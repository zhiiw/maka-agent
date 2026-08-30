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
  WorkspaceActiveEpochRecordV1,
  WorkspaceEpochActivationAuthorityInput,
} from '@maka/core/workspace-version-authority';

export interface WorkspaceActiveEpochCommitResult {
  readonly created: boolean;
  readonly activeEpoch: WorkspaceActiveEpochRecordV1;
}

type WorkspaceActiveEpochWriter = (
  input: WorkspaceEpochActivationAuthorityInput,
  rootId: string,
) => Promise<WorkspaceActiveEpochCommitResult>;

type WorkspaceActiveEpochReader = (
  workspaceId: string,
) => Promise<WorkspaceActiveEpochRecordV1 | undefined>;

interface Registration {
  readonly writer: WorkspaceActiveEpochWriter;
  readonly reader: WorkspaceActiveEpochReader;
}

const registrations = new WeakMap<object, Registration>();

export function registerWorkspaceActiveEpochAuthorityInternal(
  store: object,
  writer: WorkspaceActiveEpochWriter,
  reader: WorkspaceActiveEpochReader,
): void {
  if (registrations.has(store)) throw new Error('Workspace active-epoch authority already exists');
  registrations.set(store, { writer, reader });
}

export function commitWorkspaceActiveEpochInternal(
  store: object,
  input: WorkspaceEpochActivationAuthorityInput,
  rootId: string,
): Promise<WorkspaceActiveEpochCommitResult> {
  const registration = registrations.get(store);
  if (!registration) throw new Error('Workspace active-epoch authority is unavailable');
  return registration.writer(input, rootId);
}

export function readWorkspaceActiveEpochInternal(
  store: object,
  workspaceId: string,
): Promise<WorkspaceActiveEpochRecordV1 | undefined> {
  const registration = registrations.get(store);
  if (!registration) throw new Error('Workspace active-epoch authority is unavailable');
  return registration.reader(workspaceId);
}
