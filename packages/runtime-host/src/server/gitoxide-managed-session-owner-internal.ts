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
import { MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST } from '@maka/core/runtime-event';
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
  requireGitoxideHelperArtifactIdentityInternal,
  requireGitoxideHelperOperationsInternal,
} from './gitoxide-helper-artifact-authority-internal.js';
import { importFilesystemSnapshotWithGitoxideHelperInternal } from './gitoxide-helper-invocation-internal.js';
import {
  createGitoxideManagedWriteEditOwnerInternal,
  type GitoxideManagedWriteEditOwnerInternal,
} from './gitoxide-managed-write-edit-owner-internal.js';
import {
  createGitoxideManagedInspectionOwnerInternal,
  type GitoxideManagedInspectionOwnerInternal,
} from './gitoxide-managed-inspection-owner-internal.js';
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

const MANAGED_REPOSITORY_DIRECTORY = 'gitoxide-managed-repositories';
const ACCEPTED_REF = 'refs/maka/accepted';
const SOURCE_BASELINE_REF = 'refs/maka/source-baseline';

export interface GitoxideManagedSessionOwnerInternal {
  readonly sourceKind: ResumableWorkspaceSourceKindInternal;
  readonly repositoryPath: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly inspection: GitoxideManagedInspectionOwnerInternal;
  readonly writeEdit: GitoxideManagedWriteEditOwnerInternal;
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
  const identity = deriveManagedSessionIdentity(sourceRoot, input.sessionId, sourceBinding.kind);
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
    MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
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
  readonly abortSignal?: AbortSignal;
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
  const identity = deriveManagedSessionIdentity(sourceRoot, input.sessionId, sourceBinding.kind);
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
  const materializationProfileDigest = sha256(
    `maka-gitoxide-materialization-v4\0${sourceBinding.kind}\0${helperIdentity.sha256}\0`,
  );
  const policyHash = workspaceMutationPolicyHashV1(
    materializationProfileDigest,
    MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
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
  await writeEdit.reconcileAcceptedProjection(input.abortSignal);
  return Object.freeze({
    sourceKind: sourceBinding.kind,
    repositoryPath,
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
    inspection,
    writeEdit,
  });
}

function deriveManagedSessionIdentity(
  sourceRoot: string,
  sessionId: string,
  sourceKind: ResumableWorkspaceSourceKindInternal,
) {
  if (!sessionId.trim()) throw new Error('Gitoxide managed session identity is invalid');
  const digest = createHash('sha256')
    .update('maka-resumable-managed-session-v2\0', 'utf8')
    .update(sourceKind, 'utf8')
    .update('\0')
    .update(sourceRoot, 'utf8')
    .update('\0')
    .update(sessionId, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return Object.freeze({
    digest,
    repositoryId: `repository_${digest}`,
    workspaceId: `workspace_${digest}`,
    workspaceEpochId: `epoch_${digest}`,
    workspaceInstanceId: `instance_${digest}`,
    workspaceVersionId: `version_${digest}`,
  });
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
