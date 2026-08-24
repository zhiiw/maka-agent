/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';
import { z } from 'zod';
import { createReadOnlyPermissionProfile } from '@maka/core/permission-profile';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  computeManagedDependencyEnvironmentIdentity,
  createManagedDependencyEnvironmentAuthority,
  createManagedDependencyEnvironmentProducerCapability,
  type ManagedDependencyEnvironmentAuthority,
  type ManagedDependencyEnvironmentProducerInput,
} from '@maka/storage/managed-dependency-environment';
import type {
  ManagedWorkspaceFilesystemWorker,
  ManagedWorkspaceReadOnlyOperation,
  ManagedWorkspaceReadOnlyResult,
} from '@maka/storage/managed-workspace-owner';
import { resolveBundledNpmRuntime } from './bundled-npm-runtime.js';
import {
  runManagedNpmDependencyProvision,
  type ManagedNpmRuntimeCapability,
} from './managed-dependency-producer-process.js';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import { resolvePackagedGitoxideHelperInternal } from './packaged-gitoxide-helper-internal.js';
import {
  admitGitoxideRepositoryInternal,
  importAdmittedGitoxideRepositoryInternal,
  materializeGitoxideProjectionInternal,
  observeGitoxideProjectionInternal,
  readGitoxideTreeFileInternal,
} from './gitoxide-repository-admission-authority-internal.js';

const MAX_PATH_CHARS = 4_096;
const MAX_GLOB_PATTERN_CHARS = 4_096;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_GLOB_RESULTS = 256;
const BASELINE_REF = 'refs/maka/accepted';

const boundedPath = z.string().min(1).max(MAX_PATH_CHARS);
const managedInspectionInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('read'),
      path: boundedPath,
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(MAX_GLOB_RESULTS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('glob'),
      path: boundedPath,
      pattern: z.string().min(1).max(MAX_GLOB_PATTERN_CHARS),
      limit: z.number().int().positive().max(MAX_GLOB_RESULTS).optional(),
    })
    .strict(),
]);

export type GitoxideManagedInspectionInput = z.infer<typeof managedInspectionInputSchema>;

export interface GitoxideManagedInspectionResult {
  readonly kind: 'gitoxide_managed_inspection_v1';
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  /** Present only when this operation actually consumed the dependency environment. */
  readonly dependencyEnvironmentId?: `sha256:${string}`;
  readonly result: ManagedWorkspaceReadOnlyResult;
}

export interface GitoxideInspectionRepositoryInternal {
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readFile(
    path: string,
    abortSignal: AbortSignal,
  ): Promise<{ readonly path: string; readonly content: string }>;
  materializeProjection(
    destinationPath: string,
    abortSignal: AbortSignal,
  ): Promise<{
    readonly destinationPath: string;
    verify(abortSignal: AbortSignal): Promise<void>;
  }>;
}

export type GitoxideInspectionRepositoryProviderInternal = (input: {
  readonly sourceCwd: string;
  readonly repositoryPath: string;
  readonly abortSignal: AbortSignal;
}) => Promise<GitoxideInspectionRepositoryInternal>;

export interface GitoxideManagedInspectionComposition {
  readonly state: 'ready' | 'draining' | 'closed';
  readonly tool: MakaTool<GitoxideManagedInspectionInput, GitoxideManagedInspectionResult>;
  toolForRepositoryProvider(
    provider: GitoxideInspectionRepositoryProviderInternal,
  ): MakaTool<GitoxideManagedInspectionInput, GitoxideManagedInspectionResult>;
  beginDrain(): void;
  close(): Promise<void>;
}

export interface CreateGitoxideManagedInspectionCompositionInput {
  readonly storageRoot: string;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly npmRuntime: ManagedNpmRuntimeCapability;
  readonly dependencyAuthority: ManagedDependencyEnvironmentAuthority;
  readonly filesystemWorker: ManagedWorkspaceFilesystemWorker;
}

