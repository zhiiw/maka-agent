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
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { MANAGED_OBSERVATION_EXECUTION_PROFILE_V1_DIGEST } from '@maka/core/runtime-event';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  createManagedNodeTestAdmissionOwnerInternal,
  createManagedNodeTestExecutionRootOwnerInternal,
  type ManagedNodeTestAcceptedBoundaryInternal,
} from '../server/managed-node-test-admission-owner-internal.js';

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

test('admits one exact accepted-world Node test and removes its disposable roots', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-managed-test-admission-'));
  const rootOwner = await openStorageRootOwner(storageRoot);
  const source = 'test("works", () => {});\n';
  let executionRoot: string | undefined;
  try {
    const owner = createManagedNodeTestAdmissionOwnerInternal({
      executionRootOwner: createManagedNodeTestExecutionRootOwnerInternal({
        storageRootLease: rootOwner.lease,
      }),
      sourceOwner: {
        readAcceptedBoundary: async () => ACCEPTED_BOUNDARY,
        materializeAcceptedTree: async (request) => {
          const path = join(request.destinationPath, 'src', 'a.test.mjs');
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, source, 'utf8');
          return {
            acceptedCommitOid: ACCEPTED_BOUNDARY.acceptedCommitOid,
            acceptedTreeOid: ACCEPTED_BOUNDARY.acceptedTreeOid,
          };
        },
      },
      commandOwner: {
        readToolchainIdentity: async () => ({
          identityDigest: `sha256:${'8'.repeat(64)}`,
          nodeVersion: '24.13.1',
        }),
        inspectFile: async (request) => ({
          protocolVersion: 1,
          kind: 'file_observation',
          ...(await fileIdentity(request.inputRoot, request.relativePath)),
        }),
        runNodeTests: async (request) => ({
          protocolVersion: 1,
          kind: 'node_test_observation',
          nodeVersion: '24.13.1',
          files: [await fileIdentity(request.inputRoot, request.relativePaths[0]!)],
          passed: 1,
          failed: 0,
          skipped: 0,
          todo: 0,
        }),
      },
    });
    const abortSignal = new AbortController().signal;
    const admission = await owner.admit({
      operationId: 'operation-1',
      toolName: 'ManagedNodeTest',
      persistedArgs: { relativePaths: ['src/a.test.mjs'] },
      abortSignal,
    });

    assert.deepEqual(admission.durableDispatch, {
      protocol: 'managed_observation_v1',
      ...ACCEPTED_BOUNDARY,
      objectFormat: 'sha1',
      operationKind: 'node_test_v1',
      effectClass: 'hermetic_observation_v1',
      executionProfileDigest: MANAGED_OBSERVATION_EXECUTION_PROFILE_V1_DIGEST,
      toolchainIdentityDigest: `sha256:${'8'.repeat(64)}`,
      files: [await fileIdentityFromContent('src/a.test.mjs', source)],
    });

    let result: unknown;
    await admission.execute(async (execution) => {
      executionRoot = dirname(execution.inputRoot);
      result = await owner.tool.managedObservationImpl!(
        { relativePaths: ['src/a.test.mjs'] },
        { abortSignal } as never,
        execution,
      );
    });
    assert.deepEqual(result, {
      protocolVersion: 1,
      kind: 'node_test_observation',
      nodeVersion: '24.13.1',
      files: [await fileIdentityFromContent('src/a.test.mjs', source)],
      passed: 1,
      failed: 0,
      skipped: 0,
      todo: 0,
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

test('rejects a materialized test file that changes after durable admission', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-managed-test-tamper-'));
  const rootOwner = await openStorageRootOwner(storageRoot);
  const source = 'test("works", () => {});\n';
  try {
    const owner = createManagedNodeTestAdmissionOwnerInternal({
      executionRootOwner: createManagedNodeTestExecutionRootOwnerInternal({
        storageRootLease: rootOwner.lease,
      }),
      sourceOwner: {
        readAcceptedBoundary: async () => ACCEPTED_BOUNDARY,
        materializeAcceptedTree: async (request) => {
          const path = join(request.destinationPath, 'src', 'a.test.mjs');
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, source, 'utf8');
          return {
            acceptedCommitOid: ACCEPTED_BOUNDARY.acceptedCommitOid,
            acceptedTreeOid: ACCEPTED_BOUNDARY.acceptedTreeOid,
          };
        },
      },
      commandOwner: commandOwnerForFilesystem(),
    });
    const abortSignal = new AbortController().signal;
    const admission = await owner.admit({
      operationId: 'operation-tamper',
      toolName: 'ManagedNodeTest',
      persistedArgs: { relativePaths: ['src/a.test.mjs'] },
      abortSignal,
    });
    try {
      await assert.rejects(
        admission.execute(async (execution) => {
          await writeFile(join(execution.inputRoot, 'src', 'a.test.mjs'), 'tampered\n', 'utf8');
          await owner.tool.managedObservationImpl!(
            { relativePaths: ['src/a.test.mjs'] },
            { abortSignal } as never,
            execution,
          );
        }),
        /input changed after durable admission/u,
      );
    } finally {
      await admission.dispose();
    }
  } finally {
    await rootOwner.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('rejects a conflicting accepted-tree materialization before durable admission', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-managed-test-conflict-'));
  const rootOwner = await openStorageRootOwner(storageRoot);
  try {
    const owner = createManagedNodeTestAdmissionOwnerInternal({
      executionRootOwner: createManagedNodeTestExecutionRootOwnerInternal({
        storageRootLease: rootOwner.lease,
      }),
      sourceOwner: {
        readAcceptedBoundary: async () => ACCEPTED_BOUNDARY,
        materializeAcceptedTree: async (request) => {
          const path = join(request.destinationPath, 'src', 'a.test.mjs');
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, 'stale\n', 'utf8');
          return {
            acceptedCommitOid: '9'.repeat(40),
            acceptedTreeOid: ACCEPTED_BOUNDARY.acceptedTreeOid,
          };
        },
      },
      commandOwner: commandOwnerForFilesystem(),
    });

    await assert.rejects(
      owner.admit({
        operationId: 'operation-conflict',
        toolName: 'ManagedNodeTest',
        persistedArgs: { relativePaths: ['src/a.test.mjs'] },
        abortSignal: new AbortController().signal,
      }),
      /materialization conflicts with the accepted boundary/u,
    );

    const ownerRoot = join(storageRoot, 'managed-node-test-observations-v1');
    const entries = await readdir(ownerRoot);
    assert.deepEqual(entries, []);
  } finally {
    await rootOwner.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

async function openStorageRootOwner(storageRoot: string) {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  return owner;
}

async function fileIdentity(inputRoot: string, relativePath: string) {
  const content = await readFile(join(inputRoot, ...relativePath.split('/')));
  return {
    relativePath,
    bytes: content.byteLength,
    sha256: `sha256:${createHash('sha256').update(content).digest('hex')}` as const,
  };
}

async function fileIdentityFromContent(relativePath: string, content: string) {
  return {
    relativePath,
    bytes: Buffer.byteLength(content),
    sha256: `sha256:${createHash('sha256').update(content).digest('hex')}` as const,
  };
}

function commandOwnerForFilesystem() {
  return {
    readToolchainIdentity: async () => ({
      identityDigest: `sha256:${'8'.repeat(64)}` as const,
      nodeVersion: '24.13.1',
    }),
    inspectFile: async (request: { inputRoot: string; relativePath: string }) => ({
      protocolVersion: 1 as const,
      kind: 'file_observation' as const,
      ...(await fileIdentity(request.inputRoot, request.relativePath)),
    }),
    runNodeTests: async (request: { inputRoot: string; relativePaths: readonly string[] }) => ({
      protocolVersion: 1 as const,
      kind: 'node_test_observation' as const,
      nodeVersion: '24.13.1',
      files: [await fileIdentity(request.inputRoot, request.relativePaths[0]!)],
      passed: 1,
      failed: 0,
      skipped: 0,
      todo: 0,
    }),
  };
}
