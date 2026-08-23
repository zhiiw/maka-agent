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

import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { requireExecutionStoresWorkspaceMutationAuthorityInternal } from '@maka/storage/execution-stores-workspace-authority-internal';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../../server/gitoxide-helper-artifact-authority-internal.js';
import { openGitoxideManagedMutationSession } from '../../server/gitoxide-managed-mutation-session.js';

interface CrashInput {
  readonly helperPath: string;
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly sessionId: string;
  readonly readyPath: string;
}

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Missing crash fixture input');
const input = JSON.parse(await readFile(inputPath, 'utf8')) as CrashInput;
const helperPath = await realpath(input.helperPath);
const [helperBytes, helperInfo] = await Promise.all([readFile(helperPath), stat(helperPath)]);
const releaseOwnerToken = {};
const invocationOwnerToken = {};
const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
  executablePath: helperPath,
  expectedSha256: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`,
  expectedBytes: helperInfo.size,
  platform: process.platform,
  arch: process.arch,
  protocolVersion: 1,
});
const helperCapability = await admitGitoxideHelperArtifactInternal({
  releaseOwnerToken,
  invocationOwnerToken,
  claim,
});
const storageCapability = await resolveStorageRoot({ path: input.storageRoot, kind: 'interactive' });
const storageOwner = await tryAcquireInteractiveRootOwner(storageCapability);
if (!storageOwner) throw new Error('Crash fixture could not own the storage root');
const stores = await openInteractiveExecutionStoresForWrite(storageOwner.lease);
const operationId = 'operation-gitoxide-process-crash';
const toolCallId = `${operationId}-call`;
const args = { path: 'notes.txt', content: 'after crash boundary\n' };
const session = await openGitoxideManagedMutationSession({
  storageRoot: storageCapability.canonicalPath,
  sourceRoot: input.sourceRoot,
  sessionId: input.sessionId,
  invocationOwnerToken,
  helperCapability,
  settlementAuthority: requireExecutionStoresWorkspaceMutationAuthorityInternal(stores),
  async failpoint(point) {
    if (point !== 'after_successor_commit') return;
    await writeFile(input.readyPath, 'ready\n', 'utf8');
    await new Promise<never>(() => {
      setInterval(() => {}, 60_000);
    });
  },
});
const admission = await session.admitManagedMutation({
  operationId,
  toolName: 'Write',
  persistedArgs: args,
  abortSignal: new AbortController().signal,
});
const identity = {
  sessionId: input.sessionId,
  invocationId: `invocation-${operationId}`,
  runId: `run-${operationId}`,
  turnId: `turn-${operationId}`,
};
const callEvent: RuntimeEvent = {
  id: `${operationId}-call-event`,
  ...identity,
  ts: 20,
  partial: false,
  role: 'model',
  author: 'agent',
  content: { kind: 'function_call', id: toolCallId, name: 'Write', args },
  refs: { operationId, toolCallId },
};
const dispatchEvent: RuntimeEvent = {
  id: `${operationId}_dispatch`,
  ...identity,
  ts: 20,
  partial: false,
  role: 'system',
  author: 'system',
  actions: {
    toolDispatch: {
      protocol: 't1_after_preflight_v1',
      operationId,
      providerToolCallId: toolCallId,
      toolName: 'Write',
      canonicalArgsHash: canonicalToolArgsHash('Write', args),
      recoveryMode: 'reconcile',
      managedMutation: admission.durableDispatch,
    },
  },
  refs: { operationId, toolCallId },
};
await stores.runtimeEventStore.commitToolPrepared({
  operationId,
  journalEventId: `${operationId}_prepared`,
  runtimeEvent: callEvent,
  dispatchRuntimeEvent: dispatchEvent,
  providerToolCallId: toolCallId,
  toolName: 'Write',
  canonicalArgsHash: canonicalToolArgsHash('Write', args),
  recoveryMode: 'reconcile',
  committedAt: 20,
});
const providerResult = { kind: 'file_write', path: 'notes.txt', bytes: args.content.length };
const resultContent = { kind: 'json' as const, value: providerResult };
const outcome: RuntimeEvent = {
  id: `${operationId}-outcome-event`,
  ...identity,
  ts: 21,
  partial: false,
  role: 'tool',
  author: 'tool',
  content: { kind: 'function_response', id: toolCallId, name: 'Write', result: resultContent },
  refs: { operationId, toolCallId },
  actions: { stateDelta: { durationMs: 1 } },
};
await admission.execute(async () => ({
  content: resultContent,
  isError: false,
  durationMs: 1,
  durableOutcome: outcome,
  managedMutationResult: {
    canonicalPath: 'notes.txt',
    content: args.content,
    changed: true,
  },
}));
