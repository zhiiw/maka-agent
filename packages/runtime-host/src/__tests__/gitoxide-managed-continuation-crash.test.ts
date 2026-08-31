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
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { resolveWorkspaceIdentity } from '@maka/storage/workspace-identity';
import {
  admitGitoxideHelperArtifactInternal,
  GITOXIDE_HELPER_OPERATIONS_INTERNAL,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  inspectGitoxideManagedContinuationBoundaryInternal,
  openGitoxideManagedSessionOwnerInternal,
} from '../server/gitoxide-managed-session-owner-internal.js';
import {
  connectClient,
  ExecutionFixture,
  PROCESS_TIMEOUT_MS,
  withTimeout,
} from './fixtures/execution-host-suite.js';

const FAKE_CONNECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('a started workspace-bound continuation survives Host death without provider replay', async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper continuation test');
    return;
  }
  if (process.platform === 'win32') {
    t.skip('managed-coding-v2 is not a supported Windows product profile yet');
    return;
  }
  await withManagedContinuationFixture(
    helperPath,
    async ({ fixture, resourcesRoot, runtimeExecutablePath, callLog, boundary }) => {
      const source = await fixture.seedSafeBoundaryContinuationSource(undefined, {
        failureClass: 'test_manual_resume',
      });
      const crashHost = await fixture.startHost(undefined, true, {
        packagedResourcesRoot: resourcesRoot,
        runtimeExecutablePath,
        providerCallLogPath: callLog,
        continuationFailpoint: 'after_continuation_start_committed',
      });
      const crashClient = await connectClient(fixture.root);
      const targetTurnId = 'turn-workspace-bound-host-crash';
      try {
        const initialPlan = await crashClient.request('turn.resume.query', {
          sessionId: fixture.sessionId,
        });
        assert.equal(initialPlan.disposition, 'ready', JSON.stringify(initialPlan));
        const failpoint = waitForContinuationFailpoint(crashHost.child);
        const start = crashClient
          .request('turn.resume.start', {
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
        runtimeExecutablePath,
        providerCallLogPath: callLog,
      });
      const successorClient = await connectClient(fixture.root);
      try {
        const target = await successorClient.request('turn.query', {
          sessionId: fixture.sessionId,
          turnId: targetTurnId,
        });
        assert.equal(target.runId, admission.runId);
        assert.equal(target.status, 'failed');
        if (target.status !== 'failed') assert.fail('Crashed continuation Run was not closed');
        assert.equal(target.failureClass, 'app_restarted');
        const plan = {
          sessionId: fixture.sessionId,
          disposition: 'parked' as const,
          reason: 'continuation_started_indeterminate' as const,
        };
        assert.deepEqual(
          await successorClient.request('turn.resume.query', {
            sessionId: fixture.sessionId,
            sourceRunId: source.sourceRunId,
            expectedRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
          }),
          plan,
        );
        assert.deepEqual(
          await successorClient.request('turn.resume.start', {
            sessionId: fixture.sessionId,
            turnId: `${targetTurnId}-retry`,
            sourceRunId: source.sourceRunId,
            sourceRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
          }),
          { kind: 'parked', plan },
        );
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

test('an accepted-head continuation never calls the provider twice after Host death', async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real provider crash test');
    return;
  }
  if (process.platform === 'win32') {
    t.skip('managed-coding-v2 is not a supported Windows product profile yet');
    return;
  }
  await withManagedContinuationFixture(
    helperPath,
    async ({ fixture, resourcesRoot, runtimeExecutablePath, callLog, boundary }) => {
      assert.equal(boundary.revision, 1);
      const source = await fixture.seedSafeBoundaryContinuationSource(undefined, {
        failureClass: 'test_manual_resume',
      });
      const crashHost = await fixture.startHost(undefined, true, {
        packagedResourcesRoot: resourcesRoot,
        runtimeExecutablePath,
        providerCallLogPath: callLog,
        providerFailpointAfterSend: true,
      });
      const crashClient = await connectClient(fixture.root);
      const targetTurnId = 'turn-workspace-bound-provider-crash';
      try {
        const initialPlan = await crashClient.request('turn.resume.query', {
          sessionId: fixture.sessionId,
        });
        assert.equal(initialPlan.disposition, 'ready', JSON.stringify(initialPlan));
        const failpoint = waitForProviderFailpoint(crashHost.child);
        const start = crashClient
          .request('turn.resume.start', {
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
        assert.equal(await providerCallCount(callLog), 1);
        await fixture.killHost(crashHost);
        await withTimeout(start, PROCESS_TIMEOUT_MS, 'provider-crashed continuation did not close');
      } finally {
        await crashClient.close().catch(() => undefined);
      }

      const successorHost = await fixture.startHost(undefined, true, {
        packagedResourcesRoot: resourcesRoot,
        runtimeExecutablePath,
        providerCallLogPath: callLog,
      });
      const successorClient = await connectClient(fixture.root);
      try {
        const plan = await successorClient.request('turn.resume.query', {
          sessionId: fixture.sessionId,
          sourceRunId: source.sourceRunId,
          expectedRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
        });
        assert.equal(plan.disposition, 'parked');
        assert.equal(plan.reason, 'continuation_started_indeterminate');
        const retry = await successorClient.request('turn.resume.start', {
          sessionId: fixture.sessionId,
          turnId: `${targetTurnId}-retry`,
          sourceRunId: source.sourceRunId,
          sourceRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
        });
        assert.equal(retry.kind, 'parked');
        assert.equal(await providerCallCount(callLog), 1);
      } finally {
        await successorClient.close();
        await fixture.stopHost(successorHost);
      }
    },
  );
});

test('Host startup automatically resumes one managed task without an experimental flag', async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the automatic managed resume test');
    return;
  }
  if (process.platform === 'win32') {
    t.skip('managed-coding-v2 is not a supported Windows product profile yet');
    return;
  }
  await withManagedContinuationFixture(
    helperPath,
    async ({ fixture, resourcesRoot, runtimeExecutablePath, callLog }) => {
      const source = await fixture.seedSafeBoundaryContinuationSource();
      const firstHost = await fixture.startHost(undefined, false, {
        packagedResourcesRoot: resourcesRoot,
        runtimeExecutablePath,
        providerCallLogPath: callLog,
      });
      try {
        await waitForProviderCalls(callLog, 1);
      } finally {
        await fixture.stopHost(firstHost);
      }

      const firstAdmissions = (await fixture.readAdmissionChain()).filter(
        (candidate) => candidate.execution.kind === 'safe_boundary_continuation',
      );
      assert.equal(firstAdmissions.length, 1);
      const admission = firstAdmissions[0]!;
      assert.equal(admission.execution.kind, 'safe_boundary_continuation');
      if (admission.execution.kind !== 'safe_boundary_continuation') {
        assert.fail('Automatic managed continuation admission is missing');
      }
      assert.equal(admission.execution.sourceRunId, source.sourceRunId);
      assert.deepEqual(await fixture.readTurnFootprint(admission.turnId), {
        admitted: true,
        runCount: 1,
        userMessageCount: 0,
      });

      const secondHost = await fixture.startHost(undefined, false, {
        packagedResourcesRoot: resourcesRoot,
        runtimeExecutablePath,
        providerCallLogPath: callLog,
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(await providerCallCount(callLog), 1);
        assert.equal(
          (await fixture.readAdmissionChain()).filter(
            (candidate) => candidate.execution.kind === 'safe_boundary_continuation',
          ).length,
          1,
        );
      } finally {
        await fixture.stopHost(secondHost);
      }
    },
  );
});

for (const sourceKind of ['git_repository_v1', 'filesystem_snapshot_v1'] as const) {
  test(`Host startup never replays an indeterminate ${sourceKind} continuation`, async (t) => {
    const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
    if (!helperPath) {
      t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the automatic resume crash matrix');
      return;
    }
    if (process.platform === 'win32') {
      t.skip('managed-coding-v2 is not a supported Windows product profile yet');
      return;
    }
    await withManagedContinuationFixture(
      helperPath,
      async ({
        fixture,
        resourcesRoot,
        runtimeExecutablePath,
        callLog,
        sourceKind: admittedSourceKind,
      }) => {
        assert.equal(admittedSourceKind, sourceKind);
        const source = await fixture.seedSafeBoundaryContinuationSource();
        const firstHost = await fixture.startHost(undefined, false, {
          packagedResourcesRoot: resourcesRoot,
          runtimeExecutablePath,
          providerCallLogPath: callLog,
          providerFailpointAfterSend: true,
        });
        await waitForProviderCalls(callLog, 1);
        await fixture.killHost(firstHost);

        const admissions = (await fixture.readAdmissionChain()).filter(
          (candidate) => candidate.execution.kind === 'safe_boundary_continuation',
        );
        assert.equal(admissions.length, 1);
        assert.equal(admissions[0]!.execution.kind, 'safe_boundary_continuation');
        if (admissions[0]!.execution.kind !== 'safe_boundary_continuation') {
          assert.fail(`${sourceKind} automatic continuation admission is missing`);
        }
        assert.equal(admissions[0]!.execution.sourceRunId, source.sourceRunId);

        const secondHost = await fixture.startHost(undefined, false, {
          packagedResourcesRoot: resourcesRoot,
          runtimeExecutablePath,
          providerCallLogPath: callLog,
        });
        const secondClient = await connectClient(fixture.root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 250));
          assert.equal(await providerCallCount(callLog), 1);
          assert.equal(
            (await fixture.readAdmissionChain()).filter(
              (candidate) => candidate.execution.kind === 'safe_boundary_continuation',
            ).length,
            1,
          );
          assert.deepEqual(
            await secondClient.request('turn.resume.query', {
              sessionId: fixture.sessionId,
              sourceRunId: source.sourceRunId,
              expectedRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
            }),
            {
              sessionId: fixture.sessionId,
              disposition: 'parked',
              reason: 'continuation_started_indeterminate',
            },
          );
        } finally {
          await secondClient.close();
          await fixture.stopHost(secondHost);
        }
      },
      { sourceKind },
    );
  });
}

async function withManagedContinuationFixture(
  helperInputPath: string,
  run: (input: {
    fixture: ExecutionFixture;
    resourcesRoot: string;
    runtimeExecutablePath: string;
    callLog: string;
    sourceKind: 'git_repository_v1' | 'filesystem_snapshot_v1';
    boundary: NonNullable<
      Awaited<ReturnType<typeof inspectGitoxideManagedContinuationBoundaryInternal>>
    >;
  }) => Promise<void>,
  options: {
    readonly sourceKind?: 'git_repository_v1' | 'filesystem_snapshot_v1';
  } = {},
): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-continuation-')));
  const root = join(base, 'root');
  const sourceRoot = join(base, 'source');
  const callLog = join(base, 'provider-calls.log');
  await Promise.all([mkdir(root), mkdir(sourceRoot)]);
  await writeFile(callLog, '', 'utf8');
  await writeFile(join(sourceRoot, 'notes.txt'), 'baseline\n', 'utf8');
  if (options.sourceKind !== 'filesystem_snapshot_v1') {
    git(sourceRoot, ['init', '--quiet', '--object-format=sha1']);
    git(sourceRoot, ['add', 'notes.txt']);
    git(sourceRoot, [
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=maka@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'baseline',
    ]);
  }
  await resolveWorkspaceIdentity({ path: sourceRoot });

  const runtimeExecutablePath = resolveElectronExecutable();
  const resourcesRoot = await preparePackagedResources(
    base,
    helperInputPath,
    runtimeExecutablePath,
  );
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to own managed continuation fixture root');
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  let sessionId: string;
  let boundary: NonNullable<
    Awaited<ReturnType<typeof inspectGitoxideManagedContinuationBoundaryInternal>>
  >;
  try {
    const session = await stores.sessionStore.create({
      cwd: sourceRoot,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      toolProfile: 'managed-coding-v2',
    });
    sessionId = session.id;
    const helper = await admitRealHelper(helperInputPath);
    const sessionInput = {
      storageRootLease: owner.lease,
      stores,
      sourceRoot,
      sessionId,
      ...helper,
    };
    const opened = await openGitoxideManagedSessionOwnerInternal(sessionInput);
    assert.equal(opened.sourceKind, options.sourceKind ?? 'git_repository_v1');
    const observedBoundary = await inspectGitoxideManagedContinuationBoundaryInternal(sessionInput);
    assert.ok(observedBoundary);
    boundary = observedBoundary;
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
  }

  const fixture = new ExecutionFixture(base, root, capability, sessionId, sourceRoot);
  try {
    await run({
      fixture,
      resourcesRoot,
      runtimeExecutablePath,
      callLog,
      sourceKind: options.sourceKind ?? 'git_repository_v1',
      boundary: boundary!,
    });
  } finally {
    await fixture.close();
  }
}

