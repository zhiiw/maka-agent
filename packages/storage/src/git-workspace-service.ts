import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, posix, relative, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { isCanonicalManagedMutationPathV1 } from '@maka/core/runtime-event';
import type { WorkspaceHeadRecordV1 } from '@maka/core/workspace-version-authority';
import { withArtifactWriterLock } from './artifact-writer-lock.js';
import { bundledGitEnvironment } from './dugite-native-environment.js';
import { registerManagedBaselineReceiptAuthorityInternal } from './managed-baseline-receipt-authority-internal.js';
import {
  registerManagedMutationCandidateAuthorityInternal,
  type ManagedMutationCandidateReceiptV1,
  type ManagedMutationCandidateIdentityRequest,
  type ManagedMutationCandidateRequest,
} from './managed-mutation-candidate-authority-internal.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2 * 60 * 1_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const BINDING_SCHEMA_VERSION = 1;
const REPOSITORY_SCHEMA_VERSION = 1;
const EPOCH_ARTIFACT_SCHEMA_VERSION = 1;
const QUARANTINE_INTENT_SCHEMA_VERSION = 1;
const BASELINE_RECEIPT_SCHEMA_VERSION = 1;
const MUTATION_CANDIDATE_RECEIPT_SCHEMA_VERSION = 1;
const MUTATION_CANDIDATE_DISCARD_INTENT_SCHEMA_VERSION = 1;
const IDENTIFIER_PATTERN = /^(repository|workspace|epoch|instance)_[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const BINDING_KEYS = [
  'schemaVersion',
  'protocol',
  'repositoryId',
  'workspaceId',
  'workspaceEpochId',
  'workspaceInstanceId',
  'sourceRoot',
  'sourceGitCommonDir',
  'sourceHeadCommitOid',
  'sourceTreeOid',
  'repositoryPath',
  'worktreePath',
  'hooksPath',
  'baselineCommitOid',
  'baselineTreeOid',
  'headRef',
  'gitRuntimeSha256',
  'objectFormat',
  'materializationProfileDigest',
  'materializationSemantics',
] as const;
const REPOSITORY_KEYS = [
  'schemaVersion',
  'protocol',
  'repositoryId',
  'repositoryPath',
  'hooksPath',
  'gitRuntimeSha256',
  'objectFormat',
  'repositoryCapabilityDigest',
] as const;
const EPOCH_ARTIFACT_KEYS = [
  'schemaVersion',
  'protocol',
  'repositoryId',
  'workspaceId',
  'workspaceEpochId',
  'sourceRoot',
  'sourceGitCommonDir',
  'sourceHeadCommitOid',
  'sourceTreeOid',
  'baselineCommitOid',
  'baselineTreeOid',
  'baselineRef',
  'headRef',
  'gitRuntimeSha256',
  'objectFormat',
  'materializationProfileDigest',
  'materializationSemantics',
] as const;
const QUARANTINE_INTENT_KEYS = [
  'schemaVersion',
  'protocol',
  'reason',
  'quarantinePath',
  'binding',
] as const;
const QUARANTINE_RECORD_KEYS = ['protocol', 'reason', 'binding'] as const;
const BASELINE_RECEIPT_KEYS = [
  'schemaVersion',
  'protocol',
  'binding',
  'workspaceVersionId',
  'policyVersion',
  'policyHash',
  'epochOpenedEventId',
  'baselineAcceptedEventId',
  'treeDeltaDigest',
  'changedFileCount',
  'deletedFileCount',
] as const;
const MUTATION_CANDIDATE_RECEIPT_KEYS = [
  'schemaVersion',
  'protocol',
  'repositoryId',
  'workspaceId',
  'workspaceEpochId',
  'workspaceInstanceId',
  'operationId',
  'baseHead',
  'candidateRef',
  'candidateCommitOid',
  'candidateTreeOid',
  'gitRuntimeSha256',
  'objectFormat',
  'materializationProfileDigest',
  'workspacePolicyHash',
  'candidatePolicyHash',
  'treeDeltaDigest',
  'changedPaths',
  'deletedPaths',
  'expectedBlobOid',
  'executionProfileDigest',
] as const;
const MUTATION_CANDIDATE_POLICY_V1 = {
  protocol: 'maka_managed_mutation_candidate_policy_v1',
  base: 'exact_accepted_workspace_head',
  paths: 'exact_declared_regular_files',
  ignoredPaths: 'reject',
  symlinks: 'reject',
  submodules: 'reject',
  renames: 'reject',
  content: 'runtime_result_content_rehashed_into_private_git_index',
  worktreeInput: 'forbidden_projection_only',
  commitParents: 'exactly_one',
} as const;
const MUTATION_CANDIDATE_POLICY_HASH_V1 = hashCanonicalJson(MUTATION_CANDIDATE_POLICY_V1);
const MUTATION_CANDIDATE_MESSAGE_PREFIX = 'maka managed mutation candidate v1';
const MATERIALIZATION_SEMANTICS = 'git_tree_materialized_with_fixed_config_v1';
const MANAGED_BASELINE_POLICY_V1 = {
  protocol: 'maka_managed_workspace_baseline_policy_v1',
  source: 'source_head_tree',
  sourceWorkingTree: 'clean_tracked_and_untracked_except_ignored',
  trackedFiles: 'include',
  untrackedFiles: 'exclude',
  ignoredFiles: 'exclude',
  pathEncoding: 'utf8_lossless_roundtrip_required',
  caseCollisions: 'reject_nfc_casefold_v1',
  symlinks: 'reject',
  submodules: 'reject',
  attributes: 'reject',
  specialModes: 'reject',
  materialization: MATERIALIZATION_SEMANTICS,
} as const;
const MANAGED_BASELINE_POLICY_HASH_V1 = hashCanonicalJson(MANAGED_BASELINE_POLICY_V1);
const BASELINE_MESSAGE = 'maka managed workspace baseline v1\n';
const BASELINE_DATE = '2000-01-01T00:00:00Z';

export type GitWorkspaceServiceErrorCode =
  | 'git_runtime_unavailable'
  | 'git_runtime_integrity_mismatch'
  | 'git_workspace_operation_failed'
  | 'repository_ineligible'
  | 'source_changed_during_baseline_import'
  | 'managed_workspace_identity_conflict'
  | 'managed_workspace_unavailable'
  | 'managed_workspace_drifted'
  | 'managed_mutation_no_change'
  | 'managed_mutation_candidate_rejected';

export class GitWorkspaceServiceError extends Error {
  constructor(
    readonly code: GitWorkspaceServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitWorkspaceServiceError';
  }
}

interface GitRuntimeExecutableIdentity {
  readonly executablePath: string;
  readonly expectedSha256: `sha256:${string}`;
}

export type VerifiedGitRuntimeInput = GitRuntimeExecutableIdentity &
  (
    | {
        readonly distribution?: undefined;
        readonly runtimeIdentitySha256?: undefined;
      }
    | {
        readonly distribution: {
          readonly kind: 'dugite_native_v1';
          readonly rootPath: string;
        };
        /** Stable identity of the complete declared distribution. */
        readonly runtimeIdentitySha256: `sha256:${string}`;
      }
  );

export interface CreateGitWorkspaceServiceInput {
  readonly storageRoot: string;
  readonly gitRuntime: VerifiedGitRuntimeInput;
  readonly failpoint?: (point: GitWorkspaceServiceFailpoint) => void | Promise<void>;
}

export type GitWorkspaceServiceFailpoint =
  | 'after_repository_record'
  | 'after_baseline_ref_created'
  | 'after_worktree_materialized'
  | 'after_worktree_locked'
  | 'after_head_ref_updated'
  | 'after_quarantine_intent'
  | 'after_quarantine_unlock'
  | 'after_quarantine_move'
  | 'after_quarantine_binding_removed'
  | 'after_quarantine_pruned'
  | 'after_baseline_receipt'
  | 'after_mutation_candidate_ref'
  | 'after_mutation_candidate_discard_ref'
  | 'after_mutation_projection_intent'
  | 'after_mutation_projection_staging_registered'
  | 'after_mutation_projection_previous_renamed'
  | 'after_mutation_projection_previous'
  | 'after_mutation_projection_publish_renamed'
  | 'after_mutation_projection_publish';

export interface ManagedWorkspaceIdentity {
  /**
   * Identifies the Maka-owned Git object universe. It is not the identity of the
   * source checkout; sourceRoot, sourceGitCommonDir, HEAD, and tree OIDs carry
   * source provenance and must be validated independently.
   */
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceInstanceId: string;
}

export interface CreateManagedWorkspaceFromSourceInput extends ManagedWorkspaceIdentity {
  readonly sourceRoot: string;
}

export interface ManagedWorkspaceBinding {
  readonly schemaVersion: 1;
  readonly protocol: 'git_managed_workspace_v1';
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceInstanceId: string;
  readonly sourceRoot: string;
  readonly sourceGitCommonDir: string;
  readonly sourceHeadCommitOid: string;
  readonly sourceTreeOid: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly hooksPath: string;
  readonly baselineCommitOid: string;
  readonly baselineTreeOid: string;
  readonly headRef: string;
  readonly gitRuntimeSha256: `sha256:${string}`;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly materializationProfileDigest: `sha256:${string}`;
  readonly materializationSemantics: typeof MATERIALIZATION_SEMANTICS;
}

export type ManagedWorkspaceInspection =
  | {
      readonly state: 'ready';
      readonly commitOid: string;
      readonly treeOid: string;
    }
  | {
      readonly state: 'drifted';
      readonly commitOid?: string;
      readonly treeOid?: string;
      readonly status: string;
    };

export interface ManagedWorkspaceQuarantine {
  readonly quarantinePath: string;
  readonly reason: string;
}

export interface ManagedWorkspaceBaselineReceiptV1 {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_managed_workspace_baseline_receipt_v1';
  readonly binding: ManagedWorkspaceBinding;
  readonly workspaceVersionId: string;
  readonly policyVersion: 1;
  readonly policyHash: `sha256:${string}`;
  readonly epochOpenedEventId: string;
  readonly baselineAcceptedEventId: string;
  readonly treeDeltaDigest: `sha256:${string}`;
  readonly changedFileCount: number;
  readonly deletedFileCount: 0;
}

export interface GitWorkspaceService {
  assertAvailable(): Promise<void>;
  createManagedWorkspaceFromSource(
    input: CreateManagedWorkspaceFromSourceInput,
  ): Promise<ManagedWorkspaceBinding>;
  openManagedWorkspaceFromBinding(
    input: ManagedWorkspaceIdentity,
  ): Promise<ManagedWorkspaceBinding>;
  inspectManagedWorkspace(binding: ManagedWorkspaceBinding): Promise<ManagedWorkspaceInspection>;
  quarantineManagedWorkspace(
    binding: ManagedWorkspaceBinding,
    reason: string,
  ): Promise<ManagedWorkspaceQuarantine>;
}

export function createGitWorkspaceService(
  input: CreateGitWorkspaceServiceInput,
): GitWorkspaceService {
  return new GitWorkspaceServiceImpl(input);
}

interface SourceRepositoryInspection {
  readonly sourceRoot: string;
  readonly gitCommonDir: string;
  readonly headCommitOid: string;
  readonly treeOid: string;
  readonly objectFormat: 'sha1' | 'sha256';
}

interface GitTreeEntry {
  readonly mode: string;
  readonly objectType: string;
  readonly oid: string;
  readonly path: string;
  readonly pathBytesBase64: string;
}

interface BaselineTreeSummary {
  readonly treeDeltaDigest: `sha256:${string}`;
  readonly changedFileCount: number;
}

interface ManagedRepositoryRecord {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_managed_git_repository_v1';
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly hooksPath: string;
  readonly gitRuntimeSha256: `sha256:${string}`;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly repositoryCapabilityDigest: `sha256:${string}`;
}

interface ManagedWorkspaceEpochArtifact {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_managed_workspace_epoch_artifact_v1';
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly sourceRoot: string;
  readonly sourceGitCommonDir: string;
  readonly sourceHeadCommitOid: string;
  readonly sourceTreeOid: string;
  readonly baselineCommitOid: string;
  readonly baselineTreeOid: string;
  readonly baselineRef: string;
  readonly headRef: string;
  readonly gitRuntimeSha256: `sha256:${string}`;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly materializationProfileDigest: `sha256:${string}`;
  readonly materializationSemantics: typeof MATERIALIZATION_SEMANTICS;
}

interface ManagedWorkspaceQuarantineIntent {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_managed_workspace_quarantine_intent_v1';
  readonly reason: string;
  readonly quarantinePath: string;
  readonly binding: ManagedWorkspaceBinding;
}

interface ManagedWorkspaceQuarantineRecord {
  readonly protocol: 'maka_managed_workspace_quarantine_v1';
  readonly reason: string;
  readonly binding: ManagedWorkspaceBinding;
}

interface WorkspaceLayout {
  readonly managedRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryPath: string;
  readonly repositoryRecordPath: string;
  readonly hooksPath: string;
  readonly homePath: string;
  readonly epochRoot: string;
  readonly epochArtifactPath: string;
  readonly instanceRoot: string;
  readonly bindingPath: string;
  readonly baselineReceiptPath: string;
  readonly mutationCandidateRoot: string;
  readonly projectionStagingRoot: string;
  readonly projectionQuarantineRoot: string;
  readonly worktreePath: string;
  readonly quarantineRoot: string;
  readonly quarantineIntentRoot: string;
  readonly quarantineIntentPath: string;
}

interface ManagedMutationCandidateDiscardIntentV1 {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_managed_mutation_candidate_discard_v1';
  readonly receipt: ManagedMutationCandidateReceiptV1;
}

interface ManagedMutationProjectionIntentV2 {
  readonly schemaVersion: 2;
  readonly protocol: 'maka_managed_mutation_projection_v2';
  readonly receipt: ManagedMutationCandidateReceiptV1;
  readonly previousWorktreeIdentity: OwnedDirectoryIdentityV1;
}

interface OwnedDirectoryIdentityV1 {
  readonly device: string;
  readonly inode: string;
}

class GitWorkspaceServiceImpl implements GitWorkspaceService {
  private readonly runtime: VerifiedGitRuntime;

  constructor(private readonly input: CreateGitWorkspaceServiceInput) {
    if (!isAbsolute(input.storageRoot)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed workspace storage root must be absolute',
      );
    }
    this.runtime = new VerifiedGitRuntime(input.gitRuntime);
    registerManagedBaselineReceiptAuthorityInternal(this, {
      issue: (binding) => this.#createOrReuseManagedWorkspaceBaselineReceipt(binding),
      require: (request) => this.#requireManagedWorkspaceBaselineReceipt(request),
      loadAcceptedContext: (request) => this.#loadManagedWorkspaceAcceptedContext(request),
      verify: (receipt) => this.#verifyManagedWorkspaceBaselineReceipt(receipt),
    });
    registerManagedMutationCandidateAuthorityInternal(this, {
      readBaseFile: (binding, baseHead, path) =>
        this.#readManagedMutationBaseFile(binding, baseHead, path),
      capture: (request) => this.#captureManagedMutationCandidate(request),
      require: (binding, operationId) =>
        this.#requireManagedMutationCandidate(binding, operationId),
      accept: (binding, receipt) => this.#acceptManagedMutationCandidate(binding, receipt),
      discard: (receipt) => this.#discardManagedMutationCandidate(receipt),
    });
  }

  async assertAvailable(): Promise<void> {
    await this.runtime.verify();
    await withArtifactWriterLock(this.input.storageRoot, async () => undefined);
  }

  async createManagedWorkspaceFromSource(
    input: CreateManagedWorkspaceFromSourceInput,
  ): Promise<ManagedWorkspaceBinding> {
    assertOpenIdentity(input);
    const runtime = await this.runtime.verify();

    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, input);
      await ensureOwnedDirectory(layout.managedRoot, canonicalStorageRoot);
      await ensureOwnedDirectory(layout.quarantineRoot, layout.managedRoot);
      await ensureOwnedDirectory(layout.homePath, layout.managedRoot);
      await assertOwnedManagedWorkspaceLayout(canonicalStorageRoot, layout);

      const quarantined = await this.resumePendingQuarantine(input, layout, runtime.digest);
      if (quarantined) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed workspace instance was quarantined: ${input.workspaceInstanceId}`,
        );
      }

      const existingBinding = await readBinding(layout.bindingPath);
      if (existingBinding) {
        assertBindingMatches(existingBinding, input, layout, runtime.digest);
        await this.resumePendingMutationProjection(existingBinding, layout);
        return this.adoptStoredBinding(input, existingBinding, layout);
      }

      const sourceRoot = await canonicalDirectory(input.sourceRoot, 'repository_ineligible');
      const source = await this.inspectSourceRepository(sourceRoot);
      const repository = await this.openRepository(input, source, layout, runtime.digest);
      const epoch = await this.openEpochArtifact(input, source, repository, layout);
      await this.clearIncompleteInstance(input, epoch, layout);
      await ensureOwnedDirectory(layout.instanceRoot, layout.managedRoot);
      await this.runtime.run(
        [
          '--git-dir',
          repository.repositoryPath,
          'worktree',
          'add',
          '--quiet',
          '--detach',
          layout.worktreePath,
          epoch.baselineCommitOid,
        ],
        layout.homePath,
      );
      await this.input.failpoint?.('after_worktree_materialized');

      await this.runtime.run(
        [
          '--git-dir',
          repository.repositoryPath,
          'worktree',
          'lock',
          '--reason',
          worktreeLockReason(input),
          layout.worktreePath,
        ],
        layout.homePath,
      );
      await this.input.failpoint?.('after_worktree_locked');
      await this.updateRefCas(
        repository.repositoryPath,
        epoch.headRef,
        epoch.baselineCommitOid,
        repository.objectFormat,
        layout.homePath,
      );
      await this.input.failpoint?.('after_head_ref_updated');

      const binding: ManagedWorkspaceBinding = {
        schemaVersion: BINDING_SCHEMA_VERSION,
        protocol: 'git_managed_workspace_v1',
        repositoryId: input.repositoryId,
        workspaceId: input.workspaceId,
        workspaceEpochId: input.workspaceEpochId,
        workspaceInstanceId: input.workspaceInstanceId,
        sourceRoot: epoch.sourceRoot,
        sourceGitCommonDir: epoch.sourceGitCommonDir,
        sourceHeadCommitOid: epoch.sourceHeadCommitOid,
        sourceTreeOid: epoch.sourceTreeOid,
        repositoryPath: repository.repositoryPath,
        worktreePath: normalize(layout.worktreePath),
        hooksPath: repository.hooksPath,
        baselineCommitOid: epoch.baselineCommitOid,
        baselineTreeOid: epoch.baselineTreeOid,
        headRef: epoch.headRef,
        gitRuntimeSha256: runtime.digest,
        objectFormat: repository.objectFormat,
        materializationProfileDigest: epoch.materializationProfileDigest,
        materializationSemantics: MATERIALIZATION_SEMANTICS,
      };
      const inspection = await this.inspectBinding(binding, layout);
      if (inspection.state !== 'ready') {
        await this.beginQuarantine(binding, layout, 'initial_materialization_drift');
        throw new GitWorkspaceServiceError(
          'managed_workspace_drifted',
          'Git materialization did not produce a clean managed workspace',
        );
      }
      await atomicWriteJson(layout.bindingPath, binding);
      return binding;
    });
  }

  async openManagedWorkspaceFromBinding(
    input: ManagedWorkspaceIdentity,
  ): Promise<ManagedWorkspaceBinding> {
    assertOpenIdentity(input);
    const runtime = await this.runtime.verify();
    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, input);
      await assertOwnedManagedWorkspaceLayout(canonicalStorageRoot, layout);
      const quarantined = await this.resumePendingQuarantine(input, layout, runtime.digest);
      if (quarantined) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed workspace instance was quarantined: ${input.workspaceInstanceId}`,
        );
      }
      const binding = await readBinding(layout.bindingPath);
      if (!binding) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed workspace binding is unavailable: ${input.workspaceInstanceId}`,
        );
      }
      assertBindingIdentity(binding, input, layout, runtime.digest);
      await this.resumePendingMutationProjection(binding, layout);
      return this.adoptStoredBinding(input, binding, layout);
    });
  }

  private async adoptStoredBinding(
    input: ManagedWorkspaceIdentity,
    binding: ManagedWorkspaceBinding,
    layout: WorkspaceLayout,
  ): Promise<ManagedWorkspaceBinding> {
    const repository = await this.requireRepository(input, layout);
    assertBindingRepository(binding, repository);
    const epoch = await this.requireEpochArtifact(input, repository, layout);
    assertBindingEpoch(binding, epoch);
    const inspection = await this.inspectBinding(binding, layout);
    if (inspection.state !== 'ready') {
      throw new GitWorkspaceServiceError(
        'managed_workspace_drifted',
        `Managed workspace contains unaccepted changes: ${binding.worktreePath}`,
      );
    }
    return binding;
  }

  async inspectManagedWorkspace(
    binding: ManagedWorkspaceBinding,
  ): Promise<ManagedWorkspaceInspection> {
    const runtime = await this.runtime.verify();
    assertBindingShape(binding);
    assertOpenIdentity(binding);
    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, binding);
      await assertOwnedManagedWorkspaceLayout(canonicalStorageRoot, layout);
      assertBindingPaths(binding, layout);
      const quarantined = await this.resumePendingQuarantine(binding, layout, runtime.digest);
      if (quarantined) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed workspace instance was quarantined: ${binding.workspaceInstanceId}`,
        );
      }
      const stored = await readBinding(layout.bindingPath);
      if (!stored || !sameBinding(stored, binding)) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed workspace binding is unavailable: ${binding.workspaceInstanceId}`,
        );
      }
      const repository = await readRepositoryRecord(layout.repositoryRecordPath);
      if (!repository) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed Git repository record is unavailable: ${binding.repositoryId}`,
        );
      }
      assertBindingRepository(binding, repository);
      await this.assertRepositoryArtifact(repository);
      const epoch = await this.requireEpochArtifact(binding, repository, layout);
      assertBindingEpoch(binding, epoch);
      return this.inspectBinding(binding, layout);
    });
  }

  async #requireManagedWorkspaceBaselineReceipt(
    input: CreateManagedWorkspaceFromSourceInput,
  ): Promise<ManagedWorkspaceBaselineReceiptV1> {
    const runtime = await this.runtime.verify();
    assertOpenIdentity(input);
    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, input);
      await assertOwnedManagedWorkspaceLayout(canonicalStorageRoot, layout);
      const receipt = await readBaselineReceipt(layout.baselineReceiptPath);
      if (!receipt) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          'Canonical workspace baseline receipt is unavailable',
        );
      }
      assertBindingMatches(receipt.binding, input, layout, runtime.digest);
      const summary = await this.requireVerifiedBaselineContext(
        receipt.binding,
        layout,
        runtime.digest,
      );
      assertBaselineReceiptMatches(receipt, receipt.binding, summary);
      return receipt;
    });
  }

  async #loadManagedWorkspaceAcceptedContext(
    input: CreateManagedWorkspaceFromSourceInput,
  ): Promise<ManagedWorkspaceBaselineReceiptV1> {
    const runtime = await this.runtime.verify();
    assertOpenIdentity(input);
    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, input);
      await assertOwnedManagedWorkspaceLayout(canonicalStorageRoot, layout);
      const receipt = await readBaselineReceipt(layout.baselineReceiptPath);
      if (!receipt) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          'Canonical workspace baseline receipt is unavailable',
        );
      }
      assertBindingMatches(receipt.binding, input, layout, runtime.digest);
      const sourceRoot = await canonicalDirectory(input.sourceRoot, 'repository_ineligible');
      const source = await this.inspectSourceRepository(sourceRoot);
      const repository = await this.requireRepository(receipt.binding, layout);
      assertBindingRepository(receipt.binding, repository);
      const epoch = await this.requireEpochArtifact(receipt.binding, repository, layout);
      assertBindingEpoch(receipt.binding, epoch);
      assertEpochArtifactMatches(epoch, input, source, repository);
      const summary = await this.readBaselineTreeSummary(receipt.binding, layout);
      assertBaselineReceiptMatches(receipt, receipt.binding, summary);
      return receipt;
    });
  }

  async #createOrReuseManagedWorkspaceBaselineReceipt(
    binding: ManagedWorkspaceBinding,
  ): Promise<ManagedWorkspaceBaselineReceiptV1> {
    const runtime = await this.runtime.verify();
    assertBindingShape(binding);
    assertOpenIdentity(binding);
    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, binding);
      const summary = await this.requireVerifiedBaselineContext(binding, layout, runtime.digest);
      const existing = await readBaselineReceipt(layout.baselineReceiptPath);
      if (existing) {
        assertBaselineReceiptMatches(existing, binding, summary);
        return existing;
      }
      const identities = deriveBaselineReceiptIdentities(binding);
      const receipt: ManagedWorkspaceBaselineReceiptV1 = {
        schemaVersion: BASELINE_RECEIPT_SCHEMA_VERSION,
        protocol: 'maka_managed_workspace_baseline_receipt_v1',
        binding,
        workspaceVersionId: identities.workspaceVersionId,
        policyVersion: 1,
        policyHash: MANAGED_BASELINE_POLICY_HASH_V1,
        epochOpenedEventId: identities.epochOpenedEventId,
        baselineAcceptedEventId: identities.baselineAcceptedEventId,
        treeDeltaDigest: summary.treeDeltaDigest,
        changedFileCount: summary.changedFileCount,
        deletedFileCount: 0,
      };
      await atomicWriteJson(layout.baselineReceiptPath, receipt);
      await this.input.failpoint?.('after_baseline_receipt');
      const durable = await readBaselineReceipt(layout.baselineReceiptPath);
      if (!durable) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          'Managed workspace baseline receipt was not durable',
        );
      }
      assertBaselineReceiptMatches(durable, binding, summary);
      return durable;
    });
  }

  async #captureManagedMutationCandidate(
    input: ManagedMutationCandidateRequest,
  ): Promise<ManagedMutationCandidateReceiptV1> {
    const request = snapshotMutationCandidateRequest(input);
    const runtime = await this.runtime.verify();
    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const { binding, baseHead } = request;
      const layout = workspaceLayout(canonicalStorageRoot, binding);
      const summary = await this.requireVerifiedMutationContext(binding, layout, runtime.digest);
      const baselineReceipt = await readBaselineReceipt(layout.baselineReceiptPath);
      if (!baselineReceipt) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          'Canonical workspace baseline receipt is unavailable',
        );
      }
      assertBaselineReceiptMatches(baselineReceipt, binding, summary);
      assertCandidateBaseMatches(binding, baselineReceipt, baseHead);

      await ensureOwnedDirectory(layout.mutationCandidateRoot, layout.instanceRoot);
      const identity = mutationCandidateIdentity(request.operationId, binding.workspaceEpochId);
      const receiptPath = join(layout.mutationCandidateRoot, `${identity.digest}.json`);
      if (await readMutationCandidateDiscardIntent(`${receiptPath}.discard`)) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          'Managed mutation candidate discard must finish before capture can resume',
        );
      }
      const existing = await readMutationCandidateReceipt(receiptPath);
      if (existing) {
        assertMutationCandidateReceiptMatches(
          existing,
          request,
          identity.ref,
          baselineReceipt.policyHash,
        );
        await this.assertMutationCandidateArtifact(existing, layout);
        return existing;
      }

      const mutation = await this.inspectMutationCandidateInput(request, layout);
      const indexPath = join(layout.mutationCandidateRoot, `${identity.digest}.index`);
      try {
        await removeOwnedCandidateTemporaryFile(indexPath);
        await removeOwnedCandidateTemporaryFile(`${indexPath}.lock`);
        const indexEnv = { GIT_INDEX_FILE: indexPath };
        await this.runtime.run(
          ['--git-dir', binding.repositoryPath, 'read-tree', baseHead.commitOid],
          layout.homePath,
          indexEnv,
        );
        const candidatePath = request.expectedPaths[0]!;
        if (request.expectedContent === null) {
          await this.runtime.runWithInput(
            ['--git-dir', binding.repositoryPath, 'update-index', '--index-info'],
            `0 ${'0'.repeat(binding.objectFormat === 'sha1' ? 40 : 64)}\t${candidatePath}\n`,
            layout.homePath,
            indexEnv,
          );
        } else {
          const oid = (
            await this.runtime.runWithInput(
              ['--git-dir', binding.repositoryPath, 'hash-object', '-w', '--stdin'],
              request.expectedContent,
              layout.homePath,
            )
          ).trim();
          if (oid !== request.expectedBlobOid) {
            throw new GitWorkspaceServiceError(
              'managed_workspace_identity_conflict',
              'Managed mutation result content does not match its exact blob identity',
            );
          }
          const mode = await this.readManagedMutationPathMode(
            binding,
            baseHead.treeOid,
            candidatePath,
            layout,
          );
          await this.runtime.run(
            [
              '--literal-pathspecs',
              '--git-dir',
              binding.repositoryPath,
              'update-index',
              '--add',
              '--cacheinfo',
              mode ?? '100644',
              oid,
              candidatePath,
            ],
            layout.homePath,
            indexEnv,
          );
        }
        const candidateTreeOid = (
          await this.runtime.run(
            ['--git-dir', binding.repositoryPath, 'write-tree'],
            layout.homePath,
            indexEnv,
          )
        ).trim();
        if (candidateTreeOid === baseHead.treeOid) {
          throw new GitWorkspaceServiceError(
            'managed_workspace_drifted',
            'Managed mutation did not produce a successor tree',
          );
        }
        await this.assertSupportedMutationCandidateTree(binding, candidateTreeOid, layout);
        await this.assertManagedMutationCandidateBlob(
          binding,
          candidateTreeOid,
          request.expectedPaths[0]!,
          request.expectedBlobOid,
          layout,
        );
        const candidateCommitOid = (
          await this.runtime.run(
            [
              '--git-dir',
              binding.repositoryPath,
              'commit-tree',
              candidateTreeOid,
              '-p',
              baseHead.commitOid,
              '-m',
              mutationCandidateCommitMessage(identity.digest),
            ],
            layout.homePath,
            deterministicMutationCommitEnvironment(),
          )
        ).trim();
        await this.updateRefCas(
          binding.repositoryPath,
          identity.ref,
          candidateCommitOid,
          binding.objectFormat,
          layout.homePath,
        );
        await this.input.failpoint?.('after_mutation_candidate_ref');
        const delta = await this.readMutationDelta(
          binding,
          baseHead.commitOid,
          candidateCommitOid,
          layout,
        );
        if (!sameStringSet(delta.changedPaths, mutation.changedPaths)) {
          throw new GitWorkspaceServiceError(
            'managed_workspace_drifted',
            'Managed mutation candidate changed an undeclared path',
          );
        }
        const receipt: ManagedMutationCandidateReceiptV1 = {
          schemaVersion: MUTATION_CANDIDATE_RECEIPT_SCHEMA_VERSION,
          protocol: 'maka_managed_mutation_candidate_v1',
          repositoryId: binding.repositoryId,
          workspaceId: binding.workspaceId,
          workspaceEpochId: binding.workspaceEpochId,
          workspaceInstanceId: binding.workspaceInstanceId,
          operationId: request.operationId,
          baseHead: request.baseHead,
          candidateRef: identity.ref,
          candidateCommitOid,
          candidateTreeOid,
          gitRuntimeSha256: binding.gitRuntimeSha256,
          objectFormat: binding.objectFormat,
          materializationProfileDigest: binding.materializationProfileDigest,
          workspacePolicyHash: baselineReceipt.policyHash,
          candidatePolicyHash: MUTATION_CANDIDATE_POLICY_HASH_V1,
          treeDeltaDigest: delta.treeDeltaDigest,
          changedPaths: delta.changedPaths,
          deletedPaths: delta.deletedPaths,
          expectedBlobOid: request.expectedBlobOid,
          executionProfileDigest: request.executionProfileDigest,
        };
        await atomicWriteJson(receiptPath, receipt);
        const durable = await readMutationCandidateReceipt(receiptPath);
        if (!durable || !isDeepStrictEqual(durable, receipt)) {
          throw new GitWorkspaceServiceError(
            'managed_workspace_unavailable',
            'Managed mutation candidate receipt did not become durable',
          );
        }
        return durable;
      } finally {
        await rm(indexPath, { force: true });
        await rm(`${indexPath}.lock`, { force: true });
      }
    });
  }

  async #readManagedMutationBaseFile(
    binding: ManagedWorkspaceBinding,
    baseHead: WorkspaceHeadRecordV1,
    path: string,
  ): Promise<{ readonly blobOid: string; readonly content: string } | null> {
    const canonicalPath = assertManagedMutationPath(path);
    const runtime = await this.runtime.verify();
    return await withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, binding);
      const summary = await this.requireVerifiedMutationContext(binding, layout, runtime.digest);
      const baselineReceipt = await readBaselineReceipt(layout.baselineReceiptPath);
      if (!baselineReceipt) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          'Canonical workspace baseline receipt is unavailable',
        );
      }
      assertBaselineReceiptMatches(baselineReceipt, binding, summary);
      assertCandidateBaseMatches(binding, baselineReceipt, baseHead);
      const entries = parseTreeEntries(
        await this.runtime.runBuffer(
          [
            '--literal-pathspecs',
            '--git-dir',
            binding.repositoryPath,
            'ls-tree',
            '-z',
            baseHead.treeOid,
            '--',
            canonicalPath,
          ],
          layout.homePath,
        ),
      ).filter((entry) => entry.path === canonicalPath);
      if (entries.length === 0) return null;
      if (entries.length !== 1 || entries[0]!.objectType !== 'blob') {
        throw new GitWorkspaceServiceError(
          'managed_mutation_candidate_rejected',
          'Managed mutation base path is not one regular Git blob',
        );
      }
      const blobOid = entries[0]!.oid;
      const bytes = await this.runtime.runBuffer(
        ['--git-dir', binding.repositoryPath, 'cat-file', 'blob', blobOid],
        layout.homePath,
      );
      const content = bytes.toString('utf8');
      if (gitBlobOid(content, binding.objectFormat) !== blobOid) {
        throw new GitWorkspaceServiceError(
          'managed_mutation_candidate_rejected',
          'Managed mutation base blob is not bounded canonical UTF-8 text',
        );
      }
      return Object.freeze({ blobOid, content });
    });
  }

  async #discardManagedMutationCandidate(input: ManagedMutationCandidateReceiptV1): Promise<void> {
    const receipt = snapshotMutationCandidateReceipt(input);
    await withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, receipt);
      await assertOwnedManagedWorkspaceLayout(canonicalStorageRoot, layout);
      await assertOwnedDirectoryEntry(layout.mutationCandidateRoot, layout.instanceRoot, true);
      const identity = mutationCandidateIdentity(receipt.operationId, receipt.workspaceEpochId);
      const receiptPath = join(layout.mutationCandidateRoot, `${identity.digest}.json`);
      const intentPath = `${receiptPath}.discard`;
      let intent = await readMutationCandidateDiscardIntent(intentPath);
      if (!intent) {
        const durable = await readMutationCandidateReceipt(receiptPath);
        if (!durable || !isDeepStrictEqual(durable, receipt)) {
          throw new GitWorkspaceServiceError(
            'managed_workspace_identity_conflict',
            'Managed mutation candidate receipt changed before discard',
          );
        }
        await this.assertMutationCandidateArtifact(receipt, layout);
        intent = {
          schemaVersion: MUTATION_CANDIDATE_DISCARD_INTENT_SCHEMA_VERSION,
          protocol: 'maka_managed_mutation_candidate_discard_v1',
          receipt,
        };
        await atomicWriteJson(intentPath, intent);
      } else if (!isDeepStrictEqual(intent.receipt, receipt)) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_identity_conflict',
          'Managed mutation candidate discard intent conflicts with its receipt',
        );
      }
      const current = (
        await this.runtime.run(
          [
            '--git-dir',
            layout.repositoryPath,
            'rev-parse',
            '--verify',
            '--quiet',
            receipt.candidateRef,
          ],
          layout.homePath,
          undefined,
          [1],
        )
      ).trim();
      if (current) {
        if (current !== receipt.candidateCommitOid) {
          throw new GitWorkspaceServiceError(
            'managed_workspace_identity_conflict',
            'Managed mutation candidate ref changed before discard',
          );
        }
        await this.deleteRefCas(
          layout.repositoryPath,
          receipt.candidateRef,
          receipt.candidateCommitOid,
          layout.homePath,
        );
        await this.input.failpoint?.('after_mutation_candidate_discard_ref');
      }
      await rm(receiptPath, { force: true });
      // Keep the intent as the durable discard tombstone. Exact retries
      // must remain idempotent even when the previous process exited after
      // removing both the ref and the live receipt.
    });
  }

  async #acceptManagedMutationCandidate(
    inputBinding: ManagedWorkspaceBinding,
    inputReceipt: ManagedMutationCandidateReceiptV1,
  ): Promise<void> {
    const binding = Object.freeze({ ...inputBinding });
    const receipt = snapshotMutationCandidateReceipt(inputReceipt);
    await withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, binding);
      await assertOwnedManagedWorkspaceLayout(canonicalStorageRoot, layout);
      const baselineReceipt = await readBaselineReceipt(layout.baselineReceiptPath);
      if (!baselineReceipt) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          'Canonical workspace baseline receipt is unavailable',
        );
      }
      const summary = await this.requireVerifiedMutationContext(
        binding,
        layout,
        binding.gitRuntimeSha256,
      );
      assertBaselineReceiptMatches(baselineReceipt, binding, summary);
      const identity = mutationCandidateIdentity(receipt.operationId, receipt.workspaceEpochId);
      const receiptPath = join(layout.mutationCandidateRoot, `${identity.digest}.json`);
      const durable = await readMutationCandidateReceipt(receiptPath);
      if (!durable || !isDeepStrictEqual(durable, receipt)) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_identity_conflict',
          'Managed mutation candidate receipt changed before acceptance',
        );
      }
      assertMutationCandidateReceiptMatches(
        receipt,
        {
          binding,
          operationId: receipt.operationId,
          baseHead: receipt.baseHead,
          expectedPaths: receipt.changedPaths,
          expectedBlobOid: receipt.expectedBlobOid,
          executionProfileDigest: receipt.executionProfileDigest,
        },
        identity.ref,
        baselineReceipt.policyHash,
      );
      await this.assertMutationCandidateArtifact(receipt, layout);
      if (await isNonSymlinkDirectory(binding.worktreePath)) {
        const [currentHead, currentHeadRef, currentStatus] = await Promise.all([
          this.runtime.run(['-C', binding.worktreePath, 'rev-parse', 'HEAD'], layout.homePath),
          this.runtime.run(
            ['--git-dir', binding.repositoryPath, 'rev-parse', binding.headRef],
            layout.homePath,
          ),
          this.runtime.run(
            [
              '-C',
              binding.worktreePath,
              'status',
              '--porcelain=v1',
              '--untracked-files=all',
              '--ignored=matching',
            ],
            layout.homePath,
          ),
        ]);
        if (
          currentHead.trim() === receipt.candidateCommitOid &&
          currentHeadRef.trim() === receipt.candidateCommitOid
        ) {
          if (currentStatus.trim() === '') return;
          throw new GitWorkspaceServiceError(
            'managed_workspace_drifted',
            'Accepted managed projection contains later external changes',
          );
        }
        if (
          currentHead.trim() !== receipt.baseHead.commitOid ||
          currentHeadRef.trim() !== receipt.baseHead.commitOid
        ) {
          throw new GitWorkspaceServiceError(
            'managed_workspace_drifted',
            'Managed projection no longer matches the candidate rotation base',
          );
        }
      }
      await this.prepareMutationProjection(binding, receipt, identity.digest, layout);
      await this.convergeMutationProjection(binding, receipt, identity.digest, layout);
    });
  }

  private async prepareMutationProjection(
    binding: ManagedWorkspaceBinding,
    receipt: ManagedMutationCandidateReceiptV1,
    digest: string,
    layout: WorkspaceLayout,
  ): Promise<void> {
    await ensureOwnedDirectory(layout.mutationCandidateRoot, layout.instanceRoot);
    await ensureOwnedDirectory(layout.projectionStagingRoot, layout.managedRoot);
    await ensureOwnedDirectory(layout.projectionQuarantineRoot, layout.managedRoot);
    const paths = mutationProjectionPaths(layout, digest);
    const existing = await readMutationProjectionIntent(paths.intentPath);
    if (existing) {
      assertMutationProjectionIntent(existing, receipt);
      return;
    }
    const intent: ManagedMutationProjectionIntentV2 = {
      schemaVersion: 2,
      protocol: 'maka_managed_mutation_projection_v2',
      receipt,
      previousWorktreeIdentity: await readOwnedDirectoryIdentity(binding.worktreePath),
    };
    // The intent precedes staging publication so a crash during `worktree add`
    // can be repaired from the immutable candidate instead of leaving an
    // unauthenticated directory that later code has to delete by pathname.
    await atomicWriteJson(paths.intentPath, intent);
    await this.input.failpoint?.('after_mutation_projection_intent');
  }

  private async convergeMutationProjection(
    binding: ManagedWorkspaceBinding,
    receipt: ManagedMutationCandidateReceiptV1,
    digest: string,
    layout: WorkspaceLayout,
  ): Promise<void> {
    const paths = mutationProjectionPaths(layout, digest);
    const intent = await readMutationProjectionIntent(paths.intentPath);
    if (!intent) {
      const inspection = await this.inspectBinding(binding, layout);
      if (
        inspection.state === 'ready' &&
        inspection.commitOid === receipt.candidateCommitOid &&
        inspection.treeOid === receipt.candidateTreeOid
      ) {
        return;
      }
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        'Managed mutation projection intent is unavailable',
      );
    }
    assertMutationProjectionIntent(intent, receipt);

    const stableExists = await pathEntryExists(binding.worktreePath);
    const previousExists = await pathEntryExists(paths.previousPath);
    if (previousExists) {
      await assertOwnedDirectoryIdentity(paths.previousPath, intent.previousWorktreeIdentity);
    }

    if (previousExists && stableExists) {
      await this.relocateManagedProjectionWorktree(
        binding,
        paths.stagingPath,
        binding.worktreePath,
        receipt.candidateCommitOid,
        mutationProjectionStagingLockReason(digest),
        worktreeLockReason(binding),
        'after_mutation_projection_publish_renamed',
        layout,
      );
    }
    const stableRegistration = stableExists
      ? await this.readProjectionWorktreeRegistration(binding, binding.worktreePath, layout)
      : undefined;
    const projectionAlreadyPublished = stableRegistration?.headOid === receipt.candidateCommitOid;
    if (!projectionAlreadyPublished) {
      await this.ensureMutationProjectionStaging(binding, receipt, digest, layout);
    }

    if (!previousExists) {
      if (!stableExists) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          'Managed mutation projection lost both its current and previous worktree',
        );
      }
      await assertOwnedDirectoryIdentity(binding.worktreePath, intent.previousWorktreeIdentity);
      await this.relocateManagedProjectionWorktree(
        binding,
        binding.worktreePath,
        paths.previousPath,
        receipt.baseHead.commitOid,
        worktreeLockReason(binding),
        mutationProjectionQuarantineLockReason(digest),
        'after_mutation_projection_previous_renamed',
        layout,
      );
      await this.input.failpoint?.('after_mutation_projection_previous');
    }
    await assertOwnedDirectoryIdentity(paths.previousPath, intent.previousWorktreeIdentity);
    await this.repairAndRequireProjectionWorktreeRegistration(
      binding,
      paths.previousPath,
      receipt.baseHead.commitOid,
      mutationProjectionQuarantineLockReason(digest),
      layout,
    );

    const stableAfterPrevious = await pathEntryExists(binding.worktreePath);
    if (!stableAfterPrevious) {
      if (!(await pathEntryExists(paths.stagingPath))) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          'Managed mutation projection staging tree is unavailable',
        );
      }
      await this.relocateManagedProjectionWorktree(
        binding,
        paths.stagingPath,
        binding.worktreePath,
        receipt.candidateCommitOid,
        mutationProjectionStagingLockReason(digest),
        worktreeLockReason(binding),
        'after_mutation_projection_publish_renamed',
        layout,
      );
      await this.input.failpoint?.('after_mutation_projection_publish');
    } else if (await pathEntryExists(paths.stagingPath)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_drifted',
        'A concurrent writer recreated the managed projection during rotation',
      );
    }

    await this.repairAndRequireProjectionWorktreeRegistration(
      binding,
      binding.worktreePath,
      receipt.candidateCommitOid,
      worktreeLockReason(binding),
      layout,
    );
    const headRef = (
      await this.runtime.run(
        ['--git-dir', binding.repositoryPath, 'rev-parse', binding.headRef],
        layout.homePath,
      )
    ).trim();
    if (headRef === receipt.baseHead.commitOid) {
      await this.updateExistingRefCas(
        binding.repositoryPath,
        binding.headRef,
        receipt.candidateCommitOid,
        receipt.baseHead.commitOid,
        layout.homePath,
      );
    } else if (headRef !== receipt.candidateCommitOid) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_drifted',
        'Managed workspace head ref changed during projection rotation',
      );
    }
    const inspection = await this.inspectBinding(binding, layout);
    if (
      inspection.state !== 'ready' ||
      inspection.commitOid !== receipt.candidateCommitOid ||
      inspection.treeOid !== receipt.candidateTreeOid
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_drifted',
        `Managed mutation projection did not converge to the accepted candidate: ${JSON.stringify(inspection)}`,
      );
    }
    await rm(paths.intentPath, { force: true });
  }

  private async ensureMutationProjectionStaging(
    binding: ManagedWorkspaceBinding,
    receipt: ManagedMutationCandidateReceiptV1,
    digest: string,
    layout: WorkspaceLayout,
  ): Promise<void> {
    const paths = mutationProjectionPaths(layout, digest);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const registration = await this.readProjectionWorktreeRegistration(
        binding,
        paths.stagingPath,
        layout,
      );
      const pathExists = await pathEntryExists(paths.stagingPath);

      if (registration && !pathExists) {
        if (registration.lockReason !== undefined) {
          throw new GitWorkspaceServiceError(
            'managed_workspace_identity_conflict',
            'Missing projection staging path still has a locked Git registration',
          );
        }
        await this.runtime.run(
          ['--git-dir', binding.repositoryPath, 'worktree', 'prune', '--expire=now'],
          layout.homePath,
        );
        if (await this.readProjectionWorktreeRegistration(binding, paths.stagingPath, layout)) {
          throw new GitWorkspaceServiceError(
            'managed_workspace_identity_conflict',
            'Incomplete projection staging registration could not be pruned',
          );
        }
        continue;
      }

      if (pathExists) {
        await assertOwnedDirectoryEntry(paths.stagingPath, layout.projectionStagingRoot, true);
        if (
          registration?.headOid === receipt.candidateCommitOid &&
          (registration.lockReason === undefined ||
            registration.lockReason === mutationProjectionStagingLockReason(digest))
        ) {
          const [tree, status] = await Promise.all([
            this.runtime.run(
              ['-C', paths.stagingPath, 'rev-parse', '--verify', 'HEAD^{tree}'],
              layout.homePath,
            ),
            this.readProjectionWorktreeStatus(paths.stagingPath, layout),
          ]);
          if (tree.trim() === receipt.candidateTreeOid && status === '') {
            await this.ensureProjectionWorktreeLock(
              binding,
              paths.stagingPath,
              receipt.candidateCommitOid,
              mutationProjectionStagingLockReason(digest),
              layout,
            );
            return;
          }
        } else if (registration) {
          throw new GitWorkspaceServiceError(
            'managed_workspace_identity_conflict',
            'Incomplete projection staging registration changed identity',
          );
        }
        await this.preserveIncompleteProjectionStaging(
          binding,
          paths.stagingPath,
          registration,
          receipt.candidateCommitOid,
          digest,
          layout,
        );
        continue;
      }

      await this.runtime.run(
        [
          '--git-dir',
          binding.repositoryPath,
          'worktree',
          'add',
          '--quiet',
          '--detach',
          '--no-checkout',
          paths.stagingPath,
          receipt.candidateCommitOid,
        ],
        layout.homePath,
      );
      await this.input.failpoint?.('after_mutation_projection_staging_registered');
      await this.runtime.run(
        ['-C', paths.stagingPath, 'reset', '--hard', receipt.candidateCommitOid],
        layout.homePath,
      );
      const [tree, status] = await Promise.all([
        this.runtime.run(
          ['-C', paths.stagingPath, 'rev-parse', '--verify', 'HEAD^{tree}'],
          layout.homePath,
        ),
        this.readProjectionWorktreeStatus(paths.stagingPath, layout),
      ]);
      if (tree.trim() !== receipt.candidateTreeOid || status !== '') {
        throw new GitWorkspaceServiceError(
          'managed_workspace_identity_conflict',
          'New projection staging worktree did not materialize the candidate',
        );
      }
      await this.ensureProjectionWorktreeLock(
        binding,
        paths.stagingPath,
        receipt.candidateCommitOid,
        mutationProjectionStagingLockReason(digest),
        layout,
      );
      return;
    }
    throw new GitWorkspaceServiceError(
      'managed_workspace_unavailable',
      'Managed mutation projection staging did not converge',
    );
  }

  private async preserveIncompleteProjectionStaging(
    binding: ManagedWorkspaceBinding,
    stagingPath: string,
    registration: WorktreeRegistration | undefined,
    expectedHead: string,
    digest: string,
    layout: WorkspaceLayout,
  ): Promise<void> {
    if (registration) {
      if (
        registration.headOid !== expectedHead ||
        (registration.lockReason !== undefined &&
          registration.lockReason !== mutationProjectionStagingLockReason(digest))
      ) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_identity_conflict',
          'Incomplete projection staging artifact changed Git identity',
        );
      }
      if (registration.lockReason !== undefined) {
        await this.runtime.run(
          ['--git-dir', binding.repositoryPath, 'worktree', 'unlock', stagingPath],
          layout.homePath,
        );
      }
    }
    const preservedPath = await moveToQuarantine(
      stagingPath,
      layout.projectionQuarantineRoot,
      `partial-projection-${digest}`,
    );
    if (registration || (await pathEntryExists(join(preservedPath, '.git')))) {
      try {
        await this.runtime.run(
          ['--git-dir', binding.repositoryPath, 'worktree', 'repair', preservedPath],
          layout.homePath,
        );
      } catch (error) {
        // A path-only interruption may contain an incomplete or absent `.git`
        // pointer with no central registration to repair. The whole directory
        // is already quarantined and cannot alias the future canonical
        // worktree, so retain it as inert evidence. A known registration must
        // always remain repairable.
        if (registration) throw error;
      }
    }
    const preservedRegistration = await this.readProjectionWorktreeRegistration(
      binding,
      preservedPath,
      layout,
    );
    if (preservedRegistration) {
      await this.ensureProjectionWorktreeLock(
        binding,
        preservedPath,
        expectedHead,
        mutationProjectionPartialLockReason(digest),
        layout,
      );
    }
    await this.runtime.run(
      ['--git-dir', binding.repositoryPath, 'worktree', 'prune', '--expire=now'],
      layout.homePath,
    );
    if (await this.readProjectionWorktreeRegistration(binding, stagingPath, layout)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Incomplete projection staging registration still owns its source path',
      );
    }
  }

  private async readProjectionWorktreeStatus(
    worktreePath: string,
    layout: WorkspaceLayout,
  ): Promise<string> {
    return (
      await this.runtime.run(
        [
          '-C',
          worktreePath,
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
          '--ignored=matching',
        ],
        layout.homePath,
      )
    ).trim();
  }

  private async relocateManagedProjectionWorktree(
    binding: ManagedWorkspaceBinding,
    sourcePath: string,
    targetPath: string,
    expectedHead: string,
    sourceLockReason: string,
    targetLockReason: string,
    afterRenameFailpoint:
      | 'after_mutation_projection_previous_renamed'
      | 'after_mutation_projection_publish_renamed',
    layout: WorkspaceLayout,
  ): Promise<void> {
    const sourceExists = await pathEntryExists(sourcePath);
    const targetExists = await pathEntryExists(targetPath);
    if (sourceExists && targetExists) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Projection relocation source and target both exist',
      );
    }
    if (!sourceExists && !targetExists) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        'Projection relocation lost both source and target paths',
      );
    }

    if (sourceExists) {
      // Repair is deliberately driven from the directory that actually
      // exists. A prior killed repair may already name the target in central
      // registration metadata even though the atomic rename still presents
      // the source path.
      await this.runtime.run(
        ['--git-dir', binding.repositoryPath, 'worktree', 'repair', sourcePath],
        layout.homePath,
      );
      const registration = await this.requireProjectionWorktreeRegistration(
        binding,
        sourcePath,
        expectedHead,
        sourceLockReason,
        layout,
      );
      if (registration.lockReason !== undefined) {
        await this.runtime.run(
          ['--git-dir', binding.repositoryPath, 'worktree', 'unlock', sourcePath],
          layout.homePath,
        );
      }
      await rename(sourcePath, targetPath);
      await this.input.failpoint?.(afterRenameFailpoint);
    }

    await this.runtime.run(
      ['--git-dir', binding.repositoryPath, 'worktree', 'repair', targetPath],
      layout.homePath,
    );
    await this.ensureProjectionWorktreeLock(
      binding,
      targetPath,
      expectedHead,
      targetLockReason,
      layout,
    );
    if (await this.readProjectionWorktreeRegistration(binding, sourcePath, layout)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Projection relocation retained its obsolete source registration',
      );
    }
  }

  private async repairAndRequireProjectionWorktreeRegistration(
    binding: ManagedWorkspaceBinding,
    worktreePath: string,
    expectedHead: string,
    expectedLockReason: string,
    layout: WorkspaceLayout,
  ): Promise<WorktreeRegistration> {
    await this.runtime.run(
      ['--git-dir', binding.repositoryPath, 'worktree', 'repair', worktreePath],
      layout.homePath,
    );
    return this.requireProjectionWorktreeRegistration(
      binding,
      worktreePath,
      expectedHead,
      expectedLockReason,
      layout,
    );
  }

  private async ensureProjectionWorktreeLock(
    binding: ManagedWorkspaceBinding,
    worktreePath: string,
    expectedHead: string,
    expectedLockReason: string,
    layout: WorkspaceLayout,
  ): Promise<void> {
    const registration = await this.readProjectionWorktreeRegistration(
      binding,
      worktreePath,
      layout,
    );
    if (!registration || registration.headOid !== expectedHead) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed projection Git worktree registration changed identity',
      );
    }
    if (registration.lockReason === expectedLockReason) return;
    if (registration.lockReason !== undefined) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed projection Git worktree lock changed identity',
      );
    }
    await this.runtime.run(
      [
        '--git-dir',
        binding.repositoryPath,
        'worktree',
        'lock',
        '--reason',
        expectedLockReason,
        worktreePath,
      ],
      layout.homePath,
    );
  }

  private async requireProjectionWorktreeRegistration(
    binding: ManagedWorkspaceBinding,
    worktreePath: string,
    expectedHead: string,
    expectedLockReason: string,
    layout: WorkspaceLayout,
  ): Promise<WorktreeRegistration> {
    await this.ensureProjectionWorktreeLock(
      binding,
      worktreePath,
      expectedHead,
      expectedLockReason,
      layout,
    );
    const registration = await this.readProjectionWorktreeRegistration(
      binding,
      worktreePath,
      layout,
    );
    if (
      !registration ||
      registration.headOid !== expectedHead ||
      registration.lockReason !== expectedLockReason
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed projection Git worktree registration is unavailable',
      );
    }
    return registration;
  }

  private async readProjectionWorktreeRegistration(
    binding: ManagedWorkspaceBinding,
    worktreePath: string,
    layout: WorkspaceLayout,
  ): Promise<WorktreeRegistration | undefined> {
    return findWorktreeRegistration(
      await this.runtime.run(
        ['--git-dir', binding.repositoryPath, 'worktree', 'list', '--porcelain'],
        layout.homePath,
      ),
      worktreePath,
    );
  }

  private async resumePendingMutationProjection(
    binding: ManagedWorkspaceBinding,
    layout: WorkspaceLayout,
  ): Promise<void> {
    let names: string[];
    try {
      names = await readdir(layout.mutationCandidateRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const intents = names.filter((name) => name.endsWith('.projection.json'));
    if (intents.length > 1) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed workspace has multiple pending projection rotations',
      );
    }
    const name = intents[0];
    if (!name) return;
    const digest = name.slice(0, -'.projection.json'.length);
    const intent = await readMutationProjectionIntent(join(layout.mutationCandidateRoot, name));
    if (!intent) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed mutation projection intent is invalid',
      );
    }
    assertMutationProjectionIntent(intent, intent.receipt);
    if (
      intent.receipt.repositoryId !== binding.repositoryId ||
      intent.receipt.workspaceId !== binding.workspaceId ||
      intent.receipt.workspaceEpochId !== binding.workspaceEpochId ||
      intent.receipt.workspaceInstanceId !== binding.workspaceInstanceId
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed mutation projection intent belongs to another workspace',
      );
    }
    await this.assertMutationCandidateArtifact(intent.receipt, layout);
    await this.convergeMutationProjection(binding, intent.receipt, digest, layout);
  }

  async #requireManagedMutationCandidate(
    inputBinding: ManagedWorkspaceBinding,
    operationId: string,
  ): Promise<ManagedMutationCandidateReceiptV1> {
    const binding = Object.freeze({ ...inputBinding });
    const runtime = await this.runtime.verify();
    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, binding);
      await assertOwnedManagedWorkspaceLayout(canonicalStorageRoot, layout);
      const baselineReceipt = await readBaselineReceipt(layout.baselineReceiptPath);
      if (!baselineReceipt) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          'Canonical workspace baseline receipt is unavailable',
        );
      }
      const summary = await this.requireVerifiedMutationContext(binding, layout, runtime.digest);
      assertBaselineReceiptMatches(baselineReceipt, binding, summary);
      const identity = mutationCandidateIdentity(operationId, binding.workspaceEpochId);
      const receipt = await readMutationCandidateReceipt(
        join(layout.mutationCandidateRoot, `${identity.digest}.json`),
      );
      if (!receipt) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed mutation candidate receipt is unavailable: ${operationId}`,
        );
      }
      assertMutationCandidateReceiptMatches(
        receipt,
        {
          binding,
          operationId,
          baseHead: receipt.baseHead,
          expectedPaths: receipt.changedPaths,
          expectedBlobOid: receipt.expectedBlobOid,
          executionProfileDigest: receipt.executionProfileDigest,
        },
        identity.ref,
        baselineReceipt.policyHash,
      );
      await this.assertMutationCandidateArtifact(receipt, layout);
      return receipt;
    });
  }

  private async inspectMutationCandidateInput(
    request: ManagedMutationCandidateRequest,
    layout: WorkspaceLayout,
  ): Promise<{ changedPaths: readonly string[]; deletedPaths: readonly string[] }> {
    const { binding, baseHead } = request;
    if (!(await isNonSymlinkDirectory(binding.worktreePath))) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed mutation worktree is unavailable or has changed identity',
      );
    }
    const [head, tree, headRef, status, commonDirRaw, worktreeList] = await Promise.all([
      this.runtime.run(
        ['-C', binding.worktreePath, 'rev-parse', '--verify', 'HEAD'],
        layout.homePath,
      ),
      this.runtime.run(
        ['-C', binding.worktreePath, 'rev-parse', '--verify', 'HEAD^{tree}'],
        layout.homePath,
      ),
      this.runtime.run(
        ['--git-dir', binding.repositoryPath, 'rev-parse', '--verify', binding.headRef],
        layout.homePath,
      ),
      this.runtime.runBuffer(
        [
          '-C',
          binding.worktreePath,
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignored=matching',
        ],
        layout.homePath,
      ),
      this.runtime.run(
        ['-C', binding.worktreePath, 'rev-parse', '--git-common-dir'],
        layout.homePath,
      ),
      this.runtime.run(
        ['--git-dir', binding.repositoryPath, 'worktree', 'list', '--porcelain'],
        layout.homePath,
      ),
    ]);
    const commonDir = await realpath(resolveGitPath(binding.worktreePath, commonDirRaw.trim()));
    if (!samePath(commonDir, binding.repositoryPath)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed mutation worktree is attached to a different repository',
      );
    }
    assertWorktreeRegistrationLocked(
      worktreeList,
      binding.worktreePath,
      worktreeLockReason(binding),
    );
    if (
      head.trim() !== baseHead.commitOid ||
      tree.trim() !== baseHead.treeOid ||
      headRef.trim() !== baseHead.commitOid
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_drifted',
        'Managed mutation base no longer matches the accepted workspace head',
      );
    }
    const entries = parsePorcelainStatus(status);
    if (entries.length !== 0) {
      throw new GitWorkspaceServiceError(
        'managed_mutation_candidate_rejected',
        'Managed mutation input projection contains external changes',
      );
    }
    const baseBlob = await this.readTreeBlobOid(
      binding,
      baseHead.treeOid,
      request.expectedPaths[0]!,
      layout,
    );
    if (baseBlob === request.expectedBlobOid) {
      throw new GitWorkspaceServiceError(
        'managed_mutation_no_change',
        'Managed mutation did not change the workspace',
      );
    }
    const changedPaths = request.expectedPaths;
    return {
      changedPaths,
      deletedPaths: request.expectedBlobOid === null ? changedPaths : [],
    };
  }

  private async readTreeBlobOid(
    binding: ManagedWorkspaceBinding,
    treeOid: string,
    path: string,
    layout: WorkspaceLayout,
  ): Promise<string | null> {
    const entries = parseTreeEntries(
      await this.runtime.runBuffer(
        [
          '--literal-pathspecs',
          '--git-dir',
          binding.repositoryPath,
          'ls-tree',
          '-z',
          treeOid,
          '--',
          path,
        ],
        layout.homePath,
      ),
    ).filter((entry) => entry.path === path);
    if (entries.length === 0) return null;
    if (entries.length !== 1 || entries[0]!.objectType !== 'blob') {
      throw new GitWorkspaceServiceError(
        'managed_mutation_candidate_rejected',
        'Managed mutation path is not one regular Git blob',
      );
    }
    return entries[0]!.oid;
  }

  private async readManagedMutationPathMode(
    binding: ManagedWorkspaceBinding,
    treeOid: string,
    path: string,
    layout: WorkspaceLayout,
  ): Promise<string | null> {
    const entries = parseTreeEntries(
      await this.runtime.runBuffer(
        [
          '--literal-pathspecs',
          '--git-dir',
          binding.repositoryPath,
          'ls-tree',
          '-z',
          treeOid,
          '--',
          path,
        ],
        layout.homePath,
      ),
    ).filter((entry) => entry.path === path);
    if (entries.length === 0) return null;
    const entry = entries[0]!;
    if (
      entries.length !== 1 ||
      entry.objectType !== 'blob' ||
      !['100644', '100755'].includes(entry.mode)
    ) {
      throw new GitWorkspaceServiceError(
        'managed_mutation_candidate_rejected',
        'Managed mutation path has an unsupported Git mode',
      );
    }
    return entry.mode;
  }

  private async readMutationDelta(
    binding: ManagedWorkspaceBinding,
    baseCommitOid: string,
    candidateCommitOid: string,
    layout: WorkspaceLayout,
  ): Promise<{
    treeDeltaDigest: `sha256:${string}`;
    changedPaths: readonly string[];
    deletedPaths: readonly string[];
  }> {
    const [raw, names] = await Promise.all([
      this.runtime.runBuffer(
        [
          '--git-dir',
          binding.repositoryPath,
          'diff-tree',
          '-r',
          '--raw',
          '-z',
          '--no-renames',
          baseCommitOid,
          candidateCommitOid,
        ],
        layout.homePath,
      ),
      this.runtime.runBuffer(
        [
          '--git-dir',
          binding.repositoryPath,
          'diff-tree',
          '-r',
          '--name-status',
          '-z',
          '--no-renames',
          baseCommitOid,
          candidateCommitOid,
        ],
        layout.homePath,
      ),
    ]);
    const entries = parseNameStatus(names);
    return {
      treeDeltaDigest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      changedPaths: entries.map((entry) => entry.path).sort(),
      deletedPaths: entries
        .filter((entry) => entry.status === 'D')
        .map((entry) => entry.path)
        .sort(),
    };
  }

  private async assertMutationCandidateArtifact(
    receipt: ManagedMutationCandidateReceiptV1,
    layout: WorkspaceLayout,
  ): Promise<void> {
    const storedBinding = await readBinding(layout.bindingPath);
    if (
      !storedBinding ||
      storedBinding.repositoryId !== receipt.repositoryId ||
      storedBinding.workspaceId !== receipt.workspaceId ||
      storedBinding.workspaceEpochId !== receipt.workspaceEpochId ||
      storedBinding.workspaceInstanceId !== receipt.workspaceInstanceId
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed mutation candidate lost its workspace binding',
      );
    }
    const [ref, commit, tree, parent, body] = await Promise.all([
      this.runtime.run(
        ['--git-dir', layout.repositoryPath, 'rev-parse', '--verify', receipt.candidateRef],
        layout.homePath,
      ),
      this.runtime.run(
        ['--git-dir', layout.repositoryPath, 'rev-parse', '--verify', receipt.candidateCommitOid],
        layout.homePath,
      ),
      this.runtime.run(
        [
          '--git-dir',
          layout.repositoryPath,
          'rev-parse',
          '--verify',
          `${receipt.candidateCommitOid}^{tree}`,
        ],
        layout.homePath,
      ),
      this.runtime.run(
        [
          '--git-dir',
          layout.repositoryPath,
          'rev-parse',
          '--verify',
          `${receipt.candidateCommitOid}^`,
        ],
        layout.homePath,
      ),
      this.runtime.run(
        ['--git-dir', layout.repositoryPath, 'cat-file', 'commit', receipt.candidateCommitOid],
        layout.homePath,
      ),
    ]);
    const identity = mutationCandidateIdentity(receipt.operationId, receipt.workspaceEpochId);
    if (
      ref.trim() !== receipt.candidateCommitOid ||
      commit.trim() !== receipt.candidateCommitOid ||
      tree.trim() !== receipt.candidateTreeOid ||
      parent.trim() !== receipt.baseHead.commitOid ||
      !isOwnedMutationCandidateCommit(
        body,
        identity.digest,
        receipt.baseHead.commitOid,
        receipt.candidateTreeOid,
      )
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed mutation candidate artifact changed after publication',
      );
    }
    await this.assertSupportedMutationCandidateTree(
      storedBinding,
      receipt.candidateTreeOid,
      layout,
    );
    await this.assertManagedMutationCandidateBlob(
      storedBinding,
      receipt.candidateTreeOid,
      receipt.changedPaths[0]!,
      receipt.expectedBlobOid,
      layout,
    );
    const delta = await this.readMutationDelta(
      storedBinding,
      receipt.baseHead.commitOid,
      receipt.candidateCommitOid,
      layout,
    );
    if (
      delta.treeDeltaDigest !== receipt.treeDeltaDigest ||
      !isDeepStrictEqual(delta.changedPaths, receipt.changedPaths) ||
      !isDeepStrictEqual(delta.deletedPaths, receipt.deletedPaths)
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed mutation candidate receipt does not match its Git delta',
      );
    }
  }

  private async assertManagedMutationCandidateBlob(
    binding: ManagedWorkspaceBinding,
    treeOid: string,
    path: string,
    expectedBlobOid: string | null,
    layout: WorkspaceLayout,
  ): Promise<void> {
    const entries = parseTreeEntries(
      await this.runtime.runBuffer(
        [
          '--literal-pathspecs',
          '--git-dir',
          binding.repositoryPath,
          'ls-tree',
          '-z',
          treeOid,
          '--',
          path,
        ],
        layout.homePath,
      ),
    ).filter((entry) => entry.path === path);
    const matches =
      expectedBlobOid === null
        ? entries.length === 0
        : entries.length === 1 &&
          entries[0]!.objectType === 'blob' &&
          entries[0]!.oid === expectedBlobOid;
    if (!matches) {
      throw new GitWorkspaceServiceError(
        'managed_mutation_candidate_rejected',
        'Managed mutation candidate does not match its worker result blob',
      );
    }
  }

  private async assertSupportedMutationCandidateTree(
    binding: ManagedWorkspaceBinding,
    treeOid: string,
    layout: WorkspaceLayout,
  ): Promise<void> {
    const entries = parseTreeEntries(
      await this.runtime.runBuffer(
        ['--git-dir', binding.repositoryPath, 'ls-tree', '-r', '-z', treeOid],
        layout.homePath,
      ),
    );
    try {
      assertSupportedTree(entries);
    } catch (error) {
      throw new GitWorkspaceServiceError(
        'managed_mutation_candidate_rejected',
        'Managed mutation candidate contains an unsupported path or Git mode',
        { cause: error },
      );
    }
  }

  async #verifyManagedWorkspaceBaselineReceipt(
    receipt: ManagedWorkspaceBaselineReceiptV1,
  ): Promise<void> {
    const runtime = await this.runtime.verify();
    assertBaselineReceiptShape(receipt);
    assertOpenIdentity(receipt.binding);
    await withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, receipt.binding);
      const summary = await this.requireVerifiedBaselineContext(
        receipt.binding,
        layout,
        runtime.digest,
      );
      const durable = await readBaselineReceipt(layout.baselineReceiptPath);
      if (!durable || !sameBaselineReceipt(durable, receipt)) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_identity_conflict',
          'Managed workspace baseline receipt does not match its durable artifact',
        );
      }
      assertBaselineReceiptMatches(durable, receipt.binding, summary);
    });
  }

  async quarantineManagedWorkspace(
    binding: ManagedWorkspaceBinding,
    reason: string,
  ): Promise<ManagedWorkspaceQuarantine> {
    const runtime = await this.runtime.verify();
    assertBindingShape(binding);
    assertOpenIdentity(binding);
    if (!reason.trim()) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed workspace quarantine reason is required',
      );
    }
    return withArtifactWriterLock(this.input.storageRoot, async (canonicalStorageRoot) => {
      const layout = workspaceLayout(canonicalStorageRoot, binding);
      await assertOwnedManagedWorkspaceLayout(canonicalStorageRoot, layout);
      assertBindingPaths(binding, layout);
      const pending = await readQuarantineIntent(layout.quarantineIntentPath);
      if (pending) {
        assertQuarantineIntentMatches(pending, binding, reason, layout);
        await this.assertQuarantineBindingAuthority(binding, layout, runtime.digest);
        return this.resumeQuarantineIntent(pending, layout);
      }
      const stored = await readBinding(layout.bindingPath);
      if (!stored || !sameBinding(stored, binding)) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed workspace binding is unavailable: ${binding.workspaceInstanceId}`,
        );
      }
      const repository = await readRepositoryRecord(layout.repositoryRecordPath);
      if (!repository) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_unavailable',
          `Managed Git repository record is unavailable: ${binding.repositoryId}`,
        );
      }
      assertBindingRepository(binding, repository);
      await this.assertRepositoryArtifact(repository);
      const epoch = await this.requireEpochArtifact(binding, repository, layout);
      assertBindingEpoch(binding, epoch);
      return this.beginQuarantine(binding, layout, reason);
    });
  }

  private async requireVerifiedBaselineContext(
    binding: ManagedWorkspaceBinding,
    layout: WorkspaceLayout,
    runtimeDigest: `sha256:${string}`,
  ): Promise<BaselineTreeSummary> {
    assertBindingPaths(binding, layout);
    const quarantined = await this.resumePendingQuarantine(binding, layout, runtimeDigest);
    if (quarantined) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed workspace instance was quarantined: ${binding.workspaceInstanceId}`,
      );
    }
    const stored = await readBinding(layout.bindingPath);
    if (!stored || !sameBinding(stored, binding)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed workspace binding is unavailable: ${binding.workspaceInstanceId}`,
      );
    }
    const repository = await this.requireRepository(binding, layout);
    assertBindingRepository(binding, repository);
    const epoch = await this.requireEpochArtifact(binding, repository, layout);
    assertBindingEpoch(binding, epoch);
    const inspection = await this.inspectBinding(binding, layout);
    if (inspection.state !== 'ready') {
      throw new GitWorkspaceServiceError(
        'managed_workspace_drifted',
        `Managed workspace contains unaccepted changes: ${binding.worktreePath}`,
      );
    }
    return this.readBaselineTreeSummary(binding, layout);
  }

  private async requireVerifiedMutationContext(
    binding: ManagedWorkspaceBinding,
    layout: WorkspaceLayout,
    runtimeDigest: `sha256:${string}`,
  ): Promise<BaselineTreeSummary> {
    await assertOwnedManagedWorkspaceLayout(this.input.storageRoot, layout);
    assertBindingPaths(binding, layout);
    const quarantined = await this.resumePendingQuarantine(binding, layout, runtimeDigest);
    if (quarantined) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed workspace instance was quarantined: ${binding.workspaceInstanceId}`,
      );
    }
    const stored = await readBinding(layout.bindingPath);
    if (!stored || !sameBinding(stored, binding)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed workspace binding is unavailable: ${binding.workspaceInstanceId}`,
      );
    }
    const repository = await this.requireRepository(binding, layout);
    assertBindingRepository(binding, repository);
    const epoch = await this.requireEpochArtifact(binding, repository, layout);
    assertBindingEpoch(binding, epoch);
    return this.readBaselineTreeSummary(binding, layout);
  }

  private async readBaselineTreeSummary(
    binding: ManagedWorkspaceBinding,
    layout: WorkspaceLayout,
  ): Promise<BaselineTreeSummary> {
    const entries = parseTreeEntries(
      await this.runtime.runBuffer(
        ['--git-dir', binding.repositoryPath, 'ls-tree', '-r', '-z', binding.baselineCommitOid],
        layout.homePath,
      ),
    );
    assertSupportedTree(entries);
    return baselineTreeSummary(entries);
  }

  private async inspectSourceRepository(sourceRoot: string): Promise<SourceRepositoryInspection> {
    try {
      const topLevelRaw = await this.runtime.run([
        '-C',
        sourceRoot,
        'rev-parse',
        '--show-toplevel',
      ]);
      const topLevel = await realpath(topLevelRaw.trim());
      if (!samePath(topLevel, sourceRoot)) {
        throw new GitWorkspaceServiceError(
          'repository_ineligible',
          'Managed workspace source must be the Git worktree root',
        );
      }
      const status = await this.runtime.run([
        '-C',
        sourceRoot,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ]);
      if (status.trim()) {
        throw new GitWorkspaceServiceError(
          'repository_ineligible',
          'Managed workspace source must have no tracked or untracked changes',
        );
      }
      const sparse = await this.runtime.runOptional(
        ['-C', sourceRoot, 'config', '--bool', '--get', 'core.sparseCheckout'],
        1,
      );
      if (sparse?.trim() === 'true') {
        throw new GitWorkspaceServiceError(
          'repository_ineligible',
          'Sparse Git worktrees are not supported by managed workspace v1',
        );
      }
      const entries = parseTreeEntries(
        await this.runtime.runBuffer(['-C', sourceRoot, 'ls-tree', '-r', '-z', 'HEAD']),
      );
      assertSupportedTree(entries);

      const gitCommonDirRaw = (
        await this.runtime.run(['-C', sourceRoot, 'rev-parse', '--git-common-dir'])
      ).trim();
      const gitCommonDir = await realpath(resolveGitPath(sourceRoot, gitCommonDirRaw));
      await this.assertSourceConfigurationFences(sourceRoot, gitCommonDir);
      const [headCommitOid, treeOid, objectFormat] = await Promise.all([
        this.runtime.run(['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD']),
        this.runtime.run(['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD^{tree}']),
        this.runtime.run(['-C', sourceRoot, 'rev-parse', '--show-object-format']),
      ]);
      const normalizedObjectFormat = objectFormat.trim();
      if (normalizedObjectFormat !== 'sha1' && normalizedObjectFormat !== 'sha256') {
        throw new GitWorkspaceServiceError(
          'repository_ineligible',
          `Unsupported Git object format: ${normalizedObjectFormat}`,
        );
      }
      return {
        sourceRoot: normalize(sourceRoot),
        gitCommonDir: normalize(gitCommonDir),
        headCommitOid: headCommitOid.trim(),
        treeOid: treeOid.trim(),
        objectFormat: normalizedObjectFormat,
      };
    } catch (error) {
      if (error instanceof GitWorkspaceServiceError) throw error;
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        `Unable to inspect managed workspace source: ${sourceRoot}`,
        { cause: error },
      );
    }
  }

  private async openRepository(
    input: CreateManagedWorkspaceFromSourceInput,
    source: SourceRepositoryInspection,
    layout: WorkspaceLayout,
    runtimeDigest: `sha256:${string}`,
  ): Promise<ManagedRepositoryRecord> {
    const existing = await readRepositoryRecord(layout.repositoryRecordPath);
    if (existing) {
      assertRepositoryMatches(existing, input, source.objectFormat, layout, runtimeDigest);
      await this.assertRepositoryArtifact(existing);
      return existing;
    }

    if (await pathExists(layout.repositoryRoot)) {
      await moveToQuarantine(
        layout.repositoryRoot,
        layout.quarantineRoot,
        `${input.repositoryId}-incomplete-repository`,
      );
    }
    await ensureOwnedDirectory(layout.repositoryRoot, layout.managedRoot);
    await ensureOwnedDirectory(layout.hooksPath, layout.repositoryRoot);
    const stagingRepository = join(
      layout.repositoryRoot,
      `r.tmp-${randomBytes(6).toString('hex')}`,
    );
    try {
      const templatePath = join(layout.repositoryRoot, 'empty-template');
      await mkdir(templatePath, { recursive: true });
      await this.runtime.run(
        [
          'init',
          '--quiet',
          '--bare',
          `--object-format=${source.objectFormat}`,
          `--template=${templatePath}`,
          stagingRepository,
        ],
        layout.homePath,
      );
      await this.configureManagedRepository(stagingRepository, layout.hooksPath);
      await rename(stagingRepository, layout.repositoryPath);

      const record: ManagedRepositoryRecord = {
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        protocol: 'maka_managed_git_repository_v1',
        repositoryId: input.repositoryId,
        repositoryPath: normalize(layout.repositoryPath),
        hooksPath: normalize(layout.hooksPath),
        gitRuntimeSha256: runtimeDigest,
        objectFormat: source.objectFormat,
        repositoryCapabilityDigest: repositoryCapabilityDigest(runtimeDigest, source.objectFormat),
      };
      await this.assertRepositoryArtifact(record);
      await atomicWriteJson(layout.repositoryRecordPath, record);
      await this.input.failpoint?.('after_repository_record');
      return record;
    } catch (error) {
      await rm(stagingRepository, { recursive: true, force: true });
      if (error instanceof GitWorkspaceServiceError) throw error;
      throw new GitWorkspaceServiceError(
        'git_workspace_operation_failed',
        'Unable to create the Maka-owned Git repository',
        { cause: error },
      );
    }
  }

  private async assertSourceConfigurationFences(
    sourceRoot: string,
    gitCommonDir: string,
  ): Promise<void> {
    if (await pathExists(join(gitCommonDir, 'objects', 'info', 'alternates'))) {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Managed workspace source must not use Git object alternates',
      );
    }
    const unsafeConfig = await this.runtime.runOptional(
      ['-C', sourceRoot, 'config', '--no-includes', '--local', '--name-only', '--get-regexp', '.*'],
      1,
    );
    const worktreeConfigEnabled = (
      await this.runtime.runOptional(
        [
          '-C',
          sourceRoot,
          'config',
          '--no-includes',
          '--local',
          '--bool',
          '--get',
          'extensions.worktreeConfig',
        ],
        1,
      )
    )?.trim();
    const unsafeWorktreeConfig =
      worktreeConfigEnabled === 'true'
        ? await this.runtime.runOptional(
            [
              '-C',
              sourceRoot,
              'config',
              '--no-includes',
              '--worktree',
              '--name-only',
              '--get-regexp',
              '.*',
            ],
            1,
          )
        : undefined;
    const replaceRefs = await this.runtime.run(
      ['-C', sourceRoot, 'for-each-ref', '--format=%(refname)', 'refs/replace/'],
      undefined,
      undefined,
      [1],
    );
    if (
      hasUnsafeSourceConfig(unsafeConfig) ||
      hasUnsafeSourceConfig(unsafeWorktreeConfig) ||
      replaceRefs.trim()
    ) {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Managed workspace source contains unsupported Git indirection or runtime configuration',
      );
    }
  }

  private async openEpochArtifact(
    input: CreateManagedWorkspaceFromSourceInput,
    source: SourceRepositoryInspection,
    repository: ManagedRepositoryRecord,
    layout: WorkspaceLayout,
  ): Promise<ManagedWorkspaceEpochArtifact> {
    const existing = await readEpochArtifact(layout.epochArtifactPath);
    if (existing) {
      assertEpochArtifactMatches(existing, input, source, repository);
      await this.assertEpochArtifact(existing, repository, layout);
      return existing;
    }

    const baselineRef = managedBaselineRef(input.workspaceEpochId);
    await this.clearIncompleteBaselineRef(repository.repositoryPath, baselineRef, layout.homePath);
    await ensureOwnedDirectory(layout.epochRoot, layout.managedRoot);
    await this.runtime.importTree(
      source.sourceRoot,
      source.treeOid,
      repository.repositoryPath,
      layout.homePath,
    );
    const importedTree = (
      await this.runtime.run(
        ['--git-dir', repository.repositoryPath, 'rev-parse', `${source.treeOid}^{tree}`],
        layout.homePath,
      )
    ).trim();
    if (importedTree !== source.treeOid) {
      throw new GitWorkspaceServiceError(
        'git_workspace_operation_failed',
        'Imported baseline tree does not match the source HEAD tree',
      );
    }
    const baselineCommitOid = (
      await this.runtime.run(
        [
          '--git-dir',
          repository.repositoryPath,
          'commit-tree',
          importedTree,
          '-m',
          BASELINE_MESSAGE.trim(),
        ],
        layout.homePath,
        baselineCommitEnvironment(),
      )
    ).trim();
    const observedBeforeRef = await this.inspectSourceRepository(source.sourceRoot);
    assertSameSourceObservation(source, observedBeforeRef);
    await this.updateRefCas(
      repository.repositoryPath,
      baselineRef,
      baselineCommitOid,
      repository.objectFormat,
      layout.homePath,
    );

    await this.input.failpoint?.('after_baseline_ref_created');
    try {
      const observedAgain = await this.inspectSourceRepository(source.sourceRoot);
      assertSameSourceObservation(source, observedAgain);
    } catch (error) {
      await this.deleteRefCas(
        repository.repositoryPath,
        baselineRef,
        baselineCommitOid,
        layout.homePath,
      );
      throw error;
    }

    const artifact: ManagedWorkspaceEpochArtifact = {
      schemaVersion: EPOCH_ARTIFACT_SCHEMA_VERSION,
      protocol: 'maka_managed_workspace_epoch_artifact_v1',
      repositoryId: input.repositoryId,
      workspaceId: input.workspaceId,
      workspaceEpochId: input.workspaceEpochId,
      sourceRoot: source.sourceRoot,
      sourceGitCommonDir: source.gitCommonDir,
      sourceHeadCommitOid: source.headCommitOid,
      sourceTreeOid: source.treeOid,
      baselineCommitOid,
      baselineTreeOid: importedTree,
      baselineRef,
      headRef: managedHeadRef(input.workspaceId, input.workspaceEpochId),
      gitRuntimeSha256: repository.gitRuntimeSha256,
      objectFormat: repository.objectFormat,
      materializationProfileDigest: materializationProfileDigest(
        repository.gitRuntimeSha256,
        repository.objectFormat,
      ),
      materializationSemantics: MATERIALIZATION_SEMANTICS,
    };
    await this.assertEpochArtifact(artifact, repository, layout);
    await atomicWriteJson(layout.epochArtifactPath, artifact);
    return artifact;
  }

  private async requireRepository(
    input: ManagedWorkspaceIdentity,
    layout: WorkspaceLayout,
  ): Promise<ManagedRepositoryRecord> {
    const repository = await readRepositoryRecord(layout.repositoryRecordPath);
    if (!repository) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed Git repository record is unavailable: ${input.repositoryId}`,
      );
    }
    if (
      repository.repositoryId !== input.repositoryId ||
      !samePath(repository.repositoryPath, layout.repositoryPath) ||
      !samePath(repository.hooksPath, layout.hooksPath)
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed Git repository does not match the requested repository identity',
      );
    }
    await this.assertRepositoryArtifact(repository);
    return repository;
  }

  private async requireEpochArtifact(
    input: Pick<ManagedWorkspaceIdentity, 'repositoryId' | 'workspaceId' | 'workspaceEpochId'>,
    repository: ManagedRepositoryRecord,
    layout: WorkspaceLayout,
  ): Promise<ManagedWorkspaceEpochArtifact> {
    const epoch = await readEpochArtifact(layout.epochArtifactPath);
    if (!epoch) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed workspace epoch artifact is unavailable: ${input.workspaceEpochId}`,
      );
    }
    if (
      epoch.repositoryId !== input.repositoryId ||
      epoch.workspaceId !== input.workspaceId ||
      epoch.workspaceEpochId !== input.workspaceEpochId
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed workspace epoch artifact does not match the requested identity',
      );
    }
    await this.assertEpochArtifact(epoch, repository, layout);
    return epoch;
  }

  private async assertEpochArtifact(
    epoch: ManagedWorkspaceEpochArtifact,
    repository: ManagedRepositoryRecord,
    layout: WorkspaceLayout,
  ): Promise<void> {
    if (
      epoch.repositoryId !== repository.repositoryId ||
      epoch.gitRuntimeSha256 !== repository.gitRuntimeSha256 ||
      epoch.objectFormat !== repository.objectFormat ||
      epoch.materializationProfileDigest !==
        materializationProfileDigest(repository.gitRuntimeSha256, repository.objectFormat) ||
      epoch.baselineRef !== managedBaselineRef(epoch.workspaceEpochId) ||
      epoch.headRef !== managedHeadRef(epoch.workspaceId, epoch.workspaceEpochId)
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed workspace epoch artifact does not match its repository capability',
      );
    }
    const [commit, tree, baselineRef] = await Promise.all([
      this.runtime.run(
        ['--git-dir', repository.repositoryPath, 'rev-parse', '--verify', epoch.baselineCommitOid],
        layout.homePath,
      ),
      this.runtime.run(
        [
          '--git-dir',
          repository.repositoryPath,
          'rev-parse',
          '--verify',
          `${epoch.baselineCommitOid}^{tree}`,
        ],
        layout.homePath,
      ),
      this.runtime.run(
        ['--git-dir', repository.repositoryPath, 'rev-parse', '--verify', epoch.baselineRef],
        layout.homePath,
      ),
    ]);
    if (
      commit.trim() !== epoch.baselineCommitOid ||
      tree.trim() !== epoch.baselineTreeOid ||
      baselineRef.trim() !== epoch.baselineCommitOid
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed workspace epoch baseline identity changed',
      );
    }
  }

  private async updateRefCas(
    repositoryPath: string,
    ref: string,
    desiredOid: string,
    objectFormat: string,
    homePath: string,
  ): Promise<void> {
    const current = (
      await this.runtime.runOptional(
        ['--git-dir', repositoryPath, 'rev-parse', '--verify', '--quiet', ref],
        1,
      )
    )?.trim();
    if (current === desiredOid) return;
    if (current) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Managed Git ref already points at a different object: ${ref}`,
      );
    }
    const expected = '0'.repeat(objectFormat === 'sha256' ? 64 : 40);
    try {
      await this.runtime.run(
        ['--git-dir', repositoryPath, 'update-ref', ref, desiredOid, expected],
        homePath,
      );
    } catch (error) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Managed Git ref changed concurrently: ${ref}`,
        { cause: error },
      );
    }
  }

  private async updateExistingRefCas(
    repositoryPath: string,
    ref: string,
    desiredOid: string,
    expectedOid: string,
    homePath: string,
  ): Promise<void> {
    const current = (
      await this.runtime.runOptional(
        ['--git-dir', repositoryPath, 'rev-parse', '--verify', '--quiet', ref],
        1,
      )
    )?.trim();
    if (current === desiredOid) return;
    if (current !== expectedOid) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Managed Git ref does not match its accepted predecessor: ${ref}`,
      );
    }
    try {
      await this.runtime.run(
        ['--git-dir', repositoryPath, 'update-ref', ref, desiredOid, expectedOid],
        homePath,
      );
    } catch (error) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Managed Git ref changed during successor acceptance: ${ref}`,
        { cause: error },
      );
    }
  }

  private async deleteRefCas(
    repositoryPath: string,
    ref: string,
    expectedOid: string,
    homePath: string,
  ): Promise<void> {
    try {
      await this.runtime.run(
        ['--git-dir', repositoryPath, 'update-ref', '-d', ref, expectedOid],
        homePath,
      );
    } catch (error) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Managed Git ref changed before cleanup: ${ref}`,
        { cause: error },
      );
    }
  }

  private async clearIncompleteBaselineRef(
    repositoryPath: string,
    baselineRef: string,
    homePath: string,
  ): Promise<void> {
    const current = (
      await this.runtime.runOptional(
        ['--git-dir', repositoryPath, 'rev-parse', '--verify', '--quiet', baselineRef],
        1,
      )
    )?.trim();
    if (!current) return;
    const commitBody = await this.runtime.run(
      ['--git-dir', repositoryPath, 'cat-file', 'commit', current],
      homePath,
    );
    if (!isOwnedBaselineCommit(commitBody)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Incomplete managed baseline ref is not owned by this protocol: ${baselineRef}`,
      );
    }
    await this.deleteRefCas(repositoryPath, baselineRef, current, homePath);
  }

  private async configureManagedRepository(
    repositoryPath: string,
    hooksPath: string,
  ): Promise<void> {
    const entries: readonly [string, string][] = [
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'true'],
      ['core.hooksPath', normalize(hooksPath)],
      ['core.sshCommand', ''],
      ['credential.helper', ''],
      ['credential.interactive', 'never'],
      ['protocol.allow', 'never'],
      ['gc.auto', '0'],
    ];
    for (const [key, value] of entries) {
      await this.runtime.run(
        ['--git-dir', repositoryPath, 'config', '--local', key, value],
        dirname(repositoryPath),
      );
    }
  }

  private async assertRepositoryArtifact(record: ManagedRepositoryRecord): Promise<void> {
    if (!(await isNonSymlinkDirectory(record.repositoryPath))) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed Git repository is unavailable: ${record.repositoryPath}`,
      );
    }
    if (!(await isNonSymlinkDirectory(record.hooksPath))) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Managed Git hooks fence is unavailable: ${record.hooksPath}`,
      );
    }
    const objectFormat = (
      await this.runtime.run([
        '--git-dir',
        record.repositoryPath,
        'rev-parse',
        '--show-object-format',
      ])
    ).trim();
    if (
      objectFormat !== record.objectFormat ||
      record.repositoryCapabilityDigest !==
        repositoryCapabilityDigest(record.gitRuntimeSha256, record.objectFormat)
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed Git repository capability identity changed',
      );
    }
    if (await pathExists(join(record.repositoryPath, 'objects', 'info', 'alternates'))) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed Git repository must not use object alternates',
      );
    }
  }

  private async inspectBinding(
    binding: ManagedWorkspaceBinding,
    layout: WorkspaceLayout,
  ): Promise<ManagedWorkspaceInspection> {
    assertBindingPaths(binding, layout);
    if (
      !(await isNonSymlinkDirectory(binding.worktreePath)) ||
      !(await isNonSymlinkDirectory(binding.repositoryPath))
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Managed workspace is unavailable: ${binding.worktreePath}`,
      );
    }
    try {
      const commonDirRaw = (
        await this.runtime.run(
          ['-C', binding.worktreePath, 'rev-parse', '--git-common-dir'],
          layout.homePath,
        )
      ).trim();
      const commonDir = await realpath(resolveGitPath(binding.worktreePath, commonDirRaw));
      if (!samePath(commonDir, binding.repositoryPath)) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_identity_conflict',
          'Managed worktree is attached to a different Git repository',
        );
      }
      const [commitRaw, treeRaw, statusRaw, headRefRaw, worktreeListRaw] = await Promise.all([
        this.runtime.run(
          ['-C', binding.worktreePath, 'rev-parse', '--verify', 'HEAD'],
          layout.homePath,
        ),
        this.runtime.run(
          ['-C', binding.worktreePath, 'rev-parse', '--verify', 'HEAD^{tree}'],
          layout.homePath,
        ),
        this.runtime.run(
          [
            '-C',
            binding.worktreePath,
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
            '--ignored=matching',
          ],
          layout.homePath,
        ),
        this.runtime.run(
          ['--git-dir', binding.repositoryPath, 'rev-parse', '--verify', binding.headRef],
          layout.homePath,
        ),
        this.runtime.run(
          ['--git-dir', binding.repositoryPath, 'worktree', 'list', '--porcelain'],
          layout.homePath,
        ),
      ]);
      const commitOid = commitRaw.trim();
      const treeOid = treeRaw.trim();
      const status = statusRaw.trim();
      const headRef = headRefRaw.trim();
      assertWorktreeRegistrationLocked(
        worktreeListRaw,
        binding.worktreePath,
        worktreeLockReason(binding),
      );
      if (commitOid !== headRef || status) {
        return { state: 'drifted', commitOid, treeOid, status };
      }
      return { state: 'ready', commitOid, treeOid };
    } catch (error) {
      if (error instanceof GitWorkspaceServiceError) throw error;
      throw new GitWorkspaceServiceError(
        'managed_workspace_unavailable',
        `Unable to inspect managed workspace: ${binding.worktreePath}`,
        { cause: error },
      );
    }
  }

  private async clearIncompleteInstance(
    input: ManagedWorkspaceIdentity,
    epoch: ManagedWorkspaceEpochArtifact,
    layout: WorkspaceLayout,
  ): Promise<void> {
    const registration = findWorktreeRegistration(
      await this.runtime.run(
        ['--git-dir', layout.repositoryPath, 'worktree', 'list', '--porcelain'],
        layout.homePath,
      ),
      layout.worktreePath,
    );
    if (registration) {
      if (
        registration.headOid !== epoch.baselineCommitOid ||
        (registration.lockReason !== undefined &&
          registration.lockReason !== worktreeLockReason(input))
      ) {
        throw new GitWorkspaceServiceError(
          'managed_workspace_identity_conflict',
          'Incomplete managed worktree registration does not match its durable identity',
        );
      }
      // Git cannot unlock a registration after its worktree path has been moved
      // (notably on Windows), so unlock only after exact identity validation and
      // immediately before quarantining the path under the global writer lock.
      if (registration.lockReason !== undefined) {
        await this.runtime.run(
          ['--git-dir', layout.repositoryPath, 'worktree', 'unlock', layout.worktreePath],
          layout.homePath,
        );
      }
    }
    if (await pathExists(layout.instanceRoot)) {
      await moveToQuarantine(
        layout.instanceRoot,
        layout.quarantineRoot,
        `incomplete-${randomUUID()}`,
      );
    }
    await this.runtime.run(
      ['--git-dir', layout.repositoryPath, 'worktree', 'prune', '--expire=now'],
      layout.homePath,
    );
    const remaining = findWorktreeRegistration(
      await this.runtime.run(
        ['--git-dir', layout.repositoryPath, 'worktree', 'list', '--porcelain'],
        layout.homePath,
      ),
      layout.worktreePath,
    );
    if (remaining) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Incomplete managed worktree registration could not be removed safely',
      );
    }
  }

  private async resumePendingQuarantine(
    input: ManagedWorkspaceIdentity,
    layout: WorkspaceLayout,
    runtimeDigest: `sha256:${string}`,
  ): Promise<ManagedWorkspaceQuarantine | undefined> {
    await assertOwnedManagedWorkspaceLayout(this.input.storageRoot, layout);
    const intent = await readQuarantineIntent(layout.quarantineIntentPath);
    if (!intent) return undefined;
    assertQuarantineIntentMatches(intent, intent.binding, intent.reason, layout);
    assertBindingIdentity(intent.binding, input, layout, runtimeDigest);
    await this.assertQuarantineBindingAuthority(intent.binding, layout, runtimeDigest);
    return this.resumeQuarantineIntent(intent, layout);
  }

  private async assertQuarantineBindingAuthority(
    binding: ManagedWorkspaceBinding,
    layout: WorkspaceLayout,
    runtimeDigest: `sha256:${string}`,
  ): Promise<void> {
    assertBindingIdentity(binding, binding, layout, runtimeDigest);
    const repository = await this.requireRepository(binding, layout);
    assertBindingRepository(binding, repository);
    const epoch = await this.requireEpochArtifact(binding, repository, layout);
    assertBindingEpoch(binding, epoch);
  }

  private async beginQuarantine(
    binding: ManagedWorkspaceBinding,
    layout: WorkspaceLayout,
    reason: string,
  ): Promise<ManagedWorkspaceQuarantine> {
    await ensureOwnedDirectory(layout.quarantineIntentRoot, layout.managedRoot);
    const existing = await readQuarantineIntent(layout.quarantineIntentPath);
    if (existing) {
      assertQuarantineIntentMatches(existing, binding, reason, layout);
      return this.resumeQuarantineIntent(existing, layout);
    }
    const intent: ManagedWorkspaceQuarantineIntent = {
      schemaVersion: QUARANTINE_INTENT_SCHEMA_VERSION,
      protocol: 'maka_managed_workspace_quarantine_intent_v1',
      reason,
      quarantinePath: join(
        layout.quarantineRoot,
        `${compactIdentity(binding.workspaceInstanceId)}-${sanitizeReason(reason)}-${randomUUID()}`,
      ),
      binding,
    };
    assertQuarantineIntentMatches(intent, binding, reason, layout);
    await atomicWriteJson(layout.quarantineIntentPath, intent);
    await this.input.failpoint?.('after_quarantine_intent');
    return this.resumeQuarantineIntent(intent, layout);
  }

  private async resumeQuarantineIntent(
    intent: ManagedWorkspaceQuarantineIntent,
    layout: WorkspaceLayout,
  ): Promise<ManagedWorkspaceQuarantine> {
    await assertOwnedManagedWorkspaceLayout(this.input.storageRoot, layout);
    const { binding, reason, quarantinePath } = intent;
    assertQuarantineIntentMatches(intent, binding, reason, layout);
    const registration = findWorktreeRegistration(
      await this.runtime.run(
        ['--git-dir', binding.repositoryPath, 'worktree', 'list', '--porcelain'],
        layout.homePath,
      ),
      binding.worktreePath,
    );
    if (
      registration &&
      (registration.headOid !== binding.baselineCommitOid ||
        (registration.lockReason !== undefined &&
          registration.lockReason !== worktreeLockReason(binding)))
    ) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Quarantine worktree registration does not match its durable intent',
      );
    }
    if (registration?.lockReason !== undefined) {
      await this.runtime.run(
        ['--git-dir', binding.repositoryPath, 'worktree', 'unlock', binding.worktreePath],
        layout.homePath,
      );
    }
    await this.input.failpoint?.('after_quarantine_unlock');

    const sourceExists = await pathEntryExists(binding.worktreePath);
    const targetExists = await pathEntryExists(quarantinePath);
    if (sourceExists && targetExists) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Quarantine source and target both exist',
      );
    }
    if (sourceExists) {
      await ensureOwnedDirectory(layout.quarantineRoot, layout.managedRoot);
      await assertOwnedManagedWorkspaceLayout(this.input.storageRoot, layout);
      await rename(binding.worktreePath, quarantinePath);
    } else if (!targetExists) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Quarantine intent has neither a source worktree nor a target artifact',
      );
    }
    await assertOwnedDirectoryEntry(quarantinePath, layout.quarantineRoot, true);
    if (!samePath(await realpath(dirname(quarantinePath)), await realpath(layout.quarantineRoot))) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Quarantine target parent does not match the owned quarantine root',
      );
    }
    await this.input.failpoint?.('after_quarantine_move');

    const stored = await readBinding(layout.bindingPath);
    if (stored && !sameBinding(stored, binding)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Quarantine binding changed after its durable intent was recorded',
      );
    }
    await rm(layout.bindingPath, { force: true });
    await this.input.failpoint?.('after_quarantine_binding_removed');
    await this.runtime.run(
      ['--git-dir', binding.repositoryPath, 'worktree', 'prune', '--expire=now'],
      layout.homePath,
    );
    const remaining = findWorktreeRegistration(
      await this.runtime.run(
        ['--git-dir', binding.repositoryPath, 'worktree', 'list', '--porcelain'],
        layout.homePath,
      ),
      binding.worktreePath,
    );
    if (remaining) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Quarantine could not remove the managed worktree registration',
      );
    }
    await this.input.failpoint?.('after_quarantine_pruned');

    const record: ManagedWorkspaceQuarantineRecord = {
      protocol: 'maka_managed_workspace_quarantine_v1',
      reason,
      binding,
    };
    const existingRecord = await readQuarantineRecord(`${quarantinePath}.json`);
    if (existingRecord && !sameQuarantineRecord(existingRecord, record)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Quarantine record conflicts with its durable intent',
      );
    }
    if (!existingRecord) await atomicWriteJson(`${quarantinePath}.json`, record);
    return { quarantinePath, reason };
  }
}

class VerifiedGitRuntime {
  constructor(private readonly input: VerifiedGitRuntimeInput) {
    if (
      !isAbsolute(input.executablePath) ||
      !SHA256_PATTERN.test(input.expectedSha256) ||
      (input.distribution !== undefined && !SHA256_PATTERN.test(input.runtimeIdentitySha256 ?? ''))
    ) {
      throw new GitWorkspaceServiceError(
        'git_runtime_unavailable',
        'Managed workspace requires an absolute Git executable and SHA-256 digest',
      );
    }
    if (input.distribution) {
      const rootPath = input.distribution.rootPath;
      const executableRelativePath = relative(rootPath, input.executablePath);
      if (
        !isAbsolute(rootPath) ||
        executableRelativePath === '' ||
        executableRelativePath === '..' ||
        executableRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(executableRelativePath)
      ) {
        throw new GitWorkspaceServiceError(
          'git_runtime_unavailable',
          'Bundled Git executable must belong to its declared distribution root',
        );
      }
    }
  }

  verify(): Promise<{ executablePath: string; digest: `sha256:${string}` }> {
    return this.verifyOnce();
  }

  async run(
    args: readonly string[],
    homePath?: string,
    extraEnv?: NodeJS.ProcessEnv,
    acceptedExitCodes: readonly number[] = [],
  ): Promise<string> {
    const runtime = await this.verify();
    const hooksPath = homePath ? join(homePath, 'empty-hooks') : dirname(runtime.executablePath);
    if (homePath) {
      await mkdir(homePath, { recursive: true });
      await mkdir(hooksPath, { recursive: true });
    }
    const env = isolatedGitEnvironment(this.input, homePath ?? dirname(runtime.executablePath));
    try {
      const { stdout } = await execFileAsync(
        runtime.executablePath,
        [...fixedGitArguments(hooksPath), ...args],
        {
          cwd: homePath ?? dirname(runtime.executablePath),
          // Operation-scoped values (currently only deterministic commit
          // identity) cannot override the hermetic Git execution profile.
          env: { ...extraEnv, ...env },
          encoding: 'utf8',
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      return stdout;
    } catch (error) {
      if (acceptedExitCodes.includes(exitCode(error) ?? -1)) return '';
      throw error;
    }
  }

  async runBuffer(
    args: readonly string[],
    homePath?: string,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<Buffer> {
    const runtime = await this.verify();
    const hooksPath = homePath ? join(homePath, 'empty-hooks') : dirname(runtime.executablePath);
    if (homePath) {
      await mkdir(homePath, { recursive: true });
      await mkdir(hooksPath, { recursive: true });
    }
    const env = isolatedGitEnvironment(this.input, homePath ?? dirname(runtime.executablePath));
    const { stdout } = await execFileAsync(
      runtime.executablePath,
      [...fixedGitArguments(hooksPath), ...args],
      {
        cwd: homePath ?? dirname(runtime.executablePath),
        env: { ...extraEnv, ...env },
        encoding: 'buffer',
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return stdout;
  }

  async runWithInput(
    args: readonly string[],
    input: string | Buffer,
    homePath?: string,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<string> {
    const runtime = await this.verify();
    const hooksPath = homePath ? join(homePath, 'empty-hooks') : dirname(runtime.executablePath);
    if (homePath) {
      await mkdir(homePath, { recursive: true });
      await mkdir(hooksPath, { recursive: true });
    }
    const child = spawn(runtime.executablePath, [...fixedGitArguments(hooksPath), ...args], {
      cwd: homePath ?? dirname(runtime.executablePath),
      env: {
        ...extraEnv,
        ...isolatedGitEnvironment(this.input, homePath ?? dirname(runtime.executablePath)),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!child.stdin) {
      child.kill('SIGKILL');
      throw new Error('Git input process did not create stdin');
    }
    const stdout = collectBoundedOutput(child.stdout, GIT_MAX_BUFFER_BYTES);
    const stderr = collectBoundedStderr(child.stderr);
    const timeout = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
    child.stdin.end(input);
    try {
      const code = await waitForChildExit(child);
      const [output, errorOutput] = await Promise.all([stdout, stderr]);
      if (code !== 0) throw new Error(`Git command failed (${String(code)}): ${errorOutput}`);
      return output;
    } finally {
      clearTimeout(timeout);
    }
  }

  async runOptional(
    args: readonly string[],
    acceptedMissingExitCode: number,
  ): Promise<string | undefined> {
    try {
      return await this.run(args);
    } catch (error) {
      if (exitCode(error) === acceptedMissingExitCode) return undefined;
      throw error;
    }
  }

  async importTree(
    sourceRoot: string,
    treeOid: string,
    repositoryPath: string,
    homePath: string,
  ): Promise<void> {
    const packRuntime = await this.verify();
    const hooksPath = join(homePath, 'empty-hooks');
    await mkdir(hooksPath, { recursive: true });
    const fixed = fixedGitArguments(hooksPath);
    const pack = spawn(
      packRuntime.executablePath,
      [...fixed, '-C', sourceRoot, 'pack-objects', '--stdout', '--revs'],
      {
        cwd: homePath,
        env: isolatedGitEnvironment(this.input, homePath),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let indexRuntime: Awaited<ReturnType<VerifiedGitRuntime['verify']>>;
    try {
      // Each Git process is an independent trust decision. Re-check the
      // executable immediately before index-pack instead of extending the
      // pack-objects verification across a second invocation.
      indexRuntime = await this.verify();
    } catch (error) {
      pack.kill('SIGKILL');
      await waitForChildExit(pack).catch(() => undefined);
      throw error;
    }
    const index = spawn(
      indexRuntime.executablePath,
      [...fixed, '--git-dir', repositoryPath, 'index-pack', '--stdin', '--fix-thin'],
      {
        cwd: homePath,
        env: isolatedGitEnvironment(this.input, homePath),
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    if (!pack.stdin || !pack.stdout || !index.stdin) {
      pack.kill('SIGKILL');
      index.kill('SIGKILL');
      throw new Error('Git tree import did not create the required process pipes');
    }
    const packStderr = collectBoundedStderr(pack.stderr);
    const indexStderr = collectBoundedStderr(index.stderr);
    index.stdin.on('error', () => {
      // The index process exit status/stderr is the authoritative pipeline failure.
    });
    pack.stdout.pipe(index.stdin);
    pack.stdin.end(`${treeOid}\n`);
    const timeout = setTimeout(() => {
      pack.kill('SIGKILL');
      index.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);
    try {
      const [packCode, indexCode] = await Promise.all([
        waitForChildExit(pack),
        waitForChildExit(index),
      ]);
      if (packCode !== 0 || indexCode !== 0) {
        throw new Error(
          `Git tree import failed: pack=${packCode} index=${indexCode} ` +
            `${await packStderr} ${await indexStderr}`,
        );
      }
    } catch (error) {
      pack.kill('SIGKILL');
      index.kill('SIGKILL');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async verifyOnce(): Promise<{
    executablePath: string;
    digest: `sha256:${string}`;
  }> {
    try {
      const executablePath = normalize(await realpath(this.input.executablePath));
      const info = await stat(executablePath);
      if (!info.isFile()) throw new Error('not a regular file');
      const executableDigest = await sha256File(executablePath);
      if (executableDigest !== this.input.expectedSha256) {
        throw new GitWorkspaceServiceError(
          'git_runtime_integrity_mismatch',
          `Git executable digest mismatch: ${executablePath}`,
        );
      }
      return {
        executablePath,
        digest: this.input.runtimeIdentitySha256 ?? executableDigest,
      };
    } catch (error) {
      if (error instanceof GitWorkspaceServiceError) throw error;
      throw new GitWorkspaceServiceError(
        'git_runtime_unavailable',
        `Git runtime is unavailable: ${this.input.executablePath}`,
        { cause: error },
      );
    }
  }
}

function workspaceLayout(
  canonicalStorageRoot: string,
  identity: Pick<
    ManagedWorkspaceIdentity,
    'repositoryId' | 'workspaceId' | 'workspaceEpochId' | 'workspaceInstanceId'
  >,
): WorkspaceLayout {
  const managedRoot = join(canonicalStorageRoot, 'managed-workspaces');
  const quarantineIntentRoot = join(managedRoot, 'quarantine-intents');
  const repositoryRoot = join(managedRoot, 'r', compactIdentity(identity.repositoryId));
  const epochRoot = join(
    managedRoot,
    'w',
    compactIdentity(identity.workspaceId),
    'e',
    compactIdentity(identity.workspaceEpochId),
  );
  const instanceRoot = join(epochRoot, 'i', compactIdentity(identity.workspaceInstanceId));
  return {
    managedRoot,
    repositoryRoot,
    repositoryPath: join(repositoryRoot, 'repository.git'),
    repositoryRecordPath: join(repositoryRoot, 'repository.json'),
    hooksPath: join(repositoryRoot, 'hooks'),
    homePath: join(managedRoot, 'git-home'),
    epochRoot,
    epochArtifactPath: join(epochRoot, 'epoch.json'),
    instanceRoot,
    bindingPath: join(instanceRoot, 'binding.json'),
    baselineReceiptPath: join(instanceRoot, 'baseline-receipt.json'),
    mutationCandidateRoot: join(instanceRoot, 'mutation-candidates'),
    // Projection worktrees live directly below the managed root so Git for
    // Windows can create its per-worktree gitdir within the platform path
    // budget. Full operation identity remains in the durable intent/receipt;
    // these compact paths are carriers, not authority.
    projectionStagingRoot: join(managedRoot, 'p'),
    projectionQuarantineRoot: join(managedRoot, 'q'),
    worktreePath: join(instanceRoot, 'worktree'),
    quarantineRoot: join(managedRoot, 'quarantine'),
    quarantineIntentRoot,
    quarantineIntentPath: join(
      quarantineIntentRoot,
      `${compactIdentity(identity.workspaceInstanceId)}.json`,
    ),
  };
}

function mutationProjectionPaths(layout: WorkspaceLayout, digest: string) {
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Invalid managed mutation projection identity',
    );
  }
  const compactDigest = digest.slice(0, 20);
  return {
    intentPath: join(layout.mutationCandidateRoot, `${digest}.projection.json`),
    stagingPath: join(layout.projectionStagingRoot, compactDigest),
    previousPath: join(layout.projectionQuarantineRoot, compactDigest),
  } as const;
}

function assertOpenIdentity(input: ManagedWorkspaceIdentity): void {
  for (const [name, value] of Object.entries({
    repositoryId: input.repositoryId,
    workspaceId: input.workspaceId,
    workspaceEpochId: input.workspaceEpochId,
    workspaceInstanceId: input.workspaceInstanceId,
  })) {
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Invalid ${name}: ${value}`,
      );
    }
  }
}

