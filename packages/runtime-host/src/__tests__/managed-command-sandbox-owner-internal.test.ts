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
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { SandboxTransformRequest, SandboxTransformResult } from '@maka/runtime/sandbox';
import { createManagedDependencySnapshotAuthority } from '@maka/storage/managed-dependency-snapshot-authority';
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
  const dependencyLeaseConsumerOwnerToken = {};
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
      allowedEffectClasses: ['hermetic_observation_v2'],
    }),
  });
  let transformedRequest: SandboxTransformRequest | undefined;
  const owner = createManagedCommandSandboxOwnerInternal({
    invocationOwnerToken,
    dependencyLeaseConsumerOwnerToken,
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
  assert.equal(transformedRequest?.command.pathContext.runtimeWritableRoots, undefined);
  if (process.platform === 'win32') {
    assert.equal(transformedRequest?.command.env?.SystemRoot, process.env.SystemRoot);
    assert.equal(transformedRequest?.command.env?.SystemDrive, process.env.SystemDrive);
    assert.equal(transformedRequest?.command.env?.LOCALAPPDATA, process.env.LOCALAPPDATA);
    assert.deepEqual(transformedRequest?.command.pathContext.runtimeExactReadableRoots, [
      ...new Set(
        [inputRoot, scratchRoot, executablePath, entrypointPath].map((path) => path.slice(0, 3)),
      ),
    ]);
  }
  assert.equal(dirname(transformedRequest?.command.program ?? ''), dirname(executablePath));
  assert.equal(
    transformedRequest?.command.args[0],
    process.platform === 'win32' ? '--no-stdio-init' : '--permission',
  );
  assert.deepEqual(transformedRequest?.command.args.slice(-2), [
    'maka-observe-file-v1',
    'notes.txt',
  ]);
});

test('runs explicit dependency-free Node tests as one sandboxed root process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-node-test-'));
  let closeDependencyAuthority: () => Promise<void> = async () => {};
  t.after(async () => {
    await closeDependencyAuthority();
    await rm(root, { recursive: true, force: true });
  });
  const inputRoot = join(root, 'input');
  const scratchRoot = join(root, 'scratch');
  await Promise.all([mkdir(inputRoot), mkdir(scratchRoot)]);
  await writeFile(
    join(inputRoot, 'accepted.test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "test('accepted content passes', () => { console.log('bounded diagnostic'); assert.equal(2 + 2, 4); });",
      "test('one-shot helper owns leaked handles', () => { setInterval(() => {}, 60_000); assert.ok(true); });",
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
  const dependencyLeaseConsumerOwnerToken = {};
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
      allowedEffectClasses: ['hermetic_observation_v2'],
    }),
  });
  const transformedRequests: SandboxTransformRequest[] = [];
  const owner = createManagedCommandSandboxOwnerInternal({
    invocationOwnerToken,
    dependencyLeaseConsumerOwnerToken,
    toolchainCapability: capability,
    sandboxManager: {
      transform(request): SandboxTransformResult {
        transformedRequests.push(request);
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
    passed: 2,
    failed: 0,
    skipped: 1,
    todo: 0,
  });
  assert.ok(
    transformedRequests.some((request) => request.command.args.includes('maka-node-tests-v1')),
  );
  assert.ok(
    transformedRequests.some((request) => request.command.args.includes('--test-force-exit')),
  );

  const dependencySourceRoot = join(root, 'dependency-source', 'node_modules');
  await mkdir(join(dependencySourceRoot, 'fixture-dependency'), { recursive: true });
  await writeFile(
    join(dependencySourceRoot, 'fixture-dependency', 'package.json'),
    '{"name":"fixture-dependency","type":"module","exports":"./index.js"}\n',
    'utf8',
  );
  await writeFile(
    join(dependencySourceRoot, 'fixture-dependency', 'index.js'),
    'export const answer = 42;\n',
    'utf8',
  );
  const dependencyAuthority = await createManagedDependencySnapshotAuthority({
    storageRoot: join(root, 'dependency-storage'),
    leaseConsumerOwnerToken: dependencyLeaseConsumerOwnerToken,
    nodeRuntime: {
      version: '24.18.1',
      abi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    },
  });
  closeDependencyAuthority = () => dependencyAuthority.close();
  const dependencyLease = await dependencyAuthority.acquire({
    sourceDependencyRoot: dependencySourceRoot,
    manifestBytes: Buffer.from('{"name":"fixture"}\n'),
    lockfileBytes: Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{}}\n'),
  });
  assert.deepEqual(await owner.readDependencyIdentity(dependencyLease), {
    environmentId: dependencyLease.environmentId,
    contentTreeSha256: dependencyLease.contentTreeSha256,
    nodeVersion: '24.18.1',
    nodeAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  });
  await assert.rejects(
    owner.readDependencyIdentity({
      environmentId: dependencyLease.environmentId,
      contentTreeSha256: dependencyLease.contentTreeSha256,
      async release() {},
    }),
    /lease capability is invalid/u,
  );
  await writeFile(
    join(inputRoot, 'dependency.test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { answer } from 'fixture-dependency';",
      "test('uses the leased dependency snapshot', () => assert.equal(answer, 42));",
      '',
    ].join('\n'),
    'utf8',
  );
  const withDependency = await owner.runNodeTests({
    inputRoot,
    scratchRoot,
    relativePaths: ['dependency.test.mjs'],
    dependencyLease,
  });
  assert.equal(withDependency.passed, 1);
  assert.equal(withDependency.failed, 0);
  await dependencyLease.release();
  await assert.rejects(
    owner.runNodeTests({
      inputRoot,
      scratchRoot,
      relativePaths: ['dependency.test.mjs'],
      dependencyLease,
    }),
    /lease capability is invalid/u,
  );

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

test('runs one explicit accepted-tree Node entrypoint without PATH, network, or child authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-node-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = join(root, 'input');
  const scratchRoot = join(root, 'scratch');
  await Promise.all([mkdir(join(inputRoot, 'scripts'), { recursive: true }), mkdir(scratchRoot)]);
  await writeFile(
    join(inputRoot, 'scripts', 'check.mjs'),
    [
      "import { writeFile } from 'node:fs/promises';",
      "import { spawnSync } from 'node:child_process';",
      "let inputWrite = 'allowed';",
      "try { await writeFile(new URL('./tampered.txt', import.meta.url), 'bad'); } catch { inputWrite = 'blocked'; }",
      "let child = 'allowed';",
      "try { spawnSync(process.execPath, ['--version']); } catch { child = 'blocked'; }",
      "await writeFile(process.env.TMP + '/scratch.txt', 'ok');",
      'console.log(JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH, inputWrite, child }));',
      'process.exitCode = 7;',
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
      allowedEffectClasses: ['hermetic_observation_v3'],
    }),
  });
  let transformedRequest: SandboxTransformRequest | undefined;
  const owner = createManagedCommandSandboxOwnerInternal({
    invocationOwnerToken,
    dependencyLeaseConsumerOwnerToken: {},
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

  const result = await owner.runNodeEntrypoint!({
    inputRoot,
    scratchRoot,
    entryPath: 'scripts/check.mjs',
    args: ['--check', 'src/index.js'],
  });
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.kind, 'node_command_observation');
  assert.equal(result.entry.relativePath, 'scripts/check.mjs');
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    argv: ['--check', 'src/index.js'],
    path: '',
    inputWrite: 'blocked',
    child: 'blocked',
  });
  assert.equal(
    transformedRequest?.command.profile.type === 'managed'
      ? transformedRequest.command.profile.network.kind
      : undefined,
    'restricted',
  );
  assert.equal(await stat(join(scratchRoot, 'scratch.txt')).then((value) => value.size), 2);
  await assert.rejects(stat(join(inputRoot, 'scripts', 'tampered.txt')));
});

