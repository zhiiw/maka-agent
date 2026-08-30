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
import type {
  WorkspaceHeadRecordV1,
  WorkspaceHistorySuccessorAuthorityInput,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  issueExecutionStoresWorkspaceHistoryAuthorityInternal,
  requireExecutionStoresWorkspaceHistoryAuthorityInternal,
} from '@maka/storage/execution-stores-workspace-authority-internal';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import {
  createHistoryCandidateWithGitoxideHelperInternal,
  promoteHistoryCandidateWithGitoxideHelperInternal,
  type GitoxideHistoryCandidatePublishedV1,
} from './gitoxide-helper-invocation-internal.js';
import { reopenGitoxideAcceptedRepositoryInternal } from './gitoxide-repository-admission-authority-internal.js';

const ACCEPTED_REF = 'refs/maka/accepted';
const RESTORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
export const GITOXIDE_HISTORY_RESTORE_EXECUTION_PROFILE_DIGEST =
  `sha256:${createHash('sha256').update('maka.gitoxide.history-restore-execution-profile.v1').digest('hex')}` as const;

export interface GitoxideManagedHistorySuccessorOwnerInternal {
  restore(input: GitoxideManagedHistoryRestoreInputInternal): Promise<
    Readonly<{
      created: boolean;
      head: WorkspaceHeadRecordV1;
      projection: 'already_current' | 'promoted';
    }>
  >;
}

export interface GitoxideManagedHistoryRestoreInputInternal {
  readonly restoreId: string;
  readonly targetWorkspaceVersionId: string;
  readonly abortSignal?: AbortSignal;
}

export type GitoxideManagedHistorySuccessorFailpoint = 'after_history_successor_commit';

export function createGitoxideManagedHistorySuccessorOwnerInternal(input: {
  readonly stores: InteractiveExecutionStoresWriter;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly failpoint?: (point: GitoxideManagedHistorySuccessorFailpoint) => void | Promise<void>;
}): GitoxideManagedHistorySuccessorOwnerInternal {
  const ownerToken = {};
  const issuedCandidates = new WeakMap<object, WorkspaceHistorySuccessorAuthorityInput>();
  const capability = issueExecutionStoresWorkspaceHistoryAuthorityInternal({
    ownerToken,
    stores: input.stores,
    verifyCandidate(candidateOutcome) {
      const successor = issuedCandidates.get(candidateOutcome);
      if (!successor) throw new Error('Managed history candidate proof is invalid');
      return successor;
    },
  });
  const persistence = requireExecutionStoresWorkspaceHistoryAuthorityInternal(
    ownerToken,
    capability,
  );

  return Object.freeze({
    async restore(request: GitoxideManagedHistoryRestoreInputInternal) {
      if (!RESTORE_ID_PATTERN.test(request.restoreId)) {
        throw new Error('Managed history restore identity is invalid');
      }
      request.abortSignal?.throwIfAborted();
      const head = await persistence.readHead(input.workspaceId, input.workspaceEpochId);
      if (!head || !matchesWorkspace(input, head)) {
        throw new Error('Managed history restore head is unavailable');
      }
      const current = await persistence.readVersion(head.workspaceVersionId);
      const target = await persistence.readVersion(request.targetWorkspaceVersionId);
      if (
        !current ||
        !target ||
        !matchesWorkspace(input, current) ||
        !matchesWorkspace(input, target) ||
        current.commitOid !== head.commitOid ||
        current.treeOid !== head.treeOid ||
        target.policyHash !== current.policyHash
      ) {
        throw new Error('Managed history restore target is unavailable');
      }

      if (
        current.protocol === 'workspace_history_version_accepted_v1' &&
        current.origin.kind === 'history_restore' &&
        current.origin.restoreId === request.restoreId &&
        current.origin.targetWorkspaceVersionId === target.workspaceVersionId
      ) {
        const parent = await persistence.readVersion(current.parents[0]);
        if (!parent || !matchesWorkspace(input, parent)) {
          throw new Error('Managed history restore parent is unavailable');
        }
        const candidateRef = historyCandidateRef(
          request.restoreId,
          parent.workspaceVersionId,
          target.workspaceVersionId,
        );
        const requestDigestSha256 = historyCandidateRequestDigest({
          acceptedRef: ACCEPTED_REF,
          baseCommitOid: parent.commitOid,
          baseTreeOid: parent.treeOid,
          targetCommitOid: target.commitOid,
          targetTreeOid: target.treeOid,
          candidateRef,
          restoreId: request.restoreId,
        });
        const promoted = await promoteHistoryCandidateWithGitoxideHelperInternal({
          invocationOwnerToken: input.invocationOwnerToken,
          capability: input.helperCapability,
          repositoryPath: input.repositoryPath,
          acceptedRef: ACCEPTED_REF,
          expectedBaseCommitOid: parent.commitOid,
          expectedBaseTreeOid: parent.treeOid,
          candidateRef,
          expectedCandidateCommitOid: current.commitOid,
          expectedCandidateTreeOid: current.treeOid,
          targetCommitOid: target.commitOid,
          targetTreeOid: target.treeOid,
          requestDigestSha256,
          restoreId: request.restoreId,
          managedTreePolicyVersion: 3,
          ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        });
        return Object.freeze({
          created: false,
          head,
          projection: promoted.replayed ? ('already_current' as const) : ('promoted' as const),
        });
      }

      const acceptedRepositoryOwnerToken = {};
      await reopenGitoxideAcceptedRepositoryInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        helperCapability: input.helperCapability,
        acceptedRepositoryOwnerToken,
        repositoryPath: input.repositoryPath,
        acceptedRef: ACCEPTED_REF,
        expectedAcceptedCommitOid: head.commitOid,
        expectedAcceptedTreeOid: head.treeOid,
        managedTreePolicyVersion: 3,
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      });

      const candidateRef = historyCandidateRef(
        request.restoreId,
        head.workspaceVersionId,
        target.workspaceVersionId,
      );
      const candidate = await createHistoryCandidateWithGitoxideHelperInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        capability: input.helperCapability,
        repositoryPath: input.repositoryPath,
        acceptedRef: ACCEPTED_REF,
        expectedBaseCommitOid: head.commitOid,
        expectedBaseTreeOid: head.treeOid,
        targetCommitOid: target.commitOid,
        targetTreeOid: target.treeOid,
        candidateRef,
        restoreId: request.restoreId,
        managedTreePolicyVersion: 3,
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      });
      const successor = buildHistorySuccessor({
        restoreId: request.restoreId,
        head,
        current,
        target,
        candidate,
      });
      issuedCandidates.set(candidate, successor);
      const committed = await persistence.commitHistorySuccessor(candidate);
      await input.failpoint?.('after_history_successor_commit');
      request.abortSignal?.throwIfAborted();
      const promoted = await promoteHistoryCandidateWithGitoxideHelperInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        capability: input.helperCapability,
        repositoryPath: input.repositoryPath,
        acceptedRef: ACCEPTED_REF,
        expectedBaseCommitOid: head.commitOid,
        expectedBaseTreeOid: head.treeOid,
        candidateRef,
        expectedCandidateCommitOid: candidate.candidateCommitOid,
        expectedCandidateTreeOid: candidate.candidateTreeOid,
        targetCommitOid: target.commitOid,
        targetTreeOid: target.treeOid,
        requestDigestSha256: candidate.requestDigestSha256,
        restoreId: request.restoreId,
        managedTreePolicyVersion: 3,
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      });
      if (
        promoted.acceptedCommitOid !== committed.committedSuccessor.commitOid ||
        promoted.acceptedTreeOid !== committed.committedSuccessor.treeOid
      ) {
        throw new Error('Managed history projection conflicts with its accepted successor');
      }
      return Object.freeze({
        created: committed.created,
        head: committed.committedSuccessor,
        projection: promoted.replayed ? ('already_current' as const) : ('promoted' as const),
      });
    },
  });
}

