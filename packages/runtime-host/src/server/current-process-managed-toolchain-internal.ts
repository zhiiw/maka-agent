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

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import {
  admitManagedToolchainArtifactInternal,
  issueManagedToolchainReleaseClaimInternal,
  ManagedToolchainArtifactAuthorityError,
  type ManagedToolchainInvocationCapabilityInternal,
} from './managed-toolchain-artifact-authority-internal.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRYPOINT_BYTES = 4 * 1024 * 1024;
const releaseOwnerToken = Object.freeze({ kind: 'current_process_managed_toolchain_owner_v1' });
const MANIFEST_KEYS = [
  'allowedEffectClasses',
  'arch',
  'distributionReady',
  'entrypointBytes',
  'entrypointRelativePath',
  'entrypointSha256',
  'nodeVersion',
  'platform',
  'profileVersion',
  'protocol',
  'provider',
  'schemaVersion',
] as const;

export type CurrentProcessManagedToolchainErrorCode =
  | 'current_process_managed_toolchain_unavailable'
  | 'current_process_managed_toolchain_manifest_invalid'
  | 'current_process_managed_toolchain_platform_mismatch'
  | 'current_process_managed_toolchain_integrity_mismatch';

export class CurrentProcessManagedToolchainError extends Error {
  constructor(
    readonly code: CurrentProcessManagedToolchainErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CurrentProcessManagedToolchainError';
  }
}

export async function resolveCurrentProcessManagedToolchainInternal(input: {
  readonly invocationOwnerToken: object;
  readonly resourcesRoot?: string;
}): Promise<ManagedToolchainInvocationCapabilityInternal> {
  try {
    if (process.platform === 'win32') {
      throw new CurrentProcessManagedToolchainError(
        'current_process_managed_toolchain_unavailable',
        'Managed command toolchain requires an independently admitted standalone Node runtime on Windows',
      );
    }
    if (typeof process.versions.electron !== 'string') {
      throw new CurrentProcessManagedToolchainError(
        'current_process_managed_toolchain_unavailable',
        'Managed command toolchain requires the Desktop Electron runtime',
      );
    }
    const resourcesRoot = normalize(
      await realpath(input.resourcesRoot ?? requirePackagedProcessResourcesRoot()),
    );
    const manifestPath = normalize(
      await realpath(join(resourcesRoot, 'managed-command-toolchain.json')),
    );
    assertWithinRoot(resourcesRoot, manifestPath, 'Managed command toolchain manifest');
    const manifestInfo = await lstat(manifestPath);
    if (
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      manifestInfo.size < 1 ||
      manifestInfo.size > MAX_MANIFEST_BYTES
    ) {
      throw invalidManifest('Managed command toolchain manifest must be a bounded regular file');
    }
    const manifest = decodeManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    if (
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch ||
      manifest.nodeVersion !== process.versions.node
    ) {
      throw new CurrentProcessManagedToolchainError(
        'current_process_managed_toolchain_platform_mismatch',
        'Managed command toolchain does not match the current Desktop runtime',
      );
    }
    const entrypointPath = normalize(
      await realpath(join(resourcesRoot, ...manifest.entrypointRelativePath.split('/'))),
    );
    assertWithinRoot(resourcesRoot, entrypointPath, 'Managed command entrypoint');
    const executablePath = normalize(await realpath(process.execPath));
    const executable = await fileIdentity(executablePath, MAX_EXECUTABLE_BYTES, 'executable');
    const claim = issueManagedToolchainReleaseClaimInternal(releaseOwnerToken, {
      executablePath,
      executableSha256: executable.sha256,
      executableBytes: executable.bytes,
      entrypointPath,
      entrypointSha256: manifest.entrypointSha256,
      entrypointBytes: manifest.entrypointBytes,
      nodeVersion: manifest.nodeVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      profileVersion: manifest.profileVersion,
      allowedEffectClasses: manifest.allowedEffectClasses,
    });
    return await admitManagedToolchainArtifactInternal({
      releaseOwnerToken,
      invocationOwnerToken: input.invocationOwnerToken,
      claim,
    });
  } catch (error) {
    if (error instanceof CurrentProcessManagedToolchainError) throw error;
    if (error instanceof ManagedToolchainArtifactAuthorityError) {
      throw new CurrentProcessManagedToolchainError(
        error.code === 'managed_toolchain_artifact_identity_mismatch'
          ? 'current_process_managed_toolchain_integrity_mismatch'
          : 'current_process_managed_toolchain_unavailable',
        'Managed command toolchain failed release admission',
        { cause: error },
      );
    }
    throw new CurrentProcessManagedToolchainError(
      'current_process_managed_toolchain_unavailable',
      'Managed command toolchain is unavailable',
      { cause: error },
    );
  }
}

