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
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { WORKSPACE_MATERIALIZATION_SEMANTICS_V1 } from '@maka/core/workspace-version-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { commitExecutionStoresWorkspaceBaselineForTestInternal } from '@maka/storage/test-only/execution-stores-workspace-authority';
import {
  admitGitoxideHelperArtifactInternal,
  type GitoxideHelperInvocationCapability,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  createGitoxideManagedWriteEditOwnerInternal,
  GitoxideManagedWriteEditRecoveryError,
} from '../server/gitoxide-managed-write-edit-owner-internal.js';
import {
  admitGitoxideRepositoryInternal,
  importAdmittedGitoxideRepositoryInternal,
} from '../server/gitoxide-repository-admission-authority-internal.js';

test('rejects a non-canonical managed path before consulting Gitoxide', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-write-edit-owner-'));
  const rootCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  try {
    const owner = createGitoxideManagedWriteEditOwnerInternal({
      storageRootLease: rootOwner.lease,
      stores,
      invocationOwnerToken: {},
      helperCapability: {} as GitoxideHelperInvocationCapability,
      repositoryPath: join(root, 'managed.git'),
      workspaceId: `workspace_${'1'.repeat(32)}`,
      workspaceEpochId: `epoch_${'2'.repeat(32)}`,
    });

    await assert.rejects(
      owner.admitManagedMutation({
        operationId: 'operation-path-alias',
        toolName: 'Write',
        persistedArgs: { path: 'dir\\file.txt', content: 'after\n' },
        abortSignal: new AbortController().signal,
      }),
      /path must already be canonical/i,
    );
  } finally {
    await stores.sessionStore.close?.();
    await rootOwner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('requires the durable workspace epoch before consulting Gitoxide', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-write-edit-epoch-'));
  const rootCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  try {
    const owner = createGitoxideManagedWriteEditOwnerInternal({
      storageRootLease: rootOwner.lease,
      stores,
      invocationOwnerToken: {},
      helperCapability: {} as GitoxideHelperInvocationCapability,
      repositoryPath: join(root, 'managed.git'),
      workspaceId: `workspace_${'1'.repeat(32)}`,
      workspaceEpochId: `epoch_${'2'.repeat(32)}`,
    });

    await assert.rejects(
      owner.admitManagedMutation({
        operationId: 'operation-missing-epoch',
        toolName: 'Write',
        persistedArgs: { path: 'file.txt', content: 'after\n' },
        abortSignal: new AbortController().signal,
      }),
      /durable workspace epoch is unavailable/i,
    );
  } finally {
    await stores.sessionStore.close?.();
    await rootOwner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not report a current projection while a durable mutation reservation is active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-write-edit-active-'));
  const rootCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  const ids = {
    repositoryId: `repository_${'1'.repeat(32)}`,
    workspaceId: `workspace_${'2'.repeat(32)}`,
    workspaceEpochId: `epoch_${'3'.repeat(32)}`,
    workspaceInstanceId: `instance_${'4'.repeat(32)}`,
    workspaceVersionId: `version_${'5'.repeat(32)}`,
  } as const;
  const commitOid = '6'.repeat(40);
  const treeOid = '7'.repeat(40);
  const operationId = 'operation-active-write';
  const toolCallId = 'call-active-write';
  const args = { path: 'notes.txt', content: 'after\n' };
  const identity = {
    sessionId: 'session-active-write',
    invocationId: 'invocation-active-write',
    runId: 'run-active-write',
    turnId: 'turn-active-write',
  } as const;
  try {
    const baseline = await commitExecutionStoresWorkspaceBaselineForTestInternal(stores, {
      epochOpenedEventId: 'active-write-epoch',
      baselineAcceptedEventId: 'active-write-baseline',
      committedAt: 1,
      epoch: {
        repositoryId: ids.repositoryId,
        workspaceId: ids.workspaceId,
        workspaceEpochId: ids.workspaceEpochId,
        workspaceInstanceId: ids.workspaceInstanceId,
        mode: 'managed_worktree',
        objectFormat: 'sha1',
        sourceCommitOid: commitOid,
        sourceTreeOid: treeOid,
        materializationProfileDigest: sha256('gitoxide-materialization-v1'),
        materializationSemantics: WORKSPACE_MATERIALIZATION_SEMANTICS_V1,
        policyHash: sha256('managed-tree-policy-v3'),
      },
      baseline: {
        workspaceVersionId: ids.workspaceVersionId,
        commitOid,
        treeOid,
        treeDeltaDigest: sha256('gitoxide-baseline-delta-v1'),
        changedFileCount: 1,
        deletedFileCount: 0,
      },
    });
    const canonicalArgsHash = canonicalToolArgsHash('Write', args);
    await stores.runtimeEventStore.commitToolPrepared({
      operationId,
      journalEventId: `${operationId}_prepared`,
      runtimeEvent: {
        id: 'active-write-call-event',
        ...identity,
        ts: 2,
        partial: false,
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: toolCallId, name: 'Write', args },
        refs: { operationId, toolCallId },
      },
      dispatchRuntimeEvent: {
        id: 'active-write-dispatch-event',
        ...identity,
        ts: 2,
        partial: false,
        role: 'system',
        author: 'system',
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId,
            providerToolCallId: toolCallId,
            toolName: 'Write',
            canonicalArgsHash,
            recoveryMode: 'reconcile',
            managedMutation: {
              protocol: 'managed_mutation_v2',
              repositoryId: ids.repositoryId,
              workspaceId: ids.workspaceId,
              workspaceEpochId: ids.workspaceEpochId,
              workspaceInstanceId: ids.workspaceInstanceId,
              objectFormat: 'sha1',
              baseWorkspaceVersionId: ids.workspaceVersionId,
              baseAcceptedEventId: baseline.head.acceptedEventId,
              baseHeadRevision: baseline.head.revision,
              baseCommitOid: commitOid,
              baseTreeOid: treeOid,
              expectedPath: args.path,
              pathPolicyVersion: 3,
              executionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
            },
          },
        },
        refs: { operationId, toolCallId },
      },
      providerToolCallId: toolCallId,
      toolName: 'Write',
      canonicalArgsHash,
      recoveryMode: 'reconcile',
      committedAt: 2,
    });
    const owner = createGitoxideManagedWriteEditOwnerInternal({
      storageRootLease: rootOwner.lease,
      stores,
      invocationOwnerToken: {},
      helperCapability: {} as GitoxideHelperInvocationCapability,
      repositoryPath: join(root, 'managed.git'),
      workspaceId: ids.workspaceId,
      workspaceEpochId: ids.workspaceEpochId,
    });

    await assert.rejects(owner.reconcileAcceptedProjection(), (error: unknown) => {
      assert.ok(error instanceof GitoxideManagedWriteEditRecoveryError);
      assert.equal(error.code, 'gitoxide_managed_mutation_replay_required');
      return true;
    });
  } finally {
    await stores.sessionStore.close?.();
    await rootOwner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('reopens after a process crash and promotes the exact durable Write successor', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real owner contract test');
    return;
  }
  const sourceRepositoryPath = await createRepository(t);
  await writeFile(join(sourceRepositoryPath, 'notes.txt'), 'before\n', 'utf8');
  git(sourceRepositoryPath, ['add', 'notes.txt']);
  git(sourceRepositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);

  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-write-edit-full-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);

  const admissionOwnerToken = {};
  const importedRepositoryOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath: sourceRepositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const repositoryPath = join(root, 'managed.git');
  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken: importedRepositoryOwnerToken,
    destinationRepositoryPath: repositoryPath,
  });
  const ids = {
    repositoryId: `repository_${'1'.repeat(32)}`,
    workspaceId: `workspace_${'2'.repeat(32)}`,
    workspaceEpochId: `epoch_${'3'.repeat(32)}`,
    workspaceInstanceId: `instance_${'4'.repeat(32)}`,
    workspaceVersionId: `version_${'5'.repeat(32)}`,
  } as const;
  const baseline = await commitExecutionStoresWorkspaceBaselineForTestInternal(stores, {
    epochOpenedEventId: 'gitoxide-write-edit-epoch',
    baselineAcceptedEventId: 'gitoxide-write-edit-baseline',
    committedAt: 1,
    epoch: {
      repositoryId: ids.repositoryId,
      workspaceId: ids.workspaceId,
      workspaceEpochId: ids.workspaceEpochId,
      workspaceInstanceId: ids.workspaceInstanceId,
      mode: 'managed_worktree',
      objectFormat: 'sha1',
      sourceCommitOid: imported.sourceHeadCommitOid,
      sourceTreeOid: imported.sourceTreeOid,
      materializationProfileDigest: sha256('gitoxide-materialization-v1'),
      materializationSemantics: WORKSPACE_MATERIALIZATION_SEMANTICS_V1,
      policyHash: sha256('managed-tree-policy-v3'),
    },
    baseline: {
      workspaceVersionId: ids.workspaceVersionId,
      commitOid: imported.baselineCommitOid,
      treeOid: imported.baselineTreeOid,
      treeDeltaDigest: sha256('gitoxide-baseline-delta-v1'),
      changedFileCount: 1,
      deletedFileCount: 0,
    },
  });
  const operationId = 'operation-real-write';
  const toolCallId = 'call-real-write';
  const args = { path: 'notes.txt', content: 'after\n' };
  const fixturePath = join(root, 'managed-write-crash-fixture.json');
  await writeFile(
    fixturePath,
    `${JSON.stringify({
      storageRoot: root,
      repositoryPath,
      helperPath: helper.helperPath,
      workspaceId: ids.workspaceId,
      workspaceEpochId: ids.workspaceEpochId,
      operationId,
      toolCallId,
      args,
    })}\n`,
    'utf8',
  );
  await stores.sessionStore.close?.();
  await rootOwner.close();

  const child = spawn(
    process.execPath,
    [
      join(import.meta.dirname, 'fixtures', 'gitoxide-managed-write-edit-owner-crash-child.js'),
      fixturePath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [exitCode] = (await once(child, 'exit')) as [number | null];
  assert.equal(exitCode, 73, Buffer.concat(stderr).toString('utf8'));
  assert.equal(
    gitBare(repositoryPath, ['rev-parse', 'refs/maka/accepted']),
    baseline.head.commitOid,
  );

  const reopenedRootCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const reopenedRootOwner = await tryAcquireInteractiveRootOwner(reopenedRootCapability);
  assert.ok(reopenedRootOwner);
  t.after(() => reopenedRootOwner.close());
  const reopenedStores = await openInteractiveExecutionStoresForWrite(reopenedRootOwner.lease);
  t.after(() => reopenedStores.sessionStore.close?.());
  const owner = createGitoxideManagedWriteEditOwnerInternal({
    storageRootLease: reopenedRootOwner.lease,
    stores: reopenedStores,
    invocationOwnerToken: helper.invocationOwnerToken,
    helperCapability: helper.helperCapability,
    repositoryPath,
    workspaceId: ids.workspaceId,
    workspaceEpochId: ids.workspaceEpochId,
  });
  assert.equal(await owner.reconcileAcceptedProjection(), 'promoted');

  const reopened = await owner.admitManagedMutation({
    operationId: 'operation-read-promoted-head',
    toolName: 'Write',
    persistedArgs: { path: 'notes.txt', content: 'after\n' },
    abortSignal: new AbortController().signal,
  });
  assert.equal(reopened.durableDispatch.baseHeadRevision, baseline.head.revision + 1);
  assert.equal(
    gitBare(repositoryPath, ['rev-parse', 'refs/maka/accepted']),
    reopened.durableDispatch.baseCommitOid,
  );
  assert.deepEqual(reopened.immutableBase, { content: 'after\n' });
  assert.equal(await owner.reconcileAcceptedProjection(), 'already_current');
});

async function admittedHelper(): Promise<
  | {
      readonly invocationOwnerToken: object;
      readonly helperCapability: GitoxideHelperInvocationCapability;
      readonly helperPath: string;
    }
  | undefined
> {
  const configuredHelperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!configuredHelperPath) return undefined;
  const helperPath = await realpath(configuredHelperPath);
  const helperBytes = await readFile(helperPath);
  const helperInfo = await stat(helperPath);
  const expectedSha256 = sha256Bytes(helperBytes);
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath: helperPath,
    expectedSha256,
    expectedBytes: helperInfo.size,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
    supportedOperations: [
      'inspect_repository',
      'import_source_head',
      'create_candidate',
      'promote_candidate',
      'observe_accepted_ref',
      'read_tree_file',
    ],
  });
  const helperCapability = await admitGitoxideHelperArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim,
  });
  return { invocationOwnerToken, helperCapability, helperPath };
}

async function createRepository(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-write-edit-source-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  git(path, ['init', '--quiet', '--object-format=sha1']);
  return path;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function gitBare(repositoryPath: string, args: readonly string[]): string {
  return execFileSync('git', [`--git-dir=${repositoryPath}`, ...args], {
    encoding: 'utf8',
  }).trim();
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function sha256Bytes(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
