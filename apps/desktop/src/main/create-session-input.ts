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

/**
 * What a `sessions:create` request resolves to.
 *
 * #1433: these fields used to be derived in two places. `sessions:create`
 * took them from the renderer, and a second IPC (`quickChat:start`, built for
 * the first-run Quick Chat panel) derived them from a product `mode`. The
 * panel is gone, and what remained of the second IPC was a duplicate of the
 * first — same readiness gate, same connection resolution, same
 * `emitSessionsChanged('created')` — so only the derivation survived.
 *
 * It lives here as a pure function rather than inside the handler because the
 * handler is an `ipcMain.handle` closure no test can call. The invariants
 * below — the refusal of a directly-requested `explore`, and leaving an
 * omitted mode omitted — would otherwise only be assertable by regex over the
 * handler's source.
 *
 * The permission mode a session actually starts in is resolved by the Runtime
 * Host from its own `chatDefaults`, so an omitted mode stays omitted here.
 */

import type { CollaborationMode } from '@maka/core/collaboration';

import type { OrchestrationMode } from '@maka/core/orchestration';

import type { PermissionMode } from '@maka/core/permission';
import type { SessionToolProfile } from '@maka/core/session';

import type { SessionStartMode } from '@maka/core/deep-research';
import { DEFAULT_SESSION_NAME } from '@maka/core/session-name';

import { isChatDefaultPermissionMode } from '@maka/core/settings';

import { isCollaborationMode } from '@maka/core/collaboration';

import { isOrchestrationMode } from '@maka/core/orchestration';

import { isSessionStartMode } from '@maka/core/deep-research';
import type { WorkspaceTarget } from '@maka/runtime-host/protocol';

/**
 * `unknown`, because this is an IPC boundary and the renderer's type is a
 * promise, not a guarantee. An unrecognized value confers nothing — it is not
 * a mode — and the caller falls through to an ordinary session, which is the
 * same session it would have got by not naming one.
 */
export interface CreateSessionRequest {
  mode?: SessionStartMode;
  productIntent?: 'managed_coding';
  permissionMode?: PermissionMode;
  collaborationMode?: CollaborationMode;
  orchestrationMode?: OrchestrationMode;
  name?: string;
  labels?: string[];
}

export interface ResolvedCreateSessionRequest {
  mode?: SessionStartMode;
  permissionMode?: PermissionMode;
  collaborationMode: CollaborationMode;
  orchestrationMode: OrchestrationMode;
  name: string;
  labels: string[] | undefined;
}

export function resolveCreateSessionRequest(
  input: CreateSessionRequest | undefined,
): ResolvedCreateSessionRequest {
  const productIntent = input?.productIntent;
  if (productIntent !== undefined && productIntent !== 'managed_coding') {
    throw new TypeError('Invalid session product intent.');
  }
  if (productIntent === 'managed_coding' && input?.mode !== undefined) {
    throw new TypeError('Managed coding cannot be combined with another session product mode.');
  }
  const collaborationMode = input?.collaborationMode ?? 'agent';
  if (!isCollaborationMode(collaborationMode)) {
    throw new TypeError('Invalid collaboration mode.');
  }
  const orchestrationMode = input?.orchestrationMode ?? 'default';
  if (!isOrchestrationMode(orchestrationMode)) {
    throw new TypeError('Invalid orchestration mode.');
  }
  // `explore` is a boundary a product mode confers, not one a caller may
  // request directly. Existing Sessions use a separate deliberate mutation.
  if (input?.permissionMode !== undefined && !isChatDefaultPermissionMode(input.permissionMode)) {
    throw new TypeError('Invalid permission mode.');
  }

  return {
    ...(isSessionStartMode(input?.mode) ? { mode: input.mode } : {}),
    ...(input?.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    collaborationMode,
    orchestrationMode,
    name: input?.name ?? DEFAULT_SESSION_NAME,
    labels: input?.labels,
  };
}

/**
 * Desktop coding tasks always have an owner-resolved workspace target.  That
 * is the product boundary for resumability: the Host subsequently classifies
 * the target as a Git repository or a bounded filesystem snapshot.  The
 * renderer cannot opt this profile out, and it cannot mint the internal
 * profile directly.
 *
 * Distinct product modes keep their own execution contract.  In particular,
 * Deep Research is not silently converted into a managed coding task merely
 * because it also has a cwd.
 */
export function resolveAutomaticWorkspaceToolProfile(
  request: ResolvedCreateSessionRequest,
  workspace: WorkspaceTarget,
  availableProfiles: readonly SessionToolProfile[] = ['managed-coding-v1'],
): SessionToolProfile | undefined {
  if (request.mode !== undefined) return undefined;

  switch (workspace.kind) {
    case 'project':
    case 'host_path': {
      if (availableProfiles.includes('managed-coding-v2')) return 'managed-coding-v2';
      if (availableProfiles.includes('managed-coding-v1')) return 'managed-coding-v1';
      throw new Error('Managed coding is unavailable in the active Runtime Host.');
    }
  }
}