export async function createGitoxideManagedInspectionComposition(
  input: CreateGitoxideManagedInspectionCompositionInput,
): Promise<GitoxideManagedInspectionComposition> {
  const storageRoot = await realpath(input.storageRoot);
  const stagingRoot = join(storageRoot, 'managed-workspaces', 'gitoxide-inspection-staging');
  await mkdir(stagingRoot, { recursive: true });
  const canonicalStagingRoot = await realpath(stagingRoot);
  assertWithin(storageRoot, canonicalStagingRoot, 'Gitoxide inspection staging root');

  const invocationOwnerToken = input.invocationOwnerToken;
  const admissionOwnerToken = {};
  const managedRepositoryOwnerToken = {};
  const projectionOwnerToken = {};
  let state: GitoxideManagedInspectionComposition['state'] = 'ready';
  let activeOperations = 0;
  const drainWaiters = new Set<() => void>();
  let closeTask: Promise<void> | undefined;

  const openFreshSourceRepository = async (request: {
    readonly sourceRoot: string;
    readonly repositoryPath: string;
    readonly abortSignal: AbortSignal;
  }): Promise<GitoxideInspectionRepositoryInternal> => {
    const admitted = await admitGitoxideRepositoryInternal({
      invocationOwnerToken,
      helperCapability: input.helperCapability,
      admissionOwnerToken,
      repositoryPath: request.sourceRoot,
      abortSignal: request.abortSignal,
    });
    if (admitted.kind !== 'accepted') {
      throw new Error(`Gitoxide rejected the source repository: ${admitted.reason}`);
    }
    const imported = await importAdmittedGitoxideRepositoryInternal({
      invocationOwnerToken,
      helperCapability: input.helperCapability,
      admissionOwnerToken,
      repositoryCapability: admitted.capability,
      managedRepositoryOwnerToken,
      destinationRepositoryPath: request.repositoryPath,
      baselineRef: BASELINE_REF,
      abortSignal: request.abortSignal,
    });
    return Object.freeze({
      acceptedCommitOid: imported.baselineCommitOid,
      acceptedTreeOid: imported.baselineTreeOid,
      async readFile(path: string, abortSignal: AbortSignal) {
        const file = await readGitoxideTreeFileInternal({
          invocationOwnerToken,
          helperCapability: input.helperCapability,
          managedRepositoryOwnerToken,
          managedRepositoryCapability: imported.managedRepositoryCapability,
          path,
          abortSignal,
        });
        return Object.freeze({ path: file.path, content: file.content });
      },
      async materializeProjection(destinationPath: string, abortSignal: AbortSignal) {
        const projection = await materializeGitoxideProjectionInternal({
          invocationOwnerToken,
          helperCapability: input.helperCapability,
          managedRepositoryOwnerToken,
          managedRepositoryCapability: imported.managedRepositoryCapability,
          projectionOwnerToken,
          destinationPath,
          abortSignal,
        });
        return Object.freeze({
          destinationPath: projection.destinationPath,
          async verify(signal: AbortSignal) {
            const observation = await observeGitoxideProjectionInternal({
              invocationOwnerToken,
              helperCapability: input.helperCapability,
              projectionOwnerToken,
              projectionCapability: projection.projectionCapability,
              abortSignal: signal,
            });
            if (observation.kind !== 'projection_observed') {
              throw new Error(
                `Gitoxide projection drifted at ${observation.path}: ${observation.reason}`,
              );
            }
          },
        });
      },
    });
  };

  const execute = async (
    operation: GitoxideManagedInspectionInput,
    sourceCwd: string,
    abortSignal: AbortSignal,
    repositoryProvider?: GitoxideInspectionRepositoryProviderInternal,
  ): Promise<GitoxideManagedInspectionResult> => {
    if (state !== 'ready') throw new Error(`Gitoxide managed inspection is ${state}`);
    const route = routeInspectionOperation(operation);
    abortSignal.throwIfAborted();
    activeOperations += 1;
    let operationRoot: string | undefined;
    let dependencyLease: Awaited<ReturnType<typeof input.dependencyAuthority.acquire>> | undefined;
    let primaryError: unknown;
    try {
      const sourceRoot = await realpath(sourceCwd);
      abortSignal.throwIfAborted();
      operationRoot = await mkdtemp(join(canonicalStagingRoot, 'inspection-'));
      const repositoryPath = join(operationRoot, 'repository.git');
      const projectionPath = join(operationRoot, 'projection');
      const repository = repositoryProvider
        ? await repositoryProvider({ sourceCwd: sourceRoot, repositoryPath, abortSignal })
        : await openFreshSourceRepository({ sourceRoot, repositoryPath, abortSignal });
      let rawResult: ManagedWorkspaceReadOnlyResult;
      let dependencyEnvironmentId: `sha256:${string}` | undefined;
      if (route.root === 'source_tree') {
        if (operation.kind !== 'read') throw new Error('Invalid source-tree inspection route');
        const file = await repository.readFile(route.workerOperation.path, abortSignal);
        rawResult = Object.freeze({
          kind: 'read' as const,
          content: sliceReadContent(file.content, operation.offset, operation.limit),
        });
      } else if (route.root === 'projection') {
        const projection = await repository.materializeProjection(projectionPath, abortSignal);
        rawResult = await input.filesystemWorker.execute({
          operation: route.workerOperation,
          cwd: projection.destinationPath,
          executionBoundary: route.executionBoundary,
          abortSignal,
        });
        await projection.verify(abortSignal);
      } else {
        // These reads are intentionally sequential. A rejected child cannot outlive
        // the operation and race cleanup of the shared managed repository.
        const manifest = await repository.readFile('package.json', abortSignal);
        const lockfile = await repository.readFile('package-lock.json', abortSignal);
        const manifestBytes = Buffer.from(manifest.content, 'utf8');
        const lockfileBytes = Buffer.from(lockfile.content, 'utf8');
        const producerCapability = createManagedDependencyEnvironmentProducerCapability(
          input.npmRuntime.runtimeIdentitySha256,
        );
        const dependencyIdentity = computeManagedDependencyEnvironmentIdentity({
          manifestPath: manifest.path,
          manifestBytes,
          lockfilePath: lockfile.path,
          lockfileBytes,
          packageManagerName: 'npm',
          packageManagerVersion: input.npmRuntime.npmVersion,
          nodeVersion: input.npmRuntime.nodeVersion,
          nodeAbi: input.npmRuntime.nodeAbi,
          platform: input.npmRuntime.platform,
          arch: input.npmRuntime.arch,
          producerRuntimeIdentitySha256: producerCapability.runtimeIdentitySha256,
          producerPolicyIdentitySha256: producerCapability.policyIdentitySha256,
          policyVersion: 'managed_dependency_environment_v1',
        });
        dependencyLease = await input.dependencyAuthority.acquire(dependencyIdentity, {
          manifestBytes,
          lockfileBytes,
          abortSignal,
        });
        abortSignal.throwIfAborted();
        dependencyEnvironmentId = dependencyLease.environmentId;
        rawResult = await input.filesystemWorker.execute({
          operation: route.workerOperation,
          cwd: dependencyLease.dependencyRoot,
          executionBoundary: route.executionBoundary,
          abortSignal,
        });
      }
      const result = remapInspectionResult(route, rawResult);
      const response = Object.freeze({
        kind: 'gitoxide_managed_inspection_v1' as const,
        acceptedCommitOid: repository.acceptedCommitOid,
        acceptedTreeOid: repository.acceptedTreeOid,
        ...(dependencyEnvironmentId ? { dependencyEnvironmentId } : {}),
        result,
      });
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESULT_BYTES) {
        throw new Error('Managed inspection result exceeds its response limit; narrow the request');
      }
      return response;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await dependencyLease?.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (operationRoot) await rm(operationRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      activeOperations -= 1;
      if (activeOperations === 0) {
        for (const resolveWaiter of drainWaiters) resolveWaiter();
        drainWaiters.clear();
      }
      if (primaryError instanceof Error && cleanupErrors.length > 0) {
        const cleanupCause = new AggregateError(
          cleanupErrors,
          'Gitoxide managed inspection cleanup also failed',
        );
        if (primaryError.cause === undefined) {
          Object.defineProperty(primaryError, 'cause', {
            configurable: true,
            value: cleanupCause,
          });
        }
      }
      if (primaryError === undefined && cleanupErrors.length === 1) throw cleanupErrors[0];
      if (primaryError === undefined && cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'Gitoxide managed inspection cleanup failed');
      }
    }
  };

  const createTool = (
    repositoryProvider?: GitoxideInspectionRepositoryProviderInternal,
  ): MakaTool<GitoxideManagedInspectionInput, GitoxideManagedInspectionResult> => ({
    name: 'ManagedWorkspaceInspect',
    displayName: 'Inspect isolated workspace',
    description:
      'Read or glob a project through a Maka-owned Gitoxide accepted tree and its attested npm dependency environment. ' +
      'This operation may provision dependencies and is intentionally unavailable in read-only Plan Mode.',
    parameters: managedInspectionInputSchema,
    categoryHint: 'custom_tool',
    recoveryMode: 'never_auto_retry',
    executionSemantics: 'exclusive_step',
    impl: async (operation, context) =>
      execute(operation, context.cwd, context.abortSignal, repositoryProvider),
  });
  const tool = createTool();

  return Object.freeze({
    get state() {
      return state;
    },
    tool,
    toolForRepositoryProvider(provider: GitoxideInspectionRepositoryProviderInternal) {
      return createTool(provider);
    },
    beginDrain() {
      if (state === 'ready') state = 'draining';
    },
    close() {
      closeTask ??= (async () => {
        if (state === 'ready') state = 'draining';
        if (activeOperations > 0) {
          await new Promise<void>((resolveWaiter) => drainWaiters.add(resolveWaiter));
        }
        await input.dependencyAuthority.close();
        state = 'closed';
      })();
      return closeTask;
    },
  });
}

