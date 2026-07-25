import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  type RuntimeEvent,
  type ToolBoundaryProtocol,
} from '@maka/core/runtime-event';
import { validateToolRecoveryEventBundle } from '@maka/core/tool-recovery-bundle';

export type ToolRecoveryDecisionStatus =
  | 'completed'
  | 'definitely_not_dispatched'
  | 'indeterminate'
  | 'corruption';

export type ToolRecoveryDecisionReason =
  | 'matching_response'
  | 'dispatch_without_response'
  | 'new_protocol_before_dispatch'
  | 'legacy_dispatch_unknown'
  | 'orphan_dispatch'
  | 'orphan_response'
  | 'duplicate_dispatch'
  | 'duplicate_response'
  | 'identity_conflict'
  | 'protocol_marker_invalid'
  | 'recovery_fact_corruption';

export interface ToolRecoveryDecision {
  toolCallId: string;
  toolName?: string;
  operationId?: string;
  status: ToolRecoveryDecisionStatus;
  reason: ToolRecoveryDecisionReason;
  callRuntimeEventId?: string;
  dispatchRuntimeEventId?: string;
  responseRuntimeEventId?: string;
  responseIsError?: boolean;
}

export interface RuntimeRecoveryResolution {
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  decisions: ToolRecoveryDecision[];
  issues: Array<{
    code: 'protocol_marker_invalid';
    eventId: string;
  }>;
  hasCorruption: boolean;
  requiresReconciliation: boolean;
}

