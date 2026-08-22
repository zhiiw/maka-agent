use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

const BROKER: &str = env!("CARGO_BIN_EXE_maka-gitoxide-broker");

#[test]
fn inspects_a_sha1_repository_without_invoking_git_from_the_broker() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let expected_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let expected_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);

    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "inspect_repository",
        "repositoryPath": fixture.root,
    }));

    assert!(
        output.status.success(),
        "broker failed: {}",
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
fn rejects_sha256_before_returning_a_repository_capability() {
    let fixture = RepositoryFixture::sha256_unborn();

    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "inspect_repository",
        "repositoryPath": fixture.root,
    }));

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
fn publishes_a_successor_only_from_the_exact_base_commit() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let base_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let target_ref = "refs/maka/accepted";
    fixture.git(["update-ref", target_ref, base_commit.as_str()]);

    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "create_successor",
        "repositoryPath": fixture.root,
        "expectedBaseCommitOid": base_commit,
        "targetRef": target_ref,
        "path": "docs/hello.txt",
        "content": "successor content\n",
    }));

    assert!(
        output.status.success(),
        "broker failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["protocolVersion"], 1);
    assert_eq!(response["kind"], "successor_published");
    assert_eq!(response["objectFormat"], "sha1");
    assert_eq!(response["baseCommitOid"], base_commit);
    assert_eq!(response["targetRef"], target_ref);
    assert_eq!(response["path"], "docs/hello.txt");

    let successor_commit = response["successorCommitOid"].as_str().unwrap();
    let successor_tree = response["successorTreeOid"].as_str().unwrap();
    let result_blob = response["resultBlobOid"].as_str().unwrap();
    assert_eq!(
        fixture.git_output(["rev-parse", target_ref]),
        successor_commit
    );
    assert_eq!(
        fixture.git_output(["rev-parse", &format!("{successor_commit}^")]),
        base_commit
    );
    assert_eq!(
        fixture.git_output(["rev-parse", &format!("{successor_commit}^{{tree}}")]),
        successor_tree
    );
    assert_eq!(
        fixture.git_output(["rev-parse", &format!("{successor_commit}:docs/hello.txt")]),
        result_blob
    );
    assert_eq!(
        fixture.git_bytes(["show", &format!("{successor_commit}:docs/hello.txt")]),
        b"successor content\n"
    );
}

#[test]
fn rejects_a_successor_when_the_target_ref_no_longer_matches_the_base() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let expected_base = fixture.git_output(["rev-parse", "HEAD"]);
    let target_ref = "refs/maka/accepted";
    fixture.git(["update-ref", target_ref, expected_base.as_str()]);

    fs::write(fixture.root.join("concurrent.txt"), b"concurrent advance\n").unwrap();
    fixture.git(["add", "concurrent.txt"]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "concurrent",
    ]);
    let actual_base = fixture.git_output(["rev-parse", "HEAD"]);
    fixture.git(["update-ref", target_ref, actual_base.as_str()]);

    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "create_successor",
        "repositoryPath": fixture.root,
        "expectedBaseCommitOid": expected_base,
        "targetRef": target_ref,
        "path": "docs/should-not-exist.txt",
        "content": "must not publish\n",
    }));

    assert_eq!(output.status.code(), Some(3));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        response,
        serde_json::json!({
            "protocolVersion": 1,
            "kind": "successor_rejected",
            "reason": "base_commit_mismatch",
            "objectFormat": "sha1",
            "expectedBaseCommitOid": expected_base,
            "actualBaseCommitOid": actual_base,
            "targetRef": target_ref,
        })
    );
    assert_eq!(fixture.git_output(["rev-parse", target_ref]), actual_base);
    assert!(!fixture.git_succeeds([
        "cat-file",
        "-e",
        &format!("{actual_base}:docs/should-not-exist.txt"),
    ]));
}

#[test]
fn preserves_the_existing_executable_mode_in_the_successor_tree() {
    let fixture = RepositoryFixture::sha1_with_commit();
    fs::write(
        fixture.root.join("script.sh"),
        b"#!/bin/sh\necho original\n",
    )
    .unwrap();
    fixture.git(["add", "script.sh"]);
    fixture.git(["update-index", "--chmod=+x", "script.sh"]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "add executable",
    ]);
    let base_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let target_ref = "refs/maka/accepted";
    fixture.git(["update-ref", target_ref, base_commit.as_str()]);

    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "create_successor",
        "repositoryPath": fixture.root,
        "expectedBaseCommitOid": base_commit,
        "targetRef": target_ref,
        "path": "script.sh",
        "content": "#!/bin/sh\necho successor\n",
    }));

    assert!(
        output.status.success(),
        "broker failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let successor_commit = response["successorCommitOid"].as_str().unwrap();
    assert!(
        fixture
            .git_output(["ls-tree", successor_commit, "--", "script.sh"])
            .starts_with("100755 blob ")
    );
    assert_eq!(
        fixture.git_bytes(["show", &format!("{successor_commit}:script.sh")]),
        b"#!/bin/sh\necho successor\n"
    );
}

#[test]
fn leaves_the_accepted_ref_unchanged_when_publication_cannot_lock_it() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let base_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let target_ref = "refs/maka/accepted";
    fixture.git(["update-ref", target_ref, base_commit.as_str()]);
    fs::write(
        fixture.root.join(".git/refs/maka/accepted.lock"),
        b"held by test",
    )
    .unwrap();

    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "create_successor",
        "repositoryPath": fixture.root,
        "expectedBaseCommitOid": base_commit,
        "targetRef": target_ref,
        "path": "docs/not-published.txt",
        "content": "orphaned but unreachable\n",
    }));

    assert_eq!(output.status.code(), Some(1));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["kind"], "broker_error");
    assert_eq!(response["reason"], "successor_publish_failed");
    assert_eq!(fixture.git_output(["rev-parse", target_ref]), base_commit);
    assert!(!fixture.git_succeeds([
        "cat-file",
        "-e",
        &format!("{base_commit}:docs/not-published.txt"),
    ]));
}

#[test]
fn rejects_non_canonical_successor_paths_before_publication() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let base_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let target_ref = "refs/maka/accepted";
    fixture.git(["update-ref", target_ref, base_commit.as_str()]);

    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "create_successor",
        "repositoryPath": fixture.root,
        "expectedBaseCommitOid": base_commit,
        "targetRef": target_ref,
        "path": "docs/../outside.txt",
        "content": "must not publish\n",
    }));

    assert_eq!(output.status.code(), Some(1));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["kind"], "broker_error");
    assert_eq!(response["reason"], "invalid_successor_path");
    assert_eq!(fixture.git_output(["rev-parse", target_ref]), base_commit);
}

fn invoke_broker(request: serde_json::Value) -> Output {
    let mut child = Command::new(BROKER)
        // The broker must never use a system Git fallback. Fixtures are complete before this spawn.
        .env("PATH", "")
        // Repository identity must not be caller-controlled through Git's environment config seam.
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

    fn init(object_format: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "maka-gitoxide-admission-{}-{nonce}",
            std::process::id()
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
        String::from_utf8(self.git_bytes(args))
            .unwrap()
            .trim()
            .to_owned()
    }

    fn git_bytes<const N: usize>(&self, args: [&str; N]) -> Vec<u8> {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        output.stdout
    }

    fn git_succeeds<const N: usize>(&self, args: [&str; N]) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .output()
            .unwrap()
            .status
            .success()
    }
}

impl Drop for RepositoryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
