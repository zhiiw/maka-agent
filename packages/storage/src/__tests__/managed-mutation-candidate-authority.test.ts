import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createGitWorkspaceService,
  type GitWorkspaceService,
  type ManagedWorkspaceBinding,
} from '../git-workspace-service.js';
import { requireManagedBaselineReceiptAuthorityInternal } from '../managed-baseline-receipt-authority-internal.js';
import {
  type ManagedMutationCandidateReceiptV1,
  type ManagedMutationCandidateRequest,
  requireManagedMutationCandidateAuthorityInternal,
} from '../managed-mutation-candidate-authority-internal.js';

const execFileAsync = promisify(execFile);
const RUN_REAL_PROCESS_CRASH_TESTS = process.env.MAKA_STORAGE_STRESS === '1';
const cleanup: string[] = [];
let gitExecutablePath: string;
let gitExecutableSha256: `sha256:${string}`;

before(async () => {
  gitExecutablePath = await findGitExecutable();
  gitExecutableSha256 = await sha256File(gitExecutablePath);
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('managed mutation candidate authority', () => {
  test('captures only the declared workspace mutation as a base-bound Git candidate', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);

    const receipt = await requireManagedMutationCandidateAuthorityInternal(service).capture(
      candidateRequest(binding, baseline),
    );

    assert.equal(receipt.baseHead.commitOid, binding.baselineCommitOid);
    assert.deepEqual(receipt.changedPaths, ['tracked.txt']);
    assert.deepEqual(receipt.deletedPaths, []);
    assert.equal(
      await gitBare(binding.repositoryPath, 'rev-parse', '--verify', receipt.candidateRef),
      receipt.candidateCommitOid,
    );
    assert.equal(
      await gitBare(binding.repositoryPath, 'rev-parse', `${receipt.candidateCommitOid}^`),
      binding.baselineCommitOid,
    );
    assert.notEqual(receipt.candidateTreeOid, binding.baselineTreeOid);
    assert.equal(await git(binding.worktreePath, 'rev-parse', 'HEAD'), binding.baselineCommitOid);
    assert.equal(
      await gitBare(binding.repositoryPath, 'rev-parse', '--verify', binding.headRef),
      binding.baselineCommitOid,
    );
    assert.deepEqual(
      await requireManagedMutationCandidateAuthorityInternal(service).capture(
        candidateRequest(binding, baseline),
      ),
      receipt,
    );
  });

  test('rejects a non-UTF-8 base blob before issuing transform input', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source-binary'));
    await writeFile(join(sourceRoot, 'tracked.txt'), Buffer.from([0xff, 0xfe, 0x00, 0x61]));
    await git(sourceRoot, 'add', 'tracked.txt');
    await git(
      sourceRoot,
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '--quiet',
      '-m',
      'binary baseline',
    );
    const service = await serviceAt(join(root, 'storage-binary'));
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);
    const request = candidateRequest(binding, baseline);

    await assert.rejects(
      requireManagedMutationCandidateAuthorityInternal(service).readBaseFile(
        binding,
        request.baseHead,
        'tracked.txt',
      ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'managed_mutation_candidate_rejected',
    );
  });

  test('rotates the projection and preserves concurrent external content', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);
    const authority = requireManagedMutationCandidateAuthorityInternal(service);
    const receipt = await authority.capture(candidateRequest(binding, baseline));

    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'external concurrent content\n');
    await authority.accept(binding, receipt);

    assert.equal(await readFile(join(binding.worktreePath, 'tracked.txt'), 'utf8'), 'candidate\n');
    const quarantineRoot = join(dirname(binding.worktreePath), 'projection-quarantine');
    const quarantined = await readdir(quarantineRoot);
    assert.equal(quarantined.length, 1);
    assert.equal(
      await readFile(join(quarantineRoot, quarantined[0]!, 'tracked.txt'), 'utf8'),
      'external concurrent content\n',
    );
  });

  test('rejects a tampered Windows quarantine junction without deleting its target metadata', {
    skip: process.platform !== 'win32',
  }, async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);
    const authority = requireManagedMutationCandidateAuthorityInternal(service);
    const receipt = await authority.capture(candidateRequest(binding, baseline));
    const digest = receipt.candidateRef.split('/').at(-1)!;
    const quarantineRoot = join(dirname(binding.worktreePath), 'projection-quarantine');
    const externalWorktree = join(root, 'external-worktree');
    const externalGitMetadata = join(externalWorktree, '.git');
    await mkdir(quarantineRoot, { recursive: true });
    await mkdir(externalWorktree);
    await writeFile(externalGitMetadata, 'external git metadata\n', 'utf8');
    await symlink(externalWorktree, join(quarantineRoot, digest), 'junction');

    await assert.rejects(authority.accept(binding, receipt));
    assert.equal(await readFile(externalGitMetadata, 'utf8'), 'external git metadata\n');
  });

  test('rejects a tampered POSIX quarantine symlink without deleting its target metadata', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);
    const authority = requireManagedMutationCandidateAuthorityInternal(service);
    const receipt = await authority.capture(candidateRequest(binding, baseline));
    const digest = receipt.candidateRef.split('/').at(-1)!;
    const quarantineRoot = join(dirname(binding.worktreePath), 'projection-quarantine');
    const externalWorktree = join(root, 'external-worktree');
    const externalGitMetadata = join(externalWorktree, '.git');
    await mkdir(quarantineRoot, { recursive: true });
    await mkdir(externalWorktree);
    await writeFile(externalGitMetadata, 'external git metadata\n', 'utf8');
    await symlink(externalWorktree, join(quarantineRoot, digest), 'dir');

    await assert.rejects(authority.accept(binding, receipt));
    assert.equal(await readFile(externalGitMetadata, 'utf8'), 'external git metadata\n');
  });

  test('resumes projection rotation after the previous worktree was preserved', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const storageRoot = join(root, 'storage');
    let stopped = false;
    const interrupted = createGitWorkspaceService({
      storageRoot,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      failpoint(point) {
        if (point === 'after_mutation_projection_previous' && !stopped) {
          stopped = true;
          throw new Error('simulated process stop after preserving previous projection');
        }
      },
    });
    const binding = await interrupted.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const baseline =
      await requireManagedBaselineReceiptAuthorityInternal(interrupted).issue(binding);
    const authority = requireManagedMutationCandidateAuthorityInternal(interrupted);
    const receipt = await authority.capture(candidateRequest(binding, baseline));
    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'external before crash\n');

    await assert.rejects(
      authority.accept(binding, receipt),
      /simulated process stop after preserving previous projection/u,
    );

    const restarted = await serviceAt(storageRoot);
    await restarted.openManagedWorkspaceFromBinding(openRequest(sourceRoot));
    assert.equal(await readFile(join(binding.worktreePath, 'tracked.txt'), 'utf8'), 'candidate\n');
    const previous = await readdir(join(dirname(binding.worktreePath), 'projection-quarantine'));
    assert.equal(
      await readFile(
        join(dirname(binding.worktreePath), 'projection-quarantine', previous[0]!, 'tracked.txt'),
        'utf8',
      ),
      'external before crash\n',
    );
  });

  test('converges the same candidate when the process stops after ref publication', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const storageRoot = join(root, 'storage');
    let stopped = false;
    const interrupted = createGitWorkspaceService({
      storageRoot,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      failpoint: (point) => {
        if (point === 'after_mutation_candidate_ref' && !stopped) {
          stopped = true;
          throw new Error('simulated process stop after candidate ref');
        }
      },
    });
    const binding = await interrupted.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const baseline =
      await requireManagedBaselineReceiptAuthorityInternal(interrupted).issue(binding);
    const request = candidateRequest(
      binding,
      baseline,
      ['docs/a.md'],
      'operation-nested-ref-retry',
    );

    await assert.rejects(
      requireManagedMutationCandidateAuthorityInternal(interrupted).capture(request),
      /simulated process stop/u,
    );

    const restarted = await serviceAt(storageRoot);
    const recovered =
      await requireManagedMutationCandidateAuthorityInternal(restarted).capture(request);
    assert.equal(
      await gitBare(binding.repositoryPath, 'rev-parse', '--verify', recovered.candidateRef),
      recovered.candidateCommitOid,
    );
    assert.equal(
      await gitBare(
        binding.repositoryPath,
        'for-each-ref',
        '--format=%(refname)',
        'refs/maka/candidates/',
      ),
      recovered.candidateRef,
    );
    assert.deepEqual(recovered.changedPaths, ['docs/a.md']);
  });

  for (const mutation of ['add', 'modify', 'delete'] as const) {
    test(`captures a nested ${mutation} as the exact changed path`, async () => {
      const root = await temporaryRoot();
      const sourceRoot = await createEligibleSource(join(root, `source-${mutation}`));
      const service = await serviceAt(join(root, `storage-${mutation}`));
      const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
      const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);
      const relativePath = mutation === 'add' ? 'docs/new.md' : 'docs/a.md';
      const receipt = await requireManagedMutationCandidateAuthorityInternal(service).capture(
        candidateRequest(
          binding,
          baseline,
          [relativePath],
          `operation-nested-${mutation}`,
          mutation === 'delete' ? null : `${mutation}\n`,
        ),
      );

      assert.deepEqual(receipt.changedPaths, [relativePath]);
      assert.deepEqual(receipt.deletedPaths, mutation === 'delete' ? [relativePath] : []);
    });
  }

  test('rejects a candidate that changes a regular file into a symlink', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);
    await rm(join(binding.worktreePath, 'tracked.txt'));
    await symlink('outside-target', join(binding.worktreePath, 'tracked.txt'));

    await assert.rejects(
      requireManagedMutationCandidateAuthorityInternal(service).capture(
        candidateRequest(binding, baseline),
      ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'managed_mutation_candidate_rejected',
    );
  });

  test('rejects a durable receipt whose workspace policy no longer matches the baseline', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const service = await serviceAt(join(root, 'storage'));
    const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);
    const request = candidateRequest(binding, baseline);
    await requireManagedMutationCandidateAuthorityInternal(service).capture(request);

    const receiptRoot = join(dirname(binding.worktreePath), 'mutation-candidates');
    const receiptName = (await readdir(receiptRoot)).find((name) => name.endsWith('.json'));
    assert.ok(receiptName);
    const receiptPath = join(receiptRoot, receiptName);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.workspacePolicyHash = `sha256:${'f'.repeat(64)}`;
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, 'utf8');

    await assert.rejects(
      requireManagedMutationCandidateAuthorityInternal(service).capture(request),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'managed_workspace_identity_conflict',
    );
  });

  test('resumes candidate discard after the ref was deleted', async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const storageRoot = join(root, 'storage');
    let stopped = false;
    const interrupted = createGitWorkspaceService({
      storageRoot,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      failpoint: (point) => {
        if (point === 'after_mutation_candidate_discard_ref' && !stopped) {
          stopped = true;
          throw new Error('simulated process stop after candidate ref deletion');
        }
      },
    });
    const binding = await interrupted.createManagedWorkspaceFromSource(openRequest(sourceRoot));
    const baseline =
      await requireManagedBaselineReceiptAuthorityInternal(interrupted).issue(binding);
    const receipt = await requireManagedMutationCandidateAuthorityInternal(interrupted).capture(
      candidateRequest(binding, baseline),
    );

    await assert.rejects(
      requireManagedMutationCandidateAuthorityInternal(interrupted).discard(receipt),
      /simulated process stop/u,
    );

    const restarted = await serviceAt(storageRoot);
    await requireManagedMutationCandidateAuthorityInternal(restarted).discard(receipt);
    await requireManagedMutationCandidateAuthorityInternal(restarted).discard(receipt);
    await assert.rejects(
      gitBare(binding.repositoryPath, 'rev-parse', '--verify', receipt.candidateRef),
    );
  });

  test('converges candidate capture after a real process is killed post-ref', {
    skip: !RUN_REAL_PROCESS_CRASH_TESTS,
    timeout: 60_000,
  }, async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const storageRoot = join(root, 'storage');
    const outputPath = join(root, 'mutation-output.json');
    const child = spawnMutationCrashChild({
      action: 'mutation-capture',
      failpoint: 'after_mutation_candidate_ref',
      sourceRoot,
      storageRoot,
      outputPath,
    });
    try {
      await waitForReady(child, 30_000);
      child.kill('SIGKILL');
      await waitForExit(child);
      const { candidateRequest } = JSON.parse(await readFile(outputPath, 'utf8')) as {
        candidateRequest: ManagedMutationCandidateRequest;
      };

      const restarted = await serviceAt(storageRoot);
      const receipt =
        await requireManagedMutationCandidateAuthorityInternal(restarted).capture(candidateRequest);
      assert.deepEqual(receipt.changedPaths, ['docs/a.md']);
      assert.equal(
        await gitBare(candidateRequest.binding.repositoryPath, 'rev-parse', receipt.candidateRef),
        receipt.candidateCommitOid,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  test('converges candidate discard after a real process is killed post-ref deletion', {
    skip: !RUN_REAL_PROCESS_CRASH_TESTS,
    timeout: 60_000,
  }, async () => {
    const root = await temporaryRoot();
    const sourceRoot = await createEligibleSource(join(root, 'source'));
    const storageRoot = join(root, 'storage');
    const outputPath = join(root, 'mutation-output.json');
    const child = spawnMutationCrashChild({
      action: 'mutation-discard',
      failpoint: 'after_mutation_candidate_discard_ref',
      sourceRoot,
      storageRoot,
      outputPath,
    });
    try {
      await waitForReady(child, 30_000);
      child.kill('SIGKILL');
      await waitForExit(child);
      const { binding, receipt } = JSON.parse(await readFile(outputPath, 'utf8')) as {
        binding: ManagedWorkspaceBinding;
        receipt: ManagedMutationCandidateReceiptV1;
      };

      const restarted = await serviceAt(storageRoot);
      await requireManagedMutationCandidateAuthorityInternal(restarted).discard(receipt);
      await requireManagedMutationCandidateAuthorityInternal(restarted).discard(receipt);
      await assert.rejects(
        gitBare(binding.repositoryPath, 'rev-parse', '--verify', receipt.candidateRef),
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  test('converges projection rotation after a real process is killed without overwriting drift', {
    skip: !RUN_REAL_PROCESS_CRASH_TESTS,
    timeout: 120_000,
  }, async () => {
    for (const failpoint of [
      'after_mutation_projection_previous',
      'after_mutation_projection_publish',
    ] as const) {
      const root = await temporaryRoot();
      const sourceRoot = await createEligibleSource(join(root, `source-${failpoint}`));
      const storageRoot = join(root, `storage-${failpoint}`);
      const outputPath = join(root, `mutation-output-${failpoint}.json`);
      const child = spawnMutationCrashChild({
        action: 'mutation-accept',
        failpoint,
        sourceRoot,
        storageRoot,
        outputPath,
      });
      try {
        await waitForReady(child, 30_000);
        child.kill('SIGKILL');
        await waitForExit(child);
        const { binding, receipt } = JSON.parse(await readFile(outputPath, 'utf8')) as {
          binding: ManagedWorkspaceBinding;
          receipt: ManagedMutationCandidateReceiptV1;
        };

        const restarted = await serviceAt(storageRoot);
        await restarted.openManagedWorkspaceFromBinding(openRequest(sourceRoot));
        assert.equal(
          await readFile(join(binding.worktreePath, 'docs', 'a.md'), 'utf8'),
          'candidate from child\n',
        );
        const previous = await readdir(
          join(dirname(binding.worktreePath), 'projection-quarantine'),
        );
        const preserved = await Promise.all(
          previous.map((name) =>
            readFile(
              join(dirname(binding.worktreePath), 'projection-quarantine', name, 'docs', 'a.md'),
              'utf8',
            ),
          ),
        );
        assert.ok(preserved.includes('external before crash\n'));
        assert.equal(
          await gitBare(binding.repositoryPath, 'rev-parse', '--verify', binding.headRef),
          receipt.candidateCommitOid,
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  });

  test('rejects undeclared and ignored workspace changes before publishing a ref', async () => {
    for (const extraPath of ['extra.txt', 'ignored.env']) {
      const root = await temporaryRoot();
      const sourceRoot = await createEligibleSource(join(root, `source-${extraPath}`));
      const service = await serviceAt(join(root, `storage-${extraPath}`));
      const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
      const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);
      await writeFile(join(binding.worktreePath, extraPath), 'not declared\n', 'utf8');

      await assert.rejects(
        requireManagedMutationCandidateAuthorityInternal(service).capture(
          candidateRequest(binding, baseline),
        ),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'managed_mutation_candidate_rejected',
      );
      assert.equal(
        await gitBare(
          binding.repositoryPath,
          'for-each-ref',
          '--format=%(refname)',
          'refs/maka/candidates/',
        ),
        '',
      );
    }
  });
});

function candidateRequest(
  binding: Awaited<ReturnType<GitWorkspaceService['createManagedWorkspaceFromSource']>>,
  baseline: Awaited<
    ReturnType<ReturnType<typeof requireManagedBaselineReceiptAuthorityInternal>['issue']>
  >,
  expectedPaths: readonly string[] = ['tracked.txt'],
  operationId = 'operation-candidate-1',
  expectedContent: string | null = 'candidate\n',
) {
  return {
    binding,
    operationId,
    baseHead: {
      repositoryId: binding.repositoryId,
      workspaceId: binding.workspaceId,
      workspaceEpochId: binding.workspaceEpochId,
      workspaceVersionId: baseline.workspaceVersionId,
      acceptedEventId: baseline.baselineAcceptedEventId,
      commitOid: binding.baselineCommitOid,
      treeOid: binding.baselineTreeOid,
      revision: 1,
    },
    expectedPaths,
    expectedBlobOid: expectedContent === null ? null : gitBlobOid(expectedContent),
    expectedContent,
    executionProfileDigest: `sha256:${'e'.repeat(64)}`,
  } as const;
}

function gitBlobOid(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

async function serviceAt(storageRoot: string): Promise<GitWorkspaceService> {
  return createGitWorkspaceService({
    storageRoot,
    gitRuntime: {
      executablePath: gitExecutablePath,
      expectedSha256: gitExecutableSha256,
    },
  });
}

function openRequest(sourceRoot: string) {
  return {
    repositoryId: 'repository_11111111111111111111111111111111',
    workspaceId: 'workspace_22222222222222222222222222222222',
    workspaceEpochId: 'epoch_33333333333333333333333333333333',
    workspaceInstanceId: 'instance_44444444444444444444444444444444',
    sourceRoot,
  } as const;
}

async function createEligibleSource(sourceRoot: string): Promise<string> {
  await mkdir(sourceRoot, { recursive: true });
  await git(sourceRoot, 'init', '--quiet');
  await mkdir(join(sourceRoot, 'docs'), { recursive: true });
  await writeFile(join(sourceRoot, 'tracked.txt'), 'tracked\n', 'utf8');
  await writeFile(join(sourceRoot, 'docs', 'a.md'), 'nested\n', 'utf8');
  await writeFile(join(sourceRoot, '.gitignore'), 'ignored.env\n', 'utf8');
  await git(sourceRoot, 'add', 'tracked.txt', 'docs/a.md', '.gitignore');
  await git(
    sourceRoot,
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@maka.invalid',
    'commit',
    '--quiet',
    '-m',
    'source baseline',
  );
  return realpath(sourceRoot);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-mutation-candidate-'));
  cleanup.push(root);
  return root;
}

async function findGitExecutable(): Promise<string> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const { stdout } = await execFileAsync(command, ['git'], { encoding: 'utf8' });
  const first = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) throw new Error('Git executable is unavailable for integration tests');
  return realpath(first);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function spawnMutationCrashChild(input: {
  action: 'mutation-capture' | 'mutation-discard' | 'mutation-accept';
  failpoint:
    | 'after_mutation_candidate_ref'
    | 'after_mutation_candidate_discard_ref'
    | 'after_mutation_projection_previous'
    | 'after_mutation_projection_publish';
  sourceRoot: string;
  storageRoot: string;
  outputPath: string;
}): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/git-workspace-service-crash-child.js', import.meta.url))],
    {
      env: {
        ...process.env,
        MAKA_GIT_WORKSPACE_ACTION: input.action,
        MAKA_GIT_WORKSPACE_FAILPOINT: input.failpoint,
        MAKA_GIT_WORKSPACE_SOURCE: input.sourceRoot,
        MAKA_GIT_WORKSPACE_STORAGE: input.storageRoot,
        MAKA_GIT_WORKSPACE_EXECUTABLE: gitExecutablePath,
        MAKA_GIT_WORKSPACE_SHA256: gitExecutableSha256,
        MAKA_GIT_WORKSPACE_MUTATION_OUTPUT: input.outputPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function waitForReady(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanupListeners();
      reject(new Error(`Managed mutation crash child did not become ready: ${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk: unknown) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) {
        cleanupListeners();
        resolve();
      }
    };
    const onStderr = (chunk: unknown) => {
      stderr += String(chunk);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanupListeners();
      reject(new Error(`Managed mutation crash child exited early: ${code}/${signal} ${stderr}`));
    };
    const onError = (error: Error) => {
      cleanupListeners();
      reject(error);
    };
    const cleanupListeners = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitBare(repositoryPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.longpaths=true', '--git-dir', repositoryPath, ...args],
    {
      cwd: dirname(repositoryPath),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return stdout.trim();
}
