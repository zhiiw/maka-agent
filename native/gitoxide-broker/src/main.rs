use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

const PROTOCOL_VERSION: u8 = 1;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_PROJECTION_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PROJECTION_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PROJECTION_FILES: u64 = 200_000;

#[derive(Deserialize)]
#[serde(
    deny_unknown_fields,
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Request {
    InspectRepository {
        protocol_version: u8,
        repository_path: PathBuf,
    },
    CreateSuccessor {
        protocol_version: u8,
        repository_path: PathBuf,
        expected_base_commit_oid: String,
        target_ref: String,
        path: String,
        content: String,
    },
    MaterializeProjection {
        protocol_version: u8,
        repository_path: PathBuf,
        accepted_commit_oid: String,
        destination_path: PathBuf,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Response<'a> {
    #[serde(rename_all = "camelCase")]
    RepositoryInspected {
        protocol_version: u8,
        object_format: &'static str,
        head_commit_oid: String,
        head_tree_oid: String,
    },
    #[serde(rename_all = "camelCase")]
    RepositoryRejected {
        protocol_version: u8,
        reason: &'static str,
        object_format: String,
        supported_object_formats: [&'static str; 1],
    },
    #[serde(rename_all = "camelCase")]
    SuccessorPublished {
        protocol_version: u8,
        object_format: &'static str,
        base_commit_oid: String,
        successor_commit_oid: String,
        successor_tree_oid: String,
        result_blob_oid: String,
        target_ref: String,
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    SuccessorRejected {
        protocol_version: u8,
        reason: &'static str,
        object_format: &'static str,
        expected_base_commit_oid: String,
        actual_base_commit_oid: String,
        target_ref: String,
    },
    #[serde(rename_all = "camelCase")]
    ProjectionMaterialized {
        protocol_version: u8,
        object_format: &'static str,
        accepted_commit_oid: String,
        accepted_tree_oid: String,
        destination_path: PathBuf,
        files_materialized: u64,
        bytes_written: u64,
    },
    #[serde(rename_all = "camelCase")]
    BrokerError {
        protocol_version: u8,
        reason: &'a str,
    },
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(reason) => {
            write_response(&Response::BrokerError {
                protocol_version: PROTOCOL_VERSION,
                reason,
            });
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<ExitCode, &'static str> {
    let request = read_request()?;
    match request {
        Request::InspectRepository {
            protocol_version,
            repository_path,
        } => {
            assert_protocol_version(protocol_version)?;
            inspect_repository(repository_path)
        }
        Request::CreateSuccessor {
            protocol_version,
            repository_path,
            expected_base_commit_oid,
            target_ref,
            path,
            content,
        } => {
            assert_protocol_version(protocol_version)?;
            create_successor(
                repository_path,
                expected_base_commit_oid,
                target_ref,
                path,
                content,
            )
        }
        Request::MaterializeProjection {
            protocol_version,
            repository_path,
            accepted_commit_oid,
            destination_path,
        } => {
            assert_protocol_version(protocol_version)?;
            materialize_projection(repository_path, accepted_commit_oid, destination_path)
        }
    }
}

fn assert_protocol_version(protocol_version: u8) -> Result<(), &'static str> {
    if protocol_version != PROTOCOL_VERSION {
        return Err("unsupported_protocol_version");
    }
    Ok(())
}

fn open_repository(repository_path: PathBuf) -> Result<gix::Repository, &'static str> {
    Ok(gix::open::Options::isolated()
        .strict_config(true)
        .open(repository_path)
        .map_err(|_| "repository_open_failed")?
        .to_thread_local())
}

fn inspect_repository(repository_path: PathBuf) -> Result<ExitCode, &'static str> {
    let repository = open_repository(repository_path)?;

    match repository.object_hash() {
        gix::hash::Kind::Sha1 => {
            let head = repository
                .head_commit()
                .map_err(|_| "head_commit_unavailable")?;
            let head_commit_oid = head.id().detach().to_string();
            let head_tree_oid = head
                .tree_id()
                .map_err(|_| "head_tree_unavailable")?
                .detach()
                .to_string();
            write_response(&Response::RepositoryInspected {
                protocol_version: PROTOCOL_VERSION,
                object_format: "sha1",
                head_commit_oid,
                head_tree_oid,
            });
            Ok(ExitCode::SUCCESS)
        }
        gix::hash::Kind::Sha256 => {
            write_response(&Response::RepositoryRejected {
                protocol_version: PROTOCOL_VERSION,
                reason: "unsupported_object_format",
                object_format: "sha256".to_owned(),
                supported_object_formats: ["sha1"],
            });
            Ok(ExitCode::from(2))
        }
        _ => {
            write_response(&Response::RepositoryRejected {
                protocol_version: PROTOCOL_VERSION,
                reason: "unsupported_object_format",
                object_format: "unknown".to_owned(),
                supported_object_formats: ["sha1"],
            });
            Ok(ExitCode::from(2))
        }
    }
}

fn create_successor(
    repository_path: PathBuf,
    expected_base_commit_oid: String,
    target_ref: String,
    path: String,
    content: String,
) -> Result<ExitCode, &'static str> {
    use gix::bstr::ByteSlice;

    if !target_ref.starts_with("refs/maka/") {
        return Err("target_ref_outside_maka_namespace");
    }
    if !is_canonical_successor_path(&path) {
        return Err("invalid_successor_path");
    }

    let repository = open_repository(repository_path)?;
    if repository.object_hash() != gix::hash::Kind::Sha1 {
        return Err("unsupported_object_format");
    }

    let expected_base = gix::hash::ObjectId::from_hex(expected_base_commit_oid.as_bytes())
        .map_err(|_| "invalid_base_commit_oid")?;
    if expected_base.kind() != gix::hash::Kind::Sha1 {
        return Err("invalid_base_commit_oid");
    }

    let current = repository
        .find_reference(target_ref.as_str())
        .map_err(|_| "target_ref_unavailable")?
        .into_fully_peeled_id()
        .map_err(|_| "target_ref_unavailable")?
        .detach();
    if current != expected_base {
        write_response(&Response::SuccessorRejected {
            protocol_version: PROTOCOL_VERSION,
            reason: "base_commit_mismatch",
            object_format: "sha1",
            expected_base_commit_oid: expected_base.to_string(),
            actual_base_commit_oid: current.to_string(),
            target_ref,
        });
        return Ok(ExitCode::from(3));
    }

    let base_tree = repository
        .find_commit(expected_base)
        .map_err(|_| "base_commit_unavailable")?
        .tree_id()
        .map_err(|_| "base_tree_unavailable")?
        .detach();
    let result_blob = repository
        .write_blob(content.as_bytes())
        .map_err(|_| "blob_write_failed")?
        .detach();
    let entry_kind = match repository
        .find_tree(base_tree)
        .map_err(|_| "base_tree_unavailable")?
        .lookup_entry_by_path(path.as_str())
        .map_err(|_| "base_path_lookup_failed")?
        .map(|entry| entry.mode().kind())
    {
        Some(gix::objs::tree::EntryKind::BlobExecutable) => {
            gix::objs::tree::EntryKind::BlobExecutable
        }
        Some(gix::objs::tree::EntryKind::Blob) | None => gix::objs::tree::EntryKind::Blob,
        Some(_) => return Err("unsupported_base_path_kind"),
    };
    let mut editor = repository
        .edit_tree(base_tree)
        .map_err(|_| "tree_edit_failed")?;
    editor
        .upsert(path.as_str(), entry_kind, result_blob)
        .map_err(|_| "tree_edit_failed")?;
    let successor_tree = editor.write().map_err(|_| "tree_write_failed")?.detach();

    let signature = gix::actor::SignatureRef {
        name: b"Maka".as_bstr(),
        email: b"workspace@maka.invalid".as_bstr(),
        time: "1 +0000",
    };
    let successor_commit = repository
        .new_commit_as(
            signature,
            signature,
            "maka managed workspace successor",
            successor_tree,
            [expected_base],
        )
        .map_err(|_| "commit_write_failed")?
        .id()
        .detach();
    repository
        .reference(
            target_ref.as_str(),
            successor_commit,
            gix::refs::transaction::PreviousValue::MustExistAndMatch(gix::refs::Target::Object(
                expected_base,
            )),
            "maka managed workspace successor",
        )
        .map_err(|_| "successor_publish_failed")?;

    write_response(&Response::SuccessorPublished {
        protocol_version: PROTOCOL_VERSION,
        object_format: "sha1",
        base_commit_oid: expected_base.to_string(),
        successor_commit_oid: successor_commit.to_string(),
        successor_tree_oid: successor_tree.to_string(),
        result_blob_oid: result_blob.to_string(),
        target_ref,
        path,
    });
    Ok(ExitCode::SUCCESS)
}

