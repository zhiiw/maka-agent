import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  createGitWorkspaceService,
  type CreateManagedWorkspaceFromSourceInput,
  GitWorkspaceServiceError,
  type GitWorkspaceService,
  type GitWorkspaceServiceFailpoint,
  type ManagedWorkspaceBaselineReceiptV1,
  type ManagedWorkspaceBinding,
  type VerifiedGitRuntimeInput,
} from './git-workspace-service.js';
import {
  requireManagedBaselineReceiptAuthorityInternal,
  type ManagedBaselineReceiptAuthorityInternal,
} from './managed-baseline-receipt-authority-internal.js';
import {
  advanceManagedWorkspaceExecutionHandleInternal,
  issueManagedWorkspaceExecutionHandleInternal,
  issueManagedWorkspaceExecutionScopeInternal,
  requireManagedWorkspaceExecutionHandleInternal,
  revokeManagedWorkspaceExecutionScopeInternal,
  type ManagedWorkspaceExecutionHandle,
  type ManagedWorkspaceExecutionScope,
} from './managed-workspace-execution-authority-internal.js';
import {
  requireManagedMutationCandidateAuthorityInternal,
  type ManagedMutationCandidateAuthorityInternal,
  type ManagedMutationCandidateReceiptV1,
} from './managed-mutation-candidate-authority-internal.js';
import {
  createManagedWorkspaceWorkerBridgeInternal,
  type ManagedWorkspaceFilesystemWorker,
  type ManagedWorkspaceMutationOperation,
  type ManagedWorkspaceMutationResult,
  type ManagedWorkspaceReadOnlyOperation,
  type ManagedWorkspaceReadOnlyResult,
  type ManagedWorkspaceWorkerBridgeInternal,
} from './managed-workspace-worker-bridge-internal.js';
import type { RuntimeWorkspaceVersionAuthorityStore } from '@maka/core/runtime-event-store';
import {
  isCanonicalManagedMutationPathV1,
  type RuntimeEventManagedWorkspaceMutationV1,
} from '@maka/core/runtime-event';
import type {
  WorkspaceHeadRecordV1,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import {
  assertInteractiveRootOwner,
  authenticateInteractiveRootOwner,
  createStorageRootLeaseIdentityGuard,
  runWithStorageRootLease,
  type InteractiveRootOwner,
} from './root-authority.js';
import {
  assertWorkspaceBaselineAuthorityStoreRootInternal,
  bindWorkspaceBaselineAuthorityStoreRootInternal,
  commitWorkspaceBaselineInternal,
  commitManagedMutationTerminalInternal,
  commitWorkspaceSuccessorInternal,
  readActiveManagedMutationInternal,
  readWorkspaceHeadInternal,
} from './workspace-version-authority-internal.js';
import type { InteractiveExecutionStoresWriter } from './execution-stores.js';
import { requireExecutionStoresWorkspaceAuthorityInternal } from './execution-stores-workspace-authority-internal.js';

// RuntimeEvent order is assigned by the SQLite authority spine. M0 therefore
// uses a protocol-fixed logical timestamp and keeps unauthenticated wall-clock
// time out of the durable Git receipt.
const MANAGED_BASELINE_LOGICAL_TIMESTAMP_V1 = 0;

export type ManagedWorkspaceOwnerErrorCode =
  | 'managed_workspace_owner_conflict'
  | 'managed_workspace_owner_unavailable'
  | 'managed_workspace_owner_closing'
  | 'managed_workspace_owner_reentrant_close'
  | 'managed_workspace_worker_unavailable'
  | 'managed_workspace_quarantined'
  | 'managed_workspace_execution_handle_invalid';

export class ManagedWorkspaceOwnerError extends Error {
  constructor(
    readonly code: ManagedWorkspaceOwnerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManagedWorkspaceOwnerError';
  }
}

export interface OpenManagedWorkspaceOwnerInput {
  readonly rootOwner: InteractiveRootOwner;
  readonly gitRuntime: VerifiedGitRuntimeInput;
  readonly failpoint?: (point: ManagedWorkspaceOwnerFailpoint) => void | Promise<void>;
  readonly filesystemWorker?: ManagedWorkspaceFilesystemWorker;
}

export type ManagedWorkspaceOwnerFailpoint =
  | GitWorkspaceServiceFailpoint
  | 'after_initial_store_root_validation'
  | 'after_baseline_authority_commit'
  | 'after_post_commit_artifact_verification'
  | 'after_execution_artifact_verification'
  | 'after_managed_successor_commit'
  | 'after_managed_candidate_accept';

export type OpenManagedWorkspaceBaselineInput = CreateManagedWorkspaceFromSourceInput;

export interface OpenManagedWorkspaceBaselineResult {
  readonly created: boolean;
  readonly head: WorkspaceHeadRecordV1;
  readonly executionHandle: ManagedWorkspaceExecutionHandle;
}

export interface AdmitManagedWorkspaceMutationInput {
  readonly operationId: string;
  readonly toolName: 'Write' | 'Edit';
  readonly persistedArgs: unknown;
  readonly abortSignal: AbortSignal;
}

export interface ManagedWorkspaceMutationAdmission {
  readonly durableDispatch: Readonly<RuntimeEventManagedWorkspaceMutationV1>;
  readonly executionArgs: Readonly<Record<string, string>>;
  execute(
    operation: () => Promise<ManagedWorkspaceMutationOperationProof>,
  ): Promise<ManagedWorkspaceMutationSettlement>;
  /** Idempotent before T1 or after an admission is otherwise abandoned. */
  dispose(): Promise<void>;
}

export interface ManagedWorkspaceMutationOperationProof {
  readonly content: unknown;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly durableOutcome: import('@maka/core/runtime-event').RuntimeEvent;
}

export type ManagedWorkspaceMutationSettlement =
  | {
      readonly kind: 'workspace_successor_committed';
      readonly durableOutcome: import('@maka/core/runtime-event').RuntimeEvent;
    }
  | {
      readonly kind: 'no_workspace_change_committed';
      readonly durableOutcome: import('@maka/core/runtime-event').RuntimeEvent;
    }
  | {
      readonly kind: 'operation_failed_no_effect_committed';
      readonly durableOutcome: import('@maka/core/runtime-event').RuntimeEvent;
    };

export interface ManagedWorkspaceOwner {
  readonly state: 'ready' | 'closing' | 'closed';
  openManagedWorkspaceBaseline(
    store: RuntimeWorkspaceVersionAuthorityStore,
    input: OpenManagedWorkspaceBaselineInput,
  ): Promise<OpenManagedWorkspaceBaselineResult>;
  openManagedWorkspaceBaselineFromExecutionStores(
    stores: InteractiveExecutionStoresWriter,
    input: OpenManagedWorkspaceBaselineInput,
  ): Promise<OpenManagedWorkspaceBaselineResult>;
  withManagedWorkspaceExecution<T>(
    handle: ManagedWorkspaceExecutionHandle,
    operation: (scope: ManagedWorkspaceExecutionScope) => Promise<T>,
  ): Promise<T>;
  admitManagedWorkspaceMutation(
    handle: ManagedWorkspaceExecutionHandle,
    input: AdmitManagedWorkspaceMutationInput,
  ): Promise<ManagedWorkspaceMutationAdmission>;
  executeReadOnlyFilesystemOperation(
    scope: ManagedWorkspaceExecutionScope,
    operation: ManagedWorkspaceReadOnlyOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceReadOnlyResult>;
  executeManagedMutationFilesystemOperation(
    operation: ManagedWorkspaceMutationOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceMutationResult>;
  close(): Promise<void>;
}

export type {
  ManagedWorkspaceExecutionHandle,
  ManagedWorkspaceExecutionScope,
  ManagedWorkspaceFilesystemWorker,
  ManagedWorkspaceReadOnlyOperation,
  ManagedWorkspaceReadOnlyResult,
  VerifiedGitRuntimeInput,
};

const owners = new WeakMap<InteractiveRootOwner, object>();

export async function openManagedWorkspaceOwner(
  input: OpenManagedWorkspaceOwnerInput,
): Promise<ManagedWorkspaceOwner> {
  const rootOwner = authenticateInteractiveRootOwner(input.rootOwner);
  await assertInteractiveRootOwner(rootOwner);
  if (owners.has(rootOwner)) {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_conflict',
      'This storage root owner already has a managed workspace owner',
    );
  }

  const claim = {};
  owners.set(rootOwner, claim);
  try {
    const service = createGitWorkspaceService({
      storageRoot: rootOwner.capability.canonicalPath,
      gitRuntime: input.gitRuntime,
      ...(input.failpoint ? { failpoint: input.failpoint } : {}),
    });
    await runWithStorageRootLease(rootOwner.lease, 'interactive', 'write', () =>
      service.assertAvailable(),
    );
    // The root owner may begin closing while capability initialization is in
    // flight. Revalidate after the lease-bound operation so a stale lifecycle
    // owner is never published as ready.
    await assertInteractiveRootOwner(rootOwner);
    const owner = new ManagedWorkspaceOwnerImpl(
      rootOwner,
      service,
      requireManagedBaselineReceiptAuthorityInternal(service),
      requireManagedMutationCandidateAuthorityInternal(service),
      input.failpoint,
      input.filesystemWorker,
    );
    owners.set(rootOwner, owner);
    return owner;
  } catch (error) {
    if (owners.get(rootOwner) === claim) owners.delete(rootOwner);
    if (error instanceof ManagedWorkspaceOwnerError) throw error;
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      'Unable to initialize the managed workspace owner',
      { cause: error },
    );
  }
}

class ManagedWorkspaceOwnerImpl implements ManagedWorkspaceOwner {
  #state: 'ready' | 'closing' | 'closed' = 'ready';
  #activeOperations = 0;
  readonly #drainWaiters = new Set<() => void>();
  readonly #assertCurrentRootIdentity: () => Promise<void>;
  readonly #executionContext = new AsyncLocalStorage<object>();
  readonly #mutationExecutionContext = new AsyncLocalStorage<ManagedWorkspaceExecutionScope>();
  #closeTask: Promise<void> | undefined;
  readonly #executionOwnerToken = {};
  readonly #workerBridge: ManagedWorkspaceWorkerBridgeInternal | undefined;

  constructor(
    private readonly rootOwner: InteractiveRootOwner,
    private readonly service: GitWorkspaceService,
    private readonly receiptAuthority: ManagedBaselineReceiptAuthorityInternal,
    private readonly mutationCandidateAuthority: ManagedMutationCandidateAuthorityInternal,
    private readonly failpoint?: (point: ManagedWorkspaceOwnerFailpoint) => void | Promise<void>,
    filesystemWorker?: ManagedWorkspaceFilesystemWorker,
  ) {
    // Capture the identity guard while the lease is active. Unlike a fresh
    // admission check, this guard remains valid for an already-admitted
    // operation while owner.close() waits for that operation to drain.
    this.#assertCurrentRootIdentity = createStorageRootLeaseIdentityGuard(
      rootOwner.lease,
      'interactive',
      'write',
    );
    this.#workerBridge = filesystemWorker
      ? createManagedWorkspaceWorkerBridgeInternal(this.#executionOwnerToken, filesystemWorker)
      : undefined;
  }

  get state(): 'ready' | 'closing' | 'closed' {
    return this.#state;
  }

  async openManagedWorkspaceBaseline(
    store: RuntimeWorkspaceVersionAuthorityStore,
    input: OpenManagedWorkspaceBaselineInput,
  ): Promise<OpenManagedWorkspaceBaselineResult> {
    return this.#run(async () => {
      await assertWorkspaceBaselineAuthorityStoreRootInternal(
        store,
        this.rootOwner.capability.canonicalPath,
      );
      bindWorkspaceBaselineAuthorityStoreRootInternal(store, this.rootOwner.capability.rootId);
      await this.failpoint?.('after_initial_store_root_validation');
      const existingHead = await readWorkspaceHeadInternal(
        store,
        input.workspaceId,
        input.workspaceEpochId,
      );
      const receipt = existingHead
        ? await this.receiptAuthority.loadAcceptedContext(input)
        : undefined;
      let acceptedCandidate: ManagedMutationCandidateReceiptV1 | undefined;
      let binding: ManagedWorkspaceBinding;
      if (!receipt) {
        binding = await this.#requireReady(
          await this.service.createManagedWorkspaceFromSource(input),
        );
      } else if (isBaselineWorkspaceHead(existingHead!, receipt, receipt.binding)) {
        binding = await this.#openReadyBinding(receipt.binding);
      } else {
        binding = receipt.binding;
        const version = await store.readWorkspaceVersion(existingHead!.workspaceVersionId);
        if (!version || version.origin.kind !== 'tool_mutation') {
          throw new ManagedWorkspaceOwnerError(
            'managed_workspace_owner_unavailable',
            'Canonical managed workspace successor evidence is unavailable',
          );
        }
        acceptedCandidate = await this.mutationCandidateAuthority.require(
          binding,
          version.origin.operationId,
        );
        assertAcceptedSuccessorCandidate(binding, existingHead!, version, acceptedCandidate);
        await this.mutationCandidateAuthority.accept(binding, acceptedCandidate);
      }
      const durableReceipt = receipt ?? (await this.receiptAuthority.issue(binding));
      const committed = await commitWorkspaceBaselineInternal(store, {
        epochOpenedEventId: durableReceipt.epochOpenedEventId,
        baselineAcceptedEventId: durableReceipt.baselineAcceptedEventId,
        committedAt: MANAGED_BASELINE_LOGICAL_TIMESTAMP_V1,
        epoch: {
          repositoryId: binding.repositoryId,
          workspaceId: binding.workspaceId,
          workspaceEpochId: binding.workspaceEpochId,
          workspaceInstanceId: binding.workspaceInstanceId,
          mode: 'managed_worktree',
          objectFormat: binding.objectFormat,
          sourceCommitOid: binding.sourceHeadCommitOid,
          sourceTreeOid: binding.sourceTreeOid,
          materializationProfileDigest: binding.materializationProfileDigest,
          materializationSemantics: binding.materializationSemantics,
          policyHash: durableReceipt.policyHash,
        },
        baseline: {
          workspaceVersionId: durableReceipt.workspaceVersionId,
          commitOid: binding.baselineCommitOid,
          treeOid: binding.baselineTreeOid,
          treeDeltaDigest: durableReceipt.treeDeltaDigest,
          changedFileCount: durableReceipt.changedFileCount,
          deletedFileCount: durableReceipt.deletedFileCount,
        },
      });
      await this.failpoint?.('after_baseline_authority_commit');
      // The transaction writes through the already-open SQLite handle. Rebind
      // that handle to the canonical pathname after COMMIT so an external
      // rename/replacement cannot make an orphan database look accepted.
      await assertWorkspaceBaselineAuthorityStoreRootInternal(
        store,
        this.rootOwner.capability.canonicalPath,
      );
      bindWorkspaceBaselineAuthorityStoreRootInternal(store, this.rootOwner.capability.rootId);
      // Canonical acceptance never makes a missing Git artifact acceptable.
      // Reverify after the SQLite transaction so post-accept artifact loss is
      // reported fail-closed instead of returning a usable workspace head.
      if (acceptedCandidate) {
        await this.mutationCandidateAuthority.accept(binding, acceptedCandidate);
      } else {
        await this.receiptAuthority.verify(durableReceipt);
      }
      await this.failpoint?.('after_post_commit_artifact_verification');
      // The root marker is mutable host state and is not covered by receipt
      // verification. Revalidate its identity at the final return gate without
      // rejecting an operation that owner.close() is legitimately draining.
      await this.#assertCurrentRootIdentity();
      const internalHead = freezeWorkspaceHead(committed.head);
      const internalBinding = freezeManagedWorkspaceBinding(binding);
      const internalReceipt = freezeManagedWorkspaceReceipt(durableReceipt);
      return {
        created: committed.created,
        head: freezeWorkspaceHead(committed.head),
        executionHandle: issueManagedWorkspaceExecutionHandleInternal(this.#executionOwnerToken, {
          store,
          binding: internalBinding,
          receipt: internalReceipt,
          head: internalHead,
          ...(acceptedCandidate
            ? { candidateReceipt: Object.freeze(structuredClone(acceptedCandidate)) }
            : {}),
        }),
      };
    });
  }

  openManagedWorkspaceBaselineFromExecutionStores(
    stores: InteractiveExecutionStoresWriter,
    input: OpenManagedWorkspaceBaselineInput,
  ): Promise<OpenManagedWorkspaceBaselineResult> {
    return this.openManagedWorkspaceBaseline(
      requireExecutionStoresWorkspaceAuthorityInternal(stores),
      input,
    );
  }

  async withManagedWorkspaceExecution<T>(
    handle: ManagedWorkspaceExecutionHandle,
    operation: (scope: ManagedWorkspaceExecutionScope) => Promise<T>,
  ): Promise<T> {
    return this.#run(async () => {
      let accepted;
      try {
        accepted = requireManagedWorkspaceExecutionHandleInternal(
          this.#executionOwnerToken,
          handle,
        );
      } catch (error) {
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_execution_handle_invalid',
          'Managed workspace execution handle is invalid for this owner',
          { cause: error },
        );
      }
      assertExecutionCrossPlaneIdentity(
        accepted.binding,
        accepted.receipt,
        accepted.head,
        accepted.candidateReceipt,
      );
      // Test builds with a failpoint retain a preliminary proof so crash tests
      // can stop after a real, completed artifact verification. The ordinary
      // production path performs only the final proof below.
      if (this.failpoint) {
        await this.#verifyExecutionStateOrQuarantine(accepted);
        await this.failpoint('after_execution_artifact_verification');
      }

      // The root write lease excludes cooperating Maka writers across this
      // proof bundle. Verify the durable Git artifact first, then make the
      // immutable workspace head the final durable reread before scope issue.
      await this.#assertCurrentRootIdentity();
      await this.#verifyExecutionStateOrQuarantine(accepted);
      const currentHead = await readWorkspaceHeadInternal(
        accepted.store,
        accepted.binding.workspaceId,
        accepted.binding.workspaceEpochId,
      );
      // Rebind only after the head read. This catches a database pathname
      // detach at the admission boundary without putting a mutable DB guard
      // ahead of the durable head evidence it protects.
      await assertWorkspaceBaselineAuthorityStoreRootInternal(
        accepted.store,
        this.rootOwner.capability.canonicalPath,
      );
      bindWorkspaceBaselineAuthorityStoreRootInternal(
        accepted.store,
        this.rootOwner.capability.rootId,
      );
      if (!currentHead || !sameWorkspaceHead(currentHead, accepted.head)) {
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_owner_unavailable',
          'Managed workspace execution handle no longer matches the canonical workspace head',
        );
      }
      assertExecutionCrossPlaneIdentity(
        accepted.binding,
        accepted.receipt,
        currentHead,
        accepted.candidateReceipt,
      );
      const binding = accepted.binding;
      const scope = issueManagedWorkspaceExecutionScopeInternal(this.#executionOwnerToken, {
        provisioning: 'canonical_tree_only_v1',
        workspaceEffect: 'none',
        cwd: binding.worktreePath,
        binding: Object.freeze({ ...binding }),
        head: freezeWorkspaceHead(currentHead),
      });
      try {
        return await this.#executionContext.run(this.#executionOwnerToken, () => operation(scope));
      } finally {
        revokeManagedWorkspaceExecutionScopeInternal(this.#executionOwnerToken, scope);
      }
    });
  }

  async admitManagedWorkspaceMutation(
    handle: ManagedWorkspaceExecutionHandle,
    input: AdmitManagedWorkspaceMutationInput,
  ): Promise<ManagedWorkspaceMutationAdmission> {
    return this.#run(async () => {
      input.abortSignal.throwIfAborted();
      if (!this.#workerBridge) {
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_worker_unavailable',
          'Managed workspace mutation requires the sandboxed filesystem worker',
        );
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.operationId)) {
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_execution_handle_invalid',
          'Managed workspace mutation operation identity is invalid',
        );
      }
      let accepted;
      try {
        accepted = requireManagedWorkspaceExecutionHandleInternal(
          this.#executionOwnerToken,
          handle,
        );
      } catch (error) {
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_execution_handle_invalid',
          'Managed workspace execution handle is invalid for this owner',
          { cause: error },
        );
      }
      assertExecutionCrossPlaneIdentity(
        accepted.binding,
        accepted.receipt,
        accepted.head,
        accepted.candidateReceipt,
      );
      await this.#assertCurrentRootIdentity();
      await this.#verifyExecutionStateOrQuarantine(accepted);
      const currentHead = await readWorkspaceHeadInternal(
        accepted.store,
        accepted.binding.workspaceId,
        accepted.binding.workspaceEpochId,
      );
      await assertWorkspaceBaselineAuthorityStoreRootInternal(
        accepted.store,
        this.rootOwner.capability.canonicalPath,
      );
      bindWorkspaceBaselineAuthorityStoreRootInternal(
        accepted.store,
        this.rootOwner.capability.rootId,
      );
      if (!currentHead || !sameWorkspaceHead(currentHead, accepted.head)) {
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_owner_unavailable',
          'Managed mutation base no longer matches the canonical workspace head',
        );
      }
      assertExecutionCrossPlaneIdentity(
        accepted.binding,
        accepted.receipt,
        currentHead,
        accepted.candidateReceipt,
      );
      const active = await readActiveManagedMutationInternal(
        accepted.store,
        accepted.binding.workspaceInstanceId,
      );
      if (active) {
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_owner_unavailable',
          `Managed workspace already has active mutation ${active.operationId}`,
        );
      }
      const canonicalInput = canonicalManagedMutationInput(input.toolName, input.persistedArgs);
      const expectedPath = canonicalInput.path;
      input.abortSignal.throwIfAborted();
      const durableDispatch = Object.freeze({
        protocol: 'managed_mutation_v1' as const,
        repositoryId: accepted.binding.repositoryId,
        workspaceId: accepted.binding.workspaceId,
        workspaceEpochId: accepted.binding.workspaceEpochId,
        workspaceInstanceId: accepted.binding.workspaceInstanceId,
        objectFormat: accepted.binding.objectFormat,
        baseWorkspaceVersionId: currentHead.workspaceVersionId,
        baseAcceptedEventId: currentHead.acceptedEventId,
        baseHeadRevision: currentHead.revision,
        baseCommitOid: currentHead.commitOid,
        baseTreeOid: currentHead.treeOid,
        expectedPaths: Object.freeze([expectedPath]),
        executionProfileDigest: this.#workerBridge.mutationExecutionProfileDigest,
      });
      let state: 'open' | 'executing' | 'closed' = 'open';
      const execute = async (
        operation: () => Promise<ManagedWorkspaceMutationOperationProof>,
      ): Promise<ManagedWorkspaceMutationSettlement> => {
        if (state !== 'open') {
          throw new ManagedWorkspaceOwnerError(
            'managed_workspace_owner_unavailable',
            'Managed workspace mutation admission is no longer active',
          );
        }
        state = 'executing';
        try {
          return await this.#run(async () => {
            input.abortSignal.throwIfAborted();
            const reservation = await readActiveManagedMutationInternal(
              accepted.store,
              accepted.binding.workspaceInstanceId,
            );
            assertManagedMutationReservation(reservation, input.operationId, durableDispatch);
            const scope = issueManagedWorkspaceExecutionScopeInternal(this.#executionOwnerToken, {
              provisioning: 'canonical_tree_only_v1',
              workspaceEffect: 'mutation',
              cwd: accepted.binding.worktreePath,
              binding: accepted.binding,
              head: freezeWorkspaceHead(currentHead),
              operationId: input.operationId,
              expectedPaths: durableDispatch.expectedPaths,
            });
            try {
              const proof = await this.#executionContext.run(this.#executionOwnerToken, () =>
                this.#mutationExecutionContext.run(scope, operation),
              );
              if (proof.isError) {
                await this.#requireReady(accepted.binding);
                await commitManagedMutationTerminalInternal(accepted.store, {
                  disposition: 'operation_failed_no_effect_committed',
                  toolOutcome: {
                    operationId: input.operationId,
                    journalEventId: `${input.operationId}_outcome`,
                    runtimeEvent: proof.durableOutcome,
                    committedAt: proof.durableOutcome.ts,
                  },
                });
                return Object.freeze({
                  kind: 'operation_failed_no_effect_committed' as const,
                  durableOutcome: proof.durableOutcome,
                });
              }
              let candidate: ManagedMutationCandidateReceiptV1;
              try {
                candidate = await this.mutationCandidateAuthority.capture({
                  binding: accepted.binding,
                  operationId: input.operationId,
                  baseHead: currentHead,
                  expectedPaths: durableDispatch.expectedPaths,
                  executionProfileDigest: durableDispatch.executionProfileDigest,
                });
              } catch (error) {
                if (
                  !(error instanceof GitWorkspaceServiceError) ||
                  error.code !== 'managed_mutation_no_change'
                ) {
                  throw error;
                }
                await this.#requireReady(accepted.binding);
                await commitManagedMutationTerminalInternal(accepted.store, {
                  disposition: 'no_workspace_change_committed',
                  toolOutcome: {
                    operationId: input.operationId,
                    journalEventId: `${input.operationId}_outcome`,
                    runtimeEvent: proof.durableOutcome,
                    committedAt: proof.durableOutcome.ts,
                  },
                });
                return Object.freeze({
                  kind: 'no_workspace_change_committed' as const,
                  durableOutcome: proof.durableOutcome,
                });
              }
              const identity = successorIdentity(candidate);
              const committed = await commitWorkspaceSuccessorInternal(accepted.store, {
                successor: {
                  acceptedEventId: identity.acceptedEventId,
                  committedAt: proof.durableOutcome.ts,
                  successor: {
                    repositoryId: candidate.repositoryId,
                    workspaceId: candidate.workspaceId,
                    workspaceEpochId: candidate.workspaceEpochId,
                    workspaceVersionId: identity.workspaceVersionId,
                    objectFormat: candidate.objectFormat,
                    parentWorkspaceVersionId: currentHead.workspaceVersionId,
                    baseAcceptedEventId: currentHead.acceptedEventId,
                    baseHeadRevision: currentHead.revision,
                    commitOid: candidate.candidateCommitOid,
                    treeOid: candidate.candidateTreeOid,
                    policyHash: candidate.workspacePolicyHash,
                    treeDeltaDigest: candidate.treeDeltaDigest,
                    changedPaths: candidate.changedPaths,
                    changedFileCount: candidate.changedPaths.length,
                    deletedFileCount: candidate.deletedPaths.length,
                    executionProfileDigest: candidate.executionProfileDigest,
                  },
                  origin: {
                    operationId: input.operationId,
                    dispatchEventId: reservation!.dispatchEventId,
                    outcomeEventId: proof.durableOutcome.id,
                  },
                },
                toolOutcome: {
                  operationId: input.operationId,
                  journalEventId: `${input.operationId}_outcome`,
                  runtimeEvent: proof.durableOutcome,
                  committedAt: proof.durableOutcome.ts,
                },
              });
              await this.failpoint?.('after_managed_successor_commit');
              await this.mutationCandidateAuthority.accept(accepted.binding, candidate);
              await this.failpoint?.('after_managed_candidate_accept');
              advanceManagedWorkspaceExecutionHandleInternal(
                this.#executionOwnerToken,
                handle,
                freezeWorkspaceHead(committed.head),
                Object.freeze(structuredClone(candidate)),
              );
              return Object.freeze({
                kind: 'workspace_successor_committed' as const,
                durableOutcome: proof.durableOutcome,
              });
            } finally {
              revokeManagedWorkspaceExecutionScopeInternal(this.#executionOwnerToken, scope);
            }
          });
        } finally {
          state = 'closed';
        }
      };
      return Object.freeze({
        durableDispatch,
        executionArgs: canonicalInput.executionArgs,
        execute,
        async dispose() {
          if (state === 'open') state = 'closed';
        },
      });
    });
  }

  async executeReadOnlyFilesystemOperation(
    scope: ManagedWorkspaceExecutionScope,
    operation: ManagedWorkspaceReadOnlyOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceReadOnlyResult> {
    if (!this.#workerBridge) {
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_worker_unavailable',
        'Managed workspace filesystem worker is unavailable',
      );
    }
    return await this.#workerBridge.execute(scope, operation, abortSignal);
  }

  async executeManagedMutationFilesystemOperation(
    operation: ManagedWorkspaceMutationOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceMutationResult> {
    if (!this.#workerBridge) {
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_worker_unavailable',
        'Managed workspace filesystem worker is unavailable',
      );
    }
    const scope = this.#mutationExecutionContext.getStore();
    if (!scope) {
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_execution_handle_invalid',
        'Managed mutation worker is available only inside its active admission',
      );
    }
    return await this.#workerBridge.executeMutation(scope, operation, abortSignal);
  }

  close(): Promise<void> {
    if (this.#executionContext.getStore() === this.#executionOwnerToken) {
      return Promise.reject(
        new ManagedWorkspaceOwnerError(
          'managed_workspace_owner_reentrant_close',
          'Managed workspace owner cannot close from its own execution callback',
        ),
      );
    }
    this.#closeTask ??= (async () => {
      this.#state = 'closing';
      await this.#waitForDrain();
      this.#state = 'closed';
    })();
    return this.#closeTask;
  }

  #assertReady(): void {
    if (this.#state !== 'ready') {
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_owner_closing',
        'Managed workspace owner is closing or closed',
      );
    }
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertReady();
    this.#activeOperations += 1;
    try {
      return await runWithStorageRootLease(this.rootOwner.lease, 'interactive', 'write', operation);
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        for (const resolve of this.#drainWaiters) resolve();
        this.#drainWaiters.clear();
      }
    }
  }

  #waitForDrain(): Promise<void> {
    if (this.#activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.add(resolve));
  }

  async #requireReady(binding: ManagedWorkspaceBinding): Promise<ManagedWorkspaceBinding> {
    const inspection = await this.service.inspectManagedWorkspace(binding);
    if (inspection.state === 'ready') return binding;
    const quarantine = await this.service.quarantineManagedWorkspace(
      binding,
      'external_workspace_drift',
    );
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_quarantined',
      `Managed workspace drift was quarantined at ${quarantine.quarantinePath}`,
    );
  }

  async #openReadyBinding(binding: ManagedWorkspaceBinding): Promise<ManagedWorkspaceBinding> {
    try {
      return await this.#requireReady(await this.service.openManagedWorkspaceFromBinding(binding));
    } catch (error) {
      if (
        !(error instanceof GitWorkspaceServiceError) ||
        error.code !== 'managed_workspace_drifted'
      ) {
        throw error;
      }
      const quarantine = await this.service.quarantineManagedWorkspace(
        binding,
        'external_workspace_drift',
      );
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_quarantined',
        `Managed workspace drift was quarantined at ${quarantine.quarantinePath}`,
        { cause: error },
      );
    }
  }

  async #verifyExecutionArtifactOrQuarantine(
    binding: ManagedWorkspaceBinding,
    receipt: ManagedWorkspaceBaselineReceiptV1,
  ): Promise<void> {
    try {
      await this.receiptAuthority.verify(receipt);
    } catch (error) {
      if (
        !(error instanceof GitWorkspaceServiceError) ||
        error.code !== 'managed_workspace_drifted'
      ) {
        throw error;
      }
      const quarantine = await this.service.quarantineManagedWorkspace(
        binding,
        'external_workspace_drift',
      );
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_quarantined',
        `Managed workspace drift was quarantined at ${quarantine.quarantinePath}`,
        { cause: error },
      );
    }
  }

  async #verifyExecutionStateOrQuarantine(
    accepted: ReturnType<typeof requireManagedWorkspaceExecutionHandleInternal>,
  ): Promise<void> {
    if (!accepted.candidateReceipt) {
      await this.#verifyExecutionArtifactOrQuarantine(accepted.binding, accepted.receipt);
      return;
    }
    try {
      await this.mutationCandidateAuthority.accept(accepted.binding, accepted.candidateReceipt);
    } catch (error) {
      if (
        !(error instanceof GitWorkspaceServiceError) ||
        error.code !== 'managed_workspace_drifted'
      ) {
        throw error;
      }
      const quarantine = await this.service.quarantineManagedWorkspace(
        accepted.binding,
        'external_workspace_drift',
      );
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_quarantined',
        `Managed workspace drift was quarantined at ${quarantine.quarantinePath}`,
        { cause: error },
      );
    }
  }
}