function assertBindingShape(value: unknown): asserts value is ManagedWorkspaceBinding {
  if (!isBinding(value)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Invalid managed workspace binding',
    );
  }
}

function assertBindingMatches(
  binding: ManagedWorkspaceBinding,
  input: CreateManagedWorkspaceFromSourceInput,
  layout: WorkspaceLayout,
  runtimeDigest: `sha256:${string}`,
): void {
  assertBindingIdentity(binding, input, layout, runtimeDigest);
  if (!samePath(binding.sourceRoot, input.sourceRoot)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace binding does not match the requested source provenance',
    );
  }
}

function assertBindingIdentity(
  binding: ManagedWorkspaceBinding,
  input: ManagedWorkspaceIdentity,
  layout: WorkspaceLayout,
  runtimeDigest: `sha256:${string}`,
): void {
  assertBindingShape(binding);
  assertBindingPaths(binding, layout);
  if (
    binding.repositoryId !== input.repositoryId ||
    binding.workspaceId !== input.workspaceId ||
    binding.workspaceEpochId !== input.workspaceEpochId ||
    binding.workspaceInstanceId !== input.workspaceInstanceId ||
    binding.gitRuntimeSha256 !== runtimeDigest ||
    binding.materializationProfileDigest !==
      materializationProfileDigest(runtimeDigest, binding.objectFormat) ||
    binding.headRef !== managedHeadRef(input.workspaceId, input.workspaceEpochId)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace binding does not match the requested managed identity',
    );
  }
}

