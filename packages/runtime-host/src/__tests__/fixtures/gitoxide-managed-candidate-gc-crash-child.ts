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
import {
  admitGitoxideHelperArtifactInternal,
  GITOXIDE_HELPER_OPERATIONS_INTERNAL,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../../server/gitoxide-helper-artifact-authority-internal.js';
import { createGitoxideManagedGcOwnerInternal } from '../../server/gitoxide-managed-gc-owner-internal.js';

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('Missing managed candidate GC crash fixture path');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
  readonly storageRoot: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly repositoryPath: string;
  readonly acceptedCommitOid: string;
  readonly helperPath: string;
};
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
const owner = createGitoxideManagedGcOwnerInternal({
  storageRoot: fixture.storageRoot,
  workspaceId: fixture.workspaceId,
  workspaceEpochId: fixture.workspaceEpochId,
  repositoryPath: fixture.repositoryPath,
  invocationOwnerToken,
  helperCapability,
  readCandidateRetentionRoots: async () => ({
    acceptedCommitOid: fixture.acceptedCommitOid,
    protectedOperationIdentitySha256: [],
  }),
  failpoint(point) {
    if (point === 'after_candidate_ref_retired') process.exit(80);
  },
});
await owner.collectMutationCandidates({ olderThanMs: 0, maxEntries: 1 });
throw new Error('Managed candidate GC crash failpoint did not stop the child process');
