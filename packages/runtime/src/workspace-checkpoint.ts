import type { RuntimeEvent, RuntimeFactEnvelope } from '@maka/core';
import { stableHash } from './request-shape.js';

export const WORKSPACE_CHECKPOINT_FACT_KIND = 'maka.workspace.checkpoint' as const;
export const WORKSPACE_TRANSITION_FACT_KIND = 'maka.workspace.transition' as const;
export const WORKSPACE_RUNTIME_FACT_VERSION = 1 as const;

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

export type ParsedWorkspaceRuntimeFact =
  | { status: 'unsupported' }
  | { status: 'invalid' }
  | { status: 'checkpoint'; fact: WorkspaceCheckpointFact }
  | { status: 'transition'; fact: WorkspaceTransitionFact };

export interface BuildRuntimePrefixSegmentInput {
  /** Exact immutable prefix returned by readImmutableRuntimeEvents. */
  events: readonly RuntimeEvent[];
  highWater: number;
  workspaceEpochId: string;
  workspace: WorkspaceIdentity;
}

export type RuntimeBoundaryVerificationResult =
  | { valid: true }
  | {
      valid: false;
      reason:
        | 'high_water_unavailable'
        | 'execution_identity_mismatch'
        | 'prefix_digest_mismatch'
        | 'manifest_digest_mismatch';
      runId?: string;
    };

