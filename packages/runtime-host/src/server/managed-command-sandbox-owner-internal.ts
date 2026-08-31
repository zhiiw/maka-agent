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

import { lstat, realpath } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
import type { PermissionProfileManaged } from '@maka/core/permission-profile';
import {
  runFilesystemWorkerProcess,
  type FilesystemWorkerProcessRunner,
} from '@maka/runtime/filesystem-worker/process-runner';
import type { SandboxManager } from '@maka/runtime/sandbox';
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

export interface ManagedCommandSandboxOwnerInternal {
  readToolchainIdentity(): Promise<ManagedCommandToolchainIdentityInternal>;
  inspectFile(
    input: ManagedCommandInspectFileInputInternal,
  ): Promise<ManagedFileObservationInternal>;
  runNodeTests(
    input: ManagedCommandRunNodeTestsInputInternal,
  ): Promise<ManagedNodeTestObservationInternal>;
}

export interface ManagedCommandToolchainIdentityInternal {
  readonly identityDigest: `sha256:${string}`;
  readonly nodeVersion: string;
}

export interface ManagedCommandInspectFileInputInternal {
  readonly relativePath: string;
  readonly inputRoot: string;
  readonly scratchRoot: string;
  readonly abortSignal?: AbortSignal;
}

export interface ManagedCommandRunNodeTestsInputInternal {
  readonly relativePaths: readonly string[];
  readonly inputRoot: string;
  readonly scratchRoot: string;
  readonly abortSignal?: AbortSignal;
}

export function createManagedCommandSandboxOwnerInternal(input: {
  readonly invocationOwnerToken: object;
  readonly toolchainCapability: ManagedToolchainInvocationCapabilityInternal;
  readonly sandboxManager: Pick<SandboxManager, 'transform'>;
  readonly runProcess?: FilesystemWorkerProcessRunner;
}): ManagedCommandSandboxOwnerInternal {
  const runProcess = input.runProcess ?? runFilesystemWorkerProcess;
  async function execute(
    request: {
      readonly inputRoot: string;
      readonly scratchRoot: string;
      readonly abortSignal?: AbortSignal;
    },
    invocation:
      | {
          readonly kind: 'helper';
          readonly operation: 'inspect_file_v1' | 'inspect_files_v1';
          readonly relativePaths: readonly string[];
        }
      | {
          readonly kind: 'node_tests';
          readonly relativePaths: readonly string[];
        },
  ): Promise<{
    readonly stdout: string;
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
    const toolchain = await verifyManagedToolchainForInvocationInternal(
      input.invocationOwnerToken,
      input.toolchainCapability,
      'hermetic_observation_v1',
    );
    request.abortSignal?.throwIfAborted();
    const profile = hermeticObservationProfile(inputRoot, scratchRoot);
    const runtimeArgs = [
      ...(process.platform === 'win32' ? ['--no-stdio-init'] : []),
      '--permission',
      `--allow-fs-read=${inputRoot}`,
      `--allow-fs-write=${scratchRoot}`,
      ...(invocation.kind === 'helper'
        ? [
            toolchain.entrypointPath,
            invocation.operation === 'inspect_file_v1'
              ? 'maka-observe-file-v1'
              : 'maka-observe-files-v1',
            ...invocation.relativePaths,
          ]
        : [
            '--test-force-exit',
            '--test-reporter=tap',
            toolchain.entrypointPath,
            'maka-node-tests-v1',
            ...invocation.relativePaths,
          ]),
    ];
    const transformed = input.sandboxManager.transform({
      preference: 'require',
      command: {
        program: toolchain.executablePath,
        args: runtimeArgs,
        cwd: inputRoot,
        env: hermeticEnvironment(scratchRoot),
        profile,
        pathContext: {
          workspaceRoots: [inputRoot, scratchRoot],
          runtimeReadableRoots: [
            dirname(toolchain.entrypointPath),
            ...(process.platform === 'darwin' ? [dirname(dirname(toolchain.executablePath))] : []),
          ],
          ...(process.platform === 'win32'
            ? {
                runtimeExactReadableRoots: uniqueWindowsVolumeRoots([
                  inputRoot,
                  scratchRoot,
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
      maxResponseBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      ...(transformed.exec.fdInputs ? { fdInputs: transformed.exec.fdInputs } : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    });
    if (
      result.timedOut ||
      result.aborted ||
      result.responseOverflow ||
      (invocation.kind === 'helper'
        ? result.exitCode !== 0
        : result.exitCode !== 0 && result.exitCode !== 1) ||
      !result.dispatched
    ) {
      throw new Error(formatManagedCommandFailure(result, invocationLabel(invocation)));
    }
    return {
      stdout: result.stdout,
      nodeVersion: toolchain.nodeVersion,
      exitCode: result.exitCode,
    };
  }
  return Object.freeze({
    async readToolchainIdentity() {
      const toolchain = await verifyManagedToolchainForInvocationInternal(
        input.invocationOwnerToken,
        input.toolchainCapability,
        'hermetic_observation_v1',
      );
      return Object.freeze({
        identityDigest: toolchain.identityDigest,
        nodeVersion: toolchain.nodeVersion,
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
  });
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
      }
    | { readonly kind: 'node_tests'; readonly relativePaths: readonly string[] },
): string {
  if (invocation.kind === 'node_tests') return 'node_tests';
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
): PermissionProfileManaged {
  return {
    type: 'managed',
    name: 'managed-hermetic-observation-v1',
    fileSystem: {
      kind: 'restricted',
      entries: [
        { kind: 'path', access: 'read', path: inputRoot, match: 'subtree' },
        { kind: 'path', access: 'write', path: scratchRoot, match: 'subtree' },
      ],
      protectedMetadata: { access: 'deny_write', names: ['.git', '.agents', '.codex'] },
    },
    network: { kind: 'restricted' },
  };
}

function hermeticEnvironment(scratchRoot: string): Readonly<Record<string, string>> {
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
