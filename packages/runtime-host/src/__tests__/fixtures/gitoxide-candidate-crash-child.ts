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
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import type { WorkspaceHeadRecordV1 } from '@maka/core/workspace-version-authority';
import {
  discoverMarkedStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../../server/gitoxide-helper-artifact-authority-internal.js';
import {
  type GitoxideMutationCandidateCaptureInput,
  createGitoxideMutationCandidateAuthorityInternal,
} from '../../server/gitoxide-helper-mutation-candidate-authority-internal.js';

interface CrashInput {
  readonly helperPath: string;
  readonly storageRoot: string;
  readonly baseHead: WorkspaceHeadRecordV1;
  readonly capture: GitoxideMutationCandidateCaptureInput;
  readonly readyPath: string;
}

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Gitoxide candidate crash input path is required');
const input = JSON.parse(await readFile(inputPath, 'utf8')) as CrashInput;
const helperPath = await realpath(input.helperPath);
const [helperBytes, helperInfo] = await Promise.all([readFile(helperPath), stat(helperPath)]);
const releaseOwnerToken = {};
const invocationOwnerToken = {};
const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
  executablePath: helperPath,
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
const rootCapability = await discoverMarkedStorageRoot({ path: input.storageRoot });
const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
if (!rootOwner) throw new Error('Gitoxide candidate fixture could not acquire the storage root');
const authority = await createGitoxideMutationCandidateAuthorityInternal({
  invocationOwnerToken,
  helperCapability,
  storageRootLease: rootOwner.lease,
  baseHead: input.baseHead,
  async failpoint(point) {
    if (point !== 'after_candidate_ref') return;
    await writeFile(input.readyPath, 'ready\n', 'utf8');
    await new Promise<never>(() => undefined);
  },
});
await authority.capture(input.capture);
throw new Error('Gitoxide candidate crash fixture unexpectedly completed');