export async function tryOpenPackagedGitoxideManagedInspectionComposition(input: {
  readonly storageRoot: string;
  readonly filesystemWorker?: ManagedWorkspaceFilesystemWorker;
  readonly onUnavailable?: (error: unknown) => void;
}): Promise<GitoxideManagedInspectionComposition | undefined> {
  const resourcesRoot = runtimeHostPackagedResourcesRootInternal();
  if (!resourcesRoot || !input.filesystemWorker) return undefined;
  const invocationOwnerToken = {};
  try {
    const helperCapability = await resolvePackagedGitoxideHelperInternal({
      invocationOwnerToken,
    });
    const npmRuntime = await resolveBundledNpmRuntime({ resourcesRoot });
    const producerCapability = createManagedDependencyEnvironmentProducerCapability(
      npmRuntime.runtimeIdentitySha256,
    );
    const dependencyAuthority = await createManagedDependencyEnvironmentAuthority({
      storageRoot: input.storageRoot,
      producer: Object.freeze({
        capability: producerCapability,
        packageManagerName: 'npm' as const,
        packageManagerVersion: npmRuntime.npmVersion,
        nodeRuntime: Object.freeze({
          version: npmRuntime.nodeVersion,
          abi: npmRuntime.nodeAbi,
          platform: npmRuntime.platform,
          arch: npmRuntime.arch,
        }),
        provision: async (producerInput: ManagedDependencyEnvironmentProducerInput) =>
          runManagedNpmDependencyProvision({ producerInput, runtime: npmRuntime }),
      }),
    });
    try {
      return await createGitoxideManagedInspectionComposition({
        storageRoot: input.storageRoot,
        invocationOwnerToken,
        helperCapability,
        npmRuntime,
        dependencyAuthority,
        filesystemWorker: input.filesystemWorker,
      });
    } catch (error) {
      await dependencyAuthority.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    input.onUnavailable?.(error);
    return undefined;
  }
}

export function runtimeHostPackagedResourcesRootInternal(): string | undefined {
  if (!process.versions.electron) return undefined;
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string })
    .resourcesPath;
  return typeof resourcesPath === 'string' && isAbsolute(resourcesPath) ? resourcesPath : undefined;
}

