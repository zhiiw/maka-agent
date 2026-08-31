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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GitReviewReadResult } from '@maka/core/git-review';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import { registerRuntimeHostWorkspaceIpc } from '../runtime-host-workspace-ipc-main.js';

test('managed Review reads the accepted tree from Runtime Host', async () => {
  const expected: GitReviewReadResult = {
    ok: true,
    snapshot: {
      source: 'branch',
      repositoryRoot: 'maka-managed://session-managed',
      currentBranch: null,
      baseBranch: null,
      baseBranchOptions: [],
      revision: 'a'.repeat(64),
      files: [
        {
          path: 'src/example.ts',
          status: 'modified',
          diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
          additions: 1,
          deletions: 1,
        },
      ],
      additions: 1,
      deletions: 1,
      truncated: false,
    },
  };
  let managedReads = 0;
  const ipc = ipcHarness();
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    allowLocalWorkspace: false,
    client: {
      async getSession() {
        return sessionProjection('managed-coding-v1');
      },
      async readManagedWorkspaceReview(sessionId: string) {
        managedReads += 1;
        assert.equal(sessionId, 'session-managed');
        return expected;
      },
    } as never,
  });

  assert.deepEqual(
    await ipc.invoke('git-review:read', {
      sessionId: 'session-managed',
      source: 'branch',
    }),
    expected,
  );
  assert.equal(managedReads, 1);
});

test('managed coding v2 keeps Desktop Review on the accepted tree', async () => {
  const ipc = ipcHarness();
  let managedReads = 0;
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    allowLocalWorkspace: false,
    client: {
      async getSession() {
        return sessionProjection('managed-coding-v2');
      },
      async readManagedWorkspaceReview() {
        managedReads += 1;
        return { ok: false, reason: 'not_a_repository' };
      },
    } as never,
  });

  assert.deepEqual(
    await ipc.invoke('git-review:read', {
      sessionId: 'session-managed',
      source: 'branch',
    }),
    { ok: false, reason: 'not_a_repository' },
  );
  assert.equal(managedReads, 1);
});

test('ordinary Review keeps reading the attached checkout', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-review-ordinary-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let managedReads = 0;
  const ipc = ipcHarness();
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    client: {
      async getSession() {
        return sessionProjection(undefined, workspace);
      },
      async readManagedWorkspaceReview() {
        managedReads += 1;
        throw new Error('not used');
      },
      async publishManagedWorkspaceSourceBranch() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSnapshot() {
        throw new Error('not used');
      },
      async maintainManagedWorkspace() {
        throw new Error('not used');
      },
      async restoreManagedWorkspaceSnapshot() {
        throw new Error('not used');
      },
      async readManagedWorkspaceHistory() {
        throw new Error('not used');
      },
      async restoreManagedWorkspaceVersion() {
        throw new Error('not used');
      },
      async undoManagedWorkspaceVersion() {
        throw new Error('not used');
      },
      async rebaselineManagedWorkspace() {
        throw new Error('not used');
      },
    },
  });

  assert.deepEqual(
    await ipc.invoke('git-review:read', {
      sessionId: 'session-managed',
      source: 'branch',
    }),
    { ok: false, reason: 'not_git_repository' },
  );
  assert.equal(managedReads, 0);
});

test('managed Review fails closed instead of reading the attached checkout', async () => {
  const ipc = ipcHarness();
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    client: {
      async getSession() {
        return sessionProjection('managed-coding-v1');
      },
      async readManagedWorkspaceReview() {
        throw new Error('accepted review unavailable');
      },
      async publishManagedWorkspaceSourceBranch() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSnapshot() {
        throw new Error('not used');
      },
      async maintainManagedWorkspace() {
        throw new Error('not used');
      },
      async restoreManagedWorkspaceSnapshot() {
        throw new Error('not used');
      },
      async readManagedWorkspaceHistory() {
        throw new Error('not used');
      },
      async restoreManagedWorkspaceVersion() {
        throw new Error('not used');
      },
      async undoManagedWorkspaceVersion() {
        throw new Error('not used');
      },
      async rebaselineManagedWorkspace() {
        throw new Error('not used');
      },
    },
  });

  await assert.rejects(
    ipc.invoke('git-review:read', {
      sessionId: 'session-managed',
      source: 'branch',
    }),
    /accepted review unavailable/u,
  );
});

