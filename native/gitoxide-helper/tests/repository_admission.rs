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
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const HELPER: &str = env!("CARGO_BIN_EXE_maka-gitoxide-helper");
static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn inspects_a_sha1_repository_without_invoking_system_git() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let expected_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let expected_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);

    let output = invoke_helper(&fixture.root);

    assert!(
        output.status.success(),
        "helper failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        response,
        serde_json::json!({
            "protocolVersion": 1,
            "kind": "repository_inspected",
            "objectFormat": "sha1",
            "headCommitOid": expected_commit,
            "headTreeOid": expected_tree,
        })
    );
}

#[test]
fn rejects_sha256_before_returning_repository_identity() {
    let fixture = RepositoryFixture::sha256_unborn();

    let output = invoke_helper(&fixture.root);

    assert_eq!(output.status.code(), Some(2));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        response,
        serde_json::json!({
            "protocolVersion": 1,
            "kind": "repository_rejected",
            "reason": "unsupported_object_format",
            "objectFormat": "sha256",
            "supportedObjectFormats": ["sha1"],
        })
    );
}

#[test]
fn rejects_an_unknown_object_format_during_repository_open() {
    let fixture = RepositoryFixture::unknown_object_format();

    let output = invoke_helper(&fixture.root);

    assert_eq!(output.status.code(), Some(2));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        response,
        serde_json::json!({
            "protocolVersion": 1,
            "kind": "repository_rejected",
            "reason": "unsupported_object_format",
            "objectFormat": "sha512",
            "supportedObjectFormats": ["sha1"],
        })
    );
}

#[test]
fn observes_raw_head_identity_instead_of_replacement_ref_semantics() {
    let (fixture, expected_commit, expected_tree) = RepositoryFixture::sha1_with_replacement_ref();

    let output = invoke_helper(&fixture.root);

    assert!(output.status.success());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["headCommitOid"], expected_commit);
    assert_eq!(response["headTreeOid"], expected_tree);
}

#[test]
fn imports_an_exact_source_head_into_a_fresh_managed_repository() {
    let fixture = RepositoryFixture::sha1_with_commit();
    fs::create_dir_all(fixture.root.join("docs")).unwrap();
    fs::write(fixture.root.join("docs/guide.txt"), b"nested guide\n").unwrap();
    fixture.git(["add", "docs/guide.txt"]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "source import fixture",
    ]);
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let source_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);
    let destination = fixture.root.join("managed.git");

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
    }));

    assert!(
        output.status.success(),
        "helper failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["kind"], "source_imported");
    assert_eq!(response["sourceHeadCommitOid"], source_head);
    assert_eq!(response["sourceTreeOid"], source_tree);
    assert_eq!(response["baselineTreeOid"], source_tree);
    assert_eq!(response["filesImported"], 2);
    assert_eq!(response["bytesImported"], 29);
    let baseline_commit = response["baselineCommitOid"].as_str().unwrap();
    assert_ne!(baseline_commit, source_head);
    assert_eq!(
        git_bare_output(&destination, ["rev-parse", "refs/maka/baseline"]),
        baseline_commit
    );
    assert_eq!(
        git_bare_output(
            &destination,
            ["rev-parse", &format!("{baseline_commit}^{{tree}}")]
        ),
        source_tree
    );
    assert!(!git_bare_succeeds(
        &destination,
        ["cat-file", "-e", source_head.as_str()]
    ));
    assert!(!destination.join("objects/info/alternates").exists());

    let retry = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
    }));
    assert!(retry.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&retry.stdout).unwrap(),
        response
    );
}

#[test]
fn repairs_an_initialized_import_destination_without_a_published_baseline() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("managed-partial.git");
    let initialized = Command::new("git")
        .args(["init", "--bare"])
        .arg(&destination)
        .output()
        .unwrap();
    assert!(initialized.status.success());

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/accepted",
    }));

    assert!(output.status.success());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        git_bare_output(&destination, ["rev-parse", "refs/maka/accepted"]),
        response["baselineCommitOid"].as_str().unwrap()
    );
}

#[test]
fn publishes_and_exactly_retries_a_successor_from_the_current_ref() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("managed.git");
    let imported = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/accepted",
    }));
    assert!(imported.status.success());
    let imported: serde_json::Value = serde_json::from_slice(&imported.stdout).unwrap();
    let baseline = imported["baselineCommitOid"].as_str().unwrap();
    let request = serde_json::json!({
        "protocolVersion": 1,
        "operation": "create_successor",
        "repositoryPath": destination,
        "expectedBaseCommitOid": baseline,
        "targetRef": "refs/maka/accepted",
        "path": "docs/hello.txt",
        "content": "successor content\n",
    });

    let first = invoke_request(request.clone());
    assert!(first.status.success());
    let first: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(first["kind"], "successor_published");
    assert_eq!(first["baseCommitOid"], baseline);
    assert_eq!(
        git_bare_output(&destination, ["rev-parse", "refs/maka/accepted"]),
        first["successorCommitOid"].as_str().unwrap()
    );
    assert_eq!(
        git_bare_bytes(
            &destination,
            [
                "show",
                &format!(
                    "{}:docs/hello.txt",
                    first["successorCommitOid"].as_str().unwrap()
                )
            ]
        ),
        b"successor content\n"
    );

    let retry = invoke_request(request);
    assert!(retry.status.success());
    let retry: serde_json::Value = serde_json::from_slice(&retry.stdout).unwrap();
    assert_eq!(retry, first);
}

