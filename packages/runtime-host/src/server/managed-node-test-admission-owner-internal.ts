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

import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isCanonicalManagedMutationPathV1,
  MANAGED_OBSERVATION_EXECUTION_PROFILE_V1_DIGEST,
  type RuntimeEventManagedObservationFileV1,
  type RuntimeEventManagedWorkspaceObservationV1,
} from '@maka/core/runtime-event';
import type { MakaTool, RuntimeManagedObservationAdmission } from '@maka/runtime/tool-runtime';
import { runWithStorageRootLease, type StorageRootLease } from '@maka/storage/root-authority';
import { z } from 'zod';
import type {
  ManagedCommandSandboxOwnerInternal,
  ManagedNodeTestObservationInternal,
} from './managed-command-sandbox-owner-internal.js';

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MANAGED_TEST_ROOT = 'managed-node-test-observations-v1';
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
}): ManagedNodeTestAdmissionOwnerInternal {
  const admittedFilesByInputRoot = new Map<
    string,
    readonly RuntimeEventManagedObservationFileV1[]
  >();
  const tool: MakaTool<ManagedNodeTestArgsInternal, ManagedNodeTestObservationInternal> = {
    name: 'ManagedNodeTest',
    displayName: 'Managed Node Test',
    description:
      'Run explicit Node test files against the immutable accepted workspace. No package scripts, dependency installation, PATH tools, network, or child processes are available.',
    parameters: MANAGED_NODE_TEST_PARAMETERS,
    categoryHint: 'custom_tool',
    recoveryMode: 'replay_safe',
    durableExecutionProfile: 'managed_observation_v1',
    executionSemantics: 'exclusive_step',
    nesting: 'direct_only',
    impl: async () => {
      throw new Error('Managed Node test requires accepted-world admission');
    },
    managedObservationImpl: async (args, ctx, execution) => {
      const relativePaths = requireManagedNodeTestArgs(args);
      const observation = await input.commandOwner.runNodeTests({
        relativePaths,
        inputRoot: execution.inputRoot,
        scratchRoot: execution.scratchRoot,
        abortSignal: ctx.abortSignal,
      });
      const expectedFiles = admittedFilesByInputRoot.get(execution.inputRoot);
      if (!expectedFiles) throw new Error('Managed Node test execution roots are not admitted');
      assertExactFiles(observation.files, expectedFiles);
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
        const durableDispatch: RuntimeEventManagedWorkspaceObservationV1 = Object.freeze({
          protocol: 'managed_observation_v1',
          ...boundary,
          objectFormat: 'sha1',
          operationKind: 'node_test_v1',
          effectClass: 'hermetic_observation_v1',
          executionProfileDigest: MANAGED_OBSERVATION_EXECUTION_PROFILE_V1_DIGEST,
          toolchainIdentityDigest: toolchain.identityDigest,
          files: Object.freeze(files),
        });
        let operation: Promise<unknown> | undefined;
        let state: 'ready' | 'running' | 'complete' | 'disposed' = 'ready';
        admittedFilesByInputRoot.set(inputRoot, durableDispatch.files);
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
            await input.executionRootOwner.release(executionRootLease);
          },
        });
      } finally {
        if (!admitted) await input.executionRootOwner.release(executionRootLease);
      }
    },
  };
  return Object.freeze(owner);
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

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
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