async function preparePackagedResources(
  base: string,
  helperInputPath: string,
  runtimeExecutablePath: string,
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
      supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
      distributionReady: true,
    })}\n`,
    'utf8',
  );

  const commandRoot = join(resourcesRoot, 'managed-command');
  const entrypointPath = join(commandRoot, 'managed-command-helper-main.js');
  await mkdir(commandRoot);
  await copyFile(
    resolve(import.meta.dirname, '..', 'server', 'managed-command-helper-main.js'),
    entrypointPath,
  );
  const entrypoint = await readFile(entrypointPath);
  const nodeVersion = execFileSync(runtimeExecutablePath, ['-p', 'process.versions.node'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  await writeFile(
    join(resourcesRoot, 'managed-command-toolchain.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      protocol: 'maka_managed_command_toolchain_release_v2',
      provider: 'maka/managed-command-toolchain',
      platform: process.platform,
      arch: process.arch,
      nodeVersion,
      profileVersion: 1,
      entrypointRelativePath: 'managed-command/managed-command-helper-main.js',
      entrypointBytes: (await stat(entrypointPath)).size,
      entrypointSha256: `sha256:${createHash('sha256').update(entrypoint).digest('hex')}`,
      allowedEffectClasses: ['hermetic_observation_v2', 'workspace_transform_v1'],
      distributionReady: true,
    })}\n`,
    'utf8',
  );
  return resourcesRoot;
}

