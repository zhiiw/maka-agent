/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
const MAX_REQUEST_BYTES: u64 = MAX_IMPORT_FILE_BYTES + 64 * 1024;
const MAX_IMPORT_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_IMPORT_FILES: u64 = 200_000;
const MANAGED_TREE_POLICY_V1: ManagedTreePolicy = ManagedTreePolicy {
    max_depth: 64,
    max_tree_visits: 250_000,
    max_entries: 400_000,
    max_total_path_bytes: 256 * 1024 * 1024,
    max_component_bytes: 255,
    max_relative_path_bytes: 4096,
    max_files: MAX_IMPORT_FILES,
    max_file_bytes: MAX_IMPORT_FILE_BYTES,
    max_bytes: MAX_IMPORT_BYTES,
};
const MAX_TREE_FILE_BYTES: u64 = 8 * 1024 * 1024;

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
    ReadTreeFile {
        protocol_version: u8,
        repository_path: PathBuf,
        accepted_commit_oid: String,
        path: String,
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
    TreeFileRead {
        protocol_version: u8,
        object_format: &'static str,
        accepted_commit_oid: String,
        accepted_tree_oid: String,
        blob_oid: String,
        path: String,
        content: String,
        bytes_read: u64,
    },
    #[serde(rename_all = "camelCase")]
    HelperError {
        protocol_version: u8,
        reason: &'a str,
    },
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(reason) => {
            write_response(&Response::HelperError {
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
        Request::ReadTreeFile {
            protocol_version,
            repository_path,
            accepted_commit_oid,
            path,
        } => {
            assert_protocol_version(protocol_version)?;
            read_tree_file(repository_path, accepted_commit_oid, path)
        }
    }
}

fn assert_protocol_version(protocol_version: u8) -> Result<(), &'static str> {
    if protocol_version != PROTOCOL_VERSION {
        return Err("unsupported_protocol_version");
    }
    Ok(())
}

fn inspect_repository(repository_path: PathBuf) -> Result<ExitCode, &'static str> {
    let repository = match gix::open::Options::isolated()
        .strict_config(true)
        .open(repository_path)
    {
        Ok(repository) => repository.to_thread_local(),
        Err(gix::open::Error::Config(gix::config::Error::ConfigTypedString(error)))
            if error.key.as_slice() == b"extensions.objectFormat" =>
        {
            let object_format = error
                .value
                .as_ref()
                .map(|value| String::from_utf8_lossy(value.as_slice()).into_owned())
                .unwrap_or_else(|| "unknown".to_owned());
            return Ok(reject_unsupported_object_format(object_format));
        }
        Err(gix::open::Error::Config(gix::config::Error::UnsupportedObjectFormat { name })) => {
            let object_format = String::from_utf8_lossy(name.as_slice()).into_owned();
            return Ok(reject_unsupported_object_format(object_format));
        }
        Err(_) => return Err("repository_open_failed"),
    };

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
        gix::hash::Kind::Sha256 => Ok(reject_unsupported_object_format("sha256".to_owned())),
        _ => Ok(reject_unsupported_object_format("unknown".to_owned())),
    }
}

