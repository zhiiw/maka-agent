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
  MANAGED_MUTATION_EXECUTION_PROFILE_V2_DIGEST,
  type RuntimeEventManagedObservationFileV1,
  type RuntimeEventManagedWorkspaceNodeTransformMutationV2,
} from '@maka/core/runtime-event';
import type {
  WorkspaceEpochRecordV1,
  WorkspaceHeadRecordV1,
} from '@maka/core/workspace-version-authority';
import type {
  MakaTool,
  MakaToolContext,
  RuntimeManagedMutationResultProof,
} from '@maka/runtime/tool-runtime';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { GitoxideManagedNodeTransformAdmissionInternal } from './gitoxide-managed-write-edit-owner-internal.js';
import type {
  ManagedCommandSandboxOwnerInternal,
  ManagedNodeTransformResultInternal,
} from './managed-command-sandbox-owner-internal.js';
import {
  readManagedObservationExecutionRootInternal,
  type ManagedNodeTestExecutionRootOwnerInternal,
  type ManagedNodeTestSourceOwnerInternal,
} from './managed-node-test-admission-owner-internal.js';

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface ManagedNodeTransformArgsInternal {
  readonly entryPath: string;
  readonly path: string;
  readonly args?: readonly string[];
}

export interface ManagedNodeTransformOwnerInternal {
  readonly tool: MakaTool<ManagedNodeTransformArgsInternal, unknown>;
  readonly admission: GitoxideManagedNodeTransformAdmissionInternal;
}

const PARAMETERS = z
  .object({
    entryPath: z.string().describe('One explicit JavaScript transformer from the accepted tree'),
    path: z.string().describe('One canonical accepted-workspace output path'),
    args: z.array(z.string()).max(64).optional(),
  })
  .strict();

