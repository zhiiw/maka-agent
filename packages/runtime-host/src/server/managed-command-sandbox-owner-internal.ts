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

import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import type { PermissionProfileManaged } from '@maka/core/permission-profile';
import {
  runFilesystemWorkerProcess,
  type FilesystemWorkerProcessRunner,
} from '@maka/runtime/filesystem-worker/process-runner';
import type { SandboxManager } from '@maka/runtime/sandbox';
import {
  requireManagedDependencySnapshotLeaseAccessInternal,
  type ManagedDependencySnapshotLease,
} from '@maka/storage/managed-dependency-snapshot-authority';
import {
  verifyManagedToolchainForInvocationInternal,
  type ManagedToolchainInvocationCapabilityInternal,
} from './managed-toolchain-artifact-authority-internal.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PORTABLE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

export interface ManagedFileObservationInternal {
  readonly protocolVersion: 1;
  readonly kind: 'file_observation';
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
}

export interface ManagedNodeTestFileIdentityInternal {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
}

export interface ManagedNodeTestObservationInternal {
  readonly protocolVersion: 1;
  readonly kind: 'node_test_observation';
  readonly nodeVersion: string;
  readonly files: readonly ManagedNodeTestFileIdentityInternal[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly todo: number;
}

export interface ManagedNodeCommandObservationInternal {
  readonly protocolVersion: 1;
  readonly kind: 'node_command_observation';
  readonly nodeVersion: string;
  readonly entry: ManagedNodeTestFileIdentityInternal;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ManagedNodeTransformResultInternal {
  readonly protocolVersion: 1;
  readonly kind: 'workspace_transform';
  readonly nodeVersion: string;
  readonly entry: ManagedNodeTestFileIdentityInternal;
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ManagedCommandSandboxOwnerInternal {
  readToolchainIdentity(
    effectClass?: 'hermetic_observation_v2' | 'hermetic_observation_v3' | 'workspace_transform_v1',
  ): Promise<ManagedCommandToolchainIdentityInternal>;
  readDependencyIdentity(
    lease: ManagedDependencySnapshotLease,
  ): Promise<ManagedCommandDependencyIdentityInternal>;
  inspectFile(
    input: ManagedCommandInspectFileInputInternal,
  ): Promise<ManagedFileObservationInternal>;
  runNodeTests(
    input: ManagedCommandRunNodeTestsInputInternal,
  ): Promise<ManagedNodeTestObservationInternal>;
  runNodeEntrypoint?(
    input: ManagedCommandRunNodeEntrypointInputInternal,
  ): Promise<ManagedNodeCommandObservationInternal>;
  runNodeTransform?(
    input: ManagedCommandRunNodeTransformInputInternal,
  ): Promise<ManagedNodeTransformResultInternal>;
}

export interface ManagedCommandDependencyIdentityInternal {
  readonly environmentId: `sha256:${string}`;
  readonly contentTreeSha256: `sha256:${string}`;
  readonly nodeVersion: string;
  readonly nodeAbi: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export interface ManagedCommandToolchainIdentityInternal {
  readonly identityDigest: `sha256:${string}`;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export interface ManagedCommandInspectFileInputInternal {
  readonly relativePath: string;
  readonly inputRoot: string;
  readonly scratchRoot: string;
  readonly effectClass?:
    | 'hermetic_observation_v2'
    | 'hermetic_observation_v3'
    | 'workspace_transform_v1';
  readonly abortSignal?: AbortSignal;
}

export interface ManagedCommandRunNodeTestsInputInternal {
  readonly relativePaths: readonly string[];
  readonly inputRoot: string;
  readonly scratchRoot: string;
  readonly dependencyLease?: ManagedDependencySnapshotLease;
  readonly abortSignal?: AbortSignal;
}

export interface ManagedCommandRunNodeEntrypointInputInternal {
  readonly entryPath: string;
  readonly args: readonly string[];
  readonly inputRoot: string;
  readonly scratchRoot: string;
  readonly abortSignal?: AbortSignal;
}

export interface ManagedCommandRunNodeTransformInputInternal
  extends ManagedCommandRunNodeEntrypointInputInternal {
  readonly outputPath: string;
}

export function createManagedCommandSandboxOwnerInternal(input: {
  readonly invocationOwnerToken: object;
  readonly dependencyLeaseConsumerOwnerToken: object;
  readonly toolchainCapability: ManagedToolchainInvocationCapabilityInternal;
  readonly sandboxManager: Pick<SandboxManager, 'transform'>;
  readonly runProcess?: FilesystemWorkerProcessRunner;
}): ManagedCommandSandboxOwnerInternal {
  const runProcess = input.runProcess ?? runFilesystemWorkerProcess;
  async function execute(
    request: {
      readonly inputRoot: string;
      readonly scratchRoot: string;
      readonly dependencyLease?: ManagedDependencySnapshotLease;
      readonly abortSignal?: AbortSignal;
    },
    invocation:
      | {
          readonly kind: 'helper';
          readonly operation: 'inspect_file_v1' | 'inspect_files_v1';
          readonly relativePaths: readonly string[];
          readonly effectClass?:
            | 'hermetic_observation_v2'
            | 'hermetic_observation_v3'
            | 'workspace_transform_v1';
        }
      | {
          readonly kind: 'node_tests';
          readonly relativePaths: readonly string[];
        }
      | {
          readonly kind: 'node_entrypoint';
          readonly entryPath: string;
          readonly args: readonly string[];
          readonly outputPath?: string;
        },
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly nodeVersion: string;
    readonly exitCode: number;
  }> {
    request.abortSignal?.throwIfAborted();
    const [inputRoot, scratchRoot] = await Promise.all([
      requireRealDirectory(request.inputRoot, 'input'),
      requireRealDirectory(request.scratchRoot, 'scratch'),
    ]);
    if (inputRoot === scratchRoot) {
      throw new Error('Managed command input and scratch roots must be distinct');
    }
    const dependency = request.dependencyLease
      ? requireManagedDependencySnapshotLeaseAccessInternal(
          input.dependencyLeaseConsumerOwnerToken,
          request.dependencyLease,
        )
      : undefined;
    const toolchain = await verifyManagedToolchainForInvocationInternal(
      input.invocationOwnerToken,
      input.toolchainCapability,
      invocation.kind === 'node_entrypoint' && invocation.outputPath !== undefined
        ? 'workspace_transform_v1'
        : invocation.kind === 'helper' && invocation.effectClass === 'workspace_transform_v1'
          ? 'workspace_transform_v1'
          : invocation.kind === 'node_entrypoint' ||
              (invocation.kind === 'helper' && invocation.effectClass === 'hermetic_observation_v3')
            ? 'hermetic_observation_v3'
            : 'hermetic_observation_v2',
    );
    request.abortSignal?.throwIfAborted();
    const profile = hermeticObservationProfile(inputRoot, scratchRoot, dependency?.dependencyRoot);
    const runtimeArgs = [
      ...(process.platform === 'win32' ? ['--no-stdio-init'] : []),
      '--permission',
      `--allow-fs-read=${inputRoot}`,
      ...(dependency ? [`--allow-fs-read=${dependency.dependencyRoot}`] : []),
      `--allow-fs-write=${scratchRoot}`,
      ...(invocation.kind === 'helper'
        ? [
            toolchain.entrypointPath,
            invocation.operation === 'inspect_file_v1'
              ? 'maka-observe-file-v1'
              : 'maka-observe-files-v1',
            ...invocation.relativePaths,
          ]
        : invocation.kind === 'node_tests'
          ? [
              '--test-force-exit',
              '--test-reporter=tap',
              toolchain.entrypointPath,
              'maka-node-tests-v1',
              ...(dependency ? ['--dependency-root', dependency.dependencyRoot] : []),
              '--',
              ...invocation.relativePaths,
            ]
          : [join(inputRoot, ...invocation.entryPath.split('/')), ...invocation.args]),
    ];
    const transformed = input.sandboxManager.transform({
      preference: 'require',
      command: {
        program: toolchain.executablePath,
        args: runtimeArgs,
        cwd: inputRoot,
        env: hermeticEnvironment(
          scratchRoot,
          invocation.kind === 'node_entrypoint' ? invocation.outputPath : undefined,
        ),
        profile,
        pathContext: {
          workspaceRoots: [
            inputRoot,
            scratchRoot,
            ...(dependency ? [dependency.dependencyRoot] : []),
          ],
          runtimeReadableRoots: [
            dirname(toolchain.entrypointPath),
            ...(process.platform === 'darwin' ? [dirname(dirname(toolchain.executablePath))] : []),
          ],
          ...(process.platform === 'win32'
            ? {
                runtimeExactReadableRoots: uniqueWindowsVolumeRoots([
                  inputRoot,
                  scratchRoot,
                  ...(dependency ? [dependency.dependencyRoot] : []),
                  toolchain.executablePath,
                  toolchain.entrypointPath,
                ]),
              }
            : {}),
          executableRoots: [dirname(toolchain.executablePath)],
        },
      },
    });
    if (!transformed.ok || !transformed.requiresSandbox || transformed.sandboxType === 'none') {
      throw new Error('Managed command sandbox profile is unavailable');
    }
    const result = await runProcess({
      argv: transformed.exec.argv,
      cwd: transformed.exec.cwd,
      env: transformed.exec.env ?? {},
      stdin: '',
      timeoutMs: 30_000,
      maxResponseBytes: invocation.kind === 'node_entrypoint' ? 32_769 : 64 * 1024,
      maxStderrBytes: invocation.kind === 'node_entrypoint' ? 32_769 : 64 * 1024,
      ...(transformed.exec.fdInputs ? { fdInputs: transformed.exec.fdInputs } : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    });
    if (
      result.timedOut ||
      result.aborted ||
      result.responseOverflow ||
      (invocation.kind === 'helper'
        ? result.exitCode !== 0
        : invocation.kind === 'node_tests'
          ? result.exitCode !== 0 && result.exitCode !== 1
          : invocation.outputPath !== undefined && result.exitCode !== 0) ||
      !result.dispatched
    ) {
      throw new Error(formatManagedCommandFailure(result, invocationLabel(invocation)));
    }
    return {
      stdout: result.stdout,
      stderr: result.stderrTail,
      nodeVersion: toolchain.nodeVersion,
      exitCode: result.exitCode,
    };
  }
  return Object.freeze({
    async readToolchainIdentity(
      effectClass:
        | 'hermetic_observation_v2'
        | 'hermetic_observation_v3'
        | 'workspace_transform_v1' = 'hermetic_observation_v2',
    ) {
      const toolchain = await verifyManagedToolchainForInvocationInternal(
        input.invocationOwnerToken,
        input.toolchainCapability,
        effectClass,
      );
      return Object.freeze({
        identityDigest: toolchain.identityDigest,
        nodeVersion: toolchain.nodeVersion,
        platform: toolchain.platform,
        arch: toolchain.arch,
      });
    },
    async readDependencyIdentity(lease: ManagedDependencySnapshotLease) {
      const dependency = requireManagedDependencySnapshotLeaseAccessInternal(
        input.dependencyLeaseConsumerOwnerToken,
        lease,
      );
      const toolchain = await verifyManagedToolchainForInvocationInternal(
        input.invocationOwnerToken,
        input.toolchainCapability,
        'hermetic_observation_v2',
      );
      if (
        !SHA256_PATTERN.test(dependency.environmentId) ||
        !SHA256_PATTERN.test(dependency.contentTreeSha256) ||
        dependency.runtime.nodeVersion !== toolchain.nodeVersion ||
        dependency.runtime.platform !== toolchain.platform ||
        dependency.runtime.arch !== toolchain.arch ||
        !/^[0-9]{2,4}$/u.test(dependency.runtime.nodeAbi)
      ) {
        throw new Error('Managed command dependency snapshot identity is invalid');
      }
      return Object.freeze({
        environmentId: dependency.environmentId,
        contentTreeSha256: dependency.contentTreeSha256,
        nodeVersion: dependency.runtime.nodeVersion,
        nodeAbi: dependency.runtime.nodeAbi,
        platform: dependency.runtime.platform,
        arch: dependency.runtime.arch,
      });
    },
    async inspectFile(request: ManagedCommandInspectFileInputInternal) {
      if (!isPortableRelativePath(request.relativePath)) {
        throw new Error('Managed command observation path is invalid');
      }
      const result = await execute(request, {
        kind: 'helper',
        operation: 'inspect_file_v1',
        relativePaths: [request.relativePath],
        ...(request.effectClass ? { effectClass: request.effectClass } : {}),
      });
      return decodeObservation(result.stdout, request.relativePath, result.nodeVersion);
    },
    async runNodeTests(request: ManagedCommandRunNodeTestsInputInternal) {
      const relativePaths = [...request.relativePaths].sort();
      if (
        relativePaths.length === 0 ||
        relativePaths.length > 64 ||
        new Set(relativePaths).size !== relativePaths.length ||
        !relativePaths.every(
          (path) => isPortableRelativePath(path) && /\.(?:cjs|mjs|js)$/u.test(path),
        )
      ) {
        throw new Error('Managed Node test file list is invalid');
      }
      const before = await execute(request, {
        kind: 'helper',
        operation: 'inspect_files_v1',
        relativePaths,
      });
      const files = decodeFileObservations(before.stdout, relativePaths, before.nodeVersion);
      const result = await execute(request, {
        kind: 'node_tests',
        relativePaths,
      });
      const after = await execute(request, {
        kind: 'helper',
        operation: 'inspect_files_v1',
        relativePaths,
      });
      const afterFiles = decodeFileObservations(after.stdout, relativePaths, after.nodeVersion);
      assertSameFileObservations(files, afterFiles);
      return decodeNodeTestTap(result.stdout, files, result.nodeVersion, result.exitCode);
    },
    async runNodeEntrypoint(request: ManagedCommandRunNodeEntrypointInputInternal) {
      if (
        !isPortableRelativePath(request.entryPath) ||
        !/\.(?:cjs|mjs|js)$/u.test(request.entryPath) ||
        !areManagedNodeCommandArgs(request.args)
      ) {
        throw new Error('Managed Node command arguments are invalid');
      }
      const observationRequest = {
        inputRoot: request.inputRoot,
        scratchRoot: request.scratchRoot,
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      };
      const before = await execute(observationRequest, {
        kind: 'helper',
        operation: 'inspect_file_v1',
        relativePaths: [request.entryPath],
        effectClass: 'hermetic_observation_v3',
      });
      const entry = decodeObservation(before.stdout, request.entryPath, before.nodeVersion);
      const result = await execute(request, {
        kind: 'node_entrypoint',
        entryPath: request.entryPath,
        args: Object.freeze([...request.args]),
      });
      const after = await execute(observationRequest, {
        kind: 'helper',
        operation: 'inspect_file_v1',
        relativePaths: [request.entryPath],
        effectClass: 'hermetic_observation_v3',
      });
      const afterEntry = decodeObservation(after.stdout, request.entryPath, after.nodeVersion);
      if (
        entry.relativePath !== afterEntry.relativePath ||
        entry.bytes !== afterEntry.bytes ||
        entry.sha256 !== afterEntry.sha256
      ) {
        throw new Error('Managed Node command entry changed during execution');
      }
      if (
        Buffer.byteLength(result.stdout, 'utf8') > 32_768 ||
        Buffer.byteLength(result.stderr, 'utf8') > 32_768
      ) {
        throw new Error('Managed Node command output is too large');
      }
      return Object.freeze({
        protocolVersion: 1 as const,
        kind: 'node_command_observation' as const,
        nodeVersion: result.nodeVersion,
        entry: Object.freeze({
          relativePath: entry.relativePath,
          bytes: entry.bytes,
          sha256: entry.sha256,
        }),
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },
    async runNodeTransform(request: ManagedCommandRunNodeTransformInputInternal) {
      if (
        !isPortableRelativePath(request.entryPath) ||
        !/\.(?:cjs|mjs|js)$/u.test(request.entryPath) ||
        !isPortableRelativePath(request.outputPath) ||
        !areManagedNodeCommandArgs(request.args)
      ) {
        throw new Error('Managed Node transform arguments are invalid');
      }
      const physicalOutputPath = join(request.scratchRoot, 'maka-transform-output');
      if (await lstat(physicalOutputPath).catch(() => undefined)) {
        throw new Error('Managed Node transform output root is not empty');
      }
      const observationRequest = {
        inputRoot: request.inputRoot,
        scratchRoot: request.scratchRoot,
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      };
      const before = await execute(observationRequest, {
        kind: 'helper',
        operation: 'inspect_file_v1',
        relativePaths: [request.entryPath],
        effectClass: 'hermetic_observation_v3',
      });
      const entry = decodeObservation(before.stdout, request.entryPath, before.nodeVersion);
      const result = await execute(request, {
        kind: 'node_entrypoint',
        entryPath: request.entryPath,
        args: Object.freeze([...request.args]),
        outputPath: physicalOutputPath,
      });
      const after = await execute(observationRequest, {
        kind: 'helper',
        operation: 'inspect_file_v1',
        relativePaths: [request.entryPath],
        effectClass: 'hermetic_observation_v3',
      });
      const afterEntry = decodeObservation(after.stdout, request.entryPath, after.nodeVersion);
      if (
        entry.relativePath !== afterEntry.relativePath ||
        entry.bytes !== afterEntry.bytes ||
        entry.sha256 !== afterEntry.sha256
      ) {
        throw new Error('Managed Node transform entry changed during execution');
      }
      const output = await readExactTransformOutput(physicalOutputPath);
      return Object.freeze({
        protocolVersion: 1 as const,
        kind: 'workspace_transform' as const,
        nodeVersion: result.nodeVersion,
        entry: Object.freeze({
          relativePath: entry.relativePath,
          bytes: entry.bytes,
          sha256: entry.sha256,
        }),
        path: request.outputPath,
        content: output.content,
        bytes: output.bytes,
        sha256: output.sha256,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },
  });
}

async function readExactTransformOutput(path: string): Promise<
  Readonly<{
    content: string;
    bytes: number;
    sha256: `sha256:${string}`;
  }>
> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1_048_576) {
    throw new Error('Managed Node transform output must be one bounded regular file');
  }
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || opened.size > 1_048_576) {
      throw new Error('Managed Node transform output identity changed before read');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error('Managed Node transform output changed while read');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error('Managed Node transform output is not canonical UTF-8 text', {
        cause: error,
      });
    }
    return Object.freeze({
      content,
      bytes: bytes.byteLength,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
  } finally {
    await handle.close();
  }
}

function uniqueWindowsVolumeRoots(paths: readonly string[]): readonly string[] {
  const roots: string[] = [];
  for (const path of paths) {
    const root = win32.parse(path).root;
    if (root && !roots.some((existing) => existing.toLowerCase() === root.toLowerCase())) {
      roots.push(root);
    }
  }
  return roots;
}

function invocationLabel(
  invocation:
    | {
        readonly kind: 'helper';
        readonly operation: 'inspect_file_v1' | 'inspect_files_v1';
        readonly relativePaths: readonly string[];
        readonly effectClass?:
          | 'hermetic_observation_v2'
          | 'hermetic_observation_v3'
          | 'workspace_transform_v1';
      }
    | { readonly kind: 'node_tests'; readonly relativePaths: readonly string[] }
    | {
        readonly kind: 'node_entrypoint';
        readonly entryPath: string;
        readonly args: readonly string[];
      },
): string {
  if (invocation.kind === 'node_tests') return 'node_tests';
  if (invocation.kind === 'node_entrypoint') return 'node_entrypoint';
  return invocation.operation;
}

function formatManagedCommandFailure(
  input: {
    readonly timedOut: boolean;
    readonly aborted: boolean;
    readonly responseOverflow: boolean;
    readonly exitCode: number;
    readonly dispatched: boolean;
    readonly stdout: string;
    readonly stderrTail: string;
  },
  phase: string,
): string {
  const reason = input.timedOut
    ? 'timeout'
    : input.aborted
      ? 'aborted'
      : input.responseOverflow
        ? 'response_overflow'
        : !input.dispatched
          ? 'not_dispatched'
          : `exit_${input.exitCode}`;
  const stderr = input.stderrTail
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(-512);
  const stdout = input.stdout
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(-512);
  const detail = [stderr && `stderr=${stderr}`, stdout && `stdout=${stdout}`]
    .filter(Boolean)
    .join('; ');
  return `Managed command execution did not complete safely (${phase}:${reason}${detail ? `: ${detail}` : ''})`;
}

function hermeticObservationProfile(
  inputRoot: string,
  scratchRoot: string,
  dependencyRoot?: string,
): PermissionProfileManaged {
  return {
    type: 'managed',
    name: 'managed-hermetic-observation-v2',
    fileSystem: {
      kind: 'restricted',
      entries: [
        { kind: 'path', access: 'read', path: inputRoot, match: 'subtree' },
        ...(dependencyRoot
          ? ([{ kind: 'path', access: 'read', path: dependencyRoot, match: 'subtree' }] as const)
          : []),
        { kind: 'path', access: 'write', path: scratchRoot, match: 'subtree' },
      ],
      protectedMetadata: { access: 'deny_write', names: ['.git', '.agents', '.codex'] },
    },
    network: { kind: 'restricted' },
  };
}

function hermeticEnvironment(
  scratchRoot: string,
  outputPath?: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ELECTRON_RUN_AS_NODE: '1',
    HOME: scratchRoot,
    USERPROFILE: scratchRoot,
    TMP: scratchRoot,
    TEMP: scratchRoot,
    PATH: '',
    NODE_OPTIONS: '',
    NO_COLOR: '1',
    CI: '1',
    ...(outputPath ? { MAKA_OUTPUT_PATH: outputPath } : {}),
    ...(process.platform === 'win32'
      ? Object.fromEntries(
          (['SystemRoot', 'SystemDrive', 'LOCALAPPDATA'] as const).flatMap((name) => {
            const value = process.env[name];
            return value ? [[name, value] as const] : [];
          }),
        )
      : {}),
  });
}

async function requireRealDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Managed command ${label} root is invalid`);
  }
  return canonical;
}

function isPortableRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    !value.includes('\\') &&
    value.split('/').every((segment) => PORTABLE_PATH_SEGMENT.test(segment) && segment !== '..')
  );
}

function areManagedNodeCommandArgs(value: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length > 64) return false;
  let totalBytes = 0;
  for (const argument of value) {
    if (typeof argument !== 'string') return false;
    const bytes = Buffer.byteLength(argument, 'utf8');
    if (bytes > 4096) return false;
    totalBytes += bytes;
    if (totalBytes > 32_768) return false;
  }
  return true;
}

function decodeObservation(
  raw: string,
  relativePath: string,
  nodeVersion: string,
): ManagedFileObservationInternal {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    Object.keys(value).sort().join('\0') !==
      ['bytes', 'kind', 'nodeVersion', 'protocolVersion', 'relativePath', 'sha256']
        .sort()
        .join('\0') ||
    value.protocolVersion !== 1 ||
    value.kind !== 'file_observation' ||
    value.nodeVersion !== nodeVersion ||
    value.relativePath !== relativePath ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > 16 * 1024 * 1024 ||
    typeof value.sha256 !== 'string' ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new Error('Managed command response is invalid');
  }
  return Object.freeze({
    protocolVersion: 1 as const,
    kind: 'file_observation' as const,
    relativePath,
    bytes: value.bytes as number,
    sha256: value.sha256 as `sha256:${string}`,
  });
}

function decodeFileObservations(
  raw: string,
  relativePaths: readonly string[],
  nodeVersion: string,
): readonly ManagedNodeTestFileIdentityInternal[] {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    Object.keys(value).sort().join('\0') !==
      ['files', 'kind', 'nodeVersion', 'protocolVersion'].sort().join('\0') ||
    value.protocolVersion !== 1 ||
    value.kind !== 'file_observations' ||
    value.nodeVersion !== nodeVersion ||
    !Array.isArray(value.files) ||
    value.files.length !== relativePaths.length
  ) {
    throw new Error('Managed command file observation response is invalid');
  }
  const files = value.files.map((file, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('Managed command file observation response is invalid');
    }
    const record = file as Record<string, unknown>;
    if (
      Object.keys(record).sort().join('\0') !==
        ['bytes', 'relativePath', 'sha256'].sort().join('\0') ||
      record.relativePath !== relativePaths[index] ||
      !Number.isSafeInteger(record.bytes) ||
      (record.bytes as number) < 0 ||
      (record.bytes as number) > 16 * 1024 * 1024 ||
      typeof record.sha256 !== 'string' ||
      !SHA256_PATTERN.test(record.sha256)
    ) {
      throw new Error('Managed command file observation response is invalid');
    }
    return Object.freeze({
      relativePath: record.relativePath,
      bytes: record.bytes as number,
      sha256: record.sha256 as `sha256:${string}`,
    });
  });
  return Object.freeze(files);
}

function assertSameFileObservations(
  before: readonly ManagedNodeTestFileIdentityInternal[],
  after: readonly ManagedNodeTestFileIdentityInternal[],
): void {
  if (
    before.length !== after.length ||
    !before.every(
      (file, index) =>
        file.relativePath === after[index]?.relativePath &&
        file.bytes === after[index]?.bytes &&
        file.sha256 === after[index]?.sha256,
    )
  ) {
    throw new Error('Managed Node test input changed during execution');
  }
}

function decodeNodeTestTap(
  raw: string,
  files: readonly ManagedNodeTestFileIdentityInternal[],
  nodeVersion: string,
  exitCode: number,
): ManagedNodeTestObservationInternal {
  if (raw.trim().length === 0 && exitCode === 0) {
    throw new Error('Managed Node test run did not report any tests');
  }
  const summaries = new Map<string, number>();
  let observedDeclaredTest = false;
  for (const line of raw.split(/\r?\n/gu)) {
    const subtest = /^# Subtest: (.+)$/u.exec(line);
    if (subtest && !files.some((file) => file.relativePath === subtest[1])) {
      observedDeclaredTest = true;
    }
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) ([0-9]+)$/u.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    if (summaries.has(key)) throw new Error('Managed Node test TAP summary is ambiguous');
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count)) throw new Error('Managed Node test TAP summary is invalid');
    summaries.set(key, count);
  }
  const tests = summaries.get('tests');
  const passed = summaries.get('pass');
  const failed = summaries.get('fail');
  const cancelled = summaries.get('cancelled');
  const skipped = summaries.get('skipped');
  const todo = summaries.get('todo');
  if (
    tests === undefined ||
    passed === undefined ||
    failed === undefined ||
    cancelled === undefined ||
    skipped === undefined ||
    todo === undefined ||
    cancelled !== 0 ||
    tests !== passed + failed + skipped + todo ||
    exitCode !== (failed > 0 ? 1 : 0)
  ) {
    throw new Error('Managed Node test TAP summary is invalid');
  }
  if (tests === 0 || !observedDeclaredTest) {
    throw new Error('Managed Node test run did not report any tests');
  }
  const terminalCount = passed + failed + skipped + todo;
  if (terminalCount === 0) {
    throw new Error('Managed Node test run did not report any tests');
  }
  return Object.freeze({
    protocolVersion: 1 as const,
    kind: 'node_test_observation' as const,
    nodeVersion,
    files: Object.freeze([...files]),
    passed,
    failed,
    skipped,
    todo,
  });
}
