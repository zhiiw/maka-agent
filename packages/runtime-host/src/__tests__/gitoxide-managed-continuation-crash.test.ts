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
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSqliteRuntimeStore } from '@maka/storage';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { requireExecutionStoresWorkspaceMutationAuthorityInternal } from '@maka/storage/execution-stores-workspace-authority-internal';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  inspectGitoxideManagedContinuationBoundary,
  openGitoxideManagedMutationSession,
} from '../server/gitoxide-managed-mutation-session.js';
import {
  connectClient,
  ExecutionFixture,
  PROCESS_TIMEOUT_MS,
  withTimeout,
} from './fixtures/execution-host-suite.js';

test('a started workspace-bound continuation survives Host death without provider replay', async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  const bundledNpmResourcesRoot = process.env.MAKA_BUNDLED_NPM_RESOURCES_ROOT;
  if (!helperPath || !bundledNpmResourcesRoot) {
    t.skip(
      'MAKA_GITOXIDE_HELPER_PATH and MAKA_BUNDLED_NPM_RESOURCES_ROOT are required for the real helper continuation test',
    );
    return;
  }

  await withManagedContinuationFixture(
    helperPath,
    bundledNpmResourcesRoot,
    async ({ fixture, resourcesRoot, callLog, boundary }) => {
      const source = await fixture.seedSafeBoundaryContinuationSource();
      const crashHost = await fixture.startHost(undefined, true, {
        packagedResourcesRoot: resourcesRoot,
        providerCallLogPath: callLog,
        continuationFailpoint: 'after_continuation_start_committed',
      });
      const crashClient = await connectClient(fixture.root);
      const targetTurnId = 'turn-workspace-bound-host-crash';
      try {
        const initialPlan = await crashClient.queryTurnResume({ sessionId: fixture.sessionId });
        assert.equal(initialPlan.disposition, 'ready', JSON.stringify(initialPlan));
        const failpoint = waitForContinuationFailpoint(crashHost.child);
        const start = crashClient
          .startTurnResume({
            sessionId: fixture.sessionId,
            turnId: targetTurnId,
            sourceRunId: source.sourceRunId,
            sourceRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
          })
          .then(
            () => undefined,
            () => undefined,
          );
        await failpoint;
        await fixture.killHost(crashHost);
        await withTimeout(start, PROCESS_TIMEOUT_MS, 'crashed continuation request did not close');
      } finally {
        await crashClient.close().catch(() => undefined);
      }

      assert.equal(await readFile(callLog, 'utf8'), '');
      const admission = (await fixture.readAdmissionChain()).find(
        (candidate) => candidate.turnId === targetTurnId,
      );
      assert.equal(admission?.execution.kind, 'safe_boundary_continuation');
      if (admission?.execution.kind !== 'safe_boundary_continuation') {
        assert.fail('Workspace-bound continuation admission is missing');
      }

      const successorHost = await fixture.startHost(undefined, true, {
        packagedResourcesRoot: resourcesRoot,
        providerCallLogPath: callLog,
      });
      const successorClient = await connectClient(fixture.root);
      try {
        const target = await successorClient.queryTurn({
          sessionId: fixture.sessionId,
          turnId: targetTurnId,
        });
        assert.equal(target.runId, admission.runId);
        assert.equal(
          target.status === 'created' || target.status === 'running',
          true,
          JSON.stringify(target),
        );
        assert.deepEqual(await successorClient.queryTurnResume({ sessionId: fixture.sessionId }), {
          sessionId: fixture.sessionId,
          disposition: 'parked',
          reason: 'continuation_started_indeterminate',
        });
        assert.equal(await readFile(callLog, 'utf8'), '');
      } finally {
        await successorClient.close();
        await fixture.stopHost(successorHost);
      }

      const store = createSqliteRuntimeStore(join(fixture.root, 'runtime.sqlite'), {
        readOnly: true,
      });
      try {
        const state = await store.readWorkspaceBoundContinuationClaimStateByBoundary(
          admission.execution.boundaryDigest,
        );
        assert.equal(state?.claim.protocol, 'continuation_claim_v2');
        assert.equal(state?.startKind, 'runtime_admission');
        assert.ok(state?.startEventId);
        assert.equal(state?.claim.workspaceBoundary.commitOid, boundary.commitOid);
        assert.equal(state?.claim.workspaceBoundary.treeOid, boundary.treeOid);
        assert.equal(state?.claim.workspaceBoundary.revision, boundary.revision);
      } finally {
        store.close();
      }
    },
  );
});

