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
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  WorkspaceHeadRecordV1,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import {
  createGitoxideManagedMutationAdmissionInternal,
  reconcileGitoxideManagedMutationProjectionInternal,
  type GitoxideManagedMutationSettlementAuthorityInternal,
} from '../server/gitoxide-managed-mutation-admission.js';

test('commits the exact Runtime outcome before promoting the Gitoxide candidate', async () => {
  const order: string[] = [];
  const head = baselineHead();
  const version = baselineVersion(head);
  const authority: GitoxideManagedMutationSettlementAuthorityInternal = {
    readHead: async () => head,
    readVersion: async () => version,
    commitSuccessor: async (input) => {
      order.push('sqlite');
      assert.equal(input.toolOutcome.runtimeEvent.id, 'op-1_response');
      assert.equal(input.successor.successor.commitOid, '3'.repeat(40));
      return {
        created: true,
        outcomeRuntimeEventSeq: 4,
        head: { ...head, commitOid: '3'.repeat(40), treeOid: '4'.repeat(40), revision: 2 },
      };
    },
  };
  const admissionOwner = createGitoxideManagedMutationAdmissionInternal({
    workspaceInstanceId: 'instance_44444444444444444444444444444444',
    workspaceId: head.workspaceId,
    workspaceEpochId: head.workspaceEpochId,
    settlementAuthority: authority,
    candidateAuthorityForHead: async () => ({
      readBaseFile: async () => ({ content: 'before\n', blobOid: '5'.repeat(40) }),
      capture: async () => ({
        receipt: {
          repositoryId: head.repositoryId,
          workspaceId: head.workspaceId,
          workspaceEpochId: head.workspaceEpochId,
          workspaceVersionId: head.workspaceVersionId,
          baseAcceptedEventId: head.acceptedEventId,
          baseHeadRevision: head.revision,
          baseCommitOid: head.commitOid,
          baseTreeOid: head.treeOid,
          candidateCommitOid: '3'.repeat(40),
          candidateTreeOid: '4'.repeat(40),
          resultBlobOid: '6'.repeat(40),
          path: 'notes.txt',
          contentSha256: sha256('after\n'),
          executionProfileDigest:
            'sha256:992cc9a7a2f7cd32b1062241146727aac11ae111ab81d480c57c5d68ad8f35cc',
        },
      }),
      promote: async (proof) => {
        order.push('promote');
        return proof.receipt;
      },
      promoteDurable: async () => {
        throw new Error('not used');
      },
    }),
  });

  const admission = await admissionOwner({
    operationId: 'op-1',
    toolName: 'Write',
    persistedArgs: { path: 'notes.txt', content: 'after\n' },
    abortSignal: new AbortController().signal,
  });
  const durableOutcome = outcomeEvent();
  const content = {
    kind: 'json' as const,
    value: { kind: 'file_diff', paths: ['notes.txt'], diff: 'diff' },
  };
  const settlement = await admission.execute(async () => ({
    content,
    isError: false,
    durationMs: 5,
    durableOutcome,
    managedMutationResult: {
      canonicalPath: 'notes.txt',
      content: 'after\n',
      changed: true,
    },
  }));

  assert.equal(settlement.kind, 'workspace_successor_committed');
  assert.deepEqual(order, ['sqlite', 'promote']);
  assert.equal(admission.gitoxideTransform?.baseContent, 'before\n');
});