interface ManagedCommandToolchainManifestV1 {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_managed_command_toolchain_release_v1';
  readonly provider: 'maka/managed-command-toolchain';
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly profileVersion: 1;
  readonly entrypointRelativePath: 'managed-command/managed-command-helper-main.js';
  readonly entrypointBytes: number;
  readonly entrypointSha256: `sha256:${string}`;
  readonly allowedEffectClasses: readonly ['hermetic_observation_v1'];
  readonly distributionReady: true;
}

function decodeManifest(input: unknown): ManagedCommandToolchainManifestV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidManifest('Managed command toolchain manifest must be an object');
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join('\0') !== [...MANIFEST_KEYS].sort().join('\0') ||
    value.schemaVersion !== 1 ||
    value.protocol !== 'maka_managed_command_toolchain_release_v1' ||
    value.provider !== 'maka/managed-command-toolchain' ||
    !['win32', 'darwin', 'linux'].includes(value.platform as string) ||
    typeof value.arch !== 'string' ||
    !/^[a-z0-9_]+$/u.test(value.arch) ||
    typeof value.nodeVersion !== 'string' ||
    !/^24\.[0-9]+\.[0-9]+$/u.test(value.nodeVersion) ||
    value.profileVersion !== 1 ||
    value.entrypointRelativePath !== 'managed-command/managed-command-helper-main.js' ||
    !Number.isSafeInteger(value.entrypointBytes) ||
    (value.entrypointBytes as number) < 1 ||
    (value.entrypointBytes as number) > MAX_ENTRYPOINT_BYTES ||
    typeof value.entrypointSha256 !== 'string' ||
    !SHA256_PATTERN.test(value.entrypointSha256) ||
    !Array.isArray(value.allowedEffectClasses) ||
    value.allowedEffectClasses.length !== 1 ||
    value.allowedEffectClasses[0] !== 'hermetic_observation_v1' ||
    value.distributionReady !== true
  ) {
    throw invalidManifest('Managed command toolchain manifest is invalid');
  }
  return value as unknown as ManagedCommandToolchainManifestV1;
}

async function fileIdentity(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<{ readonly bytes: number; readonly sha256: `sha256:${string}` }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) {
    throw new CurrentProcessManagedToolchainError(
      'current_process_managed_toolchain_unavailable',
      `Managed command ${label} must be a bounded regular file`,
    );
  }
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const finalInfo = await lstat(path);
  if (
    finalInfo.dev !== info.dev ||
    finalInfo.ino !== info.ino ||
    finalInfo.size !== info.size ||
    finalInfo.mtimeMs !== info.mtimeMs ||
    finalInfo.ctimeMs !== info.ctimeMs
  ) {
    throw new CurrentProcessManagedToolchainError(
      'current_process_managed_toolchain_integrity_mismatch',
      `Managed command ${label} changed while it was inspected`,
    );
  }
  return Object.freeze({
    bytes: info.size,
    sha256: `sha256:${digest.digest('hex')}`,
  });
}

function requirePackagedProcessResourcesRoot(): string {
  const value = (process as NodeJS.Process & { readonly resourcesPath?: unknown }).resourcesPath;
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new CurrentProcessManagedToolchainError(
      'current_process_managed_toolchain_unavailable',
      'Managed command packaged resources root is unavailable',
    );
  }
  return value;
}

function assertWithinRoot(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw invalidManifest(`${label} escapes the packaged resources root`);
}

function invalidManifest(message: string): CurrentProcessManagedToolchainError {
  return new CurrentProcessManagedToolchainError(
    'current_process_managed_toolchain_manifest_invalid',
    message,
  );
}
