import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  RUNTIME_FACT_WRITE_CAPABILITY_V1,
  type RuntimeEvent,
  type RuntimeEventStore,
} from '@maka/core';

import {
  commitWorkspaceCheckpointFact,
  commitWorkspaceTransitionFact,
} from '../workspace-checkpoint-fact-writer.js';
import type { WorkspaceCheckpointFact, WorkspaceTransitionFact } from '../workspace-checkpoint.js';

describe('workspace checkpoint canonical fact writer', () => {
  test('rejects a store without the runtime fact capability', async () => {
    const events: RuntimeEvent[] = [];
    await assert.rejects(
      commitWorkspaceCheckpointFact({
        ...writerIdentity(),
        runtimeEventStore: fakeStore(events),
        fact: checkpointFact(),
      }),
      /runtime fact writer capability/i,
    );
    assert.deepEqual(events, []);
  });

  test('durably appends an invisible versioned checkpoint fact', async () => {
    const events: RuntimeEvent[] = [];
    const event = await commitWorkspaceCheckpointFact({
      ...writerIdentity(),
      runtimeEventStore: fakeStore(events, RUNTIME_FACT_WRITE_CAPABILITY_V1),
      fact: checkpointFact(),
    });

    assert.equal(events[0], event);
    assert.equal(event.actions?.runtimeFact?.kind, 'maka.workspace.checkpoint');
    assert.equal(event.actions?.runtimeFact?.legacyProjection, 'invisible');
    assert.equal(event.role, 'system');
    assert.equal(event.partial, false);
  });

  test('durably appends an exact workspace transition fact', async () => {
    const events: RuntimeEvent[] = [];
    const fact: WorkspaceTransitionFact = {
      protocol: 'workspace_transition_v1',
      fromEpochId: 'epoch-1',
      toEpochId: 'epoch-2',
      from: identity('/repo-a'),
      to: identity('/repo-b'),
      reason: 'session_cwd_move',
    };
    const event = await commitWorkspaceTransitionFact({
      ...writerIdentity(),
      runtimeEventStore: fakeStore(events, RUNTIME_FACT_WRITE_CAPABILITY_V1),
      fact,
    });

    assert.equal(event.actions?.runtimeFact?.kind, 'maka.workspace.transition');
    assert.equal(event.actions?.runtimeFact?.payload, fact);
  });
});

function writerIdentity() {
  return {
    sessionId: 'session-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    eventId: 'workspace-event-1',
    ts: 10,
  };
}

function fakeStore(
  events: RuntimeEvent[],
  capability?: typeof RUNTIME_FACT_WRITE_CAPABILITY_V1,
): RuntimeEventStore {
  return {
    ...(capability ? { runtimeFactWriteCapability: capability } : {}),
    appendRuntimeEvent: async (_sessionId, _runId, event, options) => {
      assert.deepEqual(options, { durable: true });
      events.push(event);
    },
    ensureTerminalRuntimeEventDurable: async () => {},
    readRuntimeEvents: async () => [],
    readSessionRuntimeEvents: async () => [],
  };
}

function checkpointFact(): WorkspaceCheckpointFact {
  return {
    protocol: 'workspace_checkpoint_v1',
    checkpointId: 'checkpoint-1',
    kind: 'captured',
    coveredBoundary: {
      sourceInvocationId: 'invocation-1',
      sourceRunId: 'run-1',
      sourceTurnId: 'turn-1',
      sourceHighWater: 1,
      replaySources: [
        {
          invocationId: 'invocation-1',
          runId: 'run-1',
          turnId: 'turn-1',
          highWater: 1,
          prefixDigest: digest('1'),
          workspaceEpochId: 'epoch-1',
          workspace: identity('/repo'),
        },
      ],
      replayManifestDigest: digest('2'),
    },
    workspaceEpochId: 'epoch-1',
    workspace: identity('/repo'),
    coverage: 'full_policy_scope',
    capabilities: {
      coverage: 'full_policy_scope',
      contentRetention: 'full_snapshot',
      validation: 'manifest_hash',
      restore: 'isolated_directory',
      repositoryAware: false,
      executableMode: true,
      symlinks: true,
      submodules: false,
    },
    providerId: 'native-cas',
    artifact: {
      kind: 'native_cas_v1',
      rootHash: digest('3'),
      rootTreeId: digest('4'),
      snapshotObjectId: digest('5'),
    },
    policy: { version: 1, hash: digest('6') },
    capturedAt: '2026-07-23T00:00:00.000Z',
  };
}

function identity(root: string) {
  return { workspaceInstanceIdentity: `workspace:${root}`, canonicalRoot: root };
}

function digest(value: string): string {
  return `sha256:${value.repeat(64).slice(0, 64)}`;
}