test('managed workspace Publish delegates one immutable accepted snapshot to Runtime Host', async () => {
  const ipc = ipcHarness();
  let publishCalls = 0;
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    client: {
      async getSession() {
        return sessionProjection('managed-coding-v1');
      },
      async readManagedWorkspaceReview() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSourceBranch() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSnapshot(sessionId: string, publishId: string) {
        publishCalls += 1;
        assert.equal(sessionId, 'session-managed');
        assert.equal(publishId, 'desktop-123');
        return {
          kind: 'accepted_snapshot_published' as const,
          publishId,
          acceptedCommitOid: 'b'.repeat(40),
          acceptedTreeOid: 'c'.repeat(40),
          publishedRef: `refs/maka/published/${publishId}`,
          replayed: false,
        };
      },
    } as never,
  });

  assert.deepEqual(
    await ipc.invoke('managed-workspace:publish', {
      sessionId: 'session-managed',
      publishId: 'desktop-123',
    }),
    {
      kind: 'accepted_snapshot_published',
      publishId: 'desktop-123',
      acceptedCommitOid: 'b'.repeat(40),
      acceptedTreeOid: 'c'.repeat(40),
      publishedRef: 'refs/maka/published/desktop-123',
      replayed: false,
    },
  );
  assert.equal(publishCalls, 1);
});

test('managed workspace source branch Publish delegates one exact branch request', async () => {
  const ipc = ipcHarness();
  let publishCalls = 0;
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    client: {
      async getSession() {
        return sessionProjection('managed-coding-v1');
      },
      async readManagedWorkspaceReview() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSourceBranch(sessionId: string, publishId: string) {
        publishCalls += 1;
        assert.equal(sessionId, 'session-managed');
        assert.equal(publishId, 'desktop-branch-123');
        return {
          kind: 'accepted_source_branch_published' as const,
          publishId,
          sourceBaseCommitOid: 'a'.repeat(40),
          sourceBaseTreeOid: 'b'.repeat(40),
          acceptedCommitOid: 'c'.repeat(40),
          acceptedTreeOid: 'd'.repeat(40),
          publishedCommitOid: 'e'.repeat(40),
          publishedRef: `refs/heads/maka/${publishId}`,
          replayed: false,
        };
      },
      async publishManagedWorkspaceSnapshot() {
        throw new Error('not used');
      },
    } as never,
  });

  assert.deepEqual(
    await ipc.invoke('managed-workspace:publish-source-branch', {
      sessionId: 'session-managed',
      publishId: 'desktop-branch-123',
    }),
    {
      kind: 'accepted_source_branch_published',
      publishId: 'desktop-branch-123',
      sourceBaseCommitOid: 'a'.repeat(40),
      sourceBaseTreeOid: 'b'.repeat(40),
      acceptedCommitOid: 'c'.repeat(40),
      acceptedTreeOid: 'd'.repeat(40),
      publishedCommitOid: 'e'.repeat(40),
      publishedRef: 'refs/heads/maka/desktop-branch-123',
      replayed: false,
    },
  );
  assert.equal(publishCalls, 1);
});

test('ordinary workspace cannot enter managed immutable Publish', async () => {
  const ipc = ipcHarness();
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    client: {
      async getSession() {
        return sessionProjection(undefined);
      },
      async readManagedWorkspaceReview() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSourceBranch() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSnapshot() {
        throw new Error('must not publish');
      },
    } as never,
  });

  await assert.rejects(
    ipc.invoke('managed-workspace:publish', {
      sessionId: 'session-managed',
      publishId: 'desktop-123',
    }),
    /does not own a managed workspace/u,
  );
});