async function withManagedContinuationFixture(
  helperInputPath: string,
  bundledNpmResourcesRoot: string,
  run: (input: {
    fixture: ExecutionFixture;
    resourcesRoot: string;
    callLog: string;
    boundary: NonNullable<Awaited<ReturnType<typeof inspectGitoxideManagedContinuationBoundary>>>;
  }) => Promise<void>,
): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-continuation-')));
  const root = join(base, 'root');
  const callLog = join(base, 'provider-calls.log');
  await mkdir(root);
  await writeFile(callLog, '', 'utf8');
  git(root, ['init', '--quiet', '--object-format=sha1']);
  await writeFile(join(root, 'notes.txt'), 'baseline\n', 'utf8');
  git(root, ['add', 'notes.txt']);
  git(root, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'baseline',
  ]);

  const resourcesRoot = await preparePackagedResources(
    base,
    helperInputPath,
    bundledNpmResourcesRoot,
  );
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to own managed continuation fixture root');
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  let sessionId: string;
  let boundary: NonNullable<Awaited<ReturnType<typeof inspectGitoxideManagedContinuationBoundary>>>;
  try {
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      toolProfile: 'managed-coding-v1',
    });
    sessionId = session.id;
    const helper = await admitRealHelper(helperInputPath);
    await openGitoxideManagedMutationSession({
      storageRoot: capability.canonicalPath,
      sourceRoot: root,
      sessionId,
      ...helper,
      settlementAuthority: requireExecutionStoresWorkspaceMutationAuthorityInternal(stores),
    });
    const observedBoundary = await inspectGitoxideManagedContinuationBoundary({
      storageRoot: capability.canonicalPath,
      sourceRoot: root,
      sessionId,
      ...helper,
      settlementAuthority: requireExecutionStoresWorkspaceMutationAuthorityInternal(stores),
    });
    assert.ok(observedBoundary);
    boundary = observedBoundary;
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
  }

  const fixture = new ExecutionFixture(base, root, capability, sessionId);
  try {
    await run({ fixture, resourcesRoot, callLog, boundary: boundary! });
  } finally {
    await fixture.close();
  }
}

async function preparePackagedResources(
  base: string,
  helperInputPath: string,
  bundledNpmResourcesInputRoot: string,
): Promise<string> {
  const resourcesRoot = join(base, 'resources');
  const helperDirectory = join(resourcesRoot, 'gitoxide');
  const executableName =
    process.platform === 'win32' ? 'maka-gitoxide-helper.exe' : 'maka-gitoxide-helper';
  const executablePath = join(helperDirectory, executableName);
  await mkdir(helperDirectory, { recursive: true });
  await copyFile(await realpath(helperInputPath), executablePath);
  if (process.platform !== 'win32') await chmod(executablePath, 0o755);
  const [bytes, info] = await Promise.all([readFile(executablePath), stat(executablePath)]);
  await writeFile(
    join(resourcesRoot, 'gitoxide-helper.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      protocol: 'maka_gitoxide_helper_release_v1',
      provider: 'maka/gitoxide-helper',
      platform: process.platform,
      arch: process.arch,
      protocolVersion: 1,
      executableRelativePath: `gitoxide/${executableName}`,
      bytes: info.size,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      distributionReady: true,
    })}\n`,
    'utf8',
  );
  const bundledNpmResourcesRoot = await realpath(bundledNpmResourcesInputRoot);
  await copyFile(
    join(bundledNpmResourcesRoot, 'bundled-npm.json'),
    join(resourcesRoot, 'bundled-npm.json'),
  );
  await cp(join(bundledNpmResourcesRoot, 'npm'), join(resourcesRoot, 'npm'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  return resourcesRoot;
}

async function admitRealHelper(helperInputPath: string) {
  const executablePath = await realpath(helperInputPath);
  const [bytes, info] = await Promise.all([readFile(executablePath), stat(executablePath)]);
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath,
    expectedSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    expectedBytes: info.size,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
  });
  const helperCapability = await admitGitoxideHelperArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim,
  });
  return { invocationOwnerToken, helperCapability };
}

function waitForContinuationFailpoint(child: ChildProcess): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown): void => {
        if (
          message &&
          typeof message === 'object' &&
          (message as { type?: unknown }).type === 'test.continuation_failpoint'
        ) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(`Runtime Host exited before continuation failpoint: ${code ?? signal}`));
      };
      const cleanup = (): void => {
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.on('exit', onExit);
    }),
    PROCESS_TIMEOUT_MS * 3,
    'Runtime Host did not reach the continuation failpoint',
  );
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
