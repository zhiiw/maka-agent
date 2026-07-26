import type { RuntimeEvent } from './runtime-event.js';
import {
  isToolRecoveryFactEnvelope,
  type ToolReconcileResultFact,
  type ToolRecoveryDecisionFact,
} from './tool-recovery-fact.js';

export interface ToolRecoveryOperationIdentity {
  operationId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: NonNullable<NonNullable<RuntimeEvent['actions']>['toolDispatch']>['recoveryMode'];
  callEventId: string;
  dispatchEventId: string;
}

export interface ToolRecoveryEventBundle {
  operation: ToolRecoveryOperationIdentity;
  callEvent: RuntimeEvent;
  dispatchEvent: RuntimeEvent;
  reconcileEvent: RuntimeEvent;
  outcomeEvent?: RuntimeEvent;
  decisionEvent: RuntimeEvent;
}

export type ToolRecoveryBundleValidationCode =
  | 'call_identity_conflict'
  | 'dispatch_identity_conflict'
  | 'reconcile_fact_invalid'
  | 'decision_fact_invalid'
  | 'recovery_fact_identity_conflict'
  | 'operation_identity_conflict'
  | 'recovery_mode_unsupported'
  | 'outcome_required'
  | 'outcome_for_parked'
  | 'outcome_identity_conflict'
  | 'outcome_reference_conflict'
  | 'reconcile_decision_conflict'
  | 'evidence_order_conflict';

export type ToolRecoveryBundleValidationResult =
  | {
      ok: true;
      reconcile: ToolReconcileResultFact;
      decision: ToolRecoveryDecisionFact;
    }
  | {
      ok: false;
      code: ToolRecoveryBundleValidationCode;
      message: string;
    };

export class ToolRecoveryBundleValidationError extends Error {
  readonly name = 'ToolRecoveryBundleValidationError';

