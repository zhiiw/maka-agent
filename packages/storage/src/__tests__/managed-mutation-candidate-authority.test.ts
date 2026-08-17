import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, before, describe, test } from 'node:test';
import { createGitWorkspaceService, type GitWorkspaceService } from '../git-workspace-service.js';
import { requireManagedBaselineReceiptAuthorityInternal } from '../managed-baseline-receipt-authority-internal.js';
import { requireManagedMutationCandidateAuthorityInternal } from '../managed-mutation-candidate-authority-internal.js';

const execFileAsync = promisify(execFile);
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
    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'candidate\n', 'utf8');

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
    const request = candidateRequest(binding, baseline);
    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'candidate\n', 'utf8');

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
  });

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
    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'candidate\n', 'utf8');
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

  test('rejects undeclared and ignored workspace changes before publishing a ref', async () => {
    for (const extraPath of ['extra.txt', 'ignored.env']) {
      const root = await temporaryRoot();
      const sourceRoot = await createEligibleSource(join(root, `source-${extraPath}`));
      const service = await serviceAt(join(root, `storage-${extraPath}`));
      const binding = await service.createManagedWorkspaceFromSource(openRequest(sourceRoot));
      const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);
      await writeFile(join(binding.worktreePath, 'tracked.txt'), 'candidate\n', 'utf8');
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
) {
  return {
    binding,
    operationId: 'operation-candidate-1',
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
    expectedPaths: ['tracked.txt'],
    executionProfileDigest: `sha256:${'e'.repeat(64)}`,
  } as const;
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
  await writeFile(join(sourceRoot, 'tracked.txt'), 'tracked\n', 'utf8');
  await writeFile(join(sourceRoot, '.gitignore'), 'ignored.env\n', 'utf8');
  await git(sourceRoot, 'add', 'tracked.txt', '.gitignore');
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
