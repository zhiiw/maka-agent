import {
  isPartialRuntimeEvent,
  type RuntimeEvent,
  type RuntimeEventFunctionCallContent,
  type RuntimeEventFunctionResponseContent,
} from '@maka/core/runtime-event';

export type ToolOperationStatus =
  | 'succeeded'
  | 'failed'
  | 'indeterminate';

export interface ToolOperation {
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: ToolOperationStatus;
  callRuntimeEventId: string;
  responseRuntimeEventId?: string;
  responseIsError?: boolean;
}

export type ResumePlanDisposition =
  | 'safe_replay'
  | 'blocked';

export type ResumePlanDiagnosticCode =
  | 'pending_tool_result'
  | 'unmatched_tool_result'
  | 'tool_name_mismatch'
  | 'runtime_offset_mismatch';

export type ResumeRejectionReason =
  | 'runtime_offset_mismatch'
  | 'dangling_tool_state';

export interface ResumePlanDiagnostic {
  code: ResumePlanDiagnosticCode;
  message: string;
  eventId?: string;
  toolCallId?: string;
  toolName?: string;
  detail?: Record<string, unknown>;
}

export interface ResumePlan {
  disposition: ResumePlanDisposition;
  operations: ToolOperation[];
  diagnostics: ResumePlanDiagnostic[];
  rejectionReasons: ResumeRejectionReason[];
  requiresVerification: boolean;
  sourceRuntimeEventHighWater: number;
  directive?: string;
  runtimeEvents: RuntimeEvent[];
  replayRuntimeEvents: RuntimeEvent[];
}

export interface BuildResumePlanOptions {
  expectedRuntimeEventHighWater?: number;
}

interface MutableToolOperation extends ToolOperation {
  responseRuntimeEventId?: string;
  responseIsError?: boolean;
}

export const INDETERMINATE_TOOL_RESULT_DIRECTIVE = [
  'Tool execution was interrupted before a matching committed tool result was found.',
  'The side effects may or may not have occurred.',
  'Do not retry the tool call immediately.',
  'Use read-only inspection tools to verify the current state before deciding the next step.',
].join(' ');

export function projectToolOperationsFromRuntimeEvents(
  events: readonly RuntimeEvent[],
): ToolOperation[] {
  const operationsById = new Map<string, MutableToolOperation>();
  const operations: MutableToolOperation[] = [];

  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    const content = event.content;
    if (!content) continue;

    if (content.kind === 'function_call') {
      if (operationsById.has(content.id)) continue;
      const operation: MutableToolOperation = {
        toolCallId: content.id,
        toolName: content.name,
        args: content.args,
        status: 'indeterminate',
        callRuntimeEventId: event.id,
      };
      operationsById.set(content.id, operation);
      operations.push(operation);
      continue;
    }

    if (content.kind === 'function_response') {
      const operation = operationsById.get(content.id);
      if (!operation || operation.responseRuntimeEventId !== undefined) continue;
      operation.responseRuntimeEventId = event.id;
      operation.responseIsError = content.isError === true;
      operation.status = content.isError === true ? 'failed' : 'succeeded';
    }
  }

  return operations.map((operation) => ({ ...operation }));
}

export function buildResumePlanFromRuntimeEvents(
  events: readonly RuntimeEvent[],
  options: BuildResumePlanOptions = {},
): ResumePlan {
  const operations = projectToolOperationsFromRuntimeEvents(events);
  const sourceRuntimeEventHighWater = events.length;
  const diagnostics = collectResumeDiagnostics(events, operations, options);
  const rejectionReasons = deriveRejectionReasons(diagnostics);
  const requiresVerification = operations.some((operation) => operation.status === 'indeterminate');
  const disposition: ResumePlanDisposition =
    rejectionReasons.length === 0 && !requiresVerification ? 'safe_replay' : 'blocked';

  return {
    disposition,
    operations,
    diagnostics,
    rejectionReasons,
    requiresVerification,
    sourceRuntimeEventHighWater,
    ...(requiresVerification ? { directive: INDETERMINATE_TOOL_RESULT_DIRECTIVE } : {}),
    runtimeEvents: [...events],
    replayRuntimeEvents: buildResumeReplayRuntimeEvents(events),
  };
}

