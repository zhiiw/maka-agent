import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableHash } from './request-shape.js';
import type {
  CheckpointValidationResult,
  ValidateCheckpointInput,
  WorkspaceCheckpointArtifact,
  WorkspaceCheckpointCapabilities,
  WorkspaceCheckpointProvider,
  WorkspaceIdentity,
} from './workspace-checkpoint.js';

export interface WorkspaceSnapshotPolicyV1 {
  version: 1;
  trackedFiles: 'include';
  untrackedFiles: 'include_with_limits' | 'exclude';
  ignoredFiles: 'exclude';
  symlinks: 'preserve_link';
  submodules: 'gitlink_clean_only';
  gitFilters: 'reject';
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  captureTimeoutMs: number;
  excludedGlobs: string[];
}

export const DEFAULT_GIT_WORKSPACE_SNAPSHOT_POLICY_V1: WorkspaceSnapshotPolicyV1 = {
  version: 1,
  trackedFiles: 'include',
  untrackedFiles: 'include_with_limits',
  ignoredFiles: 'exclude',
  symlinks: 'preserve_link',
  submodules: 'gitlink_clean_only',
  gitFilters: 'reject',
  maxFiles: 50_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  captureTimeoutMs: 5_000,
  excludedGlobs: [],
};

export interface CaptureGitWorkspaceCheckpointInput {
  workspaceRoot: string;
  checkpointId: string;
  sessionId: string;
  boundaryDigest: string;
  policy: WorkspaceSnapshotPolicyV1;
}

export interface PreparedGitWorkspaceCheckpoint {
  workspace: WorkspaceIdentity;
  artifact: Extract<WorkspaceCheckpointArtifact, { kind: 'git_repository_v1' }>;
  policy: { version: 1; hash: string };
  fileCount: number;
  totalBytes: number;
  captureDurationMs: number;
}

export interface GitWorkspaceCheckpointProviderOptions {
  gitBinary?: string;
  priority?: number;
  now?: () => number;
  onTelemetry?: (event: {
    name: 'checkpoint_capture_completed' | 'checkpoint_validation_completed';
    durationMs: number;
    disposition?: CheckpointValidationResult['disposition'];
  }) => void;
}

export interface GitCheckpointOrphanCandidate {
  retentionRef: string;
  commitCreatedAt: number;
}

export class GitWorkspaceCheckpointProvider implements WorkspaceCheckpointProvider {
  readonly id = 'git-repository-v1';
  readonly priority: number;
  readonly capabilities: WorkspaceCheckpointCapabilities = {
    coverage: 'full_policy_scope',
    contentRetention: 'full_snapshot',
    validation: 'tree_identity',
    restore: 'unsupported',
    repositoryAware: true,
    executableMode: true,
    symlinks: true,
    submodules: false,
  };
  private readonly gitBinary: string;
  private readonly now: () => number;
  private readonly onTelemetry?: GitWorkspaceCheckpointProviderOptions['onTelemetry'];

  constructor(options: GitWorkspaceCheckpointProviderOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.priority = options.priority ?? 100;
    this.now = options.now ?? Date.now;
    this.onTelemetry = options.onTelemetry;
  }

  async capture(
    input: CaptureGitWorkspaceCheckpointInput,
  ): Promise<PreparedGitWorkspaceCheckpoint> {
    const startedAt = this.now();
    assertSupportedPolicy(input.policy);
    const repository = await this.inspectRepository(input.workspaceRoot);
    const captured = await this.captureTree(
      repository.workspace.canonicalRoot,
      input.policy,
      startedAt,
    );
    const commitOid = (
      await this.git(
        repository.workspace.canonicalRoot,
        ['commit-tree', captured.treeOid],
        Buffer.from(
          `Maka workspace checkpoint ${input.checkpointId}\n\nBoundary: ${input.boundaryDigest}\nPolicy: ${workspaceSnapshotPolicyIdentity(input.policy).hash}\n`,
        ),
        checkpointIdentityEnv(),
      )
    ).trim();
    const namespace = stableHash({
      workspace: repository.workspace.workspaceInstanceIdentity,
      sessionId: input.sessionId,
      checkpointId: input.checkpointId,
    }).slice('sha256:'.length);
    const retentionRef = `refs/maka/checkpoints/${namespace.slice(0, 2)}/${namespace}`;
    await this.git(repository.workspace.canonicalRoot, ['update-ref', retentionRef, commitOid]);
    const retained = (
      await this.git(repository.workspace.canonicalRoot, [
        'rev-parse',
        '--verify',
        `${retentionRef}^{commit}`,
      ])
    ).trim();
    if (retained !== commitOid) throw new Error('Git checkpoint retention ref verification failed');
    const durationMs = this.now() - startedAt;
    this.onTelemetry?.({ name: 'checkpoint_capture_completed', durationMs });
    return {
      workspace: repository.workspace,
      artifact: {
        kind: 'git_repository_v1',
        repositoryIdentity: repository.workspace.repositoryIdentity!,
        objectFormat: repository.objectFormat,
        commitOid,
        treeOid: captured.treeOid,
        retentionRef,
      },
      policy: workspaceSnapshotPolicyIdentity(input.policy),
      fileCount: captured.fileCount,
      totalBytes: captured.totalBytes,
      captureDurationMs: durationMs,
    };
  }

