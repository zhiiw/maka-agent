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

import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import {
  publishAcceptedTreeToSourceBranchWithGitoxideHelperInternal,
  type GitoxideSourceBranchPublishedV1,
} from './gitoxide-helper-invocation-internal.js';

const PUBLISH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface GitoxideManagedSourceBranchPublishOwnerInternal {
  publish(publishId: string, abortSignal?: AbortSignal): Promise<GitoxideSourceBranchPublishedV1>;
}

/**
 * Publishes accepted content as a new source-repository branch without
 * modifying the source checkout, HEAD, index, or an existing reference.
 * The helper's target-ref compare-and-swap is the only publication point.
 */
export function createGitoxideManagedSourceBranchPublishOwnerInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly managedRepositoryPath: string;
  readonly sourceRepositoryPath: string;
  readonly sourceBaseCommitOid: string;
  readonly sourceBaseTreeOid: string;
  readonly readAcceptedIdentity: () => Promise<{
    readonly commitOid: string;
    readonly treeOid: string;
  }>;
}): GitoxideManagedSourceBranchPublishOwnerInternal {
  return Object.freeze({
    async publish(publishId: string, abortSignal?: AbortSignal) {
      if (!PUBLISH_ID_PATTERN.test(publishId)) {
        throw new Error('Gitoxide managed source-branch publication identity is invalid');
      }
      abortSignal?.throwIfAborted();
      const accepted = await input.readAcceptedIdentity();
      abortSignal?.throwIfAborted();
      return publishAcceptedTreeToSourceBranchWithGitoxideHelperInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        capability: input.helperCapability,
        managedRepositoryPath: input.managedRepositoryPath,
        sourceRepositoryPath: input.sourceRepositoryPath,
        sourceBaseCommitOid: input.sourceBaseCommitOid,
        sourceBaseTreeOid: input.sourceBaseTreeOid,
        acceptedCommitOid: accepted.commitOid,
        acceptedTreeOid: accepted.treeOid,
        publishedRef: `refs/heads/maka/${publishId}`,
        managedTreePolicyVersion: 3,
        ...(abortSignal ? { abortSignal } : {}),
      });
    },
  });
}
