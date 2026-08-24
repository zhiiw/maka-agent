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
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { requireExecutionStoresWorkspaceMutationAuthorityInternal } from '@maka/storage/execution-stores-workspace-authority-internal';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import { openGitoxideManagedMutationSession } from '../server/gitoxide-managed-mutation-session.js';

test('opens one durable Gitoxide baseline and exactly reuses it for the session', async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper session test');
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-session-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  git(root, ['init', '--quiet', '--object-format=sha1', sourceRoot]);
  await writeFile(join(sourceRoot, 'notes.txt'), 'baseline\n');
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
  const storageCapability = await resolveStorageRoot({
    path: join(root, 'storage'),
    kind: 'interactive',
  });
  const storageOwner = await tryAcquireInteractiveRootOwner(storageCapability);
  assert.ok(storageOwner);
  if (!storageOwner) return;
  const stores = await openInteractiveExecutionStoresForWrite(storageOwner.lease);
  try {
    const helperBytes = await readFile(await realpath(helperPath));
    const helperInfo = await stat(await realpath(helperPath));
    const releaseOwnerToken = {};
    const invocationOwnerToken = {};
    const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
      executablePath: await realpath(helperPath),
      expectedSha256: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`,
      expectedBytes: helperInfo.size,
      platform: process.platform,
      arch: process.arch,
      protocolVersion: 1,
    });
    const helperCapability = await admitGitoxideHelperArtifactInternal({
      releaseOwnerToken,
      invocationOwnerToken,
      claim,
    });
    const input = {
      storageRootLease: storageOwner.lease,
      sourceRoot,
      sessionId: 'session-gitoxide-managed-1',
      invocationOwnerToken,
      helperCapability,
      settlementAuthority: requireExecutionStoresWorkspaceMutationAuthorityInternal(stores),
    };

    const first = await openGitoxideManagedMutationSession(input);
    const reopened = await openGitoxideManagedMutationSession(input);

    assert.deepEqual(reopened.head, first.head);
    assert.equal(first.head.revision, 1);
    assert.notEqual(first.head.commitOid, git(sourceRoot, ['rev-parse', 'HEAD']));
    assert.equal(first.head.treeOid, git(sourceRoot, ['rev-parse', 'HEAD^{tree}']));

    const changed = await executeManagedWrite({
      stores,
      session: reopened,
      operationId: 'operation-gitoxide-write-1',
      content: 'after\n',
      changed: true,
    });
    assert.equal(changed.kind, 'workspace_successor_committed');
    const afterChange = await openGitoxideManagedMutationSession(input);
    assert.equal(afterChange.head.revision, 2);
    assert.notEqual(afterChange.head.commitOid, first.head.commitOid);

    const noChange = await executeManagedWrite({
      stores,
      session: afterChange,
      operationId: 'operation-gitoxide-write-noop',
      content: 'after\n',
      changed: false,
    });
    assert.equal(noChange.kind, 'no_workspace_change_committed');
    const afterNoChange = await openGitoxideManagedMutationSession(input);
    assert.deepEqual(afterNoChange.head, afterChange.head);
  } finally {
    await stores.sessionStore.close?.();
    await storageOwner.close();
  }
});

test('reopens after process death between successor acceptance and Git ref promotion', async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper crash test');
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-session-crash-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const storageRoot = join(root, 'storage');
  const readyPath = join(root, 'successor-committed');
  const childInputPath = join(root, 'child-input.json');
  const sessionId = 'session-gitoxide-managed-crash';
  await mkdir(sourceRoot);
  git(root, ['init', '--quiet', '--object-format=sha1', sourceRoot]);
  await writeFile(join(sourceRoot, 'notes.txt'), 'baseline\n');
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

  const initialStorage = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const initialOwner = await tryAcquireInteractiveRootOwner(initialStorage);
  assert.ok(initialOwner);
  if (!initialOwner) return;
  const initialStores = await openInteractiveExecutionStoresForWrite(initialOwner.lease);
  const initialHelper = await admitRealHelper(helperPath);
  try {
    const initial = await openGitoxideManagedMutationSession({
      storageRootLease: initialOwner.lease,
      sourceRoot,
      sessionId,
      ...initialHelper,
      settlementAuthority: requireExecutionStoresWorkspaceMutationAuthorityInternal(initialStores),
    });
    assert.equal(initial.head.revision, 1);
  } finally {
    await initialStores.sessionStore.close?.();
    await initialOwner.close();
  }

  await writeFile(
    childInputPath,
    JSON.stringify({ helperPath, storageRoot, sourceRoot, sessionId, readyPath }),
    'utf8',
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL('./fixtures/gitoxide-managed-mutation-session-crash-child.js', import.meta.url),
      ),
      childInputPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  try {
    await waitForPath(readyPath, child, stdout, stderr);
    child.kill('SIGKILL');
    await waitForExit(child);

    const reopenedStorage = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
    const reopenedOwner = await tryAcquireInteractiveRootOwner(reopenedStorage);
    assert.ok(reopenedOwner);
    if (!reopenedOwner) return;
    const reopenedStores = await openInteractiveExecutionStoresForWrite(reopenedOwner.lease);
    const reopenedHelper = await admitRealHelper(helperPath);
    try {
      const reopened = await openGitoxideManagedMutationSession({
        storageRootLease: reopenedOwner.lease,
        sourceRoot,
        sessionId,
        ...reopenedHelper,
        settlementAuthority:
          requireExecutionStoresWorkspaceMutationAuthorityInternal(reopenedStores),
      });
      assert.equal(reopened.head.revision, 2);
      const exactRetry = await openGitoxideManagedMutationSession({
        storageRootLease: reopenedOwner.lease,
        sourceRoot,
        sessionId,
        ...reopenedHelper,
        settlementAuthority:
          requireExecutionStoresWorkspaceMutationAuthorityInternal(reopenedStores),
      });
      assert.deepEqual(exactRetry.head, reopened.head);
    } finally {
      await reopenedStores.sessionStore.close?.();
      await reopenedOwner.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

async function executeManagedWrite(input: {
  readonly stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
  readonly session: Awaited<ReturnType<typeof openGitoxideManagedMutationSession>>;
  readonly operationId: string;
  readonly content: string;
  readonly changed: boolean;
}) {
  const toolCallId = `${input.operationId}-call`;
  const args = { path: 'notes.txt', content: input.content };
  const admission = await input.session.admitManagedMutation({
    operationId: input.operationId,
    toolName: 'Write',
    persistedArgs: args,
    abortSignal: new AbortController().signal,
  });
  const identity = {
    sessionId: 'session-gitoxide-managed-1',
    invocationId: `invocation-${input.operationId}`,
    runId: `run-${input.operationId}`,
    turnId: `turn-${input.operationId}`,
  };
  const callEvent: RuntimeEvent = {
    id: `${input.operationId}-call-event`,
    ...identity,
    ts: 10,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: toolCallId, name: 'Write', args },
    refs: { operationId: input.operationId, toolCallId },
  };
  const dispatchEvent: RuntimeEvent = {
    id: `${input.operationId}_dispatch`,
    ...identity,
    ts: 10,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: input.operationId,
        providerToolCallId: toolCallId,
        toolName: 'Write',
        canonicalArgsHash: canonicalToolArgsHash('Write', args),
        recoveryMode: 'reconcile',
        managedMutation: admission.durableDispatch,
      },
    },
    refs: { operationId: input.operationId, toolCallId },
  };
  await input.stores.runtimeEventStore.commitToolPrepared({
    operationId: input.operationId,
    journalEventId: `${input.operationId}_prepared`,
    runtimeEvent: callEvent,
    dispatchRuntimeEvent: dispatchEvent,
    providerToolCallId: toolCallId,
    toolName: 'Write',
    canonicalArgsHash: canonicalToolArgsHash('Write', args),
    recoveryMode: 'reconcile',
    committedAt: 10,
  });
  const providerResult = { kind: 'file_write', path: 'notes.txt', bytes: input.content.length };
  const resultContent = { kind: 'json' as const, value: providerResult };
  const outcome: RuntimeEvent = {
    id: `${input.operationId}-outcome-event`,
    ...identity,
    ts: 11,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: toolCallId,
      name: 'Write',
      result: resultContent,
    },
    refs: { operationId: input.operationId, toolCallId },
    actions: { stateDelta: { durationMs: 1 } },
  };
  return admission.execute(async () => ({
    content: resultContent,
    isError: false,
    durationMs: 1,
    durableOutcome: outcome,
    managedMutationResult: {
      canonicalPath: 'notes.txt',
      content: input.content,
      changed: input.changed,
    },
  }));
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function admitRealHelper(helperPath: string) {
  const executablePath = await realpath(helperPath);
  const [helperBytes, helperInfo] = await Promise.all([
    readFile(executablePath),
    stat(executablePath),
  ]);
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath,
    expectedSha256: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`,
    expectedBytes: helperInfo.size,
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

async function waitForPath(
  path: string,
  child: ChildProcess,
  stdout: readonly Buffer[],
  stderr: readonly Buffer[],
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Crash fixture exited before successor commit: ${Buffer.concat(stdout).toString('utf8')} ${Buffer.concat(stderr).toString('utf8')}`,
        );
      }
      await delay(50);
    }
  }
  throw new Error('Timed out waiting for the durable successor crash boundary');
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(10_000).then(() => {
      throw new Error('Timed out waiting for crash fixture exit');
    }),
  ]);
}
