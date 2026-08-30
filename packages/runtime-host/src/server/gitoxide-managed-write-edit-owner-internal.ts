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
import { isDeepStrictEqual } from 'node:util';
import {
  isCanonicalManagedMutationPathV1,
  MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  type RuntimeEvent,
  type RuntimeEventManagedWorkspaceMutationV2,
} from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import type {
  WorkspaceEpochRecordV1,
  WorkspaceHeadRecordV1,
  WorkspaceSuccessorAuthorityInput,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import type {
  RuntimeManagedMutationAdmission,
  RuntimeManagedMutationOperationProof,
  RuntimeManagedMutationSettlement,
  ToolRuntimeInput,
} from '@maka/runtime/tool-runtime';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  issueExecutionStoresWorkspaceMutationAuthorityInternal,
  requireExecutionStoresWorkspaceMutationAuthorityInternal,
  type ExecutionStoresWorkspaceMutationAuthorityInternal,
} from '@maka/storage/execution-stores-workspace-authority-internal';
import type { StorageRootLease } from '@maka/storage/root-authority';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import { GitoxideHelperInvocationError } from './gitoxide-helper-invocation-internal.js';
import {
  createGitoxideMutationCandidateAuthorityInternal,
  type GitoxideMutationCandidateProofV1,
} from './gitoxide-mutation-candidate-receipt-authority-internal.js';
import {
  readGitoxideTreeFileInternal,
  reopenGitoxideAcceptedRepositoryInternal,
  type GitoxideAcceptedRepositoryCapability,
} from './gitoxide-repository-admission-authority-internal.js';

const ACCEPTED_REF = 'refs/maka/accepted';
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;

export type GitoxideManagedWriteEditOwnerFailpoint = 'after_workspace_successor_commit';

export class GitoxideManagedWriteEditRecoveryError extends Error {
  constructor(
    readonly code:
      | 'gitoxide_managed_mutation_replay_required'
      | 'gitoxide_managed_projection_conflict',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitoxideManagedWriteEditRecoveryError';
  }
}

export interface GitoxideManagedWriteEditOwnerInternal {
  readonly admitManagedMutation: NonNullable<ToolRuntimeInput['admitManagedMutation']>;
  reconcileAcceptedProjection(abortSignal?: AbortSignal): Promise<'already_current' | 'promoted'>;
}

export interface GitoxideManagedWriteEditOwnerInputInternal {
  readonly storageRootLease: StorageRootLease<'interactive', 'write'>;
  readonly stores: InteractiveExecutionStoresWriter;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly failpoint?: (point: GitoxideManagedWriteEditOwnerFailpoint) => void | Promise<void>;
}

