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
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MANAGED_MUTATION_EXECUTION_PROFILE_V1 } from '@maka/core/runtime-event';
import type { ManagedWorkspaceContinuationBoundaryV1 } from '@maka/core/runtime-boundary';
import {
  WORKSPACE_MATERIALIZATION_SEMANTICS_V1,
  workspaceMutationPolicyHashV1,
  type WorkspaceBaselineAuthorityInput,
} from '@maka/core/workspace-version-authority';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  issueExecutionStoresWorkspaceBaselineAuthorityInternal,
  issueExecutionStoresWorkspaceContinuationAuthorityInternal,
  requireExecutionStoresWorkspaceBaselineAuthorityInternal,
  requireExecutionStoresWorkspaceContinuationAuthorityInternal,
} from '@maka/storage/execution-stores-workspace-authority-internal';
import { runWithStorageRootLease, type StorageRootLease } from '@maka/storage/root-authority';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import {
  createGitoxideManagedWriteEditOwnerInternal,
  type GitoxideManagedWriteEditOwnerInternal,
} from './gitoxide-managed-write-edit-owner-internal.js';
import {
  createGitoxideManagedInspectionOwnerInternal,
  type GitoxideManagedInspectionOwnerInternal,
} from './gitoxide-managed-inspection-owner-internal.js';
import {
  createGitoxideManagedReviewOwnerInternal,
  type GitoxideManagedReviewOwnerInternal,
} from './gitoxide-managed-review-owner-internal.js';
import {
  createGitoxideManagedRestoreOwnerInternal,
  type GitoxideManagedRestoreOwnerInternal,
} from './gitoxide-managed-restore-owner-internal.js';
import {
  createGitoxideManagedPublishOwnerInternal,
  type GitoxideManagedPublishOwnerInternal,
} from './gitoxide-managed-publish-owner-internal.js';
import {
  createGitoxideManagedTimeTravelOwnerInternal,
  type GitoxideManagedTimeTravelOwnerInternal,
} from './gitoxide-managed-time-travel-owner-internal.js';
import {
  createGitoxideManagedGcOwnerInternal,
  type GitoxideManagedGcOwnerInternal,
} from './gitoxide-managed-gc-owner-internal.js';
import {
  admitGitoxideRepositoryInternal,
  importAdmittedGitoxideRepositoryInternal,
  reopenGitoxideAcceptedRepositoryInternal,
  requireGitoxideRepositoryAdmissionInternal,
} from './gitoxide-repository-admission-authority-internal.js';

const MANAGED_REPOSITORY_DIRECTORY = 'gitoxide-managed-repositories';
const ACCEPTED_REF = 'refs/maka/accepted';

export interface GitoxideManagedSessionOwnerInternal {
  readonly repositoryPath: string;
  readonly repositoryId: string;
  readonly baselineWorkspaceVersionId: string;
  readonly gc: GitoxideManagedGcOwnerInternal;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly inspection: GitoxideManagedInspectionOwnerInternal;
  readonly publish: GitoxideManagedPublishOwnerInternal;
  readonly review: GitoxideManagedReviewOwnerInternal;
  readonly restore: GitoxideManagedRestoreOwnerInternal;
  readonly timeTravel: GitoxideManagedTimeTravelOwnerInternal;
  readonly writeEdit: GitoxideManagedWriteEditOwnerInternal;
  rebaseline(
    rebaselineId: string,
    abortSignal?: AbortSignal,
  ): Promise<GitoxideManagedSessionOwnerInternal>;
}

export type GitoxideManagedSessionOwnerFailpoint = 'after_repository_import';

/**
 * Re-observes an existing managed workspace without gaining mutation authority.
 * The returned value is derived from one SQLite read transaction, then bound to
 * the exact source HEAD and accepted Gitoxide ref before it reaches Runtime.
 */
