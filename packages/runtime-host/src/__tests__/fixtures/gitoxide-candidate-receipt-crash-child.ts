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
  discoverMarkedStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST } from '@maka/core/runtime-event';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../../server/gitoxide-helper-artifact-authority-internal.js';
import {
  admitGitoxideRepositoryInternal,
  importAdmittedGitoxideRepositoryInternal,
} from '../../server/gitoxide-repository-admission-authority-internal.js';
import { createGitoxideMutationCandidateAuthorityInternal } from '../../server/gitoxide-mutation-candidate-receipt-authority-internal.js';

interface Fixture {
  readonly storageRoot: string;
  readonly sourceRepositoryPath: string;
  readonly destinationRepositoryPath: string;
  readonly helperPath: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceVersionId: string;
  readonly acceptedEventId: string;
  readonly sourceHeadCommitOid: string;
  readonly sourceTreeOid: string;
  readonly operationId: string;
  readonly path: string;
  readonly content: string;
}

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('Missing candidate receipt crash fixture path');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture;
const rootCapability = await discoverMarkedStorageRoot({ path: fixture.storageRoot });
if (rootCapability.kind !== 'interactive') throw new Error('Crash fixture root kind is invalid');
const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
if (!rootOwner) throw new Error('Crash fixture could not acquire the storage root');
const helperPath = await realpath(fixture.helperPath);
const helperBytes = await readFile(helperPath);
const helperInfo = await stat(helperPath);
const releaseOwnerToken = {};
const invocationOwnerToken = {};
const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
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
  ],
});
const helperCapability = await admitGitoxideHelperArtifactInternal({
  releaseOwnerToken,
  invocationOwnerToken,
  claim,
});
const admissionOwnerToken = {};
const admitted = await admitGitoxideRepositoryInternal({
  invocationOwnerToken,
  helperCapability,
  admissionOwnerToken,
  repositoryPath: fixture.sourceRepositoryPath,
});
if (admitted.kind !== 'accepted') throw new Error('Crash fixture source was rejected');
const acceptedRepositoryOwnerToken = {};
const imported = await importAdmittedGitoxideRepositoryInternal({
  admissionOwnerToken,
  repositoryCapability: admitted.capability,
  acceptedRepositoryOwnerToken,
  destinationRepositoryPath: fixture.destinationRepositoryPath,
});
if (
  imported.sourceHeadCommitOid !== fixture.sourceHeadCommitOid ||
  imported.sourceTreeOid !== fixture.sourceTreeOid ||
  imported.baselineTreeOid !== fixture.sourceTreeOid
) {
  throw new Error('Crash fixture imported different source provenance');
}
const authority = await createGitoxideMutationCandidateAuthorityInternal({
  storageRootLease: rootOwner.lease,
  baseHead: {
    repositoryId: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    workspaceEpochId: fixture.workspaceEpochId,
    workspaceVersionId: fixture.workspaceVersionId,
    acceptedEventId: fixture.acceptedEventId,
    commitOid: imported.baselineCommitOid,
    treeOid: imported.baselineTreeOid,
    revision: 1,
  },
  acceptedRepositoryOwnerToken,
  acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
  projectionOwnerToken: {},
  failpoint: (point) => {
    if (point === 'after_candidate_ref') process.exit(71);
  },
});
await authority.capture({
  operationId: fixture.operationId,
  path: fixture.path,
  content: fixture.content,
  executionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
});
throw new Error('Crash fixture did not stop after candidate publication');
