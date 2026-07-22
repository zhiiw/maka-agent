import type { RuntimeEvent } from '@maka/core';
import { stableHash } from './request-shape.js';

export type WorkspaceCheckpointCoverage =
  | 'workspace_identity'
  | 'dependency_set'
  | 'full_policy_scope';
export type WorkspaceCheckpointContentRetention = 'none' | 'selected_blobs' | 'full_snapshot';
export type WorkspaceCheckpointValidation = 'identity_only' | 'manifest_hash' | 'tree_identity';
export type WorkspaceCheckpointRestore =
  | 'unsupported'
  | 'selected_files'
  | 'isolated_directory'
  | 'linked_worktree';

export interface WorkspaceCheckpointCapabilities {
  coverage: WorkspaceCheckpointCoverage;
  contentRetention: WorkspaceCheckpointContentRetention;
  validation: WorkspaceCheckpointValidation;
  restore: WorkspaceCheckpointRestore;
  repositoryAware: boolean;
  executableMode: boolean;
  symlinks: boolean;
  submodules: boolean;
}

export interface WorkspaceResumeRequirement {
  minimumCoverage: WorkspaceCheckpointCoverage;
  minimumContentRetention: WorkspaceCheckpointContentRetention;
  minimumRestore: WorkspaceCheckpointRestore;
  minimumValidation?: WorkspaceCheckpointValidation;
  requireRepositoryIdentity: boolean;
}

export type WorkspaceCheckpointCapabilityGap =
  | 'coverage'
  | 'content_retention'
  | 'validation'
  | 'restore'
  | 'repository_identity';

export type WorkspaceCheckpointCapabilityEvaluation =
  | { satisfied: true; missing: [] }
  | { satisfied: false; missing: WorkspaceCheckpointCapabilityGap[] };

export interface WorkspaceCheckpointProviderDescriptor {
  id: string;
  /** Host-owned preference. Correctness is determined only by capabilities. */
  priority: number;
  capabilities: WorkspaceCheckpointCapabilities;
}

export interface WorkspaceIdentity {
  /** Stable identity of one object universe when repository-aware; absent for native filesystems. */
  repositoryIdentity?: string;
  /** Identity of this concrete checkout/directory instance. */
  workspaceInstanceIdentity: string;
  canonicalRoot: string;
}

export interface WorkspaceEpoch {
  workspaceEpochId: string;
  workspace: WorkspaceIdentity;
  openedByEventId: string;
  previousEpochId?: string;
}

export interface WorkspaceTransitionFact {
  protocol: 'workspace_transition_v1';
  fromEpochId: string;
  toEpochId: string;
  from: WorkspaceIdentity;
  to: WorkspaceIdentity;
  reason: 'session_cwd_move' | 'branch_workspace_select' | 'isolated_restore' | 'user_rebaseline';
}

export interface RuntimePrefixSegment {
  invocationId: string;
  runId: string;
  turnId: string;
  highWater: number;
  prefixDigest: string;
  workspaceEpochId: string;
  workspace: WorkspaceIdentity;
}

export interface RuntimeBoundaryCursor {
  sourceInvocationId: string;
  sourceRunId: string;
  sourceTurnId: string;
  sourceHighWater: number;
  replaySources: RuntimePrefixSegment[];
  replayManifestDigest: string;
}

export type WorkspaceCheckpointArtifact =
  | {
      kind: 'native_manifest_v1';
      rootHash: string;
      manifestObjectId: string;
    }
  | {
      kind: 'native_cas_v1';
      rootHash: string;
      rootTreeId: string;
      snapshotObjectId: string;
    }
  | {
      kind: 'git_repository_v1';
      repositoryIdentity: string;
      objectFormat: 'sha1' | 'sha256';
      commitOid: string;
      treeOid: string;
      retentionRef: string;
    }
  | {
      kind: 'git_private_v1';
      storeIdentity: string;
      objectFormat: 'sha1' | 'sha256';
      commitOid: string;
      treeOid: string;
      retentionRef: string;
    };

export interface WorkspaceCheckpointFact {
  protocol: 'workspace_checkpoint_v1';
  checkpointId: string;
  kind: 'captured' | 'restored' | 'rebased';
  coveredBoundary: RuntimeBoundaryCursor;
  workspaceEpochId: string;
  workspace: WorkspaceIdentity;
  coverage: WorkspaceCheckpointCoverage;
  capabilities: WorkspaceCheckpointCapabilities;
  providerId: string;
  artifact: WorkspaceCheckpointArtifact;
  policy: { version: number; hash: string };
  capturedAt: string;
  parentCheckpointId?: string;
  derivedFromCheckpointId?: string;
}

