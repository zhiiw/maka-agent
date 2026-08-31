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

import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isCanonicalManagedMutationPathV1,
  MANAGED_OBSERVATION_EXECUTION_PROFILE_V2_DIGEST,
  type RuntimeEventManagedDependencyObservationV1,
  type RuntimeEventManagedObservationFileV1,
  type RuntimeEventManagedWorkspaceObservationV2,
} from '@maka/core/runtime-event';
import type { MakaTool, RuntimeManagedObservationAdmission } from '@maka/runtime/tool-runtime';
import { runWithStorageRootLease, type StorageRootLease } from '@maka/storage/root-authority';
import type {
  ManagedDependencySnapshotAuthority,
  ManagedDependencySnapshotLease,
} from '@maka/storage/managed-dependency-snapshot-authority';
import { z } from 'zod';
import type {
  ManagedCommandSandboxOwnerInternal,
  ManagedNodeTestObservationInternal,
} from './managed-command-sandbox-owner-internal.js';

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MANAGED_TEST_ROOT = 'managed-node-test-observations-v1';
const MAX_DEPENDENCY_METADATA_BYTES = 4 * 1024 * 1024;
const executionRootLeaseBrand: unique symbol = Symbol('ManagedNodeTestExecutionRootLease');

export interface ManagedNodeTestExecutionRootLeaseInternal {
  readonly [executionRootLeaseBrand]: true;
}

export interface ManagedNodeTestExecutionRootOwnerInternal {
  allocate(): Promise<ManagedNodeTestExecutionRootLeaseInternal>;
  release(lease: ManagedNodeTestExecutionRootLeaseInternal): Promise<void>;
}

interface ManagedNodeTestExecutionRootRecordInternal {
  readonly inputRoot: string;
  readonly scratchRoot: string;
  readonly release: () => Promise<void>;
  released: boolean;
}

const executionRootLeases = new WeakMap<object, ManagedNodeTestExecutionRootRecordInternal>();

export interface ManagedNodeTestAcceptedBoundaryInternal {
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceInstanceId: string;
  readonly acceptedWorkspaceVersionId: string;
  readonly acceptedEventId: string;
  readonly acceptedHeadRevision: number;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
}

