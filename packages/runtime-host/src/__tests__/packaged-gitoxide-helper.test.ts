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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyGitoxideHelperArtifactForInvocationInternal } from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  PackagedGitoxideHelperError,
  resolvePackagedGitoxideHelperInternal,
} from '../server/packaged-gitoxide-helper-internal.js';

test('turns an exact packaged helper manifest into an owner-bound invocation capability', async () => {
  const fixture = await createFixture();
  try {
    const invocationOwnerToken = {};
    const capability = await withPackagedResourcesRoot(fixture.root, () =>
      resolvePackagedGitoxideHelperInternal({ invocationOwnerToken }),
    );
    const verified = await verifyGitoxideHelperArtifactForInvocationInternal(
      invocationOwnerToken,
      capability,
    );
    assert.equal(verified.executablePath, fixture.executablePath);
    assert.equal(verified.protocolVersion, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('fails closed when the manifest and packaged helper no longer agree', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(fixture.executablePath, 'tampered');
    await assert.rejects(
      withPackagedResourcesRoot(fixture.root, () =>
        resolvePackagedGitoxideHelperInternal({ invocationOwnerToken: {} }),
      ),
      (error: unknown) =>
        error instanceof PackagedGitoxideHelperError &&
        error.code === 'packaged_gitoxide_helper_integrity_mismatch',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('rejects an unknown or self-declared manifest shape', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      join(fixture.root, 'gitoxide-helper.json'),
      JSON.stringify({ schemaVersion: 999, executableRelativePath: 'gitoxide/helper' }),
    );
    await assert.rejects(
      withPackagedResourcesRoot(fixture.root, () =>
        resolvePackagedGitoxideHelperInternal({ invocationOwnerToken: {} }),
      ),
      (error: unknown) =>
        error instanceof PackagedGitoxideHelperError &&
        error.code === 'packaged_gitoxide_helper_manifest_invalid',
    );
  } finally {
    await fixture.cleanup();
  }
});

async function withPackagedResourcesRoot<T>(root: string, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: root,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process, 'resourcesPath', descriptor);
    else delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  }
}

async function createFixture(): Promise<{
  root: string;
  executablePath: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'maka-packaged-gitoxide-'));
  const runtimeRoot = join(root, 'gitoxide');
  await mkdir(runtimeRoot, { recursive: true });
  const executableName =
    process.platform === 'win32' ? 'maka-gitoxide-helper.exe' : 'maka-gitoxide-helper';
  const executablePath = join(runtimeRoot, executableName);
  const bytes = Buffer.from('packaged-helper');
  await writeFile(executablePath, bytes, { mode: 0o755 });
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
      distributionReady: true,
    })}\n`,
  );
  return {
    root,
    executablePath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