export function createManagedNodeTransformOwnerInternal(input: {
  readonly executionRootOwner: ManagedNodeTestExecutionRootOwnerInternal;
  readonly sourceOwner: ManagedNodeTestSourceOwnerInternal;
  readonly commandOwner: ManagedCommandSandboxOwnerInternal;
}): ManagedNodeTransformOwnerInternal {
  const prepared = new Map<string, PreparedTransform>();
  const tool: MakaTool<ManagedNodeTransformArgsInternal, unknown> = Object.freeze({
    name: 'ManagedNodeTransform',
    displayName: 'Managed Node Transform',
    description:
      'Run one accepted-tree JavaScript transformer and publish exactly one bounded UTF-8 output through Gitoxide and the durable workspace successor authority.',
    parameters: PARAMETERS,
    categoryHint: 'custom_tool',
    recoveryMode: 'reconcile',
    durableExecutionProfile: 'managed_mutation_v2',
    executionSemantics: 'exclusive_step',
    nesting: 'direct_only',
    impl: async () => {
      throw new Error('Managed Node transform requires owner admission');
    },
    managedWorkspaceTransform: async (
      rawArgs: ManagedNodeTransformArgsInternal,
      context: MakaToolContext,
    ) => {
      const args = requireArgs(rawArgs);
      const operationId = context.operationId;
      const state = operationId ? prepared.get(operationId) : undefined;
      if (
        !state ||
        state.executed ||
        args.entryPath !== state.entry.relativePath ||
        args.path !== state.path ||
        !sameArgs(args.args, state.args)
      ) {
        throw new Error('Managed Node transform execution capability is unavailable');
      }
      state.executed = true;
      const run = input.commandOwner.runNodeTransform;
      if (!run) throw new Error('Managed Node transform sandbox authority is unavailable');
      const result = await run({
        entryPath: args.entryPath,
        outputPath: args.path,
        args: args.args,
        inputRoot: state.inputRoot,
        scratchRoot: state.scratchRoot,
        abortSignal: context.abortSignal,
      });
      assertResult(result, state);
      const mutationResult: RuntimeManagedMutationResultProof = Object.freeze({
        path: state.path,
        content: result.content,
        changed: result.content !== state.baseContent,
      });
      return Object.freeze({
        result: Object.freeze({
          protocolVersion: 1,
          kind: 'workspace_transform',
          path: result.path,
          bytes: result.bytes,
          sha256: result.sha256,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
        mutationResult,
      });
    },
  });

  const admission: GitoxideManagedNodeTransformAdmissionInternal = Object.freeze({
    async prepare({
      request,
      head,
      epoch,
    }: Parameters<GitoxideManagedNodeTransformAdmissionInternal['prepare']>[0]) {
      request.abortSignal.throwIfAborted();
      if (
        request.toolName !== 'ManagedNodeTransform' ||
        !OPERATION_ID_PATTERN.test(request.operationId) ||
        !input.commandOwner.runNodeTransform ||
        prepared.has(request.operationId)
      ) {
        throw new Error('Managed Node transform admission identity is invalid');
      }
      const args = requireArgs(request.persistedArgs);
      const [boundary, toolchain] = await Promise.all([
        input.sourceOwner.readAcceptedBoundary(request.abortSignal),
        input.commandOwner.readToolchainIdentity('workspace_transform_v1'),
      ]);
      assertBoundary(boundary, head, epoch);
      if (!SHA256_PATTERN.test(toolchain.identityDigest)) {
        throw new Error('Managed Node transform toolchain identity is invalid');
      }
      const lease = await input.executionRootOwner.allocate();
      const executionRoot = readManagedObservationExecutionRootInternal(lease);
      let installed = false;
      try {
        const materialized = await input.sourceOwner.materializeAcceptedTree({
          destinationPath: executionRoot.inputRoot,
          acceptedCommitOid: head.commitOid,
          acceptedTreeOid: head.treeOid,
          abortSignal: request.abortSignal,
        });
        if (
          materialized.acceptedCommitOid !== head.commitOid ||
          materialized.acceptedTreeOid !== head.treeOid
        ) {
          throw new Error('Managed Node transform materialization conflicts with accepted truth');
        }
        await mkdir(executionRoot.scratchRoot);
        const observed = await input.commandOwner.inspectFile({
          relativePath: args.entryPath,
          inputRoot: executionRoot.inputRoot,
          scratchRoot: executionRoot.scratchRoot,
          effectClass: 'workspace_transform_v1',
          abortSignal: request.abortSignal,
        });
        const entry = Object.freeze({
          relativePath: observed.relativePath,
          bytes: observed.bytes,
          sha256: observed.sha256,
        });
        if (entry.relativePath !== args.entryPath) {
          throw new Error('Managed Node transform entry identity is invalid');
        }
        const baseContent = await readOptionalBoundedText(executionRoot.inputRoot, args.path);
        const state: PreparedTransform = {
          inputRoot: executionRoot.inputRoot,
          scratchRoot: executionRoot.scratchRoot,
          entry,
          path: args.path,
          args: args.args,
          baseContent,
          executed: false,
        };
        prepared.set(request.operationId, state);
        installed = true;
        const durableDispatch: RuntimeEventManagedWorkspaceNodeTransformMutationV2 = Object.freeze({
          protocol: 'managed_mutation_v2',
          repositoryId: head.repositoryId,
          workspaceId: head.workspaceId,
          workspaceEpochId: head.workspaceEpochId,
          workspaceInstanceId: epoch.workspaceInstanceId,
          objectFormat: 'sha1',
          baseWorkspaceVersionId: head.workspaceVersionId,
          baseAcceptedEventId: head.acceptedEventId,
          baseHeadRevision: head.revision,
          baseCommitOid: head.commitOid,
          baseTreeOid: head.treeOid,
          expectedPath: args.path,
          pathPolicyVersion: 3,
          operationKind: 'node_transform_v2',
          executionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V2_DIGEST,
          toolchainIdentityDigest: toolchain.identityDigest,
          entry,
          args: args.args,
        });
        return Object.freeze({
          durableDispatch,
          async dispose() {
            prepared.delete(request.operationId);
            await input.executionRootOwner.release(lease);
          },
        });
      } finally {
        if (!installed) await input.executionRootOwner.release(lease);
      }
    },
  });
  return Object.freeze({ tool, admission });
}

export function createManagedNodeTransformToolDeclarationInternal(): MakaTool<
  ManagedNodeTransformArgsInternal,
  unknown
> {
  const unavailable = async (): Promise<never> => {
    throw new Error('Managed Node transform declaration cannot execute without session admission');
  };
  return Object.freeze({
    name: 'ManagedNodeTransform',
    displayName: 'Managed Node Transform',
    description:
      'Run one accepted-tree JavaScript transformer and publish exactly one bounded UTF-8 output through Gitoxide and the durable workspace successor authority.',
    parameters: PARAMETERS,
    categoryHint: 'custom_tool',
    recoveryMode: 'reconcile',
    durableExecutionProfile: 'managed_mutation_v2',
    executionSemantics: 'exclusive_step',
    nesting: 'direct_only',
    impl: unavailable,
    managedWorkspaceTransform: unavailable,
  });
}

interface PreparedTransform {
  readonly inputRoot: string;
  readonly scratchRoot: string;
  readonly entry: RuntimeEventManagedObservationFileV1;
  readonly path: string;
  readonly args: readonly string[];
  readonly baseContent: string | null;
  executed: boolean;
}

function requireArgs(
  value: unknown,
): Readonly<{ entryPath: string; path: string; args: readonly string[] }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Managed Node transform arguments are invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const rawArgs = record.args ?? [];
  if (
    keys.length < 2 ||
    keys.length > 3 ||
    keys.some((key) => key !== 'entryPath' && key !== 'path' && key !== 'args') ||
    typeof record.entryPath !== 'string' ||
    !isCanonicalManagedMutationPathV1(record.entryPath) ||
    !/\.(?:cjs|mjs|js)$/u.test(record.entryPath) ||
    !isCanonicalManagedMutationPathV1(record.path) ||
    !Array.isArray(rawArgs) ||
    rawArgs.length > 64
  ) {
    throw new Error('Managed Node transform arguments are invalid');
  }
  let bytes = 0;
  for (const value of rawArgs) {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) {
      throw new Error('Managed Node transform argument is invalid');
    }
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > 32_768) throw new Error('Managed Node transform arguments are too large');
  }
  return Object.freeze({
    entryPath: record.entryPath,
    path: record.path,
    args: Object.freeze([...rawArgs] as string[]),
  });
}

