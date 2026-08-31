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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionCreateInput } from '@maka/runtime-host/protocol';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import { registerRuntimeHostSessionCatalogIpc } from '../runtime-host-session-catalog-ipc-main.js';

test('Desktop main automatically admits ordinary project sessions to managed coding', async () => {
  const handlers = new Map<string, IpcHandler>();
  const creates: SessionCreateInput[] = [];

  registerRuntimeHostSessionCatalogIpc(
    {
      client: {
        async queryHostExecutionProfiles() {
          return {
            profiles: ['managed-coding-v1', 'managed-coding-v2'] as const,
          };
        },
        async createSession(input: SessionCreateInput) {
          creates.push(input);
          return sessionProjection(input);
        },
      } as never,
      runningTurnIds: () => [],
      resolveCreateProject: async () => ({ kind: 'project', projectId: 'project-1' }),
      emitSessionsChanged() {},
      releaseSessionResources() {},
      sessionCopyCleanup: {
        recover: async () => ({ cleaned: [], failed: [] }),
      } as never,
      newId: () => 'session-1',
    },
    {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
  );

  const create = handlers.get('sessions:create');
  assert.ok(create);
  await create({} as never, { projectId: 'project-1' });

  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.toolProfile, 'managed-coding-v2');
  assert.deepEqual(creates[0]?.workspace, { kind: 'project', projectId: 'project-1' });
});

function sessionProjection(input: SessionCreateInput) {
  return {
    id: input.sessionId,
    revision: 1,
    workspace: {
      target: input.workspace,
      hostCwd: '/workspace',
    },
    name: input.name ?? 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    status: 'active' as const,
    createdAt: 1,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask' as const,
    collaborationMode: 'agent' as const,
    orchestrationMode: 'default' as const,
    toolProfile: input.toolProfile,
  };
}
