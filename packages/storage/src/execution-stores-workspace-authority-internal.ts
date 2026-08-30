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

import type {
  ManagedWorkspaceContinuationBoundaryV1,
  RuntimeBoundaryDigest,
} from '@maka/core/runtime-boundary';
import type {
  WorkspaceBaselineAuthorityInput,
  WorkspaceBaselineCommitResult,
  WorkspaceHeadRecordV1,
  WorkspaceEpochRecordV1,
  WorkspaceSuccessorAuthorityInput,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import {
  adoptWorkspaceBaselineAuthorityStoreRootInternal,
  commitWorkspaceBaselineInternal,
  commitManagedMutationTerminalInternal,
  commitVerifiedWorkspaceSuccessorInternal,
  readActiveManagedMutationInternal,
  readManagedMutationEvidenceInternal,
  readWorkspaceContinuationBoundaryInternal,
  readWorkspaceEpochInternal,
  readWorkspaceHeadInternal,
  readWorkspaceVersionInternal,
  registerManagedMutationNoEffectVerifierInternal,
  type ManagedMutationNoEffectClaimV1,
  type ManagedMutationReservationRecordV1,
  type ManagedMutationEvidenceRecordV1,
  type ManagedMutationTerminalCommitInput,
  type ManagedMutationTerminalCommitResult,
  type WorkspaceSuccessorCommitInput,
  type WorkspaceSuccessorCommitResult,
} from './workspace-version-authority-internal.js';

export interface ExecutionStoresWorkspaceMutationAuthorityCapabilityInternal {
  readonly kind: 'execution_stores_workspace_mutation_authority_v1';
}

export interface ExecutionStoresWorkspaceBaselineAuthorityCapabilityInternal {
  readonly kind: 'execution_stores_workspace_baseline_authority_v1';
}

export interface ExecutionStoresWorkspaceContinuationAuthorityCapabilityInternal {
  readonly kind: 'execution_stores_workspace_continuation_authority_v1';
}

export interface ExecutionStoresWorkspaceContinuationAuthorityInternal {
  readContinuationBoundary(
    workspaceId: string,
    workspaceEpochId: string,
    executionProfileDigest: RuntimeBoundaryDigest,
  ): Promise<ManagedWorkspaceContinuationBoundaryV1 | undefined>;
}

export interface ExecutionStoresWorkspaceBaselineAuthorityInternal {
  commitBaseline(importedRepositoryProof: object): Promise<WorkspaceBaselineCommitResult>;
  readEpoch(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceEpochRecordV1 | undefined>;
  readHead(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceHeadRecordV1 | undefined>;
  readVersion(workspaceVersionId: string): Promise<WorkspaceVersionRecordV1 | undefined>;
}

export interface WorkspaceSuccessorProjectionCapabilityInternal {
  readonly kind: 'workspace_successor_projection_capability_v1';
}

export interface ExecutionStoresWorkspaceSuccessorCommitResult
  extends WorkspaceSuccessorCommitResult {
  readonly projectionCapability: WorkspaceSuccessorProjectionCapabilityInternal;
}

export interface ExecutionStoresWorkspaceMutationAuthorityInternal {
  readEpoch(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceEpochRecordV1 | undefined>;
  readHead(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceHeadRecordV1 | undefined>;
  readVersion(workspaceVersionId: string): Promise<WorkspaceVersionRecordV1 | undefined>;
  readActiveMutation(
    workspaceInstanceId: string,
  ): Promise<ManagedMutationReservationRecordV1 | undefined>;
  readMutationEvidence(operationId: string): Promise<ManagedMutationEvidenceRecordV1 | undefined>;
  issueNoEffectOutcome(claim: ManagedMutationNoEffectClaimV1): object;
  commitSuccessor(
    input: WorkspaceSuccessorCommitInput,
  ): Promise<ExecutionStoresWorkspaceSuccessorCommitResult>;
  commitTerminal(
    input: ManagedMutationTerminalCommitInput,
  ): Promise<ManagedMutationTerminalCommitResult>;
}

interface AuthoritySource {
  readonly store: object;
  readonly rootId: string;
}

interface AuthorityCapabilityRecord extends AuthoritySource {
  readonly ownerToken: object;
  readonly verifyCandidate: (candidateOutcome: object) => WorkspaceSuccessorAuthorityInput;
}

interface NoEffectCapabilityRecord extends AuthoritySource {
  readonly ownerToken: object;
  readonly claim: ManagedMutationNoEffectClaimV1;
}

interface BaselineAuthorityCapabilityRecord extends AuthoritySource {
  readonly ownerToken: object;
  readonly verifyBaseline: (importedRepositoryProof: object) => WorkspaceBaselineAuthorityInput;
}

const sources = new WeakMap<object, AuthoritySource>();
const capabilities = new WeakMap<object, AuthorityCapabilityRecord>();
const noEffectCapabilities = new WeakMap<object, NoEffectCapabilityRecord>();
const baselineCapabilities = new WeakMap<object, BaselineAuthorityCapabilityRecord>();
const continuationCapabilities = new WeakMap<
  object,
  AuthoritySource & { readonly ownerToken: object }
>();
const projectionCapabilities = new WeakMap<
  object,
  {
    readonly ownerToken: object;
    readonly candidateOutcome: object;
    readonly head: WorkspaceHeadRecordV1;
  }
>();

export function registerExecutionStoresWorkspaceMutationSourceInternal(
  stores: object,
  store: object,
  rootId: string,
): void {
  if (sources.has(stores) || !/^[0-9a-f]{64}$/u.test(rootId)) {
    throw new Error('Execution stores workspace mutation source is invalid');
  }
  sources.set(stores, Object.freeze({ store, rootId }));
  registerManagedMutationNoEffectVerifierInternal(store, (capability) => {
    const record = noEffectCapabilities.get(capability);
    if (!record || record.store !== store || record.rootId !== rootId) {
      throw new Error('Managed mutation no-effect proof is invalid');
    }
    return record.claim;
  });
}

/** Test-only bridge used by cross-package production-shaped owner tests. */
export function commitExecutionStoresWorkspaceBaselineForTestInternal(
  stores: object,
  input: WorkspaceBaselineAuthorityInput,
): Promise<WorkspaceBaselineCommitResult> {
  const source = sources.get(stores);
  if (!source) throw new Error('Execution stores workspace baseline test source is unavailable');
  adoptWorkspaceBaselineAuthorityStoreRootInternal(source.store, source.rootId);
  return commitWorkspaceBaselineInternal(source.store, input);
}

export function issueExecutionStoresWorkspaceMutationAuthorityInternal(input: {
  readonly ownerToken: object;
  readonly stores: object;
  readonly verifyCandidate: (candidateOutcome: object) => WorkspaceSuccessorAuthorityInput;
}): ExecutionStoresWorkspaceMutationAuthorityCapabilityInternal {
  const source = sources.get(input.stores);
  if (!source) throw new Error('Execution stores workspace mutation source is unavailable');
  adoptWorkspaceBaselineAuthorityStoreRootInternal(source.store, source.rootId);
  const capability = Object.freeze({
    kind: 'execution_stores_workspace_mutation_authority_v1' as const,
  });
  capabilities.set(
    capability,
    Object.freeze({
      ownerToken: input.ownerToken,
      store: source.store,
      rootId: source.rootId,
      verifyCandidate: input.verifyCandidate,
    }),
  );
  return capability;
}

export function issueExecutionStoresWorkspaceBaselineAuthorityInternal(input: {
  readonly ownerToken: object;
  readonly stores: object;
  readonly verifyBaseline: (importedRepositoryProof: object) => WorkspaceBaselineAuthorityInput;
}): ExecutionStoresWorkspaceBaselineAuthorityCapabilityInternal {
  const source = sources.get(input.stores);
  if (!source) throw new Error('Execution stores workspace baseline source is unavailable');
  adoptWorkspaceBaselineAuthorityStoreRootInternal(source.store, source.rootId);
  const capability = Object.freeze({
    kind: 'execution_stores_workspace_baseline_authority_v1' as const,
  });
  baselineCapabilities.set(
    capability,
    Object.freeze({
      ownerToken: input.ownerToken,
      store: source.store,
      rootId: source.rootId,
      verifyBaseline: input.verifyBaseline,
    }),
  );
  return capability;
}

export function issueExecutionStoresWorkspaceContinuationAuthorityInternal(input: {
  readonly ownerToken: object;
  readonly stores: object;
}): ExecutionStoresWorkspaceContinuationAuthorityCapabilityInternal {
  const source = sources.get(input.stores);
  if (!source) throw new Error('Execution stores workspace continuation source is unavailable');
  adoptWorkspaceBaselineAuthorityStoreRootInternal(source.store, source.rootId);
  const capability = Object.freeze({
    kind: 'execution_stores_workspace_continuation_authority_v1' as const,
  });
  continuationCapabilities.set(
    capability,
    Object.freeze({ ...source, ownerToken: input.ownerToken }),
  );
  return capability;
}

export function requireExecutionStoresWorkspaceContinuationAuthorityInternal(
  ownerToken: object,
  capability: ExecutionStoresWorkspaceContinuationAuthorityCapabilityInternal,
): ExecutionStoresWorkspaceContinuationAuthorityInternal {
  const record = continuationCapabilities.get(capability);
  if (!record || record.ownerToken !== ownerToken) {
    throw new Error('Execution stores workspace continuation authority capability is invalid');
  }
  return Object.freeze({
    readContinuationBoundary: (
      workspaceId: string,
      workspaceEpochId: string,
      executionProfileDigest: RuntimeBoundaryDigest,
    ) =>
      readWorkspaceContinuationBoundaryInternal(
        record.store,
        workspaceId,
        workspaceEpochId,
        executionProfileDigest,
      ),
  });
}

export function requireExecutionStoresWorkspaceBaselineAuthorityInternal(
  ownerToken: object,
  capability: ExecutionStoresWorkspaceBaselineAuthorityCapabilityInternal,
): ExecutionStoresWorkspaceBaselineAuthorityInternal {
  const record = baselineCapabilities.get(capability);
  if (!record || record.ownerToken !== ownerToken) {
    throw new Error('Execution stores workspace baseline authority capability is invalid');
  }
  return Object.freeze({
    commitBaseline: async (importedRepositoryProof: object) =>
      commitWorkspaceBaselineInternal(record.store, record.verifyBaseline(importedRepositoryProof)),
    readEpoch: (workspaceId: string, workspaceEpochId: string) =>
      readWorkspaceEpochInternal(record.store, workspaceId, workspaceEpochId),
    readHead: (workspaceId: string, workspaceEpochId: string) =>
      readWorkspaceHeadInternal(record.store, workspaceId, workspaceEpochId),
    readVersion: (workspaceVersionId: string) =>
      readWorkspaceVersionInternal(record.store, workspaceVersionId),
  });
}

export function requireExecutionStoresWorkspaceMutationAuthorityInternal(
  ownerToken: object,
  capability: ExecutionStoresWorkspaceMutationAuthorityCapabilityInternal,
): ExecutionStoresWorkspaceMutationAuthorityInternal {
  const record = capabilities.get(capability);
  if (!record || record.ownerToken !== ownerToken) {
    throw new Error('Execution stores workspace mutation authority capability is invalid');
  }
  const store = record.store;
  return Object.freeze({
    readEpoch: (workspaceId: string, workspaceEpochId: string) =>
      readWorkspaceEpochInternal(store, workspaceId, workspaceEpochId),
    readHead: (workspaceId: string, workspaceEpochId: string) =>
      readWorkspaceHeadInternal(store, workspaceId, workspaceEpochId),
    readVersion: (workspaceVersionId: string) =>
      readWorkspaceVersionInternal(store, workspaceVersionId),
    readActiveMutation: (workspaceInstanceId: string) =>
      readActiveManagedMutationInternal(store, workspaceInstanceId),
    issueNoEffectOutcome: (claim: ManagedMutationNoEffectClaimV1) => {
      const noEffectOutcome = Object.freeze({});
      noEffectCapabilities.set(
        noEffectOutcome,
        Object.freeze({
          ownerToken,
          store,
          rootId: record.rootId,
          claim: structuredClone(claim),
        }),
      );
      return noEffectOutcome;
    },
    readMutationEvidence: (operationId: string) =>
      readManagedMutationEvidenceInternal(store, operationId),
    commitSuccessor: async (input: WorkspaceSuccessorCommitInput) => {
      const successor = record.verifyCandidate(input.candidateOutcome);
      const result = await commitVerifiedWorkspaceSuccessorInternal(store, {
        successor,
        toolOutcome: input.toolOutcome,
      });
      const projectionCapability = Object.freeze({
        kind: 'workspace_successor_projection_capability_v1' as const,
      });
      projectionCapabilities.set(
        projectionCapability,
        Object.freeze({
          ownerToken,
          candidateOutcome: input.candidateOutcome,
          head: result.committedSuccessor,
        }),
      );
      return Object.freeze({ ...result, projectionCapability });
    },
    commitTerminal: (input: ManagedMutationTerminalCommitInput) => {
      const noEffect = noEffectCapabilities.get(input.noEffectOutcome);
      if (
        !noEffect ||
        noEffect.ownerToken !== ownerToken ||
        noEffect.store !== store ||
        noEffect.rootId !== record.rootId
      ) {
        throw new Error('Managed mutation no-effect proof is invalid');
      }
      return commitManagedMutationTerminalInternal(store, input);
    },
  });
}

export function requireWorkspaceSuccessorProjectionInternal(
  ownerToken: object,
  capability: WorkspaceSuccessorProjectionCapabilityInternal,
): Readonly<{
  candidateOutcome: object;
  head: WorkspaceHeadRecordV1;
}> {
  const record = projectionCapabilities.get(capability);
  if (!record || record.ownerToken !== ownerToken) {
    throw new Error('Workspace successor projection capability is invalid');
  }
  return Object.freeze({ candidateOutcome: record.candidateOutcome, head: record.head });
}
