import type {
  WorkspaceBaselineAuthorityInput,
  WorkspaceBaselineCommitResult,
  WorkspaceHeadRecordV1,
  WorkspaceSuccessorAuthorityInput,
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
export interface WorkspaceSuccessorCommitInput {
  successor: WorkspaceSuccessorAuthorityInput;
  toolOutcome: {
    operationId: string;
    journalEventId: string;
    runtimeEvent: RuntimeEvent;
    committedAt: number;
  };
}
export interface WorkspaceSuccessorCommitResult {
  created: boolean;
  head: WorkspaceHeadRecordV1;
  outcomeRuntimeEventSeq: number;
}
export interface ManagedMutationTerminalCommitInput {
  readonly disposition: 'operation_failed_no_effect_committed' | 'no_workspace_change_committed';
  readonly toolOutcome: WorkspaceSuccessorCommitInput['toolOutcome'];
}
export interface ManagedMutationTerminalCommitResult {
  readonly created: boolean;
  readonly outcomeRuntimeEventSeq: number;
}
type WorkspaceSuccessorAuthorityWriter = (
  input: WorkspaceSuccessorCommitInput,
  rootId: string,
) => Promise<WorkspaceSuccessorCommitResult>;
type ManagedMutationTerminalWriter = (
  input: ManagedMutationTerminalCommitInput,
  rootId: string,
) => Promise<ManagedMutationTerminalCommitResult>;
type WorkspaceHeadReader = (
  workspaceId: string,
  workspaceEpochId: string,
) => Promise<WorkspaceHeadRecordV1 | undefined>;
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
  readonly baseBlobOid: string | null;
  readonly expectedPaths: readonly string[];
  readonly executionProfileDigest: string;
  readonly reservedAt: number;
}
type ManagedMutationReservationReader = (
  workspaceInstanceId: string,
) => Promise<ManagedMutationReservationRecordV1 | undefined>;

interface WorkspaceBaselineAuthorityRegistration {
  readonly writer: WorkspaceBaselineAuthorityWriter;
  readonly successorWriter: WorkspaceSuccessorAuthorityWriter;
  readonly terminalWriter: ManagedMutationTerminalWriter;
  readonly readHead: WorkspaceHeadReader;
  readonly readActiveManagedMutation: ManagedMutationReservationReader;
  readonly bindStorageRoot: WorkspaceStorageRootBinder;
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
  terminalWriter: ManagedMutationTerminalWriter,
  bindStorageRoot: WorkspaceStorageRootBinder,
  readHead: WorkspaceHeadReader,
  readActiveManagedMutation: ManagedMutationReservationReader,
): void {
  if (workspaceBaselineAuthorityWriters.has(store)) {
    throw new Error('Workspace baseline authority writer is already registered');
  }
  const resolvedDatabasePath = resolve(databasePath);
  workspaceBaselineAuthorityWriters.set(store, {
    writer,
    successorWriter,
    terminalWriter,
    readHead,
    readActiveManagedMutation,
    bindStorageRoot,
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

export function readWorkspaceHeadInternal(
  store: object,
  workspaceId: string,
  workspaceEpochId: string,
): Promise<WorkspaceHeadRecordV1 | undefined> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority reader is unavailable');
  return registration.readHead(workspaceId, workspaceEpochId);
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
  return registration.successorWriter(input, registration.boundRootId);
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