export type CheckpointValidationDisposition =
  | 'current_matches'
  | 'drifted_restore_available'
  | 'drifted_restore_unavailable'
  | 'missing'
  | 'identity_mismatch'
  | 'policy_mismatch'
  | 'capability_insufficient'
  | 'provider_mismatch'
  | 'corrupt';

export interface CheckpointValidationResult {
  disposition: CheckpointValidationDisposition;
  checkpointId: string;
  observedArtifactDigest?: string;
  missingCapabilities?: WorkspaceCheckpointCapabilityGap[];
}

export interface ValidateCheckpointInput {
  checkpoint: WorkspaceCheckpointFact;
  currentWorkspace: WorkspaceIdentity;
}

export interface WorkspaceCheckpointProvider extends WorkspaceCheckpointProviderDescriptor {
  validate(input: ValidateCheckpointInput): Promise<CheckpointValidationResult>;
}

export interface ValidateWorkspaceCheckpointForResumeInput {
  checkpoint: WorkspaceCheckpointFact;
  provider: WorkspaceCheckpointProvider;
  currentWorkspace: WorkspaceIdentity;
  requirement: WorkspaceResumeRequirement;
  policy: { version: number; hash: string };
}

export interface BuildRuntimePrefixSegmentInput {
  /** Exact immutable prefix returned by readImmutableRuntimeEvents. */
  events: readonly RuntimeEvent[];
  highWater: number;
  workspaceEpochId: string;
  workspace: WorkspaceIdentity;
}

export function buildRuntimePrefixSegment(
  input: BuildRuntimePrefixSegmentInput,
): RuntimePrefixSegment {
  if (input.events.length === 0) throw new Error('Runtime prefix segment requires events');
  if (!Number.isSafeInteger(input.highWater) || input.highWater !== input.events.length) {
    throw new Error('Runtime prefix high-water must equal the immutable event prefix length');
  }
  if (!input.workspaceEpochId) throw new Error('Runtime prefix requires a workspace epoch');
  assertWorkspaceIdentity(input.workspace);

  const first = input.events[0]!;
  for (const event of input.events) {
    if (event.partial) throw new Error('Runtime prefix digest cannot include partial events');
    if (
      event.sessionId !== first.sessionId ||
      event.invocationId !== first.invocationId ||
      event.runId !== first.runId ||
      event.turnId !== first.turnId
    ) {
      throw new Error('Runtime prefix segment contains mixed execution identities');
    }
  }

  return {
    invocationId: first.invocationId,
    runId: first.runId,
    turnId: first.turnId,
    highWater: input.highWater,
    prefixDigest: stableHash({ protocol: 'runtime_prefix_v1', events: input.events }),
    workspaceEpochId: input.workspaceEpochId,
    workspace: structuredClone(input.workspace),
  };
}

export function buildRuntimeBoundaryCursor(
  replaySources: readonly RuntimePrefixSegment[],
): RuntimeBoundaryCursor {
  if (replaySources.length === 0) throw new Error('Runtime boundary requires replay sources');
  const source = replaySources.at(-1)!;
  const copiedSources = structuredClone([...replaySources]);
  return {
    sourceInvocationId: source.invocationId,
    sourceRunId: source.runId,
    sourceTurnId: source.turnId,
    sourceHighWater: source.highWater,
    replaySources: copiedSources,
    replayManifestDigest: stableHash({
      protocol: 'runtime_boundary_cursor_v1',
      replaySources: copiedSources,
    }),
  };
}

export function evaluateWorkspaceCheckpointCapabilities(
  capabilities: WorkspaceCheckpointCapabilities,
  requirement: WorkspaceResumeRequirement,
): WorkspaceCheckpointCapabilityEvaluation {
  const missing: WorkspaceCheckpointCapabilityGap[] = [];
  if (rankCoverage(capabilities.coverage) < rankCoverage(requirement.minimumCoverage)) {
    missing.push('coverage');
  }
  if (
    rankContentRetention(capabilities.contentRetention) <
    rankContentRetention(requirement.minimumContentRetention)
  ) {
    missing.push('content_retention');
  }
  if (
    rankValidation(capabilities.validation) <
    rankValidation(requirement.minimumValidation ?? 'identity_only')
  ) {
    missing.push('validation');
  }
  if (rankRestore(capabilities.restore) < rankRestore(requirement.minimumRestore)) {
    missing.push('restore');
  }
  if (requirement.requireRepositoryIdentity && !capabilities.repositoryAware) {
    missing.push('repository_identity');
  }
  return missing.length === 0 ? { satisfied: true, missing: [] } : { satisfied: false, missing };
}

export function selectWorkspaceCheckpointProvider<
  TProvider extends WorkspaceCheckpointProviderDescriptor,
