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
import {
  decodeManagedWorkspacePublishResult,
  decodeManagedWorkspaceMaintenanceResult,
  decodeManagedWorkspaceSourceBranchPublishResult,
  decodeManagedWorkspaceHistoryResult,
  decodeManagedWorkspaceHistoryUndoResult,
  decodeManagedWorkspaceReviewQueryResult,
  decodeManagedWorkspaceRebaselineResult,
  decodeManagedWorkspaceRestoreResult,
} from '../protocol/managed-workspace-review.js';

test('managed maintenance decodes one bounded restore-orphan collection result', () => {
  const result = {
    kind: 'managed_workspace_maintenance_completed',
    scope: 'restore_orphans_v1',
    collected: 3,
    retained: 5,
  } as const;
  assert.deepEqual(decodeManagedWorkspaceMaintenanceResult(result), result);
});

test('managed maintenance rejects counters outside its bounded inventory', () => {
  assert.throws(
    () =>
      decodeManagedWorkspaceMaintenanceResult({
        kind: 'managed_workspace_maintenance_completed',
        scope: 'restore_orphans_v1',
        collected: 257,
        retained: 0,
      }),
    /maintenance result/u,
  );
});

test('managed source branch Publish decodes one exact source-repository receipt', () => {
  const result = {
    kind: 'accepted_source_branch_published',
    publishId: 'desktop-branch-123',
    sourceBaseCommitOid: 'a'.repeat(40),
    sourceBaseTreeOid: 'b'.repeat(40),
    acceptedCommitOid: 'c'.repeat(40),
    acceptedTreeOid: 'd'.repeat(40),
    publishedCommitOid: 'e'.repeat(40),
    publishedRef: 'refs/heads/maka/desktop-branch-123',
    replayed: false,
  } as const;

  assert.deepEqual(decodeManagedWorkspaceSourceBranchPublishResult(result), result);
});

test('managed source branch Publish rejects a caller-selected branch namespace', () => {
  assert.throws(
    () =>
      decodeManagedWorkspaceSourceBranchPublishResult({
        kind: 'accepted_source_branch_published',
        publishId: 'desktop-branch-123',
        sourceBaseCommitOid: 'a'.repeat(40),
        sourceBaseTreeOid: 'b'.repeat(40),
        acceptedCommitOid: 'c'.repeat(40),
        acceptedTreeOid: 'd'.repeat(40),
        publishedCommitOid: 'e'.repeat(40),
        publishedRef: 'refs/heads/main',
        replayed: false,
      }),
    /published ref/u,
  );
});

test('managed Rebaseline decodes one exact active epoch result', () => {
  const result = {
    kind: 'managed_workspace_rebaselined',
    rebaselineId: 'desktop-rebaseline-1',
    workspaceId: `workspace_${'1'.repeat(32)}`,
    workspaceEpochId: `epoch_${'2'.repeat(32)}`,
    baselineWorkspaceVersionId: `version_${'3'.repeat(32)}`,
    sourceKind: 'git_repository_v1',
  } as const;
  assert.deepEqual(decodeManagedWorkspaceRebaselineResult(result), result);
});

test('managed History Undo decodes one accepted successor', () => {
  const result = {
    kind: 'accepted_history_successor',
    restoreId: 'desktop-undo-1',
    targetWorkspaceVersionId: `version_${'1'.repeat(32)}`,
    workspaceVersionId: `version_${'2'.repeat(32)}`,
    acceptedCommitOid: '2'.repeat(40),
    acceptedTreeOid: '1'.repeat(40),
    revision: 4,
    created: true,
  } as const;
  assert.deepEqual(decodeManagedWorkspaceHistoryUndoResult(result), result);
});

test('managed History Undo rejects a malformed accepted successor', () => {
  assert.throws(
    () =>
      decodeManagedWorkspaceHistoryUndoResult({
        kind: 'accepted_history_successor',
        restoreId: 'desktop-undo-1',
        targetWorkspaceVersionId: `version_${'1'.repeat(32)}`,
        workspaceVersionId: `version_${'1'.repeat(32)}`,
        acceptedCommitOid: '2'.repeat(40),
        acceptedTreeOid: '1'.repeat(40),
        revision: 0,
        created: true,
      }),
    /history successor/u,
  );
});

const valid = {
  kind: 'accepted_review',
  sourceKind: 'git_repository_v1',
  snapshot: {
    source: 'branch',
    repositoryRoot: 'maka-managed://session-1',
    currentBranch: null,
    baseBranch: null,
    baseBranchOptions: [],
    revision: 'a'.repeat(64),
    files: [
      {
        path: 'src/example.ts',
        status: 'modified',
        diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,1 +1,1 @@\n-old\n+new',
        additions: 1,
        deletions: 1,
      },
    ],
    additions: 1,
    deletions: 1,
    truncated: false,
  },
} as const;

