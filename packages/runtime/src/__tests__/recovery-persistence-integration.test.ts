import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createSqliteRuntimeStore } from '@maka/storage';
import { resolveRuntimeRecovery } from '../recovery-resolver.js';

describe('recovery persistence integration', () => {
  it('reopens, rebuilds projections, and resolves a completed recovery from immutable events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-recovery-persistence-'));
    const dbPath = join(root, 'runtime.sqlite');
    const writer = createSqliteRuntimeStore(dbPath);
    let reopened: ReturnType<typeof createSqliteRuntimeStore> | undefined;

    try {
      await writer.appendRuntimeEvent('session-1', 'run-1', protocolEvent());
      await writer.commitToolPrepared({
        operationId: 'operation-1',
        journalEventId: 'journal-prepared-1',
        runtimeEvent: functionCallEvent(),
        dispatchRuntimeEvent: toolDispatchEvent(),
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
        committedAt: 3,
      });
      await writer.commitToolRecoveryBundle({
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcileResultEvent(),
        outcomeRuntimeEvent: functionResponseEvent(),
        decisionRuntimeEvent: recoveryDecisionEvent(),
      });
      writer.close();

      reopened = createSqliteRuntimeStore(dbPath);
      assert.deepEqual(await reopened.rebuildToolProjectionsFromRuntimeEvents(), {
        operations: 1,
        journalEvents: 4,
      });

      const immutableEvents = await reopened.readImmutableRuntimeEvents('session-1', 'run-1');
      const resolution = resolveRuntimeRecovery(immutableEvents);

      assert.deepEqual(
        immutableEvents.map((event) => event.id),
        [
          'protocol-event-1',
          'call-event-1',
          'dispatch-event-1',
          'reconcile-event-1',
          'response-event-1',
          'recovery-decision-event-1',
        ],
      );
      assert.deepEqual(resolution.decisions, [
        {
          toolCallId: 'provider-call-1',
          toolName: 'Read',
          operationId: 'operation-1',
          status: 'completed',
          reason: 'matching_response',
          callRuntimeEventId: 'call-event-1',
          dispatchRuntimeEventId: 'dispatch-event-1',
          responseRuntimeEventId: 'response-event-1',
          responseIsError: false,
        },
      ]);
      assert.equal(resolution.hasCorruption, false);
      assert.equal(resolution.requiresReconciliation, false);
      assert.equal(
        (await reopened.readToolOperation('operation-1'))?.currentState,
        'outcome_committed',
      );
      assert.deepEqual(
        (await reopened.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared', 'reconcile_recorded', 'outcome_committed', 'recovery_decided'],
      );
    } finally {
      reopened?.close();
      writer.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function protocolEvent(): RuntimeEvent {
  return event({
    id: 'protocol-event-1',
    ts: 1,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'read the file' },
    actions: { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } },
  });
}

function functionCallEvent(): RuntimeEvent {
  return event({
    id: 'call-event-1',
    ts: 2,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: 'provider-call-1',
      name: 'Read',
      args: { path: 'README.md' },
    },
  });
}

function toolDispatchEvent(): RuntimeEvent {
  return event({
    id: 'dispatch-event-1',
    ts: 3,
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function reconcileResultEvent(): RuntimeEvent {
  return event({
    id: 'reconcile-event-1',
    ts: 4,
    actions: {
      toolRecovery: {
        kind: 'maka.tool.reconcile_result',
        version: 1,
        payload: {
          protocol: 'tool_reconcile_v1',
          operationId: 'operation-1',
          result: 'applied',
          observationDigest: 'sha256:observation-1',
          observedAt: '2026-07-27T00:00:00.000Z',
          nextAction: 'synthesize_response',
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function functionResponseEvent(): RuntimeEvent {
  return event({
    id: 'response-event-1',
    ts: 5,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Read',
      result: 'contents',
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function recoveryDecisionEvent(): RuntimeEvent {
  return event({
    id: 'recovery-decision-event-1',
    ts: 6,
    actions: {
      toolRecovery: {
        kind: 'maka.tool.recovery_decision',
        version: 1,
        payload: {
          protocol: 'tool_recovery_v1',
          operationId: 'operation-1',
          disposition: 'completed',
          reasonCode: 'reconcile_applied',
          outcomeEventId: 'response-event-1',
          evidenceEventIds: [
            'call-event-1',
            'dispatch-event-1',
            'reconcile-event-1',
            'response-event-1',
          ],
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function event(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}
