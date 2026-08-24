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

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { workspaceMutationPolicyHashV1 } from '@maka/core/workspace-version-authority';
import { GITOXIDE_MANAGED_MUTATION_TRANSFORM_PROFILE_DIGEST } from '@maka/runtime/managed-mutation-transform';
import type { ToolRuntimeInput } from '@maka/runtime/tool-runtime';
import type { ManagedWorkspaceContinuationBoundaryV1 } from '@maka/core/runtime-boundary';
import type { WorkspaceHeadRecordV1 } from '@maka/core/workspace-version-authority';
import type { ExecutionStoresWorkspaceMutationAuthorityInternal } from '@maka/storage/execution-stores-workspace-authority-internal';
import { runWithStorageRootLease, type StorageRootLease } from '@maka/storage/root-authority';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import { verifyGitoxideHelperArtifactForInvocationInternal } from './gitoxide-helper-artifact-authority-internal.js';
import {
  importSourceHeadWithGitoxideHelperInternal,
  inspectManagedRefWithGitoxideHelperInternal,
} from './gitoxide-helper-invocation-internal.js';
import {
  admitGitoxideRepositoryInternal,
  requireGitoxideRepositoryAdmissionInternal,
} from './gitoxide-repository-admission-authority-internal.js';
import {
  createGitoxideMutationCandidateAuthorityInternal,
  gitoxideManagedRepositoryPathInternal,
} from './gitoxide-helper-mutation-candidate-authority-internal.js';
import {
  createGitoxideManagedMutationAdmissionInternal,
  reconcilePreparedGitoxideManagedMutationInternal,
  type GitoxideManagedMutationAdmissionFailpoint,
  reconcileGitoxideManagedMutationProjectionInternal,
} from './gitoxide-managed-mutation-admission.js';
import type { GitoxideInspectionRepositoryProviderInternal } from './gitoxide-managed-inspection.js';

const ACCEPTED_REF = 'refs/maka/accepted';
const RECEIPT_PROTOCOL = 'maka_gitoxide_managed_mutation_baseline_v1';

interface BaselineIntentV1 {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_gitoxide_managed_mutation_baseline_intent_v1';
  readonly sourceRoot: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceInstanceId: string;
  readonly workspaceVersionId: string;
  readonly sourceCommitOid: string;
  readonly sourceTreeOid: string;
  readonly helperArtifactSha256: `sha256:${string}`;
}

interface BaselineReceiptV1 extends Omit<BaselineIntentV1, 'protocol'> {
  readonly protocol: typeof RECEIPT_PROTOCOL;
  readonly baselineCommitOid: string;
  readonly baselineTreeOid: string;
  readonly filesImported: number;
  readonly bytesImported: number;
}

export interface GitoxideManagedMutationSession {
  readonly head: WorkspaceHeadRecordV1;
  readonly admitManagedMutation: NonNullable<ToolRuntimeInput['admitManagedMutation']>;
  readonly inspectionRepositoryProvider: GitoxideInspectionRepositoryProviderInternal;
  readonly reconcileProjection: (abortSignal?: AbortSignal) => Promise<void>;
}

export type GitoxideManagedMutationRecoveryGate =
  | { readonly kind: 'settled' }
  | { readonly kind: 'no_active_mutation' }
  | { readonly kind: 'parked'; readonly reason: string };

/**
 * Runs before generic AgentRun recovery is allowed to append a terminal fact.
 * It deliberately proves the absence of a reservation without opening a new
 * baseline, and fails closed when an active T1 cannot be reconciled.
 */
