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
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { MANAGED_OBSERVATION_EXECUTION_PROFILE_V3_DIGEST } from '@maka/core/runtime-event';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createManagedNodeCommandAdmissionOwnerInternal } from '../server/managed-node-command-admission-owner-internal.js';
import { createManagedNodeTestExecutionRootOwnerInternal } from '../server/managed-node-test-admission-owner-internal.js';

const BOUNDARY = Object.freeze({
  repositoryId: 'repository_11111111111111111111111111111111',
  workspaceId: 'workspace_22222222222222222222222222222222',
  workspaceEpochId: 'epoch_33333333333333333333333333333333',
  workspaceInstanceId: 'instance_44444444444444444444444444444444',
  acceptedWorkspaceVersionId: 'version_55555555555555555555555555555555',
  acceptedEventId: 'accepted-event-1',
  acceptedHeadRevision: 2,
  acceptedCommitOid: '1'.repeat(40),
  acceptedTreeOid: '2'.repeat(40),
});

test('admits one exact accepted-tree Node entrypoint and freezes its arguments before T1', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-managed-node-command-admission-'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const storageOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(storageOwner);
  t.after(async () => {
    await storageOwner.close();
    await rm(storageRoot, { recursive: true, force: true });
  });
  const source = 'console.log("accepted");\n';
  const owner = createManagedNodeCommandAdmissionOwnerInternal({
    executionRootOwner: createManagedNodeTestExecutionRootOwnerInternal({
      storageRootLease: storageOwner.lease,
    }),
    sourceOwner: {
      readAcceptedBoundary: async () => BOUNDARY,
      materializeAcceptedTree: async (request) => {
        const path = join(request.destinationPath, 'scripts', 'check.mjs');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, source, 'utf8');
        return {
          acceptedCommitOid: BOUNDARY.acceptedCommitOid,
          acceptedTreeOid: BOUNDARY.acceptedTreeOid,
        };
      },
    },
    commandOwner: {
      readToolchainIdentity: async (effectClass) => {
        assert.equal(effectClass, 'hermetic_observation_v3');
        return {
          identityDigest: `sha256:${'8'.repeat(64)}`,
          nodeVersion: '24.13.1',
          platform: process.platform,
          arch: process.arch,
        };
      },
      readDependencyIdentity: async () => {
        throw new Error('dependencies are not part of managed Node command v1');
      },
      inspectFile: async (request) => {
        assert.equal(request.effectClass, 'hermetic_observation_v3');
        const bytes = await readFile(join(request.inputRoot, ...request.relativePath.split('/')));
        return {
          protocolVersion: 1,
          kind: 'file_observation',
          relativePath: request.relativePath,
          bytes: bytes.byteLength,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        };
      },
      runNodeTests: async () => {
        throw new Error('test runner is not part of this operation');
      },
      runNodeEntrypoint: async (request) => ({
        protocolVersion: 1,
        kind: 'node_command_observation',
        nodeVersion: '24.13.1',
        entry: {
          relativePath: request.entryPath,
          bytes: Buffer.byteLength(source),
          sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
        },
        exitCode: 0,
        stdout: `${request.args.join(',')}\n`,
        stderr: '',
      }),
    },
  });
  const abortSignal = new AbortController().signal;
  await assert.rejects(
    owner.admit({
      operationId: 'invalid-operation-1',
      toolName: 'ManagedNodeRun',
      persistedArgs: { entryPath: '../escape.mjs', args: [] },
      abortSignal,
    }),
    /entrypoint is invalid/u,
  );
  await assert.rejects(
    owner.admit({
      operationId: 'invalid-operation-2',
      toolName: 'ManagedNodeRun',
      persistedArgs: { entryPath: 'scripts/check.mjs', args: ['x'.repeat(4097)] },
      abortSignal,
    }),
    /argument is too large/u,
  );
  const admission = await owner.admit({
    operationId: 'operation-1',
    toolName: 'ManagedNodeRun',
    persistedArgs: { entryPath: 'scripts/check.mjs', args: ['--check', 'src/index.js'] },
    abortSignal,
  });
  assert.deepEqual(admission.durableDispatch, {
    protocol: 'managed_observation_v3',
    ...BOUNDARY,
    objectFormat: 'sha1',
    operationKind: 'node_command_v3',
    effectClass: 'hermetic_observation_v3',
    executionProfileDigest: MANAGED_OBSERVATION_EXECUTION_PROFILE_V3_DIGEST,
    toolchainIdentityDigest: `sha256:${'8'.repeat(64)}`,
    entry: {
      relativePath: 'scripts/check.mjs',
      bytes: Buffer.byteLength(source),
      sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
    },
    args: ['--check', 'src/index.js'],
  });

  let result: unknown;
  let executionRoot: string | undefined;
  await admission.execute(async (execution) => {
    executionRoot = dirname(execution.inputRoot);
    await assert.rejects(
      async () =>
        await owner.tool.managedObservationImpl!(
          { entryPath: 'scripts/other.mjs', args: ['--check', 'src/index.js'] },
          { abortSignal } as never,
          execution,
        ),
      /execution roots are not admitted/u,
    );
    result = await owner.tool.managedObservationImpl!(
      { entryPath: 'scripts/check.mjs', args: ['--check', 'src/index.js'] },
      { abortSignal } as never,
      execution,
    );
  });
  assert.deepEqual(result, {
    protocolVersion: 1,
    kind: 'node_command_observation',
    nodeVersion: '24.13.1',
    entry: admission.durableDispatch.entry,
    exitCode: 0,
    stdout: '--check,src/index.js\n',
    stderr: '',
  });
  await admission.dispose();
  assert.ok(executionRoot);
  await assert.rejects(stat(executionRoot));
});
