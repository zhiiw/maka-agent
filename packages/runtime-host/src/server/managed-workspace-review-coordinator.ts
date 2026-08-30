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

import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import { isManagedCodingSessionToolProfile } from '@maka/core/session';
import { isSessionNotFoundError } from '@maka/storage/execution-stores';
import type { StorageRootLease } from '@maka/storage/root-authority';
import type {
  ManagedWorkspacePublishInput,
  ManagedWorkspaceMaintenanceInput,
  ManagedWorkspaceSourceBranchPublishInput,
  ManagedWorkspaceHistoricalRestoreInput,
  ManagedWorkspaceHistoryInput,
  ManagedWorkspaceHistoryUndoInput,
  ManagedWorkspaceReviewQueryInput,
  ManagedWorkspaceRebaselineInput,
  ManagedWorkspaceRestoreInput,
  OperationOutcome,
} from '../protocol/index.js';
import type { ManagedWorkspaceReviewOperationHandlerMap } from './operation-dispatcher.js';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import { openGitoxideManagedSessionOwnerInternal } from './gitoxide-managed-session-owner-internal.js';

export class HostManagedWorkspaceReviewCoordinator {
  readonly handlers: ManagedWorkspaceReviewOperationHandlerMap = {
    'managed-workspace.review.query': (input) => this.#query(input),
    'managed-workspace.publish.mutate': (input) => this.#publish(input),
    'managed-workspace.source-branch.publish.mutate': (input) => this.#publishSourceBranch(input),
    'managed-workspace.restore.mutate': (input) => this.#restore(input),
    'managed-workspace.history.query': (input) => this.#history(input),
    'managed-workspace.history.restore.mutate': (input) => this.#restoreHistory(input),
    'managed-workspace.history.undo.mutate': (input) => this.#undoHistory(input),
    'managed-workspace.rebaseline.mutate': (input) => this.#rebaseline(input),
    'managed-workspace.maintenance.mutate': (input) => this.#maintain(input),
  };

  constructor(
    private readonly input: {
      readonly storageRootLease: StorageRootLease<'interactive', 'write'>;
      readonly stores: InteractiveExecutionStoresWriter;
      readonly invocationOwnerToken: object;
      readonly helperCapability?: GitoxideHelperInvocationCapability;
    },
  ) {}