>(providers: readonly TProvider[], requirement: WorkspaceResumeRequirement): TProvider | undefined {
  return providers
    .map((provider, index) => ({ provider, index }))
    .filter(
      ({ provider }) =>
        evaluateWorkspaceCheckpointCapabilities(provider.capabilities, requirement).satisfied,
    )
    .sort(
      (left, right) => right.provider.priority - left.provider.priority || left.index - right.index,
    )
    .at(0)?.provider;
}

export async function validateWorkspaceCheckpointForResume(
  input: ValidateWorkspaceCheckpointForResumeInput,
): Promise<CheckpointValidationResult> {
  const { checkpoint } = input;
  if (checkpoint.providerId !== input.provider.id) {
    return { disposition: 'provider_mismatch', checkpointId: checkpoint.checkpointId };
  }
  if (
    checkpoint.policy.version !== input.policy.version ||
    checkpoint.policy.hash !== input.policy.hash
  ) {
    return { disposition: 'policy_mismatch', checkpointId: checkpoint.checkpointId };
  }
  if (!sameWorkspaceIdentity(checkpoint.workspace, input.currentWorkspace)) {
    return { disposition: 'identity_mismatch', checkpointId: checkpoint.checkpointId };
  }
  const checkpointCapabilities = evaluateWorkspaceCheckpointCapabilities(
    checkpoint.capabilities,
    input.requirement,
  );
  if (!checkpointCapabilities.satisfied) {
    return {
      disposition: 'capability_insufficient',
      checkpointId: checkpoint.checkpointId,
      missingCapabilities: checkpointCapabilities.missing,
    };
  }
  const providerCapabilities = evaluateWorkspaceCheckpointCapabilities(
    input.provider.capabilities,
    input.requirement,
  );
  if (!providerCapabilities.satisfied) {
    return {
      disposition: 'capability_insufficient',
      checkpointId: checkpoint.checkpointId,
      missingCapabilities: providerCapabilities.missing,
    };
  }
  return input.provider.validate({
    checkpoint,
    currentWorkspace: structuredClone(input.currentWorkspace),
  });
}

/** Deterministic Phase 3B test provider. It stores no workspace content and performs no I/O. */
export class InMemoryWorkspaceCheckpointProvider implements WorkspaceCheckpointProvider {
  readonly id: string;
  readonly priority: number;
  readonly capabilities: WorkspaceCheckpointCapabilities;
  readonly validationCalls: ValidateCheckpointInput[] = [];
  private readonly validations = new Map<string, CheckpointValidationResult>();

  constructor(descriptor: WorkspaceCheckpointProviderDescriptor) {
    this.id = descriptor.id;
    this.priority = descriptor.priority;
    this.capabilities = structuredClone(descriptor.capabilities);
  }

  setValidation(checkpointId: string, result: CheckpointValidationResult): void {
    if (result.checkpointId !== checkpointId) {
      throw new Error('Checkpoint validation fixture identity mismatch');
    }
    this.validations.set(checkpointId, structuredClone(result));
  }

  async validate(input: ValidateCheckpointInput): Promise<CheckpointValidationResult> {
    this.validationCalls.push(structuredClone(input));
    return structuredClone(
      this.validations.get(input.checkpoint.checkpointId) ?? {
        disposition: 'missing',
        checkpointId: input.checkpoint.checkpointId,
      },
    );
  }
}

function assertWorkspaceIdentity(identity: WorkspaceIdentity): void {
  if (!identity.workspaceInstanceIdentity || !identity.canonicalRoot) {
    throw new Error('Workspace identity requires instance identity and canonical root');
  }
}

function sameWorkspaceIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return (
    left.workspaceInstanceIdentity === right.workspaceInstanceIdentity &&
    normalizeWorkspaceRoot(left.canonicalRoot) === normalizeWorkspaceRoot(right.canonicalRoot) &&
    left.repositoryIdentity === right.repositoryIdentity
  );
}

function normalizeWorkspaceRoot(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function rankCoverage(value: WorkspaceCheckpointCoverage): number {
  return ['workspace_identity', 'dependency_set', 'full_policy_scope'].indexOf(value);
}

function rankContentRetention(value: WorkspaceCheckpointContentRetention): number {
  return ['none', 'selected_blobs', 'full_snapshot'].indexOf(value);
}

function rankValidation(value: WorkspaceCheckpointValidation): number {
  return ['identity_only', 'manifest_hash', 'tree_identity'].indexOf(value);
}

function rankRestore(value: WorkspaceCheckpointRestore): number {
  return ['unsupported', 'selected_files', 'isolated_directory', 'linked_worktree'].indexOf(value);
}
