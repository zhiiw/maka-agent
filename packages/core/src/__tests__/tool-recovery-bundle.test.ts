import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeEvent } from '../runtime-event.js';
import { isToolReconcileResultFact } from '../tool-recovery-fact.js';
import { validateToolRecoveryEventBundle } from '../tool-recovery-bundle.js';

describe('validateToolRecoveryEventBundle', () => {
  it('keeps reconcile observations free of policy actions', () => {
    const observation = {
      protocol: 'tool_reconcile_v1',
      operationId: 'operation-1',
      result: 'applied',
      observationDigest: 'sha256:observation',
      observedAt: '2026-07-25T00:00:00.000Z',
    };

    assert.equal(isToolReconcileResultFact(observation), true);
    assert.equal(
      isToolReconcileResultFact({ ...observation, nextAction: 'synthesize_response' }),
      false,
    );
  });

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

  it('rejects a recovery fact envelope with an unsupported version', () => {
    const reconcile = reconcileEvent();
    (reconcile.actions!.toolRecovery as { version: number }).version = 999;

    const result = validateToolRecoveryEventBundle({
      operation: operationIdentity(),
      callEvent: callEvent(),
      dispatchEvent: dispatchEvent(),
      reconcileEvent: reconcile,
      outcomeEvent: outcomeEvent(),
      decisionEvent: decisionEvent(),
    });

    assert.deepEqual(result, {
      ok: false,
      code: 'reconcile_fact_invalid',
      message: 'Recovery bundle requires one canonical reconcile result fact',
    });
  });

  it('rejects a reconcile-result bundle for an operation without reconcile recovery mode', () => {
    const dispatch = dispatchEvent();
    dispatch.actions!.toolDispatch!.recoveryMode = 'replay_safe';

    const result = validateToolRecoveryEventBundle({
      operation: { ...operationIdentity(), recoveryMode: 'replay_safe' },
      callEvent: callEvent(),
      dispatchEvent: dispatch,
      reconcileEvent: reconcileEvent(),
      outcomeEvent: outcomeEvent(),
      decisionEvent: decisionEvent(),
    });

    assert.deepEqual(result, {
      ok: false,
      code: 'recovery_mode_unsupported',
      message: 'Recovery bundle requires reconcile recovery mode',
    });
  });

  it('rejects a reserved recovery fact hidden in the canonical function call', () => {
    const call = callEvent();
    call.actions = reconcileEvent().actions;

    const result = validateToolRecoveryEventBundle({
      operation: operationIdentity(),
      callEvent: call,
      dispatchEvent: dispatchEvent(),
      reconcileEvent: reconcileEvent(),
      outcomeEvent: outcomeEvent(),
      decisionEvent: decisionEvent(),
    });

    assert.deepEqual(result, {
      ok: false,
      code: 'call_identity_conflict',
      message: 'Recovery bundle call identity conflict',
    });
  });

  it('rejects a reserved recovery fact hidden in the canonical outcome', () => {
    const outcome = outcomeEvent();
    outcome.actions = reconcileEvent().actions;

    const result = validateToolRecoveryEventBundle({
      operation: operationIdentity(),
      callEvent: callEvent(),
      dispatchEvent: dispatchEvent(),
      reconcileEvent: reconcileEvent(),
      outcomeEvent: outcome,
      decisionEvent: decisionEvent(),
    });

    assert.deepEqual(result, {
      ok: false,
      code: 'outcome_identity_conflict',
      message: 'Completed recovery outcome execution identity conflict',
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