export async function inspectGitoxideManagedContinuationBoundaryInternal(input: {
  readonly storageRootLease: StorageRootLease<'interactive', 'write'>;
  readonly stores: InteractiveExecutionStoresWriter;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly sourceRoot: string;
  readonly sessionId: string;
  readonly workspaceEpochSeed?: string;
  readonly abortSignal?: AbortSignal;
}): Promise<ManagedWorkspaceContinuationBoundaryV1 | undefined> {
  input.abortSignal?.throwIfAborted();
  const [storageRoot, sourceRoot] = await Promise.all([
    runWithStorageRootLease(input.storageRootLease, 'interactive', 'write', async (root) => root),
    realpath(input.sourceRoot),
  ]);
  const identity = deriveManagedSessionIdentity(input.sessionId, input.workspaceEpochSeed);
  const continuationOwnerToken = {};
  const capability = issueExecutionStoresWorkspaceContinuationAuthorityInternal({
    ownerToken: continuationOwnerToken,
    stores: input.stores,
  });
  const authority = requireExecutionStoresWorkspaceContinuationAuthorityInternal(
    continuationOwnerToken,
    capability,
  );
  const boundary = await authority.readContinuationBoundary(
    identity.workspaceId,
    identity.workspaceEpochId,
    MANAGED_MUTATION_EXECUTION_PROFILE_V1,
  );
  if (!boundary) return undefined;
  if (
    boundary.repositoryId !== identity.repositoryId ||
    boundary.workspaceId !== identity.workspaceId ||
    boundary.workspaceEpochId !== identity.workspaceEpochId ||
    boundary.workspaceInstanceId !== identity.workspaceInstanceId ||
    boundary.objectFormat !== 'sha1'
  ) {
    throw new Error('Gitoxide managed continuation boundary conflicts with session identity');
  }

  const sourceOwnerToken = {};
  const sourceAdmission = await admitGitoxideRepositoryInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    admissionOwnerToken: sourceOwnerToken,
    repositoryPath: sourceRoot,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  if (sourceAdmission.kind !== 'accepted') {
    throw new Error(`Gitoxide managed continuation rejected source: ${sourceAdmission.reason}`);
  }
  const source = requireGitoxideRepositoryAdmissionInternal(
    sourceOwnerToken,
    sourceAdmission.capability,
  );
  if (
    source.headCommitOid !== boundary.sourceCommitOid ||
    source.headTreeOid !== boundary.sourceTreeOid
  ) {
    throw new Error('Gitoxide managed continuation source has drifted');
  }

  const repositoryPath = join(
    storageRoot,
    MANAGED_REPOSITORY_DIRECTORY,
    identity.workspaceEpochId,
    'repository.git',
  );
  await reopenGitoxideAcceptedRepositoryInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    acceptedRepositoryOwnerToken: {},
    repositoryPath,
    acceptedRef: ACCEPTED_REF,
    expectedAcceptedCommitOid: boundary.commitOid,
    expectedAcceptedTreeOid: boundary.treeOid,
    managedTreePolicyVersion: 3,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  input.abortSignal?.throwIfAborted();
  return boundary;
}

