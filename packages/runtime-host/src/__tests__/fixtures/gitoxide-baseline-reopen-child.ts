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
import { readFile, realpath } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { createGitoxideWorkspaceBaselineOwnerInternal } from '../../server/gitoxide-workspace-baseline-owner-internal.js';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
  GITOXIDE_HELPER_OPERATIONS_INTERNAL,
} from '../../server/gitoxide-helper-artifact-authority-internal.js';
import {
  admitGitoxideRepositoryInternal,
  importAdmittedGitoxideRepositoryInternal,
  readGitoxideTreeFileInternal,
  createGitoxideCandidateInternal,
  requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal,
} from '../../server/gitoxide-repository-admission-authority-internal.js';

const [mode, rootPath, sourcePath] = process.argv.slice(2);
if (!rootPath || !sourcePath || !process.env.MAKA_GITOXIDE_HELPER_PATH)
  throw new Error('Missing child input');
const executablePath = await realpath(process.env.MAKA_GITOXIDE_HELPER_PATH);
const bytes = await readFile(executablePath);
const releaseOwnerToken = {};
const invocationOwnerToken = {};
const helperCapability = await admitGitoxideHelperArtifactInternal({
  releaseOwnerToken,
  invocationOwnerToken,
  claim: issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath,
    expectedBytes: bytes.length,
    expectedSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
    supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
  }),
});
const root = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
const leaseOwner = await tryAcquireInteractiveRootOwner(root);
if (!leaseOwner) throw new Error('Root still owned by another process');
const stores = await openInteractiveExecutionStoresForWrite(leaseOwner.lease);
const owner = createGitoxideWorkspaceBaselineOwnerInternal(stores);
const acceptedRepositoryOwnerToken = {};
const repositoryPath = join(rootPath, 'repository.git');
if (mode === 'crash-after-baseline') {
  const admissionOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    invocationOwnerToken,
    helperCapability,
    admissionOwnerToken,
    repositoryPath: sourcePath,
  });
  if (admitted.kind !== 'accepted') throw new Error(admitted.reason);
  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath: repositoryPath,
  });
  await owner.acceptImport({
    workspaceKey: 'crash-session',
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
  });
  // Deliberately bypass store/lease cleanup. Next process must reacquire and revalidate.
  process.exit(77);
}
if (!['reopen', 'crash-after-candidate', 'retry-candidate', 'conflicting-candidate'].includes(mode))
  throw new Error('Unknown child mode');
try {
  const capability = await owner.reopen({
    workspaceKey: 'crash-session',
    repositoryPath,
    invocationOwnerToken,
    helperCapability,
    acceptedRepositoryOwnerToken,
  });
  const file = await readGitoxideTreeFileInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: capability,
    path: 'hello.txt',
  });
  if (mode !== 'reopen') {
    const candidateOwnerToken = {};
    const candidate = await createGitoxideCandidateInternal({
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: capability,
      candidateOwnerToken,
      operationId: 'crash-candidate-operation',
      path: 'hello.txt',
      content: mode === 'conflicting-candidate' ? 'conflicting result\n' : 'candidate result\n',
    });
    const proof = requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: capability,
      candidateOwnerToken,
      candidateOutcomeCapability: candidate.candidateOutcomeCapability,
    });
    writeSync(1, JSON.stringify({ proof, acceptedContent: file.content }));
    if (mode === 'crash-after-candidate') process.exit(78);
  } else {
    writeSync(
      1,
      JSON.stringify({
        content: file.content,
        commit: file.acceptedCommitOid,
        tree: file.acceptedTreeOid,
      }),
    );
  }
} finally {
  await stores.sessionStore.close?.();
  await leaseOwner.close();
}