test('managed Review protocol accepts one bounded accepted-tree projection', () => {
  assert.deepEqual(decodeManagedWorkspaceReviewQueryResult(valid), valid);
});

test('managed Review protocol rejects totals that do not match its files', () => {
  assert.throws(
    () =>
      decodeManagedWorkspaceReviewQueryResult({
        ...valid,
        snapshot: { ...valid.snapshot, additions: 2 },
      }),
    /totals conflict/u,
  );
});

test('managed Publish protocol accepts one exact immutable ref receipt', () => {
  const published = {
    kind: 'accepted_snapshot_published',
    publishId: 'desktop-123',
    acceptedCommitOid: 'b'.repeat(40),
    acceptedTreeOid: 'c'.repeat(40),
    publishedRef: 'refs/maka/published/desktop-123',
    replayed: false,
  } as const;

  assert.deepEqual(decodeManagedWorkspacePublishResult(published), published);
});

test('managed Publish protocol rejects refs outside the immutable publication namespace', () => {
  assert.throws(
    () =>
      decodeManagedWorkspacePublishResult({
        kind: 'accepted_snapshot_published',
        publishId: 'desktop-123',
        acceptedCommitOid: 'b'.repeat(40),
        acceptedTreeOid: 'c'.repeat(40),
        publishedRef: 'refs/heads/main',
        replayed: false,
      }),
    /published ref/u,
  );
});

test('managed Restore protocol accepts one bounded isolated materialization receipt', () => {
  const restored = {
    kind: 'accepted_snapshot_restored',
    restoreId: 'desktop-restore-123',
    destinationPath: 'C:\\maka\\restores\\desktop-restore-123\\workspace',
    acceptedCommitOid: 'd'.repeat(40),
    acceptedTreeOid: 'e'.repeat(40),
    filesMaterialized: 12,
    bytesMaterialized: 4096,
  } as const;

  assert.deepEqual(decodeManagedWorkspaceRestoreResult(restored), restored);
});

test('managed Restore protocol rejects unbounded materialization counters', () => {
  assert.throws(
    () =>
      decodeManagedWorkspaceRestoreResult({
        kind: 'accepted_snapshot_restored',
        restoreId: 'desktop-restore-123',
        destinationPath: '/tmp/restore',
        acceptedCommitOid: 'd'.repeat(40),
        acceptedTreeOid: 'e'.repeat(40),
        filesMaterialized: Number.MAX_SAFE_INTEGER + 1,
        bytesMaterialized: 4096,
      }),
    /restore result/u,
  );
});

test('managed History protocol accepts one contiguous newest-first lineage', () => {
  const result = {
    kind: 'accepted_history',
    headWorkspaceVersionId: `version_${'3'.repeat(32)}`,
    versions: [
      {
        workspaceVersionId: `version_${'3'.repeat(32)}`,
        parentWorkspaceVersionId: `version_${'2'.repeat(32)}`,
        commitOid: '3'.repeat(40),
        treeOid: '3'.repeat(40),
        acceptedEventId: 'accepted-3',
        committedAt: 3,
        kind: 'history_restore',
        changedFileCount: 1,
      },
      {
        workspaceVersionId: `version_${'2'.repeat(32)}`,
        parentWorkspaceVersionId: null,
        commitOid: '2'.repeat(40),
        treeOid: '2'.repeat(40),
        acceptedEventId: 'accepted-2',
        committedAt: 2,
        kind: 'baseline',
        changedFileCount: 1,
      },
    ],
    hasMore: false,
  } as const;
  assert.deepEqual(decodeManagedWorkspaceHistoryResult(result), result);
});

test('managed History protocol rejects a discontinuous lineage', () => {
  assert.throws(
    () =>
      decodeManagedWorkspaceHistoryResult({
        kind: 'accepted_history',
        headWorkspaceVersionId: `version_${'3'.repeat(32)}`,
        versions: [
          {
            workspaceVersionId: `version_${'3'.repeat(32)}`,
            parentWorkspaceVersionId: `version_${'1'.repeat(32)}`,
            commitOid: '3'.repeat(40),
            treeOid: '3'.repeat(40),
            acceptedEventId: 'accepted-3',
            committedAt: 3,
            kind: 'tool_mutation',
            changedFileCount: 1,
          },
          {
            workspaceVersionId: `version_${'2'.repeat(32)}`,
            parentWorkspaceVersionId: null,
            commitOid: '2'.repeat(40),
            treeOid: '2'.repeat(40),
            acceptedEventId: 'accepted-2',
            committedAt: 2,
            kind: 'baseline',
            changedFileCount: 1,
          },
        ],
        hasMore: false,
      }),
    /discontinuous/u,
  );
});
