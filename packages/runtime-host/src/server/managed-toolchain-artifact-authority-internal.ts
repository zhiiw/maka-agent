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
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const NODE_VERSION_PATTERN = /^24\.[0-9]+\.[0-9]+$/u;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRYPOINT_BYTES = 4 * 1024 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;

export const MANAGED_TOOLCHAIN_EFFECT_CLASSES_INTERNAL = Object.freeze([
  'hermetic_observation_v1',
  'hermetic_observation_v2',
  'hermetic_observation_v3',
  'workspace_transform_v1',
] as const);
export type ManagedToolchainEffectClassInternal =
  (typeof MANAGED_TOOLCHAIN_EFFECT_CLASSES_INTERNAL)[number];

export interface ManagedToolchainReleaseClaimInternal {
  readonly kind: 'managed_toolchain_release_claim_v1';
}

export interface ManagedToolchainInvocationCapabilityInternal {
  readonly kind: 'managed_toolchain_invocation_capability_v1';
}

export interface ManagedToolchainReleaseStateInternal {
  readonly executablePath: string;
  readonly executableSha256: `sha256:${string}`;
  readonly executableBytes: number;
  readonly entrypointPath: string;
  readonly entrypointSha256: `sha256:${string}`;
  readonly entrypointBytes: number;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly profileVersion: 1;
  readonly allowedEffectClasses: readonly ManagedToolchainEffectClassInternal[];
}

export interface VerifiedManagedToolchainInternal {
  readonly executablePath: string;
  readonly entrypointPath: string;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly profileVersion: 1;
  readonly allowedEffectClasses: readonly ManagedToolchainEffectClassInternal[];
  readonly identityDigest: `sha256:${string}`;
}

type ManagedToolchainArtifactAuthorityErrorCode =
  | 'managed_toolchain_release_claim_invalid'
  | 'managed_toolchain_release_claim_unsupported'
  | 'managed_toolchain_artifact_invalid'
  | 'managed_toolchain_artifact_identity_mismatch'
  | 'managed_toolchain_invocation_capability_invalid';

export class ManagedToolchainArtifactAuthorityError extends Error {
  constructor(
    readonly code: ManagedToolchainArtifactAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedToolchainArtifactAuthorityError';
  }
}

interface ReleaseRecord extends ManagedToolchainReleaseStateInternal {
  readonly releaseOwnerToken: object;
}

interface CapabilityRecord {
  readonly invocationOwnerToken: object;
  readonly release: ReleaseRecord;
  readonly canonicalExecutablePath: string;
  readonly canonicalEntrypointPath: string;
}

const releases = new WeakMap<object, ReleaseRecord>();
const capabilities = new WeakMap<object, CapabilityRecord>();

export function issueManagedToolchainReleaseClaimInternal(
  releaseOwnerToken: object,
  state: ManagedToolchainReleaseStateInternal,
): ManagedToolchainReleaseClaimInternal {
  assertReleaseState(state);
  const claim = Object.freeze({ kind: 'managed_toolchain_release_claim_v1' as const });
  releases.set(
    claim,
    Object.freeze({
      ...state,
      allowedEffectClasses: Object.freeze([...state.allowedEffectClasses].sort()),
      releaseOwnerToken,
    }),
  );
  return claim;
}

export async function admitManagedToolchainArtifactInternal(input: {
  readonly releaseOwnerToken: object;
  readonly invocationOwnerToken: object;
  readonly claim: ManagedToolchainReleaseClaimInternal;
}): Promise<ManagedToolchainInvocationCapabilityInternal> {
  const release = releases.get(input.claim);
  if (!release || release.releaseOwnerToken !== input.releaseOwnerToken) {
    throw authorityError(
      'managed_toolchain_release_claim_invalid',
      'Managed toolchain release claim is invalid for this owner',
    );
  }
  if (release.platform !== process.platform || release.arch !== process.arch) {
    throw authorityError(
      'managed_toolchain_release_claim_unsupported',
      `Managed toolchain does not support ${process.platform}/${process.arch}`,
    );
  }
  const canonicalExecutablePath = await verifyFile(
    release.executablePath,
    release.executableBytes,
    release.executableSha256,
    MAX_EXECUTABLE_BYTES,
    'executable',
  );
  const canonicalEntrypointPath = await verifyFile(
    release.entrypointPath,
    release.entrypointBytes,
    release.entrypointSha256,
    MAX_ENTRYPOINT_BYTES,
    'entrypoint',
  );
  const capability = Object.freeze({
    kind: 'managed_toolchain_invocation_capability_v1' as const,
  });
  capabilities.set(capability, {
    invocationOwnerToken: input.invocationOwnerToken,
    release,
    canonicalExecutablePath,
    canonicalEntrypointPath,
  });
  return capability;
}

