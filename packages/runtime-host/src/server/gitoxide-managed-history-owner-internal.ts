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

import type {
  WorkspaceHeadRecordV1,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';

const MAX_HISTORY_ENTRIES = 100;

export interface GitoxideManagedHistoryEntryInternal {
  readonly workspaceVersionId: string;
  readonly parentWorkspaceVersionId: string | null;
  readonly commitOid: string;
  readonly treeOid: string;
  readonly acceptedEventId: string;
  readonly committedAt: number;
  readonly kind: 'baseline' | 'tool_mutation' | 'history_restore';
  readonly changedFileCount: number;
}

export interface GitoxideManagedHistoryResultInternal {
  readonly headWorkspaceVersionId: string;
  readonly versions: readonly GitoxideManagedHistoryEntryInternal[];
  readonly hasMore: boolean;
}

export interface GitoxideManagedHistoryOwnerInternal {
  list(limit?: number): Promise<GitoxideManagedHistoryResultInternal>;
}

export function createGitoxideManagedHistoryOwnerInternal(input: {
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly readHead: () => Promise<WorkspaceHeadRecordV1 | undefined>;
  readonly readVersion: (
    workspaceVersionId: string,
  ) => Promise<WorkspaceVersionRecordV1 | undefined>;
}): GitoxideManagedHistoryOwnerInternal {
  return Object.freeze({
    async list(limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_ENTRIES) {
        throw new Error('Gitoxide managed history limit is invalid');
      }
      const head = await input.readHead();
      if (!head || !sameWorkspace(input, head)) {
        throw new Error('Gitoxide managed history head is unavailable');
      }
      const versions: GitoxideManagedHistoryEntryInternal[] = [];
      const seen = new Set<string>();
      let nextVersionId: string | null = head.workspaceVersionId;
      while (nextVersionId !== null && versions.length < limit) {
        if (seen.has(nextVersionId)) {
          throw new Error('Gitoxide managed history lineage is cyclic');
        }
        seen.add(nextVersionId);
        const version = await input.readVersion(nextVersionId);
        if (
          !version ||
          version.workspaceVersionId !== nextVersionId ||
          !sameWorkspace(input, version)
        ) {
          throw new Error('Gitoxide managed history identity is unavailable');
        }
        if (
          versions.length === 0 &&
          (version.acceptedEventId !== head.acceptedEventId ||
            version.commitOid !== head.commitOid ||
            version.treeOid !== head.treeOid)
        ) {
          throw new Error('Gitoxide managed history head conflicts with its accepted version');
        }
        const parentWorkspaceVersionId =
          version.protocol === 'workspace_version_accepted_v1' ? version.parents[0] : null;
        versions.push(
          Object.freeze({
            workspaceVersionId: version.workspaceVersionId,
            parentWorkspaceVersionId,
            commitOid: version.commitOid,
            treeOid: version.treeOid,
            acceptedEventId: version.acceptedEventId,
            committedAt: version.committedAt,
            kind: version.origin.kind,
            changedFileCount: version.changedFileCount,
          }),
        );
        nextVersionId = parentWorkspaceVersionId;
      }
      return Object.freeze({
        headWorkspaceVersionId: head.workspaceVersionId,
        versions: Object.freeze(versions),
        hasMore: nextVersionId !== null,
      });
    },
  });
}

function sameWorkspace(
  expected: { repositoryId: string; workspaceId: string; workspaceEpochId: string },
  actual: { repositoryId: string; workspaceId: string; workspaceEpochId: string },
): boolean {
  return (
    actual.repositoryId === expected.repositoryId &&
    actual.workspaceId === expected.workspaceId &&
    actual.workspaceEpochId === expected.workspaceEpochId
  );
}
