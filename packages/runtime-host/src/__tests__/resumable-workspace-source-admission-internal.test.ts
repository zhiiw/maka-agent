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
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  admitResumableWorkspaceSourceInternal,
  requireResumableWorkspaceSourceAdmissionInternal,
} from '../server/resumable-workspace-source-admission-internal.js';

test('classifies a plain directory as a filesystem snapshot source', async (t) => {
  const sourceRoot = await temporaryDirectory(t, 'maka-source-snapshot-');
  await writeFile(join(sourceRoot, 'notes.txt'), 'plain source\n', 'utf8');
  const ownerToken = {};

  const capability = await admitResumableWorkspaceSourceInternal({
    ownerToken,
    sourceRoot,
  });

  assert.deepEqual(requireResumableWorkspaceSourceAdmissionInternal(ownerToken, capability), {
    protocolVersion: 1,
    kind: 'filesystem_snapshot_v1',
    sourceRoot,
  });
});

test('classifies any root .git marker as Git without snapshot fallback', async (t) => {
  const directoryMarkerRoot = await temporaryDirectory(t, 'maka-source-git-directory-');
  await mkdir(join(directoryMarkerRoot, '.git'));
  const directoryOwner = {};
  const directoryCapability = await admitResumableWorkspaceSourceInternal({
    ownerToken: directoryOwner,
    sourceRoot: directoryMarkerRoot,
  });
  assert.equal(
    requireResumableWorkspaceSourceAdmissionInternal(directoryOwner, directoryCapability).kind,
    'git_repository_v1',
  );

  const fileMarkerRoot = await temporaryDirectory(t, 'maka-source-git-file-');
  await writeFile(join(fileMarkerRoot, '.git'), 'malformed but still Git-owned\n', 'utf8');
  const fileOwner = {};
  const fileCapability = await admitResumableWorkspaceSourceInternal({
    ownerToken: fileOwner,
    sourceRoot: fileMarkerRoot,
  });
  assert.equal(
    requireResumableWorkspaceSourceAdmissionInternal(fileOwner, fileCapability).kind,
    'git_repository_v1',
  );
});

test('does not allow another owner to inspect the admitted source', async (t) => {
  const sourceRoot = await temporaryDirectory(t, 'maka-source-owner-');
  const capability = await admitResumableWorkspaceSourceInternal({
    ownerToken: {},
    sourceRoot,
  });

  assert.throws(
    () => requireResumableWorkspaceSourceAdmissionInternal({}, capability),
    /source admission capability is invalid/i,
  );
});

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