test('replays only candidate promotion after SQLite already accepted the successor', async () => {
  const parent = baselineHead();
  const parentVersion = baselineVersion(parent);
  const successor: WorkspaceVersionRecordV1 = {
    protocol: 'workspace_version_accepted_v1',
    repositoryId: parent.repositoryId,
    workspaceId: parent.workspaceId,
    workspaceEpochId: parent.workspaceEpochId,
    workspaceVersionId: 'version_99999999999999999999999999999999',
    objectFormat: 'sha1',
    parents: [parent.workspaceVersionId],
    origin: {
      kind: 'tool_mutation',
      operationId: 'op-recover',
      dispatchEventId: 'op-recover_dispatch',
      outcomeEventId: 'op-recover_response',
    },
    baseAcceptedEventId: parent.acceptedEventId,
    baseHeadRevision: parent.revision,
    commitOid: '3'.repeat(40),
    treeOid: '4'.repeat(40),
    policyHash: parentVersion.policyHash,
    treeDeltaDigest: `sha256:${'a'.repeat(64)}`,
    changedPaths: ['notes.txt'],
    changedFileCount: 1,
    deletedFileCount: 0,
    executionProfileDigest:
      'sha256:992cc9a7a2f7cd32b1062241146727aac11ae111ab81d480c57c5d68ad8f35cc',
    acceptedEventId: 'successor-event-1',
    committedAt: 10,
  };
  const head: WorkspaceHeadRecordV1 = {
    ...parent,
    workspaceVersionId: successor.workspaceVersionId,
    acceptedEventId: successor.acceptedEventId,
    commitOid: successor.commitOid,
    treeOid: successor.treeOid,
    revision: 2,
  };
  let promoted = 0;
  const result = await reconcileGitoxideManagedMutationProjectionInternal({
    workspaceId: head.workspaceId,
    workspaceEpochId: head.workspaceEpochId,
    settlementAuthority: {
      readHead: async () => head,
      readVersion: async (id) => (id === successor.workspaceVersionId ? successor : parentVersion),
      commitSuccessor: async () => {
        throw new Error('reconciliation must not rewrite SQLite');
      },
    },
    candidateAuthorityForHead: async (base) => {
      assert.deepEqual(base, parent);
      return {
        readBaseFile: async () => null,
        capture: async () => {
          throw new Error('reconciliation must not rerun the transform');
        },
        promote: async () => {
          throw new Error('reconciliation must use the durable receipt');
        },
        promoteDurable: async (operationId) => {
          promoted += 1;
          assert.equal(operationId, 'op-recover');
          return {
            repositoryId: parent.repositoryId,
            workspaceId: parent.workspaceId,
            workspaceEpochId: parent.workspaceEpochId,
            workspaceVersionId: parent.workspaceVersionId,
            baseAcceptedEventId: parent.acceptedEventId,
            baseHeadRevision: parent.revision,
            baseCommitOid: parent.commitOid,
            baseTreeOid: parent.treeOid,
            candidateCommitOid: successor.commitOid,
            candidateTreeOid: successor.treeOid,
            resultBlobOid: '6'.repeat(40),
            path: 'notes.txt',
            contentSha256: `sha256:${'b'.repeat(64)}`,
            executionProfileDigest: successor.executionProfileDigest,
          };
        },
      };
    },
  });

  assert.equal(result, 'promoted');
  assert.equal(promoted, 1);
});

function baselineHead(): WorkspaceHeadRecordV1 {
  return {
    repositoryId: 'repository_11111111111111111111111111111111',
    workspaceId: 'workspace_22222222222222222222222222222222',
    workspaceEpochId: 'epoch_33333333333333333333333333333333',
    workspaceVersionId: 'version_55555555555555555555555555555555',
    acceptedEventId: 'baseline-event-1',
    commitOid: '1'.repeat(40),
    treeOid: '2'.repeat(40),
    revision: 1,
  };
}

function baselineVersion(head: WorkspaceHeadRecordV1): WorkspaceVersionRecordV1 {
  return {
    protocol: 'workspace_baseline_accepted_v1',
    repositoryId: head.repositoryId,
    workspaceId: head.workspaceId,
    workspaceEpochId: head.workspaceEpochId,
    workspaceVersionId: head.workspaceVersionId,
    objectFormat: 'sha1',
    parents: [],
    origin: { kind: 'baseline', epochOpenedEventId: 'epoch-event-1' },
    commitOid: head.commitOid,
    treeOid: head.treeOid,
    policyHash: `sha256:${'7'.repeat(64)}`,
    treeDeltaDigest: `sha256:${'8'.repeat(64)}`,
    changedFileCount: 1,
    deletedFileCount: 0,
    acceptedEventId: head.acceptedEventId,
    committedAt: 1,
  };
}

function outcomeEvent(): RuntimeEvent {
  return {
    id: 'op-1_response',
    sessionId: 'session-1',
    invocationId: 'run-1',
    runId: 'run-1',
    turnId: 'turn-1',
    ts: 10,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'call-1',
      name: 'Write',
      result: {
        kind: 'json',
        value: { kind: 'file_diff', paths: ['notes.txt'], diff: 'diff' },
      },
    },
    refs: { operationId: 'op-1', toolCallId: 'call-1' },
    actions: { stateDelta: { durationMs: 5 } },
  };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
