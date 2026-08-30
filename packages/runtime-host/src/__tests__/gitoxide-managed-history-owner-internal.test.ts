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
import test from 'node:test';
import type {
  WorkspaceHeadRecordV1,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import { createGitoxideManagedHistoryOwnerInternal } from '../server/gitoxide-managed-history-owner-internal.js';

const WORKSPACE_ID = 'workspace-history';
const EPOCH_ID = 'epoch-history';
const REPOSITORY_ID = 'repository-history';
const BASELINE_ID = `version_${'1'.repeat(32)}`;
const SECOND_ID = `version_${'2'.repeat(32)}`;
const HEAD_ID = `version_${'3'.repeat(32)}`;

test('managed history follows one immutable accepted lineage from its captured head', async () => {
  const versions = new Map<string, WorkspaceVersionRecordV1>([
    [BASELINE_ID, baseline(BASELINE_ID)],
    [SECOND_ID, successor(SECOND_ID, BASELINE_ID, 2)],
    [HEAD_ID, successor(HEAD_ID, SECOND_ID, 3)],
  ]);
  const owner = createGitoxideManagedHistoryOwnerInternal({
    readHead: async () => head(),
    readVersion: async (id) => versions.get(id),
    repositoryId: REPOSITORY_ID,
    workspaceId: WORKSPACE_ID,
    workspaceEpochId: EPOCH_ID,
  });

  assert.deepEqual(await owner.list(2), {
    headWorkspaceVersionId: HEAD_ID,
    versions: [
      {
        workspaceVersionId: HEAD_ID,
        parentWorkspaceVersionId: SECOND_ID,
        commitOid: '3'.repeat(40),
        treeOid: '3'.repeat(40),
        acceptedEventId: 'accepted-3',
        committedAt: 3,
        kind: 'tool_mutation',
        changedFileCount: 1,
      },
      {
        workspaceVersionId: SECOND_ID,
        parentWorkspaceVersionId: BASELINE_ID,
        commitOid: '2'.repeat(40),
        treeOid: '2'.repeat(40),
        acceptedEventId: 'accepted-2',
        committedAt: 2,
        kind: 'tool_mutation',
        changedFileCount: 1,
      },
    ],
    hasMore: true,
  });
});

test('managed history fails closed when a version leaves its durable epoch', async () => {
  const corrupted = { ...successor(HEAD_ID, SECOND_ID, 3), workspaceEpochId: 'other-epoch' };
  const owner = createGitoxideManagedHistoryOwnerInternal({
    readHead: async () => head(),
    readVersion: async () => corrupted,
    repositoryId: REPOSITORY_ID,
    workspaceId: WORKSPACE_ID,
    workspaceEpochId: EPOCH_ID,
  });

  await assert.rejects(owner.list(10), /history identity is unavailable/u);
});

function head(): WorkspaceHeadRecordV1 {
  return {
    repositoryId: REPOSITORY_ID,
    workspaceId: WORKSPACE_ID,
    workspaceEpochId: EPOCH_ID,
    workspaceVersionId: HEAD_ID,
    acceptedEventId: 'accepted-3',
    commitOid: '3'.repeat(40),
    treeOid: '3'.repeat(40),
    revision: 3,
  };
}

function baseline(workspaceVersionId: string): WorkspaceVersionRecordV1 {
  return {
    protocol: 'workspace_baseline_accepted_v1',
    repositoryId: REPOSITORY_ID,
    workspaceId: WORKSPACE_ID,
    workspaceEpochId: EPOCH_ID,
    workspaceVersionId,
    objectFormat: 'sha1',
    parents: [],
    origin: { kind: 'baseline', epochOpenedEventId: 'epoch-opened' },
    policyHash: `sha256:${'a'.repeat(64)}`,
    treeDeltaDigest: `sha256:${'b'.repeat(64)}`,
    changedFileCount: 1,
    deletedFileCount: 0,
    acceptedEventId: 'accepted-1',
    committedAt: 1,
    commitOid: '1'.repeat(40),
    treeOid: '1'.repeat(40),
  };
}

function successor(
  workspaceVersionId: string,
  parentWorkspaceVersionId: string,
  sequence: number,
): WorkspaceVersionRecordV1 {
  return {
    protocol: 'workspace_version_accepted_v1',
    repositoryId: REPOSITORY_ID,
    workspaceId: WORKSPACE_ID,
    workspaceEpochId: EPOCH_ID,
    workspaceVersionId,
    objectFormat: 'sha1',
    parents: [parentWorkspaceVersionId],
    origin: {
      kind: 'tool_mutation',
      operationId: `operation-${sequence}`,
      dispatchEventId: `dispatch-${sequence}`,
      outcomeEventId: `outcome-${sequence}`,
    },
    baseAcceptedEventId: `accepted-${sequence - 1}`,
    baseHeadRevision: sequence - 1,
    commitOid: String(sequence).repeat(40),
    treeOid: String(sequence).repeat(40),
    policyHash: `sha256:${'a'.repeat(64)}`,
    treeDeltaDigest: `sha256:${'b'.repeat(64)}`,
    changedPaths: ['notes.txt'],
    changedFileCount: 1,
    deletedFileCount: 0,
    executionProfileDigest: `sha256:${'c'.repeat(64)}`,
    acceptedEventId: `accepted-${sequence}`,
    committedAt: sequence,
  };
}
