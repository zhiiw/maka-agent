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
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GITOXIDE_HELPER_OPERATIONS_INTERNAL,
  verifyGitoxideHelperArtifactForInvocationInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  PackagedGitoxideHelperError,
  resolvePackagedGitoxideHelperInternal,
} from '../server/packaged-gitoxide-helper-internal.js';

test('turns the strict release manifest into an owner-bound helper capability', async () => {
  const fixture = await createFixture();
  try {
    const invocationOwnerToken = {};
    const capability = await resolvePackagedGitoxideHelperInternal({
      invocationOwnerToken,
      resourcesRoot: fixture.root,
    });
    const verified = await verifyGitoxideHelperArtifactForInvocationInternal(
      invocationOwnerToken,
      capability,
    );
    assert.equal(verified.executablePath, fixture.executablePath);
    assert.deepEqual(verified.supportedOperations, GITOXIDE_HELPER_OPERATIONS_INTERNAL);
  } finally {
    await fixture.cleanup();
  }
});

test('fails closed for helper tamper and operation-list drift', async () => {
  const tampered = await createFixture();
  try {
    await writeFile(tampered.executablePath, 'tampered');
    await assert.rejects(
      resolvePackagedGitoxideHelperInternal({
        invocationOwnerToken: {},
        resourcesRoot: tampered.root,
      }),
      (error: unknown) =>
        error instanceof PackagedGitoxideHelperError &&
        error.code === 'packaged_gitoxide_helper_integrity_mismatch',
    );
  } finally {
    await tampered.cleanup();
  }

  const narrowed = await createFixture();
  try {
    const manifestPath = join(narrowed.root, 'gitoxide-helper.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.supportedOperations = ['inspect_repository'];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      resolvePackagedGitoxideHelperInternal({
        invocationOwnerToken: {},
        resourcesRoot: narrowed.root,
      }),
      (error: unknown) =>
        error instanceof PackagedGitoxideHelperError &&
        error.code === 'packaged_gitoxide_helper_manifest_invalid',
    );
  } finally {
    await narrowed.cleanup();
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-packaged-gitoxide-'));
  const runtimeRoot = join(root, 'gitoxide');
  await mkdir(runtimeRoot, { recursive: true });
  const executableName =
    process.platform === 'win32' ? 'maka-gitoxide-helper.exe' : 'maka-gitoxide-helper';
  const unresolvedExecutablePath = join(runtimeRoot, executableName);
  const bytes = Buffer.from('packaged-helper');
  await writeFile(unresolvedExecutablePath, bytes, { mode: 0o755 });
  const executablePath = await realpath(unresolvedExecutablePath);
  await writeFile(
    join(root, 'gitoxide-helper.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      protocol: 'maka_gitoxide_helper_release_v1',
      provider: 'maka/gitoxide-helper',
      platform: process.platform,
      arch: process.arch,
      protocolVersion: 1,
      executableRelativePath: `gitoxide/${executableName}`,
      bytes: bytes.byteLength,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
      distributionReady: true,
    })}\n`,
  );
  return {
    root,
    executablePath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
