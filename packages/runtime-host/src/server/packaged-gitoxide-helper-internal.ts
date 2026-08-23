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

import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import {
  admitGitoxideHelperArtifactInternal,
  GitoxideHelperArtifactAuthorityError,
  issueGitoxideHelperReleaseArtifactClaimInternal,
  type GitoxideHelperInvocationCapability,
} from './gitoxide-helper-artifact-authority-internal.js';

const MANIFEST_KEYS = [
  'arch',
  'bytes',
  'distributionReady',
  'executableRelativePath',
  'platform',
  'protocol',
  'protocolVersion',
  'provider',
  'schemaVersion',
  'sha256',
] as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_HELPER_BYTES = 256 * 1024 * 1024;

export type PackagedGitoxideHelperErrorCode =
  | 'packaged_gitoxide_helper_unavailable'
  | 'packaged_gitoxide_helper_manifest_invalid'
  | 'packaged_gitoxide_helper_platform_mismatch'
  | 'packaged_gitoxide_helper_integrity_mismatch';

export class PackagedGitoxideHelperError extends Error {
  constructor(
    readonly code: PackagedGitoxideHelperErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PackagedGitoxideHelperError';
  }
}

export async function resolvePackagedGitoxideHelperInternal(input: {
  readonly resourcesRoot: string;
  readonly releaseOwnerToken: object;
  readonly invocationOwnerToken: object;
}): Promise<GitoxideHelperInvocationCapability> {
  try {
    const resourcesRoot = normalize(await realpath(input.resourcesRoot));
    const manifestPath = normalize(await realpath(join(resourcesRoot, 'gitoxide-helper.json')));
    assertWithinRoot(resourcesRoot, manifestPath, 'Gitoxide helper manifest');
    const manifestInfo = await lstat(manifestPath);
    if (
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      manifestInfo.size > MAX_MANIFEST_BYTES
    ) {
      throw invalidManifest('Gitoxide helper manifest must be a bounded regular file');
    }
    const manifest = decodeManifest(parseManifest(await readFile(manifestPath, 'utf8')));
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
      throw new PackagedGitoxideHelperError(
        'packaged_gitoxide_helper_platform_mismatch',
        `Packaged Gitoxide helper targets ${manifest.platform}/${manifest.arch}, not ${process.platform}/${process.arch}`,
      );
    }
    const executablePath = normalize(
      await realpath(join(resourcesRoot, ...manifest.executableRelativePath.split('/'))),
    );
    assertWithinRoot(resourcesRoot, executablePath, 'Gitoxide helper executable');
    const claim = issueGitoxideHelperReleaseArtifactClaimInternal(input.releaseOwnerToken, {
      executablePath,
      expectedSha256: manifest.sha256,
      expectedBytes: manifest.bytes,
      platform: manifest.platform,
      arch: manifest.arch,
      protocolVersion: manifest.protocolVersion,
    });
    return await admitGitoxideHelperArtifactInternal({
      releaseOwnerToken: input.releaseOwnerToken,
      invocationOwnerToken: input.invocationOwnerToken,
      claim,
    });
  } catch (error) {
    if (error instanceof PackagedGitoxideHelperError) throw error;
    if (error instanceof GitoxideHelperArtifactAuthorityError) {
      throw new PackagedGitoxideHelperError(
        error.code === 'gitoxide_helper_artifact_identity_mismatch'
          ? 'packaged_gitoxide_helper_integrity_mismatch'
          : 'packaged_gitoxide_helper_unavailable',
        'Packaged Gitoxide helper failed release admission',
        { cause: error },
      );
    }
    throw new PackagedGitoxideHelperError(
      'packaged_gitoxide_helper_unavailable',
      'Packaged Gitoxide helper is unavailable',
      { cause: error },
    );
  }
}

interface PackagedGitoxideHelperManifestV1 {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_gitoxide_helper_release_v1';
  readonly provider: 'maka/gitoxide-helper';
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly protocolVersion: 1;
  readonly executableRelativePath: string;
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
  readonly distributionReady: true;
}

function decodeManifest(input: unknown): PackagedGitoxideHelperManifestV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidManifest('Gitoxide helper manifest must be an object');
  }
  const value = input as Record<string, unknown>;
  const expectedExecutable =
    value.platform === 'win32'
      ? 'gitoxide/maka-gitoxide-helper.exe'
      : 'gitoxide/maka-gitoxide-helper';
  if (
    Object.keys(value).sort().join('\0') !== [...MANIFEST_KEYS].sort().join('\0') ||
    value.schemaVersion !== 1 ||
    value.protocol !== 'maka_gitoxide_helper_release_v1' ||
    value.provider !== 'maka/gitoxide-helper' ||
    (value.platform !== 'win32' && value.platform !== 'darwin' && value.platform !== 'linux') ||
    typeof value.arch !== 'string' ||
    !/^[a-z0-9_]+$/u.test(value.arch) ||
    value.protocolVersion !== 1 ||
    value.executableRelativePath !== expectedExecutable ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 1 ||
    (value.bytes as number) > MAX_HELPER_BYTES ||
    typeof value.sha256 !== 'string' ||
    !SHA256_PATTERN.test(value.sha256) ||
    value.distributionReady !== true
  ) {
    throw invalidManifest('Gitoxide helper manifest is invalid');
  }
  return value as unknown as PackagedGitoxideHelperManifestV1;
}

function parseManifest(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw invalidManifest(`Gitoxide helper manifest is not valid JSON: ${String(error)}`);
  }
}

function assertWithinRoot(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw invalidManifest(`${label} escapes the packaged resources root`);
}

function invalidManifest(message: string): PackagedGitoxideHelperError {
  return new PackagedGitoxideHelperError('packaged_gitoxide_helper_manifest_invalid', message);
}