  async validate(input: ValidateCheckpointInput): Promise<CheckpointValidationResult> {
    const startedAt = this.now();
    const artifact = input.checkpoint.artifact;
    let disposition: CheckpointValidationResult['disposition'] = 'corrupt';
    let observedArtifactDigest: string | undefined;
    try {
      if (artifact.kind !== 'git_repository_v1' || input.checkpoint.providerId !== this.id) {
        disposition = 'provider_mismatch';
      } else {
        const repository = await this.inspectRepository(input.currentWorkspace.canonicalRoot);
        if (
          repository.workspace.repositoryIdentity !== artifact.repositoryIdentity ||
          repository.workspace.workspaceInstanceIdentity !==
            input.currentWorkspace.workspaceInstanceIdentity
        ) {
          disposition = 'identity_mismatch';
        } else {
          const retained = (
            await this.git(repository.workspace.canonicalRoot, [
              'rev-parse',
              '--verify',
              `${artifact.retentionRef}^{commit}`,
            ])
          ).trim();
          const retainedTree = (
            await this.git(repository.workspace.canonicalRoot, [
              'rev-parse',
              '--verify',
              `${retained}^{tree}`,
            ])
          ).trim();
          if (retained !== artifact.commitOid || retainedTree !== artifact.treeOid) {
            disposition = 'corrupt';
          } else {
            const captured = await this.captureTree(
              repository.workspace.canonicalRoot,
              DEFAULT_GIT_WORKSPACE_SNAPSHOT_POLICY_V1,
              startedAt,
            );
            observedArtifactDigest = captured.treeOid;
            disposition =
              captured.treeOid === artifact.treeOid
                ? 'current_matches'
                : 'drifted_restore_unavailable';
          }
        }
      }
    } catch {
      disposition = 'missing';
    }
    const durationMs = this.now() - startedAt;
    this.onTelemetry?.({ name: 'checkpoint_validation_completed', durationMs, disposition });
    return {
      disposition,
      checkpointId: input.checkpoint.checkpointId,
      ...(observedArtifactDigest ? { observedArtifactDigest } : {}),
    };
  }