function assertBindingRepository(
  binding: ManagedWorkspaceBinding,
  repository: ManagedRepositoryRecord,
): void {
  if (
    binding.repositoryId !== repository.repositoryId ||
    !samePath(binding.repositoryPath, repository.repositoryPath) ||
    !samePath(binding.hooksPath, repository.hooksPath) ||
    binding.gitRuntimeSha256 !== repository.gitRuntimeSha256 ||
    binding.objectFormat !== repository.objectFormat ||
    repository.repositoryCapabilityDigest !==
      repositoryCapabilityDigest(repository.gitRuntimeSha256, repository.objectFormat)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace binding does not match its Git repository record',
    );
  }
}

function assertBindingEpoch(
  binding: ManagedWorkspaceBinding,
  epoch: ManagedWorkspaceEpochArtifact,
): void {
  if (
    binding.repositoryId !== epoch.repositoryId ||
    binding.workspaceId !== epoch.workspaceId ||
    binding.workspaceEpochId !== epoch.workspaceEpochId ||
    !samePath(binding.sourceRoot, epoch.sourceRoot) ||
    !samePath(binding.sourceGitCommonDir, epoch.sourceGitCommonDir) ||
    binding.sourceHeadCommitOid !== epoch.sourceHeadCommitOid ||
    binding.sourceTreeOid !== epoch.sourceTreeOid ||
    binding.baselineCommitOid !== epoch.baselineCommitOid ||
    binding.baselineTreeOid !== epoch.baselineTreeOid ||
    binding.headRef !== epoch.headRef ||
    binding.materializationProfileDigest !== epoch.materializationProfileDigest
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace binding does not match its epoch artifact',
    );
  }
}

