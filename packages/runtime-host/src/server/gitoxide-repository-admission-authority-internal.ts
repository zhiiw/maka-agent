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
import { lstat, realpath } from 'node:fs/promises';
import {
  type GitoxideHelperInvocationCapability,
  requireGitoxideHelperArtifactIdentityInternal,
  requireGitoxideHelperOperationsInternal,
} from './gitoxide-helper-artifact-authority-internal.js';
import {
  createCandidateWithGitoxideHelperInternal,
  GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL,
  importSourceHeadWithGitoxideHelperInternal,
  inspectCanonicalRepositoryWithGitoxideHelperInternal,
  observeAcceptedRefWithGitoxideHelperInternal,
  promoteCandidateWithGitoxideHelperInternal,
  readTreeFileWithGitoxideHelperInternal,
  type GitoxideCandidateNoChangeV1,
  type GitoxideCandidatePublishedV1,
  type GitoxideCandidatePromotedV1,
  type GitoxideAcceptedRefObservationV1,
  type GitoxideSourceImportObservationV1,
  type GitoxideTreeFileReadV1,
  type GitoxideRepositoryRejectionV1,
} from './gitoxide-helper-invocation-internal.js';

export interface GitoxideRepositoryAdmissionCapability {
  readonly kind: 'gitoxide_repository_admission_capability_v1';
}

export interface GitoxideAcceptedRepositoryCapability {
  readonly kind: 'gitoxide_accepted_repository_capability_v1';
}

export interface GitoxideCandidateOutcomeCapability {
  readonly kind: 'gitoxide_candidate_outcome_capability_v1';
}

export interface GitoxideRepositoryAdmissionStateInternal {
  readonly protocolVersion: 1;
  readonly repositoryPath: string;
  readonly objectFormat: 'sha1';
  readonly headCommitOid: string;
  readonly headTreeOid: string;
  readonly helperArtifactSha256: `sha256:${string}`;
  readonly managedTreePolicyVersion: 3;
}

const MANAGED_TREE_POLICY_VERSION = 3 as const;
const ACCEPTED_REPOSITORY_REF = 'refs/maka/accepted' as const;
const SHA1_OID_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

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
        ? 'Gitoxide managed repository base does not match the accepted commit'
        : 'Gitoxide repository admission capability is invalid',
    );
    this.name = 'GitoxideRepositoryAdmissionAuthorityError';
  }
}

interface AdmissionCapabilityRecord {
  readonly admissionOwnerToken: object;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly state: GitoxideRepositoryAdmissionStateInternal;
}

interface AcceptedRepositoryCapabilityRecord {
  readonly acceptedRepositoryOwnerToken: object;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly repositoryDev: number;
  readonly repositoryIno: number;
  readonly acceptedRef: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly managedTreePolicyVersion: 3;
}

export type GitoxideAcceptedRepositoryStateInternal = Readonly<
  Omit<
    AcceptedRepositoryCapabilityRecord,
    'acceptedRepositoryOwnerToken' | 'invocationOwnerToken' | 'helperCapability'
  >
>;

interface CandidateOutcomeCapabilityRecord {
  readonly candidateOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly repositoryPath: string;
  readonly acceptedRef: string;
  readonly objectFormat: 'sha1';
  readonly managedTreePolicyVersion: 3;
  readonly helperArtifactSha256: `sha256:${string}`;
  readonly disposition: 'published' | 'no_change';
  readonly operationId: string;
  readonly requestDigestSha256: string;
  readonly resultContentSha256: `sha256:${string}`;
  readonly baseCommitOid: string;
  readonly baseTreeOid: string;
  readonly candidateCommitOid: string;
  readonly candidateTreeOid: string;
  readonly candidateRef: string;
  readonly resultBlobOid: string;
  readonly path: string;
}

const admissions = new WeakMap<object, AdmissionCapabilityRecord>();
const acceptedRepositories = new WeakMap<object, AcceptedRepositoryCapabilityRecord>();
const candidateOutcomes = new WeakMap<object, CandidateOutcomeCapabilityRecord>();

export async function admitGitoxideRepositoryInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly admissionOwnerToken: object;
  readonly repositoryPath: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideRepositoryAdmissionResultV1> {
  const deadlineAt =
    performance.now() + GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.inspectRepositoryMs;
  const { observation, repositoryPath } =
    await inspectCanonicalRepositoryWithGitoxideHelperInternal({
      invocationOwnerToken: input.invocationOwnerToken,
      capability: input.helperCapability,
      repositoryPath: input.repositoryPath,
      deadlineAt,
      abortSignal: input.abortSignal,
    });
  if (observation.kind === 'repository_rejected') return observation;
  const helperArtifactIdentity = requireGitoxideHelperArtifactIdentityInternal(
    input.invocationOwnerToken,
    input.helperCapability,
  );

  const capability = Object.freeze({
    kind: 'gitoxide_repository_admission_capability_v1' as const,
  });
  admissions.set(
    capability,
    Object.freeze({
      admissionOwnerToken: input.admissionOwnerToken,
      invocationOwnerToken: input.invocationOwnerToken,
      helperCapability: input.helperCapability,
      state: Object.freeze({
        protocolVersion: observation.protocolVersion,
        repositoryPath,
        objectFormat: observation.objectFormat,
        headCommitOid: observation.headCommitOid,
        headTreeOid: observation.headTreeOid,
        helperArtifactSha256: helperArtifactIdentity.sha256,
        managedTreePolicyVersion: MANAGED_TREE_POLICY_VERSION,
      }),
    }),
  );
  return Object.freeze({ kind: 'accepted' as const, capability });
}

export function requireGitoxideRepositoryAdmissionInternal(
  admissionOwnerToken: object,
  capability: GitoxideRepositoryAdmissionCapability,
): GitoxideRepositoryAdmissionStateInternal {
  return requireAdmissionRecord(admissionOwnerToken, capability).state;
}

export async function importAdmittedGitoxideRepositoryInternal(input: {
  readonly admissionOwnerToken: object;
  readonly repositoryCapability: GitoxideRepositoryAdmissionCapability;
  readonly acceptedRepositoryOwnerToken: object;
  readonly destinationRepositoryPath: string;
  readonly abortSignal?: AbortSignal;
}): Promise<
  GitoxideSourceImportObservationV1 & {
    readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  }
> {
  const admission = requireAdmissionRecord(input.admissionOwnerToken, input.repositoryCapability);
  const source = admission.state;
  requireGitoxideHelperOperationsInternal(
    admission.invocationOwnerToken,
    admission.helperCapability,
    ['create_candidate', 'promote_candidate', 'observe_accepted_ref', 'read_tree_file'],
  );
  const result = await importSourceHeadWithGitoxideHelperInternal({
    invocationOwnerToken: admission.invocationOwnerToken,
    capability: admission.helperCapability,
    sourceRepositoryPath: source.repositoryPath,
    expectedSourceHeadCommitOid: source.headCommitOid,
    destinationRepositoryPath: input.destinationRepositoryPath,
    baselineRef: ACCEPTED_REPOSITORY_REF,
    managedTreePolicyVersion: source.managedTreePolicyVersion,
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
  const destinationRepositoryPath = await realpath(input.destinationRepositoryPath).catch(() => {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  });
  const destinationRepositoryInfo = await lstat(destinationRepositoryPath);
  if (!destinationRepositoryInfo.isDirectory() || destinationRepositoryInfo.isSymbolicLink()) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const acceptedRepositoryCapability = issueAcceptedRepositoryCapability({
    acceptedRepositoryOwnerToken: input.acceptedRepositoryOwnerToken,
    invocationOwnerToken: admission.invocationOwnerToken,
    helperCapability: admission.helperCapability,
    repositoryPath: destinationRepositoryPath,
    repositoryDev: destinationRepositoryInfo.dev,
    repositoryIno: destinationRepositoryInfo.ino,
    acceptedRef: result.baselineRef,
    acceptedCommitOid: result.baselineCommitOid,
    acceptedTreeOid: result.baselineTreeOid,
    managedTreePolicyVersion: result.managedTreePolicyVersion,
  });
  return Object.freeze({ ...result, acceptedRepositoryCapability });
}

export function requireGitoxideAcceptedRepositoryInternal(
  acceptedRepositoryOwnerToken: object,
  acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability,
): GitoxideAcceptedRepositoryStateInternal {
  const record = requireAcceptedRepositoryRecord(
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability,
  );
  const {
    acceptedRepositoryOwnerToken: _acceptedOwner,
    invocationOwnerToken: _invocationOwner,
    helperCapability: _helperCapability,
    ...state
  } = record;
  return Object.freeze(state);
}

export async function reopenGitoxideAcceptedRepositoryInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly acceptedRepositoryOwnerToken: object;
  readonly repositoryPath: string;
  readonly acceptedRef: string;
  readonly expectedAcceptedCommitOid: string;
  readonly expectedAcceptedTreeOid: string;
  readonly managedTreePolicyVersion: 3;
  readonly abortSignal?: AbortSignal;
}): Promise<
  GitoxideAcceptedRefObservationV1 & {
    readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  }
