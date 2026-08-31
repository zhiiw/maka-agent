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
import { MANAGED_MUTATION_EXECUTION_PROFILE_V2_DIGEST } from '@maka/core/runtime-event';
import type { ManagedWorkspaceContinuationBoundaryV1 } from '@maka/core/runtime-boundary';
import {
  WORKSPACE_MATERIALIZATION_SEMANTICS_V1,
  workspaceMutationPolicyHashV1,
  type WorkspaceBaselineAuthorityInput,
  type WorkspaceEpochActivationAuthorityInput,
} from '@maka/core/workspace-version-authority';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  issueExecutionStoresWorkspaceBaselineAuthorityInternal,
  issueExecutionStoresWorkspaceActiveEpochAuthorityInternal,
  issueExecutionStoresWorkspaceContinuationAuthorityInternal,
  requireExecutionStoresWorkspaceBaselineAuthorityInternal,
  requireExecutionStoresWorkspaceActiveEpochAuthorityInternal,
  requireExecutionStoresWorkspaceContinuationAuthorityInternal,
} from '@maka/storage/execution-stores-workspace-authority-internal';
import { runWithStorageRootLease, type StorageRootLease } from '@maka/storage/root-authority';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import {
  requireGitoxideHelperArtifactIdentityInternal,
  requireGitoxideHelperOperationsInternal,
} from './gitoxide-helper-artifact-authority-internal.js';
import {
  importFilesystemSnapshotWithGitoxideHelperInternal,
  materializeAcceptedTreeWithGitoxideHelperInternal,
} from './gitoxide-helper-invocation-internal.js';
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
  createGitoxideManagedSourceBranchPublishOwnerInternal,
  type GitoxideManagedSourceBranchPublishOwnerInternal,
} from './gitoxide-managed-source-branch-publish-owner-internal.js';
import {
  createGitoxideManagedTimeTravelOwnerInternal,
  type GitoxideManagedTimeTravelOwnerInternal,
} from './gitoxide-managed-time-travel-owner-internal.js';
import {
  createGitoxideManagedHistorySuccessorOwnerInternal,
  type GitoxideManagedHistorySuccessorOwnerInternal,
} from './gitoxide-managed-history-successor-owner-internal.js';
import {
  createGitoxideManagedHistoryOwnerInternal,
  type GitoxideManagedHistoryOwnerInternal,
} from './gitoxide-managed-history-owner-internal.js';
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
import {
  admitResumableWorkspaceSourceInternal,
  requireResumableWorkspaceSourceAdmissionInternal,
  type ResumableWorkspaceSourceKindInternal,
} from './resumable-workspace-source-admission-internal.js';
import type {
  ManagedNodeTestAcceptedBoundaryInternal,
  ManagedNodeTestExecutionRootOwnerInternal,
  ManagedNodeTestSourceOwnerInternal,
} from './managed-node-test-admission-owner-internal.js';
import type { ManagedCommandSandboxOwnerInternal } from './managed-command-sandbox-owner-internal.js';
import {
  createManagedNodeTransformOwnerInternal,
  type ManagedNodeTransformOwnerInternal,
} from './managed-node-transform-admission-owner-internal.js';

const MANAGED_REPOSITORY_DIRECTORY = 'gitoxide-managed-repositories';
const ACCEPTED_REF = 'refs/maka/accepted';
const SOURCE_BASELINE_REF = 'refs/maka/source-baseline';

export interface GitoxideManagedSessionOwnerInternal {
  readonly sourceKind: ResumableWorkspaceSourceKindInternal;
  readonly repositoryPath: string;
  readonly repositoryId: string;
  readonly baselineWorkspaceVersionId: string;
  readonly gc: GitoxideManagedGcOwnerInternal;
  readonly history: GitoxideManagedHistoryOwnerInternal;
  readonly historySuccessor: GitoxideManagedHistorySuccessorOwnerInternal;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly inspection: GitoxideManagedInspectionOwnerInternal;
  readonly nodeTestSource: ManagedNodeTestSourceOwnerInternal;
  readonly nodeTransform: ManagedNodeTransformOwnerInternal | undefined;
  readonly publish: GitoxideManagedPublishOwnerInternal;
  readonly sourceBranchPublish: GitoxideManagedSourceBranchPublishOwnerInternal | undefined;
  readonly review: GitoxideManagedReviewOwnerInternal;
  readonly restore: GitoxideManagedRestoreOwnerInternal;
  readonly timeTravel: GitoxideManagedTimeTravelOwnerInternal;
  readonly writeEdit: GitoxideManagedWriteEditOwnerInternal;
  rebaseline(
    rebaselineId: string,
    abortSignal?: AbortSignal,
  ): Promise<GitoxideManagedSessionOwnerInternal>;
}

