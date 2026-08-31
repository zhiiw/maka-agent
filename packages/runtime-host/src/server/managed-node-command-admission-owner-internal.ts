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

import {
  isCanonicalManagedMutationPathV1,
  MANAGED_OBSERVATION_EXECUTION_PROFILE_V2_DIGEST,
  type RuntimeEventManagedObservationFileV1,
  type RuntimeEventManagedWorkspaceNodeCommandObservationV2,
} from '@maka/core/runtime-event';
import { mkdir } from 'node:fs/promises';
import type { MakaTool, RuntimeManagedObservationAdmission } from '@maka/runtime/tool-runtime';
import type { ManagedDependencySnapshotLease } from '@maka/storage/managed-dependency-snapshot-authority';
import { z } from 'zod';
import type {
  ManagedCommandSandboxOwnerInternal,
  ManagedNodeCommandObservationInternal,
} from './managed-command-sandbox-owner-internal.js';
import {
  readManagedObservationExecutionRootInternal,
  requireManagedDependencyObservationInternal,
  type ManagedNodeDependencyOwnerInternal,
  type ManagedNodeTestAcceptedBoundaryInternal,
  type ManagedNodeTestExecutionRootOwnerInternal,
  type ManagedNodeTestSourceOwnerInternal,
} from './managed-node-test-admission-owner-internal.js';

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface ManagedNodeCommandArgsInternal {
  readonly entryPath: string;
  readonly args?: readonly string[];
}