> {
  requireGitoxideHelperOperationsInternal(input.invocationOwnerToken, input.helperCapability, [
    'observe_accepted_ref',
    'create_candidate',
    'promote_candidate',
    'read_tree_file',
  ]);
  const observed = await observeAcceptedRefWithGitoxideHelperInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    capability: input.helperCapability,
    repositoryPath: input.repositoryPath,
    acceptedRef: input.acceptedRef,
    expectedAcceptedCommitOid: input.expectedAcceptedCommitOid,
    expectedAcceptedTreeOid: input.expectedAcceptedTreeOid,
    managedTreePolicyVersion: input.managedTreePolicyVersion,
    abortSignal: input.abortSignal,
  });
  const repositoryPath = await realpath(input.repositoryPath).catch(() => {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  });
  const repositoryInfo = await lstat(repositoryPath);
  if (!repositoryInfo.isDirectory() || repositoryInfo.isSymbolicLink()) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const acceptedRepositoryCapability = issueAcceptedRepositoryCapability({
    acceptedRepositoryOwnerToken: input.acceptedRepositoryOwnerToken,
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    repositoryPath,
    repositoryDev: repositoryInfo.dev,
    repositoryIno: repositoryInfo.ino,
    acceptedRef: observed.acceptedRef,
    acceptedCommitOid: observed.acceptedCommitOid,
    acceptedTreeOid: observed.acceptedTreeOid,
    managedTreePolicyVersion: observed.managedTreePolicyVersion,
  });
  return Object.freeze({ ...observed, acceptedRepositoryCapability });
}

export async function createGitoxideCandidateInternal(input: {
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly candidateOwnerToken: object;
  readonly operationId: string;
  readonly path: string;
  readonly content: string;
  readonly abortSignal?: AbortSignal;
}): Promise<
  | (GitoxideCandidatePublishedV1 & {
      readonly candidateOutcomeCapability: GitoxideCandidateOutcomeCapability;
    })
  | (GitoxideCandidateNoChangeV1 & {
      readonly candidateOutcomeCapability: GitoxideCandidateOutcomeCapability;
    })