function assertBindingPaths(binding: ManagedWorkspaceBinding, layout: WorkspaceLayout): void {
  if (
    !samePath(binding.repositoryPath, layout.repositoryPath) ||
    !samePath(binding.worktreePath, layout.worktreePath) ||
    !samePath(binding.hooksPath, layout.hooksPath)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace binding escapes its owned storage namespace',
    );
  }
}

function assertRepositoryMatches(
  record: ManagedRepositoryRecord,
  input: CreateManagedWorkspaceFromSourceInput,
  objectFormat: string,
  layout: WorkspaceLayout,
  runtimeDigest: `sha256:${string}`,
): void {
  if (
    record.repositoryId !== input.repositoryId ||
    record.gitRuntimeSha256 !== runtimeDigest ||
    record.objectFormat !== objectFormat ||
    record.repositoryCapabilityDigest !== repositoryCapabilityDigest(runtimeDigest, objectFormat) ||
    !samePath(record.repositoryPath, layout.repositoryPath) ||
    !samePath(record.hooksPath, layout.hooksPath)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed Git repository does not match the requested repository capability',
    );
  }
}

async function readBinding(path: string): Promise<ManagedWorkspaceBinding | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  assertBindingShape(value);
  return value;
}

async function readBaselineReceipt(
  path: string,
): Promise<ManagedWorkspaceBaselineReceiptV1 | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  assertBaselineReceiptShape(value);
  return value;
}