export async function openGitoxideManagedSessionOwnerInternal(input: {
  readonly storageRootLease: StorageRootLease<'interactive', 'write'>;
  readonly stores: InteractiveExecutionStoresWriter;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly sourceRoot: string;
  readonly sessionId: string;
  readonly workspaceEpochSeed?: string;
  readonly abortSignal?: AbortSignal;
  readonly failpoint?: (point: GitoxideManagedSessionOwnerFailpoint) => void | Promise<void>;
}): Promise<GitoxideManagedSessionOwnerInternal> {
  input.abortSignal?.throwIfAborted();
  const [storageRoot, sourceRoot] = await Promise.all([
    runWithStorageRootLease(input.storageRootLease, 'interactive', 'write', async (root) => root),
    realpath(input.sourceRoot),
  ]);
  const identity = deriveManagedSessionIdentity(input.sessionId, input.workspaceEpochSeed);
  const repositoryPath = join(
    storageRoot,
    MANAGED_REPOSITORY_DIRECTORY,
    identity.workspaceEpochId,
    'repository.git',
  );
  await mkdir(dirname(repositoryPath), { recursive: true });

  const admissionOwnerToken = {};
  const sourceAdmission = await admitGitoxideRepositoryInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    admissionOwnerToken,
    repositoryPath: sourceRoot,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  if (sourceAdmission.kind !== 'accepted') {
    throw new Error(`Gitoxide managed session rejected source: ${sourceAdmission.reason}`);
  }
  const source = requireGitoxideRepositoryAdmissionInternal(
    admissionOwnerToken,
    sourceAdmission.capability,
  );
  const materializationProfileDigest = sha256(
    `maka-gitoxide-materialization-v3\0${source.helperArtifactSha256}\0`,
  );
  const policyHash = workspaceMutationPolicyHashV1(
    materializationProfileDigest,
    MANAGED_MUTATION_EXECUTION_PROFILE_V1,
  );
  const baselineOwnerToken = {};
  const verifiedBaselines = new WeakMap<object, WorkspaceBaselineAuthorityInput>();
  const baselineCapability = issueExecutionStoresWorkspaceBaselineAuthorityInternal({
    ownerToken: baselineOwnerToken,
    stores: input.stores,
    verifyBaseline(proof) {
      const baseline = verifiedBaselines.get(proof);
      if (!baseline) throw new Error('Gitoxide managed session baseline proof is invalid');
      return baseline;
    },
  });
  const baselineAuthority = requireExecutionStoresWorkspaceBaselineAuthorityInternal(
    baselineOwnerToken,
    baselineCapability,
  );
  const existingEpoch = await baselineAuthority.readEpoch(
    identity.workspaceId,
    identity.workspaceEpochId,
  );
  const existingHead = await baselineAuthority.readHead(
    identity.workspaceId,
    identity.workspaceEpochId,
  );
  const existingVersion = existingHead
    ? await baselineAuthority.readVersion(existingHead.workspaceVersionId)
    : undefined;
  if (existingEpoch || existingHead) {
    if (
      !existingEpoch ||
      !existingHead ||
      existingEpoch.repositoryId !== identity.repositoryId ||
      existingEpoch.workspaceInstanceId !== identity.workspaceInstanceId ||
      existingEpoch.sourceCommitOid !== source.headCommitOid ||
      existingEpoch.sourceTreeOid !== source.headTreeOid ||
      existingEpoch.objectFormat !== 'sha1' ||
      existingEpoch.materializationProfileDigest !== materializationProfileDigest ||
      existingEpoch.policyHash !== policyHash ||
      !existingVersion ||
      existingVersion.repositoryId !== identity.repositoryId ||
      existingVersion.workspaceId !== identity.workspaceId ||
      existingVersion.workspaceEpochId !== identity.workspaceEpochId ||
      existingVersion.commitOid !== existingHead.commitOid ||
      existingVersion.treeOid !== existingHead.treeOid ||
      existingVersion.policyHash !== policyHash
    ) {
      throw new Error('Gitoxide managed session source or durable epoch has drifted');
    }
  } else {
    const acceptedRepositoryOwnerToken = {};
    const imported = await importAdmittedGitoxideRepositoryInternal({
      admissionOwnerToken,
      repositoryCapability: sourceAdmission.capability,
      acceptedRepositoryOwnerToken,
      destinationRepositoryPath: repositoryPath,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    const baseline: WorkspaceBaselineAuthorityInput = Object.freeze({
      epochOpenedEventId: `workspace-epoch-${identity.digest}`,
      baselineAcceptedEventId: `workspace-baseline-${identity.digest}`,
      committedAt: 0,
      epoch: Object.freeze({
        repositoryId: identity.repositoryId,
        workspaceId: identity.workspaceId,
        workspaceEpochId: identity.workspaceEpochId,
        workspaceInstanceId: identity.workspaceInstanceId,
        mode: 'managed_worktree' as const,
        objectFormat: 'sha1' as const,
        sourceCommitOid: imported.sourceHeadCommitOid,
        sourceTreeOid: imported.sourceTreeOid,
        materializationProfileDigest,
        materializationSemantics: WORKSPACE_MATERIALIZATION_SEMANTICS_V1,
        policyHash,
      }),
      baseline: Object.freeze({
        workspaceVersionId: identity.workspaceVersionId,
        commitOid: imported.baselineCommitOid,
        treeOid: imported.baselineTreeOid,
        treeDeltaDigest: sha256(`maka-gitoxide-baseline-tree-v1\0${imported.baselineTreeOid}\0`),
        changedFileCount: imported.filesImported,
        deletedFileCount: 0 as const,
      }),
    });
    verifiedBaselines.set(imported, baseline);
    await input.failpoint?.('after_repository_import');
    await baselineAuthority.commitBaseline(imported);
  }

  const writeEdit = createGitoxideManagedWriteEditOwnerInternal({
    storageRootLease: input.storageRootLease,
    stores: input.stores,
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    repositoryPath,
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
  });
  const inspection = createGitoxideManagedInspectionOwnerInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    repositoryPath,
    async readAcceptedIdentity() {
      const [epoch, head] = await Promise.all([
        baselineAuthority.readEpoch(identity.workspaceId, identity.workspaceEpochId),
        baselineAuthority.readHead(identity.workspaceId, identity.workspaceEpochId),
      ]);
      if (
        !epoch ||
        !head ||
        epoch.repositoryId !== identity.repositoryId ||
        epoch.workspaceId !== identity.workspaceId ||
        epoch.workspaceEpochId !== identity.workspaceEpochId ||
        head.repositoryId !== identity.repositoryId ||
        head.workspaceId !== identity.workspaceId ||
        head.workspaceEpochId !== identity.workspaceEpochId
      ) {
        throw new Error('Gitoxide managed inspection durable workspace head is unavailable');
      }
      const version = await baselineAuthority.readVersion(head.workspaceVersionId);
      if (
        !version ||
        version.repositoryId !== head.repositoryId ||
        version.workspaceId !== head.workspaceId ||
        version.workspaceEpochId !== head.workspaceEpochId ||
        version.workspaceVersionId !== head.workspaceVersionId ||
        version.acceptedEventId !== head.acceptedEventId ||
        version.commitOid !== head.commitOid ||
        version.treeOid !== head.treeOid
      ) {
        throw new Error('Gitoxide managed inspection workspace version is unavailable');
      }
      return Object.freeze({ commitOid: head.commitOid, treeOid: head.treeOid });
    },
  });
  const review = createGitoxideManagedReviewOwnerInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    repositoryPath,
    async readReviewBoundary() {
      const [epoch, baseline, head] = await Promise.all([
        baselineAuthority.readEpoch(identity.workspaceId, identity.workspaceEpochId),
        baselineAuthority.readVersion(identity.workspaceVersionId),
        baselineAuthority.readHead(identity.workspaceId, identity.workspaceEpochId),
      ]);
      if (
        !epoch ||
        !baseline ||
        !head ||
        epoch.repositoryId !== identity.repositoryId ||
        epoch.workspaceId !== identity.workspaceId ||
        epoch.workspaceEpochId !== identity.workspaceEpochId ||
        baseline.protocol !== 'workspace_baseline_accepted_v1' ||
        baseline.repositoryId !== identity.repositoryId ||
        baseline.workspaceId !== identity.workspaceId ||
        baseline.workspaceEpochId !== identity.workspaceEpochId ||
        baseline.workspaceVersionId !== identity.workspaceVersionId ||
        head.repositoryId !== identity.repositoryId ||
        head.workspaceId !== identity.workspaceId ||
        head.workspaceEpochId !== identity.workspaceEpochId
      ) {
        throw new Error('Gitoxide managed review durable workspace boundary is unavailable');
      }
      const accepted = await baselineAuthority.readVersion(head.workspaceVersionId);
      if (
        !accepted ||
        accepted.repositoryId !== head.repositoryId ||
        accepted.workspaceId !== head.workspaceId ||
        accepted.workspaceEpochId !== head.workspaceEpochId ||
        accepted.workspaceVersionId !== head.workspaceVersionId ||
        accepted.acceptedEventId !== head.acceptedEventId ||
        accepted.commitOid !== head.commitOid ||
        accepted.treeOid !== head.treeOid ||
        accepted.policyHash !== baseline.policyHash
      ) {
        throw new Error('Gitoxide managed review accepted workspace version is unavailable');
      }
      return Object.freeze({
        baselineCommitOid: baseline.commitOid,
        baselineTreeOid: baseline.treeOid,
        acceptedCommitOid: accepted.commitOid,
        acceptedTreeOid: accepted.treeOid,
      });
    },
  });
  const restore = createGitoxideManagedRestoreOwnerInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    repositoryPath,
    storageRoot,
    workspaceEpochId: identity.workspaceEpochId,
    async readAcceptedIdentity() {
      const head = await baselineAuthority.readHead(
        identity.workspaceId,
        identity.workspaceEpochId,
      );
      if (
        !head ||
        head.repositoryId !== identity.repositoryId ||
        head.workspaceId !== identity.workspaceId ||
        head.workspaceEpochId !== identity.workspaceEpochId
      ) {
        throw new Error('Gitoxide managed restore durable workspace head is unavailable');
      }
      const version = await baselineAuthority.readVersion(head.workspaceVersionId);
      if (
        !version ||
        version.repositoryId !== head.repositoryId ||
        version.workspaceId !== head.workspaceId ||
        version.workspaceEpochId !== head.workspaceEpochId ||
        version.workspaceVersionId !== head.workspaceVersionId ||
        version.acceptedEventId !== head.acceptedEventId ||
        version.commitOid !== head.commitOid ||
        version.treeOid !== head.treeOid
      ) {
        throw new Error('Gitoxide managed restore accepted workspace version is unavailable');
      }
      return Object.freeze({ commitOid: version.commitOid, treeOid: version.treeOid });
    },
  });
  const publish = createGitoxideManagedPublishOwnerInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    repositoryPath,
    async readAcceptedIdentity() {
      const head = await baselineAuthority.readHead(
        identity.workspaceId,
        identity.workspaceEpochId,
      );
      if (
        !head ||
        head.repositoryId !== identity.repositoryId ||
        head.workspaceId !== identity.workspaceId ||
        head.workspaceEpochId !== identity.workspaceEpochId
      ) {
        throw new Error('Gitoxide managed publication durable workspace head is unavailable');
      }
      const version = await baselineAuthority.readVersion(head.workspaceVersionId);
      if (
        !version ||
        version.repositoryId !== head.repositoryId ||
        version.workspaceId !== head.workspaceId ||
        version.workspaceEpochId !== head.workspaceEpochId ||
        version.workspaceVersionId !== head.workspaceVersionId ||
        version.acceptedEventId !== head.acceptedEventId ||
        version.commitOid !== head.commitOid ||
        version.treeOid !== head.treeOid
      ) {
        throw new Error('Gitoxide managed publication accepted workspace version is unavailable');
      }
      return Object.freeze({ commitOid: version.commitOid, treeOid: version.treeOid });
    },
  });
  const timeTravel = createGitoxideManagedTimeTravelOwnerInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    repositoryPath,
    storageRoot,
    workspaceEpochId: identity.workspaceEpochId,
    async readVersionIdentity(workspaceVersionId) {
      const version = await baselineAuthority.readVersion(workspaceVersionId);
      if (
        !version ||
        version.repositoryId !== identity.repositoryId ||
        version.workspaceId !== identity.workspaceId ||
        version.workspaceEpochId !== identity.workspaceEpochId
      ) {
        throw new Error('Gitoxide managed time-travel workspace version is unavailable');
      }
      return Object.freeze({ commitOid: version.commitOid, treeOid: version.treeOid });
    },
  });
  const gc = createGitoxideManagedGcOwnerInternal({
    storageRoot,
    workspaceEpochId: identity.workspaceEpochId,
  });
  await writeEdit.reconcileAcceptedProjection(input.abortSignal);
  const rebaseline = async (
    rebaselineId: string,
    abortSignal?: AbortSignal,
  ): Promise<GitoxideManagedSessionOwnerInternal> => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(rebaselineId)) {
      throw new Error('Gitoxide managed rebaseline identity is invalid');
    }
    return openGitoxideManagedSessionOwnerInternal({
      ...input,
      workspaceEpochSeed: rebaselineId,
      ...(abortSignal ? { abortSignal } : {}),
    });
  };
  return Object.freeze({
    repositoryPath,
    repositoryId: identity.repositoryId,
    baselineWorkspaceVersionId: identity.workspaceVersionId,
    gc,
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
    inspection,
    publish,
    review,
    restore,
    timeTravel,
    writeEdit,
    rebaseline,
  });
}

function deriveManagedSessionIdentity(sessionId: string, workspaceEpochSeed?: string) {
  if (!sessionId.trim()) throw new Error('Gitoxide managed session identity is invalid');
  const workspaceDigest = createHash('sha256')
    .update('maka-gitoxide-managed-session-v2\0', 'utf8')
    .update(sessionId, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const digest = workspaceEpochSeed
    ? createHash('sha256')
        .update('maka-gitoxide-managed-rebaseline-v1\0', 'utf8')
        .update(workspaceDigest, 'utf8')
        .update('\0')
        .update(workspaceEpochSeed, 'utf8')
        .digest('hex')
        .slice(0, 32)
    : workspaceDigest;
  return Object.freeze({
    digest,
    repositoryId: `repository_${workspaceDigest}`,
    workspaceId: `workspace_${workspaceDigest}`,
    workspaceEpochId: `epoch_${digest}`,
    workspaceInstanceId: `instance_${digest}`,
    workspaceVersionId: `version_${digest}`,
  });
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
