import type { RuntimeEvent, RuntimeEventStore, ToolRecoveryMode } from '@maka/core';
import { stableHash } from './request-shape.js';
import type { RecoveryDisposition, RecoveryReasonCode } from './recovery-resolver.js';
import type { ResumePlanDiagnostic } from './runtime-resume.js';
import {
  type ToolReconcileDecision,
  type ToolRecoveryContractRegistry,
  type UnsettledToolOperation,
} from './tool-recovery-contract.js';
import {
  commitToolReconcileResultFact,
  commitToolRecoveryDecisionFact,
} from './tool-recovery-fact-writer.js';
import type { ToolReconcileResultFact } from './tool-recovery-facts.js';

export interface ReconcileUnsettledToolOperationInput {
  contracts: ToolRecoveryContractRegistry;
  runtimeEventStore: RuntimeEventStore;
  operation: UnsettledToolOperation;
  runtimeIdentity: {
    sessionId: string;
    invocationId: string;
    runId: string;
    turnId: string;
  };
  newId(): string;
  now(): number;
}

interface ToolRecoveryOutcomeCommitStore extends RuntimeEventStore {
  commitToolOutcome(input: {
    operationId: string;
    journalEventId: string;
    runtimeEvent: RuntimeEvent;
    committedAt: number;
  }): Promise<unknown>;
}

export type ReconcileUnsettledToolOperationResult =
  | {
      status: 'reconciled';
      reconcileEvent: RuntimeEvent;
      decisionEvent: RuntimeEvent;
    }
  | { status: 'blocked'; diagnostic: ResumePlanDiagnostic };

export async function reconcileUnsettledToolOperation(
  input: ReconcileUnsettledToolOperationInput,
): Promise<ReconcileUnsettledToolOperationResult> {
  const { operation } = input;
  if (!operation.operationId || !operation.recoveryMode) {
    return blockedDiagnostic(
      'tool_fact_corruption',
      'tool recovery operation is missing its durable identity',
      operation,
    );
  }
  const contractResolution = input.contracts.resolve(
    operation.toolName,
    operation.recoveryMode as ToolRecoveryMode,
  );
  if (contractResolution.status !== 'available') {
    return blockedDiagnostic(
      'tool_recovery_contract_missing',
      contractResolution.status === 'missing'
        ? 'tool recovery contract is unavailable'
        : 'tool recovery contract does not match the durable recovery mode',
      operation,
    );
  }
  const contract = contractResolution.contract;
  if (!contract.observe || !contract.decide) {
    return blockedDiagnostic(
      'tool_recovery_contract_missing',
      'tool recovery contract does not implement observation and decision',
      operation,
    );
  }
  let observation: unknown;
  let contractDecision: ToolReconcileDecision;
  try {
    observation = await contract.observe(operation);
    contractDecision = contract.decide({ operation, observation });
  } catch {
    return blockedDiagnostic(
      'tool_recovery_observation_failed',
      'tool recovery observation could not be completed',
      operation,
    );
  }
  const reconcileFact = normalizeReconcileDecision(
    operation.operationId,
    contractDecision,
    stableHash(observation),
    input.now(),
  );
  let outcomeStore: ToolRecoveryOutcomeCommitStore | undefined;
  if (reconcileFact.nextAction === 'synthesize_response') {
    if (!isToolRecoveryOutcomeCommitStore(input.runtimeEventStore)) {
      return blockedDiagnostic(
        'restricted_verification_violation',
        'runtime recovery cannot atomically commit a synthesized tool response',
        operation,
      );
    }
    outcomeStore = input.runtimeEventStore;
  }
  const reconcileEvent = await commitToolReconcileResultFact({
    runtimeEventStore: input.runtimeEventStore,
    ...input.runtimeIdentity,
    eventId: input.newId(),
    ts: input.now(),
    fact: reconcileFact,
  });
  const decisionEvidenceEventIds = [...operation.evidenceEventIds, reconcileEvent.id];
  if (reconcileFact.nextAction === 'synthesize_response') {
    const outcomeTs = input.now();
    const outcomeEvent: RuntimeEvent = {
      id: input.newId(),
      ...input.runtimeIdentity,
      ts: outcomeTs,
      partial: false,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: operation.toolCallId,
        name: operation.toolName,
        result: contractDecision.synthesizedResult ?? {
          ok: true,
          recovered: true,
          operationId: operation.operationId,
        },
      },
      actions: { stateDelta: { toolOutcomeOrigin: 'runtime_recovery' } },
      refs: { operationId: operation.operationId, toolCallId: operation.toolCallId },
    };
    await outcomeStore!.commitToolOutcome({
      operationId: operation.operationId,
      journalEventId: `${outcomeEvent.id}_journal`,
      runtimeEvent: outcomeEvent,
      committedAt: outcomeTs,
    });
    decisionEvidenceEventIds.push(outcomeEvent.id);
  }
  const disposition: RecoveryDisposition =
    reconcileFact.nextAction === 'park'
      ? 'parked'
      : reconcileFact.nextAction === 'synthesize_response'
        ? 'completed'
        : 'reconcile_required';
  const reasonCode = recoveryReasonForReconcileResult(reconcileFact.result);
  const decisionEvent = await commitToolRecoveryDecisionFact({
    runtimeEventStore: input.runtimeEventStore,
    ...input.runtimeIdentity,
    eventId: input.newId(),
    ts: input.now(),
    fact: {
      protocol: 'tool_recovery_v1',
      operationId: operation.operationId,
      disposition,
      reasonCode,
      evidenceEventIds: decisionEvidenceEventIds,
      recoveryContractId: `${contract.id}@${contract.version}`,
    },
  });
  return { status: 'reconciled', reconcileEvent, decisionEvent };
}