  constructor(
    readonly code: ToolRecoveryBundleValidationCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The one pure authority for recovery-bundle causality. Callers may decide
 * whether invalid evidence rejects a write, aborts a rebuild, or marks a
 * ledger corrupt, but they must not reinterpret these rules.
 */
export function validateToolRecoveryEventBundle(
  input: ToolRecoveryEventBundle,
): ToolRecoveryBundleValidationResult {
  const { operation } = input;
  const call = input.callEvent.content;
  if (
    input.callEvent.id !== operation.callEventId ||
    call?.kind !== 'function_call' ||
    call.id !== operation.providerToolCallId ||
    call.name !== operation.toolName ||
    input.callEvent.role !== 'model' ||
    input.callEvent.author !== 'agent' ||
    input.callEvent.actions?.toolRecovery !== undefined ||
    !hasExecutionIdentity(input.callEvent, operation)
  ) {
    return invalid('call_identity_conflict', 'Recovery bundle call identity conflict');
  }

  const dispatch = input.dispatchEvent.actions?.toolDispatch;
  if (
    input.dispatchEvent.id !== operation.dispatchEventId ||
    !dispatch ||
    dispatch.operationId !== operation.operationId ||
    dispatch.providerToolCallId !== operation.providerToolCallId ||
    dispatch.toolName !== operation.toolName ||
    dispatch.canonicalArgsHash !== operation.canonicalArgsHash ||
    dispatch.recoveryMode !== operation.recoveryMode ||
    !hasExecutionIdentity(input.dispatchEvent, operation) ||
    input.dispatchEvent.sessionId !== input.callEvent.sessionId ||
    input.dispatchEvent.content !== undefined ||
    input.dispatchEvent.role !== 'system' ||
    input.dispatchEvent.author !== 'system' ||
    !hasOnlyKeys(input.dispatchEvent.actions, ['toolDispatch']) ||
    !hasOnlyKeys(input.dispatchEvent.refs, ['operationId', 'toolCallId']) ||
    input.dispatchEvent.refs?.operationId !== operation.operationId ||
    input.dispatchEvent.refs?.toolCallId !== operation.providerToolCallId
  ) {
    return invalid('dispatch_identity_conflict', 'Recovery bundle dispatch identity conflict');
  }
  if (operation.recoveryMode !== 'reconcile') {
    return invalid('recovery_mode_unsupported', 'Recovery bundle requires reconcile recovery mode');
  }

  const reconcileEnvelope = input.reconcileEvent.actions?.toolRecovery;
  if (
    !isToolRecoveryFactEnvelope(reconcileEnvelope) ||
    reconcileEnvelope.kind !== 'maka.tool.reconcile_result'
  ) {
    return invalid(
      'reconcile_fact_invalid',
      'Recovery bundle requires one canonical reconcile result fact',
    );
  }
  const decisionEnvelope = input.decisionEvent.actions?.toolRecovery;
  if (
    !isToolRecoveryFactEnvelope(decisionEnvelope) ||
    decisionEnvelope.kind !== 'maka.tool.recovery_decision'
  ) {
    return invalid(
      'decision_fact_invalid',
      'Recovery bundle requires one canonical recovery decision fact',
    );
  }
  const reconcile = reconcileEnvelope.payload;
  const decision = decisionEnvelope.payload;

  if (
    !isRecoveryFactEvent(input.reconcileEvent, operation) ||
    !isRecoveryFactEvent(input.decisionEvent, operation) ||
    input.reconcileEvent.sessionId !== input.callEvent.sessionId ||
    input.decisionEvent.sessionId !== input.callEvent.sessionId
  ) {
    return invalid('recovery_fact_identity_conflict', 'Recovery fact execution identity conflict');
  }
  if (
    reconcile.operationId !== operation.operationId ||
    decision.operationId !== operation.operationId
  ) {
    return invalid(
      'operation_identity_conflict',
      'Recovery bundle fact operation identity conflict',
    );
  }

  const expectedEvidence = [
    operation.callEventId,
    operation.dispatchEventId,
    input.reconcileEvent.id,
  ];
  if (decision.disposition === 'completed') {
    if (!input.outcomeEvent) {
      return invalid(
        'outcome_required',
        'Completed recovery decision requires a persisted outcome',
      );
    }
    if (
      input.outcomeEvent.sessionId !== input.callEvent.sessionId ||
      !isMatchingOutcome(input.outcomeEvent, operation)
    ) {
      return invalid(
        'outcome_identity_conflict',
        'Completed recovery outcome execution identity conflict',
      );
    }
    if (decision.outcomeEventId !== input.outcomeEvent.id) {
      return invalid(
        'outcome_reference_conflict',
        'Completed recovery decision outcome reference conflict',
      );
    }
    if (reconcile.result !== 'applied') {
      return invalid(
        'reconcile_decision_conflict',
        'Completed recovery decision requires an applied reconcile result',
      );
    }
    expectedEvidence.push(input.outcomeEvent.id);
  } else {
    if (input.outcomeEvent) {
      return invalid(
        'outcome_for_parked',
        'Parked recovery decision must not commit a provider outcome',
      );
    }
    if (
      reconcile.result === 'applied' ||
      decision.reasonCode !== parkedReasonFor(reconcile.result)
    ) {
      return invalid(
        'reconcile_decision_conflict',
        'Parked recovery decision does not match the reconcile result',
      );
    }
  }

  if (
    decision.evidenceEventIds.length !== expectedEvidence.length ||
    decision.evidenceEventIds.some((eventId, index) => eventId !== expectedEvidence[index])
  ) {
    return invalid(
      'evidence_order_conflict',
      'Recovery decision evidence does not match the canonical causal order',
    );
  }
  return { ok: true, reconcile, decision };
}

export function assertToolRecoveryEventBundle(input: ToolRecoveryEventBundle): {
  reconcile: ToolReconcileResultFact;
  decision: ToolRecoveryDecisionFact;
} {
  const result = validateToolRecoveryEventBundle(input);
  if (!result.ok) {
    throw new ToolRecoveryBundleValidationError(result.code, result.message);
  }
  return { reconcile: result.reconcile, decision: result.decision };
}

function hasExecutionIdentity(
  event: RuntimeEvent,
  operation: ToolRecoveryOperationIdentity,
): boolean {
  return (
    !event.partial &&
    event.invocationId === operation.invocationId &&
    event.runId === operation.runId &&
    event.turnId === operation.turnId
  );
}

function isRecoveryFactEvent(
  event: RuntimeEvent,
  operation: ToolRecoveryOperationIdentity,
): boolean {
  return (
    hasExecutionIdentity(event, operation) &&
    event.content === undefined &&
    event.role === 'system' &&
    event.author === 'system' &&
    hasOnlyKeys(event.actions, ['toolRecovery']) &&
    hasOnlyKeys(event.refs, ['operationId', 'toolCallId']) &&
    event.refs?.operationId === operation.operationId &&
    event.refs?.toolCallId === operation.providerToolCallId
  );
}

function hasOnlyKeys(value: object | undefined, expected: readonly string[]): boolean {
  if (!value) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isMatchingOutcome(event: RuntimeEvent, operation: ToolRecoveryOperationIdentity): boolean {
  const content = event.content;
  return (
    hasExecutionIdentity(event, operation) &&
    content?.kind === 'function_response' &&
    content.id === operation.providerToolCallId &&
    content.name === operation.toolName &&
    event.role === 'tool' &&
    event.author === 'tool' &&
    event.actions?.toolRecovery === undefined &&
    event.refs?.operationId === operation.operationId &&
    event.refs?.toolCallId === operation.providerToolCallId
  );
}

function invalid(
  code: ToolRecoveryBundleValidationCode,
  message: string,
): ToolRecoveryBundleValidationResult {
  return { ok: false, code, message };
}

function parkedReasonFor(
  result: Exclude<ToolReconcileResultFact['result'], 'applied'>,
): 'reconcile_not_applied' | 'reconcile_conflict' | 'reconcile_still_running' {
  switch (result) {
    case 'not_applied':
      return 'reconcile_not_applied';
    case 'conflict':
      return 'reconcile_conflict';
    case 'still_running':
      return 'reconcile_still_running';
  }
}