test('managed workspace Restore delegates one isolated accepted snapshot to Runtime Host', async () => {
  const ipc = ipcHarness();
  let restoreCalls = 0;
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    client: {
      async getSession() {
        return sessionProjection('managed-coding-v1');
      },
      async readManagedWorkspaceReview() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSourceBranch() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSnapshot() {
        throw new Error('not used');
      },
      async maintainManagedWorkspace() {
        throw new Error('not used');
      },
      async restoreManagedWorkspaceSnapshot(sessionId, restoreId) {
        restoreCalls += 1;
        assert.equal(sessionId, 'session-1');
        assert.equal(restoreId, 'desktop-restore-123');
        return {
          kind: 'accepted_snapshot_restored' as const,
          restoreId,
          destinationPath: 'C:\\maka\\restores\\desktop-restore-123\\workspace',
          acceptedCommitOid: 'd'.repeat(40),
          acceptedTreeOid: 'e'.repeat(40),
          filesMaterialized: 12,
          bytesMaterialized: 4096,
        };
      },
      async readManagedWorkspaceHistory() {
        throw new Error('not used');
      },
      async restoreManagedWorkspaceVersion() {
        throw new Error('not used');
      },
      async undoManagedWorkspaceVersion() {
        throw new Error('not used');
      },
      async rebaselineManagedWorkspace() {
        throw new Error('not used');
      },
    },
  });

  const result = await ipc.invoke('managed-workspace:restore', {
    sessionId: 'session-1',
    restoreId: 'desktop-restore-123',
  });
  assert.deepEqual(result, {
    kind: 'accepted_snapshot_restored',
    restoreId: 'desktop-restore-123',
    destinationPath: 'C:\\maka\\restores\\desktop-restore-123\\workspace',
    acceptedCommitOid: 'd'.repeat(40),
    acceptedTreeOid: 'e'.repeat(40),
    filesMaterialized: 12,
    bytesMaterialized: 4096,
  });
  assert.equal(restoreCalls, 1);
});

test('ordinary workspace cannot enter managed isolated Restore', async () => {
  const ipc = ipcHarness();
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    client: {
      async getSession() {
        return sessionProjection(undefined);
      },
      async readManagedWorkspaceReview() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSourceBranch() {
        throw new Error('not used');
      },
      async publishManagedWorkspaceSnapshot() {
        throw new Error('not used');
      },
      async maintainManagedWorkspace() {
        throw new Error('not used');
      },
      async restoreManagedWorkspaceSnapshot() {
        throw new Error('must not restore an ordinary workspace');
      },
      async readManagedWorkspaceHistory() {
        throw new Error('not used');
      },
      async restoreManagedWorkspaceVersion() {
        throw new Error('not used');
      },
      async undoManagedWorkspaceVersion() {
        throw new Error('not used');
      },
      async rebaselineManagedWorkspace() {
        throw new Error('not used');
      },
    },
  });

  await assert.rejects(
    ipc.invoke('managed-workspace:restore', {
      sessionId: 'session-1',
      restoreId: 'desktop-restore-123',
    }),
    /does not own a managed workspace/u,
  );
});

test('managed workspace maintenance delegates one bounded quiet cleanup', async () => {
  const ipc = ipcHarness();
  let calls = 0;
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    client: {
      async getSession() {
        return sessionProjection('managed-coding-v1');
      },
      async maintainManagedWorkspace(sessionId: string) {
        calls += 1;
        assert.equal(sessionId, 'session-managed');
        return {
          kind: 'managed_workspace_maintenance_completed' as const,
          scope: 'managed_artifacts_v2' as const,
          collected: 2,
          retained: 1,
        };
      },
    } as never,
  });

  assert.deepEqual(
    await ipc.invoke('managed-workspace:maintain', { sessionId: 'session-managed' }),
    {
      kind: 'managed_workspace_maintenance_completed',
      scope: 'managed_artifacts_v2',
      collected: 2,
      retained: 1,
    },
  );
  assert.equal(calls, 1);
});