function canonicalManagedMutationInput(
  toolName: 'Write' | 'Edit',
  persistedArgs: unknown,
): {
  readonly path: string;
  readonly executionArgs: Readonly<Record<string, string>>;
} {
  if (!persistedArgs || typeof persistedArgs !== 'object' || Array.isArray(persistedArgs)) {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      `Managed ${toolName} arguments are invalid`,
    );
  }
  const record = persistedArgs as Record<string, unknown>;
  const expectedKeys =
    toolName === 'Write' ? ['content', 'path'] : ['new_string', 'old_string', 'path'];
  if (
    Object.keys(record).sort().join('\0') !== expectedKeys.join('\0') ||
    typeof record.path !== 'string' ||
    (toolName === 'Write' && typeof record.content !== 'string') ||
    (toolName === 'Edit' &&
      (typeof record.old_string !== 'string' || typeof record.new_string !== 'string'))
  ) {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      `Managed ${toolName} arguments are invalid`,
    );
  }
  const path = process.platform === 'win32' ? record.path.replaceAll('\\', '/') : record.path;
  if (!isCanonicalManagedMutationPathV1(path)) {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      'Managed workspace mutation path is not a canonical tracked file path',
    );
  }
  const executionArgs =
    toolName === 'Write'
      ? Object.freeze({ path, content: record.content as string })
      : Object.freeze({
          path,
          old_string: record.old_string as string,
          new_string: record.new_string as string,
        });
  return Object.freeze({ path, executionArgs });
}