fn open_repository(repository_path: PathBuf) -> Result<gix::Repository, &'static str> {
    Ok(gix::open::Options::isolated()
        .strict_config(true)
        .open(repository_path)
        .map_err(|_| "repository_open_failed")?
        .to_thread_local())
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

    let destination = match fs::symlink_metadata(&destination_repository_path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            open_repository(destination_repository_path.clone())?
        }
        Ok(_) => return Err("import_destination_not_fresh"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            gix::init_bare(&destination_repository_path)
                .map_err(|_| "import_destination_create_failed")?
        }
        Err(_) => return Err("import_destination_unreadable"),
    };
    if destination.object_hash() != gix::hash::Kind::Sha1 {
        return Err("import_destination_object_format_mismatch");
    }

    fs::remove_dir_all(destination_repository_path.join("hooks"))
        .map_err(|_| "import_hooks_cleanup_failed")?;
    fs::create_dir(destination_repository_path.join("hooks"))
        .map_err(|_| "import_hooks_cleanup_failed")?;

    let mut stats = ManagedTreeStats::default();
    copy_source_tree(
        &source,
        &destination,
        source_tree,
        "",
        0,
        MANAGED_TREE_POLICY_V1,
        &mut stats,
    )?;

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
    match destination
        .try_find_reference(baseline_ref.as_str())
        .map_err(|_| "baseline_publish_failed")?
    {
        Some(reference) => {
            let current = reference
                .into_fully_peeled_id()
                .map_err(|_| "baseline_publish_failed")?
                .detach();
            if current != baseline_commit {
                return Err("baseline_publish_conflict");
            }
        }
        None => {
            destination
                .reference(
                    baseline_ref.as_str(),
                    baseline_commit,
                    gix::refs::transaction::PreviousValue::MustNotExist,
                    "maka managed workspace baseline",
                )
                .map_err(|_| "baseline_publish_failed")?;
        }
    }

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
    depth: u64,
    policy: ManagedTreePolicy,
    stats: &mut ManagedTreeStats,
) -> Result<(), &'static str> {
    stats.enter_tree(depth, policy)?;
    let tree = source
        .find_tree(tree_oid)
        .map_err(|_| "source_tree_unavailable")?;
    for entry in tree.iter() {
        let entry = entry.map_err(|_| "source_tree_invalid")?;
        let component =
            std::str::from_utf8(entry.filename()).map_err(|_| "unsupported_source_path")?;
        if !is_supported_source_component(component)
            || component.len() as u64 > policy.max_component_bytes
        {
            return Err("unsupported_source_path");
        }
        let relative_path = if prefix.is_empty() {
            component.to_owned()
        } else {
            format!("{prefix}/{component}")
        };
        stats.observe_entry(&relative_path, policy)?;
        match entry.mode().kind() {
            gix::objs::tree::EntryKind::Tree => {
                copy_source_tree(
                    source,
                    destination,
                    entry.object_id(),
                    &relative_path,
                    depth.checked_add(1).ok_or("source_tree_depth_exceeded")?,
                    policy,
                    stats,
                )?;
            }
            gix::objs::tree::EntryKind::Blob | gix::objs::tree::EntryKind::BlobExecutable => {
                let header = entry.id().header().map_err(|_| "source_blob_unavailable")?;
                if header.kind() != gix::objs::Kind::Blob {
                    return Err("source_blob_invalid");
                }
                stats.observe_blob(header.size(), policy)?;
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
    if content.len() as u64 > MAX_IMPORT_FILE_BYTES {
        return Err("successor_content_limit_exceeded");
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
    validate_managed_tree(&repository, successor_tree, MANAGED_TREE_POLICY_V1)?;
    let signature = gix::actor::SignatureRef {
        name: b"Maka Workspace Service".as_bstr(),
        email: b"workspace@maka.invalid".as_bstr(),
        time: "946684800 +0000",
    };
    let successor_commit = repository
        .new_commit_as(
            signature,
            signature,
            "maka managed workspace successor v1",
            successor_tree,
            [expected_base],
        )
        .map_err(|_| "commit_write_failed")?
        .id()
        .detach();

    let current = repository
        .find_reference(target_ref.as_str())
        .map_err(|_| "target_ref_unavailable")?
        .into_fully_peeled_id()
        .map_err(|_| "target_ref_unavailable")?
        .detach();
    if current != expected_base && current != successor_commit {
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
    if current == expected_base {
        repository
            .reference(
                target_ref.as_str(),
                successor_commit,
                gix::refs::transaction::PreviousValue::MustExistAndMatch(
                    gix::refs::Target::Object(expected_base),
                ),
                "maka managed workspace successor",
            )
            .map_err(|_| "successor_publish_failed")?;
    }

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

fn validate_managed_tree(
    repository: &gix::Repository,
    tree_oid: gix::hash::ObjectId,
    policy: ManagedTreePolicy,
) -> Result<ManagedTreeStats, &'static str> {
    let mut stats = ManagedTreeStats::default();
    validate_managed_tree_inner(repository, tree_oid, "", 0, policy, &mut stats)?;
    Ok(stats)
}

fn validate_managed_tree_inner(
    repository: &gix::Repository,
    tree_oid: gix::hash::ObjectId,
    prefix: &str,
    depth: u64,
    policy: ManagedTreePolicy,
    stats: &mut ManagedTreeStats,
) -> Result<(), &'static str> {
    stats.enter_tree(depth, policy)?;
    let tree = repository
        .find_tree(tree_oid)
        .map_err(|_| "source_tree_unavailable")?;
    for entry in tree.iter() {
        let entry = entry.map_err(|_| "source_tree_invalid")?;
        let component =
            std::str::from_utf8(entry.filename()).map_err(|_| "unsupported_source_path")?;
        if !is_supported_source_component(component)
            || component.len() as u64 > policy.max_component_bytes
        {
            return Err("unsupported_source_path");
        }
        let relative_path = if prefix.is_empty() {
            component.to_owned()
        } else {
            format!("{prefix}/{component}")
        };
        stats.observe_entry(&relative_path, policy)?;
        match entry.mode().kind() {
            gix::objs::tree::EntryKind::Tree => validate_managed_tree_inner(
                repository,
                entry.object_id(),
                &relative_path,
                depth.checked_add(1).ok_or("source_tree_depth_exceeded")?,
                policy,
                stats,
            )?,
            gix::objs::tree::EntryKind::Blob | gix::objs::tree::EntryKind::BlobExecutable => {
                let header = entry.id().header().map_err(|_| "source_blob_unavailable")?;
                if header.kind() != gix::objs::Kind::Blob {
                    return Err("source_blob_invalid");
                }
                stats.observe_blob(header.size(), policy)?;
            }
            _ => return Err("unsupported_source_entry_kind"),
        }
    }
    Ok(())
}

fn is_canonical_successor_path(path: &str) -> bool {
    path.len() <= 4096
        && !path.is_empty()
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

fn read_tree_file(
    repository_path: PathBuf,
    accepted_commit_oid: String,
    path: String,
) -> Result<ExitCode, &'static str> {
    if !is_canonical_successor_path(&path) {
        return Err("invalid_tree_file_path");
    }
    let repository = open_repository(repository_path)?;
    let (accepted_commit, accepted_tree) =
        accepted_commit_identity(&repository, &accepted_commit_oid)?;
    let entry = repository
        .find_tree(accepted_tree)
        .map_err(|_| "accepted_tree_unavailable")?
        .lookup_entry_by_path(path.as_str())
        .map_err(|_| "tree_file_lookup_failed")?
        .ok_or("tree_file_unavailable")?;
    if !matches!(
        entry.mode().kind(),
        gix::objs::tree::EntryKind::Blob | gix::objs::tree::EntryKind::BlobExecutable
    ) {
        return Err("tree_file_invalid");
    }
    let header = entry.id().header().map_err(|_| "tree_file_unavailable")?;
    if header.kind() != gix::objs::Kind::Blob || header.size() > MAX_TREE_FILE_BYTES {
        return Err("tree_file_size_limit_exceeded");
    }
    let blob_oid = entry.object_id();
    let blob = entry
        .object()
        .map_err(|_| "tree_file_unavailable")?
        .try_into_blob()
        .map_err(|_| "tree_file_invalid")?;
    let bytes_read = blob.data.len() as u64;
    if bytes_read != header.size() {
        return Err("tree_file_identity_mismatch");
    }
    let actual_blob_oid =
        gix::objs::compute_hash(gix::hash::Kind::Sha1, gix::objs::Kind::Blob, &blob.data)
            .map_err(|_| "tree_file_identity_mismatch")?;
    if actual_blob_oid != blob_oid {
        return Err("tree_file_identity_mismatch");
    }
    let content = std::str::from_utf8(&blob.data)
        .map_err(|_| "tree_file_not_utf8")?
        .to_owned();
    write_response(&Response::TreeFileRead {
        protocol_version: PROTOCOL_VERSION,
        object_format: "sha1",
        accepted_commit_oid: accepted_commit.to_string(),
        accepted_tree_oid: accepted_tree.to_string(),
        blob_oid: blob_oid.to_string(),
        path,
        content,
        bytes_read,
    });
    Ok(ExitCode::SUCCESS)
}

#[derive(Default)]
struct ProjectionStats {
    files: u64,
    bytes: u64,
    folded_paths: HashSet<String>,
    expected_paths: HashSet<String>,
}

struct ProjectionDrift {
    reason: &'static str,
    path: String,
}

fn materialize_projection(
    repository_path: PathBuf,
    accepted_commit_oid: String,
    destination_path: PathBuf,
) -> Result<ExitCode, &'static str> {
    let repository = open_repository(repository_path)?;
    let (accepted_commit, accepted_tree) =
        accepted_commit_identity(&repository, &accepted_commit_oid)?;
    validate_managed_tree(&repository, accepted_tree, MANAGED_TREE_POLICY_V1)?;

    let stats = match fs::create_dir(&destination_path) {
        Ok(()) => {
            let mut stats = ProjectionStats::default();
            materialize_tree(
                &repository,
                accepted_tree,
                &destination_path,
                "",
                &mut stats,
            )?;
            stats
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            inspect_projection(&repository, accepted_tree, &destination_path)
                .map_err(|_| "projection_destination_not_fresh")?
        }
        Err(_) => return Err("projection_destination_create_failed"),
    };

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

fn accepted_commit_identity(
    repository: &gix::Repository,
    accepted_commit_oid: &str,
) -> Result<(gix::hash::ObjectId, gix::hash::ObjectId), &'static str> {
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
    Ok((accepted_commit, accepted_tree))
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
        if !is_supported_source_component(component) {
            return Err("unsupported_projection_path");
        }
        let relative_path = join_projection_path(prefix, component);
        record_projection_path(stats, &relative_path).map_err(|_| "projection_path_collision")?;
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
                let header = entry
                    .id()
                    .header()
                    .map_err(|_| "projection_blob_unavailable")?;
                if header.kind() != gix::objs::Kind::Blob
                    || header.size() > MANAGED_TREE_POLICY_V1.max_file_bytes
                {
                    return Err("projection_file_limit_exceeded");
                }
                stats.files = stats
                    .files
                    .checked_add(1)
                    .filter(|count| *count <= MANAGED_TREE_POLICY_V1.max_files)
                    .ok_or("projection_file_limit_exceeded")?;
                stats.bytes = stats
                    .bytes
                    .checked_add(header.size())
                    .filter(|bytes| *bytes <= MANAGED_TREE_POLICY_V1.max_bytes)
                    .ok_or("projection_byte_limit_exceeded")?;
                let blob = entry
                    .object()
                    .map_err(|_| "projection_blob_unavailable")?
                    .try_into_blob()
                    .map_err(|_| "projection_blob_invalid")?;
                if blob.data.len() as u64 != header.size() {
                    return Err("projection_blob_invalid");
                }
                let mut output = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&output_path)
                    .map_err(|_| "projection_file_create_failed")?;
                output
                    .write_all(&blob.data)
                    .map_err(|_| "projection_file_write_failed")?;
                output
                    .sync_all()
                    .map_err(|_| "projection_file_sync_failed")?;
                drop(output);
                set_projection_mode(
                    &output_path,
                    entry.mode().kind() == gix::objs::tree::EntryKind::BlobExecutable,
                )?;
            }
            _ => return Err("unsupported_projection_entry_kind"),
        }
    }
    sync_directory(destination)?;
    Ok(())
}

