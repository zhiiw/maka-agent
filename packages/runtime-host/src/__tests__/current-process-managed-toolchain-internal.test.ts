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
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('admits the current Electron Node runtime and packaged command entrypoint where supported', async (t) => {
  const fixture = await createFixture(t);
  if (process.platform === 'win32') {
    await assert.rejects(
      runElectronChild(fixture.resourcesRoot),
      /independently admitted standalone Node runtime/u,
    );
    return;
  }
  const result = await runElectronChild(fixture.resourcesRoot);
  const value = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(value.nodeVersion, fixture.nodeVersion);
  assert.equal(value.entrypointName, 'managed-command-helper-main.js');
  assert.match(String(value.identityDigest), /^sha256:[0-9a-f]{64}$/u);
});

test('rejects a command entrypoint changed after its release manifest was written', {
  skip:
    process.platform === 'win32'
      ? 'Windows does not admit Electron as the managed Node runtime'
      : false,
}, async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.entrypointPath, 'throw new Error("tampered");\n', 'utf8');
  await assert.rejects(runElectronChild(fixture.resourcesRoot), /failed release admission/u);
});

test('rejects the superseded v2 release envelope instead of silently weakening v3', {
  skip:
    process.platform === 'win32'
      ? 'Windows does not admit Electron as the managed Node runtime'
      : false,
}, async (t) => {
  const fixture = await createFixture(t);
  const manifestPath = join(fixture.resourcesRoot, 'managed-command-toolchain.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      ...manifest,
      schemaVersion: 2,
      protocol: 'maka_managed_command_toolchain_release_v2',
      allowedEffectClasses: ['hermetic_observation_v2'],
    })}\n`,
    'utf8',
  );
  await assert.rejects(runElectronChild(fixture.resourcesRoot), /failed release admission/u);
});

async function createFixture(t: test.TestContext) {
  const resourcesRoot = await mkdtemp(join(tmpdir(), 'maka-current-process-toolchain-'));
  t.after(() => rm(resourcesRoot, { recursive: true, force: true }));
  const runtimeRoot = join(resourcesRoot, 'managed-command');
  await mkdir(runtimeRoot);
  const sourceEntrypoint = resolve(
    import.meta.dirname,
    '..',
    'server',
    'managed-command-helper-main.js',
  );
  const entrypointPath = join(runtimeRoot, 'managed-command-helper-main.js');
  await copyFile(sourceEntrypoint, entrypointPath);
  const entrypoint = await readFile(entrypointPath);
  const nodeVersion = '24.18.1';
  await writeFile(
    join(resourcesRoot, 'managed-command-toolchain.json'),
    `${JSON.stringify({
      schemaVersion: 3,
      protocol: 'maka_managed_command_toolchain_release_v3',
      provider: 'maka/managed-command-toolchain',
      platform: process.platform,
      arch: process.arch,
      nodeVersion,
      profileVersion: 1,
      entrypointRelativePath: 'managed-command/managed-command-helper-main.js',
      entrypointBytes: (await stat(entrypointPath)).size,
      entrypointSha256: `sha256:${createHash('sha256').update(entrypoint).digest('hex')}`,
      allowedEffectClasses: ['hermetic_observation_v2', 'hermetic_observation_v3'],
      distributionReady: true,
    })}\n`,
    'utf8',
  );
  return { resourcesRoot, entrypointPath, nodeVersion };
}

async function runElectronChild(resourcesRoot: string) {
  const electronExecutable = resolve(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  const childPath = resolve(
    import.meta.dirname,
    'fixtures',
    'current-process-managed-toolchain-child.js',
  );
  return await execFileAsync(electronExecutable, [childPath, resourcesRoot], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
    windowsHide: true,
  });
}