function resolveElectronExecutable(): string {
  const distributionRoot = resolve(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return join(distributionRoot, 'electron.exe');
  if (process.platform === 'darwin') {
    return join(distributionRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  return join(distributionRoot, 'electron');
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
    supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
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

function waitForProviderFailpoint(child: ChildProcess): Promise<void> {
  return waitForChildMessage(child, 'test.provider_failpoint', 'provider');
}

function waitForChildMessage(
  child: ChildProcess,
  expectedType: string,
  label: string,
): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown): void => {
        if (
          message &&
          typeof message === 'object' &&
          (message as { type?: unknown }).type === expectedType
        ) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(`Runtime Host exited before ${label} failpoint: ${code ?? signal}`));
      };
      const cleanup = (): void => {
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.on('exit', onExit);
    }),
    PROCESS_TIMEOUT_MS * 3,
    `Runtime Host did not reach the ${label} failpoint`,
  );
}

async function providerCallCount(path: string): Promise<number> {
  return (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean).length;
}

async function waitForProviderCalls(path: string, expected: number): Promise<void> {
  await withTimeout(
    (async () => {
      while ((await providerCallCount(path)) < expected) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })(),
    PROCESS_TIMEOUT_MS,
    `provider call count did not reach ${expected}`,
  );
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
