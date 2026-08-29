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
  WorkspaceBaselineAuthorityInput,
  WorkspaceBaselineCommitResult,
  WorkspaceEpochRecordV1,
  WorkspaceHeadRecordV1,
  WorkspaceSuccessorAuthorityInput,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { lstatSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { OPERATIONAL_STATE_DATABASE_NAME } from './operational-state-store.js';

type WorkspaceBaselineAuthorityWriter = (
  input: WorkspaceBaselineAuthorityInput,
  rootId: string,
) => Promise<WorkspaceBaselineCommitResult>;
type WorkspaceStorageRootBinder = (rootId: string) => void;
type WorkspaceStorageRootAdopter = (rootId: string) => void;
export interface WorkspaceSuccessorCommitInput {
  /** Opaque capability issued by the repository candidate owner. */
  candidateOutcome: object;
  toolOutcome: {
    operationId: string;
    journalEventId: string;
    runtimeEvent: RuntimeEvent;
    committedAt: number;
  };
}
export interface VerifiedWorkspaceSuccessorCommitInput {
  successor: WorkspaceSuccessorAuthorityInput;
  toolOutcome: WorkspaceSuccessorCommitInput['toolOutcome'];
}
export interface WorkspaceSuccessorCommitResult {
  created: boolean;
  head: WorkspaceHeadRecordV1;
  outcomeRuntimeEventSeq: number;
}
export interface ManagedMutationTerminalCommitInput {
  toolOutcome: WorkspaceSuccessorCommitInput['toolOutcome'];
}
export interface ManagedMutationTerminalCommitResult {
  created: boolean;
  outcomeRuntimeEventSeq: number;
}
type ManagedMutationTerminalAuthorityWriter = (
  input: ManagedMutationTerminalCommitInput,
  rootId: string,
) => Promise<ManagedMutationTerminalCommitResult>;
type WorkspaceSuccessorAuthorityWriter = (
  input: VerifiedWorkspaceSuccessorCommitInput,
  rootId: string,
) => Promise<WorkspaceSuccessorCommitResult>;
type WorkspaceSuccessorCandidateVerifier = (
  candidateOutcome: object,
) => WorkspaceSuccessorAuthorityInput;
type WorkspaceHeadReader = (
  workspaceId: string,
  workspaceEpochId: string,
) => Promise<WorkspaceHeadRecordV1 | undefined>;
type WorkspaceEpochReader = (
  workspaceId: string,
  workspaceEpochId: string,
) => Promise<WorkspaceEpochRecordV1 | undefined>;
type WorkspaceVersionReader = (
  workspaceVersionId: string,
) => Promise<WorkspaceVersionRecordV1 | undefined>;
export interface ManagedMutationReservationRecordV1 {
  readonly workspaceInstanceId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly operationId: string;
  readonly dispatchEventId: string;
  readonly baseWorkspaceVersionId: string;
  readonly baseAcceptedEventId: string;
  readonly baseHeadRevision: number;
  readonly baseCommitOid: string;
  readonly baseTreeOid: string;
  readonly expectedPath: string;
  readonly executionProfileDigest: string;
  readonly reservedAt: number;
}
export interface ManagedMutationEvidenceRecordV1 {
  readonly operationId: string;
  readonly callEvent: RuntimeEvent;
  readonly dispatchEvent: RuntimeEvent;
  readonly outcomeEvent: RuntimeEvent;
}
type ManagedMutationReservationReader = (
  workspaceInstanceId: string,
) => Promise<ManagedMutationReservationRecordV1 | undefined>;
type ManagedMutationEvidenceReader = (
  operationId: string,
) => Promise<ManagedMutationEvidenceRecordV1 | undefined>;

interface WorkspaceBaselineAuthorityRegistration {
  readonly writer: WorkspaceBaselineAuthorityWriter;
  readonly successorWriter: WorkspaceSuccessorAuthorityWriter;
  candidateVerifier?: WorkspaceSuccessorCandidateVerifier;
  readonly terminalWriter: ManagedMutationTerminalAuthorityWriter;
  readonly readEpoch: WorkspaceEpochReader;
  readonly readHead: WorkspaceHeadReader;
  readonly readVersion: WorkspaceVersionReader;
  readonly readActiveManagedMutation: ManagedMutationReservationReader;
  readonly readManagedMutationEvidence: ManagedMutationEvidenceReader;
  readonly bindStorageRoot: WorkspaceStorageRootBinder;
  readonly adoptStorageRoot: WorkspaceStorageRootAdopter;
  readonly databasePath: string;
  readonly databaseFileIdentity?: string;
  boundRootId?: string;
}

const workspaceBaselineAuthorityWriters = new WeakMap<
  object,
  WorkspaceBaselineAuthorityRegistration
>();

export function registerWorkspaceBaselineAuthorityWriterInternal(
  store: object,
  databasePath: string,
  writer: WorkspaceBaselineAuthorityWriter,
  successorWriter: WorkspaceSuccessorAuthorityWriter,
  terminalWriter: ManagedMutationTerminalAuthorityWriter,
  bindStorageRoot: WorkspaceStorageRootBinder,
  adoptStorageRoot: WorkspaceStorageRootAdopter,
  readEpoch: WorkspaceEpochReader,
  readHead: WorkspaceHeadReader,
  readVersion: WorkspaceVersionReader,
  readActiveManagedMutation: ManagedMutationReservationReader,
  readManagedMutationEvidence: ManagedMutationEvidenceReader,
): void {
  if (workspaceBaselineAuthorityWriters.has(store)) {
    throw new Error('Workspace baseline authority writer is already registered');
  }
  const resolvedDatabasePath = resolve(databasePath);
  workspaceBaselineAuthorityWriters.set(store, {
    writer,
    successorWriter,
    terminalWriter,
    readEpoch,
    readHead,
    readVersion,
    readActiveManagedMutation,
    readManagedMutationEvidence,
    bindStorageRoot,
    adoptStorageRoot,
    databasePath: resolvedDatabasePath,
    databaseFileIdentity: captureRegularFileIdentity(resolvedDatabasePath),
  });
}

export function readActiveManagedMutationInternal(
  store: object,
  workspaceInstanceId: string,
): Promise<ManagedMutationReservationRecordV1 | undefined> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Managed mutation reservation reader is unavailable');
  return registration.readActiveManagedMutation(workspaceInstanceId);
}

