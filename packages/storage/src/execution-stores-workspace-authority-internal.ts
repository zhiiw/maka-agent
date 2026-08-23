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

import type { RuntimeWorkspaceVersionAuthorityStore } from '@maka/core/runtime-event-store';
import type {
  WorkspaceHeadRecordV1,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import {
  commitWorkspaceSuccessorInternal,
  type WorkspaceSuccessorCommitInput,
  type WorkspaceSuccessorCommitResult,
} from './workspace-version-authority-internal.js';

export interface ExecutionStoresWorkspaceMutationAuthorityInternal {
  readHead(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceHeadRecordV1 | undefined>;
  readVersion(workspaceVersionId: string): Promise<WorkspaceVersionRecordV1 | undefined>;
  commitSuccessor(input: WorkspaceSuccessorCommitInput): Promise<WorkspaceSuccessorCommitResult>;
}

const workspaceAuthorities = new WeakMap<object, RuntimeWorkspaceVersionAuthorityStore>();

export function registerExecutionStoresWorkspaceMutationAuthorityInternal(
  stores: object,
  authority: RuntimeWorkspaceVersionAuthorityStore,
): void {
  if (workspaceAuthorities.has(stores)) {
    throw new Error('Execution stores workspace mutation authority is already registered');
  }
  workspaceAuthorities.set(stores, authority);
}

export function requireExecutionStoresWorkspaceMutationAuthorityInternal(
  stores: object,
): ExecutionStoresWorkspaceMutationAuthorityInternal {
  const authority = workspaceAuthorities.get(stores);
  if (!authority) throw new Error('Execution stores workspace mutation authority is unavailable');
  return Object.freeze({
    readHead: (workspaceId: string, workspaceEpochId: string) =>
      authority.readWorkspaceHead(workspaceId, workspaceEpochId),
    readVersion: (workspaceVersionId: string) => authority.readWorkspaceVersion(workspaceVersionId),
    commitSuccessor: (input: WorkspaceSuccessorCommitInput) =>
      commitWorkspaceSuccessorInternal(authority, input),
  });
}