#[test]
fn rejects_a_successor_when_the_target_ref_no_longer_matches_the_base() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("managed.git");
    let imported = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/accepted",
    }));
    assert!(imported.status.success());
    let imported: serde_json::Value = serde_json::from_slice(&imported.stdout).unwrap();
    let baseline = imported["baselineCommitOid"].as_str().unwrap();
    let advanced = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "create_successor",
        "repositoryPath": destination,
        "expectedBaseCommitOid": baseline,
        "targetRef": "refs/maka/accepted",
        "path": "advanced.txt",
        "content": "advanced\n",
    }));
    assert!(advanced.status.success());
    let advanced: serde_json::Value = serde_json::from_slice(&advanced.stdout).unwrap();

    let rejected = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "create_successor",
        "repositoryPath": destination,
        "expectedBaseCommitOid": baseline,
        "targetRef": "refs/maka/accepted",
        "path": "should-not-exist.txt",
        "content": "must not publish\n",
    }));
    assert_eq!(rejected.status.code(), Some(3));
    let rejected: serde_json::Value = serde_json::from_slice(&rejected.stdout).unwrap();
    assert_eq!(rejected["kind"], "successor_rejected");
    assert_eq!(rejected["reason"], "base_commit_mismatch");
    assert_eq!(
        rejected["actualBaseCommitOid"],
        advanced["successorCommitOid"]
    );
}

#[test]
fn rejects_a_successor_tree_outside_the_managed_tree_policy_before_ref_cas() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("managed.git");
    let imported = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/accepted",
    }));
    assert!(imported.status.success());
    let imported: serde_json::Value = serde_json::from_slice(&imported.stdout).unwrap();
    let baseline = imported["baselineCommitOid"].as_str().unwrap();
    let overdeep_path = (0..65)
        .map(|index| format!("d{index}"))
        .chain(std::iter::once("file.txt".to_owned()))
        .collect::<Vec<_>>()
        .join("/");

    let rejected = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "create_successor",
        "repositoryPath": destination,
        "expectedBaseCommitOid": baseline,
        "targetRef": "refs/maka/accepted",
        "path": overdeep_path,
        "content": "must not publish\n",
    }));

    assert_eq!(rejected.status.code(), Some(1));
    let rejected: serde_json::Value = serde_json::from_slice(&rejected.stdout).unwrap();
    assert_eq!(rejected["reason"], "source_tree_depth_exceeded");
    assert_eq!(
        git_bare_output(&destination, ["rev-parse", "refs/maka/accepted"]),
        baseline
    );
}

fn invoke_helper(repository_path: &Path) -> Output {
    invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "inspect_repository",
        "repositoryPath": repository_path,
    }))
}

fn invoke_request(request: serde_json::Value) -> Output {
    let mut child = Command::new(HELPER)
        .env("PATH", "")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "extensions.objectFormat")
        .env("GIT_CONFIG_VALUE_0", "sha256")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&request).unwrap().as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn git_bare_output<const N: usize>(repository: &Path, args: [&str; N]) -> String {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(repository)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn git_bare_succeeds<const N: usize>(repository: &Path, args: [&str; N]) -> bool {
    Command::new("git")
        .arg("--git-dir")
        .arg(repository)
        .args(args)
        .status()
        .unwrap()
        .success()
}

fn git_bare_bytes<const N: usize>(repository: &Path, args: [&str; N]) -> Vec<u8> {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(repository)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success());
    output.stdout
}

struct RepositoryFixture {
    root: PathBuf,
}

impl RepositoryFixture {
    fn sha1_with_commit() -> Self {
        let fixture = Self::init("sha1");
        fs::write(fixture.root.join("hello.txt"), b"hello from sha1\n").unwrap();
        fixture.git(["add", "hello.txt"]);
        fixture.git([
            "-c",
            "user.name=Maka Test",
            "-c",
            "user.email=maka@example.invalid",
            "commit",
            "-m",
            "fixture",
        ]);
        fixture
    }

    fn sha256_unborn() -> Self {
        Self::init("sha256")
    }

    fn unknown_object_format() -> Self {
        let fixture = Self::init("sha1");
        fixture.git(["config", "core.repositoryFormatVersion", "1"]);
        fixture.git(["config", "extensions.objectFormat", "sha512"]);
        fixture
    }

    fn sha1_with_replacement_ref() -> (Self, String, String) {
        let fixture = Self::sha1_with_commit();
        let raw_commit = fixture.git_output(["rev-parse", "HEAD"]);
        let raw_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);

        fs::write(fixture.root.join("hello.txt"), b"replacement content\n").unwrap();
        fixture.git(["add", "hello.txt"]);
        fixture.git([
            "-c",
            "user.name=Maka Test",
            "-c",
            "user.email=maka@example.invalid",
            "commit",
            "-m",
            "replacement",
        ]);
        let replacement_commit = fixture.git_output(["rev-parse", "HEAD"]);
        fixture.git(["replace", &raw_commit, &replacement_commit]);
        fixture.git(["checkout", "--detach", &raw_commit]);

        (fixture, raw_commit, raw_tree)
    }

    fn init(object_format: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "maka-gitoxide-helper-admission-{}-{nonce}-{}",
            std::process::id(),
            FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).unwrap();
        let fixture = Self { root };
        fixture.git([
            "init",
            "--quiet",
            &format!("--object-format={object_format}"),
        ]);
        fixture
    }

    fn git<const N: usize>(&self, args: [&str; N]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git fixture command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output<const N: usize>(&self, args: [&str; N]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
}

impl Drop for RepositoryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