function assertManagedMutationReservation(
  reservation: Awaited<ReturnType<typeof readActiveManagedMutationInternal>>,
  operationId: string,
  dispatch: RuntimeEventManagedWorkspaceMutationV1,
): void {
  if (
    !reservation ||
    reservation.operationId !== operationId ||
    reservation.workspaceInstanceId !== dispatch.workspaceInstanceId ||
    reservation.repositoryId !== dispatch.repositoryId ||
    reservation.workspaceId !== dispatch.workspaceId ||
    reservation.workspaceEpochId !== dispatch.workspaceEpochId ||
    reservation.baseWorkspaceVersionId !== dispatch.baseWorkspaceVersionId ||
    reservation.baseAcceptedEventId !== dispatch.baseAcceptedEventId ||
    reservation.baseHeadRevision !== dispatch.baseHeadRevision ||
    reservation.baseCommitOid !== dispatch.baseCommitOid ||
    reservation.baseTreeOid !== dispatch.baseTreeOid ||
    reservation.executionProfileDigest !== dispatch.executionProfileDigest ||
    reservation.expectedPaths.length !== dispatch.expectedPaths.length ||
    reservation.expectedPaths.some((path, index) => path !== dispatch.expectedPaths[index])
  ) {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      'Managed mutation reservation does not match its owner-issued admission',
    );
  }
}

