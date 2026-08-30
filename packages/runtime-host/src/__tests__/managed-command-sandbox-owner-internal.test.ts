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
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { SandboxTransformRequest, SandboxTransformResult } from '@maka/runtime/sandbox';
import { createManagedCommandSandboxOwnerInternal } from '../server/managed-command-sandbox-owner-internal.js';
import {
  admitManagedToolchainArtifactInternal,
  issueManagedToolchainReleaseClaimInternal,
} from '../server/managed-toolchain-artifact-authority-internal.js';

test('runs one bounded file observation through an enforcing sandbox plan', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = join(root, 'input');
  const scratchRoot = join(root, 'scratch');
  await Promise.all([mkdir(inputRoot), mkdir(scratchRoot)]);
  await writeFile(join(inputRoot, 'notes.txt'), 'accepted world\n', 'utf8');
  const executablePath = resolve(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  const entrypointPath = resolve(
    import.meta.dirname,
    '..',
    'server',
    'managed-command-helper-main.js',
  );
  const executable = await fileIdentity(executablePath);
  const entrypoint = await fileIdentity(entrypointPath);
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const capability = await admitManagedToolchainArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim: issueManagedToolchainReleaseClaimInternal(releaseOwnerToken, {
      executablePath,
      executableSha256: executable.sha256,
      executableBytes: executable.bytes,
      entrypointPath,
      entrypointSha256: entrypoint.sha256,
      entrypointBytes: entrypoint.bytes,
      nodeVersion: '24.18.1',
      platform: process.platform,
      arch: process.arch,
      profileVersion: 1,
      allowedEffectClasses: ['hermetic_observation_v1'],
    }),
  });
  let transformedRequest: SandboxTransformRequest | undefined;
  const owner = createManagedCommandSandboxOwnerInternal({
    invocationOwnerToken,
    toolchainCapability: capability,
    sandboxManager: {
      transform(request): SandboxTransformResult {
        transformedRequest = request;
        return {
          ok: true,
          exec: {
            argv: [request.command.program, ...request.command.args],
            cwd: request.command.cwd,
            env: request.command.env,
            sandboxType: 'windows',
            effectiveProfile: request.command.profile,
          },
          sandboxType: 'windows',
          requiresSandbox: true,
          preference: 'require',
        };
      },
    },
  });

  const result = await owner.inspectFile({
    inputRoot,
    scratchRoot,
    relativePath: 'notes.txt',
  });
  assert.deepEqual(result, {
    protocolVersion: 1,
    kind: 'file_observation',
    relativePath: 'notes.txt',
    bytes: 15,
    sha256: `sha256:${createHash('sha256').update('accepted world\n').digest('hex')}`,
  });
  assert.equal(transformedRequest?.preference, 'require');
  assert.equal(transformedRequest?.command.profile.type, 'managed');
  assert.equal(
    transformedRequest?.command.profile.type === 'managed'
      ? transformedRequest.command.profile.network.kind
      : undefined,
    'restricted',
  );
  assert.equal(transformedRequest?.command.env?.PATH, '');
  assert.equal(dirname(transformedRequest?.command.program ?? ''), dirname(executablePath));
});

async function fileIdentity(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return {
    sha256: `sha256:${digest.digest('hex')}` as const,
    bytes: (await stat(path)).size,
  };
}
