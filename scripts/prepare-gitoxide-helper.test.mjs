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
import {
  GITOXIDE_HELPER_RELEASE_OPERATIONS,
  prepareGitoxideHelper,
} from './prepare-gitoxide-helper.mjs';

test('prepares an exact helper and strict release manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-package-'));
  try {
    const source = join(root, process.platform === 'win32' ? 'helper.exe' : 'helper');
    await writeFile(source, 'exact-helper-bytes');
    const result = await prepareGitoxideHelper({
      sourceExecutablePath: source,
      outputRoot: join(root, 'resources'),
      platform: process.platform,
      arch: process.arch,
    });
    assert.equal(await readFile(result.executablePath, 'utf8'), 'exact-helper-bytes');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.sha256, result.sha256);
    assert.deepEqual(manifest.supportedOperations, GITOXIDE_HELPER_RELEASE_OPERATIONS);
    assert.equal(manifest.distributionReady, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to prepare a missing helper artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-package-missing-'));
  try {
    await assert.rejects(
      prepareGitoxideHelper({
        sourceExecutablePath: join(root, 'missing'),
        outputRoot: join(root, 'resources'),
        platform: process.platform,
        arch: process.arch,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
