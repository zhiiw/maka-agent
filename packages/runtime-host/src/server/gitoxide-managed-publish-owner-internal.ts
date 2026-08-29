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
  publishAcceptedRefWithGitoxideHelperInternal,
  type GitoxideAcceptedRefPublishedV1,
} from './gitoxide-helper-invocation-internal.js';

const PUBLISH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface GitoxideManagedPublishOwnerInternal {
  publish(publishId: string, abortSignal?: AbortSignal): Promise<GitoxideAcceptedRefPublishedV1>;
}

export function createGitoxideManagedPublishOwnerInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly readAcceptedIdentity: () => Promise<{
    readonly commitOid: string;
    readonly treeOid: string;
  }>;
}): GitoxideManagedPublishOwnerInternal {
  return Object.freeze({
    async publish(publishId: string, abortSignal?: AbortSignal) {
      if (!PUBLISH_ID_PATTERN.test(publishId)) {
        throw new Error('Gitoxide managed publication identity is invalid');
      }
      abortSignal?.throwIfAborted();
      const accepted = await input.readAcceptedIdentity();
      abortSignal?.throwIfAborted();
      return publishAcceptedRefWithGitoxideHelperInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        capability: input.helperCapability,
        repositoryPath: input.repositoryPath,
        acceptedCommitOid: accepted.commitOid,
        acceptedTreeOid: accepted.treeOid,
        publishedRef: `refs/maka/published/${publishId}`,
        managedTreePolicyVersion: 3,
        ...(abortSignal ? { abortSignal } : {}),
      });
    },
  });
}
