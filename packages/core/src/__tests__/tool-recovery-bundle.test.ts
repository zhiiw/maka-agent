import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeEvent } from '../runtime-event.js';
import { validateToolRecoveryEventBundle } from '../tool-recovery-bundle.js';

describe('validateToolRecoveryEventBundle', () => {
  it('accepts completed only when it references the matching persisted outcome', () => {
    const result = validateToolRecoveryEventBundle({
      operation: operationIdentity(),
      callEvent: callEvent(),
      dispatchEvent: dispatchEvent(),
      reconcileEvent: reconcileEvent(),
      outcomeEvent: outcomeEvent(),
      decisionEvent: decisionEvent(),
    });

    assert.equal(result.ok, true);
  });

  it('rejects completed when the referenced outcome does not match the bundle', () => {
    const result = validateToolRecoveryEventBundle({
      operation: operationIdentity(),
      callEvent: callEvent(),
      dispatchEvent: dispatchEvent(),
      reconcileEvent: reconcileEvent(),
      outcomeEvent: outcomeEvent({ id: 'different-outcome' }),
      decisionEvent: decisionEvent(),
    });

    assert.deepEqual(result, {
      ok: false,
      code: 'outcome_reference_conflict',
      message: 'Completed recovery decision outcome reference conflict',
    });
  });

  it('rejects a parked decision whose reason contradicts the reconcile result', () => {
    const reconcile = reconcileEvent();
    reconcile.actions = {
      toolRecovery: {
        kind: 'maka.tool.reconcile_result',
        version: 1,
        payload: {
          protocol: 'tool_reconcile_v1',
          operationId: 'operation-1',
          result: 'conflict',
          observationDigest: 'sha256:observation',
          observedAt: '2026-07-25T00:00:00.000Z',
          nextAction: 'park',
        },
      },
    };
    const decision = decisionEvent();
    decision.actions = {
      toolRecovery: {
        kind: 'maka.tool.recovery_decision',
        version: 1,
        payload: {
          protocol: 'tool_recovery_v1',
          operationId: 'operation-1',
          disposition: 'parked',
          reasonCode: 'reconcile_not_applied',
          evidenceEventIds: ['call-event-1', 'dispatch-event-1', 'reconcile-event-1'],
        },
      },
    };

    const result = validateToolRecoveryEventBundle({
      operation: operationIdentity(),
      callEvent: callEvent(),
      dispatchEvent: dispatchEvent(),
      reconcileEvent: reconcile,
      decisionEvent: decision,
    });

    assert.deepEqual(result, {
      ok: false,
      code: 'reconcile_decision_conflict',
      message: 'Parked recovery decision does not match the reconcile result',
    });
  });
});

function operationIdentity() {
  return {
    operationId: 'operation-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    providerToolCallId: 'provider-call-1',
    toolName: 'Write',
    canonicalArgsHash: 'sha256:args',
    recoveryMode: 'reconcile' as const,
    callEventId: 'call-event-1',
    dispatchEventId: 'dispatch-event-1',
  };
}

function baseEvent(overrides: Partial<RuntimeEvent>): RuntimeEvent {
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

function callEvent(): RuntimeEvent {
  return baseEvent({
    id: 'call-event-1',
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: 'provider-call-1',
      name: 'Write',
      args: { path: 'notes.txt', content: 'after' },
    },
  });
}

function dispatchEvent(): RuntimeEvent {
  return baseEvent({
    id: 'dispatch-event-1',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Write',
        canonicalArgsHash: 'sha256:args',
        recoveryMode: 'reconcile',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function reconcileEvent(): RuntimeEvent {
  return baseEvent({
    id: 'reconcile-event-1',
    ts: 2,
    actions: {
      toolRecovery: {
        kind: 'maka.tool.reconcile_result',
        version: 1,
        payload: {
          protocol: 'tool_reconcile_v1',
          operationId: 'operation-1',
          result: 'applied',
          observationDigest: 'sha256:observation',
          observedAt: '2026-07-25T00:00:00.000Z',
          nextAction: 'synthesize_response',
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function outcomeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return baseEvent({
    id: 'outcome-event-1',
    ts: 3,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Write',
      result: 'ok',
      isError: false,
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
    ...overrides,
  });
}

function decisionEvent(): RuntimeEvent {
  return baseEvent({
    id: 'decision-event-1',
    ts: 4,
    actions: {
      toolRecovery: {
        kind: 'maka.tool.recovery_decision',
        version: 1,
        payload: {
          protocol: 'tool_recovery_v1',
          operationId: 'operation-1',
          disposition: 'completed',
          reasonCode: 'reconcile_applied',
          outcomeEventId: 'outcome-event-1',
          evidenceEventIds: [
            'call-event-1',
            'dispatch-event-1',
            'reconcile-event-1',
            'outcome-event-1',
          ],
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}
