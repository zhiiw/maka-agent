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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  admitManagedToolchainArtifactInternal,
  issueManagedToolchainReleaseClaimInternal,
  ManagedToolchainArtifactAuthorityError,
  verifyManagedToolchainForInvocationInternal,
} from '../server/managed-toolchain-artifact-authority-internal.js';

test('release owner admits one owner-bound toolchain and re-verifies both artifacts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-toolchain-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, 'node-runtime.bin');
  const entrypointPath = join(root, 'managed-runner.mjs');
  await writeFile(executablePath, 'verified runtime\n', 'utf8');
  await writeFile(entrypointPath, 'export {};\n', 'utf8');
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueManagedToolchainReleaseClaimInternal(
    releaseOwnerToken,
    await releaseState(executablePath, entrypointPath),
  );
  const capability = await admitManagedToolchainArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim,
  });

  const verified = await verifyManagedToolchainForInvocationInternal(
    invocationOwnerToken,
    capability,
    'hermetic_observation_v1',
  );
  assert.equal(verified.executablePath, executablePath);
  assert.equal(verified.entrypointPath, entrypointPath);
  assert.match(verified.identityDigest, /^sha256:[0-9a-f]{64}$/u);
  await assert.rejects(
    verifyManagedToolchainForInvocationInternal({}, capability, 'hermetic_observation_v1'),
    (error) =>
      error instanceof ManagedToolchainArtifactAuthorityError &&
      error.code === 'managed_toolchain_invocation_capability_invalid',
  );
});

test('invocation fails closed after the entrypoint bytes change', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-toolchain-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, 'node-runtime.bin');
  const entrypointPath = join(root, 'managed-runner.mjs');
  await writeFile(executablePath, 'verified runtime\n', 'utf8');
  await writeFile(entrypointPath, 'export {};\n', 'utf8');
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueManagedToolchainReleaseClaimInternal(
    releaseOwnerToken,
    await releaseState(executablePath, entrypointPath),
  );
  const capability = await admitManagedToolchainArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim,
  });
  await writeFile(entrypointPath, 'throw new Error();\n', 'utf8');

  await assert.rejects(
    verifyManagedToolchainForInvocationInternal(
      invocationOwnerToken,
      capability,
      'workspace_transform_v1',
    ),
    (error) =>
      error instanceof ManagedToolchainArtifactAuthorityError &&
      error.code === 'managed_toolchain_artifact_identity_mismatch',
  );
});

async function releaseState(executablePath: string, entrypointPath: string) {
  const executable = await fileIdentity(executablePath);
  const entrypoint = await fileIdentity(entrypointPath);
  return {
    executablePath,
    executableSha256: executable.sha256,
    executableBytes: executable.bytes,
    entrypointPath,
    entrypointSha256: entrypoint.sha256,
    entrypointBytes: entrypoint.bytes,
    nodeVersion: '24.18.1',
    platform: process.platform,
    arch: process.arch,
    profileVersion: 1 as const,
    allowedEffectClasses: ['hermetic_observation_v1', 'workspace_transform_v1'] as const,
  };
}

async function fileIdentity(path: string) {
  const content = await readFile(path);
  return {
    sha256: `sha256:${createHash('sha256').update(content).digest('hex')}` as const,
    bytes: (await stat(path)).size,
  };
}
