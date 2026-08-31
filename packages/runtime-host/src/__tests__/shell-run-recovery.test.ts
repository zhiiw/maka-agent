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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolResultContent } from '@maka/core/events';
import type { ShellRunRecord } from '@maka/core/shell-run';
import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  type RuntimeEvent,
  type ToolRecoveryMode,
} from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { recoverShellRunToolOutcomes } from '../server/shell-run-recovery.js';

test('adopts exact terminal ShellRuns, settles no-claim calls, and parks uncertain effects', async () => {
  const runtime = createSqliteRuntimeStore(':memory:');
  try {
    const foreground = await prepareBash(runtime, 'foreground', { command: 'printf ok' });
    const background = await prepareBash(runtime, 'background', {
      command: 'exit 7',
      run_in_background: true,
    });
    await prepareBash(runtime, 'no-claim', { command: 'never spawned' });
    const active = await prepareBash(runtime, 'active', { command: 'still running' });
    const orphaned = await prepareBash(runtime, 'orphaned', { command: 'owner lost' });
    await prepareBash(runtime, 'ordinary', { command: 'legacy' }, 'never_auto_retry');

    const records = new Map<string, ShellRunRecord>([
      [foreground.operationId, shellRecord(foreground, 'completed', 0)],
      [background.operationId, shellRecord(background, 'failed', 7)],
      [active.operationId, shellRecord(active, 'running')],
      [orphaned.operationId, shellRecord(orphaned, 'orphaned')],
    ]);
    const result = await recoverShellRunToolOutcomes(
      runtime,
      {
        readShellRunBySourceOperation: async (_sessionId, operationId) => records.get(operationId),
      },
      ['session-1'],
      () => 50,
    );
    assert.deepEqual(result, { settled: 3, parked: 2 });

    const foregroundResponse = (
      await runtime.readImmutableRuntimeEvents('session-1', foreground.runId)
    ).at(-1);
    assert.equal(foregroundResponse?.content?.kind, 'function_response');
    if (foregroundResponse?.content?.kind !== 'function_response') assert.fail('missing response');
    assert.deepEqual(foregroundResponse.content.result, {
      kind: 'terminal',
      cwd: '/workspace',
      cmd: 'printf ok',
      status: 'completed',
      exitCode: 0,
      output: pipeOutput('ok'),
    });
    assert.equal(foregroundResponse.content.isError, undefined);

    const backgroundResponse = (
      await runtime.readImmutableRuntimeEvents('session-1', background.runId)
    ).at(-1);
    assert.equal(backgroundResponse?.content?.kind, 'function_response');
    if (backgroundResponse?.content?.kind !== 'function_response') assert.fail('missing response');
    const backgroundResult = backgroundResponse.content.result as ToolResultContent;
    assert.equal(backgroundResponse.content.isError, undefined);
    assert.equal(
      backgroundResult.kind === 'shell_run' ? backgroundResult.status : undefined,
      'failed',
    );

    const missingResponse = (
      await runtime.readImmutableRuntimeEvents('session-1', 'no-claim-run')
    ).at(-1);
    assert.equal(missingResponse?.content?.kind, 'function_response');
    if (missingResponse?.content?.kind !== 'function_response') assert.fail('missing response');
    const missingResult = missingResponse.content.result as ToolResultContent;
    assert.equal(missingResponse.content.isError, true);
    assert.match(missingResult.kind === 'text' ? missingResult.text : '', /command_not_started/u);

    assert.deepEqual(
      (await runtime.listUnsettledToolOperations('session-1')).map(
        (operation) => operation.operationId,
      ),
      ['active', 'ordinary', 'orphaned'],
    );
    assert.deepEqual(
      await recoverShellRunToolOutcomes(
        runtime,
        {
          readShellRunBySourceOperation: async (_sessionId, operationId) =>
            records.get(operationId),
        },
        ['session-1'],
        () => 60,
      ),
      { settled: 0, parked: 2 },
    );
  } finally {
    runtime.close();
  }
});

test('rejects a terminal ShellRun whose request identity differs from T1', async () => {
  const runtime = createSqliteRuntimeStore(':memory:');
  try {
    const operation = await prepareBash(runtime, 'identity-conflict', { command: 'printf ok' });
    const record = {
      ...shellRecord(operation, 'completed', 0),
      sourceRequestHash: `sha256:${'f'.repeat(64)}` as const,
    };
    await assert.rejects(
      recoverShellRunToolOutcomes(runtime, { readShellRunBySourceOperation: async () => record }, [
        'session-1',
      ]),
      /identity does not match/u,
    );
    assert.equal((await runtime.listUnsettledToolOperations('session-1')).length, 1);
  } finally {
    runtime.close();
  }
});

interface PreparedBash {
  operationId: string;
  runId: string;
  turnId: string;
  toolCallId: string;
  canonicalArgsHash: `sha256:${string}`;
  command: string;
}

async function prepareBash(
  store: ReturnType<typeof createSqliteRuntimeStore>,
  operationId: string,
  args: Record<string, unknown> & { command: string },
  recoveryMode: ToolRecoveryMode = 'reattach',
): Promise<PreparedBash> {
  const runId = `${operationId}-run`;
  const turnId = `${operationId}-turn`;
  const toolCallId = `${operationId}-call`;
  const invocationId = `${operationId}-invocation`;
  const canonicalArgsHash = canonicalToolArgsHash('Bash', args);
  const call: RuntimeEvent = {
    id: `${operationId}_call`,
    invocationId,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: 10,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: toolCallId, name: 'Bash', args },
    refs: { operationId, toolCallId },
  };
  const dispatch: RuntimeEvent = {
    id: `${operationId}_dispatch`,
    invocationId,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: 10,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: TOOL_BOUNDARY_PROTOCOL_V1,
        operationId,
        providerToolCallId: toolCallId,
        toolName: 'Bash',
        canonicalArgsHash,
        recoveryMode,
      },
    },
    refs: { operationId, toolCallId },
  };
  await store.commitToolPrepared({
    operationId,
    journalEventId: `${operationId}_prepared`,
    runtimeEvent: call,
    dispatchRuntimeEvent: dispatch,
    providerToolCallId: toolCallId,
    toolName: 'Bash',
    canonicalArgsHash,
    recoveryMode,
    committedAt: 10,
  });
  return { operationId, runId, turnId, toolCallId, canonicalArgsHash, command: args.command };
}

function shellRecord(
  operation: PreparedBash,
  status: ShellRunRecord['status'],
  exitCode?: number,
): ShellRunRecord {
  return {
    shellRunId: `${operation.operationId}-shell`,
    sessionId: 'session-1',
    sourceRunId: operation.runId,
    sourceTurnId: operation.turnId,
    sourceToolCallId: operation.toolCallId,
    sourceOperationId: operation.operationId,
    sourceRequestHash: operation.canonicalArgsHash,
    cwd: '/workspace',
    command: operation.command,
    status,
    ...(exitCode !== undefined ? { exitCode } : {}),
    startedAt: 20,
    updatedAt: 30,
    ...(status === 'starting' || status === 'running' ? {} : { completedAt: 30 }),
    revision: 2,
    output: pipeOutput(status === 'completed' ? 'ok' : ''),
  };
}

function pipeOutput(stdout: string): Extract<ShellRunRecord['output'], { mode: 'pipes' }> {
  return {
    mode: 'pipes',
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: true,
  };
}
