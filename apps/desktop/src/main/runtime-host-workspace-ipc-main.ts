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

import { stat } from 'node:fs/promises';
import type { GitReviewSource } from '@maka/core/git-review';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { readGitReview } from './git-review-main.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

type WorkspaceClient = Pick<
  DesktopRuntimeHostClient,
  | 'getSession'
  | 'readManagedWorkspaceReview'
  | 'publishManagedWorkspaceSnapshot'
  | 'restoreManagedWorkspaceSnapshot'
  | 'readManagedWorkspaceHistory'
  | 'restoreManagedWorkspaceVersion'
  | 'undoManagedWorkspaceVersion'
>;

export function registerRuntimeHostWorkspaceIpc(
  input: {
    readonly ipcMain: ReconnectableReadIpcMain;
    readonly client: WorkspaceClient;
    readonly allowLocalWorkspace?: boolean;
  },
): void {
  handleReconnectableRead(input.ipcMain, 'git-review:read', async (_event, raw: unknown) => {
    const request = readRequest(raw);
    const session = await input.client.getSession(request.sessionId);
    if (!session) throw new Error(`No such Session: ${request.sessionId}`);
    if (session.toolProfile === 'managed-coding-v1') {
      if (request.source !== 'branch' || request.baseBranch !== undefined) {
        throw new Error('Managed workspace Review only supports its accepted history');
      }
      return input.client.readManagedWorkspaceReview(request.sessionId);
    }
    if (input.allowLocalWorkspace === false) {
      return { ok: false as const, reason: 'workspace_unavailable' as const };
    }
    const cwd = await sessionWorkspace(session.workspace.hostCwd);
    if (!cwd) return { ok: false as const, reason: 'workspace_unavailable' as const };
    return readGitReview(cwd, request.source, undefined, request.baseBranch);
  });

  input.ipcMain.handle('managed-workspace:publish', async (_event, raw: unknown) => {
    const request = publishRequest(raw);
    const session = await input.client.getSession(request.sessionId);
    if (!session) throw new Error(`No such Session: ${request.sessionId}`);
    if (session.toolProfile !== 'managed-coding-v1') {
      throw new Error('Session does not own a managed workspace');
    }
    return input.client.publishManagedWorkspaceSnapshot(request.sessionId, request.publishId);
  });

  input.ipcMain.handle('managed-workspace:restore', async (_event, raw: unknown) => {
    const request = restoreRequest(raw);
    const session = await input.client.getSession(request.sessionId);
    if (!session) throw new Error(`No such Session: ${request.sessionId}`);
    if (session.toolProfile !== 'managed-coding-v1') {
      throw new Error('Session does not own a managed workspace');
    }
    return input.client.restoreManagedWorkspaceSnapshot(request.sessionId, request.restoreId);
  });

  input.ipcMain.handle('managed-workspace:history', async (_event, raw: unknown) => {
    const request = historyRequest(raw);
    await requireManagedSession(input.client, request.sessionId);
    return input.client.readManagedWorkspaceHistory(request.sessionId, request.limit);
  });

  input.ipcMain.handle('managed-workspace:restore-version', async (_event, raw: unknown) => {
    const request = historicalRestoreRequest(raw);
    await requireManagedSession(input.client, request.sessionId);
    return input.client.restoreManagedWorkspaceVersion(
      request.sessionId,
      request.workspaceVersionId,
      request.restoreId,
    );
  });

  input.ipcMain.handle('managed-workspace:undo-version', async (_event, raw: unknown) => {
    const request = historicalRestoreRequest(raw);
    await requireManagedSession(input.client, request.sessionId);
    return input.client.undoManagedWorkspaceVersion(
      request.sessionId,
      request.workspaceVersionId,
      request.restoreId,
    );
  });
}

function publishRequest(value: unknown): { sessionId: string; publishId: string } {
  const record = requiredRecord(value, 'managed workspace publication');
  const publishId = requiredString(record.publishId, 'Publication id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(publishId)) {
    throw new Error('Invalid Publication id');
  }
  return {
    sessionId: requiredString(record.sessionId, 'Session id'),
    publishId,
  };
}

function restoreRequest(value: unknown): { sessionId: string; restoreId: string } {
  const record = requiredRecord(value, 'managed workspace restore');
  const restoreId = requiredString(record.restoreId, 'Restore id');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(restoreId)) {
    throw new Error('Invalid Restore id');
  }
  return {
    sessionId: requiredString(record.sessionId, 'Session id'),
    restoreId,
  };
}

function historyRequest(value: unknown): { sessionId: string; limit: number } {
  const record = requiredRecord(value, 'managed workspace history');
  if (!Number.isSafeInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > 100) {
    throw new Error('Invalid History limit');
  }
  return {
    sessionId: requiredString(record.sessionId, 'Session id'),
    limit: record.limit as number,
  };
}

function historicalRestoreRequest(value: unknown): {
  sessionId: string;
  workspaceVersionId: string;
  restoreId: string;
} {
  const record = requiredRecord(value, 'managed workspace historical restore');
  const workspaceVersionId = requiredString(record.workspaceVersionId, 'Workspace version id');
  const restoreId = requiredString(record.restoreId, 'Restore id');
  if (
    !/^version_[a-z0-9_-]{1,96}$/u.test(workspaceVersionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(restoreId)
  ) {
    throw new Error('Invalid Historical restore identity');
  }
  return {
    sessionId: requiredString(record.sessionId, 'Session id'),
    workspaceVersionId,
    restoreId,
  };
}

async function requireManagedSession(client: WorkspaceClient, sessionId: string): Promise<void> {
  const session = await client.getSession(sessionId);
  if (!session) throw new Error(`No such Session: ${sessionId}`);
  if (session.toolProfile !== 'managed-coding-v1') {
    throw new Error('Session does not own a managed workspace');
  }
}

async function sessionWorkspace(hostCwd: string): Promise<string | null> {
  const workspace = await stat(hostCwd).catch(() => null);
  return workspace?.isDirectory() ? hostCwd : null;
}

function readRequest(value: unknown): {
  sessionId: string;
  source: GitReviewSource;
  baseBranch?: string;
} {
  const record = requiredRecord(value, 'Git review');
  const sessionId = requiredString(record.sessionId, 'Session id');
  if (record.source !== 'branch' && record.source !== 'unstaged' && record.source !== 'staged') {
    throw new Error('Invalid Git review source');
  }
  const baseBranch = record.baseBranch;
  if (
    baseBranch !== undefined &&
    (typeof baseBranch !== 'string' ||
      baseBranch.length === 0 ||
      baseBranch.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(baseBranch))
  ) {
    throw new Error('Invalid Git review base branch');
  }
  return {
    sessionId,
    source: record.source,
    ...(typeof baseBranch === 'string' ? { baseBranch } : {}),
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label} input`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}
