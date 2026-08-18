import type { WorkspaceHeadRecordV1 } from '@maka/core/workspace-version-authority';
import type { GitWorkspaceService, ManagedWorkspaceBinding } from './git-workspace-service.js';

export interface ManagedMutationCandidateRequest {
  readonly binding: ManagedWorkspaceBinding;
  readonly operationId: string;
  readonly baseHead: WorkspaceHeadRecordV1;
  readonly expectedPaths: readonly string[];
  /** Exact resulting blob, or null when the sole declared path is deleted. */
  readonly expectedBlobOid: string | null;
  readonly executionProfileDigest: `sha256:${string}`;
}

export interface ManagedMutationCandidateReceiptV1 {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_managed_mutation_candidate_v1';
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceInstanceId: string;
  readonly operationId: string;
  readonly baseHead: WorkspaceHeadRecordV1;
  readonly candidateRef: string;
  readonly candidateCommitOid: string;
  readonly candidateTreeOid: string;
  readonly gitRuntimeSha256: `sha256:${string}`;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly materializationProfileDigest: `sha256:${string}`;
  readonly workspacePolicyHash: `sha256:${string}`;
  readonly candidatePolicyHash: `sha256:${string}`;
  readonly treeDeltaDigest: `sha256:${string}`;
  readonly changedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
  readonly expectedBlobOid: string | null;
  readonly executionProfileDigest: `sha256:${string}`;
}

export interface ManagedMutationCandidateAuthorityInternal {
  readBaseBlob(
    binding: ManagedWorkspaceBinding,
    baseHead: WorkspaceHeadRecordV1,
    path: string,
  ): Promise<string | null>;
  capture(request: ManagedMutationCandidateRequest): Promise<ManagedMutationCandidateReceiptV1>;
  require(
    binding: ManagedWorkspaceBinding,
    operationId: string,
  ): Promise<ManagedMutationCandidateReceiptV1>;
  accept(
    binding: ManagedWorkspaceBinding,
    receipt: ManagedMutationCandidateReceiptV1,
  ): Promise<void>;
  discard(receipt: ManagedMutationCandidateReceiptV1): Promise<void>;
}

const authorities = new WeakMap<GitWorkspaceService, ManagedMutationCandidateAuthorityInternal>();

export function registerManagedMutationCandidateAuthorityInternal(
  service: GitWorkspaceService,
  authority: ManagedMutationCandidateAuthorityInternal,
): void {
  if (authorities.has(service)) {
    throw new Error('Managed mutation candidate authority is already registered');
  }
  authorities.set(service, authority);
}

export function requireManagedMutationCandidateAuthorityInternal(
  service: GitWorkspaceService,
): ManagedMutationCandidateAuthorityInternal {
  const authority = authorities.get(service);
  if (!authority) throw new Error('Managed mutation candidate authority is unavailable');
  return authority;
}
