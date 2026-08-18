import type { RuntimeEventManagedWorkspaceMutationV1 } from '@maka/core/runtime-event';
import type { WorkspaceHeadRecordV1 } from '@maka/core/workspace-version-authority';
import type { ManagedWorkspaceBinding } from './git-workspace-service.js';

export interface ManagedWorkspaceMutationLease {
  readonly kind: 'managed_workspace_mutation_lease_v1';
}

export interface ManagedWorkspaceMutationScope {
  readonly kind: 'managed_workspace_mutation_scope_v1';
}

export interface ManagedWorkspaceMutationLeaseStateInternal {
  readonly binding: Readonly<ManagedWorkspaceBinding>;
  readonly baseHead: Readonly<WorkspaceHeadRecordV1>;
  readonly operationId: string;
  readonly expectedPaths: readonly string[];
  readonly executionProfileDigest: `sha256:${string}`;
  readonly durableDispatch: Readonly<RuntimeEventManagedWorkspaceMutationV1>;
}

const leases = new WeakMap<
  object,
  ManagedWorkspaceMutationLeaseStateInternal & {
    readonly ownerToken: object;
    phase: 'admitted' | 'executing' | 'expired';
  }
>();

const scopes = new WeakMap<
  object,
  ManagedWorkspaceMutationLeaseStateInternal & {
    readonly ownerToken: object;
    readonly lease: ManagedWorkspaceMutationLease;
    active: boolean;
  }
>();

export function issueManagedWorkspaceMutationLeaseInternal(
  ownerToken: object,
  state: ManagedWorkspaceMutationLeaseStateInternal,
): ManagedWorkspaceMutationLease {
  const lease = Object.freeze({ kind: 'managed_workspace_mutation_lease_v1' as const });
  leases.set(lease, { ...state, ownerToken, phase: 'admitted' });
  return lease;
}

export function requireManagedWorkspaceMutationLeaseInternal(
  ownerToken: object,
  lease: ManagedWorkspaceMutationLease,
): ManagedWorkspaceMutationLeaseStateInternal {
  const state = leases.get(lease);
  if (!state || state.ownerToken !== ownerToken) {
    throw new Error('Managed workspace mutation lease is invalid for this owner');
  }
  if (state.phase === 'expired') throw new Error('Managed workspace mutation lease has expired');
  return state;
}

export function beginManagedWorkspaceMutationLeaseInternal(
  ownerToken: object,
  lease: ManagedWorkspaceMutationLease,
): ManagedWorkspaceMutationLeaseStateInternal {
  const state = leases.get(lease);
  if (!state || state.ownerToken !== ownerToken) {
    throw new Error('Managed workspace mutation lease is invalid for this owner');
  }
  if (state.phase !== 'admitted') {
    throw new Error('Managed workspace mutation lease is not available for execution');
  }
  state.phase = 'executing';
  return state;
}

export function cancelManagedWorkspaceMutationLeaseInternal(
  ownerToken: object,
  lease: ManagedWorkspaceMutationLease,
): ManagedWorkspaceMutationLeaseStateInternal {
  const mutable = leases.get(lease);
  if (!mutable || mutable.ownerToken !== ownerToken || mutable.phase !== 'admitted') {
    throw new Error('Managed workspace mutation lease cannot be cancelled');
  }
  const state = mutable;
  mutable.phase = 'expired';
  return state;
}

export function finishManagedWorkspaceMutationLeaseInternal(
  ownerToken: object,
  lease: ManagedWorkspaceMutationLease,
): ManagedWorkspaceMutationLeaseStateInternal {
  const mutable = leases.get(lease);
  if (!mutable || mutable.ownerToken !== ownerToken || mutable.phase !== 'executing') {
    throw new Error('Managed workspace mutation lease cannot finish');
  }
  const state = mutable;
  mutable.phase = 'expired';
  return state;
}

export function issueManagedWorkspaceMutationScopeInternal(
  ownerToken: object,
  lease: ManagedWorkspaceMutationLease,
  state: ManagedWorkspaceMutationLeaseStateInternal,
): ManagedWorkspaceMutationScope {
  const scope = Object.freeze({ kind: 'managed_workspace_mutation_scope_v1' as const });
  scopes.set(scope, { ...state, ownerToken, lease, active: true });
  return scope;
}

export function requireManagedWorkspaceMutationScopeInternal(
  ownerToken: object,
  scope: ManagedWorkspaceMutationScope,
): ManagedWorkspaceMutationLeaseStateInternal & { readonly lease: ManagedWorkspaceMutationLease } {
  const state = scopes.get(scope);
  if (!state || state.ownerToken !== ownerToken) {
    throw new Error('Managed workspace mutation scope is invalid for this owner');
  }
  if (!state.active) throw new Error('Managed workspace mutation scope has expired');
  return state;
}

export function revokeManagedWorkspaceMutationScopeInternal(
  ownerToken: object,
  scope: ManagedWorkspaceMutationScope,
): void {
  requireManagedWorkspaceMutationScopeInternal(ownerToken, scope);
  scopes.get(scope)!.active = false;
}