  async listOrphanRetentionRefs(
    workspaceRoot: string,
    acceptedRefs: ReadonlySet<string>,
  ): Promise<GitCheckpointOrphanCandidate[]> {
    const repository = await this.inspectRepository(workspaceRoot);
    const output = await this.git(repository.workspace.canonicalRoot, [
      'for-each-ref',
      '--format=%(refname)%00%(creatordate:unix)',
      'refs/maka/checkpoints/',
    ]);
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [retentionRef, createdAt] = line.split('\0');
        if (!retentionRef || !createdAt || !Number.isFinite(Number(createdAt))) {
          throw new Error('Invalid Maka checkpoint ref metadata');
        }
        return { retentionRef, commitCreatedAt: Number(createdAt) * 1_000 };
      })
      .filter((candidate) => !acceptedRefs.has(candidate.retentionRef));
  }

  private async inspectRepository(workspaceRoot: string): Promise<{
    workspace: WorkspaceIdentity;
    objectFormat: 'sha1' | 'sha256';
  }> {
    const canonicalRoot = await realpath(workspaceRoot);
    if ((await this.git(canonicalRoot, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') {
      throw new Error('Workspace is not a Git worktree');
    }
    const commonDir = await realpath(
      (
        await this.git(canonicalRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      ).trim(),
    );
    const objectFormat = (
      await this.git(canonicalRoot, ['rev-parse', '--show-object-format']).catch(() => 'sha1')
    ).trim();
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
      throw new Error(`Unsupported Git object format: ${objectFormat}`);
    }
    return {
      workspace: {
        repositoryIdentity: stableHash({
          protocol: 'git_repository_identity_v1',
          commonDir,
          objectFormat,
        }),
        workspaceInstanceIdentity: stableHash({
          protocol: 'git_workspace_instance_v1',
          commonDir,
          canonicalRoot,
        }),
        canonicalRoot,
      },
      objectFormat,
    };
  }

  private async captureTree(
    workspaceRoot: string,
    policy: WorkspaceSnapshotPolicyV1,
    startedAt: number,
  ): Promise<{ treeOid: string; fileCount: number; totalBytes: number }> {
    assertSupportedPolicy(policy);
    const args = ['ls-files', '--cached'];
    if (policy.untrackedFiles === 'include_with_limits')
      args.push('--others', '--exclude-standard');
    args.push('-z');
    const paths = [
      ...new Set(
        (await this.gitBytes(workspaceRoot, args)).toString('utf8').split('\0').filter(Boolean),
      ),
    ].sort();
    if (paths.length > policy.maxFiles) throw new Error('checkpoint_policy_limit_exceeded: files');
    const temp = await mkdtemp(join(tmpdir(), 'maka-git-index-'));
    const indexPath = join(temp, 'index');
    let totalBytes = 0;
    try {
      const entries: Buffer[] = [];
      for (const path of paths) {
        if (this.now() - startedAt > policy.captureTimeoutMs) {
          throw new Error('checkpoint_policy_limit_exceeded: timeout');
        }
        const absolute = join(workspaceRoot, ...path.split('/'));
        let stat;
        try {
          stat = await lstat(absolute);
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') continue;
          throw error;
        }
        let content: Buffer;
        let mode: string;
        if (stat.isSymbolicLink()) {
          content = Buffer.from(await readlink(absolute));
          mode = '120000';
        } else if (stat.isFile()) {
          content = await readFile(absolute);
          mode = stat.mode & 0o111 ? '100755' : '100644';
        } else {
          throw new Error(`checkpoint_policy_unsupported: non-file path ${path}`);
        }
        if (content.byteLength > policy.maxFileBytes) {
          throw new Error(`checkpoint_policy_limit_exceeded: file ${path}`);
        }
        totalBytes += content.byteLength;
        if (totalBytes > policy.maxTotalBytes) {
          throw new Error('checkpoint_policy_limit_exceeded: total bytes');
        }
        const filter = (await this.git(workspaceRoot, ['check-attr', 'filter', '--', path])).trim();
        if (!filter.endsWith(': unspecified') && !filter.endsWith(': unset')) {
          throw new Error(`checkpoint_policy_unsupported: Git filter on ${path}`);
        }
        const oid = (
          await this.git(workspaceRoot, ['hash-object', '-w', '--no-filters', '--stdin'], content)
        ).trim();
        entries.push(Buffer.from(`${mode} ${oid}\t${path}\0`));
      }
      const env = { GIT_INDEX_FILE: indexPath };
      await this.git(workspaceRoot, ['read-tree', '--empty'], undefined, env);
      if (entries.length > 0) {
        await this.git(
          workspaceRoot,
          ['update-index', '-z', '--index-info'],
          Buffer.concat(entries),
          env,
        );
      }
      const treeOid = (await this.git(workspaceRoot, ['write-tree'], undefined, env)).trim();
      return { treeOid, fileCount: entries.length, totalBytes };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  private git(
    cwd: string,
    args: string[],
    stdin?: Uint8Array,
    env?: NodeJS.ProcessEnv,
  ): Promise<string> {
    return this.gitBytes(cwd, args, stdin, env).then((value) => value.toString('utf8'));
  }

  private gitBytes(
    cwd: string,
    args: string[],
    stdin?: Uint8Array,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<Buffer> {
    return runProcessBytes(this.gitBinary, args, cwd, stdin, extraEnv);
  }
}

export function workspaceSnapshotPolicyIdentity(policy: WorkspaceSnapshotPolicyV1): {
  version: 1;
  hash: string;
} {
  assertSupportedPolicy(policy);
  return { version: 1, hash: stableHash({ protocol: 'workspace_snapshot_policy_v1', policy }) };
}

function assertSupportedPolicy(policy: WorkspaceSnapshotPolicyV1): void {
  if (
    policy.version !== 1 ||
    policy.trackedFiles !== 'include' ||
    policy.untrackedFiles !== 'include_with_limits' ||
    policy.ignoredFiles !== 'exclude' ||
    policy.symlinks !== 'preserve_link' ||
    policy.submodules !== 'gitlink_clean_only' ||
    policy.gitFilters !== 'reject' ||
    policy.excludedGlobs.length > 0
  ) {
    throw new Error('checkpoint_policy_unsupported');
  }
  for (const value of [
    policy.maxFiles,
    policy.maxFileBytes,
    policy.maxTotalBytes,
    policy.captureTimeoutMs,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error('Invalid checkpoint policy limit');
  }
}

function runProcessBytes(
  command: string,
  args: string[],
  cwd: string,
  stdin?: Uint8Array,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout));
      reject(
        new Error(
          `${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
        ),
      );
    });
    child.stdin.end(stdin ? Buffer.from(stdin) : undefined);
  });
}

function checkpointIdentityEnv(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: 'Maka Checkpoint',
    GIT_AUTHOR_EMAIL: 'noreply@localhost',
    GIT_COMMITTER_NAME: 'Maka Checkpoint',
    GIT_COMMITTER_EMAIL: 'noreply@localhost',
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