function successorIdentity(receipt: {
  readonly operationId: string;
  readonly workspaceEpochId: string;
  readonly candidateCommitOid: string;
  readonly candidateTreeOid: string;
}): { acceptedEventId: string; workspaceVersionId: string } {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        protocol: 'maka_managed_workspace_successor_identity_v1',
        operationId: receipt.operationId,
        workspaceEpochId: receipt.workspaceEpochId,
        candidateCommitOid: receipt.candidateCommitOid,
        candidateTreeOid: receipt.candidateTreeOid,
      }),
      'utf8',
    )
    .digest('hex');
  return {
    acceptedEventId: `workspace-successor-${digest.slice(0, 32)}`,
    workspaceVersionId: `version_${digest.slice(32)}`,
  };
}

function sameWorkspaceHead(left: WorkspaceHeadRecordV1, right: WorkspaceHeadRecordV1): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.repositoryId === right.repositoryId &&
    left.workspaceEpochId === right.workspaceEpochId &&
    left.workspaceVersionId === right.workspaceVersionId &&
    left.acceptedEventId === right.acceptedEventId &&
    left.commitOid === right.commitOid &&
    left.treeOid === right.treeOid &&
    left.revision === right.revision
  );
}

function freezeWorkspaceHead(head: WorkspaceHeadRecordV1): Readonly<WorkspaceHeadRecordV1> {
  return Object.freeze({ ...head });
}

