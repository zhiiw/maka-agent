/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { ToolResultContent } from '@maka/core/events';
import type { ShellRunRecord, ShellRunStore } from '@maka/core/shell-run';
import { decodeRuntimeEvent, type RuntimeEvent } from '@maka/core/runtime-event';
import { scanToolLedger, type ToolLedgerScanOperation } from '@maka/core/tool-ledger-scanner';
import { shellRunContent, terminalContent } from '@maka/runtime/shell-run-tool-result';
import type { ExecutionRuntimeEventWriter } from '@maka/storage/execution-stores';
import type { ToolOperationRecord } from '@maka/storage/sqlite-runtime-store';

const COMMAND_NOT_STARTED_TEXT =
  'command_not_started: the Runtime Host restarted before the durable ShellRun claim was created; no command process was spawned.';

export interface ShellRunRecoveryResult {
  readonly settled: number;
  /** Operations intentionally left without T2 because effect evidence is incomplete. */
  readonly parked: number;
}

/**
 * Settles only outcomes proven by the ShellRun authority.
 *
 * An active/orphaned record is deliberately left at T1 so continuation stays
 * blocked.  Recovery never starts a process and never guesses an exit status.
 */
export async function recoverShellRunToolOutcomes(
  runtimeEvents: ExecutionRuntimeEventWriter,
  shellRuns: Pick<ShellRunStore, 'readShellRunBySourceOperation'>,
  sessionIds: readonly string[],
  now: () => number = Date.now,
): Promise<ShellRunRecoveryResult> {
  if (!shellRuns.readShellRunBySourceOperation) {
    throw new Error('ShellRun recovery requires durable source-operation lookup');
  }
  let settled = 0;
  let parked = 0;
  for (const sessionId of sessionIds) {
    const operations = await runtimeEvents.listUnsettledToolOperations(sessionId);
    for (const operation of operations) {
      if (operation.toolName !== 'Bash' || operation.recoveryMode !== 'reattach') continue;
      const record = await shellRuns.readShellRunBySourceOperation(
        sessionId,
        operation.operationId,
      );
      const events = await runtimeEvents.readImmutableRuntimeEvents(sessionId, operation.runId);
      const source = requireShellRunRecoverySource(events, operation);

      if (!record) {
        const committed = await commitRecoveredShellOutcome({
          runtimeEvents,
          operation,
          source,
          result: { kind: 'text', text: COMMAND_NOT_STARTED_TEXT },
          isError: true,
          ts: now(),
        });
        if (committed) settled += 1;
        continue;
      }
      assertShellRunRecoveryIdentity(record, sessionId, operation);
      if (
        record.status === 'starting' ||
        record.status === 'running' ||
        record.status === 'orphaned'
      ) {
        parked += 1;
        continue;
      }

      const background = source.call.args.run_in_background === true;
      const result = background ? shellRunContent(record) : terminalContent(record);
      const committed = await commitRecoveredShellOutcome({
        runtimeEvents,
        operation,
        source,
        result,
        isError: background ? false : record.status !== 'completed',
        ts: now(),
      });
      if (committed) settled += 1;
    }
  }
  return { settled, parked };
}

function requireShellRunRecoverySource(
  events: readonly RuntimeEvent[],
  operation: ToolOperationRecord,
): {
  readonly callEvent: RuntimeEvent;
  readonly call: Extract<NonNullable<RuntimeEvent['content']>, { kind: 'function_call' }> & {
    readonly args: Record<string, unknown>;
  };
} {
  const scan = scanToolLedger(events);
  if (scan.issues.length > 0) {
    throw new Error(
      `ShellRun recovery found corrupt RuntimeEvent evidence: ${scan.issues[0]!.code}`,
    );
  }
  const scanned = scan.operations.find(
    (candidate) => candidate.operationId === operation.operationId,
  );
  if (!scanned) throw new Error('ShellRun recovery operation is missing from immutable evidence');
  assertScannedOperationMatchesProjection(scanned, operation);
  const callEvent = scanned.callEvent!;
  const call = callEvent.content!;
  if (
    call.kind !== 'function_call' ||
    call.name !== 'Bash' ||
    !call.args ||
    typeof call.args !== 'object' ||
    Array.isArray(call.args)
  ) {
    throw new Error('ShellRun recovery has an invalid durable Bash call');
  }
  const args = call.args as Record<string, unknown>;
  if (
    (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') ||
    (args.pty === true && args.run_in_background !== true)
  ) {
    throw new Error('ShellRun recovery has an invalid foreground/background contract');
  }
  return { callEvent, call: { ...call, args } };
}

function assertScannedOperationMatchesProjection(
  scanned: ToolLedgerScanOperation,
  operation: ToolOperationRecord,
): void {
  const dispatch = scanned.dispatchEvent?.actions?.toolDispatch;
  if (
    scanned.responseEvent ||
    !scanned.callEvent ||
    !dispatch ||
    scanned.toolCallId !== operation.providerToolCallId ||
    scanned.toolName !== operation.toolName ||
    dispatch.operationId !== operation.operationId ||
    dispatch.canonicalArgsHash !== operation.canonicalArgsHash ||
    dispatch.recoveryMode !== 'reattach'
  ) {
    throw new Error('ShellRun recovery projection does not match immutable RuntimeEvent evidence');
  }
}

function assertShellRunRecoveryIdentity(
  record: ShellRunRecord,
  sessionId: string,
  operation: ToolOperationRecord,
): void {
  if (
    record.sessionId !== sessionId ||
    record.sourceOperationId !== operation.operationId ||
    record.sourceRequestHash !== operation.canonicalArgsHash ||
    record.sourceRunId !== operation.runId ||
    record.sourceTurnId !== operation.turnId ||
    record.sourceToolCallId !== operation.providerToolCallId
  ) {
    throw new Error('ShellRun recovery identity does not match the durable tool operation');
  }
}

async function commitRecoveredShellOutcome(input: {
  runtimeEvents: ExecutionRuntimeEventWriter;
  operation: ToolOperationRecord;
  source: ReturnType<typeof requireShellRunRecoverySource>;
  result: ToolResultContent;
  isError: boolean;
  ts: number;
}): Promise<boolean> {
  const callRefs = input.source.callEvent.refs;
  const runtimeEvent: RuntimeEvent = {
    id: `${input.operation.operationId}_response`,
    invocationId: input.operation.invocationId,
    runId: input.operation.runId,
    sessionId: input.source.callEvent.sessionId,
    turnId: input.operation.turnId,
    ts: input.ts,
    partial: false,
    role: 'tool',
    author: 'tool',
    origin: input.source.callEvent.origin,
    modelVisibility: input.source.callEvent.modelVisibility,
    content: {
      kind: 'function_response',
      id: input.operation.providerToolCallId,
      name: 'Bash',
      result: input.result,
      ...(input.isError ? { isError: true } : {}),
    },
    refs: {
      operationId: input.operation.operationId,
      toolCallId: input.operation.providerToolCallId,
      ...(callRefs?.parentToolCallId ? { parentToolCallId: callRefs.parentToolCallId } : {}),
      ...(callRefs?.parentOperationId ? { parentOperationId: callRefs.parentOperationId } : {}),
    },
  };
  decodeRuntimeEvent(runtimeEvent);
  const commit = await input.runtimeEvents.commitToolOutcome({
    operationId: input.operation.operationId,
    journalEventId: `${input.operation.operationId}_outcome`,
    runtimeEvent,
    committedAt: input.ts,
  });
  return commit.created;
}
