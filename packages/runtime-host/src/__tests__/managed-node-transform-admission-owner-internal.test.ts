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
import { MANAGED_MUTATION_EXECUTION_PROFILE_V2_DIGEST } from '@maka/core/runtime-event';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createManagedNodeTestExecutionRootOwnerInternal } from '../server/managed-node-test-admission-owner-internal.js';
import { createManagedNodeTransformOwnerInternal } from '../server/managed-node-transform-admission-owner-internal.js';

const HEAD = Object.freeze({
  repositoryId: 'repository_11111111111111111111111111111111',
  workspaceId: 'workspace_22222222222222222222222222222222',
  workspaceEpochId: 'epoch_33333333333333333333333333333333',
  workspaceVersionId: 'version_55555555555555555555555555555555',
  acceptedEventId: 'accepted-event-1',
  revision: 2,
  commitOid: '1'.repeat(40),
  treeOid: '2'.repeat(40),
});
const EPOCH = Object.freeze({
  protocol: 'workspace_epoch_opened_v1' as const,
  repositoryId: HEAD.repositoryId,
  workspaceId: HEAD.workspaceId,
  workspaceEpochId: HEAD.workspaceEpochId,
  workspaceInstanceId: 'instance_44444444444444444444444444444444',
  mode: 'managed_worktree' as const,
  objectFormat: 'sha1' as const,
  sourceCommitOid: '3'.repeat(40),
  sourceTreeOid: '4'.repeat(40),
  initialWorkspaceVersionId: HEAD.workspaceVersionId,
  materializationProfileDigest: `sha256:${'5'.repeat(64)}` as const,
  materializationSemantics: 'git_tree_materialized_with_fixed_config_v1' as const,
  policyHash: `sha256:${'6'.repeat(64)}` as const,
  authority: {
    sessionId: 'maka_workspace_authority' as const,
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
  },
  epochOpenedEventId: 'epoch-opened-1',
  committedAt: 1,
});

test('freezes one accepted-tree transformer and returns one owner-bound output proof', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-managed-node-transform-'));
  const rootCapability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const storageOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(storageOwner);
  t.after(async () => {
    await storageOwner.close();
    await rm(storageRoot, { recursive: true, force: true });
  });
  const entryContent = [
    "import { writeFile } from 'node:fs/promises';",
    "await writeFile(process.env.MAKA_OUTPUT_PATH, 'generated\\n');",
    '',
  ].join('\n');
  const owner = createManagedNodeTransformOwnerInternal({
    executionRootOwner: createManagedNodeTestExecutionRootOwnerInternal({
      storageRootLease: storageOwner.lease,
    }),
    sourceOwner: {
      readAcceptedBoundary: async () => ({
        repositoryId: HEAD.repositoryId,
        workspaceId: HEAD.workspaceId,
        workspaceEpochId: HEAD.workspaceEpochId,
        workspaceInstanceId: EPOCH.workspaceInstanceId,
        acceptedWorkspaceVersionId: HEAD.workspaceVersionId,
        acceptedEventId: HEAD.acceptedEventId,
        acceptedHeadRevision: HEAD.revision,
        acceptedCommitOid: HEAD.commitOid,
        acceptedTreeOid: HEAD.treeOid,
      }),
      materializeAcceptedTree: async (request) => {
        const entry = join(request.destinationPath, 'scripts', 'generate.mjs');
        const output = join(request.destinationPath, 'generated', 'output.txt');
        await Promise.all([
          mkdir(dirname(entry), { recursive: true }),
          mkdir(dirname(output), { recursive: true }),
        ]);
        await Promise.all([
          writeFile(entry, entryContent, 'utf8'),
          writeFile(output, 'old\n', 'utf8'),
        ]);
        return { acceptedCommitOid: HEAD.commitOid, acceptedTreeOid: HEAD.treeOid };
      },
    },
    commandOwner: {
      readToolchainIdentity: async (effectClass) => {
        assert.equal(effectClass, 'workspace_transform_v1');
        return {
          identityDigest: `sha256:${'7'.repeat(64)}`,
          nodeVersion: '24.18.1',
          platform: process.platform,
          arch: process.arch,
        };
      },
      readDependencyIdentity: async () => assert.fail('dependency authority is out of scope'),
      inspectFile: async (request) => {
        assert.equal(request.effectClass, 'workspace_transform_v1');
        const bytes = await readFile(join(request.inputRoot, ...request.relativePath.split('/')));
        return {
          protocolVersion: 1,
          kind: 'file_observation',
          relativePath: request.relativePath,
          bytes: bytes.byteLength,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        };
      },
      runNodeTests: async () => assert.fail('test authority is out of scope'),
      runNodeTransform: async (request) => ({
        protocolVersion: 1,
        kind: 'workspace_transform',
        nodeVersion: '24.18.1',
        entry: {
          relativePath: request.entryPath,
          bytes: Buffer.byteLength(entryContent),
          sha256: `sha256:${createHash('sha256').update(entryContent).digest('hex')}`,
        },
        path: request.outputPath,
        content: 'generated\n',
        bytes: Buffer.byteLength('generated\n'),
        sha256: `sha256:${createHash('sha256').update('generated\n').digest('hex')}`,
        stdout: 'generated one file\n',
        stderr: '',
      }),
    },
  });
  const abortSignal = new AbortController().signal;
  const prepared = await owner.admission.prepare({
    request: {
      operationId: 'operation-transform-1',
      toolName: 'ManagedNodeTransform',
      persistedArgs: {
        entryPath: 'scripts/generate.mjs',
        path: 'generated/output.txt',
        args: ['--stable'],
      },
      abortSignal,
    },
    head: HEAD,
    epoch: EPOCH,
  });
  assert.equal(prepared.durableDispatch.protocol, 'managed_mutation_v3');
  assert.equal(
    prepared.durableDispatch.executionProfileDigest,
    MANAGED_MUTATION_EXECUTION_PROFILE_V2_DIGEST,
  );
  assert.deepEqual(prepared.durableDispatch.args, ['--stable']);
  const transformed = await owner.tool.managedWorkspaceTransform!(
    {
      entryPath: 'scripts/generate.mjs',
      path: 'generated/output.txt',
      args: ['--stable'],
    },
    {
      operationId: 'operation-transform-1',
      abortSignal,
    } as never,
  );
  assert.deepEqual(transformed.mutationResult, {
    path: 'generated/output.txt',
    content: 'generated\n',
    changed: true,
  });
  await assert.rejects(
    async () =>
      await owner.tool.managedWorkspaceTransform!(
        { entryPath: 'scripts/generate.mjs', path: 'generated/output.txt', args: ['--stable'] },
        { operationId: 'operation-transform-1', abortSignal } as never,
      ),
    /capability is unavailable/u,
  );
  await prepared.dispose();
  const ownerRoot = join(storageRoot, 'managed-node-test-executions');
  const remaining = await stat(ownerRoot).catch(() => undefined);
  assert.equal(remaining, undefined);
});