  async #query(
    input: ManagedWorkspaceReviewQueryInput,
  ): Promise<OperationOutcome<'managed-workspace.review.query'>> {
    if (!this.input.helperCapability) {
      return failure('operation_unavailable', 'Managed workspace Review is unavailable');
    }
    try {
      const header = await this.input.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      if (!isManagedCodingSessionToolProfile(header.toolProfile)) {
        return failure('invalid_request', 'Session does not own a managed workspace');
      }
      const session = await openGitoxideManagedSessionOwnerInternal({
        storageRootLease: this.input.storageRootLease,
        stores: this.input.stores,
        invocationOwnerToken: this.input.invocationOwnerToken,
        helperCapability: this.input.helperCapability,
        sourceRoot: header.cwd,
        sessionId: input.sessionId,
      });
      return {
        ok: true,
        result: {
          kind: 'accepted_review',
          sourceKind: session.sourceKind,
          snapshot: await session.review.read(input.sessionId),
        },
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return failure('not_found', 'Session was not found');
      }
      return failure('persistence_failed', 'Managed workspace Review is unavailable');
    }
  }

  async #publish(
    input: ManagedWorkspacePublishInput,
  ): Promise<OperationOutcome<'managed-workspace.publish.mutate'>> {
    if (!this.input.helperCapability) {
      return failure('operation_unavailable', 'Managed workspace Publish is unavailable');
    }
    try {
      const header = await this.input.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      if (!isManagedCodingSessionToolProfile(header.toolProfile)) {
        return failure('invalid_request', 'Session does not own a managed workspace');
      }
      const session = await openGitoxideManagedSessionOwnerInternal({
        storageRootLease: this.input.storageRootLease,
        stores: this.input.stores,
        invocationOwnerToken: this.input.invocationOwnerToken,
        helperCapability: this.input.helperCapability,
        sourceRoot: header.cwd,
        sessionId: input.sessionId,
      });
      const published = await session.publish.publish(input.publishId);
      return {
        ok: true,
        result: {
          kind: 'accepted_snapshot_published',
          publishId: input.publishId,
          acceptedCommitOid: published.acceptedCommitOid,
          acceptedTreeOid: published.acceptedTreeOid,
          publishedRef: published.publishedRef,
          replayed: published.replayed,
        },
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return failure('not_found', 'Session was not found');
      }
      return failure('persistence_failed', 'Managed workspace Publish is unavailable');
    }
  }

  async #publishSourceBranch(
    input: ManagedWorkspaceSourceBranchPublishInput,
  ): Promise<OperationOutcome<'managed-workspace.source-branch.publish.mutate'>> {
    if (!this.input.helperCapability) {
      return failure(
        'operation_unavailable',
        'Managed workspace source branch Publish is unavailable',
      );
    }
    try {
      const header = await this.input.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      if (!isManagedCodingSessionToolProfile(header.toolProfile)) {
        return failure('invalid_request', 'Session does not own a managed workspace');
      }
      const session = await openGitoxideManagedSessionOwnerInternal({
        storageRootLease: this.input.storageRootLease,
        stores: this.input.stores,
        invocationOwnerToken: this.input.invocationOwnerToken,
        helperCapability: this.input.helperCapability,
        sourceRoot: header.cwd,
        sessionId: input.sessionId,
      });
      if (!session.sourceBranchPublish) {
        return failure(
          'operation_unavailable',
          'Source branch publication is available only for Git-backed managed workspaces',
        );
      }
      const published = await session.sourceBranchPublish.publish(input.publishId);
      return {
        ok: true,
        result: {
          kind: 'accepted_source_branch_published',
          publishId: input.publishId,
          sourceBaseCommitOid: published.sourceBaseCommitOid,
          sourceBaseTreeOid: published.sourceBaseTreeOid,
          acceptedCommitOid: published.acceptedCommitOid,
          acceptedTreeOid: published.acceptedTreeOid,
          publishedCommitOid: published.publishedCommitOid,
          publishedRef: published.publishedRef,
          replayed: published.replayed,
        },
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return failure('not_found', 'Session was not found');
      }
      return failure(
        'persistence_failed',
        'Managed workspace source branch Publish is unavailable',
      );
    }
  }

  async #restore(
    input: ManagedWorkspaceRestoreInput,
  ): Promise<OperationOutcome<'managed-workspace.restore.mutate'>> {
    if (!this.input.helperCapability) {
      return failure('operation_unavailable', 'Managed workspace Restore is unavailable');
    }
    try {
      const header = await this.input.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      if (!isManagedCodingSessionToolProfile(header.toolProfile)) {
        return failure('invalid_request', 'Session does not own a managed workspace');
      }
      const session = await openGitoxideManagedSessionOwnerInternal({
        storageRootLease: this.input.storageRootLease,
        stores: this.input.stores,
        invocationOwnerToken: this.input.invocationOwnerToken,
        helperCapability: this.input.helperCapability,
        sourceRoot: header.cwd,
        sessionId: input.sessionId,
      });
      const restored = await session.restore.restore(input.restoreId);
      return {
        ok: true,
        result: {
          kind: 'accepted_snapshot_restored',
          restoreId: input.restoreId,
          destinationPath: restored.destinationPath,
          acceptedCommitOid: restored.acceptedCommitOid,
          acceptedTreeOid: restored.acceptedTreeOid,
          filesMaterialized: restored.filesMaterialized,
          bytesMaterialized: restored.bytesMaterialized,
        },
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return failure('not_found', 'Session was not found');
      }
      return failure('persistence_failed', 'Managed workspace Restore is unavailable');
    }
  }

  async #maintain(
    input: ManagedWorkspaceMaintenanceInput,
  ): Promise<OperationOutcome<'managed-workspace.maintenance.mutate'>> {
    if (!this.input.helperCapability) {
      return failure('operation_unavailable', 'Managed workspace maintenance is unavailable');
    }
    try {
      const header = await this.input.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      if (!isManagedCodingSessionToolProfile(header.toolProfile)) {
        return failure('invalid_request', 'Session does not own a managed workspace');
      }
      const session = await openGitoxideManagedSessionOwnerInternal({
        storageRootLease: this.input.storageRootLease,
        stores: this.input.stores,
        invocationOwnerToken: this.input.invocationOwnerToken,
        helperCapability: this.input.helperCapability,
        sourceRoot: header.cwd,
        sessionId: input.sessionId,
      });
      const collected = await session.gc.collectRestoreOrphans({
        olderThanMs: 24 * 60 * 60 * 1_000,
        maxEntries: 32,
      });
      return {
        ok: true,
        result: {
          kind: 'managed_workspace_maintenance_completed',
          scope: 'restore_orphans_v1',
          collected: collected.collected,
          retained: collected.retained,
        },
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return failure('not_found', 'Session was not found');
      }
      return failure('persistence_failed', 'Managed workspace maintenance is unavailable');
    }
  }

  async #history(
    input: ManagedWorkspaceHistoryInput,
  ): Promise<OperationOutcome<'managed-workspace.history.query'>> {
    if (!this.input.helperCapability) {
      return failure('operation_unavailable', 'Managed workspace History is unavailable');
    }
    try {
      const header = await this.input.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      if (!isManagedCodingSessionToolProfile(header.toolProfile)) {
        return failure('invalid_request', 'Session does not own a managed workspace');
      }
      const session = await openGitoxideManagedSessionOwnerInternal({
        storageRootLease: this.input.storageRootLease,
        stores: this.input.stores,
        invocationOwnerToken: this.input.invocationOwnerToken,
        helperCapability: this.input.helperCapability,
        sourceRoot: header.cwd,
        sessionId: input.sessionId,
      });
      const history = await session.history.list(input.limit);
      return { ok: true, result: { kind: 'accepted_history', ...history } };
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return failure('not_found', 'Session was not found');
      }
      return failure('persistence_failed', 'Managed workspace History is unavailable');
    }
  }

  async #restoreHistory(
    input: ManagedWorkspaceHistoricalRestoreInput,
  ): Promise<OperationOutcome<'managed-workspace.history.restore.mutate'>> {
    if (!this.input.helperCapability) {
      return failure(
        'operation_unavailable',
        'Managed workspace historical Restore is unavailable',
      );
    }
    try {
      const header = await this.input.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      if (!isManagedCodingSessionToolProfile(header.toolProfile)) {
        return failure('invalid_request', 'Session does not own a managed workspace');
      }
      const session = await openGitoxideManagedSessionOwnerInternal({
        storageRootLease: this.input.storageRootLease,
        stores: this.input.stores,
        invocationOwnerToken: this.input.invocationOwnerToken,
        helperCapability: this.input.helperCapability,
        sourceRoot: header.cwd,
        sessionId: input.sessionId,
      });
      const restored = await session.timeTravel.restoreVersion(
        input.workspaceVersionId,
        input.restoreId,
      );
      return {
        ok: true,
        result: {
          kind: 'accepted_snapshot_restored',
          restoreId: input.restoreId,
          workspaceVersionId: input.workspaceVersionId,
          destinationPath: restored.destinationPath,
          acceptedCommitOid: restored.acceptedCommitOid,
          acceptedTreeOid: restored.acceptedTreeOid,
          filesMaterialized: restored.filesMaterialized,
          bytesMaterialized: restored.bytesMaterialized,
        },
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return failure('not_found', 'Session was not found');
      }
      return failure('persistence_failed', 'Managed workspace historical Restore is unavailable');
    }
  }

  async #undoHistory(
    input: ManagedWorkspaceHistoryUndoInput,
  ): Promise<OperationOutcome<'managed-workspace.history.undo.mutate'>> {
    if (!this.input.helperCapability) {
      return failure('operation_unavailable', 'Managed workspace Undo is unavailable');
    }
    try {
      const header = await this.input.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      if (!isManagedCodingSessionToolProfile(header.toolProfile)) {
        return failure('invalid_request', 'Session does not own a managed workspace');
      }
      const session = await openGitoxideManagedSessionOwnerInternal({
        storageRootLease: this.input.storageRootLease,
        stores: this.input.stores,
        invocationOwnerToken: this.input.invocationOwnerToken,
        helperCapability: this.input.helperCapability,
        sourceRoot: header.cwd,
        sessionId: input.sessionId,
      });
      const restored = await session.historySuccessor.restore({
        restoreId: input.restoreId,
        targetWorkspaceVersionId: input.workspaceVersionId,
      });
      return {
        ok: true,
        result: {
          kind: 'accepted_history_successor',
          restoreId: input.restoreId,
          targetWorkspaceVersionId: input.workspaceVersionId,
          workspaceVersionId: restored.head.workspaceVersionId,
          acceptedCommitOid: restored.head.commitOid,
          acceptedTreeOid: restored.head.treeOid,
          revision: restored.head.revision,
          created: restored.created,
        },
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return failure('not_found', 'Session was not found');
      }
      return failure('persistence_failed', 'Managed workspace Undo is unavailable');
    }
  }

  async #rebaseline(
    input: ManagedWorkspaceRebaselineInput,
  ): Promise<OperationOutcome<'managed-workspace.rebaseline.mutate'>> {
    if (!this.input.helperCapability) {
      return failure('operation_unavailable', 'Managed workspace Rebaseline is unavailable');
    }
    try {
      const header = await this.input.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      if (!isManagedCodingSessionToolProfile(header.toolProfile)) {
        return failure('invalid_request', 'Session does not own a managed workspace');
      }
      const session = await openGitoxideManagedSessionOwnerInternal({
        storageRootLease: this.input.storageRootLease,
        stores: this.input.stores,
        invocationOwnerToken: this.input.invocationOwnerToken,
        helperCapability: this.input.helperCapability,
        sourceRoot: header.cwd,
        sessionId: input.sessionId,
      });
      const rebased = await session.rebaseline(input.rebaselineId);
      return {
        ok: true,
        result: {
          kind: 'managed_workspace_rebaselined',
          rebaselineId: input.rebaselineId,
          workspaceId: rebased.workspaceId,
          workspaceEpochId: rebased.workspaceEpochId,
          baselineWorkspaceVersionId: rebased.baselineWorkspaceVersionId,
          sourceKind: rebased.sourceKind,
        },
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return failure('not_found', 'Session was not found');
      }
      return failure('persistence_failed', 'Managed workspace Rebaseline is unavailable');
    }
  }
}

function failure<
  C extends 'operation_unavailable' | 'not_found' | 'invalid_request' | 'persistence_failed',
>(
  code: C,
  message: string,
): { readonly ok: false; readonly error: { readonly code: C; readonly message: string } } {
  return { ok: false, error: { code, message } };
}