> {
  const managed = requireAcceptedRepositoryRecord(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  if (
    typeof input.operationId !== 'string' ||
    input.operationId.length === 0 ||
    Buffer.byteLength(input.operationId, 'utf8') > 1024
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const candidateRef = `refs/maka/candidates/${createHash('sha256').update(input.operationId).digest('hex')}`;
  const result = await createCandidateWithGitoxideHelperInternal({
    invocationOwnerToken: managed.invocationOwnerToken,
    capability: managed.helperCapability,
    repositoryPath: managed.repositoryPath,
    acceptedRef: managed.acceptedRef,
    expectedBaseCommitOid: managed.acceptedCommitOid,
    expectedBaseTreeOid: managed.acceptedTreeOid,
    candidateRef,
    path: input.path,
    content: input.content,
    managedTreePolicyVersion: managed.managedTreePolicyVersion,
    abortSignal: input.abortSignal,
  });
  if (result.kind === 'candidate_rejected') {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_managed_repository_base_mismatch',
    );
  }
  const helperArtifactIdentity = requireGitoxideHelperArtifactIdentityInternal(
    managed.invocationOwnerToken,
    managed.helperCapability,
  );
  const candidateOutcomeCapability = Object.freeze({
    kind: 'gitoxide_candidate_outcome_capability_v1' as const,
  });
  candidateOutcomes.set(
    candidateOutcomeCapability,
    Object.freeze({
      candidateOwnerToken: input.candidateOwnerToken,
      acceptedRepositoryCapability: input.acceptedRepositoryCapability,
      repositoryPath: managed.repositoryPath,
      acceptedRef: managed.acceptedRef,
      objectFormat: 'sha1' as const,
      managedTreePolicyVersion: managed.managedTreePolicyVersion,
      helperArtifactSha256: helperArtifactIdentity.sha256,
      disposition:
        result.kind === 'candidate_published' ? ('published' as const) : ('no_change' as const),
      operationId: input.operationId,
      requestDigestSha256: result.requestDigestSha256,
      resultContentSha256:
        `sha256:${createHash('sha256').update(input.content, 'utf8').digest('hex')}` as const,
      baseCommitOid: result.baseCommitOid,
      baseTreeOid: result.baseTreeOid,
      candidateCommitOid: result.candidateCommitOid,
      candidateTreeOid: result.candidateTreeOid,
      candidateRef: result.candidateRef,
      resultBlobOid: result.resultBlobOid,
      path: result.path,
    }),
  );
  return Object.freeze({ ...result, candidateOutcomeCapability });
}

/**
 * Reconstitutes only the in-process bearer needed to promote an already
 * durable candidate. The caller must own the strict receipt decoder; this
 * seam binds that receipt back to the current accepted repository and helper
 * artifact without re-running the mutation transform or candidate creation.
 */
export function reopenGitoxideCandidateOutcomeInternal(input: {
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly candidateOwnerToken: object;
  readonly operationId: string;
  readonly disposition: 'published' | 'no_change';
  readonly helperArtifactSha256: `sha256:${string}`;
  readonly requestDigestSha256: string;
  readonly resultContentSha256: `sha256:${string}`;
  readonly baseCommitOid: string;
  readonly baseTreeOid: string;
  readonly candidateCommitOid: string;
  readonly candidateTreeOid: string;
  readonly candidateRef: string;
  readonly resultBlobOid: string;
  readonly path: string;
}): GitoxideCandidateOutcomeCapability {
  const managed = requireAcceptedRepositoryRecord(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  const expectedCandidateRef = `refs/maka/candidates/${createHash('sha256')
    .update(input.operationId)
    .digest('hex')}`;
  const helperArtifact = requireGitoxideHelperArtifactIdentityInternal(
    managed.invocationOwnerToken,
    managed.helperCapability,
  );
  if (
    input.operationId.length === 0 ||
    Buffer.byteLength(input.operationId, 'utf8') > 1024 ||
    input.helperArtifactSha256 !== helperArtifact.sha256 ||
    input.baseCommitOid !== managed.acceptedCommitOid ||
    input.baseTreeOid !== managed.acceptedTreeOid ||
    input.candidateRef !== expectedCandidateRef ||
    !SHA1_OID_PATTERN.test(input.candidateCommitOid) ||
    !SHA1_OID_PATTERN.test(input.candidateTreeOid) ||
    !SHA1_OID_PATTERN.test(input.resultBlobOid) ||
    !/^[0-9a-f]{64}$/u.test(input.requestDigestSha256) ||
    !SHA256_DIGEST_PATTERN.test(input.resultContentSha256) ||
    (input.disposition === 'published' && input.candidateCommitOid === input.baseCommitOid) ||
    (input.disposition === 'no_change' && input.candidateCommitOid !== input.baseCommitOid)
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const candidateOutcomeCapability = Object.freeze({
    kind: 'gitoxide_candidate_outcome_capability_v1' as const,
  });
  candidateOutcomes.set(
    candidateOutcomeCapability,
    Object.freeze({
      candidateOwnerToken: input.candidateOwnerToken,
      acceptedRepositoryCapability: input.acceptedRepositoryCapability,
      repositoryPath: managed.repositoryPath,
      acceptedRef: managed.acceptedRef,
      objectFormat: 'sha1' as const,
      managedTreePolicyVersion: managed.managedTreePolicyVersion,
      helperArtifactSha256: input.helperArtifactSha256,
      disposition: input.disposition,
      operationId: input.operationId,
      requestDigestSha256: input.requestDigestSha256,
      resultContentSha256: input.resultContentSha256,
      baseCommitOid: input.baseCommitOid,
      baseTreeOid: input.baseTreeOid,
      candidateCommitOid: input.candidateCommitOid,
      candidateTreeOid: input.candidateTreeOid,
      candidateRef: input.candidateRef,
      resultBlobOid: input.resultBlobOid,
      path: input.path,
    }),
  );
  return candidateOutcomeCapability;
}

export async function readGitoxideTreeFileInternal(input: {
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly path: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideTreeFileReadV1> {
  const managed = requireAcceptedRepositoryRecord(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  const result = await readTreeFileWithGitoxideHelperInternal({
    invocationOwnerToken: managed.invocationOwnerToken,
    capability: managed.helperCapability,
    repositoryPath: managed.repositoryPath,
    acceptedCommitOid: managed.acceptedCommitOid,
    path: input.path,
    managedTreePolicyVersion: managed.managedTreePolicyVersion,
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

export async function promoteGitoxideCandidateInternal(input: {
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly candidateOwnerToken: object;
  readonly candidateOutcomeCapability: GitoxideCandidateOutcomeCapability;
  readonly nextAcceptedRepositoryOwnerToken: object;
  readonly abortSignal?: AbortSignal;
}): Promise<
  GitoxideCandidatePromotedV1 & {
    readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  }
> {
  const managed = requireAcceptedRepositoryRecord(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  const candidate = candidateOutcomes.get(input.candidateOutcomeCapability);
  if (
    !candidate ||
    candidate.candidateOwnerToken !== input.candidateOwnerToken ||
    candidate.acceptedRepositoryCapability !== input.acceptedRepositoryCapability ||
    candidate.repositoryPath !== managed.repositoryPath ||
    candidate.acceptedRef !== managed.acceptedRef ||
    candidate.baseCommitOid !== managed.acceptedCommitOid ||
    candidate.baseTreeOid !== managed.acceptedTreeOid
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const result = await promoteCandidateWithGitoxideHelperInternal({
    invocationOwnerToken: managed.invocationOwnerToken,
    capability: managed.helperCapability,
    repositoryPath: managed.repositoryPath,
    acceptedRef: candidate.acceptedRef,
    expectedBaseCommitOid: candidate.baseCommitOid,
    candidateRef: candidate.candidateRef,
    expectedCandidateCommitOid: candidate.candidateCommitOid,
    expectedCandidateTreeOid: candidate.candidateTreeOid,
    expectedResultBlobOid: candidate.resultBlobOid,
    requestDigestSha256: candidate.requestDigestSha256,
    path: candidate.path,
    managedTreePolicyVersion: candidate.managedTreePolicyVersion,
    abortSignal: input.abortSignal,
  });
  if (result.kind === 'candidate_promotion_rejected') {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_managed_repository_base_mismatch',
    );
  }
  const repositoryInfo = await lstat(managed.repositoryPath);
  if (
    !repositoryInfo.isDirectory() ||
    repositoryInfo.isSymbolicLink() ||
    repositoryInfo.dev !== managed.repositoryDev ||
    repositoryInfo.ino !== managed.repositoryIno ||
    result.acceptedCommitOid !== candidate.candidateCommitOid ||
    result.acceptedTreeOid !== candidate.candidateTreeOid
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const acceptedRepositoryCapability = issueAcceptedRepositoryCapability({
    acceptedRepositoryOwnerToken: input.nextAcceptedRepositoryOwnerToken,
    invocationOwnerToken: managed.invocationOwnerToken,
    helperCapability: managed.helperCapability,
    repositoryPath: managed.repositoryPath,
    repositoryDev: repositoryInfo.dev,
    repositoryIno: repositoryInfo.ino,
    acceptedRef: result.acceptedRef,
    acceptedCommitOid: result.acceptedCommitOid,
    acceptedTreeOid: result.acceptedTreeOid,
    managedTreePolicyVersion: result.managedTreePolicyVersion,
  });
  return Object.freeze({ ...result, acceptedRepositoryCapability });
}

export function requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal(input: {
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly candidateOwnerToken: object;
  readonly candidateOutcomeCapability: GitoxideCandidateOutcomeCapability;
}): Readonly<
  Omit<CandidateOutcomeCapabilityRecord, 'candidateOwnerToken' | 'acceptedRepositoryCapability'>
> {
  requireAcceptedRepositoryRecord(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  const record = candidateOutcomes.get(input.candidateOutcomeCapability);
  if (
    !record ||
    record.candidateOwnerToken !== input.candidateOwnerToken ||
    record.acceptedRepositoryCapability !== input.acceptedRepositoryCapability
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const {
    candidateOwnerToken: _candidateOwner,
    acceptedRepositoryCapability: _acceptedCapability,
    ...proof
  } = record;
  return Object.freeze(proof);
}

function issueAcceptedRepositoryCapability(
  record: AcceptedRepositoryCapabilityRecord,
): GitoxideAcceptedRepositoryCapability {
  const capability = Object.freeze({
    kind: 'gitoxide_accepted_repository_capability_v1' as const,
  });
  acceptedRepositories.set(capability, Object.freeze(record));
  return capability;
}

function requireAcceptedRepositoryRecord(
  ownerToken: object,
  capability: GitoxideAcceptedRepositoryCapability,
): AcceptedRepositoryCapabilityRecord {
  const record = acceptedRepositories.get(capability);
  if (!record || record.acceptedRepositoryOwnerToken !== ownerToken) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return record;
}

function requireAdmissionRecord(
  admissionOwnerToken: object,
  capability: GitoxideRepositoryAdmissionCapability,
): AdmissionCapabilityRecord {
  const record = admissions.get(capability);
  if (!record || record.admissionOwnerToken !== admissionOwnerToken) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return record;
}