fn is_canonical_successor_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && path.split('/').all(|component| {
            !component.is_empty()
                && component != "."
                && component != ".."
                && !component.eq_ignore_ascii_case(".git")
        })
}

#[derive(Default)]
struct ProjectionStats {
    files: u64,
    bytes: u64,
    folded_paths: HashSet<String>,
}

fn materialize_projection(
    repository_path: PathBuf,
    accepted_commit_oid: String,
    destination_path: PathBuf,
) -> Result<ExitCode, &'static str> {
    let repository = open_repository(repository_path)?;
    if repository.object_hash() != gix::hash::Kind::Sha1 {
        return Err("unsupported_object_format");
    }
    let accepted_commit = gix::hash::ObjectId::from_hex(accepted_commit_oid.as_bytes())
        .map_err(|_| "invalid_accepted_commit_oid")?;
    if accepted_commit.kind() != gix::hash::Kind::Sha1 {
        return Err("invalid_accepted_commit_oid");
    }
    let accepted_tree = repository
        .find_commit(accepted_commit)
        .map_err(|_| "accepted_commit_unavailable")?
        .tree_id()
        .map_err(|_| "accepted_tree_unavailable")?
        .detach();

    fs::create_dir(&destination_path).map_err(|error| match error.kind() {
        io::ErrorKind::AlreadyExists => "projection_destination_not_fresh",
        _ => "projection_destination_create_failed",
    })?;
    let mut stats = ProjectionStats::default();
    materialize_tree(
        &repository,
        accepted_tree,
        &destination_path,
        "",
        &mut stats,
    )?;

    write_response(&Response::ProjectionMaterialized {
        protocol_version: PROTOCOL_VERSION,
        object_format: "sha1",
        accepted_commit_oid: accepted_commit.to_string(),
        accepted_tree_oid: accepted_tree.to_string(),
        destination_path,
        files_materialized: stats.files,
        bytes_written: stats.bytes,
    });
    Ok(ExitCode::SUCCESS)
}