export async function recoverGitoxideManagedMutationBeforeRunClosureInternal(input: {
  readonly storageRootLease: StorageRootLease<'interactive', 'write'>;
  readonly sourceRoot: string;
  readonly sessionId: string;
  readonly settlementAuthority: ExecutionStoresWorkspaceMutationAuthorityInternal;
  readonly invocationOwnerToken?: object;
  readonly helperCapability?: GitoxideHelperInvocationCapability;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideManagedMutationRecoveryGate> {
  try {
    input.abortSignal?.throwIfAborted();
    const sourceRoot = await realpath(input.sourceRoot);
    const identity = managedMutationIdentity(sourceRoot, input.sessionId);
    input.settlementAuthority.adoptRootForManagedExecution();
    const active = await input.settlementAuthority.readActiveManagedMutation(
      identity.workspaceInstanceId,
    );
    if (!active) return Object.freeze({ kind: 'no_active_mutation' as const });
    if (!input.invocationOwnerToken || !input.helperCapability) {
      return Object.freeze({
        kind: 'parked' as const,
        reason: 'Gitoxide managed mutation recovery capability is unavailable',
      });
    }
    await openGitoxideManagedMutationSession({
      storageRootLease: input.storageRootLease,
      sourceRoot,
      sessionId: input.sessionId,
      invocationOwnerToken: input.invocationOwnerToken,
      helperCapability: input.helperCapability,
      settlementAuthority: input.settlementAuthority,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    return Object.freeze({ kind: 'settled' as const });
  } catch (error) {
    return Object.freeze({
      kind: 'parked' as const,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Re-observes an already accepted managed workspace without creating a
 * baseline. This is the only Host seam allowed to issue the workspace half of
 * a continuation boundary.
 */
export async function inspectGitoxideManagedContinuationBoundary(input: {
  readonly storageRootLease: StorageRootLease<'interactive', 'write'>;
  readonly sourceRoot: string;
  readonly sessionId: string;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly settlementAuthority: ExecutionStoresWorkspaceMutationAuthorityInternal;
  readonly abortSignal?: AbortSignal;
}): Promise<ManagedWorkspaceContinuationBoundaryV1 | undefined> {
  input.abortSignal?.throwIfAborted();
  const [storageRoot, sourceRoot, helper] = await Promise.all([
    runWithStorageRootLease(input.storageRootLease, 'interactive', 'write', async (root) => root),
    realpath(input.sourceRoot),
    verifyGitoxideHelperArtifactForInvocationInternal(
      input.invocationOwnerToken,
      input.helperCapability,
    ),
  ]);
  const materializationProfileDigest = sha256(
    `maka-gitoxide-materialization-v1\0${helper.artifactSha256}\0`,
  );
  const workspacePolicyHash = workspaceMutationPolicyHashV1(
    materializationProfileDigest,
    GITOXIDE_MANAGED_MUTATION_TRANSFORM_PROFILE_DIGEST,
  );
  const identity = managedMutationIdentity(sourceRoot, input.sessionId);
  const boundary = await input.settlementAuthority.readContinuationBoundary(
    identity.workspaceId,
    identity.workspaceEpochId,
    GITOXIDE_MANAGED_MUTATION_TRANSFORM_PROFILE_DIGEST,
  );
  if (!boundary) return undefined;
  if (
    boundary.repositoryId !== identity.repositoryId ||
    boundary.workspaceId !== identity.workspaceId ||
    boundary.workspaceEpochId !== identity.workspaceEpochId ||
    boundary.workspaceInstanceId !== identity.workspaceInstanceId
  ) {
    throw new Error('Gitoxide managed continuation boundary conflicts with session identity');
  }
  const repositoryPath = gitoxideManagedRepositoryPathInternal(storageRoot, identity);
  const receipt = await readBaselineReceipt(join(dirname(repositoryPath), 'baseline-receipt.json'));
  if (
    !receipt ||
    receipt.repositoryId !== boundary.repositoryId ||
    receipt.workspaceId !== boundary.workspaceId ||
    receipt.workspaceEpochId !== boundary.workspaceEpochId ||
    receipt.workspaceInstanceId !== boundary.workspaceInstanceId ||
    receipt.helperArtifactSha256 !== helper.artifactSha256 ||
    boundary.materializationProfileDigest !== materializationProfileDigest ||
    boundary.executionProfileDigest !==
      GITOXIDE_MANAGED_MUTATION_TRANSFORM_PROFILE_DIGEST ||
    boundary.policyHash !== workspacePolicyHash
  ) {
    throw new Error('Gitoxide managed continuation baseline receipt is unavailable');
  }
  await verifyAcceptedRef(input, repositoryPath, boundary.commitOid, boundary.treeOid);
  input.abortSignal?.throwIfAborted();
  return boundary;
}

/**
 * Opens one explicit managed-coding session. The source observation is frozen
 * before import, Gitoxide owns the immutable repository, SQLite owns accepted
 * versions, and Runtime owns each operation result.
 */
export async function openGitoxideManagedMutationSession(input: {
  readonly storageRootLease: StorageRootLease<'interactive', 'write'>;
  readonly sourceRoot: string;
  readonly sessionId: string;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly settlementAuthority: ExecutionStoresWorkspaceMutationAuthorityInternal;
  readonly abortSignal?: AbortSignal;
  readonly failpoint?: (point: GitoxideManagedMutationAdmissionFailpoint) => void | Promise<void>;
}): Promise<GitoxideManagedMutationSession> {
  input.abortSignal?.throwIfAborted();
  const [storageRoot, sourceRoot, helper] = await Promise.all([
    runWithStorageRootLease(input.storageRootLease, 'interactive', 'write', async (root) => root),
    realpath(input.sourceRoot),
    verifyGitoxideHelperArtifactForInvocationInternal(
      input.invocationOwnerToken,
      input.helperCapability,
    ),
  ]);
  const identity = managedMutationIdentity(sourceRoot, input.sessionId);
  const materializationProfileDigest = sha256(
    `maka-gitoxide-materialization-v1\0${helper.artifactSha256}\0`,
  );
  const workspacePolicyHash = workspaceMutationPolicyHashV1(
    materializationProfileDigest,
    GITOXIDE_MANAGED_MUTATION_TRANSFORM_PROFILE_DIGEST,
  );
  const repositoryPath = gitoxideManagedRepositoryPathInternal(storageRoot, identity);
  const controlRoot = dirname(repositoryPath);
  const intentPath = join(controlRoot, 'baseline-intent.json');
  const receiptPath = join(controlRoot, 'baseline-receipt.json');
  await mkdir(controlRoot, { recursive: true });
  input.settlementAuthority.adoptRootForManagedExecution();

  let head = await input.settlementAuthority.readHead(
    identity.workspaceId,
    identity.workspaceEpochId,
  );
  let receipt = await readBaselineReceipt(receiptPath);
  if (!head) {
    let intent = await readBaselineIntent(intentPath);
    if (!intent) {
      const admissionOwnerToken = {};
      const admitted = await admitGitoxideRepositoryInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        helperCapability: input.helperCapability,
        admissionOwnerToken,
        repositoryPath: sourceRoot,
        abortSignal: input.abortSignal,
      });
      if (admitted.kind !== 'accepted') {
        throw new Error(`Gitoxide managed coding rejected source: ${admitted.reason}`);
      }
      const observed = requireGitoxideRepositoryAdmissionInternal(
        admissionOwnerToken,
        admitted.capability,
      );
      intent = freezeIntent({
        schemaVersion: 1,
        protocol: 'maka_gitoxide_managed_mutation_baseline_intent_v1',
        sourceRoot,
        ...identity,
        sourceCommitOid: observed.headCommitOid,
        sourceTreeOid: observed.headTreeOid,
        helperArtifactSha256: helper.artifactSha256,
      });
      await writeJsonAtomic(intentPath, intent);
    }
    assertIntent(intent, sourceRoot, identity, helper.artifactSha256);
    if (!receipt) {
      const admissionOwnerToken = {};
      const admitted = await admitGitoxideRepositoryInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        helperCapability: input.helperCapability,
        admissionOwnerToken,
        repositoryPath: sourceRoot,
        abortSignal: input.abortSignal,
      });
      if (admitted.kind !== 'accepted') {
        throw new Error(`Gitoxide managed coding rejected source: ${admitted.reason}`);
      }
      const observed = requireGitoxideRepositoryAdmissionInternal(
        admissionOwnerToken,
        admitted.capability,
      );
      if (
        observed.headCommitOid !== intent.sourceCommitOid ||
        observed.headTreeOid !== intent.sourceTreeOid
      ) {
        throw new Error('Gitoxide source changed before its baseline became durable');
      }
      const imported = await importSourceHeadWithGitoxideHelperInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        capability: input.helperCapability,
        sourceRepositoryPath: sourceRoot,
        expectedSourceHeadCommitOid: intent.sourceCommitOid,
        destinationRepositoryPath: repositoryPath,
        baselineRef: ACCEPTED_REF,
        abortSignal: input.abortSignal,
      });
      receipt = freezeReceipt({
        ...intent,
        protocol: RECEIPT_PROTOCOL,
        baselineCommitOid: imported.baselineCommitOid,
        baselineTreeOid: imported.baselineTreeOid,
        filesImported: imported.filesImported,
        bytesImported: imported.bytesImported,
      });
      await writeJsonAtomic(receiptPath, receipt);
    }
    assertReceipt(receipt, intent);
    await verifyAcceptedRef(
      input,
      repositoryPath,
      receipt.baselineCommitOid,
      receipt.baselineTreeOid,
    );
    const committed = await input.settlementAuthority.commitBaseline({
      epochOpenedEventId: `workspace-epoch-${digest('epoch-event', identity.workspaceEpochId)}`,
      baselineAcceptedEventId: `workspace-baseline-${digest('baseline-event', identity.workspaceEpochId)}`,
      committedAt: 0,
      epoch: {
        repositoryId: identity.repositoryId,
        workspaceId: identity.workspaceId,
        workspaceEpochId: identity.workspaceEpochId,
        workspaceInstanceId: identity.workspaceInstanceId,
        mode: 'managed_worktree',
        objectFormat: 'sha1',
        sourceCommitOid: receipt.sourceCommitOid,
        sourceTreeOid: receipt.sourceTreeOid,
        materializationProfileDigest,
        materializationSemantics: 'git_tree_materialized_with_fixed_config_v1',
        policyHash: workspacePolicyHash,
      },
      baseline: {
        workspaceVersionId: receipt.workspaceVersionId,
        commitOid: receipt.baselineCommitOid,
        treeOid: receipt.baselineTreeOid,
        treeDeltaDigest: sha256(`maka-gitoxide-baseline-tree-v1\0${receipt.baselineTreeOid}\0`),
        changedFileCount: receipt.filesImported,
        deletedFileCount: 0,
      },
    });
    head = committed.head;
  }
  if (!receipt) throw new Error('Gitoxide managed coding baseline receipt is unavailable');
  if (receipt.helperArtifactSha256 !== helper.artifactSha256) {
    throw new Error('Gitoxide managed coding helper identity changed for this workspace epoch');
  }
  const baselineVersion = await input.settlementAuthority.readVersion(receipt.workspaceVersionId);
  if (
    !baselineVersion ||
    baselineVersion.protocol !== 'workspace_baseline_accepted_v1' ||
    baselineVersion.repositoryId !== receipt.repositoryId ||
    baselineVersion.workspaceId !== receipt.workspaceId ||
    baselineVersion.workspaceEpochId !== receipt.workspaceEpochId ||
    baselineVersion.commitOid !== receipt.baselineCommitOid ||
    baselineVersion.treeOid !== receipt.baselineTreeOid ||
    baselineVersion.policyHash !== workspacePolicyHash
  ) {
    throw new Error('Gitoxide baseline receipt conflicts with accepted baseline authority');
  }

  const candidateAuthorityForHead = (baseHead: WorkspaceHeadRecordV1) =>
    createGitoxideMutationCandidateAuthorityInternal({
      storageRootLease: input.storageRootLease,
      baseHead,
      invocationOwnerToken: input.invocationOwnerToken,
      helperCapability: input.helperCapability,
    });
  const activeReservation = await input.settlementAuthority.readActiveManagedMutation(
    identity.workspaceInstanceId,
  );
  if (activeReservation) {
    const operation = await input.settlementAuthority.readToolOperation(
      activeReservation.operationId,
    );
    if (!operation) {
      throw new Error('Active managed mutation reservation has no durable tool operation');
    }
    const runtimeEvents = await input.settlementAuthority.readRuntimeEvents(
      input.sessionId,
      operation.runId,
    );
    await reconcilePreparedGitoxideManagedMutationInternal({
      sessionId: input.sessionId,
      reservation: activeReservation,
      operation,
      runtimeEvents,
      settlementAuthority: input.settlementAuthority,
      candidateAuthorityForHead,
      abortSignal: input.abortSignal,
    });
  }
  await reconcileGitoxideManagedMutationProjectionInternal({
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
    settlementAuthority: input.settlementAuthority,
    candidateAuthorityForHead,
    abortSignal: input.abortSignal,
  });
  head = await input.settlementAuthority.readHead(identity.workspaceId, identity.workspaceEpochId);
  if (!head) throw new Error('Gitoxide managed coding lost its accepted workspace head');
  await verifyAcceptedRef(input, repositoryPath, head.commitOid, head.treeOid);
  const admitManagedMutation = createGitoxideManagedMutationAdmissionInternal({
    workspaceInstanceId: identity.workspaceInstanceId,
    workspaceId: identity.workspaceId,
    workspaceEpochId: identity.workspaceEpochId,
    settlementAuthority: input.settlementAuthority,
    candidateAuthorityForHead,
    failpoint: input.failpoint,
  });
  return Object.freeze({
    head,
    admitManagedMutation,
    inspectionRepositoryProvider: async ({
      abortSignal,
    }: {
      readonly sourceCwd: string;
      readonly repositoryPath: string;
      readonly abortSignal: AbortSignal;
    }) => {
      abortSignal.throwIfAborted();
      const currentHead = await input.settlementAuthority.readHead(
        identity.workspaceId,
        identity.workspaceEpochId,
      );
      if (!currentHead) throw new Error('Gitoxide managed inspection has no accepted head');
      const currentVersion = await input.settlementAuthority.readVersion(
        currentHead.workspaceVersionId,
      );
      if (
        !currentVersion ||
        currentVersion.repositoryId !== currentHead.repositoryId ||
        currentVersion.workspaceId !== currentHead.workspaceId ||
        currentVersion.workspaceEpochId !== currentHead.workspaceEpochId ||
        currentVersion.workspaceVersionId !== currentHead.workspaceVersionId ||
        currentVersion.acceptedEventId !== currentHead.acceptedEventId ||
        currentVersion.commitOid !== currentHead.commitOid ||
        currentVersion.treeOid !== currentHead.treeOid ||
        currentVersion.policyHash !== workspacePolicyHash
      ) {
        throw new Error('Gitoxide managed inspection head conflicts with workspace authority');
      }
      const authority = await candidateAuthorityForHead(currentHead);
      return Object.freeze({
        acceptedCommitOid: currentHead.commitOid,
        acceptedTreeOid: currentHead.treeOid,
        async readFile(path: string, signal: AbortSignal) {
          const file = await authority.readBaseFile(path, signal);
          if (!file) throw new Error(`Managed accepted tree file is unavailable: ${path}`);
          return Object.freeze({ path, content: file.content });
        },
        materializeProjection(destinationPath: string, signal: AbortSignal) {
          return authority.materializeBaseProjection(destinationPath, signal);
        },
      });
    },
    reconcileProjection: async (abortSignal?: AbortSignal) => {
      await reconcileGitoxideManagedMutationProjectionInternal({
        workspaceId: identity.workspaceId,
        workspaceEpochId: identity.workspaceEpochId,
        settlementAuthority: input.settlementAuthority,
        candidateAuthorityForHead,
        abortSignal,
      });
    },
  });
}

async function verifyAcceptedRef(
  input: Pick<
    Parameters<typeof openGitoxideManagedMutationSession>[0],
    'invocationOwnerToken' | 'helperCapability' | 'abortSignal'
  >,
  repositoryPath: string,
  expectedCommitOid: string,
  expectedTreeOid: string,
): Promise<void> {
  const observed = await inspectManagedRefWithGitoxideHelperInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    capability: input.helperCapability,
    repositoryPath,
    targetRef: ACCEPTED_REF,
    abortSignal: input.abortSignal,
  });
  if (observed.commitOid !== expectedCommitOid || observed.treeOid !== expectedTreeOid) {
    throw new Error('Gitoxide managed coding repository conflicts with its baseline receipt');
  }
}

