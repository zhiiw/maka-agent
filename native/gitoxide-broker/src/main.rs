use std::{
    io::{self, Read},
    path::PathBuf,
    process::ExitCode,
};

use serde::{Deserialize, Serialize};

const PROTOCOL_VERSION: u8 = 1;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InspectRepositoryRequest {
    protocol_version: u8,
    operation: String,
    repository_path: PathBuf,
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
    if request.protocol_version != PROTOCOL_VERSION {
        return Err("unsupported_protocol_version");
    }
    if request.operation != "inspect_repository" {
        return Err("unsupported_operation");
    }

    let repository = gix::open::Options::isolated()
        .strict_config(true)
        .open(request.repository_path)
        .map_err(|_| "repository_open_failed")?
        .to_thread_local();

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

fn read_request() -> Result<InspectRepositoryRequest, &'static str> {
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