fn materialize_tree(
    repository: &gix::Repository,
    tree_oid: gix::hash::ObjectId,
    destination: &Path,
    prefix: &str,
    stats: &mut ProjectionStats,
) -> Result<(), &'static str> {
    let tree = repository
        .find_tree(tree_oid)
        .map_err(|_| "projection_tree_unavailable")?;
    for entry in tree.iter() {
        let entry = entry.map_err(|_| "projection_tree_invalid")?;
        let component =
            std::str::from_utf8(entry.filename()).map_err(|_| "unsupported_projection_path")?;
        if !is_supported_projection_component(component) {
            return Err("unsupported_projection_path");
        }
        let relative_path = if prefix.is_empty() {
            component.to_owned()
        } else {
            format!("{prefix}/{component}")
        };
        let folded_path: String = relative_path.nfc().flat_map(char::to_lowercase).collect();
        if !stats.folded_paths.insert(folded_path) {
            return Err("projection_path_collision");
        }
        let output_path = destination.join(component);
        match entry.mode().kind() {
            gix::objs::tree::EntryKind::Tree => {
                fs::create_dir(&output_path).map_err(|_| "projection_directory_create_failed")?;
                materialize_tree(
                    repository,
                    entry.object_id(),
                    &output_path,
                    &relative_path,
                    stats,
                )?;
            }
            gix::objs::tree::EntryKind::Blob | gix::objs::tree::EntryKind::BlobExecutable => {
                stats.files = stats
                    .files
                    .checked_add(1)
                    .filter(|count| *count <= MAX_PROJECTION_FILES)
                    .ok_or("projection_file_limit_exceeded")?;
                let header = entry
                    .id()
                    .header()
                    .map_err(|_| "projection_blob_unavailable")?;
                if header.kind() != gix::objs::Kind::Blob
                    || header.size() > MAX_PROJECTION_FILE_BYTES
                {
                    return Err("projection_file_limit_exceeded");
                }
                stats.bytes = stats
                    .bytes
                    .checked_add(header.size())
                    .filter(|bytes| *bytes <= MAX_PROJECTION_BYTES)
                    .ok_or("projection_byte_limit_exceeded")?;
                let blob = entry
                    .object()
                    .map_err(|_| "projection_blob_unavailable")?
                    .try_into_blob()
                    .map_err(|_| "projection_blob_invalid")?;
                let mut output = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&output_path)
                    .map_err(|_| "projection_file_create_failed")?;
                output
                    .write_all(&blob.data)
                    .map_err(|_| "projection_file_write_failed")?;
                drop(output);
                set_projection_mode(
                    &output_path,
                    entry.mode().kind() == gix::objs::tree::EntryKind::BlobExecutable,
                )?;
            }
            _ => return Err("unsupported_projection_entry_kind"),
        }
    }
    Ok(())
}

fn is_supported_projection_component(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && !component.contains('/')
        && !component.contains('\\')
        && !component.contains('\0')
        && !component.eq_ignore_ascii_case(".git")
        && !component.eq_ignore_ascii_case(".gitattributes")
}

#[cfg(unix)]
fn set_projection_mode(path: &Path, executable: bool) -> Result<(), &'static str> {
    use std::os::unix::fs::PermissionsExt;

    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|_| "projection_mode_update_failed")
}

#[cfg(not(unix))]
fn set_projection_mode(_path: &Path, _executable: bool) -> Result<(), &'static str> {
    Ok(())
}

fn read_request() -> Result<Request, &'static str> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "request_read_failed")?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err("request_too_large");
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_request")
}

fn write_response(response: &Response<'_>) {
    // Serialization of these closed response shapes cannot fail.
    let encoded = serde_json::to_string(response).expect("response serialization must succeed");
    println!("{encoded}");
}