test('managed workspace lifecycle commands stay bound to the same session', async () => {
  const ipc = ipcHarness();
  const workspaceVersionId = `version_${'1'.repeat(32)}`;
  registerRuntimeHostWorkspaceIpc({
    ipcMain: ipc as never,
    client: {
      async getSession() {
        return sessionProjection('managed-coding-v1');
      },
      async readManagedWorkspaceHistory(sessionId: string, limit: number) {
        assert.equal(sessionId, 'session-managed');
        assert.equal(limit, 50);
        return {
          kind: 'accepted_history' as const,
          headWorkspaceVersionId: workspaceVersionId,
          versions: [
            {
              workspaceVersionId,
              parentWorkspaceVersionId: null,
              commitOid: '1'.repeat(40),
              treeOid: '1'.repeat(40),
              acceptedEventId: 'accepted-1',
              committedAt: 1,
              kind: 'baseline' as const,
              changedFileCount: 1,
            },
          ],
          hasMore: false,
        };
      },
      async restoreManagedWorkspaceVersion(
        sessionId: string,
        selectedVersionId: string,
        restoreId: string,
      ) {
        assert.equal(sessionId, 'session-managed');
        assert.equal(selectedVersionId, workspaceVersionId);
        assert.equal(restoreId, 'desktop-history-1');
        return {
          kind: 'accepted_snapshot_restored' as const,
          workspaceVersionId: selectedVersionId,
          restoreId,
          destinationPath: 'C:\\maka\\restores\\history-desktop-history-1\\workspace',
          acceptedCommitOid: '1'.repeat(40),
          acceptedTreeOid: '1'.repeat(40),
          filesMaterialized: 1,
          bytesMaterialized: 12,
        };
      },
      async undoManagedWorkspaceVersion(
        sessionId: string,
        selectedVersionId: string,
        restoreId: string,
      ) {
        assert.equal(sessionId, 'session-managed');
        assert.equal(selectedVersionId, workspaceVersionId);
        assert.equal(restoreId, 'desktop-undo-1');
        return {
          kind: 'accepted_history_successor' as const,
          restoreId,
          targetWorkspaceVersionId: selectedVersionId,
          workspaceVersionId: `version_${'2'.repeat(32)}`,
          acceptedCommitOid: '2'.repeat(40),
          acceptedTreeOid: '1'.repeat(40),
          revision: 2,
          created: true,
        };
      },
      async rebaselineManagedWorkspace(sessionId: string, rebaselineId: string) {
        assert.equal(sessionId, 'session-managed');
        assert.equal(rebaselineId, 'desktop-rebaseline-1');
        return {
          kind: 'managed_workspace_rebaselined' as const,
          rebaselineId,
          workspaceId: `workspace_${'1'.repeat(32)}`,
          workspaceEpochId: `epoch_${'2'.repeat(32)}`,
          baselineWorkspaceVersionId: `version_${'2'.repeat(32)}`,
          sourceKind: 'git_repository_v1' as const,
        };
      },
    } as never,
  });

  const history = await ipc.invoke('managed-workspace:history', {
    sessionId: 'session-managed',
    limit: 50,
  });
  assert.equal((history as { headWorkspaceVersionId: string }).headWorkspaceVersionId, workspaceVersionId);
  const restored = await ipc.invoke('managed-workspace:restore-version', {
    sessionId: 'session-managed',
    workspaceVersionId,
    restoreId: 'desktop-history-1',
  });
  assert.equal((restored as { workspaceVersionId: string }).workspaceVersionId, workspaceVersionId);
  const undone = await ipc.invoke('managed-workspace:undo-version', {
    sessionId: 'session-managed',
    workspaceVersionId,
    restoreId: 'desktop-undo-1',
  });
  assert.equal((undone as { targetWorkspaceVersionId: string }).targetWorkspaceVersionId, workspaceVersionId);
  const rebased = await ipc.invoke('managed-workspace:rebaseline', {
    sessionId: 'session-managed',
    rebaselineId: 'desktop-rebaseline-1',
  });
  assert.equal((rebased as { rebaselineId: string }).rebaselineId, 'desktop-rebaseline-1');
});

function sessionProjection(
  toolProfile?: 'managed-coding-v1' | 'managed-coding-v2',
  hostCwd = process.cwd(),
): SessionCatalogProjection {
  return {
    id: 'session-managed',
    revision: 1,
    workspace: { hostCwd },
    createdAt: 1,
    activityAt: 1,
    name: 'Managed task',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'idle',
    backend: 'sdk',
    llmConnectionId: null,
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'model',
    permissionMode: 'default',
    collaborationMode: 'default',
    orchestrationMode: 'default',
    ...(toolProfile ? { toolProfile } : {}),
  } as unknown as SessionCatalogProjection;
}

type IpcHandler = (...args: unknown[]) => unknown;

function ipcHarness() {
  const handlers = new Map<string, IpcHandler>();
  return {
    handle(channel: string, handler: IpcHandler) {
      handlers.set(channel, handler);
    },
    handleReconnectableRead(channel: string, handler: IpcHandler) {
      handlers.set(channel, handler);
    },
    async invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing handler: ${channel}`);
      return handler({}, ...args);
    },
  };
}
