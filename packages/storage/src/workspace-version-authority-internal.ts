import type { WorkspaceBaselineAuthorityInput, WorkspaceBaselineCommitResult } from '@maka/core';

type WorkspaceBaselineAuthorityWriter = (
  input: WorkspaceBaselineAuthorityInput,
  rootId: string,
) => Promise<WorkspaceBaselineCommitResult>;
type WorkspaceStorageRootBinder = (rootId: string) => void;

interface WorkspaceBaselineAuthorityRegistration {
  readonly writer: WorkspaceBaselineAuthorityWriter;
  readonly bindStorageRoot: WorkspaceStorageRootBinder;
  boundRootId?: string;
}

const workspaceBaselineAuthorityWriters = new WeakMap<
  object,
  WorkspaceBaselineAuthorityRegistration
>();

export function registerWorkspaceBaselineAuthorityWriterInternal(
  store: object,
  writer: WorkspaceBaselineAuthorityWriter,
  bindStorageRoot: WorkspaceStorageRootBinder,
): void {
  if (workspaceBaselineAuthorityWriters.has(store)) {
    throw new Error('Workspace baseline authority writer is already registered');
  }
  workspaceBaselineAuthorityWriters.set(store, { writer, bindStorageRoot });
}

/**
 * Storage-internal seam for persistence/crash tests. This module is deliberately
 * absent from @maka/storage package exports. Production composition must use a
 * future verified-receipt API instead of accepting caller-supplied Git OIDs.
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