export function readManagedMutationEvidenceInternal(
  store: object,
  operationId: string,
): Promise<ManagedMutationEvidenceRecordV1 | undefined> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Managed mutation evidence reader is unavailable');
  return registration.readManagedMutationEvidence(operationId);
}

export function readWorkspaceEpochInternal(
  store: object,
  workspaceId: string,
  workspaceEpochId: string,
): Promise<WorkspaceEpochRecordV1 | undefined> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority reader is unavailable');
  return registration.readEpoch(workspaceId, workspaceEpochId);
}

export function readWorkspaceHeadInternal(
  store: object,
  workspaceId: string,
  workspaceEpochId: string,
): Promise<WorkspaceHeadRecordV1 | undefined> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority reader is unavailable');
  return registration.readHead(workspaceId, workspaceEpochId);
}

export function readWorkspaceVersionInternal(
  store: object,
  workspaceVersionId: string,
): Promise<WorkspaceVersionRecordV1 | undefined> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace version authority reader is unavailable');
  return registration.readVersion(workspaceVersionId);
}

/**
 * Storage-internal authority seam. This module is deliberately absent from the
 * @maka/storage package exports. Production composition reaches it only through
 * ManagedWorkspaceOwner after durable Git receipt verification; focused
 * persistence/crash tests use it directly to prove the SQLite transaction.
 */
export function commitWorkspaceBaselineInternal(
  store: object,
  input: WorkspaceBaselineAuthorityInput,
): Promise<WorkspaceBaselineCommitResult> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority writer is unavailable');
  if (!registration.boundRootId) {
    throw new Error('Workspace baseline authority store has no durable storage-root binding');
  }
  return registration.writer(input, registration.boundRootId);
}

export function commitWorkspaceSuccessorInternal(
  store: object,
  input: WorkspaceSuccessorCommitInput,
): Promise<WorkspaceSuccessorCommitResult> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace successor authority writer is unavailable');
  if (!registration.boundRootId) {
    throw new Error('Workspace successor authority store has no durable storage-root binding');
  }
  if (!registration.candidateVerifier) {
    throw new Error('Workspace successor candidate verifier is unavailable');
  }
  const successor = registration.candidateVerifier(input.candidateOutcome);
  return commitVerifiedWorkspaceSuccessorInternal(store, {
    successor,
    toolOutcome: input.toolOutcome,
  });
}