function buildHistorySuccessor(input: {
  readonly restoreId: string;
  readonly head: WorkspaceHeadRecordV1;
  readonly current: WorkspaceVersionRecordV1;
  readonly target: WorkspaceVersionRecordV1;
  readonly candidate: GitoxideHistoryCandidatePublishedV1;
}): WorkspaceHistorySuccessorAuthorityInput {
  const identity = digest(
    'history-successor',
    input.restoreId,
    input.head.workspaceVersionId,
    input.target.workspaceVersionId,
    input.candidate.candidateCommitOid,
  );
  return Object.freeze({
    acceptedEventId: `workspace-history-successor-${identity}`,
    committedAt: Date.now(),
    successor: Object.freeze({
      repositoryId: input.head.repositoryId,
      workspaceId: input.head.workspaceId,
      workspaceEpochId: input.head.workspaceEpochId,
      workspaceVersionId: `version_${identity}`,
      objectFormat: 'sha1' as const,
      parentWorkspaceVersionId: input.head.workspaceVersionId,
      baseAcceptedEventId: input.head.acceptedEventId,
      baseHeadRevision: input.head.revision,
      commitOid: input.candidate.candidateCommitOid,
      treeOid: input.candidate.candidateTreeOid,
      policyHash: input.current.policyHash,
      treeDeltaDigest: `sha256:${input.candidate.treeDeltaDigestSha256}` as const,
      changedFileCount: input.candidate.changedFileCount,
      deletedFileCount: input.candidate.deletedFileCount,
      executionProfileDigest: GITOXIDE_HISTORY_RESTORE_EXECUTION_PROFILE_DIGEST,
    }),
    origin: Object.freeze({
      restoreId: input.restoreId,
      targetWorkspaceVersionId: input.target.workspaceVersionId,
    }),
  });
}

function historyCandidateRef(
  restoreId: string,
  baseWorkspaceVersionId: string,
  targetWorkspaceVersionId: string,
): string {
  return `refs/maka/history-candidates/${createHash('sha256')
    .update('maka-history-candidate-ref-v1\0')
    .update(restoreId)
    .update('\0')
    .update(baseWorkspaceVersionId)
    .update('\0')
    .update(targetWorkspaceVersionId)
    .digest('hex')}`;
}

function historyCandidateRequestDigest(input: {
  readonly acceptedRef: string;
  readonly baseCommitOid: string;
  readonly baseTreeOid: string;
  readonly targetCommitOid: string;
  readonly targetTreeOid: string;
  readonly candidateRef: string;
  readonly restoreId: string;
}): string {
  const hash = createHash('sha256').update('maka.gitoxide.history-candidate-request.v1\0', 'utf8');
  for (const value of [
    input.acceptedRef,
    input.baseCommitOid,
    input.baseTreeOid,
    input.targetCommitOid,
    input.targetTreeOid,
    input.candidateRef,
    input.restoreId,
  ]) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}

function matchesWorkspace(
  expected: { repositoryId: string; workspaceId: string; workspaceEpochId: string },
  actual: { repositoryId: string; workspaceId: string; workspaceEpochId: string },
): boolean {
  return (
    actual.repositoryId === expected.repositoryId &&
    actual.workspaceId === expected.workspaceId &&
    actual.workspaceEpochId === expected.workspaceEpochId
  );
}

function digest(domain: string, ...values: readonly string[]): string {
  const hash = createHash('sha256').update(`maka-${domain}-v1\0`, 'utf8');
  for (const value of values) hash.update(value).update('\0');
  return hash.digest('hex').slice(0, 32);
}