fn observe_projection(
    repository_path: PathBuf,
    accepted_commit_oid: String,
    projection_path: PathBuf,
) -> Result<ExitCode, &'static str> {
    let repository = open_repository(repository_path)?;
    let (accepted_commit, accepted_tree) =
        accepted_commit_identity(&repository, &accepted_commit_oid)?;
    validate_managed_tree(&repository, accepted_tree, MANAGED_TREE_POLICY_V1)?;
    match inspect_projection(&repository, accepted_tree, &projection_path) {
        Ok(stats) => {
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
        Err(drift) => projection_drifted(accepted_commit, accepted_tree, projection_path, drift),
    }
}

fn inspect_projection(
    repository: &gix::Repository,
    accepted_tree: gix::hash::ObjectId,
    projection_path: &Path,
) -> Result<ProjectionStats, ProjectionDrift> {
    let root_metadata = fs::symlink_metadata(projection_path).map_err(|_| ProjectionDrift {
        reason: "projection_unreadable",
        path: String::new(),
    })?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(ProjectionDrift {
            reason: "projection_root_type_mismatch",
            path: String::new(),
        });
    }
    let mut stats = ProjectionStats::default();
    observe_expected_tree(repository, accepted_tree, projection_path, "", &mut stats)?;
    reject_extra_projection_paths(projection_path, "", &stats.expected_paths)?;
    Ok(stats)
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
        if !is_supported_source_component(component) {
            return Err(ProjectionDrift {
                reason: "unsupported_projection_path",
                path: prefix.to_owned(),
            });
        }
        let relative_path = join_projection_path(prefix, component);
        record_projection_path(stats, &relative_path).map_err(|_| ProjectionDrift {
            reason: "projection_path_collision",
            path: relative_path.clone(),
        })?;
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
        || header.size() > MANAGED_TREE_POLICY_V1.max_file_bytes
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
        .filter(|count| *count <= MANAGED_TREE_POLICY_V1.max_files)
        .ok_or_else(|| ProjectionDrift {
            reason: "projection_file_limit_exceeded",
            path: relative_path.to_owned(),
        })?;
    stats.bytes = stats
        .bytes
        .checked_add(header.size())
        .filter(|bytes| *bytes <= MANAGED_TREE_POLICY_V1.max_bytes)
        .ok_or_else(|| ProjectionDrift {
            reason: "projection_byte_limit_exceeded",
            path: relative_path.to_owned(),
        })?;
    let input = open_projection_file_nofollow(output_path).map_err(|_| ProjectionDrift {
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
        let relative_path = join_projection_path(prefix, &component);
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
        if file_type.is_symlink() {
            return Err(ProjectionDrift {
                reason: "projection_path_type_mismatch",
                path: relative_path,
            });
        }
        if file_type.is_dir() {
            reject_extra_projection_paths(&entry.path(), &relative_path, expected_paths)?;
        }
    }
    Ok(())
}

