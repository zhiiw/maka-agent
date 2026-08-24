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

import { realpath } from 'node:fs/promises';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import {
  importSourceHeadWithGitoxideHelperInternal,
  inspectRepositoryWithGitoxideHelperInternal,
  createSuccessorWithGitoxideHelperInternal,
  materializeProjectionWithGitoxideHelperInternal,
  observeProjectionWithGitoxideHelperInternal,
  readTreeFileWithGitoxideHelperInternal,
  type GitoxideProjectionMaterializedV1,
  type GitoxideProjectionObservationV1,
  type GitoxideSuccessorPublishedV1,
  type GitoxideSourceImportObservationV1,
  type GitoxideTreeFileReadV1,
  type GitoxideRepositoryRejectionV1,
} from './gitoxide-helper-invocation-internal.js';

export interface GitoxideRepositoryAdmissionCapability {
  readonly kind: 'gitoxide_repository_admission_capability_v1';
}

export interface GitoxideManagedRepositoryCapability {
  readonly kind: 'gitoxide_managed_repository_capability_v1';
}

export interface GitoxideProjectionCapability {
  readonly kind: 'gitoxide_projection_capability_v1';
}

export interface GitoxideManagedRepositoryImportResultV1 extends GitoxideSourceImportObservationV1 {
  readonly managedRepositoryCapability: GitoxideManagedRepositoryCapability;
}

export interface GitoxideManagedRepositorySuccessorResultV1 extends GitoxideSuccessorPublishedV1 {
  readonly managedRepositoryCapability: GitoxideManagedRepositoryCapability;
}

export interface GitoxideProjectionMaterializationResultV1
  extends GitoxideProjectionMaterializedV1 {
  readonly projectionCapability: GitoxideProjectionCapability;
}

export interface GitoxideRepositoryAdmissionStateInternal {
  readonly protocolVersion: 1;
  readonly repositoryPath: string;
  readonly objectFormat: 'sha1';
  readonly headCommitOid: string;
  readonly headTreeOid: string;
}

export type GitoxideRepositoryAdmissionResultV1 =
  | {
      readonly kind: 'accepted';
      readonly capability: GitoxideRepositoryAdmissionCapability;
    }
  | GitoxideRepositoryRejectionV1;

export class GitoxideRepositoryAdmissionAuthorityError extends Error {
  constructor(
    readonly code:
      | 'gitoxide_repository_admission_capability_invalid'
      | 'gitoxide_managed_repository_base_mismatch',
  ) {
    super(
      code === 'gitoxide_managed_repository_base_mismatch'
        ? 'Gitoxide managed repository base no longer matches'
        : 'Gitoxide repository admission capability is invalid',
    );
    this.name = 'GitoxideRepositoryAdmissionAuthorityError';
  }
}

interface AdmissionCapabilityRecord {
  readonly admissionOwnerToken: object;
  readonly state: GitoxideRepositoryAdmissionStateInternal;
}

const admissions = new WeakMap<object, AdmissionCapabilityRecord>();

interface ManagedRepositoryCapabilityRecord {
  readonly managedRepositoryOwnerToken: object;
  readonly repositoryPath: string;
  readonly acceptedRef: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
}

const managedRepositories = new WeakMap<object, ManagedRepositoryCapabilityRecord>();

interface ProjectionCapabilityRecord {
  readonly projectionOwnerToken: object;
  readonly repositoryPath: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly projectionPath: string;
}

const projections = new WeakMap<object, ProjectionCapabilityRecord>();

export async function admitGitoxideRepositoryInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly admissionOwnerToken: object;
  readonly repositoryPath: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideRepositoryAdmissionResultV1> {
  const repositoryPath = await realpath(input.repositoryPath);
  const observation = await inspectRepositoryWithGitoxideHelperInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    capability: input.helperCapability,
    repositoryPath,
    abortSignal: input.abortSignal,
  });
  if (observation.kind === 'repository_rejected') return observation;

  const capability = Object.freeze({
    kind: 'gitoxide_repository_admission_capability_v1' as const,
  });
  admissions.set(
    capability,
    Object.freeze({
      admissionOwnerToken: input.admissionOwnerToken,
      state: Object.freeze({
        protocolVersion: observation.protocolVersion,
        repositoryPath,
        objectFormat: observation.objectFormat,
        headCommitOid: observation.headCommitOid,
        headTreeOid: observation.headTreeOid,
      }),
    }),
  );
  return Object.freeze({ kind: 'accepted' as const, capability });
}

export function requireGitoxideRepositoryAdmissionInternal(
  admissionOwnerToken: object,
  capability: GitoxideRepositoryAdmissionCapability,
): GitoxideRepositoryAdmissionStateInternal {
  const state = admissions.get(capability);
  if (!state || state.admissionOwnerToken !== admissionOwnerToken) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return state.state;
}

export async function importAdmittedGitoxideRepositoryInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly admissionOwnerToken: object;
  readonly repositoryCapability: GitoxideRepositoryAdmissionCapability;
  readonly managedRepositoryOwnerToken: object;
  readonly destinationRepositoryPath: string;
  readonly baselineRef: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideManagedRepositoryImportResultV1> {
  const source = requireGitoxideRepositoryAdmissionInternal(
    input.admissionOwnerToken,
    input.repositoryCapability,
  );
  const result = await importSourceHeadWithGitoxideHelperInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    capability: input.helperCapability,
    sourceRepositoryPath: source.repositoryPath,
    expectedSourceHeadCommitOid: source.headCommitOid,
    destinationRepositoryPath: input.destinationRepositoryPath,
    baselineRef: input.baselineRef,
    abortSignal: input.abortSignal,
  });
  if (
    result.sourceHeadCommitOid !== source.headCommitOid ||
    result.sourceTreeOid !== source.headTreeOid
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const managedRepositoryCapability = issueManagedRepositoryCapability({
    managedRepositoryOwnerToken: input.managedRepositoryOwnerToken,
    repositoryPath: input.destinationRepositoryPath,
    acceptedRef: result.baselineRef,
    acceptedCommitOid: result.baselineCommitOid,
    acceptedTreeOid: result.baselineTreeOid,
  });
  return Object.freeze({ ...result, managedRepositoryCapability });
}