test('runs one accepted-tree transform into the owner-selected single output file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-node-transform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = join(root, 'input');
  const scratchRoot = join(root, 'scratch');
  await Promise.all([mkdir(join(inputRoot, 'scripts'), { recursive: true }), mkdir(scratchRoot)]);
  await writeFile(join(inputRoot, 'source.txt'), 'accepted world\n', 'utf8');
  await writeFile(
    join(inputRoot, 'scripts', 'generate.mjs'),
    [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "import { spawnSync } from 'node:child_process';",
      "const source = await readFile(new URL('../source.txt', import.meta.url), 'utf8');",
      "let inputWrite = 'allowed';",
      "try { await writeFile(new URL('../tampered.txt', import.meta.url), 'bad'); } catch { inputWrite = 'blocked'; }",
      "let child = 'allowed';",
      "try { spawnSync(process.execPath, ['--version']); } catch { child = 'blocked'; }",
      'await writeFile(process.env.MAKA_OUTPUT_PATH, `${source.trim()}|${process.argv[2]}|${inputWrite}|${child}\\n`);',
      "console.log('generated one bounded output');",
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
      allowedEffectClasses: ['hermetic_observation_v3', 'workspace_transform_v1'],
    }),
  });
  const transformedRequests: SandboxTransformRequest[] = [];
  const owner = createManagedCommandSandboxOwnerInternal({
    invocationOwnerToken,
    dependencyLeaseConsumerOwnerToken: {},
    toolchainCapability: capability,
    sandboxManager: {
      transform(request): SandboxTransformResult {
        transformedRequests.push(request);
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

  const result = await owner.runNodeTransform!({
    inputRoot,
    scratchRoot,
    entryPath: 'scripts/generate.mjs',
    outputPath: 'generated/output.txt',
    args: ['stable'],
  });
  assert.equal(result.path, 'generated/output.txt');
  assert.equal(result.content, 'accepted world|stable|blocked|blocked\n');
  assert.equal(result.bytes, Buffer.byteLength(result.content));
  assert.equal(
    result.sha256,
    `sha256:${createHash('sha256').update(result.content).digest('hex')}`,
  );
  assert.equal(result.stdout, 'generated one bounded output\n');
  assert.equal(result.stderr, '');
  assert.equal(
    await stat(join(scratchRoot, 'maka-transform-output')).then((value) => value.size),
    result.bytes,
  );
  await assert.rejects(stat(join(inputRoot, 'tampered.txt')), /ENOENT/u);
  assert.equal(await readFile(join(inputRoot, 'source.txt'), 'utf8'), 'accepted world\n');
  assert.ok(
    transformedRequests.some(
      (request) =>
        request.command.env?.MAKA_OUTPUT_PATH === join(scratchRoot, 'maka-transform-output'),
    ),
  );
  assert.ok(transformedRequests.every((request) => request.command.env?.PATH === ''));
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
