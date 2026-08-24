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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareWindowsUpgradeBaseline } from './prepare-windows-upgrade-baseline.mjs';

test('downloads the pinned upgrade artifact from the manifest authority, not the workflow fork', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-windows-upgrade-authority-'));
  const manifestPath = join(root, 'baseline.json');
  const outputDirectory = join(root, 'download');
  const digest = 'a'.repeat(64);
  const calls = [];
  const previousRepository = process.env.GITHUB_REPOSITORY;
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      repository: 'apache/maka',
      version: '1.2.2',
      tag: 'v1.2.2',
      assetName: 'Maka-1.2.2-win-x64.exe',
      sha256: digest,
    })}\n`,
    'utf8',
  );

  try {
    process.env.GITHUB_REPOSITORY = 'zhiiw/maka-agent';
    await prepareWindowsUpgradeBaseline('1.2.3', outputDirectory, {
      manifestPath,
      run: async (command, args) => {
        calls.push({ command, args });
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, 'Maka-1.2.2-win-x64.exe'), 'fixture');
      },
      checksum: async () => digest,
    });
    assert.deepEqual(calls, [
      {
        command: 'gh',
        args: [
          'release',
          'download',
          'v1.2.2',
          '--repo',
          'apache/maka',
          '--pattern',
          'Maka-1.2.2-win-x64.exe',
          '--dir',
          outputDirectory,
        ],
      },
    ]);
  } finally {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
    await rm(root, { recursive: true, force: true });
  }
});