export function createGitoxideManagedWriteEditOwnerInternal(
  input: GitoxideManagedWriteEditOwnerInputInternal,
): GitoxideManagedWriteEditOwnerInternal {
  const ownerToken = {};
  const issuedSuccessors = new WeakMap<object, WorkspaceSuccessorAuthorityInput>();
  const capability = issueExecutionStoresWorkspaceMutationAuthorityInternal({
    ownerToken,
    stores: input.stores,
    verifyCandidate(candidateOutcome) {
      const successor = issuedSuccessors.get(candidateOutcome);
      if (!successor) throw new Error('Managed Write/Edit candidate proof is invalid');
      return successor;
    },
  });
  // Resolve the capability now so an invalid execution-stores owner cannot be
  // published as a usable Write/Edit admission.
  const persistence = requireExecutionStoresWorkspaceMutationAuthorityInternal(
    ownerToken,
    capability,
  );

  const admitManagedMutation: NonNullable<ToolRuntimeInput['admitManagedMutation']> = async (
    request,
  ) => {
    if (request.toolName !== 'Write' && request.toolName !== 'Edit') {
      throw new Error('Gitoxide managed mutation admits only Write and Edit');
    }
    const path = requireCanonicalPath(request.persistedArgs);
    const epoch = await persistence.readEpoch(input.workspaceId, input.workspaceEpochId);
    if (!epochMatchesOwner(epoch, input.workspaceId, input.workspaceEpochId)) {
      throw new Error('Gitoxide managed mutation durable workspace epoch is unavailable');
    }
    const head = await persistence.readHead(input.workspaceId, input.workspaceEpochId);
    if (!head) throw new Error('Gitoxide managed mutation has no accepted workspace head');
    const version = await persistence.readVersion(head.workspaceVersionId);
    if (!version || !versionMatchesHead(version, head, epoch)) {
      throw new Error('Gitoxide managed mutation workspace version is unavailable');
    }
    request.abortSignal.throwIfAborted();

    const acceptedRepositoryOwnerToken = {};
    const accepted = await reopenGitoxideAcceptedRepositoryInternal({
      invocationOwnerToken: input.invocationOwnerToken,
      helperCapability: input.helperCapability,
      acceptedRepositoryOwnerToken,
      repositoryPath: input.repositoryPath,
      acceptedRef: ACCEPTED_REF,
      expectedAcceptedCommitOid: head.commitOid,
      expectedAcceptedTreeOid: head.treeOid,
      managedTreePolicyVersion: 3,
      abortSignal: request.abortSignal,
    });
    const baseContent = await readAcceptedFile({
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: accepted.acceptedRepositoryCapability,
      path,
      abortSignal: request.abortSignal,
    });
    const candidateAuthority = await createGitoxideMutationCandidateAuthorityInternal({
      storageRootLease: input.storageRootLease,
      baseHead: head,
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: accepted.acceptedRepositoryCapability,
      projectionOwnerToken: ownerToken,
    });
    const durableDispatch = freezeManagedDispatch({
      epoch,
      head,
      expectedPath: path,
    });

    const admission: RuntimeManagedMutationAdmission = Object.freeze({
      durableDispatch,
      immutableBase: Object.freeze({ content: baseContent }),
      execute: async (operation: () => Promise<RuntimeManagedMutationOperationProof>) =>
        settleManagedMutation({
          request,
          operation,
          path,
          head,
          version,
          epoch,
          persistence,
          candidateAuthority,
          issuedSuccessors,
          ownerToken,
          failpoint: input.failpoint,
        }),
      dispose: async () => undefined,
    });
    return admission;
  };

  const reconcileAcceptedProjection = async (
    abortSignal?: AbortSignal,
  ): Promise<'already_current' | 'promoted'> => {
    abortSignal?.throwIfAborted();
    const epoch = await persistence.readEpoch(input.workspaceId, input.workspaceEpochId);
    if (!epochMatchesOwner(epoch, input.workspaceId, input.workspaceEpochId)) {
      throw new Error('Gitoxide projection recovery durable workspace epoch is unavailable');
    }
    const head = await persistence.readHead(input.workspaceId, input.workspaceEpochId);
    if (!head) throw new Error('Gitoxide projection recovery has no accepted workspace head');
    const version = await persistence.readVersion(head.workspaceVersionId);
    if (!version || !versionMatchesHead(version, head, epoch)) {
      throw new Error('Gitoxide projection recovery workspace version is unavailable');
    }
    const activeMutation = await persistence.readActiveMutation(epoch.workspaceInstanceId);
    if (activeMutation) {
      throw new GitoxideManagedWriteEditRecoveryError(
        'gitoxide_managed_mutation_replay_required',
        `Managed mutation ${activeMutation.operationId} must be resumed before projection reconciliation`,
      );
    }
    try {
      await reopenExactAcceptedRepository({
        input,
        head,
        ...(abortSignal ? { abortSignal } : {}),
      });
      return 'already_current';
    } catch (currentProjectionError) {
      if (!isAcceptedRefTargetMismatch(currentProjectionError)) throw currentProjectionError;
      if (version.protocol !== 'workspace_version_accepted_v1' || version.parents.length !== 1) {
        throw new GitoxideManagedWriteEditRecoveryError(
          'gitoxide_managed_projection_conflict',
          'Gitoxide accepted projection does not match its baseline head',
          {
            cause: currentProjectionError,
          },
        );
      }
      const parent = await persistence.readVersion(version.parents[0]);
      if (!parent || !parentMatchesSuccessor(parent, version)) {
        throw new Error('Gitoxide projection recovery parent version is unavailable', {
          cause: currentProjectionError,
        });
      }
      const parentHead: WorkspaceHeadRecordV1 = Object.freeze({
        repositoryId: parent.repositoryId,
        workspaceId: parent.workspaceId,
        workspaceEpochId: parent.workspaceEpochId,
        workspaceVersionId: parent.workspaceVersionId,
        acceptedEventId: parent.acceptedEventId,
        commitOid: parent.commitOid,
        treeOid: parent.treeOid,
        revision: version.baseHeadRevision,
      });
      const acceptedRepositoryOwnerToken = {};
      let accepted: Awaited<ReturnType<typeof reopenExactAcceptedRepository>>;
      try {
        accepted = await reopenExactAcceptedRepository({
          input,
          head: parentHead,
          acceptedRepositoryOwnerToken,
          ...(abortSignal ? { abortSignal } : {}),
        });
      } catch (parentProjectionError) {
        if (!isAcceptedRefTargetMismatch(parentProjectionError)) throw parentProjectionError;
        throw new GitoxideManagedWriteEditRecoveryError(
          'gitoxide_managed_projection_conflict',
          'Gitoxide accepted projection matches neither durable head nor parent',
          {
            cause: new AggregateError([currentProjectionError, parentProjectionError]),
          },
        );
      }
      const evidence = await persistence.readMutationEvidence(version.origin.operationId);
      if (!evidence) throw new Error('Gitoxide projection recovery operation evidence is missing');
      const path = validateAcceptedSuccessorEvidence({
        epoch,
        parentHead,
        successorVersion: version,
        evidence,
      });
      const candidateAuthority = await createGitoxideMutationCandidateAuthorityInternal({
        storageRootLease: input.storageRootLease,
        baseHead: parentHead,
        acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: accepted.acceptedRepositoryCapability,
        projectionOwnerToken: ownerToken,
      });
      const candidate = await candidateAuthority.reopen({
        operationId: version.origin.operationId,
        expectedRepositoryId: parentHead.repositoryId,
        expectedWorkspaceId: parentHead.workspaceId,
        expectedWorkspaceEpochId: parentHead.workspaceEpochId,
        expectedBaseWorkspaceVersionId: parentHead.workspaceVersionId,
        expectedBaseAcceptedEventId: parentHead.acceptedEventId,
        expectedBaseHeadRevision: parentHead.revision,
        expectedBaseCommitOid: parentHead.commitOid,
        expectedBaseTreeOid: parentHead.treeOid,
        expectedCandidateCommitOid: version.commitOid,
        expectedCandidateTreeOid: version.treeOid,
        expectedPath: path,
        expectedExecutionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
      });
      const successor = buildSuccessor({
        operationId: version.origin.operationId,
        dispatchEventId: evidence.dispatchEvent.id,
        outcome: evidence.outcomeEvent,
        head: parentHead,
        version: parent,
        candidate,
      });
      if (!successorMatchesVersion(successor, version)) {
        throw new Error('Gitoxide projection recovery candidate conflicts with durable successor');
      }
      issuedSuccessors.set(candidate, successor);
      const replay = await persistence.commitSuccessor({
        candidateOutcome: candidate,
        toolOutcome: toolOutcome(version.origin.operationId, evidence.outcomeEvent),
      });
      if (replay.created || !headRecordsEqual(replay.committedSuccessor, head)) {
        throw new Error('Gitoxide projection recovery did not exact-replay the durable successor');
      }
      const promoted = await candidateAuthority.promote({
        proof: candidate,
        projectionCapability: replay.projectionCapability,
        nextAcceptedRepositoryOwnerToken: {},
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (
        promoted.acceptedCommitOid !== head.commitOid ||
        promoted.acceptedTreeOid !== head.treeOid
      ) {
        throw new Error('Recovered Gitoxide projection conflicts with the durable workspace head');
      }
      return 'promoted';
    }
  };

  return Object.freeze({ admitManagedMutation, reconcileAcceptedProjection });
}

async function settleManagedMutation(input: {
  readonly request: Parameters<NonNullable<ToolRuntimeInput['admitManagedMutation']>>[0];
  readonly operation: () => Promise<RuntimeManagedMutationOperationProof>;
  readonly path: string;
  readonly head: WorkspaceHeadRecordV1;
  readonly version: WorkspaceVersionRecordV1;
  readonly epoch: WorkspaceEpochRecordV1;
  readonly persistence: ExecutionStoresWorkspaceMutationAuthorityInternal;
  readonly candidateAuthority: Awaited<
    ReturnType<typeof createGitoxideMutationCandidateAuthorityInternal>
  >;
  readonly issuedSuccessors: WeakMap<object, WorkspaceSuccessorAuthorityInput>;
  readonly ownerToken: object;
  readonly failpoint?: (point: GitoxideManagedWriteEditOwnerFailpoint) => void | Promise<void>;
}): Promise<RuntimeManagedMutationSettlement> {
  const proof = await input.operation();
  const reservation = await input.persistence.readActiveMutation(input.epoch.workspaceInstanceId);
  if (!reservationMatchesAdmission(reservation, input)) {
    return unsettled('Managed Write/Edit operation has no exact durable reservation');
  }

  if (proof.isError) {
    return commitTerminal(input, proof, reservation!, 'operation_failed_no_effect');
  }
  const mutation = proof.mutationResult;
  if (!mutation || mutation.path !== input.path) {
    return unsettled('Managed Write/Edit operation has no exact mutation result');
  }
  if (!mutation.changed) {
    return commitTerminal(input, proof, reservation!, 'no_workspace_change');
  }

  let candidate: GitoxideMutationCandidateProofV1;
  try {
    candidate = await input.candidateAuthority.capture({
      operationId: input.request.operationId,
      path: input.path,
      content: mutation.content,
      executionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
      abortSignal: input.request.abortSignal,
    });
    assertCandidateProof(candidate, input.head, input.path, mutation.content);
  } catch (error) {
    return Object.freeze({ kind: 'unsettled' as const, error });
  }

  const successor = buildSuccessor({
    operationId: input.request.operationId,
    dispatchEventId: reservation!.dispatchEventId,
    outcome: proof.durableOutcome,
    head: input.head,
    version: input.version,
    candidate,
  });
  input.issuedSuccessors.set(candidate, successor);
  try {
    const committed = await input.persistence.commitSuccessor({
      candidateOutcome: candidate,
      toolOutcome: toolOutcome(input.request.operationId, proof.durableOutcome),
    });
    await input.failpoint?.('after_workspace_successor_commit');
    const promoted = await input.candidateAuthority.promote({
      proof: candidate,
      projectionCapability: committed.projectionCapability,
      nextAcceptedRepositoryOwnerToken: {},
      abortSignal: input.request.abortSignal,
    });
    if (
      promoted.acceptedCommitOid !== committed.committedSuccessor.commitOid ||
      promoted.acceptedTreeOid !== committed.committedSuccessor.treeOid
    ) {
      return unsettled('Accepted Gitoxide projection conflicts with the durable workspace head');
    }
    return Object.freeze({
      kind: 'workspace_successor_committed' as const,
      durableOutcome: proof.durableOutcome,
    });
  } catch (error) {
    return Object.freeze({ kind: 'unsettled' as const, error });
  }
}

async function commitTerminal(
  input: Parameters<typeof settleManagedMutation>[0],
  proof: RuntimeManagedMutationOperationProof,
  reservation: NonNullable<
    Awaited<ReturnType<ExecutionStoresWorkspaceMutationAuthorityInternal['readActiveMutation']>>
  >,
  terminalKind: 'no_workspace_change' | 'operation_failed_no_effect',
): Promise<RuntimeManagedMutationSettlement> {
  if (proof.terminalOutcome?.kind !== terminalKind) {
    return unsettled('Managed Write/Edit terminal proof is unavailable');
  }
  try {
    const noEffectOutcome = input.persistence.issueNoEffectOutcome({
      operationId: input.request.operationId,
      dispatchEventId: reservation.dispatchEventId,
      workspaceInstanceId: reservation.workspaceInstanceId,
      terminalKind,
    });
    await input.persistence.commitTerminal({
      noEffectOutcome,
      toolOutcome: toolOutcome(input.request.operationId, proof.terminalOutcome.durableOutcome),
    });
    return Object.freeze({
      kind:
        terminalKind === 'no_workspace_change'
          ? ('no_workspace_change_committed' as const)
          : ('operation_failed_no_effect_committed' as const),
      durableOutcome: proof.terminalOutcome.durableOutcome,
    });
  } catch (error) {
    return Object.freeze({ kind: 'unsettled' as const, error });
  }
}

async function readAcceptedFile(input: {
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: Parameters<
    typeof readGitoxideTreeFileInternal
  >[0]['acceptedRepositoryCapability'];
  readonly path: string;
  readonly abortSignal: AbortSignal;
}): Promise<string | null> {
  try {
    return (
      await readGitoxideTreeFileInternal({
        acceptedRepositoryOwnerToken: input.acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: input.acceptedRepositoryCapability,
        path: input.path,
        abortSignal: input.abortSignal,
      })
    ).content;
  } catch (error) {
    if (
      error instanceof GitoxideHelperInvocationError &&
      error.code === 'gitoxide_helper_operation_failed' &&
      error.helperReason === 'tree_file_unavailable'
    ) {
      return null;
    }
    throw error;
  }
}

function freezeManagedDispatch(input: {
  readonly epoch: WorkspaceEpochRecordV1;
  readonly head: WorkspaceHeadRecordV1;
  readonly expectedPath: string;
}): Readonly<RuntimeEventManagedWorkspaceMutationV2> {
  return Object.freeze({
    protocol: 'managed_mutation_v2' as const,
    repositoryId: input.head.repositoryId,
    workspaceId: input.head.workspaceId,
    workspaceEpochId: input.head.workspaceEpochId,
    workspaceInstanceId: input.epoch.workspaceInstanceId,
    objectFormat: 'sha1' as const,
    baseWorkspaceVersionId: input.head.workspaceVersionId,
    baseAcceptedEventId: input.head.acceptedEventId,
    baseHeadRevision: input.head.revision,
    baseCommitOid: input.head.commitOid,
    baseTreeOid: input.head.treeOid,
    expectedPath: input.expectedPath,
    pathPolicyVersion: 3 as const,
    executionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  });
}

function epochMatchesOwner(
  epoch: WorkspaceEpochRecordV1 | undefined,
  workspaceId: string,
  workspaceEpochId: string,
): epoch is WorkspaceEpochRecordV1 {
  return Boolean(
    epoch &&
      epoch.workspaceId === workspaceId &&
      epoch.workspaceEpochId === workspaceEpochId &&
      epoch.mode === 'managed_worktree' &&
      epoch.objectFormat === 'sha1' &&
      /^instance_[0-9a-f]{32}$/u.test(epoch.workspaceInstanceId),
  );
}

function versionMatchesHead(
  version: WorkspaceVersionRecordV1,
  head: WorkspaceHeadRecordV1,
  epoch: WorkspaceEpochRecordV1,
): boolean {
  return (
    version.repositoryId === epoch.repositoryId &&
    version.repositoryId === head.repositoryId &&
    version.workspaceId === head.workspaceId &&
    version.workspaceEpochId === head.workspaceEpochId &&
    version.workspaceVersionId === head.workspaceVersionId &&
    version.acceptedEventId === head.acceptedEventId &&
    version.commitOid === head.commitOid &&
    version.treeOid === head.treeOid &&
    version.objectFormat === 'sha1' &&
    head.revision >= 1
  );
}

function reservationMatchesAdmission(
  reservation: Awaited<
    ReturnType<ExecutionStoresWorkspaceMutationAuthorityInternal['readActiveMutation']>
  >,
  input: Pick<Parameters<typeof settleManagedMutation>[0], 'request' | 'path' | 'head' | 'epoch'>,
): boolean {
  return Boolean(
    reservation &&
      reservation.workspaceInstanceId === input.epoch.workspaceInstanceId &&
      reservation.repositoryId === input.head.repositoryId &&
      reservation.workspaceId === input.head.workspaceId &&
      reservation.workspaceEpochId === input.head.workspaceEpochId &&
      reservation.operationId === input.request.operationId &&
      reservation.baseWorkspaceVersionId === input.head.workspaceVersionId &&
      reservation.baseAcceptedEventId === input.head.acceptedEventId &&
      reservation.baseHeadRevision === input.head.revision &&
      reservation.baseCommitOid === input.head.commitOid &&
      reservation.baseTreeOid === input.head.treeOid &&
      reservation.expectedPath === input.path &&
      reservation.executionProfileDigest === MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  );
}

function assertCandidateProof(
  proof: GitoxideMutationCandidateProofV1,
  head: WorkspaceHeadRecordV1,
  path: string,
  content: string,
): void {
  const receipt = proof.receipt;
  if (
    receipt.disposition !== 'published' ||
    receipt.repositoryId !== head.repositoryId ||
    receipt.workspaceId !== head.workspaceId ||
    receipt.workspaceEpochId !== head.workspaceEpochId ||
    receipt.workspaceVersionId !== head.workspaceVersionId ||
    receipt.baseAcceptedEventId !== head.acceptedEventId ||
    receipt.baseHeadRevision !== head.revision ||
    receipt.baseCommitOid !== head.commitOid ||
    receipt.baseTreeOid !== head.treeOid ||
    receipt.path !== path ||
    receipt.contentSha256 !== sha256(content) ||
    receipt.executionProfileDigest !== MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST ||
    !SHA1_PATTERN.test(receipt.candidateCommitOid) ||
    !SHA1_PATTERN.test(receipt.candidateTreeOid) ||
    !SHA1_PATTERN.test(receipt.resultBlobOid)
  ) {
    throw new Error('Gitoxide candidate proof conflicts with the admitted Write/Edit operation');
  }
}

function buildSuccessor(input: {
  readonly operationId: string;
  readonly dispatchEventId: string;
  readonly outcome: RuntimeEvent;
  readonly head: WorkspaceHeadRecordV1;
  readonly version: WorkspaceVersionRecordV1;
  readonly candidate: GitoxideMutationCandidateProofV1;
}): WorkspaceSuccessorAuthorityInput {
  const receipt = input.candidate.receipt;
  const identity = digest('accepted-successor', input.operationId, receipt.candidateCommitOid);
  return Object.freeze({
    acceptedEventId: `workspace-successor-${identity}`,
    committedAt: input.outcome.ts,
    successor: Object.freeze({
      repositoryId: input.head.repositoryId,
      workspaceId: input.head.workspaceId,
      workspaceEpochId: input.head.workspaceEpochId,
      workspaceVersionId: `version_${identity}`,
      objectFormat: 'sha1' as const,
      parentWorkspaceVersionId: input.head.workspaceVersionId,
      baseAcceptedEventId: input.head.acceptedEventId,
      baseHeadRevision: input.head.revision,
      commitOid: receipt.candidateCommitOid,
      treeOid: receipt.candidateTreeOid,
      policyHash: input.version.policyHash,
      treeDeltaDigest: sha256(
        `gitoxide-tree-delta-v1\0${input.head.treeOid}\0${receipt.candidateTreeOid}\0${receipt.path}\0${receipt.resultBlobOid}`,
      ),
      changedPaths: Object.freeze([receipt.path]),
      changedFileCount: 1,
      deletedFileCount: 0,
      executionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
    }),
    origin: Object.freeze({
      operationId: input.operationId,
      dispatchEventId: input.dispatchEventId,
      outcomeEventId: input.outcome.id,
    }),
  });
}

function toolOutcome(operationId: string, runtimeEvent: RuntimeEvent) {
  return Object.freeze({
    operationId,
    journalEventId: `${operationId}_outcome`,
    runtimeEvent,
    committedAt: runtimeEvent.ts,
  });
}

function unsettled(message: string): RuntimeManagedMutationSettlement {
  return Object.freeze({ kind: 'unsettled' as const, error: new Error(message) });
}

function digest(domain: string, ...values: readonly string[]): string {
  const hash = createHash('sha256').update(`maka-${domain}-v1\0`, 'utf8');
  for (const value of values) hash.update(value).update('\0');
  return hash.digest('hex').slice(0, 32);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function requireCanonicalPath(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Gitoxide managed mutation arguments are invalid');
  }
  const path = (args as Record<string, unknown>).path;
  if (!isCanonicalManagedMutationPathV1(path)) {
    throw new Error('Gitoxide managed mutation path must already be canonical');
  }
  return path;
}

async function reopenExactAcceptedRepository(input: {
  readonly input: GitoxideManagedWriteEditOwnerInputInternal;
  readonly head: WorkspaceHeadRecordV1;
  readonly acceptedRepositoryOwnerToken?: object;
  readonly abortSignal?: AbortSignal;
}) {
  return reopenGitoxideAcceptedRepositoryInternal({
    invocationOwnerToken: input.input.invocationOwnerToken,
    helperCapability: input.input.helperCapability,
    acceptedRepositoryOwnerToken: input.acceptedRepositoryOwnerToken ?? {},
    repositoryPath: input.input.repositoryPath,
    acceptedRef: ACCEPTED_REF,
    expectedAcceptedCommitOid: input.head.commitOid,
    expectedAcceptedTreeOid: input.head.treeOid,
    managedTreePolicyVersion: 3,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
}

function validateAcceptedSuccessorEvidence(input: {
  readonly epoch: WorkspaceEpochRecordV1;
  readonly parentHead: WorkspaceHeadRecordV1;
  readonly successorVersion: Extract<
    WorkspaceVersionRecordV1,
    { protocol: 'workspace_version_accepted_v1' }
  >;
  readonly evidence: NonNullable<
    Awaited<ReturnType<ExecutionStoresWorkspaceMutationAuthorityInternal['readMutationEvidence']>>
  >;
}): string {
  const call = input.evidence.callEvent;
  const dispatch = input.evidence.dispatchEvent;
  const outcome = input.evidence.outcomeEvent;
  const callContent = call.content;
  const dispatchFact = dispatch.actions?.toolDispatch;
  const managed = dispatchFact?.managedMutation;
  const outcomeContent = outcome.content;
  if (
    callContent?.kind !== 'function_call' ||
    (callContent.name !== 'Write' && callContent.name !== 'Edit') ||
    call.refs?.operationId !== input.successorVersion.origin.operationId ||
    dispatch.id !== input.successorVersion.origin.dispatchEventId ||
    dispatch.refs?.operationId !== input.successorVersion.origin.operationId ||
    dispatchFact?.operationId !== input.successorVersion.origin.operationId ||
    dispatchFact.providerToolCallId !== callContent.id ||
    dispatchFact.toolName !== callContent.name ||
    dispatchFact.recoveryMode !== 'reconcile' ||
    dispatchFact.canonicalArgsHash !== canonicalToolArgsHash(callContent.name, callContent.args) ||
    outcome.id !== input.successorVersion.origin.outcomeEventId ||
    outcome.refs?.operationId !== input.successorVersion.origin.operationId ||
    outcomeContent?.kind !== 'function_response' ||
    outcomeContent.id !== callContent.id ||
    outcomeContent.name !== callContent.name ||
    outcomeContent.isError === true ||
    !managedMutationMatchesParent(managed, input.epoch, input.parentHead)
  ) {
    throw new Error('Gitoxide projection recovery operation evidence is invalid');
  }
  const path = requireCanonicalPath(callContent.args);
  if (
    path !== managed.expectedPath ||
    input.successorVersion.changedPaths.length !== 1 ||
    input.successorVersion.changedPaths[0] !== path ||
    input.successorVersion.executionProfileDigest !== MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST
  ) {
    throw new Error('Gitoxide projection recovery path authority is invalid');
  }
  return path;
}

function isAcceptedRefTargetMismatch(error: unknown): error is GitoxideHelperInvocationError {
  return (
    error instanceof GitoxideHelperInvocationError &&
    error.code === 'gitoxide_helper_operation_failed' &&
    error.helperReason === 'accepted_ref_target_invalid'
  );
}

function managedMutationMatchesParent(
  managed: RuntimeEventManagedWorkspaceMutationV2 | undefined,
  epoch: WorkspaceEpochRecordV1,
  parent: WorkspaceHeadRecordV1,
): managed is RuntimeEventManagedWorkspaceMutationV2 {
  return Boolean(
    managed &&
      managed.protocol === 'managed_mutation_v2' &&
      managed.repositoryId === parent.repositoryId &&
      managed.workspaceId === parent.workspaceId &&
      managed.workspaceEpochId === parent.workspaceEpochId &&
      managed.workspaceInstanceId === epoch.workspaceInstanceId &&
      managed.objectFormat === 'sha1' &&
      managed.baseWorkspaceVersionId === parent.workspaceVersionId &&
      managed.baseAcceptedEventId === parent.acceptedEventId &&
      managed.baseHeadRevision === parent.revision &&
      managed.baseCommitOid === parent.commitOid &&
      managed.baseTreeOid === parent.treeOid &&
      managed.pathPolicyVersion === 3 &&
      managed.executionProfileDigest === MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  );
}

function parentMatchesSuccessor(
  parent: WorkspaceVersionRecordV1,
  successor: Extract<WorkspaceVersionRecordV1, { protocol: 'workspace_version_accepted_v1' }>,
): boolean {
  return (
    parent.repositoryId === successor.repositoryId &&
    parent.workspaceId === successor.workspaceId &&
    parent.workspaceEpochId === successor.workspaceEpochId &&
    parent.workspaceVersionId === successor.parents[0] &&
    parent.acceptedEventId === successor.baseAcceptedEventId &&
    parent.commitOid !== successor.commitOid &&
    successor.baseHeadRevision >= 1
  );
}

function successorMatchesVersion(
  expected: WorkspaceSuccessorAuthorityInput,
  actual: Extract<WorkspaceVersionRecordV1, { protocol: 'workspace_version_accepted_v1' }>,
): boolean {
  const successor = expected.successor;
  return (
    expected.acceptedEventId === actual.acceptedEventId &&
    expected.committedAt === actual.committedAt &&
    isDeepStrictEqual(expected.origin, {
      operationId: actual.origin.operationId,
      dispatchEventId: actual.origin.dispatchEventId,
      outcomeEventId: actual.origin.outcomeEventId,
    }) &&
    successor.repositoryId === actual.repositoryId &&
    successor.workspaceId === actual.workspaceId &&
    successor.workspaceEpochId === actual.workspaceEpochId &&
    successor.workspaceVersionId === actual.workspaceVersionId &&
    successor.objectFormat === actual.objectFormat &&
    successor.parentWorkspaceVersionId === actual.parents[0] &&
    successor.baseAcceptedEventId === actual.baseAcceptedEventId &&
    successor.baseHeadRevision === actual.baseHeadRevision &&
    successor.commitOid === actual.commitOid &&
    successor.treeOid === actual.treeOid &&
    successor.policyHash === actual.policyHash &&
    successor.treeDeltaDigest === actual.treeDeltaDigest &&
    isDeepStrictEqual(successor.changedPaths, actual.changedPaths) &&
    successor.changedFileCount === actual.changedFileCount &&
    successor.deletedFileCount === actual.deletedFileCount &&
    successor.executionProfileDigest === actual.executionProfileDigest
  );
}

function headRecordsEqual(left: WorkspaceHeadRecordV1, right: WorkspaceHeadRecordV1): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceEpochId === right.workspaceEpochId &&
    left.workspaceVersionId === right.workspaceVersionId &&
    left.acceptedEventId === right.acceptedEventId &&
    left.commitOid === right.commitOid &&
    left.treeOid === right.treeOid &&
    left.revision === right.revision
  );
}