export function resolveRuntimeRecovery(events: readonly RuntimeEvent[]): RuntimeRecoveryResolution {
  const firstProtocol = events[0]?.actions?.runtimeProtocol;
  const toolBoundaryProtocol =
    firstProtocol?.toolBoundary === TOOL_BOUNDARY_PROTOCOL_V1
      ? TOOL_BOUNDARY_PROTOCOL_V1
      : undefined;
  const issues: RuntimeRecoveryResolution['issues'] = [];
  if (firstProtocol !== undefined && toolBoundaryProtocol === undefined && events[0]) {
    issues.push({
      code: 'protocol_marker_invalid' as const,
      eventId: events[0].id,
    });
  }
  issues.push(
    ...events
      .slice(1)
      .filter((event) => event.actions?.runtimeProtocol !== undefined)
      .map((event) => ({ code: 'protocol_marker_invalid' as const, eventId: event.id })),
  );
  const decisions: ToolRecoveryDecision[] = [];
  const decisionsByToolCallId = new Map<string, ToolRecoveryDecision>();
  const decisionsByOperationId = new Map<string, ToolRecoveryDecision>();
  const callEventsByToolCallId = new Map<string, RuntimeEvent>();
  const dispatchEventsByOperationId = new Map<string, RuntimeEvent>();
  const responseEventsByOperationId = new Map<string, RuntimeEvent>();
  for (const event of events) {
    if (event.partial || event.content?.kind !== 'function_call') continue;
    const decision: ToolRecoveryDecision = {
      toolCallId: event.content.id,
      toolName: event.content.name,
      status: toolBoundaryProtocol ? 'definitely_not_dispatched' : 'indeterminate',
      reason: toolBoundaryProtocol ? 'new_protocol_before_dispatch' : 'legacy_dispatch_unknown',
      callRuntimeEventId: event.id,
    };
    decisions.push(decision);
    decisionsByToolCallId.set(decision.toolCallId, decision);
    callEventsByToolCallId.set(decision.toolCallId, event);
  }
  for (const event of events) {
    if (event.partial) continue;
    const dispatch = event.actions?.toolDispatch;
    if (!dispatch) continue;
    if (!dispatchEventsByOperationId.has(dispatch.operationId)) {
      dispatchEventsByOperationId.set(dispatch.operationId, event);
    }
    const decision = decisionsByToolCallId.get(dispatch.providerToolCallId);
    if (!decision) {
      const orphanDecision: ToolRecoveryDecision = {
        toolCallId: dispatch.providerToolCallId,
        toolName: dispatch.toolName,
        operationId: dispatch.operationId,
        status: 'corruption',
        reason: 'orphan_dispatch',
        dispatchRuntimeEventId: event.id,
      };
      decisions.push(orphanDecision);
      decisionsByOperationId.set(dispatch.operationId, orphanDecision);
      continue;
    }
    if (decision.dispatchRuntimeEventId !== undefined) {
      decision.status = 'corruption';
      decision.reason = 'duplicate_dispatch';
      continue;
    }
    decision.operationId = dispatch.operationId;
    decisionsByOperationId.set(dispatch.operationId, decision);
    decision.dispatchRuntimeEventId = event.id;
    if (
      decision.toolName !== dispatch.toolName ||
      event.refs?.operationId !== dispatch.operationId ||
      event.refs?.toolCallId !== dispatch.providerToolCallId
    ) {
      decision.status = 'corruption';
      decision.reason = 'identity_conflict';
      continue;
    }
    decision.status = 'indeterminate';
    decision.reason = 'dispatch_without_response';
  }
  for (const event of events) {
    if (event.partial || event.content?.kind !== 'function_response') continue;
    const decision = decisionsByToolCallId.get(event.content.id);
    if (!decision) {
      decisions.push({
        toolCallId: event.content.id,
        toolName: event.content.name,
        status: 'corruption',
        reason: 'orphan_response',
        responseRuntimeEventId: event.id,
        responseIsError: event.content.isError === true,
      });
      continue;
    }
    if (decision.responseRuntimeEventId !== undefined) {
      decision.status = 'corruption';
      decision.reason = 'duplicate_response';
      continue;
    }
    decision.responseRuntimeEventId = event.id;
    decision.responseIsError = event.content.isError === true;
    if (event.refs?.operationId) {
      responseEventsByOperationId.set(event.refs.operationId, event);
    }
    if (decision.status === 'corruption') continue;
    if (
      decision.toolName !== event.content.name ||
      (decision.operationId !== undefined && event.refs?.operationId !== decision.operationId) ||
      (event.refs?.toolCallId !== undefined && event.refs.toolCallId !== decision.toolCallId)
    ) {
      decision.status = 'corruption';
      decision.reason = 'identity_conflict';
      continue;
    }
    decision.status = 'completed';
    decision.reason = 'matching_response';
  }
  const recoveryFactsByOperationId = new Map<string, RuntimeEvent[]>();
  for (const event of events) {
    const fact = event.actions?.toolRecovery;
    if (!fact) continue;
    const facts = recoveryFactsByOperationId.get(fact.payload.operationId) ?? [];
    facts.push(event);
    recoveryFactsByOperationId.set(fact.payload.operationId, facts);
  }
  const eventIndex = new Map(events.map((event, index) => [event.id, index]));
  for (const [operationId, facts] of recoveryFactsByOperationId) {
    const decision = decisionsByOperationId.get(operationId);
    const dispatchEvent = dispatchEventsByOperationId.get(operationId);
    const callEvent = decision ? callEventsByToolCallId.get(decision.toolCallId) : undefined;
    const reconcileEvent = facts.find(
      (event) => event.actions?.toolRecovery?.kind === 'maka.tool.reconcile_result',
    );
    const decisionEvent = facts.find(
      (event) => event.actions?.toolRecovery?.kind === 'maka.tool.recovery_decision',
    );
    const outcomeEvent = responseEventsByOperationId.get(operationId);
    const validShape =
      facts.length === 2 &&
      decision !== undefined &&
      dispatchEvent !== undefined &&
      callEvent !== undefined &&
      reconcileEvent !== undefined &&
      decisionEvent !== undefined;
    const validation = validShape
      ? validateToolRecoveryEventBundle({
          operation: {
            operationId,
            invocationId: dispatchEvent.invocationId,
            runId: dispatchEvent.runId,
            turnId: dispatchEvent.turnId,
            providerToolCallId: decision.toolCallId,
            toolName: decision.toolName ?? dispatchEvent.actions?.toolDispatch?.toolName ?? '',
            canonicalArgsHash: dispatchEvent.actions?.toolDispatch?.canonicalArgsHash ?? '',
            recoveryMode: dispatchEvent.actions?.toolDispatch?.recoveryMode ?? 'never_auto_retry',
            callEventId: callEvent.id,
            dispatchEventId: dispatchEvent.id,
          },
          callEvent,
          dispatchEvent,
          reconcileEvent,
          outcomeEvent,
          decisionEvent,
        })
      : undefined;
    if (
      !validation?.ok ||
      !isCanonicalRecoveryOrder({
        eventIndex,
        callEvent,
        dispatchEvent,
        reconcileEvent,
        outcomeEvent,
        decisionEvent,
      })
    ) {
      if (decision) {
        decision.status = 'corruption';
        decision.reason = 'recovery_fact_corruption';
      } else {
        decisions.push({
          toolCallId: facts[0]?.refs?.toolCallId ?? operationId,
          operationId,
          status: 'corruption',
          reason: 'recovery_fact_corruption',
        });
      }
    }
  }
  return {
    ...(toolBoundaryProtocol ? { toolBoundaryProtocol } : {}),
    decisions,
    issues,
    hasCorruption:
      issues.length > 0 || decisions.some((decision) => decision.status === 'corruption'),
    requiresReconciliation: decisions.some((decision) => decision.status === 'indeterminate'),
  };
}

function isCanonicalRecoveryOrder(input: {
  eventIndex: ReadonlyMap<string, number>;
  callEvent?: RuntimeEvent;
  dispatchEvent?: RuntimeEvent;
  reconcileEvent?: RuntimeEvent;
  outcomeEvent?: RuntimeEvent;
  decisionEvent?: RuntimeEvent;
}): boolean {
  if (!input.callEvent || !input.dispatchEvent || !input.reconcileEvent || !input.decisionEvent) {
    return false;
  }
  const ordered = [
    input.callEvent,
    input.dispatchEvent,
    input.reconcileEvent,
    ...(input.outcomeEvent ? [input.outcomeEvent] : []),
    input.decisionEvent,
  ].map((event) => input.eventIndex.get(event.id));
  return ordered.every(
    (index, position) =>
      index !== undefined && (position === 0 || index > (ordered[position - 1] ?? -1)),
  );
}