export function buildResumeReplayRuntimeEvents(
  events: readonly RuntimeEvent[],
): RuntimeEvent[] {
  const pairedCallIds = collectPairedCallIds(events);
  const replayEvents: RuntimeEvent[] = [];

  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    const content = event.content;
    if (!content) {
      replayEvents.push(event);
      continue;
    }
    if (content.kind === 'function_call') {
      if (pairedCallIds.has(content.id)) replayEvents.push(event);
      continue;
    }
    if (content.kind === 'function_response') {
      if (pairedCallIds.has(content.id)) replayEvents.push(event);
      continue;
    }
    replayEvents.push(event);
  }

  return replayEvents;
}

function collectResumeDiagnostics(
  events: readonly RuntimeEvent[],
  operations: readonly ToolOperation[],
  options: BuildResumePlanOptions,
): ResumePlanDiagnostic[] {
  const diagnostics: ResumePlanDiagnostic[] = [];
  const operationsById = new Map(operations.map((operation) => [operation.toolCallId, operation]));
  if (
    options.expectedRuntimeEventHighWater !== undefined
    && options.expectedRuntimeEventHighWater !== events.length
  ) {
    diagnostics.push({
      code: 'runtime_offset_mismatch',
      message: 'RuntimeEvent high-water does not match the expected checkpoint offset',
      detail: {
        expectedRuntimeEventHighWater: options.expectedRuntimeEventHighWater,
        actualRuntimeEventHighWater: events.length,
      },
    });
  }

  for (const operation of operations) {
    if (operation.status === 'indeterminate') {
      diagnostics.push({
        code: 'pending_tool_result',
        message: 'function_call has no matching committed function_response',
        eventId: operation.callRuntimeEventId,
        toolCallId: operation.toolCallId,
        toolName: operation.toolName,
      });
    }
  }

  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    const content = event.content;
    if (content?.kind !== 'function_response') continue;
    const operation = operationsById.get(content.id);
    if (!operation) {
      diagnostics.push({
        code: 'unmatched_tool_result',
        message: 'function_response has no prior matching function_call',
        eventId: event.id,
        toolCallId: content.id,
        toolName: content.name,
      });
      continue;
    }
    if (operation.toolName !== content.name) {
      diagnostics.push({
        code: 'tool_name_mismatch',
        message: 'function_response tool name differs from matching function_call',
        eventId: event.id,
        toolCallId: content.id,
        toolName: content.name,
        detail: {
          callToolName: operation.toolName,
          responseToolName: content.name,
        },
      });
    }
  }

  return diagnostics;
}

function deriveRejectionReasons(
  diagnostics: readonly ResumePlanDiagnostic[],
): ResumeRejectionReason[] {
  const reasons = new Set<ResumeRejectionReason>();
  for (const diagnostic of diagnostics) {
    switch (diagnostic.code) {
      case 'runtime_offset_mismatch':
        reasons.add('runtime_offset_mismatch');
        break;
      case 'pending_tool_result':
      case 'unmatched_tool_result':
      case 'tool_name_mismatch':
        reasons.add('dangling_tool_state');
        break;
    }
  }
  return [...reasons];
}

function collectPairedCallIds(events: readonly RuntimeEvent[]): Set<string> {
  const calls = new Map<string, RuntimeEventFunctionCallContent>();
  const paired = new Set<string>();

  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    const content = event.content;
    if (content?.kind === 'function_call') {
      calls.set(content.id, content);
      continue;
    }
    if (content?.kind === 'function_response' && hasMatchingCall(calls.get(content.id), content)) {
      paired.add(content.id);
    }
  }

  return paired;
}

function hasMatchingCall(
  call: RuntimeEventFunctionCallContent | undefined,
  response: RuntimeEventFunctionResponseContent,
): boolean {
  return call !== undefined && call.name === response.name;
}