interface InspectionRoute {
  readonly root: 'source_tree' | 'projection' | 'dependency';
  readonly logicalPath: string;
  readonly workerOperation: ManagedWorkspaceReadOnlyOperation;
  readonly executionBoundary: Parameters<
    ManagedWorkspaceFilesystemWorker['execute']
  >[0]['executionBoundary'];
}

function routeInspectionOperation(operation: GitoxideManagedInspectionInput): InspectionRoute {
  const canonicalPath = canonicalProjectPath(operation.path);
  const segments = canonicalPath === '.' ? [] : canonicalPath.split('/');
  const dependencyRoot =
    segments.length > 0 &&
    (process.platform === 'win32'
      ? segments[0]?.toLowerCase() === 'node_modules'
      : segments[0] === 'node_modules');
  const logicalPath = dependencyRoot
    ? ['node_modules', ...segments.slice(1)].join('/')
    : canonicalPath;
  const workerPath = dependencyRoot ? segments.slice(1).join('/') || '.' : canonicalPath;
  return Object.freeze({
    root: dependencyRoot ? 'dependency' : operation.kind === 'read' ? 'source_tree' : 'projection',
    logicalPath,
    workerOperation: Object.freeze({ ...operation, path: workerPath }),
    executionBoundary: createReadOnlyBoundary(),
  });
}

function sliceReadContent(content: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return content;
  const lines = content.split('\n');
  const start = offset ?? 0;
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join('\n');
}

function canonicalProjectPath(value: string): string {
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/u.test(value)
  ) {
    throw new TypeError('Managed inspection path must be a canonical project-relative path');
  }
  if (value === '.') return value;
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError('Managed inspection path must not contain empty, dot, or dot-dot segments');
  }
  const normalized = posix.normalize(value);
  if (normalized !== value) {
    throw new TypeError('Managed inspection path must already be canonical');
  }
  return normalized;
}

function remapInspectionResult(
  route: InspectionRoute,
  result: ManagedWorkspaceReadOnlyResult,
): ManagedWorkspaceReadOnlyResult {
  if (result.kind !== 'glob') return result;
  return Object.freeze({
    kind: 'glob' as const,
    files: Object.freeze(
      result.files.map((file) => {
        const relativeFile = canonicalWorkerResultPath(file);
        return route.logicalPath === '.'
          ? relativeFile
          : posix.join(route.logicalPath, relativeFile);
      }),
    ),
  });
}

function canonicalWorkerResultPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized)) {
    throw new Error('Filesystem worker returned a non-relative glob path');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('Filesystem worker returned a non-canonical glob path');
  }
  return posix.normalize(normalized);
}

function createReadOnlyBoundary(): Parameters<
  ManagedWorkspaceFilesystemWorker['execute']
>[0]['executionBoundary'] {
  return createManagedExecutionBoundary(createReadOnlyPermissionProfile(), 0);
}

function assertWithin(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new Error(`${label} escapes the Runtime Host storage root`);
}
