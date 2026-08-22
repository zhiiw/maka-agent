use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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

#[test]
fn materializes_an_accepted_commit_into_a_fresh_projection_without_git_metadata() {
    let fixture = RepositoryFixture::sha1_with_commit();
    fs::create_dir_all(fixture.root.join("docs")).unwrap();
    fs::write(fixture.root.join("docs/guide.txt"), b"nested guide\n").unwrap();
    fs::write(fixture.root.join("script.sh"), b"#!/bin/sh\necho hello\n").unwrap();
    fixture.git(["add", "docs/guide.txt", "script.sh"]);
    fixture.git(["update-index", "--chmod=+x", "script.sh"]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "projection fixture",
    ]);
    let accepted_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let accepted_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);
    let destination = fixture.root.join("projection");

    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "materialize_projection",
        "repositoryPath": fixture.root,
        "acceptedCommitOid": accepted_commit,
        "destinationPath": destination,
    }));

    assert!(
        output.status.success(),
        "broker failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["kind"], "projection_materialized");
    assert_eq!(response["acceptedCommitOid"], accepted_commit);
    assert_eq!(response["acceptedTreeOid"], accepted_tree);
    assert_eq!(response["filesMaterialized"], 3);
    assert_eq!(response["bytesWritten"], 50);
    assert_eq!(
        fs::read(destination.join("hello.txt")).unwrap(),
        b"hello from sha1\n"
    );
    assert_eq!(
        fs::read(destination.join("docs/guide.txt")).unwrap(),
        b"nested guide\n"
    );
    assert_eq!(
        fs::read(destination.join("script.sh")).unwrap(),
        b"#!/bin/sh\necho hello\n"
    );
    assert!(!destination.join(".git").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(
            fs::metadata(destination.join("script.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
    }
}

#[test]
fn refuses_to_materialize_into_a_preexisting_destination() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let accepted_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("projection");
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("external.txt"), b"preserve me\n").unwrap();

    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "materialize_projection",
        "repositoryPath": fixture.root,
        "acceptedCommitOid": accepted_commit,
        "destinationPath": destination,
    }));

    assert_eq!(output.status.code(), Some(1));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["reason"], "projection_destination_not_fresh");
    assert_eq!(
        fs::read(destination.join("external.txt")).unwrap(),
        b"preserve me\n"
    );
    assert!(!destination.join("hello.txt").exists());
}

#[test]
fn rejects_symlinks_before_they_gain_a_projection_filesystem_capability() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let link_oid = fixture.git_with_input(["hash-object", "-w", "--stdin"], b"../../outside");
    let cache_info = format!("120000,{link_oid},link");
    fixture.git(["update-index", "--add", "--cacheinfo", cache_info.as_str()]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "add symlink entry",
    ]);
    let accepted_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("projection");

    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "materialize_projection",
        "repositoryPath": fixture.root,
        "acceptedCommitOid": accepted_commit,
        "destinationPath": destination,
    }));

    assert_eq!(output.status.code(), Some(1));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["reason"], "unsupported_projection_entry_kind");
    assert!(!destination.join("link").exists());
}

#[test]
fn an_interrupted_projection_is_discardable_and_retryable() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let large_bytes = vec![0x5a; 64 * 1024 * 1024];
    fs::write(fixture.root.join("large.bin"), &large_bytes).unwrap();
    fixture.git(["add", "large.bin"]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "large projection fixture",
    ]);
    drop(large_bytes);
    let accepted_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let interrupted_destination = fixture.root.join("projection-interrupted");
    let mut child = spawn_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "materialize_projection",
        "repositoryPath": fixture.root,
        "acceptedCommitOid": accepted_commit,
        "destinationPath": interrupted_destination,
    }));

    let deadline = Instant::now() + Duration::from_secs(10);
    while !interrupted_destination.join("large.bin").exists() {
        assert!(
            Instant::now() < deadline,
            "projection did not start in time"
        );
        assert!(
            child.try_wait().unwrap().is_none(),
            "broker exited before it could be killed"
        );
        thread::sleep(Duration::from_millis(1));
    }
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    assert!(!interrupted_destination.join(".git").exists());

    fs::remove_dir_all(&interrupted_destination).unwrap();
    let retry_destination = fixture.root.join("projection-retry");
    let output = invoke_broker(serde_json::json!({
        "protocolVersion": 1,
        "operation": "materialize_projection",
        "repositoryPath": fixture.root,
        "acceptedCommitOid": accepted_commit,
        "destinationPath": retry_destination,
    }));
    assert!(
        output.status.success(),
        "retry failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::metadata(retry_destination.join("large.bin"))
            .unwrap()
            .len(),
        64 * 1024 * 1024
    );
}

fn invoke_broker(request: serde_json::Value) -> Output {
    spawn_broker(request).wait_with_output().unwrap()
}

fn spawn_broker(request: serde_json::Value) -> Child {
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
    child
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

    fn git_with_input<const N: usize>(&self, args: [&str; N], input: &[u8]) -> String {
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "git fixture command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
}

impl Drop for RepositoryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