function managedMutationIdentity(sourceRoot: string, sessionId: string) {
  return Object.freeze({
    repositoryId: `repository_${digest('repository', sourceRoot)}`,
    workspaceId: `workspace_${digest('workspace', sourceRoot, sessionId)}`,
    workspaceEpochId: `epoch_${digest('epoch', sourceRoot, sessionId)}`,
    workspaceInstanceId: `instance_${digest('instance', sourceRoot, sessionId)}`,
    workspaceVersionId: `version_${digest('version', sourceRoot, sessionId)}`,
  });
}

function digest(domain: string, ...values: readonly string[]): string {
  const hash = createHash('sha256').update(`maka-gitoxide-${domain}-v1\0`, 'utf8');
  for (const value of values) hash.update(value, 'utf8').update('\0', 'utf8');
  return hash.digest('hex').slice(0, 32);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function freezeIntent(value: BaselineIntentV1): BaselineIntentV1 {
  return Object.freeze({ ...value });
}

function freezeReceipt(value: BaselineReceiptV1): BaselineReceiptV1 {
  return Object.freeze({ ...value });
}

async function readBaselineIntent(path: string): Promise<BaselineIntentV1 | undefined> {
  return readJson(path, isBaselineIntent, freezeIntent);
}

async function readBaselineReceipt(path: string): Promise<BaselineReceiptV1 | undefined> {
  return readJson(path, isBaselineReceipt, freezeReceipt);
}

async function readJson<T>(
  path: string,
  validate: (value: unknown) => value is T,
  freeze: (value: T) => T,
): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid Gitoxide durable JSON at ${path}`);
  }
  if (!validate(value)) throw new Error(`Invalid Gitoxide durable record at ${path}`);
  return freeze(value);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    const existing = await readFile(path, 'utf8').catch(() => undefined);
    await rm(temporaryPath, { force: true });
    if (existing === undefined || !isDeepStrictEqual(JSON.parse(existing), value)) throw error;
  }
}

function assertIntent(
  intent: BaselineIntentV1,
  sourceRoot: string,
  identity: ReturnType<typeof managedMutationIdentity>,
  helperArtifactSha256: `sha256:${string}`,
): void {
  if (
    intent.sourceRoot !== sourceRoot ||
    intent.repositoryId !== identity.repositoryId ||
    intent.workspaceId !== identity.workspaceId ||
    intent.workspaceEpochId !== identity.workspaceEpochId ||
    intent.workspaceInstanceId !== identity.workspaceInstanceId ||
    intent.workspaceVersionId !== identity.workspaceVersionId ||
    intent.helperArtifactSha256 !== helperArtifactSha256
  ) {
    throw new Error('Gitoxide baseline intent conflicts with this managed session');
  }
}

function assertReceipt(receipt: BaselineReceiptV1, intent: BaselineIntentV1): void {
  if (
    receipt.sourceRoot !== intent.sourceRoot ||
    receipt.repositoryId !== intent.repositoryId ||
    receipt.workspaceId !== intent.workspaceId ||
    receipt.workspaceEpochId !== intent.workspaceEpochId ||
    receipt.workspaceInstanceId !== intent.workspaceInstanceId ||
    receipt.workspaceVersionId !== intent.workspaceVersionId ||
    receipt.sourceCommitOid !== intent.sourceCommitOid ||
    receipt.sourceTreeOid !== intent.sourceTreeOid ||
    receipt.helperArtifactSha256 !== intent.helperArtifactSha256
  ) {
    throw new Error('Gitoxide baseline receipt conflicts with its durable intent');
  }
}

function isBaselineIntent(value: unknown): value is BaselineIntentV1 {
  return isBaselineRecord(value, 'maka_gitoxide_managed_mutation_baseline_intent_v1');
}

function isBaselineReceipt(value: unknown): value is BaselineReceiptV1 {
  if (!isBaselineRecord(value, RECEIPT_PROTOCOL)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.baselineCommitOid === 'string' &&
    /^[0-9a-f]{40}$/u.test(record.baselineCommitOid) &&
    typeof record.baselineTreeOid === 'string' &&
    /^[0-9a-f]{40}$/u.test(record.baselineTreeOid) &&
    Number.isSafeInteger(record.filesImported) &&
    (record.filesImported as number) >= 0 &&
    Number.isSafeInteger(record.bytesImported) &&
    (record.bytesImported as number) >= 0
  );
}

function isBaselineRecord(
  value: unknown,
  protocol: 'maka_gitoxide_managed_mutation_baseline_intent_v1' | typeof RECEIPT_PROTOCOL,
): value is BaselineIntentV1 & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expectedKeys = protocol === RECEIPT_PROTOCOL ? 15 : 11;
  return (
    Object.keys(record).length === expectedKeys &&
    record.schemaVersion === 1 &&
    record.protocol === protocol &&
    typeof record.sourceRoot === 'string' &&
    typeof record.repositoryId === 'string' &&
    typeof record.workspaceId === 'string' &&
    typeof record.workspaceEpochId === 'string' &&
    typeof record.workspaceInstanceId === 'string' &&
    typeof record.workspaceVersionId === 'string' &&
    typeof record.sourceCommitOid === 'string' &&
    /^[0-9a-f]{40}$/u.test(record.sourceCommitOid) &&
    typeof record.sourceTreeOid === 'string' &&
    /^[0-9a-f]{40}$/u.test(record.sourceTreeOid) &&
    typeof record.helperArtifactSha256 === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(record.helperArtifactSha256)
  );
}
