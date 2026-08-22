use std::{
    io::{self, Read},
    path::PathBuf,
    process::ExitCode,
};

use serde::{Deserialize, Serialize};

const PROTOCOL_VERSION: u8 = 1;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;

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