fn record_projection_path(stats: &mut ProjectionStats, path: &str) -> Result<(), ()> {
    let folded_path: String = path.nfc().flat_map(char::to_lowercase).collect();
    if !stats.folded_paths.insert(folded_path) {
        return Err(());
    }
    stats.expected_paths.insert(path.to_owned());
    Ok(())
}

fn join_projection_path(prefix: &str, component: &str) -> String {
    if prefix.is_empty() {
        component.to_owned()
    } else {
        format!("{prefix}/{component}")
    }
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
fn open_projection_file_nofollow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(windows)]
fn open_projection_file_nofollow(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_projection_file_nofollow(path: &Path) -> io::Result<File> {
    File::open(path)
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

fn sync_directory(path: &Path) -> Result<(), &'static str> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "projection_directory_sync_failed")?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn is_supported_source_component(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && !component.contains('/')
        && !component.contains('\\')
        && !component.contains('\0')
        && !component.eq_ignore_ascii_case(".git")
        && !component.eq_ignore_ascii_case(".gitattributes")
}

#[derive(Clone, Copy)]
struct ManagedTreePolicy {
    max_depth: u64,
    max_tree_visits: u64,
    max_entries: u64,
    max_total_path_bytes: u64,
    max_component_bytes: u64,
    max_relative_path_bytes: u64,
    max_files: u64,
    max_file_bytes: u64,
    max_bytes: u64,
}

#[derive(Default)]
struct ManagedTreeStats {
    tree_visits: u64,
    entries: u64,
    total_path_bytes: u64,
    files: u64,
    bytes: u64,
    folded_paths: HashSet<String>,
}

impl ManagedTreeStats {
    fn enter_tree(&mut self, depth: u64, policy: ManagedTreePolicy) -> Result<(), &'static str> {
        if depth > policy.max_depth {
            return Err("source_tree_depth_exceeded");
        }
        self.tree_visits = self
            .tree_visits
            .checked_add(1)
            .filter(|visits| *visits <= policy.max_tree_visits)
            .ok_or("source_tree_visit_limit_exceeded")?;
        Ok(())
    }

    fn observe_entry(
        &mut self,
        relative_path: &str,
        policy: ManagedTreePolicy,
    ) -> Result<(), &'static str> {
        let path_bytes = relative_path.len() as u64;
        if path_bytes > policy.max_relative_path_bytes {
            return Err("source_path_length_exceeded");
        }
        self.entries = self
            .entries
            .checked_add(1)
            .filter(|entries| *entries <= policy.max_entries)
            .ok_or("source_tree_entry_limit_exceeded")?;
        self.total_path_bytes = self
            .total_path_bytes
            .checked_add(path_bytes)
            .filter(|bytes| *bytes <= policy.max_total_path_bytes)
            .ok_or("source_path_byte_limit_exceeded")?;
        let folded_path: String = relative_path.nfc().flat_map(char::to_lowercase).collect();
        if !self.folded_paths.insert(folded_path) {
            return Err("source_path_collision");
        }
        Ok(())
    }

    fn observe_blob(&mut self, size: u64, policy: ManagedTreePolicy) -> Result<(), &'static str> {
        if size > policy.max_file_bytes {
            return Err("source_file_limit_exceeded");
        }
        self.files = self
            .files
            .checked_add(1)
            .filter(|files| *files <= policy.max_files)
            .ok_or("source_file_limit_exceeded")?;
        self.bytes = self
            .bytes
            .checked_add(size)
            .filter(|bytes| *bytes <= policy.max_bytes)
            .ok_or("source_byte_limit_exceeded")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_policy() -> ManagedTreePolicy {
        ManagedTreePolicy {
            max_depth: 1,
            max_tree_visits: 2,
            max_entries: 2,
            max_total_path_bytes: 5,
            max_component_bytes: 3,
            max_relative_path_bytes: 4,
            max_files: 1,
            max_file_bytes: 3,
            max_bytes: 3,
        }
    }

    #[test]
    fn managed_tree_budget_bounds_depth_visits_and_entries() {
        let policy = tiny_policy();
        let mut stats = ManagedTreeStats::default();
        assert_eq!(stats.enter_tree(0, policy), Ok(()));
        assert_eq!(stats.enter_tree(1, policy), Ok(()));
        assert_eq!(
            stats.enter_tree(1, policy),
            Err("source_tree_visit_limit_exceeded")
        );

        let mut stats = ManagedTreeStats::default();
        assert_eq!(
            stats.enter_tree(2, policy),
            Err("source_tree_depth_exceeded")
        );
        assert_eq!(stats.observe_entry("a", policy), Ok(()));
        assert_eq!(stats.observe_entry("bb", policy), Ok(()));
        assert_eq!(
            stats.observe_entry("c", policy),
            Err("source_tree_entry_limit_exceeded")
        );
    }

    #[test]
    fn managed_tree_budget_bounds_paths_and_blob_bytes() {
        let policy = tiny_policy();
        let mut stats = ManagedTreeStats::default();
        assert_eq!(
            stats.observe_entry("abcde", policy),
            Err("source_path_length_exceeded")
        );
        assert_eq!(stats.observe_entry("abc", policy), Ok(()));
        assert_eq!(
            stats.observe_entry("def", policy),
            Err("source_path_byte_limit_exceeded")
        );

        let mut stats = ManagedTreeStats::default();
        assert_eq!(
            stats.observe_blob(4, policy),
            Err("source_file_limit_exceeded")
        );
        assert_eq!(stats.observe_blob(3, policy), Ok(()));
        assert_eq!(
            stats.observe_blob(1, policy),
            Err("source_file_limit_exceeded")
        );
    }
}

fn reject_unsupported_object_format(object_format: String) -> ExitCode {
    write_response(&Response::RepositoryRejected {
        protocol_version: PROTOCOL_VERSION,
        reason: "unsupported_object_format",
        object_format,
        supported_object_formats: ["sha1"],
    });
    ExitCode::from(2)
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
    let encoded = serde_json::to_string(response).expect("closed response shape must serialize");
    println!("{encoded}");
}
