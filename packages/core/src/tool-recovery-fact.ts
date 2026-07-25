export const TOOL_RECONCILE_RESULT_FACT_KIND = 'maka.tool.reconcile_result' as const;
export const TOOL_RECOVERY_DECISION_FACT_KIND = 'maka.tool.recovery_decision' as const;
export const TOOL_RECOVERY_FACT_VERSION = 1 as const;

export type ToolReconcileResult = 'applied' | 'not_applied' | 'conflict' | 'still_running';

export interface ToolReconcileResultFact {
  protocol: 'tool_reconcile_v1';
  operationId: string;
  result: ToolReconcileResult;
  observationDigest: string;
  observedAt: string;
  nextAction: 'synthesize_response' | 'park';
}

export type ToolRecoveryParkReason =
  | 'reconcile_not_applied'
  | 'reconcile_conflict'
  | 'reconcile_still_running';

export interface ToolRecoveryCompletedDecisionFact {
  protocol: 'tool_recovery_v1';
  operationId: string;
  disposition: 'completed';
  reasonCode: 'reconcile_applied';
  outcomeEventId: string;
  evidenceEventIds: string[];
}

export interface ToolRecoveryParkedDecisionFact {
  protocol: 'tool_recovery_v1';
  operationId: string;
  disposition: 'parked';
  reasonCode: ToolRecoveryParkReason;
  evidenceEventIds: string[];
}

export type ToolRecoveryDecisionFact =
  | ToolRecoveryCompletedDecisionFact
  | ToolRecoveryParkedDecisionFact;

export type ToolRecoveryFactEnvelope =
  | {
      kind: typeof TOOL_RECONCILE_RESULT_FACT_KIND;
      version: typeof TOOL_RECOVERY_FACT_VERSION;
      payload: ToolReconcileResultFact;
    }
  | {
      kind: typeof TOOL_RECOVERY_DECISION_FACT_KIND;
      version: typeof TOOL_RECOVERY_FACT_VERSION;
      payload: ToolRecoveryDecisionFact;
    };

const PARK_REASONS = new Set<ToolRecoveryParkReason>([
  'reconcile_not_applied',
  'reconcile_conflict',
  'reconcile_still_running',
]);

export function isToolRecoveryFactEnvelope(value: unknown): value is ToolRecoveryFactEnvelope {
  if (!hasExactKeys(value, ['kind', 'version', 'payload'])) return false;
  if (value.version !== TOOL_RECOVERY_FACT_VERSION) return false;
  if (value.kind === TOOL_RECONCILE_RESULT_FACT_KIND) {
    return isToolReconcileResultFact(value.payload);
  }
  if (value.kind === TOOL_RECOVERY_DECISION_FACT_KIND) {
    return isToolRecoveryDecisionFact(value.payload);
  }
  return false;
}

export function isToolReconcileResultFact(value: unknown): value is ToolReconcileResultFact {
  if (
    !hasExactKeys(value, [
      'protocol',
      'operationId',
      'result',
      'observationDigest',
      'observedAt',
      'nextAction',
    ])
  ) {
    return false;
  }
  if (
    value.protocol !== 'tool_reconcile_v1' ||
    !isNonEmptyString(value.operationId) ||
    !isNonEmptyString(value.observationDigest) ||
    !isNonEmptyString(value.observedAt)
  ) {
    return false;
  }
  if (value.result === 'applied') return value.nextAction === 'synthesize_response';
  return (
    ['not_applied', 'conflict', 'still_running'].includes(String(value.result)) &&
    value.nextAction === 'park'
  );
}

export function isToolRecoveryDecisionFact(value: unknown): value is ToolRecoveryDecisionFact {
  if (!isRecord(value)) return false;
  if (
    value.protocol !== 'tool_recovery_v1' ||
    !isNonEmptyString(value.operationId) ||
    !isDistinctNonEmptyStringArray(value.evidenceEventIds)
  ) {
    return false;
  }
  if (value.disposition === 'completed') {
    return (
      hasExactKeys(value, [
        'protocol',
        'operationId',
        'disposition',
        'reasonCode',
        'outcomeEventId',
        'evidenceEventIds',
      ]) &&
      value.reasonCode === 'reconcile_applied' &&
      isNonEmptyString(value.outcomeEventId)
    );
  }
  return (
    value.disposition === 'parked' &&
    hasExactKeys(value, [
      'protocol',
      'operationId',
      'disposition',
      'reasonCode',
      'evidenceEventIds',
    ]) &&
    typeof value.reasonCode === 'string' &&
    PARK_REASONS.has(value.reasonCode as ToolRecoveryParkReason)
  );
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDistinctNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}
