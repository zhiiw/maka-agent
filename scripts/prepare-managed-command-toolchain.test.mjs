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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareManagedCommandToolchain } from './prepare-managed-command-toolchain.mjs';

test('prepares one bounded managed-command entrypoint and exact release manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-command-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'managed-command-helper-main.js');
  const outputRoot = join(root, 'output');
  await writeFile(source, 'process.stdout.write("ready");\n', 'utf8');

  const result = await prepareManagedCommandToolchain({
    sourceEntrypointPath: source,
    outputRoot,
    platform: 'win32',
    arch: 'x64',
    nodeVersion: '24.18.1',
  });

  assert.equal(await readFile(result.entrypointPath, 'utf8'), 'process.stdout.write("ready");\n');
  assert.deepEqual(JSON.parse(await readFile(result.manifestPath, 'utf8')), {
    schemaVersion: 2,
    protocol: 'maka_managed_command_toolchain_release_v2',
    provider: 'maka/managed-command-toolchain',
    platform: 'win32',
    arch: 'x64',
    nodeVersion: '24.18.1',
    profileVersion: 1,
    entrypointRelativePath: 'managed-command/managed-command-helper-main.js',
    entrypointBytes: 31,
    entrypointSha256: result.entrypointSha256,
    allowedEffectClasses: ['hermetic_observation_v2'],
    distributionReady: true,
  });
});

test('rejects an unsupported Node release before publishing output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-command-package-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'managed-command-helper-main.js');
  await writeFile(source, 'export {};\n', 'utf8');
  await assert.rejects(
    prepareManagedCommandToolchain({
      sourceEntrypointPath: source,
      outputRoot: join(root, 'output'),
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '26.0.0',
    }),
    /input is invalid/u,
  );
});