async function readMutationCandidateReceipt(
  path: string,
): Promise<ManagedMutationCandidateReceiptV1 | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  assertMutationCandidateReceipt(value);
  return value;
}

async function readMutationCandidateDiscardIntent(
  path: string,
): Promise<ManagedMutationCandidateDiscardIntentV1 | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'protocol', 'receipt']) ||
    value.schemaVersion !== MUTATION_CANDIDATE_DISCARD_INTENT_SCHEMA_VERSION ||
    value.protocol !== 'maka_managed_mutation_candidate_discard_v1' ||
    !isMutationCandidateReceipt(value.receipt)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Invalid managed mutation candidate discard intent',
    );
  }
  return {
    schemaVersion: 1,
    protocol: 'maka_managed_mutation_candidate_discard_v1',
    receipt: value.receipt,
  };
}

async function readMutationProjectionIntent(
  path: string,
): Promise<ManagedMutationProjectionIntentV2 | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'protocol', 'receipt', 'previousWorktreeIdentity']) ||
    value.schemaVersion !== 2 ||
    value.protocol !== 'maka_managed_mutation_projection_v2' ||
    !isMutationCandidateReceipt(value.receipt) ||
    !isOwnedDirectoryIdentity(value.previousWorktreeIdentity)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Invalid managed mutation projection intent',
    );
  }
  return {
    schemaVersion: 2,
    protocol: 'maka_managed_mutation_projection_v2',
    receipt: value.receipt,
    previousWorktreeIdentity: value.previousWorktreeIdentity,
  };
}

