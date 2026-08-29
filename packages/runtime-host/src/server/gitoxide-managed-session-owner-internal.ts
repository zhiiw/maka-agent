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
import {
  WORKSPACE_MATERIALIZATION_SEMANTICS_V1,
  type WorkspaceBaselineAuthorityInput,
} from '@maka/core/workspace-version-authority';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  issueExecutionStoresWorkspaceBaselineAuthorityInternal,
  requireExecutionStoresWorkspaceBaselineAuthorityInternal,
} from '@maka/storage/execution-stores-workspace-authority-internal';
import { runWithStorageRootLease, type StorageRootLease } from '@maka/storage/root-authority';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import {
  createGitoxideManagedWriteEditOwnerInternal,
  type GitoxideManagedWriteEditOwnerInternal,
} from './gitoxide-managed-write-edit-owner-internal.js';
import {
  admitGitoxideRepositoryInternal,
  importAdmittedGitoxideRepositoryInternal,
  requireGitoxideRepositoryAdmissionInternal,
} from './gitoxide-repository-admission-authority-internal.js';

const MANAGED_REPOSITORY_DIRECTORY = 'gitoxide-managed-repositories';

export interface GitoxideManagedSessionOwnerInternal {
  readonly repositoryPath: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly writeEdit: GitoxideManagedWriteEditOwnerInternal;
}

export type GitoxideManagedSessionOwnerFailpoint = 'after_repository_import';

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
  const identity = deriveManagedSessionIdentity(sourceRoot, input.sessionId);
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
  const policyHash = sha256(
    `maka-managed-write-edit-policy-v1\0${materializationProfileDigest}\0${MANAGED_MUTATION_EXECUTION_PROFILE_V1}\0`,
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
  await writeEdit.reconcileAcceptedProjection(input.abortSignal);
  return Object.freeze({
    repositoryPath,
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
    writeEdit,
  });
}

function deriveManagedSessionIdentity(sourceRoot: string, sessionId: string) {
  if (!sessionId.trim()) throw new Error('Gitoxide managed session identity is invalid');
  const digest = createHash('sha256')
    .update('maka-gitoxide-managed-session-v1\0', 'utf8')
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