export interface VerifyRuntimeBoundaryCursorInput {
  sessionId: string;
  cursor: RuntimeBoundaryCursor;
  readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
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

/** Rebuilds the boundary exclusively from immutable ledger rows; checkpoint fields are not trusted. */
export async function verifyRuntimeBoundaryCursor(
  input: VerifyRuntimeBoundaryCursorInput,
): Promise<RuntimeBoundaryVerificationResult> {
  const rebuilt: RuntimePrefixSegment[] = [];
  for (const claimed of input.cursor.replaySources) {
    const events = await input.readImmutableRuntimeEvents(input.sessionId, claimed.runId);
    if (events.length < claimed.highWater) {
      return { valid: false, reason: 'high_water_unavailable', runId: claimed.runId };
    }
    const prefix = events.slice(0, claimed.highWater);
    const first = prefix[0];
    if (
      !first ||
      first.invocationId !== claimed.invocationId ||
      first.runId !== claimed.runId ||
      first.turnId !== claimed.turnId
    ) {
      return { valid: false, reason: 'execution_identity_mismatch', runId: claimed.runId };
    }
    let segment: RuntimePrefixSegment;
    try {
      segment = buildRuntimePrefixSegment({
        events: prefix,
        highWater: claimed.highWater,
        workspaceEpochId: claimed.workspaceEpochId,
        workspace: claimed.workspace,
      });
    } catch {
      return { valid: false, reason: 'execution_identity_mismatch', runId: claimed.runId };
    }
    if (segment.prefixDigest !== claimed.prefixDigest) {
      return { valid: false, reason: 'prefix_digest_mismatch', runId: claimed.runId };
    }
    rebuilt.push(segment);
  }
  const rebuiltCursor = buildRuntimeBoundaryCursor(rebuilt);
  return rebuiltCursor.replayManifestDigest === input.cursor.replayManifestDigest
    ? { valid: true }
    : { valid: false, reason: 'manifest_digest_mismatch' };
}

export function advanceWorkspaceEpoch(
  current: WorkspaceEpoch,
  openedByEventId: string,
  transition: WorkspaceTransitionFact,
): WorkspaceEpoch {
  if (!openedByEventId) throw new Error('Workspace transition requires an opening event');
  if (
    transition.protocol !== 'workspace_transition_v1' ||
    transition.fromEpochId !== current.workspaceEpochId ||
    !sameWorkspaceIdentity(transition.from, current.workspace)
  ) {
    throw new Error('Workspace transition does not continue the active workspace epoch');
  }
  if (!transition.toEpochId || transition.toEpochId === transition.fromEpochId) {
    throw new Error('Workspace transition requires a fresh destination epoch');
  }
  assertWorkspaceIdentity(transition.to);
  return {
    workspaceEpochId: transition.toEpochId,
    workspace: structuredClone(transition.to),
    openedByEventId,
    previousEpochId: current.workspaceEpochId,
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

export function parseWorkspaceRuntimeFact(
  envelope: RuntimeFactEnvelope,
): ParsedWorkspaceRuntimeFact {
  if (
    envelope.kind !== WORKSPACE_CHECKPOINT_FACT_KIND &&
    envelope.kind !== WORKSPACE_TRANSITION_FACT_KIND
  ) {
    return { status: 'unsupported' };
  }
  if (
    envelope.version !== WORKSPACE_RUNTIME_FACT_VERSION ||
    envelope.legacyProjection !== 'invisible'
  ) {
    return { status: 'unsupported' };
  }
  if (envelope.kind === WORKSPACE_TRANSITION_FACT_KIND) {
    return isWorkspaceTransitionFact(envelope.payload)
      ? { status: 'transition', fact: envelope.payload }
      : { status: 'invalid' };
  }
  return isWorkspaceCheckpointFact(envelope.payload)
    ? { status: 'checkpoint', fact: envelope.payload }
    : { status: 'invalid' };
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

function isWorkspaceCheckpointFact(value: unknown): value is WorkspaceCheckpointFact {
  if (
    !hasExactKeys(
      value,
      [
        'protocol',
        'checkpointId',
        'kind',
        'coveredBoundary',
        'workspaceEpochId',
        'workspace',
        'coverage',
        'capabilities',
        'providerId',
        'artifact',
        'policy',
        'capturedAt',
      ],
      ['parentCheckpointId', 'derivedFromCheckpointId'],
    ) ||
    value.protocol !== 'workspace_checkpoint_v1' ||
    !isNonEmptyString(value.checkpointId) ||
    !['captured', 'restored', 'rebased'].includes(String(value.kind)) ||
    !isRuntimeBoundaryCursor(value.coveredBoundary) ||
    !isNonEmptyString(value.workspaceEpochId) ||
    !isWorkspaceIdentity(value.workspace) ||
    !isWorkspaceCheckpointCapabilities(value.capabilities) ||
    value.coverage !== value.capabilities.coverage ||
    !isNonEmptyString(value.providerId) ||
    !isWorkspaceCheckpointArtifact(value.artifact) ||
    !isCheckpointPolicy(value.policy) ||
    !isIsoDate(value.capturedAt)
  ) {
    return false;
  }
  return (
    (value.parentCheckpointId === undefined || isNonEmptyString(value.parentCheckpointId)) &&
    (value.derivedFromCheckpointId === undefined || isNonEmptyString(value.derivedFromCheckpointId))
  );
}

function isWorkspaceTransitionFact(value: unknown): value is WorkspaceTransitionFact {
  return (
    hasExactKeys(value, ['protocol', 'fromEpochId', 'toEpochId', 'from', 'to', 'reason']) &&
    value.protocol === 'workspace_transition_v1' &&
    isNonEmptyString(value.fromEpochId) &&
    isNonEmptyString(value.toEpochId) &&
    value.fromEpochId !== value.toEpochId &&
    isWorkspaceIdentity(value.from) &&
    isWorkspaceIdentity(value.to) &&
    ['session_cwd_move', 'branch_workspace_select', 'isolated_restore', 'user_rebaseline'].includes(
      String(value.reason),
    )
  );
}

function isRuntimeBoundaryCursor(value: unknown): value is RuntimeBoundaryCursor {
  return (
    hasExactKeys(value, [
      'sourceInvocationId',
      'sourceRunId',
      'sourceTurnId',
      'sourceHighWater',
      'replaySources',
      'replayManifestDigest',
    ]) &&
    isNonEmptyString(value.sourceInvocationId) &&
    isNonEmptyString(value.sourceRunId) &&
    isNonEmptyString(value.sourceTurnId) &&
    isPositiveSafeInteger(value.sourceHighWater) &&
    Array.isArray(value.replaySources) &&
    value.replaySources.length > 0 &&
    value.replaySources.every(isRuntimePrefixSegment) &&
    value.replaySources.at(-1)?.invocationId === value.sourceInvocationId &&
    value.replaySources.at(-1)?.runId === value.sourceRunId &&
    value.replaySources.at(-1)?.turnId === value.sourceTurnId &&
    value.replaySources.at(-1)?.highWater === value.sourceHighWater &&
    isSha256Digest(value.replayManifestDigest)
  );
}

function isRuntimePrefixSegment(value: unknown): value is RuntimePrefixSegment {
  return (
    hasExactKeys(value, [
      'invocationId',
      'runId',
      'turnId',
      'highWater',
      'prefixDigest',
      'workspaceEpochId',
      'workspace',
    ]) &&
    isNonEmptyString(value.invocationId) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.turnId) &&
    isPositiveSafeInteger(value.highWater) &&
    isSha256Digest(value.prefixDigest) &&
    isNonEmptyString(value.workspaceEpochId) &&
    isWorkspaceIdentity(value.workspace)
  );
}

function isWorkspaceIdentity(value: unknown): value is WorkspaceIdentity {
  return (
    hasExactKeys(value, ['workspaceInstanceIdentity', 'canonicalRoot'], ['repositoryIdentity']) &&
    isNonEmptyString(value.workspaceInstanceIdentity) &&
    isNonEmptyString(value.canonicalRoot) &&
    (value.repositoryIdentity === undefined || isNonEmptyString(value.repositoryIdentity))
  );
}

function isWorkspaceCheckpointCapabilities(
  value: unknown,
): value is WorkspaceCheckpointCapabilities {
  return (
    hasExactKeys(value, [
      'coverage',
      'contentRetention',
      'validation',
      'restore',
      'repositoryAware',
      'executableMode',
      'symlinks',
      'submodules',
    ]) &&
    ['workspace_identity', 'dependency_set', 'full_policy_scope'].includes(
      String(value.coverage),
    ) &&
    ['none', 'selected_blobs', 'full_snapshot'].includes(String(value.contentRetention)) &&
    ['identity_only', 'manifest_hash', 'tree_identity'].includes(String(value.validation)) &&
    ['unsupported', 'selected_files', 'isolated_directory', 'linked_worktree'].includes(
      String(value.restore),
    ) &&
    typeof value.repositoryAware === 'boolean' &&
    typeof value.executableMode === 'boolean' &&
    typeof value.symlinks === 'boolean' &&
    typeof value.submodules === 'boolean'
  );
}

function isWorkspaceCheckpointArtifact(value: unknown): value is WorkspaceCheckpointArtifact {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'native_manifest_v1':
      return (
        hasExactKeys(value, ['kind', 'rootHash', 'manifestObjectId']) &&
        isSha256Digest(value.rootHash) &&
        isSha256Digest(value.manifestObjectId)
      );
    case 'native_cas_v1':
      return (
        hasExactKeys(value, ['kind', 'rootHash', 'rootTreeId', 'snapshotObjectId']) &&
        isSha256Digest(value.rootHash) &&
        isSha256Digest(value.rootTreeId) &&
        isSha256Digest(value.snapshotObjectId)
      );
    case 'git_repository_v1':
      return (
        hasExactKeys(value, [
          'kind',
          'repositoryIdentity',
          'objectFormat',
          'commitOid',
          'treeOid',
          'retentionRef',
        ]) &&
        isNonEmptyString(value.repositoryIdentity) &&
        isGitObjectFormat(value.objectFormat) &&
        isGitOid(value.commitOid, value.objectFormat) &&
        isGitOid(value.treeOid, value.objectFormat) &&
        isNonEmptyString(value.retentionRef)
      );
    case 'git_private_v1':
      return (
        hasExactKeys(value, [
          'kind',
          'storeIdentity',
          'objectFormat',
          'commitOid',
          'treeOid',
          'retentionRef',
        ]) &&
        isNonEmptyString(value.storeIdentity) &&
        isGitObjectFormat(value.objectFormat) &&
        isGitOid(value.commitOid, value.objectFormat) &&
        isGitOid(value.treeOid, value.objectFormat) &&
        isNonEmptyString(value.retentionRef)
      );
    default:
      return false;
  }
}

function isCheckpointPolicy(value: unknown): boolean {
  return (
    hasExactKeys(value, ['version', 'hash']) &&
    isPositiveSafeInteger(value.version) &&
    isSha256Digest(value.hash)
  );
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isGitObjectFormat(value: unknown): value is 'sha1' | 'sha256' {
  return value === 'sha1' || value === 'sha256';
}

function isGitOid(value: unknown, format: 'sha1' | 'sha256'): value is string {
  return (
    typeof value === 'string' &&
    (format === 'sha1' ? /^[0-9a-f]{40}$/.test(value) : /^[0-9a-f]{64}$/.test(value))
  );
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
