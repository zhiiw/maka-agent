import type { WorkspaceBaselineAuthorityInput, WorkspaceBaselineCommitResult } from '@maka/core';
import { realpath } from 'node:fs/promises';
import { dirname, normalize, resolve } from 'node:path';

type WorkspaceBaselineAuthorityWriter = (
  input: WorkspaceBaselineAuthorityInput,
) => Promise<WorkspaceBaselineCommitResult>;

interface WorkspaceBaselineAuthorityRegistration {
  readonly writer: WorkspaceBaselineAuthorityWriter;
  readonly databasePath: string;
}

const workspaceBaselineAuthorityWriters = new WeakMap<
  object,
  WorkspaceBaselineAuthorityRegistration
>();

export function registerWorkspaceBaselineAuthorityWriterInternal(
  store: object,
  databasePath: string,
  writer: WorkspaceBaselineAuthorityWriter,
): void {
  if (workspaceBaselineAuthorityWriters.has(store)) {
    throw new Error('Workspace baseline authority writer is already registered');
  }
  workspaceBaselineAuthorityWriters.set(store, { writer, databasePath: resolve(databasePath) });
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
  return registration.writer(input);
}

export async function assertWorkspaceBaselineAuthorityStoreRootInternal(
  store: object,
  storageRoot: string,
): Promise<void> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration || registration.databasePath === resolve(':memory:')) {
    throw new Error('Workspace baseline authority store is unavailable for this storage root');
  }
  const [databaseRoot, expectedRoot] = await Promise.all([
    realpath(dirname(registration.databasePath)),
    realpath(storageRoot),
  ]);
  const canonicalDatabaseRoot = normalize(databaseRoot);
  const canonicalExpectedRoot = normalize(expectedRoot);
  const matches =
    process.platform === 'win32'
      ? canonicalDatabaseRoot.toLocaleLowerCase('en-US') ===
        canonicalExpectedRoot.toLocaleLowerCase('en-US')
      : canonicalDatabaseRoot === canonicalExpectedRoot;
  if (!matches) {
    throw new Error('Workspace baseline authority store belongs to a different storage root');
  }
}
