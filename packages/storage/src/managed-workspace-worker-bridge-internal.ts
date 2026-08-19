import {
  createManagedExecutionBoundary,
  type ExecutionBoundary,
} from '@maka/core/sandbox-boundary';
import { createReadOnlyPermissionProfile } from '@maka/core/permission-profile';
import {
  requireManagedWorkspaceExecutionScopeInternal,
  type ManagedWorkspaceExecutionScope,
} from './managed-workspace-execution-authority-internal.js';

export type ManagedWorkspaceReadOnlyOperation =
  | {
      readonly kind: 'read';
      readonly path: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: 'glob';
      readonly path: string;
      readonly pattern: string;
      readonly limit?: number;
    }
  | {
      readonly kind: 'grep';
      readonly path: string;
      readonly pattern: string;
      readonly glob?: string;
      readonly maxCountPerFile: number;
      readonly limit: number;
      readonly timeoutMs: number;
    };

export type ManagedWorkspaceMutationOperation =
  | {
      readonly kind: 'write';
      readonly path: string;
      readonly content: string;
    }
  | {
      readonly kind: 'edit';
      readonly path: string;
      readonly oldString: string;
      readonly newString: string;
    };

export type ManagedWorkspaceFilesystemOperation =
  | ManagedWorkspaceReadOnlyOperation
  | ManagedWorkspaceMutationOperation;

interface ManagedWorkspaceFilesystemWorkerInput {
  readonly operation: ManagedWorkspaceFilesystemOperation;
  readonly cwd: string;
  readonly executionBoundary: ExecutionBoundary;
  readonly abortSignal?: AbortSignal;
  readonly mutationEvidence?: {
    readonly protocol: 'detached_git_transform_v1';
    readonly objectFormat: 'sha1' | 'sha256';
    readonly baseBlobOid: string | null;
    readonly baseContent: string | null;
  };
}

export type ManagedWorkspaceReadOnlyResult =
  | { readonly kind: 'read'; readonly content: string }
  | {
      readonly kind: 'read_image';
      readonly base64: string;
      readonly mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    }
  | { readonly kind: 'glob'; readonly files: readonly string[] }
  | { readonly kind: 'grep'; readonly matches: readonly string[] };

export type ManagedWorkspaceMutationResult =
  | {
      readonly kind: 'write';
      readonly ok: true;
      readonly path: string;
      readonly bytes: number;
      readonly diff?: string;
      readonly resultBlobOid: string;
    }
  | {
      readonly kind: 'edit';
      readonly ok: true;
      readonly path: string;
      readonly replacements: 1;
      readonly matchedVia: 'exact' | 'line-trimmed' | 'whitespace' | 'escape';
      readonly startLine: number;
      readonly endLine: number;
      readonly diff?: string;
      readonly resultBlobOid: string;
    };

type ManagedWorkspaceMutationWorkerResult = ManagedWorkspaceMutationResult & {
  readonly resultContent: string;
};

type ManagedWorkspaceMutationWorkerOutput = ManagedWorkspaceMutationResult & {
  readonly resultContent?: string;
};

export type ManagedWorkspaceFilesystemResult =
  | ManagedWorkspaceReadOnlyResult
  | ManagedWorkspaceMutationWorkerOutput;

export interface ManagedWorkspaceFilesystemWorker {
  /** Host-issued digest of the exact worker protocol and mutation sandbox profile. */
  readonly mutationExecutionProfileDigest: `sha256:${string}`;
  /**
   * Resolves only after the one-shot filesystem operation and every process it
   * owns have reached a terminal lifecycle state. Implementations must not
   * return a detached filesystem effect to the caller. The production adapter
   * satisfies this contract through FilesystemWorkerClient. Read operations
   * use the owner-bound projection; mutation operations are pure transforms
   * over immutable Git content and receive no workspace read/write authority.
   */
  execute(input: ManagedWorkspaceFilesystemWorkerInput): Promise<ManagedWorkspaceFilesystemResult>;
}

export type ManagedWorkspaceWorkerBridgeErrorCode = 'managed_workspace_operation_denied';

export class ManagedWorkspaceWorkerBridgeError extends Error {
  constructor(
    readonly code: ManagedWorkspaceWorkerBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedWorkspaceWorkerBridgeError';
  }
}