export interface ManagedNodeTestSourceOwnerInternal {
  readAcceptedBoundary(abortSignal?: AbortSignal): Promise<ManagedNodeTestAcceptedBoundaryInternal>;
  materializeAcceptedTree(input: {
    readonly destinationPath: string;
    readonly acceptedCommitOid: string;
    readonly acceptedTreeOid: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<{
    readonly acceptedCommitOid: string;
    readonly acceptedTreeOid: string;
  }>;
}

export interface ManagedNodeTestAdmissionOwnerInternal {
  readonly tool: MakaTool<ManagedNodeTestArgsInternal, ManagedNodeTestObservationInternal>;
  admit(input: {
    readonly operationId: string;
    readonly toolName: string;
    readonly persistedArgs: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<RuntimeManagedObservationAdmission>;
}

export interface ManagedNodeTestDependencyOwnerInternal {
  acquire(input: {
    readonly acceptedInputRoot: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<ManagedDependencySnapshotLease | undefined>;
}

export function createManagedNodeTestDependencyOwnerInternal(input: {
  readonly sourceRoot: string;
  readonly snapshotAuthority: ManagedDependencySnapshotAuthority;
}): ManagedNodeTestDependencyOwnerInternal {
  return Object.freeze({
    async acquire(request: {
      readonly acceptedInputRoot: string;
      readonly abortSignal?: AbortSignal;
    }) {
      const { abortSignal } = request;
      abortSignal?.throwIfAborted();
      const sourceRoot = await realpath(input.sourceRoot);
      const sourceInfo = await lstat(sourceRoot);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
        throw new Error('Managed dependency source root is invalid');
      }
      const dependencyRoot = join(sourceRoot, 'node_modules');
      let dependencyInfo;
      try {
        dependencyInfo = await lstat(dependencyRoot);
      } catch (error) {
        if (isMissingPathError(error)) return undefined;
        throw error;
      }
      if (!dependencyInfo.isDirectory() || dependencyInfo.isSymbolicLink()) {
        throw new Error('Managed dependency source node_modules is invalid');
      }
      const [manifestBytes, lockfileBytes] = await Promise.all([
        readStableBoundedDependencyMetadata(
          join(request.acceptedInputRoot, 'package.json'),
          abortSignal,
        ),
        readStableBoundedDependencyMetadata(
          join(request.acceptedInputRoot, 'package-lock.json'),
          abortSignal,
        ),
      ]);
      abortSignal?.throwIfAborted();
      return await input.snapshotAuthority.acquire({
        sourceDependencyRoot: dependencyRoot,
        manifestBytes,
        lockfileBytes,
        ...(abortSignal ? { abortSignal } : {}),
      });
    },
  });
}

export interface ManagedNodeTestArgsInternal {
  readonly relativePaths: readonly string[];
}

const MANAGED_NODE_TEST_PARAMETERS = z
  .object({
    relativePaths: z
      .array(z.string())
      .min(1)
      .max(64)
      .describe('Sorted explicit .js, .mjs, or .cjs files from the accepted workspace'),
  })
  .strict();

export function createManagedNodeTestAdmissionOwnerInternal(input: {
  readonly executionRootOwner: ManagedNodeTestExecutionRootOwnerInternal;
  readonly sourceOwner: ManagedNodeTestSourceOwnerInternal;
  readonly commandOwner: ManagedCommandSandboxOwnerInternal;
  readonly dependencyOwner?: ManagedNodeTestDependencyOwnerInternal;
}): ManagedNodeTestAdmissionOwnerInternal {
  const admittedFilesByInputRoot = new Map<
    string,
    Readonly<{
      files: readonly RuntimeEventManagedObservationFileV1[];
      dependencyLease?: ManagedDependencySnapshotLease;
    }>
  >();
  const tool: MakaTool<ManagedNodeTestArgsInternal, ManagedNodeTestObservationInternal> = {
    name: 'ManagedNodeTest',
    displayName: 'Managed Node Test',
    description:
      'Run explicit Node test files against the immutable accepted workspace and an optional leased dependency snapshot. No package scripts, dependency installation, PATH tools, network, or child processes are available.',
    parameters: MANAGED_NODE_TEST_PARAMETERS,
    categoryHint: 'custom_tool',
    recoveryMode: 'replay_safe',
    durableExecutionProfile: 'managed_observation_v2',
    executionSemantics: 'exclusive_step',
    nesting: 'direct_only',
    impl: async () => {
      throw new Error('Managed Node test requires accepted-world admission');
    },
    managedObservationImpl: async (args, ctx, execution) => {
      const relativePaths = requireManagedNodeTestArgs(args);
      const admitted = admittedFilesByInputRoot.get(execution.inputRoot);
      if (!admitted) throw new Error('Managed Node test execution roots are not admitted');
      const observation = await input.commandOwner.runNodeTests({
        relativePaths,
        inputRoot: execution.inputRoot,
        scratchRoot: execution.scratchRoot,
        ...(admitted.dependencyLease ? { dependencyLease: admitted.dependencyLease } : {}),
        abortSignal: ctx.abortSignal,
      });
      assertExactFiles(observation.files, admitted.files);
      return observation;
    },
  };

  const owner: ManagedNodeTestAdmissionOwnerInternal = {
    tool: Object.freeze(tool),
    async admit(request) {
      request.abortSignal.throwIfAborted();
      if (
        request.toolName !== 'ManagedNodeTest' ||
        !OPERATION_ID_PATTERN.test(request.operationId)
      ) {
        throw new Error('Managed Node test admission identity is invalid');
      }
      const relativePaths = requireManagedNodeTestArgs(request.persistedArgs);
      const [boundary, toolchain] = await Promise.all([
        input.sourceOwner.readAcceptedBoundary(request.abortSignal),
        input.commandOwner.readToolchainIdentity(),
      ]);
      request.abortSignal.throwIfAborted();
      assertAcceptedBoundary(boundary);
      if (
        !SHA256_PATTERN.test(toolchain.identityDigest) ||
        !/^24\.[0-9]+\.[0-9]+$/u.test(toolchain.nodeVersion)
      ) {
        throw new Error('Managed Node test toolchain identity is invalid');
      }
      const executionRootLease = await input.executionRootOwner.allocate();
      const executionRoot = requireManagedNodeTestExecutionRootInternal(executionRootLease);
      const { inputRoot, scratchRoot } = executionRoot;
      let dependencyLease: ManagedDependencySnapshotLease | undefined;
      let admitted = false;
      try {
        await mkdir(scratchRoot);
        const materialized = await input.sourceOwner.materializeAcceptedTree({
          destinationPath: inputRoot,
          acceptedCommitOid: boundary.acceptedCommitOid,
          acceptedTreeOid: boundary.acceptedTreeOid,
          abortSignal: request.abortSignal,
        });
        if (
          materialized.acceptedCommitOid !== boundary.acceptedCommitOid ||
          materialized.acceptedTreeOid !== boundary.acceptedTreeOid
        ) {
          throw new Error('Managed Node test materialization conflicts with the accepted boundary');
        }
        const files: RuntimeEventManagedObservationFileV1[] = [];
        for (const relativePath of relativePaths) {
          request.abortSignal.throwIfAborted();
          const observed = await input.commandOwner.inspectFile({
            relativePath,
            inputRoot,
            scratchRoot,
            abortSignal: request.abortSignal,
          });
          if (observed.relativePath !== relativePath) {
            throw new Error('Managed Node test file observation identity is invalid');
          }
          files.push(
            Object.freeze({
              relativePath,
              bytes: observed.bytes,
              sha256: observed.sha256,
            }),
          );
        }
        dependencyLease = await input.dependencyOwner?.acquire({
          acceptedInputRoot: inputRoot,
          abortSignal: request.abortSignal,
        });
        request.abortSignal.throwIfAborted();
        const dependency = dependencyLease
          ? requireManagedDependencyObservation(
              await input.commandOwner.readDependencyIdentity(dependencyLease),
              toolchain,
            )
          : Object.freeze({ kind: 'none' as const });
        const durableDispatch: RuntimeEventManagedWorkspaceObservationV2 = Object.freeze({
          protocol: 'managed_observation_v2',
          ...boundary,
          objectFormat: 'sha1',
          operationKind: 'node_test_v2',
          effectClass: 'hermetic_observation_v2',
          executionProfileDigest: MANAGED_OBSERVATION_EXECUTION_PROFILE_V2_DIGEST,
          toolchainIdentityDigest: toolchain.identityDigest,
          dependency,
          files: Object.freeze(files),
        });
        let operation: Promise<unknown> | undefined;
        let state: 'ready' | 'running' | 'complete' | 'disposed' = 'ready';
        admittedFilesByInputRoot.set(
          inputRoot,
          Object.freeze({
            files: durableDispatch.files,
            ...(dependencyLease ? { dependencyLease } : {}),
          }),
        );
        admitted = true;
        return Object.freeze({
          durableDispatch,
          execute<T>(run: (execution: { inputRoot: string; scratchRoot: string }) => Promise<T>) {
            if (state !== 'ready') {
              return Promise.reject(
                new Error('Managed Node test admission is no longer executable'),
              );
            }
            state = 'running';
            const current = run(
              Object.freeze({
                inputRoot,
                scratchRoot,
              }),
            ).finally(() => {
              if (state === 'running') state = 'complete';
            });
            operation = current;
            return current;
          },
          async dispose() {
            if (state === 'disposed') return;
            await operation?.catch(() => undefined);
            state = 'disposed';
            admittedFilesByInputRoot.delete(inputRoot);
            try {
              await dependencyLease?.release();
            } finally {
              await input.executionRootOwner.release(executionRootLease);
            }
          },
        });
      } finally {
        if (!admitted) {
          try {
            await dependencyLease?.release();
          } finally {
            await input.executionRootOwner.release(executionRootLease);
          }
        }
      }
    },
  };
  return Object.freeze(owner);
}

/**
 * Tool-surface declaration used only while resolving continuation safety.
 * The returned tool cannot execute; production execution still requires the
 * session-bound admission owner above.
 */
export function createManagedNodeTestToolDeclarationInternal(): MakaTool<
  ManagedNodeTestArgsInternal,
  ManagedNodeTestObservationInternal
> {
  return Object.freeze({
    name: 'ManagedNodeTest',
    displayName: 'Managed Node Test',
    description:
      'Run explicit Node test files against the immutable accepted workspace and an optional leased dependency snapshot. No package scripts, dependency installation, PATH tools, network, or child processes are available.',
    parameters: MANAGED_NODE_TEST_PARAMETERS,
    categoryHint: 'custom_tool',
    recoveryMode: 'replay_safe',
    durableExecutionProfile: 'managed_observation_v2',
    executionSemantics: 'exclusive_step',
    nesting: 'direct_only',
    impl: async () => {
      throw new Error('Managed Node test declaration cannot execute without session admission');
    },
    managedObservationImpl: async () => {
      throw new Error('Managed Node test declaration cannot execute without session admission');
    },
  });
}

export function createManagedNodeTestExecutionRootOwnerInternal(input: {
  readonly storageRootLease: StorageRootLease<'interactive', 'write'>;
}): ManagedNodeTestExecutionRootOwnerInternal {
  return Object.freeze({
    async allocate() {
      let publishLease!: (lease: ManagedNodeTestExecutionRootLeaseInternal) => void;
      let rejectLease!: (error: unknown) => void;
      const leasePublished = new Promise<ManagedNodeTestExecutionRootLeaseInternal>(
        (resolve, reject) => {
          publishLease = resolve;
          rejectLease = reject;
        },
      );
      let releaseLifetime!: () => void;
      const lifetimeReleased = new Promise<void>((resolve) => {
        releaseLifetime = resolve;
      });
      let lifetime: Promise<void>;
      lifetime = runWithStorageRootLease(
        input.storageRootLease,
        'interactive',
        'write',
        async (storageRoot) => {
          const ownerRoot = join(storageRoot, MANAGED_TEST_ROOT);
          await mkdir(ownerRoot, { recursive: true });
          const ownerRootStat = await lstat(ownerRoot);
          if (!ownerRootStat.isDirectory() || ownerRootStat.isSymbolicLink()) {
            throw new Error('Managed Node test execution-root authority is invalid');
          }
          const canonicalOwnerRoot = await realpath(ownerRoot);
          if (!samePath(canonicalOwnerRoot, ownerRoot)) {
            throw new Error('Managed Node test execution-root authority escaped its storage root');
          }
          const executionRoot = await mkdtemp(join(canonicalOwnerRoot, 'observation-'));
          const inputRoot = join(executionRoot, 'input');
          const scratchRoot = join(executionRoot, 'scratch');
          const lease = Object.freeze({
            [executionRootLeaseBrand]: true as const,
          });
          const record: ManagedNodeTestExecutionRootRecordInternal = {
            inputRoot,
            scratchRoot,
            released: false,
            async release() {
              if (record.released) return;
              record.released = true;
              releaseLifetime();
              await lifetime;
            },
          };
          executionRootLeases.set(lease, record);
          publishLease(lease);
          try {
            await lifetimeReleased;
          } finally {
            executionRootLeases.delete(lease);
            await rm(executionRoot, { recursive: true, force: true });
          }
        },
      );
      lifetime.catch(rejectLease);
      return await leasePublished;
    },
    async release(lease: ManagedNodeTestExecutionRootLeaseInternal) {
      await requireManagedNodeTestExecutionRootInternal(lease).release();
    },
  });
}

function requireManagedNodeTestExecutionRootInternal(
  lease: ManagedNodeTestExecutionRootLeaseInternal,
): ManagedNodeTestExecutionRootRecordInternal {
  const record = executionRootLeases.get(lease);
  if (!record || record.released) {
    throw new Error('Managed Node test execution-root lease is invalid');
  }
  return record;
}

export function readManagedObservationExecutionRootInternal(
  lease: ManagedNodeTestExecutionRootLeaseInternal,
): Readonly<{ inputRoot: string; scratchRoot: string }> {
  const record = requireManagedNodeTestExecutionRootInternal(lease);
  return Object.freeze({ inputRoot: record.inputRoot, scratchRoot: record.scratchRoot });
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function readStableBoundedDependencyMetadata(
  path: string,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  abortSignal?.throwIfAborted();
  const lexical = await lstat(path);
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw new Error('Managed dependency metadata file is invalid');
  }
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_DEPENDENCY_METADATA_BYTES) {
      throw new Error('Managed dependency metadata file is invalid or too large');
    }
    const bytes = await file.readFile();
    abortSignal?.throwIfAborted();
    const after = await file.stat();
    if (
      bytes.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('Managed dependency metadata changed while read');
    }
    return bytes;
  } finally {
    await file.close();
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function requireManagedNodeTestArgs(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Managed Node test arguments are invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'relativePaths' || !Array.isArray(record.relativePaths)) {
    throw new Error('Managed Node test arguments are invalid');
  }
  const relativePaths = record.relativePaths;
  if (
    relativePaths.length === 0 ||
    relativePaths.length > 64 ||
    !relativePaths.every(
      (path, index) =>
        typeof path === 'string' &&
        isCanonicalManagedMutationPathV1(path) &&
        /\.(?:cjs|mjs|js)$/u.test(path) &&
        (index === 0 || path > (relativePaths[index - 1] as string)),
    )
  ) {
    throw new Error('Managed Node test arguments must be sorted, unique canonical test paths');
  }
  return Object.freeze([...relativePaths] as string[]);
}

function assertAcceptedBoundary(boundary: ManagedNodeTestAcceptedBoundaryInternal): void {
  if (
    !/^repository_[0-9a-f]{32}$/u.test(boundary.repositoryId) ||
    !/^workspace_[0-9a-f]{32}$/u.test(boundary.workspaceId) ||
    !/^epoch_[0-9a-f]{32}$/u.test(boundary.workspaceEpochId) ||
    !/^instance_[0-9a-f]{32}$/u.test(boundary.workspaceInstanceId) ||
    !/^version_[0-9a-f]{32}$/u.test(boundary.acceptedWorkspaceVersionId) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(boundary.acceptedEventId) ||
    !Number.isSafeInteger(boundary.acceptedHeadRevision) ||
    boundary.acceptedHeadRevision < 1 ||
    !SHA1_PATTERN.test(boundary.acceptedCommitOid) ||
    !SHA1_PATTERN.test(boundary.acceptedTreeOid)
  ) {
    throw new Error('Managed Node test accepted boundary is invalid');
  }
}

function requireManagedDependencyObservation(
  dependency: Readonly<{
    environmentId: `sha256:${string}`;
    contentTreeSha256: `sha256:${string}`;
    nodeVersion: string;
    nodeAbi: string;
    platform: NodeJS.Platform;
    arch: string;
  }>,
  toolchain: Readonly<{
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  }>,
): RuntimeEventManagedDependencyObservationV1 {
  if (
    !SHA256_PATTERN.test(dependency.environmentId) ||
    !SHA256_PATTERN.test(dependency.contentTreeSha256) ||
    dependency.nodeVersion !== toolchain.nodeVersion ||
    dependency.platform !== toolchain.platform ||
    dependency.arch !== toolchain.arch ||
    !/^[0-9]{2,4}$/u.test(dependency.nodeAbi) ||
    !['linux', 'darwin', 'win32'].includes(dependency.platform) ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(dependency.arch)
  ) {
    throw new Error('Managed Node test dependency snapshot identity is invalid');
  }
  return Object.freeze({
    kind: 'managed_dependency_snapshot_v1' as const,
    environmentId: dependency.environmentId,
    contentTreeSha256: dependency.contentTreeSha256,
    nodeVersion: dependency.nodeVersion,
    nodeAbi: dependency.nodeAbi,
    platform: dependency.platform as 'linux' | 'darwin' | 'win32',
    arch: dependency.arch,
  });
}

function assertExactFiles(
  actual: readonly RuntimeEventManagedObservationFileV1[],
  expected: readonly RuntimeEventManagedObservationFileV1[],
): void {
  if (
    actual.length !== expected.length ||
    !actual.every(
      (file, index) =>
        file.relativePath === expected[index]?.relativePath &&
        file.bytes === expected[index]?.bytes &&
        file.sha256 === expected[index]?.sha256,
    )
  ) {
    throw new Error('Managed Node test input changed after durable admission');
  }
}
