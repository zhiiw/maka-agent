import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import type {
  ManagedWorkspaceExecutionHandle,
  ManagedWorkspaceOwner,
} from '@maka/storage/managed-workspace-owner';
import { createManagedWorkspaceMutationSession } from '../server/managed-workspace-mutation-session.js';

test('binds read and mutation operations to one owner-issued managed handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-mutation-session-'));
  const handle = Object.freeze({
    kind: 'managed_workspace_execution_handle_v1' as const,
  }) as ManagedWorkspaceExecutionHandle;
  const calls: string[] = [];
  const owner = {
    state: 'ready',
    async openManagedWorkspaceBaselineFromExecutionStores(_stores, input) {
      calls.push(`open:${input.sourceRoot}`);
      return {
        created: true,
        head: {
          repositoryId: input.repositoryId,
          workspaceId: input.workspaceId,
          workspaceEpochId: input.workspaceEpochId,
          workspaceVersionId: 'version_1',
          acceptedEventId: 'accepted_1',
          commitOid: 'a'.repeat(40),
          treeOid: 'b'.repeat(40),
          revision: 1,
        },
        executionHandle: handle,
      };
    },
    async withManagedWorkspaceExecution(seenHandle, operation) {
      assert.equal(seenHandle, handle);
      calls.push('read-scope');
      return await operation({ kind: 'managed_workspace_execution_scope_v1' });
    },
    async executeReadOnlyFilesystemOperation(_scope, operation) {
      calls.push(`read:${operation.kind}`);
      return { kind: 'read' as const, content: 'managed' };
    },
    async admitManagedWorkspaceMutation(seenHandle, input) {
      assert.equal(seenHandle, handle);
      calls.push(`admit:${input.toolName}`);
      return {
        durableDispatch: {} as never,
        async execute() {
          throw new Error('not used');
        },
        async dispose() {},
      };
    },
    async executeManagedMutationFilesystemOperation(operation) {
      calls.push(`mutation:${operation.kind}`);
      return {
        kind: 'write' as const,
        ok: true as const,
        path: operation.path,
        bytes: 7,
      };
    },
    async openManagedWorkspaceBaseline() {
      throw new Error('public raw store seam must not be used by Runtime Host');
    },
    async close() {},
  } satisfies ManagedWorkspaceOwner;
  try {
    const session = await createManagedWorkspaceMutationSession({
      owner,
      stores: {} as InteractiveExecutionStoresWriter,
      sourceRoot: root,
      sessionId: 'managed-session',
    });
    assert.equal(
      (
        await session.filesystemWorker.execute({
          operation: { kind: 'read', path: 'README.md' },
          cwd: 'caller-controlled-cwd',
        })
      ).kind,
      'read',
    );
    assert.equal(
      (
        await session.filesystemWorker.execute({
          operation: { kind: 'write', path: 'tracked.txt', content: 'managed' },
          cwd: 'caller-controlled-cwd',
        })
      ).kind,
      'write',
    );
    await session.admitManagedMutation({
      operationId: 'operation-managed-session',
      toolName: 'Write',
      persistedArgs: { path: 'tracked.txt', content: 'managed' },
      abortSignal: new AbortController().signal,
    });

    assert.deepEqual(calls.slice(1), ['read-scope', 'read:read', 'mutation:write', 'admit:Write']);
    assert.equal(calls[0], `open:${await realpath(root)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