export interface ManagedWorkspaceWorkerBridgeInternal {
  readonly mutationExecutionProfileDigest: `sha256:${string}`;
  execute(
    scope: ManagedWorkspaceExecutionScope,
    operation: ManagedWorkspaceReadOnlyOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceReadOnlyResult>;
  executeMutation(
    scope: ManagedWorkspaceExecutionScope,
    operation: ManagedWorkspaceMutationOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceMutationWorkerResult>;
}

/**
 * Owner-bound bridge from an opaque, revocable scope to the filesystem worker.
 * The caller never supplies or receives cwd. Runtime validation intentionally
 * repeats the TypeScript allowlist so JavaScript/forged inputs fail closed.
 */
export function createManagedWorkspaceWorkerBridgeInternal(
  ownerToken: object,
  worker: ManagedWorkspaceFilesystemWorker,
): ManagedWorkspaceWorkerBridgeInternal {
  if (!/^sha256:[a-f0-9]{64}$/u.test(worker.mutationExecutionProfileDigest)) {
    throw new ManagedWorkspaceWorkerBridgeError(
      'managed_workspace_operation_denied',
      'Managed workspace mutation worker profile identity is invalid',
    );
  }
  const bridge: ManagedWorkspaceWorkerBridgeInternal = {
    mutationExecutionProfileDigest: worker.mutationExecutionProfileDigest,
    async execute(
      scope: ManagedWorkspaceExecutionScope,
      operation: ManagedWorkspaceReadOnlyOperation,
      abortSignal?: AbortSignal,
    ) {
      if (!isReadOnlyOperation(operation)) {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace execution currently permits only Read, Glob, and Grep operations',
        );
      }
      const state = requireManagedWorkspaceExecutionScopeInternal(ownerToken, scope);
      if (state.workspaceEffect !== 'none' || state.provisioning !== 'canonical_tree_only_v1') {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace execution scope does not permit filesystem mutation',
        );
      }
      const result = await worker.execute({
        operation,
        cwd: state.cwd,
        executionBoundary: createManagedExecutionBoundary(createReadOnlyPermissionProfile(), 0),
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (!isReadOnlyResult(result)) {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace read operation returned a mutating result',
        );
      }
      return result;
    },
    async executeMutation(scope, operation, abortSignal) {
      if (!isMutationOperation(operation)) {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace mutation permits only Write and Edit operations',
        );
      }
      const state = requireManagedWorkspaceExecutionScopeInternal(ownerToken, scope);
      if (
        state.workspaceEffect !== 'mutation' ||
        state.provisioning !== 'canonical_tree_only_v1' ||
        state.expectedPaths.length !== 1 ||
        operation.path !== state.expectedPaths[0]
      ) {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace mutation does not match its admitted path',
        );
      }
      const result = await worker.execute({
        operation,
        cwd: state.cwd,
        executionBoundary: createManagedExecutionBoundary(createReadOnlyPermissionProfile(), 0),
        mutationEvidence: {
          protocol: 'detached_git_transform_v1',
          objectFormat: state.objectFormat,
          baseBlobOid: state.baseBlobOid,
          baseContent: state.baseContent,
        },
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (
        !isMutationResult(result) ||
        result.kind !== operation.kind ||
        typeof result.resultContent !== 'string' ||
        !blobOidMatchesObjectFormat(result.resultBlobOid, state.objectFormat)
      ) {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace mutation worker returned a mismatched result',
        );
      }
      return result;
    },
  };
  return Object.freeze(bridge);
}

function isReadOnlyOperation(input: unknown): input is ManagedWorkspaceReadOnlyOperation {
  if (!input || typeof input !== 'object') return false;
  const kind = (input as { kind?: unknown }).kind;
  return kind === 'read' || kind === 'glob' || kind === 'grep';
}

function isMutationOperation(input: unknown): input is ManagedWorkspaceMutationOperation {
  if (!input || typeof input !== 'object') return false;
  const kind = (input as { kind?: unknown }).kind;
  return kind === 'write' || kind === 'edit';
}

function isReadOnlyResult(
  input: ManagedWorkspaceFilesystemResult,
): input is ManagedWorkspaceReadOnlyResult {
  return (
    input.kind === 'read' ||
    input.kind === 'read_image' ||
    input.kind === 'glob' ||
    input.kind === 'grep'
  );
}

function isMutationResult(
  input: ManagedWorkspaceFilesystemResult,
): input is ManagedWorkspaceMutationWorkerResult {
  return input.kind === 'write' || input.kind === 'edit';
}

function blobOidMatchesObjectFormat(oid: unknown, objectFormat: 'sha1' | 'sha256'): oid is string {
  return (
    typeof oid === 'string' &&
    (objectFormat === 'sha1' ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u).test(oid)
  );
}
