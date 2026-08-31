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
import { readFile, realpath, stat } from 'node:fs/promises';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  discoverMarkedStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  GITOXIDE_HELPER_OPERATIONS_INTERNAL,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../../server/gitoxide-helper-artifact-authority-internal.js';
import { createGitoxideManagedWriteEditOwnerInternal } from '../../server/gitoxide-managed-write-edit-owner-internal.js';

interface Fixture {
  readonly storageRoot: string;
  readonly repositoryPath: string;
  readonly helperPath: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceInstanceId: string;
  readonly operationId: string;
  readonly toolCallId: string;
  readonly args: {
    readonly path: string;
    readonly content: string;
  };
}

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('Missing managed Write crash fixture path');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture;
const rootCapability = await discoverMarkedStorageRoot({ path: fixture.storageRoot });
if (rootCapability.kind !== 'interactive') throw new Error('Crash fixture root kind is invalid');
const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
if (!rootOwner) throw new Error('Crash fixture could not acquire the storage root');
const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);

const helperPath = await realpath(fixture.helperPath);
const helperBytes = await readFile(helperPath);
const helperInfo = await stat(helperPath);
const releaseOwnerToken = {};
const invocationOwnerToken = {};
const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
  executablePath: helperPath,
  expectedSha256: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`,
  expectedBytes: helperInfo.size,
  platform: process.platform,
  arch: process.arch,
  protocolVersion: 1,
  supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
});
const helperCapability = await admitGitoxideHelperArtifactInternal({
  releaseOwnerToken,
  invocationOwnerToken,
  claim,
});
const owner = createGitoxideManagedWriteEditOwnerInternal({
  storageRootLease: rootOwner.lease,
  stores,
  invocationOwnerToken,
  helperCapability,
  repositoryPath: fixture.repositoryPath,
  workspaceId: fixture.workspaceId,
  workspaceEpochId: fixture.workspaceEpochId,
  workspaceInstanceId: fixture.workspaceInstanceId,
  failpoint(point) {
    if (point === 'after_workspace_successor_commit') process.exit(73);
  },
});
const admission = await owner.admitManagedMutation({
  operationId: fixture.operationId,
  toolName: 'Write',
  persistedArgs: fixture.args,
  abortSignal: new AbortController().signal,
});
if (admission.immutableBase?.content !== 'before\n') {
  throw new Error('Crash fixture opened a different immutable base');
}
const identity = {
  sessionId: 'session-real-write',
  invocationId: 'invocation-real-write',
  runId: 'run-real-write',
  turnId: 'turn-real-write',
};
const canonicalArgsHash = canonicalToolArgsHash('Write', fixture.args);
await stores.runtimeEventStore.commitToolPrepared({
  operationId: fixture.operationId,
  journalEventId: `${fixture.operationId}_prepared`,
  runtimeEvent: {
    id: 'call-event-real-write',
    ...identity,
    ts: 2,
    partial: false,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: fixture.toolCallId,
      name: 'Write',
      args: fixture.args,
    },
    refs: { operationId: fixture.operationId, toolCallId: fixture.toolCallId },
  },
  dispatchRuntimeEvent: {
    id: 'dispatch-real-write',
    ...identity,
    ts: 2,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: fixture.operationId,
        providerToolCallId: fixture.toolCallId,
        toolName: 'Write',
        canonicalArgsHash,
        recoveryMode: 'reconcile',
        managedMutation: admission.durableDispatch,
      },
    },
    refs: { operationId: fixture.operationId, toolCallId: fixture.toolCallId },
  },
  providerToolCallId: fixture.toolCallId,
  toolName: 'Write',
  canonicalArgsHash,
  recoveryMode: 'reconcile',
  committedAt: 2,
});
const durableOutcome = {
  id: 'outcome-event-real-write',
  ...identity,
  ts: 3,
  partial: false,
  role: 'tool' as const,
  author: 'tool' as const,
  content: {
    kind: 'function_response' as const,
    id: fixture.toolCallId,
    name: 'Write',
    result: {
      kind: 'json' as const,
      value: { kind: 'file_write', path: fixture.args.path },
    },
  },
  refs: { operationId: fixture.operationId, toolCallId: fixture.toolCallId },
};
await admission.execute(async () => ({
  content: durableOutcome.content.result,
  isError: false,
  durationMs: 1,
  mutationResult: {
    path: fixture.args.path,
    content: fixture.args.content,
    changed: true,
  },
  durableOutcome,
}));
throw new Error('Crash fixture did not stop after the durable successor commit');
