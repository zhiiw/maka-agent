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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeWorkspaceVersionAuthorityStore } from '@maka/core/runtime-event-store';
import type {
  WorkspaceBaselineAuthorityInput,
  WorkspaceBaselineCommitResult,
  WorkspaceHeadRecordV1,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import {
  adoptWorkspaceBaselineAuthorityStoreRootInternal,
  commitManagedMutationTerminalInternal,
  commitWorkspaceBaselineInternal,
  commitWorkspaceSuccessorInternal,
  readActiveManagedMutationInternal,
  type ManagedMutationReservationRecordV1,
  type ManagedMutationTerminalCommitInput,
  type ManagedMutationTerminalCommitResult,
  type WorkspaceSuccessorCommitInput,
  type WorkspaceSuccessorCommitResult,
} from './workspace-version-authority-internal.js';
import type { ToolOperationRecord } from './sqlite-runtime-store.js';

interface WorkspaceMutationRecoveryStore extends RuntimeWorkspaceVersionAuthorityStore {
  readToolOperation(operationId: string): Promise<ToolOperationRecord | undefined>;
}

export interface ExecutionStoresWorkspaceMutationAuthorityInternal {
  adoptRootForManagedExecution(): void;
  readHead(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceHeadRecordV1 | undefined>;
  readVersion(workspaceVersionId: string): Promise<WorkspaceVersionRecordV1 | undefined>;
  readActiveManagedMutation(
    workspaceInstanceId: string,
  ): Promise<ManagedMutationReservationRecordV1 | undefined>;
  readToolOperation(operationId: string): Promise<ToolOperationRecord | undefined>;
  readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  commitBaseline(input: WorkspaceBaselineAuthorityInput): Promise<WorkspaceBaselineCommitResult>;
  commitSuccessor(input: WorkspaceSuccessorCommitInput): Promise<WorkspaceSuccessorCommitResult>;
  commitTerminal(
    input: ManagedMutationTerminalCommitInput,
  ): Promise<ManagedMutationTerminalCommitResult>;
}

interface RegisteredWorkspaceAuthority {
  readonly authority: WorkspaceMutationRecoveryStore;
  readonly rootId: string;
}

const workspaceAuthorities = new WeakMap<object, RegisteredWorkspaceAuthority>();

export function registerExecutionStoresWorkspaceMutationAuthorityInternal(
  stores: object,
  authority: WorkspaceMutationRecoveryStore,
  rootId: string,
): void {
  if (workspaceAuthorities.has(stores)) {
    throw new Error('Execution stores workspace mutation authority is already registered');
  }
  workspaceAuthorities.set(stores, Object.freeze({ authority, rootId }));
}

export function requireExecutionStoresWorkspaceMutationAuthorityInternal(
  stores: object,
): ExecutionStoresWorkspaceMutationAuthorityInternal {
  const registered = workspaceAuthorities.get(stores);
  if (!registered) throw new Error('Execution stores workspace mutation authority is unavailable');
  const { authority, rootId } = registered;
  return Object.freeze({
    adoptRootForManagedExecution: () =>
      adoptWorkspaceBaselineAuthorityStoreRootInternal(authority, rootId),
    readHead: (workspaceId: string, workspaceEpochId: string) =>
      authority.readWorkspaceHead(workspaceId, workspaceEpochId),
    readVersion: (workspaceVersionId: string) => authority.readWorkspaceVersion(workspaceVersionId),
    readActiveManagedMutation: (workspaceInstanceId: string) =>
      readActiveManagedMutationInternal(authority, workspaceInstanceId),
    readToolOperation: (operationId: string) => authority.readToolOperation(operationId),
    readRuntimeEvents: (sessionId: string, runId: string) =>
      authority.readRuntimeEvents(sessionId, runId),
    commitBaseline: (input: WorkspaceBaselineAuthorityInput) =>
      commitWorkspaceBaselineInternal(authority, input),
    commitSuccessor: (input: WorkspaceSuccessorCommitInput) =>
      commitWorkspaceSuccessorInternal(authority, input),
    commitTerminal: (input: ManagedMutationTerminalCommitInput) =>
      commitManagedMutationTerminalInternal(authority, input),
  });
}