export async function verifyManagedToolchainForInvocationInternal(
  invocationOwnerToken: object,
  capability: ManagedToolchainInvocationCapabilityInternal,
  requiredEffectClass: ManagedToolchainEffectClassInternal,
): Promise<VerifiedManagedToolchainInternal> {
  const record = capabilities.get(capability);
  if (!record || record.invocationOwnerToken !== invocationOwnerToken) {
    throw authorityError(
      'managed_toolchain_invocation_capability_invalid',
      'Managed toolchain invocation capability is invalid for this owner',
    );
  }
  if (!record.release.allowedEffectClasses.includes(requiredEffectClass)) {
    throw authorityError(
      'managed_toolchain_release_claim_unsupported',
      `Managed toolchain does not allow ${requiredEffectClass}`,
    );
  }
  const executablePath = await verifyFile(
    record.release.executablePath,
    record.release.executableBytes,
    record.release.executableSha256,
    MAX_EXECUTABLE_BYTES,
    'executable',
  );
  const entrypointPath = await verifyFile(
    record.release.entrypointPath,
    record.release.entrypointBytes,
    record.release.entrypointSha256,
    MAX_ENTRYPOINT_BYTES,
    'entrypoint',
  );
  if (
    executablePath !== record.canonicalExecutablePath ||
    entrypointPath !== record.canonicalEntrypointPath
  ) {
    throw authorityError(
      'managed_toolchain_artifact_identity_mismatch',
      'Managed toolchain canonical artifact path changed after admission',
    );
  }
  return Object.freeze({
    executablePath,
    entrypointPath,
    nodeVersion: record.release.nodeVersion,
    platform: record.release.platform,
    arch: record.release.arch,
    profileVersion: 1 as const,
    allowedEffectClasses: record.release.allowedEffectClasses,
    identityDigest: managedToolchainIdentityDigest(record.release),
  });
}

function managedToolchainIdentityDigest(
  release: ManagedToolchainReleaseStateInternal,
): `sha256:${string}` {
  const canonical = JSON.stringify({
    protocol: 'managed_toolchain_identity_v1',
    executableSha256: release.executableSha256,
    executableBytes: release.executableBytes,
    entrypointSha256: release.entrypointSha256,
    entrypointBytes: release.entrypointBytes,
    nodeVersion: release.nodeVersion,
    platform: release.platform,
    arch: release.arch,
    profileVersion: release.profileVersion,
    allowedEffectClasses: [...release.allowedEffectClasses].sort(),
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function assertReleaseState(state: ManagedToolchainReleaseStateInternal): void {
  if (
    !isAbsolute(state.executablePath) ||
    !isAbsolute(state.entrypointPath) ||
    !SHA256_PATTERN.test(state.executableSha256) ||
    !SHA256_PATTERN.test(state.entrypointSha256) ||
    !isBoundedBytes(state.executableBytes, MAX_EXECUTABLE_BYTES) ||
    !isBoundedBytes(state.entrypointBytes, MAX_ENTRYPOINT_BYTES) ||
    !NODE_VERSION_PATTERN.test(state.nodeVersion) ||
    !state.platform ||
    !state.arch ||
    state.profileVersion !== 1 ||
    !Array.isArray(state.allowedEffectClasses) ||
    state.allowedEffectClasses.length === 0 ||
    new Set(state.allowedEffectClasses).size !== state.allowedEffectClasses.length ||
    !state.allowedEffectClasses.every((value) =>
      MANAGED_TOOLCHAIN_EFFECT_CLASSES_INTERNAL.includes(value),
    )
  ) {
    throw authorityError(
      'managed_toolchain_release_claim_invalid',
      'Managed toolchain release state is invalid',
    );
  }
}

function isBoundedBytes(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

async function verifyFile(
  path: string,
  expectedBytes: number,
  expectedSha256: `sha256:${string}`,
  maximumBytes: number,
  label: string,
): Promise<string> {
  let handle;
  try {
    if (!isBoundedBytes(expectedBytes, maximumBytes)) {
      throw authorityError(
        'managed_toolchain_artifact_invalid',
        `Managed toolchain ${label} size is invalid`,
      );
    }
    await assertNoSymbolicLinkComponents(path, label);
    const canonicalPath = await realpath(path);
    handle = await open(canonicalPath, 'r');
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || initial.size !== BigInt(expectedBytes)) {
      throw authorityError(
        'managed_toolchain_artifact_identity_mismatch',
        `Managed toolchain ${label} size or file type changed`,
      );
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;
    while (position < expectedBytes) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - position),
        position,
      );
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const finalHandle = await handle.stat({ bigint: true });
    const finalPath = await lstat(canonicalPath, { bigint: true });
    if (
      position !== expectedBytes ||
      initial.dev !== finalHandle.dev ||
      initial.ino !== finalHandle.ino ||
      initial.size !== finalHandle.size ||
      initial.mtimeNs !== finalHandle.mtimeNs ||
      initial.ctimeNs !== finalHandle.ctimeNs ||
      finalHandle.dev !== finalPath.dev ||
      finalHandle.ino !== finalPath.ino ||
      finalHandle.size !== finalPath.size ||
      `sha256:${digest.digest('hex')}` !== expectedSha256
    ) {
      throw authorityError(
        'managed_toolchain_artifact_identity_mismatch',
        `Managed toolchain ${label} changed while it was verified`,
      );
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof ManagedToolchainArtifactAuthorityError) throw error;
    throw authorityError(
      'managed_toolchain_artifact_invalid',
      `Managed toolchain ${label} could not be verified`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertNoSymbolicLinkComponents(path: string, label: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const segments = relative(root, absolutePath).split(sep).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) {
      throw authorityError(
        'managed_toolchain_artifact_invalid',
        `Managed toolchain ${label} path must not traverse a symbolic link or junction`,
      );
    }
  }
}

function authorityError(
  code: ManagedToolchainArtifactAuthorityErrorCode,
  message: string,
): ManagedToolchainArtifactAuthorityError {
  return new ManagedToolchainArtifactAuthorityError(code, message);
}