function assertMutationProjectionIntent(
  intent: ManagedMutationProjectionIntentV2,
  receipt: ManagedMutationCandidateReceiptV1,
): void {
  if (!isDeepStrictEqual(intent.receipt, receipt)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed mutation projection intent changed identity',
    );
  }
}

function isOwnedDirectoryIdentity(value: unknown): value is OwnedDirectoryIdentityV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['device', 'inode']) &&
    typeof value.device === 'string' &&
    /^\d+$/u.test(value.device) &&
    typeof value.inode === 'string' &&
    /^\d+$/u.test(value.inode)
  );
}

async function readOwnedDirectoryIdentity(path: string): Promise<OwnedDirectoryIdentityV1> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('not one regular non-symlink directory entry');
    }
    return {
      device: info.dev.toString(10),
      inode: info.ino.toString(10),
    };
  } catch (error) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Managed mutation projection directory changed identity: ${path}`,
      { cause: error },
    );
  }
}

async function assertOwnedDirectoryIdentity(
  path: string,
  expected: OwnedDirectoryIdentityV1,
): Promise<void> {
  const actual = await readOwnedDirectoryIdentity(path);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Managed mutation projection directory changed identity: ${path}`,
    );
  }
}

async function readRepositoryRecord(path: string): Promise<ManagedRepositoryRecord | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  if (!isRepositoryRecord(value)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Invalid managed Git repository record: ${path}`,
    );
  }
  return value;
}

function assertEpochArtifactMatches(
  artifact: ManagedWorkspaceEpochArtifact,
  input: CreateManagedWorkspaceFromSourceInput,
  source: SourceRepositoryInspection,
  repository: ManagedRepositoryRecord,
): void {
  if (
    artifact.repositoryId !== input.repositoryId ||
    artifact.workspaceId !== input.workspaceId ||
    artifact.workspaceEpochId !== input.workspaceEpochId ||
    !samePath(artifact.sourceRoot, source.sourceRoot) ||
    !samePath(artifact.sourceGitCommonDir, source.gitCommonDir) ||
    artifact.sourceHeadCommitOid !== source.headCommitOid ||
    artifact.sourceTreeOid !== source.treeOid ||
    artifact.baselineTreeOid !== source.treeOid ||
    artifact.gitRuntimeSha256 !== repository.gitRuntimeSha256 ||
    artifact.objectFormat !== repository.objectFormat
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace epoch artifact does not match the requested source boundary',
    );
  }
}

function assertSameSourceObservation(
  captured: SourceRepositoryInspection,
  current: SourceRepositoryInspection,
): void {
  if (
    !samePath(captured.sourceRoot, current.sourceRoot) ||
    !samePath(captured.gitCommonDir, current.gitCommonDir) ||
    captured.headCommitOid !== current.headCommitOid ||
    captured.treeOid !== current.treeOid ||
    captured.objectFormat !== current.objectFormat
  ) {
    throw new GitWorkspaceServiceError(
      'source_changed_during_baseline_import',
      'Managed workspace source changed while the baseline was being imported',
    );
  }
}

async function readEpochArtifact(path: string): Promise<ManagedWorkspaceEpochArtifact | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  if (!isEpochArtifact(value)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Invalid managed workspace epoch artifact: ${path}`,
    );
  }
  return value;
}