function freezeManagedWorkspaceBinding(
  binding: ManagedWorkspaceBinding,
): Readonly<ManagedWorkspaceBinding> {
  return Object.freeze({ ...binding });
}

function freezeManagedWorkspaceReceipt(
  receipt: ManagedWorkspaceBaselineReceiptV1,
): Readonly<ManagedWorkspaceBaselineReceiptV1> {
  return Object.freeze({ ...receipt, binding: freezeManagedWorkspaceBinding(receipt.binding) });
}

function isBaselineWorkspaceHead(
  head: WorkspaceHeadRecordV1,
  receipt: ManagedWorkspaceBaselineReceiptV1,
  binding: ManagedWorkspaceBinding,
): boolean {
  return (
    head.workspaceVersionId === receipt.workspaceVersionId &&
    head.acceptedEventId === receipt.baselineAcceptedEventId &&
    head.commitOid === binding.baselineCommitOid &&
    head.treeOid === binding.baselineTreeOid &&
    head.revision === 1
  );
}

function assertAcceptedSuccessorCandidate(
  binding: ManagedWorkspaceBinding,
  head: WorkspaceHeadRecordV1,
  version: WorkspaceVersionRecordV1,
  candidate: ManagedMutationCandidateReceiptV1,
): void {
  if (version.protocol !== 'workspace_version_accepted_v1') {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      'Canonical successor does not match its owner-derived Git candidate',
    );
  }
  const changedPathsMatch =
    version.changedPaths.length === candidate.changedPaths.length &&
    version.changedPaths.every((path, index) => path === candidate.changedPaths[index]);
  if (
    version.repositoryId !== binding.repositoryId ||
    version.workspaceId !== binding.workspaceId ||
    version.workspaceEpochId !== binding.workspaceEpochId ||
    version.workspaceVersionId !== head.workspaceVersionId ||
    version.acceptedEventId !== head.acceptedEventId ||
    version.commitOid !== head.commitOid ||
    version.treeOid !== head.treeOid ||
    version.origin.operationId !== candidate.operationId ||
    version.parents[0] !== candidate.baseHead.workspaceVersionId ||
    version.baseAcceptedEventId !== candidate.baseHead.acceptedEventId ||
    version.baseHeadRevision !== candidate.baseHead.revision ||
    head.revision !== candidate.baseHead.revision + 1 ||
    candidate.candidateCommitOid !== head.commitOid ||
    candidate.candidateTreeOid !== head.treeOid ||
    version.policyHash !== candidate.workspacePolicyHash ||
    version.treeDeltaDigest !== candidate.treeDeltaDigest ||
    version.executionProfileDigest !== candidate.executionProfileDigest ||
    version.changedFileCount !== candidate.changedPaths.length ||
    version.deletedFileCount !== candidate.deletedPaths.length ||
    !changedPathsMatch
  ) {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      'Canonical successor does not match its owner-derived Git candidate',
    );
  }
}

