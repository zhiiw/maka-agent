import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core';

import {
  advanceWorkspaceEpoch,
  buildRuntimeBoundaryCursor,
  buildRuntimePrefixSegment,
  evaluateWorkspaceCheckpointCapabilities,
  InMemoryWorkspaceCheckpointProvider,
  parseWorkspaceRuntimeFact,
  selectWorkspaceCheckpointProvider,
  validateWorkspaceCheckpointForResume,
  verifyRuntimeBoundaryCursor,
  type RuntimeBoundaryCursor,
  type WorkspaceCheckpointFact,
  type WorkspaceCheckpointProviderDescriptor,
  type WorkspaceIdentity,
} from '../workspace-checkpoint.js';

describe('workspace checkpoint contracts', () => {
  test('binds an immutable RuntimeEvent prefix to its execution and workspace epoch', () => {
    const workspace = identity('workspace-1');
    const first = runtimeEvent('event-1', { kind: 'text', text: 'hello' });
    const second = runtimeEvent('event-2', { kind: 'text', text: 'world' });

    const segment = buildRuntimePrefixSegment({
      events: [first, second],
      highWater: 2,
      workspaceEpochId: 'epoch-1',
      workspace,
    });

    assert.equal(segment.invocationId, 'invocation-1');
    assert.equal(segment.runId, 'run-1');
    assert.equal(segment.turnId, 'turn-1');
    assert.equal(segment.highWater, 2);
    assert.equal(segment.workspaceEpochId, 'epoch-1');
    assert.deepEqual(segment.workspace, workspace);
    assert.match(segment.prefixDigest, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(
      segment.prefixDigest,
      buildRuntimePrefixSegment({
        events: [first, runtimeEvent('event-2', { kind: 'text', text: 'changed' })],
        highWater: 2,
        workspaceEpochId: 'epoch-1',
        workspace,
      }).prefixDigest,
    );
  });

  test('builds one composite cursor over ancestor and source segments', () => {
    const ancestor = buildRuntimePrefixSegment({
      events: [runtimeEvent('ancestor-1', { kind: 'text', text: 'ancestor' }, 'run-a')],
      highWater: 1,
      workspaceEpochId: 'epoch-a',
      workspace: identity('workspace-a'),
    });
    const source = buildRuntimePrefixSegment({
      events: [runtimeEvent('source-1', { kind: 'text', text: 'source' })],
      highWater: 1,
      workspaceEpochId: 'epoch-1',
      workspace: identity('workspace-1'),
    });

    const cursor = buildRuntimeBoundaryCursor([ancestor, source]);

    assert.equal(cursor.sourceInvocationId, source.invocationId);
    assert.equal(cursor.sourceRunId, source.runId);
    assert.equal(cursor.sourceTurnId, source.turnId);
    assert.equal(cursor.sourceHighWater, source.highWater);
    assert.deepEqual(cursor.replaySources, [ancestor, source]);
    assert.match(cursor.replayManifestDigest, /^sha256:[0-9a-f]{64}$/);
  });

  test('recomputes every immutable ledger prefix before accepting a boundary cursor', async () => {
    const workspace = identity('workspace-1');
    const rootEvents = [runtimeEvent('root-1', { kind: 'text', text: 'root' })];
    const sourceEvents = [
      {
        ...runtimeEvent('source-1', { kind: 'text', text: 'source' }),
        invocationId: 'inv-2',
        runId: 'run-2',
        turnId: 'turn-2',
      },
    ];
    const cursor = buildRuntimeBoundaryCursor([
      buildRuntimePrefixSegment({
        events: rootEvents,
        highWater: 1,
        workspaceEpochId: 'epoch-1',
        workspace,
      }),
      buildRuntimePrefixSegment({
        events: sourceEvents,
        highWater: 1,
        workspaceEpochId: 'epoch-1',
        workspace,
      }),
    ]);
    const ledgers = new Map([
      ['run-1', rootEvents],
      ['run-2', sourceEvents],
    ]);

    assert.deepEqual(
      await verifyRuntimeBoundaryCursor({
        sessionId: 'session-1',
        cursor,
        readImmutableRuntimeEvents: async (_sessionId, runId) => ledgers.get(runId)!,
      }),
      { valid: true },
    );

    ledgers.set('run-1', [runtimeEvent('root-1', { kind: 'text', text: 'tampered' })]);
    assert.deepEqual(
      await verifyRuntimeBoundaryCursor({
        sessionId: 'session-1',
        cursor,
        readImmutableRuntimeEvents: async (_sessionId, runId) => ledgers.get(runId)!,
      }),
      { valid: false, reason: 'prefix_digest_mismatch', runId: 'run-1' },
    );
  });

  test('reports capability gaps instead of silently degrading coverage', () => {
    const evaluation = evaluateWorkspaceCheckpointCapabilities(
      {
        coverage: 'dependency_set',
        contentRetention: 'selected_blobs',
        validation: 'manifest_hash',
        restore: 'selected_files',
        repositoryAware: false,
        executableMode: true,
        symlinks: true,
        submodules: false,
      },
      {
        minimumCoverage: 'full_policy_scope',
        minimumContentRetention: 'full_snapshot',
        minimumRestore: 'isolated_directory',
        requireRepositoryIdentity: true,
      },
    );

    assert.deepEqual(evaluation, {
      satisfied: false,
      missing: ['coverage', 'content_retention', 'restore', 'repository_identity'],
    });
  });

  test('selects the highest-priority provider that satisfies the host requirement', () => {
    const native = providerDescriptor('native-cas', 10, false);
    const git = providerDescriptor('git-repository', 20, true);

    assert.equal(
      selectWorkspaceCheckpointProvider([native, git], {
        minimumCoverage: 'full_policy_scope',
        minimumContentRetention: 'full_snapshot',
        minimumRestore: 'isolated_directory',
        requireRepositoryIdentity: false,
      })?.id,
      'git-repository',
    );
    assert.equal(
      selectWorkspaceCheckpointProvider([native, git], {
        minimumCoverage: 'full_policy_scope',
        minimumContentRetention: 'full_snapshot',
        minimumRestore: 'isolated_directory',
        requireRepositoryIdentity: true,
      })?.id,
      'git-repository',
    );
    assert.equal(
      selectWorkspaceCheckpointProvider([native], {
        minimumCoverage: 'full_policy_scope',
        minimumContentRetention: 'full_snapshot',
        minimumRestore: 'isolated_directory',
        requireRepositoryIdentity: true,
      }),
      undefined,
    );
  });

  test('fails policy validation before invoking the artifact provider', async () => {
    const provider = new InMemoryWorkspaceCheckpointProvider(
      providerDescriptor('native-cas', 10, false),
    );
    const checkpoint = checkpointFact(digest('a'));

    const result = await validateWorkspaceCheckpointForResume({
      checkpoint,
      provider,
      currentWorkspace: checkpoint.workspace,
      requirement: fullWorkspaceRequirement(),
      policy: { version: 1, hash: digest('b') },
    });

    assert.deepEqual(result, {
      disposition: 'policy_mismatch',
      checkpointId: checkpoint.checkpointId,
    });
    assert.equal(provider.validationCalls.length, 0);
  });

  test('delegates artifact validation only after Runtime-owned gates pass', async () => {
    const provider = new InMemoryWorkspaceCheckpointProvider(
      providerDescriptor('native-cas', 10, false),
    );
    const checkpoint = checkpointFact(digest('a'));
    provider.setValidation(checkpoint.checkpointId, {
      disposition: 'current_matches',
      checkpointId: checkpoint.checkpointId,
      observedArtifactDigest: 'sha256:observed',
    });

    const result = await validateWorkspaceCheckpointForResume({
      checkpoint,
      provider,
      currentWorkspace: checkpoint.workspace,
      requirement: fullWorkspaceRequirement(),
      policy: checkpoint.policy,
    });

    assert.equal(result.disposition, 'current_matches');
    assert.equal(provider.validationCalls.length, 1);
    assert.equal(provider.validationCalls[0]?.checkpoint.checkpointId, checkpoint.checkpointId);
  });

  test('advances a workspace epoch only through a continuous canonical transition', () => {
    const current = {
      workspaceEpochId: 'epoch-1',
      workspace: identity('workspace-1'),
      openedByEventId: 'initial-event',
    };

    const next = advanceWorkspaceEpoch(current, 'transition-event', {
      protocol: 'workspace_transition_v1',
      fromEpochId: 'epoch-1',
      toEpochId: 'epoch-2',
      from: identity('workspace-1'),
      to: identity('workspace-2'),
      reason: 'session_cwd_move',
    });

    assert.deepEqual(next, {
      workspaceEpochId: 'epoch-2',
      workspace: identity('workspace-2'),
      openedByEventId: 'transition-event',
      previousEpochId: 'epoch-1',
    });
    assert.throws(
      () =>
        advanceWorkspaceEpoch(current, 'bad-transition', {
          protocol: 'workspace_transition_v1',
          fromEpochId: 'another-epoch',
          toEpochId: 'epoch-3',
          from: identity('workspace-1'),
          to: identity('workspace-3'),
          reason: 'session_cwd_move',
        }),
      /does not continue the active workspace epoch/,
    );
  });

  test('parses exact checkpoint and transition runtime facts but rejects capability drift', () => {
    const checkpoint = checkpointFact(digest('a'));
    assert.equal(
      parseWorkspaceRuntimeFact({
        kind: 'maka.workspace.checkpoint',
        version: 1,
        legacyProjection: 'invisible',
        payload: checkpoint,
      }).status,
      'checkpoint',
    );
    assert.equal(
      parseWorkspaceRuntimeFact({
        kind: 'maka.workspace.transition',
        version: 1,
        legacyProjection: 'invisible',
        payload: {
          protocol: 'workspace_transition_v1',
          fromEpochId: 'epoch-1',
          toEpochId: 'epoch-2',
          from: identity('workspace-1'),
          to: identity('workspace-2'),
          reason: 'session_cwd_move',
        },
      }).status,
      'transition',
    );
    assert.equal(
      parseWorkspaceRuntimeFact({
        kind: 'maka.workspace.checkpoint',
        version: 1,
        legacyProjection: 'invisible',
        payload: {
          ...checkpoint,
          coverage: 'dependency_set',
        },
      }).status,
      'invalid',
    );
  });
});

function identity(id: string): WorkspaceIdentity {
  return {
    workspaceInstanceIdentity: id,
    canonicalRoot: `/workspace/${id}`,
  };
}

function runtimeEvent(id: string, content: RuntimeEvent['content'], runId = 'run-1'): RuntimeEvent {
  return {
    id,
    invocationId: runId === 'run-1' ? 'invocation-1' : `invocation-${runId}`,
    runId,
    sessionId: 'session-1',
    turnId: runId === 'run-1' ? 'turn-1' : `turn-${runId}`,
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content,
  };
}

function providerDescriptor(
  id: string,
  priority: number,
  repositoryAware: boolean,
): WorkspaceCheckpointProviderDescriptor {
  return {
    id,
    priority,
    capabilities: {
      coverage: 'full_policy_scope',
      contentRetention: 'full_snapshot',
      validation: 'tree_identity',
      restore: 'isolated_directory',
      repositoryAware,
      executableMode: true,
      symlinks: true,
      submodules: repositoryAware,
    },
  };
}

function fullWorkspaceRequirement() {
  return {
    minimumCoverage: 'full_policy_scope',
    minimumContentRetention: 'full_snapshot',
    minimumRestore: 'isolated_directory',
    minimumValidation: 'manifest_hash',
    requireRepositoryIdentity: false,
  } as const;
}

function checkpointFact(policyHash: string): WorkspaceCheckpointFact {
  return {
    protocol: 'workspace_checkpoint_v1',
    checkpointId: 'checkpoint-1',
    kind: 'captured',
    coveredBoundary: boundary(),
    workspaceEpochId: 'epoch-1',
    workspace: identity('workspace-1'),
    coverage: 'full_policy_scope',
    capabilities: providerDescriptor('native-cas', 10, false).capabilities,
    providerId: 'native-cas',
    artifact: {
      kind: 'native_cas_v1',
      rootHash: digest('1'),
      rootTreeId: digest('2'),
      snapshotObjectId: digest('3'),
    },
    policy: { version: 1, hash: policyHash },
    capturedAt: '2026-07-23T00:00:00.000Z',
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function boundary(): RuntimeBoundaryCursor {
  return buildRuntimeBoundaryCursor([
    buildRuntimePrefixSegment({
      events: [runtimeEvent('source-1', { kind: 'text', text: 'source' })],
      highWater: 1,
      workspaceEpochId: 'epoch-1',
      workspace: identity('workspace-1'),
    }),
  ]);
}
