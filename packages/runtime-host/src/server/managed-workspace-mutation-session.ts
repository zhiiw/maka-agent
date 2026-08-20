import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AiSdkBackendInput } from '@maka/runtime/ai-sdk-backend';
import type {
  FilesystemWorkerClient,
  FilesystemWorkerClientOperation,
  FilesystemWorkerExecuteInput,
  FilesystemWorkerResult,
} from '@maka/runtime/filesystem-worker';
import type {
  ManagedWorkspaceOwner,
  ManagedWorkspaceReadOnlyOperation,
} from '@maka/storage/managed-workspace-owner';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';

export interface ManagedWorkspaceMutationSession {
  readonly filesystemWorker: {
    execute(input: FilesystemWorkerExecuteInput): ReturnType<FilesystemWorkerClient['execute']>;
  };
  readonly admitManagedMutation: NonNullable<AiSdkBackendInput['admitManagedMutation']>;
}

export interface CreateManagedWorkspaceMutationSessionInput {
  readonly owner: ManagedWorkspaceOwner;
  readonly stores: InteractiveExecutionStoresWriter;
  readonly sourceRoot: string;
  readonly sessionId: string;
  readonly abortSignal?: AbortSignal;
}

type ManagedMutationAdmissionInput = Parameters<
  NonNullable<AiSdkBackendInput['admitManagedMutation']>
>[0];

/**
 * Binds one hosted coding session to one owner-issued managed workspace handle.
 * The model never supplies a cwd, workspace identity, profile digest, or Git
 * candidate identity for this path.
 */
export async function createManagedWorkspaceMutationSession(
  input: CreateManagedWorkspaceMutationSessionInput,
): Promise<ManagedWorkspaceMutationSession> {
  input.abortSignal?.throwIfAborted();
  const sourceRoot = await realpath(input.sourceRoot);
  input.abortSignal?.throwIfAborted();
  const identity = managedMutationIdentity(sourceRoot, input.sessionId);
  const opened = await input.owner.openManagedWorkspaceBaselineFromExecutionStores(input.stores, {
    ...identity,
    sourceRoot,
  });
  input.abortSignal?.throwIfAborted();

  return Object.freeze({
    filesystemWorker: Object.freeze({
      async execute(workerInput: FilesystemWorkerExecuteInput) {
        const { operation } = workerInput;
        if (operation.kind === 'write' || operation.kind === 'edit') {
          return normalizeWorkerResult(
            await input.owner.executeManagedMutationFilesystemOperation(
              operation,
              workerInput.abortSignal,
            ),
            sourceRoot,
            operation.path,
          );
        }
        if (!isManagedReadOnlyOperation(operation)) {
          throw new Error(`Managed workspace operation is not admitted: ${operation.kind}`);
        }
        return normalizeWorkerResult(
          await input.owner.withManagedWorkspaceExecution(opened.executionHandle, (scope) =>
            input.owner.executeReadOnlyFilesystemOperation(
              scope,
              operation,
              workerInput.abortSignal,
            ),
          ),
        );
      },
    }),
    admitManagedMutation: async (admissionInput: ManagedMutationAdmissionInput) => {
      if (admissionInput.toolName !== 'Write' && admissionInput.toolName !== 'Edit') {
        throw new Error(`Managed mutation tool is not admitted: ${admissionInput.toolName}`);
      }
      return await input.owner.admitManagedWorkspaceMutation(opened.executionHandle, {
        ...admissionInput,
        toolName: admissionInput.toolName,
      });
    },
  });
}

function isManagedReadOnlyOperation(
  operation: FilesystemWorkerClientOperation,
): operation is ManagedWorkspaceReadOnlyOperation {
  return operation.kind === 'read' || operation.kind === 'glob' || operation.kind === 'grep';
}

function normalizeWorkerResult(
  result: Awaited<
    ReturnType<
      | ManagedWorkspaceOwner['executeManagedMutationFilesystemOperation']
      | ManagedWorkspaceOwner['executeReadOnlyFilesystemOperation']
    >
  >,
  logicalRoot?: string,
  logicalPath?: string,
): FilesystemWorkerResult {
  if (result.kind === 'glob') return { kind: 'glob', files: [...result.files] };
  if (result.kind === 'grep') return { kind: 'grep', matches: [...result.matches] };
  if ((result.kind === 'write' || result.kind === 'edit') && logicalRoot && logicalPath) {
    return { ...result, path: resolve(logicalRoot, logicalPath) };
  }
  return { ...result };
}

function managedMutationIdentity(sourceRoot: string, sessionId: string) {
  const sourceIdentity = domainDigest('source', sourceRoot);
  const sessionIdentity = domainDigest('session', sourceRoot, sessionId);
  return Object.freeze({
    repositoryId: `repository_${sourceIdentity}`,
    workspaceId: `workspace_${sessionIdentity}`,
    workspaceEpochId: `epoch_${domainDigest('epoch', sourceRoot, sessionId)}`,
    workspaceInstanceId: `instance_${domainDigest('instance', sourceRoot, sessionId)}`,
  });
}

function domainDigest(domain: string, ...values: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(`maka-managed-mutation-${domain}-v1\0`, 'utf8');
  for (const value of values) {
    hash.update(value, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex').slice(0, 32);
}