async function readQuarantineIntent(
  path: string,
): Promise<ManagedWorkspaceQuarantineIntent | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  if (!isQuarantineIntent(value)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Invalid managed workspace quarantine intent: ${path}`,
    );
  }
  return value;
}

async function readQuarantineRecord(
  path: string,
): Promise<ManagedWorkspaceQuarantineRecord | undefined> {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  if (!isQuarantineRecord(value)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Invalid managed workspace quarantine record: ${path}`,
    );
  }
  return value;
}

function assertQuarantineIntentMatches(
  intent: ManagedWorkspaceQuarantineIntent,
  binding: ManagedWorkspaceBinding,
  reason: string,
  layout: WorkspaceLayout,
): void {
  assertBindingShape(intent.binding);
  assertBindingPaths(intent.binding, layout);
  if (
    !sameBinding(intent.binding, binding) ||
    intent.reason !== reason ||
    !isPathWithin(intent.quarantinePath, layout.quarantineRoot) ||
    !samePath(dirname(intent.quarantinePath), layout.quarantineRoot)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace quarantine intent does not match its binding or owned namespace',
    );
  }
}

function isBinding(value: unknown): value is ManagedWorkspaceBinding {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, BINDING_KEYS) &&
    value.schemaVersion === BINDING_SCHEMA_VERSION &&
    value.protocol === 'git_managed_workspace_v1' &&
    typeof value.repositoryId === 'string' &&
    IDENTIFIER_PATTERN.test(value.repositoryId) &&
    typeof value.workspaceId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceId) &&
    typeof value.workspaceEpochId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceEpochId) &&
    typeof value.workspaceInstanceId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceInstanceId) &&
    typeof value.sourceRoot === 'string' &&
    isAbsolute(value.sourceRoot) &&
    typeof value.sourceGitCommonDir === 'string' &&
    isAbsolute(value.sourceGitCommonDir) &&
    typeof value.sourceHeadCommitOid === 'string' &&
    OID_PATTERN.test(value.sourceHeadCommitOid) &&
    typeof value.sourceTreeOid === 'string' &&
    OID_PATTERN.test(value.sourceTreeOid) &&
    typeof value.repositoryPath === 'string' &&
    isAbsolute(value.repositoryPath) &&
    typeof value.worktreePath === 'string' &&
    isAbsolute(value.worktreePath) &&
    typeof value.hooksPath === 'string' &&
    isAbsolute(value.hooksPath) &&
    typeof value.baselineCommitOid === 'string' &&
    OID_PATTERN.test(value.baselineCommitOid) &&
    typeof value.baselineTreeOid === 'string' &&
    OID_PATTERN.test(value.baselineTreeOid) &&
    typeof value.headRef === 'string' &&
    value.headRef === managedHeadRef(value.workspaceId, value.workspaceEpochId) &&
    typeof value.gitRuntimeSha256 === 'string' &&
    SHA256_PATTERN.test(value.gitRuntimeSha256) &&
    (value.objectFormat === 'sha1' || value.objectFormat === 'sha256') &&
    typeof value.materializationProfileDigest === 'string' &&
    SHA256_PATTERN.test(value.materializationProfileDigest) &&
    value.materializationSemantics === MATERIALIZATION_SEMANTICS
  );
}

function assertBaselineReceiptShape(
  value: unknown,
): asserts value is ManagedWorkspaceBaselineReceiptV1 {
  if (!isBaselineReceipt(value)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Invalid managed workspace baseline receipt',
    );
  }
}

function isBaselineReceipt(value: unknown): value is ManagedWorkspaceBaselineReceiptV1 {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, BASELINE_RECEIPT_KEYS) &&
    value.schemaVersion === BASELINE_RECEIPT_SCHEMA_VERSION &&
    value.protocol === 'maka_managed_workspace_baseline_receipt_v1' &&
    isBinding(value.binding) &&
    typeof value.workspaceVersionId === 'string' &&
    /^version_[a-f0-9]{32}$/u.test(value.workspaceVersionId) &&
    value.policyVersion === 1 &&
    typeof value.policyHash === 'string' &&
    SHA256_PATTERN.test(value.policyHash) &&
    typeof value.epochOpenedEventId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value.epochOpenedEventId) &&
    typeof value.baselineAcceptedEventId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value.baselineAcceptedEventId) &&
    value.epochOpenedEventId !== value.baselineAcceptedEventId &&
    typeof value.treeDeltaDigest === 'string' &&
    SHA256_PATTERN.test(value.treeDeltaDigest) &&
    typeof value.changedFileCount === 'number' &&
    Number.isSafeInteger(value.changedFileCount) &&
    value.changedFileCount >= 0 &&
    value.deletedFileCount === 0
  );
}

function assertBaselineReceiptMatches(
  receipt: ManagedWorkspaceBaselineReceiptV1,
  binding: ManagedWorkspaceBinding,
  summary: BaselineTreeSummary,
): void {
  const identities = deriveBaselineReceiptIdentities(binding);
  if (
    !sameBinding(receipt.binding, binding) ||
    receipt.workspaceVersionId !== identities.workspaceVersionId ||
    receipt.epochOpenedEventId !== identities.epochOpenedEventId ||
    receipt.baselineAcceptedEventId !== identities.baselineAcceptedEventId ||
    receipt.policyVersion !== 1 ||
    receipt.policyHash !== MANAGED_BASELINE_POLICY_HASH_V1 ||
    receipt.treeDeltaDigest !== summary.treeDeltaDigest ||
    receipt.changedFileCount !== summary.changedFileCount ||
    receipt.deletedFileCount !== 0
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace baseline receipt does not match its verified Git boundary',
    );
  }
}

function assertMutationCandidateRequest(request: ManagedMutationCandidateRequest): void {
  if (
    !isRecord(request) ||
    !hasExactKeys(request, [
      'binding',
      'operationId',
      'baseHead',
      'expectedPaths',
      'expectedBlobOid',
      'expectedContent',
      'executionProfileDigest',
    ])
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Invalid managed mutation candidate request envelope',
    );
  }
  assertBindingShape(request.binding);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(request.operationId) ||
    !SHA256_PATTERN.test(request.executionProfileDigest) ||
    (request.expectedBlobOid !== null &&
      !oidMatchesObjectFormat(request.expectedBlobOid, request.binding.objectFormat)) ||
    (request.expectedContent !== null && typeof request.expectedContent !== 'string') ||
    (request.expectedBlobOid === null) !== (request.expectedContent === null) ||
    (request.expectedContent !== null &&
      request.expectedBlobOid !==
        gitBlobOid(request.expectedContent, request.binding.objectFormat)) ||
    !isWorkspaceHeadRecord(request.baseHead) ||
    request.expectedPaths.length !== 1
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Invalid managed mutation candidate request',
    );
  }
  const paths = request.expectedPaths.map(assertManagedMutationPath);
  if (new Set(paths).size !== paths.length || !isDeepStrictEqual(paths, request.expectedPaths)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed mutation candidate paths must be unique canonical Git paths',
    );
  }
}

function snapshotMutationCandidateRequest(
  input: ManagedMutationCandidateRequest,
): ManagedMutationCandidateRequest {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(input);
  } catch (error) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed mutation candidate request cannot be snapshotted',
      { cause: error },
    );
  }
  assertMutationCandidateRequest(snapshot as ManagedMutationCandidateRequest);
  return snapshot as ManagedMutationCandidateRequest;
}

function assertCandidateBaseMatches(
  binding: ManagedWorkspaceBinding,
  baselineReceipt: ManagedWorkspaceBaselineReceiptV1,
  baseHead: ManagedMutationCandidateRequest['baseHead'],
): void {
  if (
    baseHead.repositoryId !== binding.repositoryId ||
    baseHead.workspaceId !== binding.workspaceId ||
    baseHead.workspaceEpochId !== binding.workspaceEpochId ||
    !oidMatchesObjectFormat(baseHead.commitOid, binding.objectFormat) ||
    !oidMatchesObjectFormat(baseHead.treeOid, binding.objectFormat) ||
    (baseHead.commitOid === binding.baselineCommitOid &&
      (baseHead.workspaceVersionId !== baselineReceipt.workspaceVersionId ||
        baseHead.acceptedEventId !== baselineReceipt.baselineAcceptedEventId ||
        baseHead.treeOid !== binding.baselineTreeOid ||
        baseHead.revision !== 1))
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed mutation base does not match its workspace authority',
    );
  }
}

function assertMutationCandidateReceipt(
  value: unknown,
): asserts value is ManagedMutationCandidateReceiptV1 {
  if (!isMutationCandidateReceipt(value)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Invalid managed mutation candidate receipt',
    );
  }
}

function snapshotMutationCandidateReceipt(
  input: ManagedMutationCandidateReceiptV1,
): ManagedMutationCandidateReceiptV1 {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(input);
  } catch (error) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed mutation candidate receipt cannot be snapshotted',
      { cause: error },
    );
  }
  assertMutationCandidateReceipt(snapshot);
  return snapshot;
}

function isMutationCandidateReceipt(value: unknown): value is ManagedMutationCandidateReceiptV1 {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, MUTATION_CANDIDATE_RECEIPT_KEYS) &&
    value.schemaVersion === MUTATION_CANDIDATE_RECEIPT_SCHEMA_VERSION &&
    value.protocol === 'maka_managed_mutation_candidate_v1' &&
    typeof value.repositoryId === 'string' &&
    IDENTIFIER_PATTERN.test(value.repositoryId) &&
    typeof value.workspaceId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceId) &&
    typeof value.workspaceEpochId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceEpochId) &&
    typeof value.workspaceInstanceId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceInstanceId) &&
    typeof value.operationId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value.operationId) &&
    isWorkspaceHeadRecord(value.baseHead) &&
    value.baseHead.repositoryId === value.repositoryId &&
    value.baseHead.workspaceId === value.workspaceId &&
    value.baseHead.workspaceEpochId === value.workspaceEpochId &&
    typeof value.candidateRef === 'string' &&
    value.candidateRef ===
      mutationCandidateIdentity(value.operationId, value.workspaceEpochId).ref &&
    typeof value.candidateCommitOid === 'string' &&
    OID_PATTERN.test(value.candidateCommitOid) &&
    typeof value.candidateTreeOid === 'string' &&
    OID_PATTERN.test(value.candidateTreeOid) &&
    typeof value.gitRuntimeSha256 === 'string' &&
    SHA256_PATTERN.test(value.gitRuntimeSha256) &&
    (value.objectFormat === 'sha1' || value.objectFormat === 'sha256') &&
    oidMatchesObjectFormat(value.baseHead.commitOid, value.objectFormat) &&
    oidMatchesObjectFormat(value.baseHead.treeOid, value.objectFormat) &&
    oidMatchesObjectFormat(value.candidateCommitOid, value.objectFormat) &&
    oidMatchesObjectFormat(value.candidateTreeOid, value.objectFormat) &&
    typeof value.materializationProfileDigest === 'string' &&
    SHA256_PATTERN.test(value.materializationProfileDigest) &&
    typeof value.workspacePolicyHash === 'string' &&
    SHA256_PATTERN.test(value.workspacePolicyHash) &&
    value.candidatePolicyHash === MUTATION_CANDIDATE_POLICY_HASH_V1 &&
    typeof value.treeDeltaDigest === 'string' &&
    SHA256_PATTERN.test(value.treeDeltaDigest) &&
    isCanonicalPathArray(value.changedPaths, false) &&
    value.changedPaths.length === 1 &&
    isCanonicalPathArray(value.deletedPaths, true) &&
    isPathSubset(value.deletedPaths, value.changedPaths) &&
    (value.expectedBlobOid === null ||
      (typeof value.expectedBlobOid === 'string' &&
        oidMatchesObjectFormat(value.expectedBlobOid, value.objectFormat))) &&
    typeof value.executionProfileDigest === 'string' &&
    SHA256_PATTERN.test(value.executionProfileDigest)
  );
}

function assertMutationCandidateReceiptMatches(
  receipt: ManagedMutationCandidateReceiptV1,
  request: ManagedMutationCandidateIdentityRequest,
  candidateRef: string,
  workspacePolicyHash: `sha256:${string}`,
): void {
  assertMutationCandidateReceipt(receipt);
  if (
    receipt.repositoryId !== request.binding.repositoryId ||
    receipt.workspaceId !== request.binding.workspaceId ||
    receipt.workspaceEpochId !== request.binding.workspaceEpochId ||
    receipt.workspaceInstanceId !== request.binding.workspaceInstanceId ||
    receipt.operationId !== request.operationId ||
    receipt.candidateRef !== candidateRef ||
    receipt.gitRuntimeSha256 !== request.binding.gitRuntimeSha256 ||
    receipt.objectFormat !== request.binding.objectFormat ||
    receipt.materializationProfileDigest !== request.binding.materializationProfileDigest ||
    receipt.workspacePolicyHash !== workspacePolicyHash ||
    !isDeepStrictEqual(receipt.baseHead, request.baseHead) ||
    !sameStringSet(receipt.changedPaths, request.expectedPaths) ||
    receipt.expectedBlobOid !== request.expectedBlobOid ||
    receipt.executionProfileDigest !== request.executionProfileDigest
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed mutation candidate receipt conflicts with its request',
    );
  }
}

