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
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { requireExecutionStoresWorkspaceMutationAuthorityInternal } from '@maka/storage/execution-stores-workspace-authority-internal';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import { openGitoxideManagedMutationSession } from '../server/gitoxide-managed-mutation-session.js';

test('opens one durable Gitoxide baseline and exactly reuses it for the session', async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper session test');
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-session-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  git(root, ['init', '--quiet', '--object-format=sha1', sourceRoot]);
  await writeFile(join(sourceRoot, 'notes.txt'), 'baseline\n');
  git(sourceRoot, ['add', 'notes.txt']);
  git(sourceRoot, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'baseline',
  ]);
  const storageCapability = await resolveStorageRoot({
    path: join(root, 'storage'),
    kind: 'interactive',
  });
  const storageOwner = await tryAcquireInteractiveRootOwner(storageCapability);
  assert.ok(storageOwner);
  if (!storageOwner) return;
  const stores = await openInteractiveExecutionStoresForWrite(storageOwner.lease);
  try {
    const helperBytes = await readFile(await realpath(helperPath));
    const helperInfo = await stat(await realpath(helperPath));
    const releaseOwnerToken = {};
    const invocationOwnerToken = {};
    const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
      executablePath: await realpath(helperPath),
      expectedSha256: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`,
      expectedBytes: helperInfo.size,
      platform: process.platform,
      arch: process.arch,
      protocolVersion: 1,
    });
    const helperCapability = await admitGitoxideHelperArtifactInternal({
      releaseOwnerToken,
      invocationOwnerToken,
      claim,
    });
    const input = {
      storageRoot: storageCapability.canonicalPath,
      sourceRoot,
      sessionId: 'session-gitoxide-managed-1',
      invocationOwnerToken,
      helperCapability,
      settlementAuthority: requireExecutionStoresWorkspaceMutationAuthorityInternal(stores),
    };

    const first = await openGitoxideManagedMutationSession(input);
    const reopened = await openGitoxideManagedMutationSession(input);

    assert.deepEqual(reopened.head, first.head);
    assert.equal(first.head.revision, 1);
    assert.notEqual(first.head.commitOid, git(sourceRoot, ['rev-parse', 'HEAD']));
    assert.equal(first.head.treeOid, git(sourceRoot, ['rev-parse', 'HEAD^{tree}']));
  } finally {
    await stores.sessionStore.close?.();
    await storageOwner.close();
  }
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
