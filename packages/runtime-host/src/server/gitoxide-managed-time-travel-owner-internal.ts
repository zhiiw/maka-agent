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
  createGitoxideManagedRestoreOwnerInternal,
  type GitoxideManagedRestoreResultInternal,
} from './gitoxide-managed-restore-owner-internal.js';

const VERSION_ID_PATTERN = /^version_[a-z0-9_-]{1,96}$/u;

export interface GitoxideManagedTimeTravelOwnerInternal {
  restoreVersion(
    workspaceVersionId: string,
    restoreId: string,
    abortSignal?: AbortSignal,
  ): Promise<GitoxideManagedRestoreResultInternal>;
}

export function createGitoxideManagedTimeTravelOwnerInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly storageRoot: string;
  readonly workspaceEpochId: string;
  readonly readVersionIdentity: (workspaceVersionId: string) => Promise<{
    readonly commitOid: string;
    readonly treeOid: string;
  }>;
}): GitoxideManagedTimeTravelOwnerInternal {
  return Object.freeze({
    async restoreVersion(
      workspaceVersionId: string,
      restoreId: string,
      abortSignal?: AbortSignal,
    ) {
      if (!VERSION_ID_PATTERN.test(workspaceVersionId)) {
        throw new Error('Gitoxide managed time-travel version identity is invalid');
      }
      const restore = createGitoxideManagedRestoreOwnerInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        helperCapability: input.helperCapability,
        repositoryPath: input.repositoryPath,
        storageRoot: input.storageRoot,
        workspaceEpochId: input.workspaceEpochId,
        readAcceptedIdentity: () => input.readVersionIdentity(workspaceVersionId),
      });
      return restore.restore(`history-${restoreId}`, abortSignal);
    },
  });
}
