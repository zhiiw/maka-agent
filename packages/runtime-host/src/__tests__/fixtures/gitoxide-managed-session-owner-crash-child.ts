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

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  discoverMarkedStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  GITOXIDE_HELPER_OPERATIONS_INTERNAL,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../../server/gitoxide-helper-artifact-authority-internal.js';
import { openGitoxideManagedSessionOwnerInternal } from '../../server/gitoxide-managed-session-owner-internal.js';

interface Fixture {
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly sessionId: string;
  readonly helperPath: string;
  readonly mode?:
    | 'after_repository_import'
    | 'after_active_epoch_commit'
    | 'after_publish_response_lost'
    | 'after_source_branch_publish_response_lost'
    | 'after_restore_response_lost';
  readonly rebaselineId?: string;
  readonly rebaselineContent?: string;
  readonly lifecycleId?: string;
}

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('Missing managed session crash fixture path');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture;
const rootCapability = await discoverMarkedStorageRoot({ path: fixture.storageRoot });
if (rootCapability.kind !== 'interactive') throw new Error('Crash fixture root kind is invalid');
const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
if (!rootOwner) throw new Error('Crash fixture could not acquire the storage root');
const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
const helperPath = await realpath(fixture.helperPath);
const helperBytes = await readFile(helperPath);
const helperInfo = await stat(helperPath);
const releaseOwnerToken = {};
const invocationOwnerToken = {};
const helperCapability = await admitGitoxideHelperArtifactInternal({
  releaseOwnerToken,
  invocationOwnerToken,
  claim: issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath: helperPath,
    expectedSha256: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`,
    expectedBytes: helperInfo.size,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
    supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
  }),
});
const mode = fixture.mode ?? 'after_repository_import';
const session = await openGitoxideManagedSessionOwnerInternal({
  storageRootLease: rootOwner.lease,
  stores,
  invocationOwnerToken,
  helperCapability,
  sourceRoot: fixture.sourceRoot,
  sessionId: fixture.sessionId,
  failpoint(point) {
    if (point === 'after_repository_import' && mode === 'after_repository_import') process.exit(74);
    if (point === 'after_active_epoch_commit' && mode === 'after_active_epoch_commit')
      process.exit(75);
  },
});
if (mode === 'after_active_epoch_commit') {
  if (!fixture.rebaselineId || fixture.rebaselineContent === undefined) {
    throw new Error('Crash fixture rebaseline input is unavailable');
  }
  await writeFile(join(fixture.sourceRoot, 'notes.txt'), fixture.rebaselineContent, 'utf8');
  execFileSync('git', ['-C', fixture.sourceRoot, 'add', 'notes.txt']);
  execFileSync('git', [
    '-C',
    fixture.sourceRoot,
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'epoch two',
  ]);
  await session.rebaseline(fixture.rebaselineId);
}
if (mode === 'after_publish_response_lost') {
  if (!fixture.lifecycleId) throw new Error('Crash fixture publication identity is unavailable');
  await session.publish.publish(fixture.lifecycleId);
  process.exit(77);
}
if (mode === 'after_source_branch_publish_response_lost') {
  if (!fixture.lifecycleId) throw new Error('Crash fixture publication identity is unavailable');
  if (!session.sourceBranchPublish) {
    throw new Error('Crash fixture source-branch publication is unavailable');
  }
  await session.sourceBranchPublish.publish(fixture.lifecycleId);
  process.exit(78);
}
if (mode === 'after_restore_response_lost') {
  if (!fixture.lifecycleId) throw new Error('Crash fixture restore identity is unavailable');
  await session.restore.restore(fixture.lifecycleId);
  process.exit(79);
}
throw new Error(`Crash fixture did not stop at ${mode}`);