/**
 * Storage-internal seam for an owner-bound candidate verifier. This module is
 * not a package export; production callers can reach it only through the
 * execution-stores capability that owns the verifier.
 */
export function commitVerifiedWorkspaceSuccessorInternal(
  store: object,
  input: VerifiedWorkspaceSuccessorCommitInput,
): Promise<WorkspaceSuccessorCommitResult> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace successor authority writer is unavailable');
  if (!registration.boundRootId) {
    throw new Error('Workspace successor authority store has no durable storage-root binding');
  }
  return registration.successorWriter(input, registration.boundRootId);
}

export function registerWorkspaceSuccessorCandidateVerifierInternal(
  store: object,
  verifier: WorkspaceSuccessorCandidateVerifier,
): void {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace successor authority writer is unavailable');
  if (registration.candidateVerifier) {
    throw new Error('Workspace successor candidate verifier is already registered');
  }
  registration.candidateVerifier = verifier;
}

export function commitManagedMutationTerminalInternal(
  store: object,
  input: ManagedMutationTerminalCommitInput,
): Promise<ManagedMutationTerminalCommitResult> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Managed mutation terminal authority writer is unavailable');
  if (!registration.boundRootId) {
    throw new Error('Workspace successor authority store has no durable storage-root binding');
  }
  return registration.terminalWriter(input, registration.boundRootId);
}

export function bindWorkspaceBaselineAuthorityStoreRootInternal(
  store: object,
  rootId: string,
): void {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority writer is unavailable');
  if (!/^[a-f0-9]{64}$/u.test(rootId)) {
    throw new Error('Invalid durable storage-root identity');
  }
  registration.bindStorageRoot(rootId);
  registration.boundRootId = rootId;
}

/**
 * Explicitly adopts ordinary pre-authority runtime state for an authenticated
 * storage root. The SQLite owner still rejects any pre-existing workspace
 * authority facts, so this cannot re-home an already managed ledger.
 */
export function adoptWorkspaceBaselineAuthorityStoreRootInternal(
  store: object,
  rootId: string,
): void {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority writer is unavailable');
  if (!/^[a-f0-9]{64}$/u.test(rootId)) {
    throw new Error('Invalid durable storage-root identity');
  }
  registration.adoptStorageRoot(rootId);
  registration.boundRootId = rootId;
}

export async function assertWorkspaceBaselineAuthorityStoreRootInternal(
  store: object,
  storageRoot: string,
): Promise<void> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (
    !registration ||
    !registration.databaseFileIdentity ||
    basename(registration.databasePath) !== OPERATIONAL_STATE_DATABASE_NAME
  ) {
    throw new Error('Workspace baseline authority store is unavailable for this storage root');
  }
  const expectedDatabasePath = join(storageRoot, OPERATIONAL_STATE_DATABASE_NAME);
  const currentIdentity = captureRegularFileIdentity(registration.databasePath);
  if (currentIdentity !== registration.databaseFileIdentity) {
    throw new Error('Workspace baseline authority database file identity changed');
  }
  let databasePath: string;
  let expectedPath: string;
  let expectedRoot: string;
  try {
    [databasePath, expectedPath, expectedRoot] = await Promise.all([
      realpath(registration.databasePath),
      realpath(expectedDatabasePath),
      realpath(storageRoot),
    ]);
  } catch (error) {
    throw new Error('Workspace baseline authority store belongs to a different storage root', {
      cause: error,
    });
  }
  const canonicalDatabasePath = normalize(databasePath);
  const canonicalExpectedPath = normalize(expectedPath);
  const canonicalExpectedRoot = normalize(expectedRoot);
  if (
    !sameFilesystemPath(canonicalDatabasePath, canonicalExpectedPath) ||
    !sameFilesystemPath(dirname(canonicalDatabasePath), canonicalExpectedRoot)
  ) {
    throw new Error('Workspace baseline authority store belongs to a different storage root');
  }
}

function captureRegularFileIdentity(path: string): string | undefined {
  try {
    const info = lstatSync(path, { bigint: true });
    // SQLite sidecars are pathname-scoped. Opening the same main database
    // inode through a second hard-linked storage root can split its WAL/SHM
    // coordination across two directories, so a canonical authority database
    // must have exactly one directory entry.
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) return undefined;
    return `${info.dev}:${info.ino}:${info.nlink}`;
  } catch {
    return undefined;
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}
