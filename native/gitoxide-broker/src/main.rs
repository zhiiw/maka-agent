use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
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
    InspectSourceEligibility {
        protocol_version: u8,
        repository_path: PathBuf,
        expected_head_commit_oid: String,
    },
    ImportSourceHead {
        protocol_version: u8,
        source_repository_path: PathBuf,
        expected_source_head_commit_oid: String,
        destination_repository_path: PathBuf,
        baseline_ref: String,
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
    ObserveProjection {
        protocol_version: u8,
        repository_path: PathBuf,
        accepted_commit_oid: String,
        projection_path: PathBuf,
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
    SourceEligible {
        protocol_version: u8,
        object_format: &'static str,
        state: &'static str,
        head_commit_oid: String,
        head_tree_oid: String,
    },
    #[serde(rename_all = "camelCase")]
    SourceIneligible {
        protocol_version: u8,
        object_format: &'static str,
        state: &'static str,
        reason: &'static str,
        expected_head_commit_oid: String,
        actual_head_commit_oid: String,
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    SourceImported {
        protocol_version: u8,
        object_format: &'static str,
        source_head_commit_oid: String,
        source_tree_oid: String,
        baseline_commit_oid: String,
        baseline_tree_oid: String,
        baseline_ref: String,
        files_imported: u64,
        bytes_imported: u64,
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
    ProjectionObserved {
        protocol_version: u8,
        object_format: &'static str,
        state: &'static str,
        accepted_commit_oid: String,
        accepted_tree_oid: String,
        projection_path: PathBuf,
        files_observed: u64,
        bytes_read: u64,
    },
    #[serde(rename_all = "camelCase")]
    ProjectionDrifted {
        protocol_version: u8,
        object_format: &'static str,
        state: &'static str,
        reason: &'static str,
        path: String,
        accepted_commit_oid: String,
        accepted_tree_oid: String,
        projection_path: PathBuf,
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
        Request::InspectSourceEligibility {
            protocol_version,
            repository_path,
            expected_head_commit_oid,
        } => {
            assert_protocol_version(protocol_version)?;
            inspect_source_eligibility(repository_path, expected_head_commit_oid)
        }
        Request::ImportSourceHead {
            protocol_version,
            source_repository_path,
            expected_source_head_commit_oid,
            destination_repository_path,
            baseline_ref,
        } => {
            assert_protocol_version(protocol_version)?;
            import_source_head(
                source_repository_path,
                expected_source_head_commit_oid,
                destination_repository_path,
                baseline_ref,
            )
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
        Request::ObserveProjection {
            protocol_version,
            repository_path,
            accepted_commit_oid,
            projection_path,
        } => {
            assert_protocol_version(protocol_version)?;
            observe_projection(repository_path, accepted_commit_oid, projection_path)
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

fn open_source_observation_repository(
    repository_path: PathBuf,
) -> Result<gix::Repository, &'static str> {
    fn reject_repository_runtime_config(metadata: &gix::config::file::Metadata) -> bool {
        !matches!(
            metadata.source,
            gix::config::Source::Local | gix::config::Source::Worktree
        )
    }

    Ok(gix::open::Options::isolated()
        .strict_config(true)
        .filter_config_section(reject_repository_runtime_config)
        .open(repository_path)
        .map_err(|_| "source_observation_open_failed")?
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

fn inspect_source_eligibility(
    repository_path: PathBuf,
    expected_head_commit_oid: String,
) -> Result<ExitCode, &'static str> {
    use gix::bstr::ByteSlice;

    let requested_root =
        fs::canonicalize(&repository_path).map_err(|_| "source_repository_root_unavailable")?;
    let repository = open_repository(repository_path)?;
    let actual_root = fs::canonicalize(repository.workdir().ok_or("source_worktree_unavailable")?)
        .map_err(|_| "source_repository_root_unavailable")?;
    if !same_platform_path(&requested_root, &actual_root) {
        return Err("source_repository_not_worktree_root");
    }
    if repository
        .common_dir()
        .join("objects/info/alternates")
        .exists()
    {
        return Err("unsafe_source_object_alternates");
    }
    if has_unsafe_source_runtime_config(&repository)? {
        return Err("unsafe_source_configuration");
    }
    let references = repository
        .references()
        .map_err(|_| "source_references_unavailable")?;
    let mut replacements = references
        .prefixed("refs/replace/")
        .map_err(|_| "source_references_unavailable")?;
    if let Some(reference) = replacements.next() {
        reference.map_err(|_| "source_references_unavailable")?;
        return Err("unsafe_source_replace_ref");
    }
    if repository.object_hash() != gix::hash::Kind::Sha1 {
        return Err("unsupported_object_format");
    }
    let expected_head = gix::hash::ObjectId::from_hex(expected_head_commit_oid.as_bytes())
        .map_err(|_| "invalid_source_head_commit_oid")?;
    if expected_head.kind() != gix::hash::Kind::Sha1 {
        return Err("invalid_source_head_commit_oid");
    }
    let actual_head = repository
        .head_commit()
        .map_err(|_| "source_head_commit_unavailable")?;
    let actual_head_oid = actual_head.id().detach();
    if actual_head_oid != expected_head {
        write_response(&Response::SourceIneligible {
            protocol_version: PROTOCOL_VERSION,
            object_format: "sha1",
            state: "ineligible",
            reason: "source_head_commit_mismatch",
            expected_head_commit_oid: expected_head.to_string(),
            actual_head_commit_oid: actual_head_oid.to_string(),
            path: String::new(),
        });
        return Ok(ExitCode::from(3));
    }
    let head_tree_oid = actual_head
        .tree_id()
        .map_err(|_| "source_head_tree_unavailable")?
        .detach();

    // Status hashing must not execute repository-defined clean/process filters.
    // Reopen the same worktree while rejecting Local/Worktree runtime config.
    // This can conservatively reject repositories that depend on autocrlf or custom
    // filters, but it cannot grant their commands an execution capability.
    let repository = open_source_observation_repository(
        repository
            .workdir()
            .ok_or("source_worktree_unavailable")?
            .to_owned(),
    )?;

    let mut status = repository
        .status(gix::progress::Discard)
        .map_err(|_| "source_status_unavailable")?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .index_worktree_submodules(None)
        .into_iter(Vec::new())
        .map_err(|_| "source_status_unavailable")?;
    if let Some(item) = status.next() {
        let item = item.map_err(|_| "source_status_unavailable")?;
        let path = item
            .location()
            .to_str()
            .map_err(|_| "unsupported_source_path")?
            .to_owned();
        write_response(&Response::SourceIneligible {
            protocol_version: PROTOCOL_VERSION,
            object_format: "sha1",
            state: "ineligible",
            reason: "source_not_clean",
            expected_head_commit_oid: expected_head.to_string(),
            actual_head_commit_oid: actual_head_oid.to_string(),
            path,
        });
        return Ok(ExitCode::from(3));
    }

    write_response(&Response::SourceEligible {
        protocol_version: PROTOCOL_VERSION,
        object_format: "sha1",
        state: "clean",
        head_commit_oid: actual_head_oid.to_string(),
        head_tree_oid: head_tree_oid.to_string(),
    });
    Ok(ExitCode::SUCCESS)
}

fn has_unsafe_source_runtime_config(repository: &gix::Repository) -> Result<bool, &'static str> {
    use gix::bstr::ByteSlice;

    let config = repository.config_snapshot();
    for section in config.sections() {
        if !matches!(
            section.meta().source,
            gix::config::Source::Local | gix::config::Source::Worktree
        ) {
            continue;
        }
        let name = section
            .header()
            .name()
            .to_str()
            .map_err(|_| "source_configuration_invalid")?
            .to_ascii_lowercase();
        let body = section.body();
        let unsafe_section = match name.as_str() {
            "include" | "includeif" | "filter" => true,
            "extensions" => {
                body.value("objectFormat").is_some() || body.value("partialClone").is_some()
            }
            "core" => body.value("fsmonitor").is_some(),
            "remote" => body.value("promisor").is_some(),
            _ => false,
        };
        if unsafe_section {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(windows)]
fn same_platform_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(not(windows))]
fn same_platform_path(left: &Path, right: &Path) -> bool {
    left == right
}

fn import_source_head(
    source_repository_path: PathBuf,
    expected_source_head_commit_oid: String,
    destination_repository_path: PathBuf,
    baseline_ref: String,
) -> Result<ExitCode, &'static str> {
    use gix::bstr::ByteSlice;

    if !baseline_ref.starts_with("refs/maka/") {
        return Err("baseline_ref_outside_maka_namespace");
    }
    let source = open_repository(source_repository_path)?;
    if source.object_hash() != gix::hash::Kind::Sha1 {
        return Err("unsupported_object_format");
    }
    let expected_source_head =
        gix::hash::ObjectId::from_hex(expected_source_head_commit_oid.as_bytes())
            .map_err(|_| "invalid_source_head_commit_oid")?;
    if expected_source_head.kind() != gix::hash::Kind::Sha1 {
        return Err("invalid_source_head_commit_oid");
    }
    let source_head = source
        .head_commit()
        .map_err(|_| "source_head_commit_unavailable")?;
    if source_head.id().detach() != expected_source_head {
        return Err("source_head_commit_mismatch");
    }
    let source_tree = source_head
        .tree_id()
        .map_err(|_| "source_head_tree_unavailable")?
        .detach();

    match fs::symlink_metadata(&destination_repository_path) {
        Ok(_) => return Err("import_destination_not_fresh"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("import_destination_unreadable"),
    }
    let destination = gix::init_bare(&destination_repository_path)
        .map_err(|_| "import_destination_create_failed")?;
    if destination.object_hash() != gix::hash::Kind::Sha1 {
        return Err("import_destination_object_format_mismatch");
    }

    // A managed repository never executes repository-provided hooks. Remove the
    // inert samples as well so the resulting artifact has a smaller authority surface.
    fs::remove_dir_all(destination_repository_path.join("hooks"))
        .map_err(|_| "import_hooks_cleanup_failed")?;
    fs::create_dir(destination_repository_path.join("hooks"))
        .map_err(|_| "import_hooks_cleanup_failed")?;

    let mut stats = ProjectionStats::default();
    copy_source_tree(&source, &destination, source_tree, "", &mut stats)?;

    let signature = gix::actor::SignatureRef {
        name: b"Maka Workspace Service".as_bstr(),
        email: b"workspace@maka.invalid".as_bstr(),
        time: "946684800 +0000",
    };
    let baseline_commit = destination
        .new_commit_as(
            signature,
            signature,
            "maka managed workspace baseline v1",
            source_tree,
            std::iter::empty::<gix::hash::ObjectId>(),
        )
        .map_err(|_| "baseline_commit_write_failed")?
        .id()
        .detach();
    destination
        .reference(
            baseline_ref.as_str(),
            baseline_commit,
            gix::refs::transaction::PreviousValue::MustNotExist,
            "maka managed workspace baseline",
        )
        .map_err(|_| "baseline_publish_failed")?;

    write_response(&Response::SourceImported {
        protocol_version: PROTOCOL_VERSION,
        object_format: "sha1",
        source_head_commit_oid: expected_source_head.to_string(),
        source_tree_oid: source_tree.to_string(),
        baseline_commit_oid: baseline_commit.to_string(),
        baseline_tree_oid: source_tree.to_string(),
        baseline_ref,
        files_imported: stats.files,
        bytes_imported: stats.bytes,
    });
    Ok(ExitCode::SUCCESS)
}

fn copy_source_tree(
    source: &gix::Repository,
    destination: &gix::Repository,
    tree_oid: gix::hash::ObjectId,
    prefix: &str,
    stats: &mut ProjectionStats,
) -> Result<(), &'static str> {
    let tree = source
        .find_tree(tree_oid)
        .map_err(|_| "source_tree_unavailable")?;
    for entry in tree.iter() {
        let entry = entry.map_err(|_| "source_tree_invalid")?;
        let component =
            std::str::from_utf8(entry.filename()).map_err(|_| "unsupported_source_path")?;
        if !is_supported_projection_component(component) {
            return Err("unsupported_source_path");
        }
        let relative_path = if prefix.is_empty() {
            component.to_owned()
        } else {
            format!("{prefix}/{component}")
        };
        let folded_path: String = relative_path.nfc().flat_map(char::to_lowercase).collect();
        if !stats.folded_paths.insert(folded_path) {
            return Err("source_path_collision");
        }
        match entry.mode().kind() {
            gix::objs::tree::EntryKind::Tree => {
                copy_source_tree(
                    source,
                    destination,
                    entry.object_id(),
                    &relative_path,
                    stats,
                )?;
            }
            gix::objs::tree::EntryKind::Blob | gix::objs::tree::EntryKind::BlobExecutable => {
                stats.files = stats
                    .files
                    .checked_add(1)
                    .filter(|count| *count <= MAX_PROJECTION_FILES)
                    .ok_or("source_file_limit_exceeded")?;
                let header = entry.id().header().map_err(|_| "source_blob_unavailable")?;
                if header.kind() != gix::objs::Kind::Blob
                    || header.size() > MAX_PROJECTION_FILE_BYTES
                {
                    return Err("source_file_limit_exceeded");
                }
                stats.bytes = stats
                    .bytes
                    .checked_add(header.size())
                    .filter(|bytes| *bytes <= MAX_PROJECTION_BYTES)
                    .ok_or("source_byte_limit_exceeded")?;
                let blob = entry
                    .object()
                    .map_err(|_| "source_blob_unavailable")?
                    .try_into_blob()
                    .map_err(|_| "source_blob_invalid")?;
                let copied_blob = destination
                    .write_blob(&blob.data)
                    .map_err(|_| "source_blob_copy_failed")?
                    .detach();
                if copied_blob != entry.object_id() {
                    return Err("source_blob_identity_mismatch");
                }
            }
            _ => return Err("unsupported_source_entry_kind"),
        }
    }
    let copied_tree = destination
        .write_object(tree.decode().map_err(|_| "source_tree_invalid")?)
        .map_err(|_| "source_tree_copy_failed")?
        .detach();
    if copied_tree != tree_oid {
        return Err("source_tree_identity_mismatch");
    }
    Ok(())
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
    expected_paths: HashSet<String>,
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
        stats.expected_paths.insert(relative_path.clone());
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

struct ProjectionDrift {
    reason: &'static str,
    path: String,
}

fn observe_projection(
    repository_path: PathBuf,
    accepted_commit_oid: String,
    projection_path: PathBuf,
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

    let root_metadata =
        fs::symlink_metadata(&projection_path).map_err(|_| "projection_unreadable")?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return projection_drifted(
            accepted_commit,
            accepted_tree,
            projection_path,
            ProjectionDrift {
                reason: "projection_root_type_mismatch",
                path: String::new(),
            },
        );
    }

    let mut stats = ProjectionStats::default();
    if let Err(drift) =
        observe_expected_tree(&repository, accepted_tree, &projection_path, "", &mut stats)
    {
        return projection_drifted(accepted_commit, accepted_tree, projection_path, drift);
    }
    if let Err(drift) = reject_extra_projection_paths(&projection_path, "", &stats.expected_paths) {
        return projection_drifted(accepted_commit, accepted_tree, projection_path, drift);
    }

    write_response(&Response::ProjectionObserved {
        protocol_version: PROTOCOL_VERSION,
        object_format: "sha1",
        state: "clean",
        accepted_commit_oid: accepted_commit.to_string(),
        accepted_tree_oid: accepted_tree.to_string(),
        projection_path,
        files_observed: stats.files,
        bytes_read: stats.bytes,
    });
    Ok(ExitCode::SUCCESS)
}

fn observe_expected_tree(
    repository: &gix::Repository,
    tree_oid: gix::hash::ObjectId,
    projection: &Path,
    prefix: &str,
    stats: &mut ProjectionStats,
) -> Result<(), ProjectionDrift> {
    let tree = repository
        .find_tree(tree_oid)
        .map_err(|_| ProjectionDrift {
            reason: "expected_tree_unavailable",
            path: prefix.to_owned(),
        })?;
    for entry in tree.iter() {
        let entry = entry.map_err(|_| ProjectionDrift {
            reason: "expected_tree_invalid",
            path: prefix.to_owned(),
        })?;
        let component = std::str::from_utf8(entry.filename()).map_err(|_| ProjectionDrift {
            reason: "unsupported_projection_path",
            path: prefix.to_owned(),
        })?;
        if !is_supported_projection_component(component) {
            return Err(ProjectionDrift {
                reason: "unsupported_projection_path",
                path: prefix.to_owned(),
            });
        }
        let relative_path = if prefix.is_empty() {
            component.to_owned()
        } else {
            format!("{prefix}/{component}")
        };
        let folded_path: String = relative_path.nfc().flat_map(char::to_lowercase).collect();
        if !stats.folded_paths.insert(folded_path) {
            return Err(ProjectionDrift {
                reason: "projection_path_collision",
                path: relative_path,
            });
        }
        stats.expected_paths.insert(relative_path.clone());
        let output_path = projection.join(component);
        let metadata = fs::symlink_metadata(&output_path).map_err(|_| ProjectionDrift {
            reason: "expected_path_missing_or_unreadable",
            path: relative_path.clone(),
        })?;
        match entry.mode().kind() {
            gix::objs::tree::EntryKind::Tree => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(ProjectionDrift {
                        reason: "expected_directory_type_mismatch",
                        path: relative_path,
                    });
                }
                observe_expected_tree(
                    repository,
                    entry.object_id(),
                    &output_path,
                    &relative_path,
                    stats,
                )?;
            }
            gix::objs::tree::EntryKind::Blob | gix::objs::tree::EntryKind::BlobExecutable => {
                observe_expected_blob(&entry, &metadata, &output_path, &relative_path, stats)?;
            }
            _ => {
                return Err(ProjectionDrift {
                    reason: "unsupported_projection_entry_kind",
                    path: relative_path,
                });
            }
        }
    }
    Ok(())
}

fn observe_expected_blob(
    entry: &gix::object::tree::EntryRef<'_, '_>,
    metadata: &fs::Metadata,
    output_path: &Path,
    relative_path: &str,
    stats: &mut ProjectionStats,
) -> Result<(), ProjectionDrift> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ProjectionDrift {
            reason: "expected_file_type_mismatch",
            path: relative_path.to_owned(),
        });
    }
    let header = entry.id().header().map_err(|_| ProjectionDrift {
        reason: "expected_blob_unavailable",
        path: relative_path.to_owned(),
    })?;
    if header.kind() != gix::objs::Kind::Blob
        || header.size() > MAX_PROJECTION_FILE_BYTES
        || metadata.len() != header.size()
    {
        return Err(ProjectionDrift {
            reason: "expected_file_size_mismatch",
            path: relative_path.to_owned(),
        });
    }
    stats.files = stats
        .files
        .checked_add(1)
        .filter(|count| *count <= MAX_PROJECTION_FILES)
        .ok_or_else(|| ProjectionDrift {
            reason: "projection_file_limit_exceeded",
            path: relative_path.to_owned(),
        })?;
    stats.bytes = stats
        .bytes
        .checked_add(header.size())
        .filter(|bytes| *bytes <= MAX_PROJECTION_BYTES)
        .ok_or_else(|| ProjectionDrift {
            reason: "projection_byte_limit_exceeded",
            path: relative_path.to_owned(),
        })?;
    let input = File::open(output_path).map_err(|_| ProjectionDrift {
        reason: "expected_file_unreadable",
        path: relative_path.to_owned(),
    })?;
    let opened_metadata = input.metadata().map_err(|_| ProjectionDrift {
        reason: "expected_file_unreadable",
        path: relative_path.to_owned(),
    })?;
    if !opened_metadata.is_file() || opened_metadata.len() != header.size() {
        return Err(ProjectionDrift {
            reason: "expected_file_size_mismatch",
            path: relative_path.to_owned(),
        });
    }
    let mut bytes = Vec::with_capacity(header.size() as usize);
    input
        .take(header.size() + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProjectionDrift {
            reason: "expected_file_unreadable",
            path: relative_path.to_owned(),
        })?;
    if bytes.len() as u64 != header.size() {
        return Err(ProjectionDrift {
            reason: "expected_file_size_mismatch",
            path: relative_path.to_owned(),
        });
    }
    let actual_oid = gix::objs::compute_hash(gix::hash::Kind::Sha1, gix::objs::Kind::Blob, &bytes)
        .map_err(|_| ProjectionDrift {
            reason: "expected_file_hash_failed",
            path: relative_path.to_owned(),
        })?;
    if actual_oid != entry.object_id() {
        return Err(ProjectionDrift {
            reason: "expected_file_content_mismatch",
            path: relative_path.to_owned(),
        });
    }
    if !projection_mode_matches(
        &opened_metadata,
        entry.mode().kind() == gix::objs::tree::EntryKind::BlobExecutable,
    ) {
        return Err(ProjectionDrift {
            reason: "expected_file_mode_mismatch",
            path: relative_path.to_owned(),
        });
    }
    Ok(())
}

fn reject_extra_projection_paths(
    projection: &Path,
    prefix: &str,
    expected_paths: &HashSet<String>,
) -> Result<(), ProjectionDrift> {
    let entries = fs::read_dir(projection).map_err(|_| ProjectionDrift {
        reason: "projection_directory_unreadable",
        path: prefix.to_owned(),
    })?;
    for entry in entries {
        let entry = entry.map_err(|_| ProjectionDrift {
            reason: "projection_directory_unreadable",
            path: prefix.to_owned(),
        })?;
        let component = entry
            .file_name()
            .into_string()
            .map_err(|_| ProjectionDrift {
                reason: "unexpected_non_utf8_path",
                path: prefix.to_owned(),
            })?;
        let relative_path = if prefix.is_empty() {
            component
        } else {
            format!("{prefix}/{component}")
        };
        if !expected_paths.contains(&relative_path) {
            return Err(ProjectionDrift {
                reason: "unexpected_projection_path",
                path: relative_path,
            });
        }
        let file_type = entry.file_type().map_err(|_| ProjectionDrift {
            reason: "projection_path_unreadable",
            path: relative_path.clone(),
        })?;
        if file_type.is_dir() {
            reject_extra_projection_paths(&entry.path(), &relative_path, expected_paths)?;
        }
    }
    Ok(())
}

fn projection_drifted(
    accepted_commit: gix::hash::ObjectId,
    accepted_tree: gix::hash::ObjectId,
    projection_path: PathBuf,
    drift: ProjectionDrift,
) -> Result<ExitCode, &'static str> {
    write_response(&Response::ProjectionDrifted {
        protocol_version: PROTOCOL_VERSION,
        object_format: "sha1",
        state: "drifted",
        reason: drift.reason,
        path: drift.path,
        accepted_commit_oid: accepted_commit.to_string(),
        accepted_tree_oid: accepted_tree.to_string(),
        projection_path,
    });
    Ok(ExitCode::from(3))
}

#[cfg(unix)]
fn projection_mode_matches(metadata: &fs::Metadata, executable: bool) -> bool {
    use std::os::unix::fs::PermissionsExt;

    (metadata.permissions().mode() & 0o111 != 0) == executable
}

#[cfg(not(unix))]
fn projection_mode_matches(_metadata: &fs::Metadata, _executable: bool) -> bool {
    true
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