export interface ManagedNodeCommandAdmissionOwnerInternal {
  readonly tool: MakaTool<ManagedNodeCommandArgsInternal, ManagedNodeCommandObservationInternal>;
  admit(input: {
    readonly operationId: string;
    readonly toolName: string;
    readonly persistedArgs: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<RuntimeManagedObservationAdmission>;
}

const MANAGED_NODE_COMMAND_PARAMETERS = z
  .object({
    entryPath: z
      .string()
      .describe('One explicit .js, .mjs, or .cjs entrypoint from the accepted workspace'),
    args: z
      .array(z.string())
      .max(64)
      .optional()
      .describe('Bounded arguments passed to the entrypoint'),
  })
  .strict();

export function createManagedNodeCommandAdmissionOwnerInternal(input: {
  readonly executionRootOwner: ManagedNodeTestExecutionRootOwnerInternal;
  readonly sourceOwner: ManagedNodeTestSourceOwnerInternal;
  readonly commandOwner: ManagedCommandSandboxOwnerInternal;
  readonly dependencyOwner?: ManagedNodeDependencyOwnerInternal;
}): ManagedNodeCommandAdmissionOwnerInternal {
  const admittedByInputRoot = new Map<
    string,
    Readonly<{
      entry: RuntimeEventManagedObservationFileV1;
      args: readonly string[];
      dependencyLease?: ManagedDependencySnapshotLease;
    }>
  >();
  const tool: MakaTool<ManagedNodeCommandArgsInternal, ManagedNodeCommandObservationInternal> = {
    name: 'ManagedNodeRun',
    displayName: 'Managed Node Run',
    description:
      'Run one explicit JavaScript entrypoint from the immutable accepted workspace with an optional immutable dependency snapshot. It has no PATH, network, child-process, package-script, dependency-installation, or attached-checkout authority; writes are disposable scratch only.',
    parameters: MANAGED_NODE_COMMAND_PARAMETERS,
    categoryHint: 'custom_tool',
    recoveryMode: 'replay_safe',
    durableExecutionProfile: 'managed_observation_v2',
    executionSemantics: 'exclusive_step',
    nesting: 'direct_only',
    impl: async () => {
      throw new Error('Managed Node command requires accepted-world admission');
    },
    managedObservationImpl: async (args, ctx, execution) => {
      const normalized = requireManagedNodeCommandArgs(args);
      const admitted = admittedByInputRoot.get(execution.inputRoot);
      if (
        !admitted ||
        normalized.entryPath !== admitted.entry.relativePath ||
        !sameArgs(normalized.args, admitted.args)
      ) {
        throw new Error('Managed Node command execution roots are not admitted');
      }
      const run = input.commandOwner.runNodeEntrypoint;
      if (!run) throw new Error('Managed Node command sandbox authority is unavailable');
      const observation = await run({
        entryPath: normalized.entryPath,
        args: normalized.args,
        inputRoot: execution.inputRoot,
        scratchRoot: execution.scratchRoot,
        ...(admitted.dependencyLease ? { dependencyLease: admitted.dependencyLease } : {}),
        abortSignal: ctx.abortSignal,
      });
      if (!sameEntry(observation.entry, admitted.entry)) {
        throw new Error('Managed Node command entry changed after durable admission');
      }
      return observation;
    },
  };

  return Object.freeze({
    tool: Object.freeze(tool),
    async admit(request: {
      readonly operationId: string;
      readonly toolName: string;
      readonly persistedArgs: unknown;
      readonly abortSignal: AbortSignal;
    }) {
      request.abortSignal.throwIfAborted();
      if (
        request.toolName !== 'ManagedNodeRun' ||
        !OPERATION_ID_PATTERN.test(request.operationId) ||
        !input.commandOwner.runNodeEntrypoint
      ) {
        throw new Error('Managed Node command admission identity is invalid');
      }
      const normalized = requireManagedNodeCommandArgs(request.persistedArgs);
      const [boundary, toolchain] = await Promise.all([
        input.sourceOwner.readAcceptedBoundary(request.abortSignal),
        input.commandOwner.readToolchainIdentity('hermetic_observation_v2'),
      ]);
      assertAcceptedBoundary(boundary);
      if (
        !SHA256_PATTERN.test(toolchain.identityDigest) ||
        !/^24\.[0-9]+\.[0-9]+$/u.test(toolchain.nodeVersion)
      ) {
        throw new Error('Managed Node command toolchain identity is invalid');
      }
      const lease = await input.executionRootOwner.allocate();
      const executionRoot = readManagedObservationExecutionRootInternal(lease);
      let dependencyLease: ManagedDependencySnapshotLease | undefined;
      let admitted = false;
      try {
        const materialized = await input.sourceOwner.materializeAcceptedTree({
          destinationPath: executionRoot.inputRoot,
          acceptedCommitOid: boundary.acceptedCommitOid,
          acceptedTreeOid: boundary.acceptedTreeOid,
          abortSignal: request.abortSignal,
        });
        if (
          materialized.acceptedCommitOid !== boundary.acceptedCommitOid ||
          materialized.acceptedTreeOid !== boundary.acceptedTreeOid
        ) {
          throw new Error('Managed Node command materialization conflicts with accepted truth');
        }
        await mkdir(executionRoot.scratchRoot);
        dependencyLease = await input.dependencyOwner?.acquire({
          acceptedInputRoot: executionRoot.inputRoot,
          abortSignal: request.abortSignal,
        });
        const dependency = dependencyLease
          ? requireManagedDependencyObservationInternal(
              await input.commandOwner.readDependencyIdentity(dependencyLease),
              toolchain,
            )
          : Object.freeze({ kind: 'none' as const });
        const observed = await input.commandOwner.inspectFile({
          relativePath: normalized.entryPath,
          inputRoot: executionRoot.inputRoot,
          scratchRoot: executionRoot.scratchRoot,
          effectClass: 'hermetic_observation_v2',
          abortSignal: request.abortSignal,
        });
        const entry = Object.freeze({
          relativePath: observed.relativePath,
          bytes: observed.bytes,
          sha256: observed.sha256,
        });
        if (entry.relativePath !== normalized.entryPath) {
          throw new Error('Managed Node command entry identity is invalid');
        }
        const durableDispatch: RuntimeEventManagedWorkspaceNodeCommandObservationV2 = Object.freeze(
          {
            protocol: 'managed_observation_v2',
            ...boundary,
            objectFormat: 'sha1',
            operationKind: 'node_command_v2',
            effectClass: 'hermetic_observation_v2',
            executionProfileDigest: MANAGED_OBSERVATION_EXECUTION_PROFILE_V2_DIGEST,
            toolchainIdentityDigest: toolchain.identityDigest,
            dependency,
            entry,
            args: normalized.args,
          },
        );
        let operation: Promise<unknown> | undefined;
        let state: 'ready' | 'running' | 'complete' | 'disposed' = 'ready';
        admittedByInputRoot.set(
          executionRoot.inputRoot,
          Object.freeze({
            entry,
            args: normalized.args,
            ...(dependencyLease ? { dependencyLease } : {}),
          }),
        );
        admitted = true;
        return Object.freeze({
          durableDispatch,
          execute<T>(run: (execution: { inputRoot: string; scratchRoot: string }) => Promise<T>) {
            if (state !== 'ready') {
              return Promise.reject(
                new Error('Managed Node command admission is no longer executable'),
              );
            }
            state = 'running';
            const current = run(executionRoot).finally(() => {
              if (state === 'running') state = 'complete';
            });
            operation = current;
            return current;
          },
          async dispose() {
            if (state === 'disposed') return;
            await operation?.catch(() => undefined);
            state = 'disposed';
            admittedByInputRoot.delete(executionRoot.inputRoot);
            try {
              await dependencyLease?.release();
            } finally {
              await input.executionRootOwner.release(lease);
            }
          },
        });
      } finally {
        if (!admitted) {
          try {
            await dependencyLease?.release();
          } finally {
            await input.executionRootOwner.release(lease);
          }
        }
      }
    },
  });
}

export function createManagedNodeCommandToolDeclarationInternal(): MakaTool<
  ManagedNodeCommandArgsInternal,
  ManagedNodeCommandObservationInternal
> {
  const ownerUnavailable = async (): Promise<never> => {
    throw new Error('Managed Node command declaration cannot execute without session admission');
  };
  return Object.freeze({
    name: 'ManagedNodeRun',
    displayName: 'Managed Node Run',
    description:
      'Run one explicit JavaScript entrypoint from the immutable accepted workspace with an optional immutable dependency snapshot, without PATH, network, child-process, package-script, dependency-installation, or attached-checkout authority.',
    parameters: MANAGED_NODE_COMMAND_PARAMETERS,
    categoryHint: 'custom_tool',
    recoveryMode: 'replay_safe',
    durableExecutionProfile: 'managed_observation_v2',
    executionSemantics: 'exclusive_step',
    nesting: 'direct_only',
    impl: ownerUnavailable,
    managedObservationImpl: ownerUnavailable,
  });
}

function requireManagedNodeCommandArgs(value: unknown): Readonly<{
  entryPath: string;
  args: readonly string[];
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Managed Node command arguments are invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length < 1 ||
    keys.length > 2 ||
    !keys.includes('entryPath') ||
    keys.some((key) => key !== 'entryPath' && key !== 'args') ||
    typeof record.entryPath !== 'string' ||
    !isCanonicalManagedMutationPathV1(record.entryPath) ||
    !/\.(?:cjs|mjs|js)$/u.test(record.entryPath)
  ) {
    throw new Error('Managed Node command entrypoint is invalid');
  }
  const args = record.args === undefined ? [] : record.args;
  if (!Array.isArray(args) || args.length > 64) {
    throw new Error('Managed Node command argument list is invalid');
  }
  let totalBytes = 0;
  for (const argument of args) {
    if (typeof argument !== 'string') throw new Error('Managed Node command argument is invalid');
    const bytes = Buffer.byteLength(argument, 'utf8');
    if (bytes > 4096) throw new Error('Managed Node command argument is too large');
    totalBytes += bytes;
    if (totalBytes > 32_768) throw new Error('Managed Node command arguments are too large');
  }
  return Object.freeze({
    entryPath: record.entryPath,
    args: Object.freeze([...args] as string[]),
  });
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
    throw new Error('Managed Node command accepted boundary is invalid');
  }
}

function sameEntry(
  left: RuntimeEventManagedObservationFileV1,
  right: RuntimeEventManagedObservationFileV1,
): boolean {
  return (
    left.relativePath === right.relativePath &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
