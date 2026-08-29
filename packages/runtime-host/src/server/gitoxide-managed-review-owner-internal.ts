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
  compareAcceptedTreesWithGitoxideHelperInternal,
  type GitoxideAcceptedTreesComparedV1,
} from './gitoxide-helper-invocation-internal.js';

export interface GitoxideManagedReviewBoundaryInternal {
  readonly baselineCommitOid: string;
  readonly baselineTreeOid: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
}

export interface GitoxideManagedReviewOwnerInternal {
  diff(abortSignal?: AbortSignal): Promise<GitoxideAcceptedTreesComparedV1>;
}

export function createGitoxideManagedReviewOwnerInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly readReviewBoundary: () => Promise<GitoxideManagedReviewBoundaryInternal>;
}): GitoxideManagedReviewOwnerInternal {
  const owner: GitoxideManagedReviewOwnerInternal = {
    async diff(abortSignal?: AbortSignal): Promise<GitoxideAcceptedTreesComparedV1> {
      abortSignal?.throwIfAborted();
      const boundary = await input.readReviewBoundary();
      abortSignal?.throwIfAborted();
      const compared = await compareAcceptedTreesWithGitoxideHelperInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        capability: input.helperCapability,
        repositoryPath: input.repositoryPath,
        baselineCommitOid: boundary.baselineCommitOid,
        acceptedCommitOid: boundary.acceptedCommitOid,
        managedTreePolicyVersion: 3,
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (
        compared.baselineCommitOid !== boundary.baselineCommitOid ||
        compared.baselineTreeOid !== boundary.baselineTreeOid ||
        compared.acceptedCommitOid !== boundary.acceptedCommitOid ||
        compared.acceptedTreeOid !== boundary.acceptedTreeOid
      ) {
        throw new Error('Gitoxide managed review conflicts with its durable workspace boundary');
      }
      return compared;
    },
  };
  return Object.freeze(owner);
}