function normalizeReconcileDecision(
  operationId: string,
  decision: ToolReconcileDecision,
  observationDigest: string,
  observedAt: number,
): ToolReconcileResultFact {
  const result = decision.result === 'unknown' ? 'conflict' : decision.result;
  const nextAction = isSafeTransition(result, decision.nextAction) ? decision.nextAction : 'park';
  return {
    protocol: 'tool_reconcile_v1',
    operationId,
    result,
    observationDigest,
    observedAt: new Date(observedAt).toISOString(),
    nextAction,
  };
}

function isSafeTransition(
  result: ToolReconcileResultFact['result'],
  nextAction: ToolReconcileResultFact['nextAction'],
): boolean {
  return (
    nextAction === 'park' ||
    (result === 'applied' && nextAction === 'synthesize_response') ||
    (result === 'not_applied' && nextAction === 'retry_allowed') ||
    (result === 'still_running' && nextAction === 'reattach')
  );
}

function recoveryReasonForReconcileResult(
  result: ToolReconcileResultFact['result'],
): RecoveryReasonCode {
  switch (result) {
    case 'applied':
      return 'reconcile_applied';
    case 'not_applied':
      return 'reconcile_not_applied';
    case 'conflict':
      return 'reconcile_conflict';
    case 'still_running':
      return 'reconcile_still_running';
  }
}

function blockedDiagnostic(
  code: Extract<
    ResumePlanDiagnostic['code'],
    | 'tool_fact_corruption'
    | 'tool_recovery_contract_missing'
    | 'tool_recovery_observation_failed'
    | 'restricted_verification_violation'
  >,
  message: string,
  operation: UnsettledToolOperation,
): ReconcileUnsettledToolOperationResult {
  return {
    status: 'blocked',
    diagnostic: {
      code,
      message,
      toolCallId: operation.toolCallId,
      toolName: operation.toolName,
      detail: { operationId: operation.operationId },
    },
  };
}

function isToolRecoveryOutcomeCommitStore(
  store: RuntimeEventStore,
): store is ToolRecoveryOutcomeCommitStore {
  return (
    'commitToolOutcome' in store &&
    typeof (store as { commitToolOutcome?: unknown }).commitToolOutcome === 'function'
  );
}