export async function createGitoxideSuccessorInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly managedRepositoryOwnerToken: object;
  readonly managedRepositoryCapability: GitoxideManagedRepositoryCapability;
  readonly path: string;
  readonly content: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideManagedRepositorySuccessorResultV1> {
  const managed = requireManagedRepositoryCapability(
    input.managedRepositoryOwnerToken,
    input.managedRepositoryCapability,
  );
  const result = await createSuccessorWithGitoxideHelperInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    capability: input.helperCapability,
    repositoryPath: managed.repositoryPath,
    expectedBaseCommitOid: managed.acceptedCommitOid,
    targetRef: managed.acceptedRef,
    path: input.path,
    content: input.content,
    abortSignal: input.abortSignal,
  });
  if (result.kind === 'successor_rejected') {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_managed_repository_base_mismatch',
    );
  }
  if (
    result.baseCommitOid !== managed.acceptedCommitOid ||
    result.targetRef !== managed.acceptedRef
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const managedRepositoryCapability = issueManagedRepositoryCapability({
    managedRepositoryOwnerToken: input.managedRepositoryOwnerToken,
    repositoryPath: managed.repositoryPath,
    acceptedRef: managed.acceptedRef,
    acceptedCommitOid: result.successorCommitOid,
    acceptedTreeOid: result.successorTreeOid,
  });
  return Object.freeze({ ...result, managedRepositoryCapability });
}

export async function materializeGitoxideProjectionInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly managedRepositoryOwnerToken: object;
  readonly managedRepositoryCapability: GitoxideManagedRepositoryCapability;
  readonly projectionOwnerToken: object;
  readonly destinationPath: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideProjectionMaterializationResultV1> {
  const managed = requireManagedRepositoryCapability(
    input.managedRepositoryOwnerToken,
    input.managedRepositoryCapability,
  );
  const result = await materializeProjectionWithGitoxideHelperInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    capability: input.helperCapability,
    repositoryPath: managed.repositoryPath,
    acceptedCommitOid: managed.acceptedCommitOid,
    destinationPath: input.destinationPath,
    abortSignal: input.abortSignal,
  });
  if (
    result.acceptedCommitOid !== managed.acceptedCommitOid ||
    result.acceptedTreeOid !== managed.acceptedTreeOid
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const projectionCapability = Object.freeze({
    kind: 'gitoxide_projection_capability_v1' as const,
  });
  projections.set(
    projectionCapability,
    Object.freeze({
      projectionOwnerToken: input.projectionOwnerToken,
      repositoryPath: managed.repositoryPath,
      acceptedCommitOid: managed.acceptedCommitOid,
      acceptedTreeOid: managed.acceptedTreeOid,
      projectionPath: result.destinationPath,
    }),
  );
  return Object.freeze({ ...result, projectionCapability });
}

export async function observeGitoxideProjectionInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly projectionOwnerToken: object;
  readonly projectionCapability: GitoxideProjectionCapability;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideProjectionObservationV1> {
  const projection = projections.get(input.projectionCapability);
  if (!projection || projection.projectionOwnerToken !== input.projectionOwnerToken) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const result = await observeProjectionWithGitoxideHelperInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    capability: input.helperCapability,
    repositoryPath: projection.repositoryPath,
    acceptedCommitOid: projection.acceptedCommitOid,
    projectionPath: projection.projectionPath,
    abortSignal: input.abortSignal,
  });
  if (
    result.acceptedCommitOid !== projection.acceptedCommitOid ||
    result.acceptedTreeOid !== projection.acceptedTreeOid ||
    result.projectionPath !== projection.projectionPath
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return result;
}

export async function readGitoxideTreeFileInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly managedRepositoryOwnerToken: object;
  readonly managedRepositoryCapability: GitoxideManagedRepositoryCapability;
  readonly path: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideTreeFileReadV1> {
  const managed = requireManagedRepositoryCapability(
    input.managedRepositoryOwnerToken,
    input.managedRepositoryCapability,
  );
  const result = await readTreeFileWithGitoxideHelperInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    capability: input.helperCapability,
    repositoryPath: managed.repositoryPath,
    acceptedCommitOid: managed.acceptedCommitOid,
    path: input.path,
    abortSignal: input.abortSignal,
  });
  if (
    result.acceptedCommitOid !== managed.acceptedCommitOid ||
    result.acceptedTreeOid !== managed.acceptedTreeOid
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return result;
}

function issueManagedRepositoryCapability(
  record: ManagedRepositoryCapabilityRecord,
): GitoxideManagedRepositoryCapability {
  const capability = Object.freeze({
    kind: 'gitoxide_managed_repository_capability_v1' as const,
  });
  managedRepositories.set(capability, Object.freeze({ ...record }));
  return capability;
}

function requireManagedRepositoryCapability(
  ownerToken: object,
  capability: GitoxideManagedRepositoryCapability,
): ManagedRepositoryCapabilityRecord {
  const record = managedRepositories.get(capability);
  if (!record || record.managedRepositoryOwnerToken !== ownerToken) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return record;
}