export type GitoxideManagedSessionOwnerFailpoint =
  | 'after_repository_import'
  | 'after_active_epoch_commit';

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
  const sourceOwnerToken = {};
  const sourceCapability = await admitResumableWorkspaceSourceInternal({
    ownerToken: sourceOwnerToken,
    sourceRoot,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  const sourceBinding = requireResumableWorkspaceSourceAdmissionInternal(
    sourceOwnerToken,
    sourceCapability,
  );
  const baseIdentity = deriveManagedSessionIdentity(input.sessionId, sourceBinding.kind);
  const activeEpochOwnerToken = {};
  const verifiedActivations = new WeakMap<object, WorkspaceEpochActivationAuthorityInput>();
  const activeEpochCapability = issueExecutionStoresWorkspaceActiveEpochAuthorityInternal({
    ownerToken: activeEpochOwnerToken,
    stores: input.stores,
    verifyActivation(proof) {
      const activation = verifiedActivations.get(proof);
      if (!activation) throw new Error('Gitoxide managed active-epoch proof is invalid');
      return activation;
    },
  });
  const activeEpochAuthority = requireExecutionStoresWorkspaceActiveEpochAuthorityInternal(
    activeEpochOwnerToken,
    activeEpochCapability,
  );
  const persistedActiveEpoch = await activeEpochAuthority.readActiveEpoch(baseIdentity.workspaceId);
  if (
    persistedActiveEpoch &&
    (persistedActiveEpoch.repositoryId !== baseIdentity.repositoryId ||
      persistedActiveEpoch.workspaceId !== baseIdentity.workspaceId)
  ) {
    throw new Error('Gitoxide managed active epoch conflicts with the session identity');
  }
  const effectiveWorkspaceEpochSeed =
    input.workspaceEpochSeed ?? persistedActiveEpoch?.rebaselineId ?? undefined;
  const identity = deriveManagedSessionIdentity(
    input.sessionId,
    sourceBinding.kind,
    effectiveWorkspaceEpochSeed,
  );
  if (
    input.workspaceEpochSeed === undefined &&
    persistedActiveEpoch &&
    persistedActiveEpoch.workspaceEpochId !== identity.workspaceEpochId
  ) {
    throw new Error('Gitoxide managed active epoch identity cannot be derived');
  }
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
    MANAGED_MUTATION_EXECUTION_PROFILE_V2_DIGEST,
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

  const repositoryPath = join(
    storageRoot,
    MANAGED_REPOSITORY_DIRECTORY,
    identity.workspaceEpochId,
    'repository.git',
  );
  if (sourceBinding.kind === 'git_repository_v1') {
    const admissionOwnerToken = {};
    const sourceAdmission = await admitGitoxideRepositoryInternal({
      invocationOwnerToken: input.invocationOwnerToken,
      helperCapability: input.helperCapability,
      admissionOwnerToken,
      repositoryPath: sourceRoot,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (sourceAdmission.kind !== 'accepted') {
      throw new Error(`Gitoxide managed continuation rejected source: ${sourceAdmission.reason}`);
    }
    const source = requireGitoxideRepositoryAdmissionInternal(
      admissionOwnerToken,
      sourceAdmission.capability,
    );
    if (
      source.headCommitOid !== boundary.sourceCommitOid ||
      source.headTreeOid !== boundary.sourceTreeOid
    ) {
      throw new Error('Gitoxide managed continuation source has drifted');
    }
  } else {
    requireGitoxideHelperOperationsInternal(input.invocationOwnerToken, input.helperCapability, [
      'import_filesystem_snapshot',
    ]);
    const snapshot = await importFilesystemSnapshotWithGitoxideHelperInternal({
      invocationOwnerToken: input.invocationOwnerToken,
      capability: input.helperCapability,
      sourceRootPath: sourceRoot,
      destinationRepositoryPath: repositoryPath,
      baselineRef: SOURCE_BASELINE_REF,
      acceptedRef: ACCEPTED_REF,
      managedTreePolicyVersion: 3,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (
      snapshot.baselineCommitOid !== boundary.sourceCommitOid ||
      snapshot.baselineTreeOid !== boundary.sourceTreeOid
    ) {
      throw new Error('Gitoxide managed continuation source has drifted');
    }
  }
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
  readonly managedNodeTransform?: Readonly<{
    executionRootOwner: ManagedNodeTestExecutionRootOwnerInternal;
    commandOwner: ManagedCommandSandboxOwnerInternal;
  }>;
  readonly failpoint?: (point: GitoxideManagedSessionOwnerFailpoint) => void | Promise<void>;
}): Promise<GitoxideManagedSessionOwnerInternal> {
  input.abortSignal?.throwIfAborted();
  const [storageRoot, sourceRoot] = await Promise.all([
    runWithStorageRootLease(input.storageRootLease, 'interactive', 'write', async (root) => root),
    realpath(input.sourceRoot),
  ]);
  const sourceOwnerToken = {};
  const sourceCapability = await admitResumableWorkspaceSourceInternal({
    ownerToken: sourceOwnerToken,
    sourceRoot,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  const sourceBinding = requireResumableWorkspaceSourceAdmissionInternal(
    sourceOwnerToken,
    sourceCapability,
  );
  const baseIdentity = deriveManagedSessionIdentity(input.sessionId, sourceBinding.kind);
  const activeEpochOwnerToken = {};
  const verifiedActivations = new WeakMap<object, WorkspaceEpochActivationAuthorityInput>();
  const activeEpochCapability = issueExecutionStoresWorkspaceActiveEpochAuthorityInternal({
    ownerToken: activeEpochOwnerToken,
    stores: input.stores,
    verifyActivation(proof) {
      const activation = verifiedActivations.get(proof);
      if (!activation) throw new Error('Gitoxide managed active-epoch proof is invalid');
      return activation;
    },
  });
  const activeEpochAuthority = requireExecutionStoresWorkspaceActiveEpochAuthorityInternal(
    activeEpochOwnerToken,
    activeEpochCapability,
  );
  const persistedActiveEpoch = await activeEpochAuthority.readActiveEpoch(baseIdentity.workspaceId);
  if (
    persistedActiveEpoch &&
    (persistedActiveEpoch.repositoryId !== baseIdentity.repositoryId ||
      persistedActiveEpoch.workspaceId !== baseIdentity.workspaceId)
  ) {
    throw new Error('Gitoxide managed active epoch conflicts with the session identity');
  }
  const effectiveWorkspaceEpochSeed =
    input.workspaceEpochSeed ?? persistedActiveEpoch?.rebaselineId ?? undefined;
  const identity = deriveManagedSessionIdentity(
    input.sessionId,
    sourceBinding.kind,
    effectiveWorkspaceEpochSeed,
  );
  if (
    input.workspaceEpochSeed === undefined &&
    persistedActiveEpoch &&
    persistedActiveEpoch.workspaceEpochId !== identity.workspaceEpochId
  ) {
    throw new Error('Gitoxide managed active epoch identity cannot be derived');
  }
  const repositoryPath = join(
    storageRoot,
    MANAGED_REPOSITORY_DIRECTORY,
    identity.workspaceEpochId,
    'repository.git',
  );
  await mkdir(dirname(repositoryPath), { recursive: true });

  const helperIdentity = requireGitoxideHelperArtifactIdentityInternal(
    input.invocationOwnerToken,
    input.helperCapability,
  );
  requireGitoxideHelperOperationsInternal(input.invocationOwnerToken, input.helperCapability, [
    'create_history_candidate',
    'promote_history_candidate',
  ]);
  const materializationProfileDigest = sha256(
    `maka-gitoxide-materialization-v4\0${sourceBinding.kind}\0${helperIdentity.sha256}\0`,
  );
  const policyHash = workspaceMutationPolicyHashV1(
    materializationProfileDigest,
    MANAGED_MUTATION_EXECUTION_PROFILE_V2_DIGEST,
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
  let sourceCommitOid: string;
  let sourceTreeOid: string;
  let importedBaseline:
    | {
        readonly proof: object;
        readonly baselineCommitOid: string;
        readonly baselineTreeOid: string;
        readonly filesImported: number;
      }
    | undefined;
  let gitAdmission:
    | {
        readonly ownerToken: object;
        readonly capability: Awaited<ReturnType<typeof admitGitoxideRepositoryInternal>>;
      }
    | undefined;
  if (sourceBinding.kind === 'git_repository_v1') {
    const admissionOwnerToken = {};
    const admission = await admitGitoxideRepositoryInternal({
      invocationOwnerToken: input.invocationOwnerToken,
      helperCapability: input.helperCapability,
      admissionOwnerToken,
      repositoryPath: sourceRoot,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (admission.kind !== 'accepted') {
      throw new Error(`Gitoxide managed session rejected source: ${admission.reason}`);
    }
    const source = requireGitoxideRepositoryAdmissionInternal(
      admissionOwnerToken,
      admission.capability,
    );
    sourceCommitOid = source.headCommitOid;
    sourceTreeOid = source.headTreeOid;
    gitAdmission = { ownerToken: admissionOwnerToken, capability: admission };
  } else {
    requireGitoxideHelperOperationsInternal(input.invocationOwnerToken, input.helperCapability, [
      'import_filesystem_snapshot',
      'create_candidate',
      'promote_candidate',
      'observe_accepted_ref',
      'read_tree_file',
      'list_tree_files',
      'grep_tree_files',
    ]);
    const snapshot = await importFilesystemSnapshotWithGitoxideHelperInternal({
      invocationOwnerToken: input.invocationOwnerToken,
      capability: input.helperCapability,
      sourceRootPath: sourceRoot,
      destinationRepositoryPath: repositoryPath,
      baselineRef: SOURCE_BASELINE_REF,
      acceptedRef: ACCEPTED_REF,
      managedTreePolicyVersion: 3,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    sourceCommitOid = snapshot.baselineCommitOid;
    sourceTreeOid = snapshot.baselineTreeOid;
    importedBaseline = {
      proof: snapshot,
      baselineCommitOid: snapshot.baselineCommitOid,
      baselineTreeOid: snapshot.baselineTreeOid,
      filesImported: snapshot.filesImported,
    };
  }
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
      existingEpoch.sourceCommitOid !== sourceCommitOid ||
      existingEpoch.sourceTreeOid !== sourceTreeOid ||
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
    if (sourceBinding.kind === 'git_repository_v1') {
      const admission = gitAdmission;
      if (!admission || admission.capability.kind !== 'accepted') {
        throw new Error('Gitoxide managed session source admission is unavailable');
      }
      const imported = await importAdmittedGitoxideRepositoryInternal({
        admissionOwnerToken: admission.ownerToken,
        repositoryCapability: admission.capability.capability,
        acceptedRepositoryOwnerToken: {},
        destinationRepositoryPath: repositoryPath,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      importedBaseline = {
        proof: imported,
        baselineCommitOid: imported.baselineCommitOid,
        baselineTreeOid: imported.baselineTreeOid,
        filesImported: imported.filesImported,
      };
    }
    const imported = importedBaseline;
    if (!imported) throw new Error('Gitoxide managed session baseline import is unavailable');
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
        sourceCommitOid,
        sourceTreeOid,
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
    verifiedBaselines.set(imported.proof, baseline);
    await input.failpoint?.('after_repository_import');
    await baselineAuthority.commitBaseline(imported.proof);
  }

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
  const readNodeTestAcceptedBoundary = async (
    abortSignal?: AbortSignal,
  ): Promise<ManagedNodeTestAcceptedBoundaryInternal> => {
    abortSignal?.throwIfAborted();
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
      epoch.workspaceInstanceId !== identity.workspaceInstanceId ||
      head.repositoryId !== identity.repositoryId ||
      head.workspaceId !== identity.workspaceId ||
      head.workspaceEpochId !== identity.workspaceEpochId
    ) {
      throw new Error('Gitoxide managed Node test durable workspace head is unavailable');
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
      throw new Error('Gitoxide managed Node test accepted workspace version is unavailable');
    }
    abortSignal?.throwIfAborted();
    return Object.freeze({
      repositoryId: identity.repositoryId,
      workspaceId: identity.workspaceId,
      workspaceEpochId: identity.workspaceEpochId,
      workspaceInstanceId: identity.workspaceInstanceId,
      acceptedWorkspaceVersionId: version.workspaceVersionId,
      acceptedEventId: version.acceptedEventId,
      acceptedHeadRevision: head.revision,
      acceptedCommitOid: version.commitOid,
      acceptedTreeOid: version.treeOid,
    });
  };
  const nodeTestSource: ManagedNodeTestSourceOwnerInternal = Object.freeze({
    readAcceptedBoundary: readNodeTestAcceptedBoundary,
    async materializeAcceptedTree(
      request: Parameters<ManagedNodeTestSourceOwnerInternal['materializeAcceptedTree']>[0],
    ) {
      const current = await readNodeTestAcceptedBoundary(request.abortSignal);
      if (
        request.acceptedCommitOid !== current.acceptedCommitOid ||
        request.acceptedTreeOid !== current.acceptedTreeOid
      ) {
        throw new Error(
          'Gitoxide managed Node test accepted boundary changed before materialization',
        );
      }
      const materialized = await materializeAcceptedTreeWithGitoxideHelperInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        capability: input.helperCapability,
        repositoryPath,
        acceptedCommitOid: current.acceptedCommitOid,
        destinationPath: request.destinationPath,
        managedTreePolicyVersion: 3,
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      });
      if (
        materialized.acceptedCommitOid !== current.acceptedCommitOid ||
        materialized.acceptedTreeOid !== current.acceptedTreeOid
      ) {
        throw new Error('Gitoxide managed Node test materialization identity is invalid');
      }
      return Object.freeze({
        acceptedCommitOid: materialized.acceptedCommitOid,
        acceptedTreeOid: materialized.acceptedTreeOid,
      });
    },
  });
  const nodeTransform = input.managedNodeTransform
    ? createManagedNodeTransformOwnerInternal({
        executionRootOwner: input.managedNodeTransform.executionRootOwner,
        sourceOwner: nodeTestSource,
        commandOwner: input.managedNodeTransform.commandOwner,
      })
    : undefined;
  const writeEdit = createGitoxideManagedWriteEditOwnerInternal({
    storageRootLease: input.storageRootLease,
    stores: input.stores,
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    repositoryPath,
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
    workspaceInstanceId: identity.workspaceInstanceId,
    ...(nodeTransform ? { managedNodeTransform: nodeTransform.admission } : {}),
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
  const sourceBranchPublish =
    sourceBinding.kind === 'git_repository_v1'
      ? createGitoxideManagedSourceBranchPublishOwnerInternal({
          invocationOwnerToken: input.invocationOwnerToken,
          helperCapability: input.helperCapability,
          managedRepositoryPath: repositoryPath,
          sourceRepositoryPath: sourceRoot,
          sourceBaseCommitOid: sourceCommitOid,
          sourceBaseTreeOid: sourceTreeOid,
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
              throw new Error(
                'Gitoxide managed source-branch publication durable workspace head is unavailable',
              );
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
              throw new Error(
                'Gitoxide managed source-branch publication accepted workspace version is unavailable',
              );
            }
            return Object.freeze({ commitOid: version.commitOid, treeOid: version.treeOid });
          },
        })
      : undefined;
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
  const history = createGitoxideManagedHistoryOwnerInternal({
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
    readHead: () => baselineAuthority.readHead(identity.workspaceId, identity.workspaceEpochId),
    readVersion: (workspaceVersionId) => baselineAuthority.readVersion(workspaceVersionId),
  });
  const historySuccessor = createGitoxideManagedHistorySuccessorOwnerInternal({
    stores: input.stores,
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    repositoryPath,
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
  });
  const gc = createGitoxideManagedGcOwnerInternal({
    storageRoot,
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
    repositoryPath,
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    readCandidateRetentionRoots: () => writeEdit.readCandidateRetentionRoots(),
  });
  await writeEdit.reconcileAcceptedProjection(input.abortSignal);
  const rebaseline = async (
    rebaselineId: string,
    abortSignal?: AbortSignal,
  ): Promise<GitoxideManagedSessionOwnerInternal> => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(rebaselineId)) {
      throw new Error('Gitoxide managed rebaseline identity is invalid');
    }
    const currentActiveEpoch = await activeEpochAuthority.readActiveEpoch(identity.workspaceId);
    if (!currentActiveEpoch) {
      throw new Error('Gitoxide managed active epoch is unavailable');
    }
    if (
      currentActiveEpoch.workspaceEpochId === identity.workspaceEpochId &&
      currentActiveEpoch.rebaselineId === rebaselineId
    ) {
      return openGitoxideManagedSessionOwnerInternal({
        ...input,
        workspaceEpochSeed: undefined,
        ...(abortSignal ? { abortSignal } : {}),
      });
    }
    if (currentActiveEpoch.workspaceEpochId !== identity.workspaceEpochId) {
      throw new Error('Gitoxide managed session owner is no longer the active epoch');
    }
    const rebased = await openGitoxideManagedSessionOwnerInternal({
      ...input,
      workspaceEpochSeed: rebaselineId,
      ...(abortSignal ? { abortSignal } : {}),
    });
    const targetEpoch = await baselineAuthority.readEpoch(
      identity.workspaceId,
      rebased.workspaceEpochId,
    );
    if (!targetEpoch) throw new Error('Gitoxide managed rebaseline target epoch is unavailable');
    const activationProof = Object.freeze({});
    verifiedActivations.set(
      activationProof,
      Object.freeze({
        activationEventId: managedEpochActivationEventId(identity.workspaceId, rebaselineId),
        committedAt: targetEpoch.committedAt + 1,
        activation: Object.freeze({
          repositoryId: identity.repositoryId,
          workspaceId: identity.workspaceId,
          previousWorkspaceEpochId: identity.workspaceEpochId,
          workspaceEpochId: rebased.workspaceEpochId,
          rebaselineId,
        }),
      }),
    );
    await activeEpochAuthority.commitActiveEpoch(activationProof);
    await input.failpoint?.('after_active_epoch_commit');
    return rebased;
  };
  return Object.freeze({
    sourceKind: sourceBinding.kind,
    repositoryPath,
    repositoryId: identity.repositoryId,
    baselineWorkspaceVersionId: identity.workspaceVersionId,
    gc,
    history,
    historySuccessor,
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
    inspection,
    nodeTestSource,
    nodeTransform,
    publish,
    sourceBranchPublish,
    review,
    restore,
    timeTravel,
    writeEdit,
    rebaseline,
  });
}

function deriveManagedSessionIdentity(
  sessionId: string,
  sourceKind: ResumableWorkspaceSourceKindInternal,
  workspaceEpochSeed?: string,
) {
  if (!sessionId.trim()) throw new Error('Gitoxide managed session identity is invalid');
  const workspaceDigest = createHash('sha256')
    .update('maka-resumable-managed-session-v3\0', 'utf8')
    .update(sourceKind, 'utf8')
    .update('\0')
    .update(sessionId, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const digest = workspaceEpochSeed
    ? createHash('sha256')
        .update('maka-resumable-managed-rebaseline-v2\0', 'utf8')
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

function managedEpochActivationEventId(workspaceId: string, rebaselineId: string): string {
  return `workspace-activation-${createHash('sha256')
    .update('maka-workspace-active-epoch-v1\0', 'utf8')
    .update(workspaceId, 'utf8')
    .update('\0')
    .update(rebaselineId, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}
