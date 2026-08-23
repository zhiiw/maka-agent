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
import { isCanonicalManagedMutationPathV1 } from '@maka/core/runtime-event';
import type {
  WorkspaceHeadRecordV1,
  WorkspaceSuccessorAuthorityInput,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import { GITOXIDE_MANAGED_MUTATION_TRANSFORM_PROFILE_DIGEST } from '@maka/runtime/managed-mutation-transform';
import type { RuntimeManagedMutationAdmission, ToolRuntimeInput } from '@maka/runtime/tool-runtime';
import type {
  ManagedMutationTerminalCommitInput,
  ManagedMutationTerminalCommitResult,
  WorkspaceSuccessorCommitInput,
  WorkspaceSuccessorCommitResult,
} from '@maka/storage/workspace-version-authority-internal';

type AdmissionInput = Parameters<NonNullable<ToolRuntimeInput['admitManagedMutation']>>[0];

interface CandidateReceipt {
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceVersionId: string;
  readonly baseAcceptedEventId: string;
  readonly baseHeadRevision: number;
  readonly baseCommitOid: string;
  readonly baseTreeOid: string;
  readonly candidateCommitOid: string;
  readonly candidateTreeOid: string;
  readonly resultBlobOid: string;
  readonly path: string;
  readonly contentSha256: `sha256:${string}`;
  readonly executionProfileDigest: `sha256:${string}`;
}

interface CandidateProof {
  readonly receipt: CandidateReceipt;
}

export interface GitoxideManagedMutationCandidateAuthorityInternal {
  readBaseFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<{ readonly content: string; readonly blobOid: string } | null>;
  capture(input: {
    readonly operationId: string;
    readonly path: string;
    readonly content: string;
    readonly executionProfileDigest: `sha256:${string}`;
    readonly abortSignal?: AbortSignal;
  }): Promise<CandidateProof>;
  promote(proof: CandidateProof, abortSignal?: AbortSignal): Promise<CandidateReceipt>;
  promoteDurable(operationId: string, abortSignal?: AbortSignal): Promise<CandidateReceipt>;
}

export interface GitoxideManagedMutationSettlementAuthorityInternal {
  readHead(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceHeadRecordV1 | undefined>;
  readVersion(workspaceVersionId: string): Promise<WorkspaceVersionRecordV1 | undefined>;
  commitSuccessor(input: WorkspaceSuccessorCommitInput): Promise<WorkspaceSuccessorCommitResult>;
  commitTerminal(
    input: ManagedMutationTerminalCommitInput,
  ): Promise<ManagedMutationTerminalCommitResult>;
}

export function createGitoxideManagedMutationAdmissionInternal(input: {
  readonly workspaceInstanceId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly settlementAuthority: GitoxideManagedMutationSettlementAuthorityInternal;
  readonly candidateAuthorityForHead: (
    head: WorkspaceHeadRecordV1,
  ) => Promise<GitoxideManagedMutationCandidateAuthorityInternal>;
}): NonNullable<ToolRuntimeInput['admitManagedMutation']> {
  return async (request: AdmissionInput): Promise<RuntimeManagedMutationAdmission> => {
    if (request.toolName !== 'Write' && request.toolName !== 'Edit') {
      throw new Error('Gitoxide managed mutation admits only Write and Edit');
    }
    const path = canonicalPath(request.persistedArgs);
    const head = await input.settlementAuthority.readHead(
      input.workspaceId,
      input.workspaceEpochId,
    );
    if (!head) throw new Error('Gitoxide managed mutation has no accepted workspace head');
    const version = await input.settlementAuthority.readVersion(head.workspaceVersionId);
    if (!version || !versionMatchesHead(version, head)) {
      throw new Error('Gitoxide managed mutation workspace version is unavailable');
    }
    const candidateAuthority = await input.candidateAuthorityForHead(head);
    const baseFile = await candidateAuthority.readBaseFile(path, request.abortSignal);
    request.abortSignal.throwIfAborted();
    const durableDispatch = Object.freeze({
      protocol: 'managed_mutation_v1' as const,
      repositoryId: head.repositoryId,
      workspaceId: head.workspaceId,
      workspaceEpochId: head.workspaceEpochId,
      workspaceInstanceId: input.workspaceInstanceId,
      objectFormat: 'sha1' as const,
      baseWorkspaceVersionId: head.workspaceVersionId,
      baseAcceptedEventId: head.acceptedEventId,
      baseHeadRevision: head.revision,
      baseCommitOid: head.commitOid,
      baseTreeOid: head.treeOid,
      expectedPaths: Object.freeze([path]),
      executionProfileDigest: GITOXIDE_MANAGED_MUTATION_TRANSFORM_PROFILE_DIGEST,
    });

    return Object.freeze({
      durableDispatch,
      gitoxideTransform: Object.freeze({
        canonicalPath: path,
        baseContent: baseFile?.content ?? null,
      }),
      async execute(operation: Parameters<RuntimeManagedMutationAdmission['execute']>[0]) {
        const proof = await operation();
        if (proof.isError) {
          await input.settlementAuthority.commitTerminal({
            disposition: 'operation_failed_no_effect_committed',
            toolOutcome: toolOutcomeInput(request.operationId, proof.durableOutcome),
          });
          return Object.freeze({
            kind: 'operation_failed_no_effect_committed' as const,
            durableOutcome: proof.durableOutcome,
          });
        }
        const mutation = proof.managedMutationResult;
        if (!mutation || mutation.canonicalPath !== path) {
          return Object.freeze({
            kind: 'unsettled' as const,
            error: new Error('Gitoxide managed mutation has no exact success transform'),
          });
        }
        if (!mutation.changed) {
          await input.settlementAuthority.commitTerminal({
            disposition: 'no_workspace_change_committed',
            toolOutcome: toolOutcomeInput(request.operationId, proof.durableOutcome),
          });
          return Object.freeze({
            kind: 'no_workspace_change_committed' as const,
            durableOutcome: proof.durableOutcome,
          });
        }
        const candidate = await candidateAuthority.capture({
          operationId: request.operationId,
          path,
          content: mutation.content,
          executionProfileDigest: GITOXIDE_MANAGED_MUTATION_TRANSFORM_PROFILE_DIGEST,
          abortSignal: request.abortSignal,
        });
        assertCandidateReceipt(candidate.receipt, head, path, mutation.content);
        const successor = successorInput({
          operationId: request.operationId,
          outcomeEventId: proof.durableOutcome.id,
          outcomeTimestamp: proof.durableOutcome.ts,
          version,
          head,
          receipt: candidate.receipt,
        });
        await input.settlementAuthority.commitSuccessor({
          successor,
          toolOutcome: toolOutcomeInput(request.operationId, proof.durableOutcome),
        });
        await candidateAuthority.promote(candidate, request.abortSignal);
        return Object.freeze({
          kind: 'workspace_successor_committed' as const,
          durableOutcome: proof.durableOutcome,
        });
      },
      async dispose() {},
    });
  };
}

function toolOutcomeInput(
  operationId: string,
  durableOutcome: import('@maka/core/runtime-event').RuntimeEvent,
) {
  return {
    operationId,
    journalEventId: `${operationId}_outcome`,
    runtimeEvent: durableOutcome,
    committedAt: durableOutcome.ts,
  };
}

export async function reconcileGitoxideManagedMutationProjectionInternal(input: {
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly settlementAuthority: GitoxideManagedMutationSettlementAuthorityInternal;
  readonly candidateAuthorityForHead: (
    head: WorkspaceHeadRecordV1,
  ) => Promise<GitoxideManagedMutationCandidateAuthorityInternal>;
  readonly abortSignal?: AbortSignal;
}): Promise<'already_at_baseline' | 'promoted'> {
  input.abortSignal?.throwIfAborted();
  const head = await input.settlementAuthority.readHead(input.workspaceId, input.workspaceEpochId);
  if (!head) throw new Error('Gitoxide projection reconciliation has no accepted head');
  const version = await input.settlementAuthority.readVersion(head.workspaceVersionId);
  if (!version || !versionMatchesHead(version, head)) {
    throw new Error('Gitoxide projection reconciliation head is corrupt');
  }
  if (version.protocol === 'workspace_baseline_accepted_v1') return 'already_at_baseline';
  if (version.parents.length !== 1 || version.baseHeadRevision + 1 !== head.revision) {
    throw new Error('Gitoxide projection reconciliation successor ancestry is corrupt');
  }
  const parent = await input.settlementAuthority.readVersion(version.parents[0]);
  if (!parent || !parentMatchesSuccessor(parent, version)) {
    throw new Error('Gitoxide projection reconciliation parent is corrupt');
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
  const candidateAuthority = await input.candidateAuthorityForHead(parentHead);
  const receipt = await candidateAuthority.promoteDurable(
    version.origin.operationId,
    input.abortSignal,
  );
  assertPromotedReceipt(receipt, parentHead, version);
  return 'promoted';
}

function canonicalPath(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Gitoxide managed mutation arguments are invalid');
  }
  const path = (args as Record<string, unknown>).path;
  if (!isCanonicalManagedMutationPathV1(path)) {
    throw new Error('Gitoxide managed mutation path must already be canonical');
  }
  return path;
}

function versionMatchesHead(
  version: WorkspaceVersionRecordV1,
  head: WorkspaceHeadRecordV1,
): boolean {
  return (
    version.repositoryId === head.repositoryId &&
    version.workspaceId === head.workspaceId &&
    version.workspaceEpochId === head.workspaceEpochId &&
    version.workspaceVersionId === head.workspaceVersionId &&
    version.acceptedEventId === head.acceptedEventId &&
    version.commitOid === head.commitOid &&
    version.treeOid === head.treeOid
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
    successor.baseHeadRevision >= 1
  );
}

function assertPromotedReceipt(
  receipt: CandidateReceipt,
  parent: WorkspaceHeadRecordV1,
  successor: Extract<WorkspaceVersionRecordV1, { protocol: 'workspace_version_accepted_v1' }>,
): void {
  if (
    receipt.repositoryId !== parent.repositoryId ||
    receipt.workspaceId !== parent.workspaceId ||
    receipt.workspaceEpochId !== parent.workspaceEpochId ||
    receipt.workspaceVersionId !== parent.workspaceVersionId ||
    receipt.baseAcceptedEventId !== parent.acceptedEventId ||
    receipt.baseHeadRevision !== parent.revision ||
    receipt.baseCommitOid !== parent.commitOid ||
    receipt.baseTreeOid !== parent.treeOid ||
    receipt.candidateCommitOid !== successor.commitOid ||
    receipt.candidateTreeOid !== successor.treeOid ||
    receipt.path !== successor.changedPaths[0] ||
    successor.changedPaths.length !== 1 ||
    receipt.executionProfileDigest !== successor.executionProfileDigest
  ) {
    throw new Error('Gitoxide durable candidate conflicts with the accepted successor');
  }
}

function assertCandidateReceipt(
  receipt: CandidateReceipt,
  head: WorkspaceHeadRecordV1,
  path: string,
  content: string,
): void {
  if (
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
    receipt.executionProfileDigest !== GITOXIDE_MANAGED_MUTATION_TRANSFORM_PROFILE_DIGEST
  ) {
    throw new Error('Gitoxide candidate receipt conflicts with the admitted operation');
  }
}

function successorInput(input: {
  readonly operationId: string;
  readonly outcomeEventId: string;
  readonly outcomeTimestamp: number;
  readonly version: WorkspaceVersionRecordV1;
  readonly head: WorkspaceHeadRecordV1;
  readonly receipt: CandidateReceipt;
}): WorkspaceSuccessorAuthorityInput {
  const identity = digest(
    'accepted-successor',
    input.operationId,
    input.receipt.candidateCommitOid,
  );
  return {
    acceptedEventId: `workspace-successor-${identity}`,
    committedAt: input.outcomeTimestamp,
    successor: {
      repositoryId: input.head.repositoryId,
      workspaceId: input.head.workspaceId,
      workspaceEpochId: input.head.workspaceEpochId,
      workspaceVersionId: `version_${identity}`,
      objectFormat: 'sha1',
      parentWorkspaceVersionId: input.head.workspaceVersionId,
      baseAcceptedEventId: input.head.acceptedEventId,
      baseHeadRevision: input.head.revision,
      commitOid: input.receipt.candidateCommitOid,
      treeOid: input.receipt.candidateTreeOid,
      policyHash: input.version.policyHash,
      treeDeltaDigest: sha256(
        `gitoxide-tree-delta-v1\0${input.head.treeOid}\0${input.receipt.candidateTreeOid}\0${input.receipt.path}\0${input.receipt.resultBlobOid}`,
      ),
      changedPaths: Object.freeze([input.receipt.path]),
      changedFileCount: 1,
      deletedFileCount: 0,
      executionProfileDigest: GITOXIDE_MANAGED_MUTATION_TRANSFORM_PROFILE_DIGEST,
    },
    origin: {
      operationId: input.operationId,
      dispatchEventId: `${input.operationId}_dispatch`,
      outcomeEventId: input.outcomeEventId,
    },
  };
}

function digest(domain: string, ...values: readonly string[]): string {
  const hash = createHash('sha256').update(`maka-${domain}-v1\0`, 'utf8');
  for (const value of values) hash.update(value).update('\0');
  return hash.digest('hex').slice(0, 32);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
