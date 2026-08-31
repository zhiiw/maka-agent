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
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { EXTERNAL_EFFECT_EXECUTION_PROFILE_V1_DIGEST } from '@maka/core/runtime-event';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  createManagedNodeTestExecutionRootOwnerInternal,
  type ManagedNodeTestAcceptedBoundaryInternal,
} from '../server/managed-node-test-admission-owner-internal.js';
import { createShellRunExternalEffectAdmissionOwnerInternal } from '../server/shell-run-external-effect-admission-owner-internal.js';

const ACCEPTED_BOUNDARY: ManagedNodeTestAcceptedBoundaryInternal = Object.freeze({
  repositoryId: `repository_${'1'.repeat(32)}`,
  workspaceId: `workspace_${'2'.repeat(32)}`,
  workspaceEpochId: `epoch_${'3'.repeat(32)}`,
  workspaceInstanceId: `instance_${'4'.repeat(32)}`,
  acceptedWorkspaceVersionId: `version_${'5'.repeat(32)}`,
  acceptedEventId: 'accepted-event-1',
  acceptedHeadRevision: 7,
  acceptedCommitOid: '6'.repeat(40),
  acceptedTreeOid: '7'.repeat(40),
});

test('binds one ShellRun fence to a disposable materialization of the accepted tree', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-shell-effect-admission-'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  let executionRoot: string | undefined;
  try {
    const owner = createShellRunExternalEffectAdmissionOwnerInternal({
      executionRootOwner: createManagedNodeTestExecutionRootOwnerInternal({
        storageRootLease: rootOwner.lease,
      }),
      sourceOwner: {
        readAcceptedBoundary: async () => ACCEPTED_BOUNDARY,
        materializeAcceptedTree: async (request) => {
          const path = join(request.destinationPath, 'package.json');
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, '{"name":"accepted"}\n', 'utf8');
          return {
            acceptedCommitOid: ACCEPTED_BOUNDARY.acceptedCommitOid,
            acceptedTreeOid: ACCEPTED_BOUNDARY.acceptedTreeOid,
          };
        },
      },
    });
    const admission = await owner.admit({
      operationId: 'operation-1',
      toolName: 'Bash',
      persistedArgs: { command: 'npm publish', timeout_ms: 30_000 },
      abortSignal: new AbortController().signal,
    });

    assert.deepEqual(admission.durableDispatch, {
      protocol: 'external_effect_v1',
      effectClass: 'external_effect_v1',
      operationId: 'operation-1',
      idempotencyKey: 'operation-1',
      targetAuthority: 'shell_run_v1',
      reconciliationContract: 'shell_run_terminal_or_park_v1',
      ...ACCEPTED_BOUNDARY,
      objectFormat: 'sha1',
      executionProfileDigest: EXTERNAL_EFFECT_EXECUTION_PROFILE_V1_DIGEST,
    });
    await admission.execute(async (execution) => {
      executionRoot = dirname(execution.cwd);
      assert.equal(execution.cwd.endsWith('input'), true);
      assert.equal(execution.scratchRoot.endsWith('scratch'), true);
      await access(join(execution.cwd, 'package.json'));
    });
    await admission.dispose();

    assert.ok(executionRoot);
    await assert.rejects(access(executionRoot), (error: unknown) =>
      Boolean(
        error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT',
      ),
    );
  } finally {
    await rootOwner.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});