function assertExecutionCrossPlaneIdentity(
  binding: ManagedWorkspaceBinding,
  receipt: ManagedWorkspaceBaselineReceiptV1,
  head: Readonly<WorkspaceHeadRecordV1>,
  candidateReceipt?: Readonly<ManagedMutationCandidateReceiptV1>,
): void {
  const commonMismatch =
    !sameManagedWorkspaceBinding(binding, receipt.binding) ||
    head.repositoryId !== binding.repositoryId ||
    head.workspaceId !== binding.workspaceId ||
    head.workspaceEpochId !== binding.workspaceEpochId;
  const baselineMismatch =
    !candidateReceipt &&
    (head.workspaceVersionId !== receipt.workspaceVersionId ||
      head.acceptedEventId !== receipt.baselineAcceptedEventId ||
      head.commitOid !== binding.baselineCommitOid ||
      head.treeOid !== binding.baselineTreeOid);
  const candidateMismatch =
    candidateReceipt &&
    (candidateReceipt.repositoryId !== binding.repositoryId ||
      candidateReceipt.workspaceId !== binding.workspaceId ||
      candidateReceipt.workspaceEpochId !== binding.workspaceEpochId ||
      candidateReceipt.workspaceInstanceId !== binding.workspaceInstanceId ||
      candidateReceipt.candidateCommitOid !== head.commitOid ||
      candidateReceipt.candidateTreeOid !== head.treeOid);
  if (commonMismatch || baselineMismatch || candidateMismatch) {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      'Managed workspace execution evidence does not identify one exact accepted boundary',
    );
  }
}

function sameManagedWorkspaceBinding(
  left: ManagedWorkspaceBinding,
  right: ManagedWorkspaceBinding,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.protocol === right.protocol &&
    left.repositoryId === right.repositoryId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceEpochId === right.workspaceEpochId &&
    left.workspaceInstanceId === right.workspaceInstanceId &&
    left.sourceRoot === right.sourceRoot &&
    left.sourceGitCommonDir === right.sourceGitCommonDir &&
    left.sourceHeadCommitOid === right.sourceHeadCommitOid &&
    left.sourceTreeOid === right.sourceTreeOid &&
    left.repositoryPath === right.repositoryPath &&
    left.worktreePath === right.worktreePath &&
    left.hooksPath === right.hooksPath &&
    left.baselineCommitOid === right.baselineCommitOid &&
    left.baselineTreeOid === right.baselineTreeOid &&
    left.headRef === right.headRef &&
    left.gitRuntimeSha256 === right.gitRuntimeSha256 &&
    left.objectFormat === right.objectFormat &&
    left.materializationProfileDigest === right.materializationProfileDigest &&
    left.materializationSemantics === right.materializationSemantics
  );
}
