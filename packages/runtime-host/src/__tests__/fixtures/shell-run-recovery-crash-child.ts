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

import { TOOL_BOUNDARY_PROTOCOL_V1, type RuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { ShellRunProcessManager } from '@maka/runtime/shell-run-manager';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openStorageWriterComposition } from '@maka/storage/storage-writer-composition';

const root = process.env.MAKA_SHELL_RECOVERY_ROOT;
const marker = process.env.MAKA_SHELL_RECOVERY_MARKER;
if (!root || !marker) throw new Error('Missing ShellRun recovery crash fixture input');

const operationId = 'shell-recovery-operation';
const runId = 'shell-recovery-run';
const turnId = 'shell-recovery-turn';
const toolCallId = 'shell-recovery-call';
const invocationId = 'shell-recovery-invocation';
const args = { command: 'append one durable marker' };
const canonicalArgsHash = canonicalToolArgsHash('Bash', args);
const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
const owner = await tryAcquireInteractiveRootOwner(capability);
if (!owner) throw new Error('Unable to own ShellRun recovery crash fixture root');
const storage = await openStorageWriterComposition(owner.lease);
const runtime = storage.execution.runtimeEventStore;
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
      recoveryMode: 'reattach',
    },
  },
  refs: { operationId, toolCallId },
};
await runtime.commitToolPrepared({
  operationId,
  journalEventId: `${operationId}_prepared`,
  runtimeEvent: call,
  dispatchRuntimeEvent: dispatch,
  providerToolCallId: toolCallId,
  toolName: 'Bash',
  canonicalArgsHash,
  recoveryMode: 'reattach',
  committedAt: 10,
});

const manager = new ShellRunProcessManager({
  store: storage.shellRuns,
  newId: () => 'shell-1',
  now: Date.now,
});
const result = await manager.runForegroundBash({
  sessionId: 'session-1',
  sourceRunId: runId,
  sourceTurnId: turnId,
  sourceToolCallId: toolCallId,
  sourceOperationId: operationId,
  sourceRequestHash: canonicalArgsHash,
  cwd: root,
  command: args.command,
  argv: [process.execPath, '-e', "require('node:fs').appendFileSync(process.argv[1], 'x')", marker],
  emitOutput: () => undefined,
});
if (result.status !== 'completed' || result.exitCode !== 0) {
  throw new Error(`ShellRun recovery crash command failed: ${JSON.stringify(result)}`);
}

process.stdout.write('SHELL_TERMINAL_DURABLE\n', () => process.exit(86));