function gitBlobOid(content: string, objectFormat: 'sha1' | 'sha256'): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash(objectFormat)
    .update(`blob ${bytes.byteLength}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

function isWorkspaceHeadRecord(
  value: unknown,
): value is ManagedMutationCandidateRequest['baseHead'] {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      'repositoryId',
      'workspaceId',
      'workspaceEpochId',
      'workspaceVersionId',
      'acceptedEventId',
      'commitOid',
      'treeOid',
      'revision',
    ]) &&
    typeof value.repositoryId === 'string' &&
    IDENTIFIER_PATTERN.test(value.repositoryId) &&
    typeof value.workspaceId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceId) &&
    typeof value.workspaceEpochId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceEpochId) &&
    typeof value.workspaceVersionId === 'string' &&
    /^version_[A-Za-z0-9_-]{1,120}$/u.test(value.workspaceVersionId) &&
    typeof value.acceptedEventId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value.acceptedEventId) &&
    typeof value.commitOid === 'string' &&
    OID_PATTERN.test(value.commitOid) &&
    typeof value.treeOid === 'string' &&
    OID_PATTERN.test(value.treeOid) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0
  );
}

function isCanonicalPathArray(value: unknown, allowEmpty: boolean): value is readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 32)
    return false;
  if (!value.every((path) => typeof path === 'string')) return false;
  try {
    const paths = value.map(assertManagedTrackedPath);
    return new Set(paths).size === paths.length && isDeepStrictEqual(paths, value);
  } catch {
    return false;
  }
}

function isPathSubset(subset: readonly string[], superset: readonly string[]): boolean {
  return subset.every((path) => superset.includes(path));
}

function oidMatchesObjectFormat(value: string, objectFormat: 'sha1' | 'sha256'): boolean {
  return value.length === (objectFormat === 'sha256' ? 64 : 40) && /^[a-f0-9]+$/u.test(value);
}

function deriveBaselineReceiptIdentities(binding: ManagedWorkspaceBinding): {
  readonly workspaceVersionId: string;
  readonly epochOpenedEventId: string;
  readonly baselineAcceptedEventId: string;
} {
  const identity = {
    repositoryId: binding.repositoryId,
    workspaceId: binding.workspaceId,
    workspaceEpochId: binding.workspaceEpochId,
    workspaceInstanceId: binding.workspaceInstanceId,
    baselineCommitOid: binding.baselineCommitOid,
    baselineTreeOid: binding.baselineTreeOid,
    policyVersion: 1,
    policyHash: MANAGED_BASELINE_POLICY_HASH_V1,
  } as const;
  const derive = (purpose: string): string =>
    createHash('sha256')
      .update(
        JSON.stringify({
          protocol: 'maka_managed_workspace_baseline_identity_v1',
          purpose,
          identity,
        }),
      )
      .digest('hex');
  return {
    workspaceVersionId: `version_${derive('workspace_version').slice(0, 32)}`,
    epochOpenedEventId: `workspace_epoch_opened_${derive('epoch_opened').slice(0, 64)}`,
    baselineAcceptedEventId: `workspace_baseline_accepted_${derive('baseline_accepted').slice(0, 64)}`,
  };
}

function hashCanonicalJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function isRepositoryRecord(value: unknown): value is ManagedRepositoryRecord {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, REPOSITORY_KEYS) &&
    value.schemaVersion === REPOSITORY_SCHEMA_VERSION &&
    value.protocol === 'maka_managed_git_repository_v1' &&
    typeof value.repositoryId === 'string' &&
    IDENTIFIER_PATTERN.test(value.repositoryId) &&
    typeof value.repositoryPath === 'string' &&
    isAbsolute(value.repositoryPath) &&
    typeof value.hooksPath === 'string' &&
    isAbsolute(value.hooksPath) &&
    typeof value.gitRuntimeSha256 === 'string' &&
    SHA256_PATTERN.test(value.gitRuntimeSha256) &&
    (value.objectFormat === 'sha1' || value.objectFormat === 'sha256') &&
    typeof value.repositoryCapabilityDigest === 'string' &&
    SHA256_PATTERN.test(value.repositoryCapabilityDigest)
  );
}

function isEpochArtifact(value: unknown): value is ManagedWorkspaceEpochArtifact {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, EPOCH_ARTIFACT_KEYS) &&
    value.schemaVersion === EPOCH_ARTIFACT_SCHEMA_VERSION &&
    value.protocol === 'maka_managed_workspace_epoch_artifact_v1' &&
    typeof value.repositoryId === 'string' &&
    IDENTIFIER_PATTERN.test(value.repositoryId) &&
    typeof value.workspaceId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceId) &&
    typeof value.workspaceEpochId === 'string' &&
    IDENTIFIER_PATTERN.test(value.workspaceEpochId) &&
    typeof value.sourceRoot === 'string' &&
    isAbsolute(value.sourceRoot) &&
    typeof value.sourceGitCommonDir === 'string' &&
    isAbsolute(value.sourceGitCommonDir) &&
    typeof value.sourceHeadCommitOid === 'string' &&
    OID_PATTERN.test(value.sourceHeadCommitOid) &&
    typeof value.sourceTreeOid === 'string' &&
    OID_PATTERN.test(value.sourceTreeOid) &&
    typeof value.baselineCommitOid === 'string' &&
    OID_PATTERN.test(value.baselineCommitOid) &&
    typeof value.baselineTreeOid === 'string' &&
    OID_PATTERN.test(value.baselineTreeOid) &&
    value.baselineRef === managedBaselineRef(value.workspaceEpochId) &&
    value.headRef === managedHeadRef(value.workspaceId, value.workspaceEpochId) &&
    typeof value.gitRuntimeSha256 === 'string' &&
    SHA256_PATTERN.test(value.gitRuntimeSha256) &&
    (value.objectFormat === 'sha1' || value.objectFormat === 'sha256') &&
    typeof value.materializationProfileDigest === 'string' &&
    SHA256_PATTERN.test(value.materializationProfileDigest) &&
    value.materializationSemantics === MATERIALIZATION_SEMANTICS
  );
}

function isQuarantineIntent(value: unknown): value is ManagedWorkspaceQuarantineIntent {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, QUARANTINE_INTENT_KEYS) &&
    value.schemaVersion === QUARANTINE_INTENT_SCHEMA_VERSION &&
    value.protocol === 'maka_managed_workspace_quarantine_intent_v1' &&
    typeof value.reason === 'string' &&
    value.reason.length > 0 &&
    typeof value.quarantinePath === 'string' &&
    isAbsolute(value.quarantinePath) &&
    isBinding(value.binding)
  );
}

function isQuarantineRecord(value: unknown): value is ManagedWorkspaceQuarantineRecord {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, QUARANTINE_RECORD_KEYS) &&
    value.protocol === 'maka_managed_workspace_quarantine_v1' &&
    typeof value.reason === 'string' &&
    value.reason.length > 0 &&
    isBinding(value.binding)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
}

function sameBinding(left: ManagedWorkspaceBinding, right: ManagedWorkspaceBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBaselineReceipt(
  left: ManagedWorkspaceBaselineReceiptV1,
  right: ManagedWorkspaceBaselineReceiptV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameQuarantineRecord(
  left: ManagedWorkspaceQuarantineRecord,
  right: ManagedWorkspaceQuarantineRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('control record is not one regular non-symlink file');
    }
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Invalid managed workspace control record: ${path}`,
      { cause: error },
    );
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    const file = await openFile(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    if (process.platform !== 'win32') {
      const directory = await openFile(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function moveToQuarantine(
  source: string,
  quarantineRoot: string,
  label: string,
): Promise<string> {
  await mkdir(quarantineRoot, { recursive: true });
  const target = join(quarantineRoot, `${sanitizeReason(label)}-${Date.now()}-${randomUUID()}`);
  await rename(source, target);
  return target;
}

async function canonicalDirectory(
  path: string,
  code: GitWorkspaceServiceErrorCode,
): Promise<string> {
  try {
    const canonical = normalize(await realpath(path));
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch (error) {
    throw new GitWorkspaceServiceError(code, `Directory is unavailable: ${path}`, { cause: error });
  }
}

async function ensureOwnedDirectory(path: string, ownerRoot: string): Promise<void> {
  const requested = normalize(resolve(path));
  const canonicalOwner = normalize(await realpath(ownerRoot));
  const relation = relative(normalize(resolve(ownerRoot)), requested);
  if (relation.startsWith('..') || isAbsolute(relation)) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Managed workspace control path escapes its owner root: ${path}`,
    );
  }
  let current = normalize(resolve(ownerRoot));
  for (const segment of relation.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    const canonical = normalize(await realpath(current));
    if (!info.isDirectory() || info.isSymbolicLink() || !isPathWithin(canonical, canonicalOwner)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Managed workspace control path is not one owned directory: ${current}`,
      );
    }
  }
}

async function assertOwnedManagedWorkspaceLayout(
  storageRoot: string,
  layout: WorkspaceLayout,
): Promise<void> {
  const canonicalStorageRoot = normalize(await realpath(storageRoot));
  await assertOwnedDirectoryEntry(layout.managedRoot, canonicalStorageRoot, true);
  await assertOwnedDirectoryEntry(layout.quarantineRoot, layout.managedRoot, true);
  await assertOwnedDirectoryEntry(layout.homePath, layout.managedRoot, true);
  await assertOwnedDirectoryEntry(layout.quarantineIntentRoot, layout.managedRoot, false);
  await assertOwnedDirectoryEntry(layout.repositoryRoot, layout.managedRoot, false);
  await assertOwnedDirectoryEntry(layout.repositoryPath, layout.repositoryRoot, false);
  await assertOwnedDirectoryEntry(layout.hooksPath, layout.repositoryRoot, false);
  await assertOwnedDirectoryEntry(layout.epochRoot, layout.managedRoot, false);
  await assertOwnedDirectoryEntry(layout.instanceRoot, layout.epochRoot, false);
  await assertOwnedDirectoryEntry(layout.worktreePath, layout.instanceRoot, false);
  await assertOwnedDirectoryEntry(layout.mutationCandidateRoot, layout.instanceRoot, false);
  await assertOwnedDirectoryEntry(layout.projectionStagingRoot, layout.managedRoot, false);
  await assertOwnedDirectoryEntry(layout.projectionQuarantineRoot, layout.managedRoot, false);
}

async function assertOwnedDirectoryEntry(
  path: string,
  ownerRoot: string,
  required: boolean,
): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Managed workspace owned directory is unavailable: ${path}`,
      { cause: error },
    );
  }
  let canonicalOwner: string;
  let canonicalPath: string;
  try {
    canonicalOwner = normalize(await realpath(ownerRoot));
    canonicalPath = normalize(await realpath(path));
  } catch (error) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Managed workspace owned directory cannot be canonicalized: ${path}`,
      { cause: error },
    );
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !isPathWithin(canonicalPath, canonicalOwner)
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      `Managed workspace owned directory escaped or changed identity: ${path}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function removeOwnedCandidateTemporaryFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        `Managed mutation temporary index changed identity: ${path}`,
      );
    }
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function isNonSymlinkDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function resolveGitPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(resolve(left));
  const normalizedRight = normalize(resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPathWithin(path: string, root: string): boolean {
  const candidate = normalize(resolve(path));
  const owner = normalize(resolve(root));
  const comparisonCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const comparisonOwner = process.platform === 'win32' ? owner.toLowerCase() : owner;
  const relation = relative(comparisonOwner, comparisonCandidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function sanitizeReason(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 64) || 'unknown'
  );
}

function hasUnsafeSourceConfig(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw.split(/\r?\n/u).some((line) => {
    const key = line.trim().toLowerCase();
    return (
      key.startsWith('include.') ||
      key.startsWith('includeif.') ||
      key === 'extensions.objectformat' ||
      key === 'extensions.partialclone' ||
      key === 'core.fsmonitor' ||
      (key.startsWith('remote.') && key.endsWith('.promisor'))
    );
  });
}

function compactIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function assertManagedTrackedPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.includes(':') ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    posix.normalize(normalized) !== normalized
  ) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace tracked file path is invalid',
    );
  }
  return normalized;
}

function assertManagedMutationPath(path: string): string {
  const normalized = assertManagedTrackedPath(path);
  if (!isCanonicalManagedMutationPathV1(normalized)) {
    throw new GitWorkspaceServiceError(
      'managed_mutation_candidate_rejected',
      'Managed mutation path belongs to workspace control or dependency state',
    );
  }
  return normalized;
}
function managedHeadRef(workspaceId: string, workspaceEpochId: string): string {
  return `refs/maka/workspaces/${workspaceId}/epochs/${workspaceEpochId}/head`;
}

function managedBaselineRef(workspaceEpochId: string): string {
  return `refs/maka/baselines/${workspaceEpochId}`;
}

function mutationCandidateIdentity(
  operationId: string,
  workspaceEpochId: string,
): { digest: string; ref: string } {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        protocol: 'maka_managed_mutation_candidate_identity_v1',
        workspaceEpochId,
        operationId,
      }),
    )
    .digest('hex');
  return {
    digest,
    ref: `refs/maka/candidates/${compactIdentity(workspaceEpochId)}/${digest}`,
  };
}

function mutationCandidateCommitMessage(digest: string): string {
  return `${MUTATION_CANDIDATE_MESSAGE_PREFIX}\nidentity ${digest}\n`;
}

function isOwnedMutationCandidateCommit(
  raw: string,
  digest: string,
  baseCommitOid: string,
  candidateTreeOid: string,
): boolean {
  const normalized = raw.replace(/\r\n/gu, '\n');
  const separator = normalized.indexOf('\n\n');
  if (separator < 0) return false;
  const headers = normalized.slice(0, separator).split('\n');
  const message = normalized.slice(separator + 2).trimEnd();
  return (
    headers.length === 4 &&
    headers[0] === `tree ${candidateTreeOid}` &&
    headers[1] === `parent ${baseCommitOid}` &&
    headers[2] === 'author Maka Runtime <runtime@maka.invalid> 946684800 +0000' &&
    headers[3] === 'committer Maka Runtime <runtime@maka.invalid> 946684800 +0000' &&
    message === mutationCandidateCommitMessage(digest).trimEnd()
  );
}

function deterministicMutationCommitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: 'Maka Runtime',
    GIT_AUTHOR_EMAIL: 'runtime@maka.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Maka Runtime',
    GIT_COMMITTER_EMAIL: 'runtime@maka.invalid',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
}

function parsePorcelainStatus(buffer: Buffer): readonly { status: string; path: string }[] {
  const records = splitNulRecords(buffer);
  const entries: { status: string; path: string }[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== ' ') {
      throw new GitWorkspaceServiceError(
        'managed_workspace_identity_conflict',
        'Managed workspace returned malformed Git status',
      );
    }
    const status = record.slice(0, 2);
    const path = assertManagedTrackedPath(record.slice(3));
    entries.push({ status, path });
    if (/[RC]/u.test(status)) index += 1;
  }
  return entries;
}

function parseNameStatus(buffer: Buffer): readonly { status: string; path: string }[] {
  const records = splitNulRecords(buffer);
  if (records.length % 2 !== 0) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed mutation candidate returned malformed Git delta',
    );
  }
  const entries: { status: string; path: string }[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const status = records[index]!;
    if (!/^[AMD]$/u.test(status)) {
      throw new GitWorkspaceServiceError(
        'managed_workspace_drifted',
        'Managed mutation candidate contains an unsupported Git delta',
      );
    }
    entries.push({ status, path: assertManagedTrackedPath(records[index + 1]!) });
  }
  return entries;
}

function splitNulRecords(buffer: Buffer): string[] {
  const records = buffer.toString('utf8').split('\0');
  if (records.at(-1) === '') records.pop();
  if (records.some((record) => record.includes('\uFFFD'))) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed workspace path is not lossless UTF-8',
    );
  }
  return records;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return isDeepStrictEqual([...left].sort(), [...right].sort());
}

function worktreeLockReason(
  identity: Pick<ManagedWorkspaceIdentity, 'workspaceInstanceId'>,
): string {
  return `maka managed workspace ${identity.workspaceInstanceId}`;
}

function mutationProjectionStagingLockReason(digest: string): string {
  return `maka mutation projection staging ${digest}`;
}

function mutationProjectionQuarantineLockReason(digest: string): string {
  return `maka mutation projection quarantine ${digest}`;
}

function mutationProjectionPartialLockReason(digest: string): string {
  return `maka mutation projection partial ${digest}`;
}

function assertWorktreeRegistrationLocked(
  porcelain: string,
  worktreePath: string,
  expectedReason: string,
): void {
  const registration = findWorktreeRegistration(porcelain, worktreePath);
  if (!registration || registration.lockReason !== expectedReason) {
    throw new GitWorkspaceServiceError(
      'managed_workspace_identity_conflict',
      'Managed worktree registration or Maka ownership lock is unavailable',
    );
  }
}

interface WorktreeRegistration {
  readonly headOid?: string;
  readonly lockReason?: string;
}

function findWorktreeRegistration(
  porcelain: string,
  worktreePath: string,
): WorktreeRegistration | undefined {
  for (const block of porcelain.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const pathLine = lines.find((line) => line.startsWith('worktree '));
    if (!pathLine || !samePath(pathLine.slice('worktree '.length), worktreePath)) continue;
    const headLine = lines.find((line) => line.startsWith('HEAD '));
    const lockedLine = lines.find((line) => line === 'locked' || line.startsWith('locked '));
    return {
      ...(headLine ? { headOid: headLine.slice('HEAD '.length) } : {}),
      ...(lockedLine ? { lockReason: lockedLine.slice('locked'.length).trim() } : {}),
    };
  }
  return undefined;
}

function repositoryCapabilityDigest(
  gitRuntimeSha256: `sha256:${string}`,
  objectFormat: string,
): `sha256:${string}` {
  const capability = JSON.stringify({
    protocol: 'maka_managed_git_repository_capability_v1',
    gitRuntimeSha256,
    objectFormat,
    hooks: 'disabled_v1',
    credentials: 'disabled_v1',
    autoGc: false,
    alternates: 'forbidden_v1',
  });
  return `sha256:${createHash('sha256').update(capability).digest('hex')}`;
}

function materializationProfileDigest(
  gitRuntimeSha256: `sha256:${string}`,
  objectFormat: string,
): `sha256:${string}` {
  const profile = JSON.stringify({
    protocol: 'git_materialization_profile_v1',
    gitRuntimeSha256,
    objectFormat,
    platform: process.platform,
    autocrlf: false,
    safecrlf: true,
    attributes: 'reject_v1',
    symlinks: 'reject_v1',
    submodules: 'reject_v1',
    caseCollisions: 'reject_v1',
    ignoredInputs: 'exclude_v1',
  });
  return `sha256:${createHash('sha256').update(profile).digest('hex')}`;
}

function parseTreeEntries(output: Buffer): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Git source tree contains an unterminated entry',
      );
    }
    const record = output.subarray(start, end);
    start = end + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(0x09);
    const metadata = tab >= 0 ? record.subarray(0, tab).toString('ascii') : '';
    const pathBytes = tab >= 0 ? record.subarray(tab + 1) : Buffer.alloc(0);
    const [mode = '', objectType = '', oid = ''] = metadata.split(' ');
    let path = '';
    try {
      path = new TextDecoder('utf-8', { fatal: true }).decode(pathBytes);
    } catch {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Managed workspace v1 requires Git paths to be valid UTF-8',
      );
    }
    if (
      !mode ||
      !objectType ||
      !OID_PATTERN.test(oid) ||
      pathBytes.length === 0 ||
      !Buffer.from(path, 'utf8').equals(pathBytes)
    ) {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Git source tree contains an unreadable entry',
      );
    }
    entries.push({ mode, objectType, oid, path, pathBytesBase64: pathBytes.toString('base64') });
  }
  return entries;
}

function baselineTreeSummary(entries: readonly GitTreeEntry[]): BaselineTreeSummary {
  const manifest = JSON.stringify({
    protocol: 'maka_git_empty_tree_delta_v1',
    entries: entries.map(({ mode, objectType, oid, pathBytesBase64 }) => ({
      mode,
      objectType,
      oid,
      pathBytesBase64,
    })),
  });
  return {
    treeDeltaDigest: `sha256:${createHash('sha256').update(manifest).digest('hex')}`,
    changedFileCount: entries.length,
  };
}

function assertSupportedTree(entries: readonly GitTreeEntry[]): void {
  const caseFolded = new Set<string>();
  for (const entry of entries) {
    if ((entry.mode !== '100644' && entry.mode !== '100755') || entry.objectType !== 'blob') {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Symlinks, submodules, and special Git modes are not supported by managed workspace v1',
      );
    }
    if (entry.path === '.gitattributes' || entry.path.endsWith('/.gitattributes')) {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Tracked .gitattributes require a materialization profile not supported by v1',
      );
    }
    const folded = entry.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (caseFolded.has(folded)) {
      throw new GitWorkspaceServiceError(
        'repository_ineligible',
        'Case-colliding Git paths are not supported by managed workspace v1',
      );
    }
    caseFolded.add(folded);
  }
}

function baselineCommitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: 'Maka Workspace Service',
    GIT_AUTHOR_EMAIL: 'workspace@maka.invalid',
    GIT_AUTHOR_DATE: BASELINE_DATE,
    GIT_COMMITTER_NAME: 'Maka Workspace Service',
    GIT_COMMITTER_EMAIL: 'workspace@maka.invalid',
    GIT_COMMITTER_DATE: BASELINE_DATE,
    GIT_WORKSPACE_BASELINE_MESSAGE: BASELINE_MESSAGE,
  };
}

function isOwnedBaselineCommit(raw: string): boolean {
  const normalized = raw.replace(/\r\n/gu, '\n');
  const separator = normalized.indexOf('\n\n');
  if (separator < 0) return false;
  const headers = normalized.slice(0, separator).split('\n');
  const message = normalized.slice(separator + 2).trimEnd();
  return (
    headers.length === 3 &&
    /^tree (?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(headers[0] ?? '') &&
    headers[1] === 'author Maka Workspace Service <workspace@maka.invalid> 946684800 +0000' &&
    headers[2] === 'committer Maka Workspace Service <workspace@maka.invalid> 946684800 +0000' &&
    message === BASELINE_MESSAGE.trimEnd()
  );
}

function isolatedGitEnvironment(
  input: VerifiedGitRuntimeInput,
  homePath: string,
): NodeJS.ProcessEnv {
  const executablePath = input.executablePath;
  const env: NodeJS.ProcessEnv = {
    HOME: homePath,
    XDG_CONFIG_HOME: join(homePath, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: dirname(executablePath),
  };
  if (input.distribution?.kind === 'dugite_native_v1') {
    Object.assign(
      env,
      bundledGitEnvironment({
        platform: process.platform,
        arch: process.arch,
        rootPath: input.distribution.rootPath,
        executablePath,
      }),
    );
  }
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP', 'TMPDIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function fixedGitArguments(hooksPath: string): string[] {
  return [
    '--no-pager',
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.safecrlf=true',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.longpaths=true',
    '-c',
    `core.hooksPath=${hooksPath}`,
    '-c',
    'credential.helper=',
    '-c',
    'credential.interactive=never',
    '-c',
    'core.sshCommand=',
    '-c',
    'protocol.allow=never',
    '-c',
    'gc.auto=0',
    '-c',
    'submodule.recurse=false',
  ];
}

function waitForChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

function collectBoundedStderr(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve) => {
    let output = '';
    stream.on('data', (chunk) => {
      if (output.length < 64 * 1024) output += String(chunk);
    });
    stream.on('end', () => resolve(output.slice(0, 64 * 1024).trim()));
  });
}

function collectBoundedOutput(
  stream: NodeJS.ReadableStream | null,
  maxBytes: number,
): Promise<string> {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        reject(new Error('Git command output exceeded its byte limit'));
        return;
      }
      chunks.push(buffer);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function exitCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}
