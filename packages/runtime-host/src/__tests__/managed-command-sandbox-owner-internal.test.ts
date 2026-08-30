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
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  if (process.platform === 'win32') {
    assert.equal(transformedRequest?.command.env?.SystemRoot, process.env.SystemRoot);
    assert.equal(transformedRequest?.command.env?.SystemDrive, process.env.SystemDrive);
    assert.equal(transformedRequest?.command.env?.LOCALAPPDATA, process.env.LOCALAPPDATA);
  }
  assert.equal(dirname(transformedRequest?.command.program ?? ''), dirname(executablePath));
});

test('runs explicit dependency-free Node tests in one sandboxed helper process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-node-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = join(root, 'input');
  const scratchRoot = join(root, 'scratch');
  await Promise.all([mkdir(inputRoot), mkdir(scratchRoot)]);
  await writeFile(
    join(inputRoot, 'accepted.test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "test('accepted content passes', () => { console.log('bounded diagnostic'); assert.equal(2 + 2, 4); });",
      "test('explicit skip', { skip: true }, () => {});",
      '',
    ].join('\n'),
    'utf8',
  );
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
  const owner = createManagedCommandSandboxOwnerInternal({
    invocationOwnerToken,
    toolchainCapability: capability,
    sandboxManager: {
      transform(request): SandboxTransformResult {
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

  const result = await owner.runNodeTests({
    inputRoot,
    scratchRoot,
    relativePaths: ['accepted.test.mjs'],
  });
  assert.deepEqual(result, {
    protocolVersion: 1,
    kind: 'node_test_observation',
    nodeVersion: '24.18.1',
    files: [
      {
        relativePath: 'accepted.test.mjs',
        bytes: (await stat(join(inputRoot, 'accepted.test.mjs'))).size,
        sha256: await sha256(join(inputRoot, 'accepted.test.mjs')),
      },
    ],
    passed: 1,
    failed: 0,
    skipped: 1,
    todo: 0,
  });

  await writeFile(
    join(inputRoot, 'denied-effects.test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { spawnSync } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "import test from 'node:test';",
      "test('cannot spawn descendants', () => assert.throws(() => spawnSync(process.execPath, ['-e', ''])))",
      "test('cannot mutate accepted input', () => assert.throws(() => writeFileSync(new URL('./tamper.txt', import.meta.url), 'x')))",
      '',
    ].join('\n'),
    'utf8',
  );
  const deniedEffects = await owner.runNodeTests({
    inputRoot,
    scratchRoot,
    relativePaths: ['denied-effects.test.mjs'],
  });
  assert.equal(deniedEffects.passed, 2);
  assert.equal(deniedEffects.failed, 0);
  await assert.rejects(stat(join(inputRoot, 'tamper.txt')), /ENOENT/u);

  await writeFile(
    join(inputRoot, 'failing.test.mjs'),
    "import test from 'node:test'; test('reported failure', () => { throw new Error('expected'); });\n",
    'utf8',
  );
  const failing = await owner.runNodeTests({
    inputRoot,
    scratchRoot,
    relativePaths: ['failing.test.mjs'],
  });
  assert.equal(failing.passed, 0);
  assert.equal(failing.failed, 1);

  await writeFile(join(inputRoot, 'empty.test.mjs'), 'export {};\n', 'utf8');
  await assert.rejects(
    owner.runNodeTests({
      inputRoot,
      scratchRoot,
      relativePaths: ['empty.test.mjs'],
    }),
    /did not report any tests/u,
  );

  try {
    await symlink('accepted.test.mjs', join(inputRoot, 'alias.test.mjs'), 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  try {
    await stat(join(inputRoot, 'alias.test.mjs'));
    await assert.rejects(
      owner.runNodeTests({
        inputRoot,
        scratchRoot,
        relativePaths: ['alias.test.mjs'],
      }),
      /did not complete safely/u,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
});

async function fileIdentity(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return {
    sha256: `sha256:${digest.digest('hex')}` as const,
    bytes: (await stat(path)).size,
  };
}

async function sha256(path: string): Promise<`sha256:${string}`> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return `sha256:${digest.digest('hex')}`;
}