function assertBoundary(
  boundary: Awaited<ReturnType<ManagedNodeTestSourceOwnerInternal['readAcceptedBoundary']>>,
  head: WorkspaceHeadRecordV1,
  epoch: WorkspaceEpochRecordV1,
): void {
  if (
    boundary.repositoryId !== head.repositoryId ||
    boundary.workspaceId !== head.workspaceId ||
    boundary.workspaceEpochId !== head.workspaceEpochId ||
    boundary.workspaceInstanceId !== epoch.workspaceInstanceId ||
    boundary.acceptedWorkspaceVersionId !== head.workspaceVersionId ||
    boundary.acceptedEventId !== head.acceptedEventId ||
    boundary.acceptedHeadRevision !== head.revision ||
    boundary.acceptedCommitOid !== head.commitOid ||
    boundary.acceptedTreeOid !== head.treeOid ||
    !SHA1_PATTERN.test(head.commitOid) ||
    !SHA1_PATTERN.test(head.treeOid)
  ) {
    throw new Error('Managed Node transform accepted boundary is invalid');
  }
}

function assertResult(result: ManagedNodeTransformResultInternal, state: PreparedTransform): void {
  if (
    result.kind !== 'workspace_transform' ||
    result.protocolVersion !== 1 ||
    result.path !== state.path ||
    result.entry.relativePath !== state.entry.relativePath ||
    result.entry.bytes !== state.entry.bytes ||
    result.entry.sha256 !== state.entry.sha256 ||
    result.bytes !== Buffer.byteLength(result.content, 'utf8') ||
    !SHA256_PATTERN.test(result.sha256) ||
    result.sha256 !== `sha256:${createHash('sha256').update(result.content).digest('hex')}`
  ) {
    throw new Error('Managed Node transform result proof is invalid');
  }
}

async function readOptionalBoundedText(root: string, relativePath: string): Promise<string | null> {
  const path = join(root, ...relativePath.split('/'));
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) {
    throw new Error('Managed Node transform base output is not one bounded regular file');
  }
  const bytes = await readFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error('Managed Node transform base output is not canonical UTF-8 text', {
      cause: error,
    });
  }
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
