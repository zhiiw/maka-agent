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
import { readFile, realpath, stat } from 'node:fs/promises';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  discoverMarkedStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../../server/gitoxide-helper-artifact-authority-internal.js';
import { openGitoxideManagedSessionOwnerInternal } from '../../server/gitoxide-managed-session-owner-internal.js';

interface Fixture {
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly sessionId: string;
  readonly helperPath: string;
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
    supportedOperations: [
      'inspect_repository',
      'import_source_head',
      'create_candidate',
      'promote_candidate',
      'observe_accepted_ref',
      'read_tree_file',
      'list_tree_files',
      'grep_tree_files',
      'compare_accepted_trees',
      'materialize_accepted_tree',
      'publish_accepted_ref',
    ],
  }),
});
await openGitoxideManagedSessionOwnerInternal({
  storageRootLease: rootOwner.lease,
  stores,
  invocationOwnerToken,
  helperCapability,
  sourceRoot: fixture.sourceRoot,
  sessionId: fixture.sessionId,
  failpoint(point) {
    if (point === 'after_repository_import') process.exit(74);
  },
});
throw new Error('Crash fixture did not stop after repository import');
