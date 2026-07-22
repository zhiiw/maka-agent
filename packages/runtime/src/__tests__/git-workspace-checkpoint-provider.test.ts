import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';

import {
  DEFAULT_GIT_WORKSPACE_SNAPSHOT_POLICY_V1,
  GitWorkspaceCheckpointProvider,
  workspaceSnapshotPolicyIdentity,
} from '../git-workspace-checkpoint-provider.js';
import type { WorkspaceCheckpointFact } from '../workspace-checkpoint.js';

const run = promisify(execFile);

describe('GitWorkspaceCheckpointProvider observe-only capture', () => {
  test('captures exact tracked and untracked bytes without changing user Git state', async (t) => {
    if (!(await gitAvailable())) return t.skip('git is unavailable');
    const root = await mkdtemp(join(tmpdir(), 'maka-git-checkpoint-'));
    try {
      await git(root, ['init', '--quiet']);
      await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
      await writeFile(join(root, 'tracked.txt'), 'before\n');
      await git(root, ['add', '.gitignore', 'tracked.txt']);
      await writeFile(join(root, 'tracked.txt'), 'after\n');
      await writeFile(join(root, 'untracked.txt'), 'deliverable\n');
      await writeFile(join(root, 'ignored.txt'), 'secret\n');
      const statusBefore = await git(root, ['status', '--porcelain=v1']);
      const indexBefore = await readFile(join(root, '.git', 'index'));

      const provider = new GitWorkspaceCheckpointProvider();
      const prepared = await provider.capture({
        workspaceRoot: root,
        checkpointId: 'checkpoint-1',
        sessionId: 'session-1',
        boundaryDigest: digest('b'),
        policy: DEFAULT_GIT_WORKSPACE_SNAPSHOT_POLICY_V1,
      });

      assert.equal(prepared.artifact.kind, 'git_repository_v1');
      assert.match(prepared.artifact.retentionRef, /^refs\/maka\/checkpoints\//);
      assert.equal(await git(root, ['status', '--porcelain=v1']), statusBefore);
      assert.deepEqual(await readFile(join(root, '.git', 'index')), indexBefore);
      assert.equal(
        await git(root, ['show', `${prepared.artifact.commitOid}:tracked.txt`]),
        'after\n',
      );
      assert.equal(
        await git(root, ['show', `${prepared.artifact.commitOid}:untracked.txt`]),
        'deliverable\n',
      );
      await assert.rejects(git(root, ['show', `${prepared.artifact.commitOid}:ignored.txt`]));
      assert.equal((await provider.listOrphanRetentionRefs(root, new Set())).length, 1);
      assert.deepEqual(
        await provider.listOrphanRetentionRefs(root, new Set([prepared.artifact.retentionRef])),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('validates current tree identity and reports drift without restoring', async (t) => {
    if (!(await gitAvailable())) return t.skip('git is unavailable');
    const root = await mkdtemp(join(tmpdir(), 'maka-git-validate-'));
    try {
      await git(root, ['init', '--quiet']);
      await writeFile(join(root, 'file.txt'), 'one\n');
      await git(root, ['add', 'file.txt']);
      const provider = new GitWorkspaceCheckpointProvider();
      const prepared = await provider.capture({
        workspaceRoot: root,
        checkpointId: 'checkpoint-1',
        sessionId: 'session-1',
        boundaryDigest: digest('b'),
        policy: DEFAULT_GIT_WORKSPACE_SNAPSHOT_POLICY_V1,
      });
      const fact = checkpointFact(prepared, provider);

      assert.equal(
        (await provider.validate({ checkpoint: fact, currentWorkspace: prepared.workspace }))
          .disposition,
        'current_matches',
      );
      await writeFile(join(root, 'file.txt'), 'two\n');
      assert.equal(
        (await provider.validate({ checkpoint: fact, currentWorkspace: prepared.workspace }))
          .disposition,
        'drifted_restore_unavailable',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function checkpointFact(
  prepared: Awaited<ReturnType<GitWorkspaceCheckpointProvider['capture']>>,
  provider: GitWorkspaceCheckpointProvider,
): WorkspaceCheckpointFact {
  return {
    protocol: 'workspace_checkpoint_v1',
    checkpointId: 'checkpoint-1',
    kind: 'captured',
    coveredBoundary: {
      sourceInvocationId: 'invocation-1',
      sourceRunId: 'run-1',
      sourceTurnId: 'turn-1',
      sourceHighWater: 1,
      replaySources: [],
      replayManifestDigest: digest('b'),
    },
    workspaceEpochId: 'epoch-1',
    workspace: prepared.workspace,
    coverage: provider.capabilities.coverage,
    capabilities: provider.capabilities,
    providerId: provider.id,
    artifact: prepared.artifact,
    policy: workspaceSnapshotPolicyIdentity(DEFAULT_GIT_WORKSPACE_SNAPSHOT_POLICY_V1),
    capturedAt: new Date().toISOString(),
  };
}

async function gitAvailable(): Promise<boolean> {
  return run('git', ['--version'], { windowsHide: true }).then(
    () => true,
    () => false,
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd, windowsHide: true, encoding: 'utf8' })).stdout;
}

function digest(value: string): string {
  return `sha256:${value.repeat(64).slice(0, 64)}`;
}
