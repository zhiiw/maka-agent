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
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  type GitoxideHelperInvocationCapability,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import { openGitoxideManagedSessionOwnerInternal } from '../server/gitoxide-managed-session-owner-internal.js';

test('opens one durable Gitoxide baseline and reuses it for the same session', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real session owner test');
    return;
  }
  const sourceRoot = await createRepository(t);
  await writeFile(join(sourceRoot, 'notes.txt'), 'before\n', 'utf8');
  git(sourceRoot, ['add', 'notes.txt']);
  commit(sourceRoot, 'baseline');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-session-owner-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  t.after(() => rootOwner.close());
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  t.after(() => stores.sessionStore.close?.());

  const first = await openGitoxideManagedSessionOwnerInternal({
    storageRootLease: rootOwner.lease,
    stores,
    ...helper,
    sourceRoot,
    sessionId: 'session-managed-owner',
  });
  const retry = await openGitoxideManagedSessionOwnerInternal({
    storageRootLease: rootOwner.lease,
    stores,
    ...helper,
    sourceRoot,
    sessionId: 'session-managed-owner',
  });
  assert.equal(retry.repositoryPath, first.repositoryPath);
  assert.equal(retry.workspaceEpochId, first.workspaceEpochId);
  const admission = await retry.writeEdit.admitManagedMutation({
    operationId: 'operation-session-read',
    toolName: 'Write',
    persistedArgs: { path: 'notes.txt', content: 'after\n' },
    abortSignal: new AbortController().signal,
  });
  assert.deepEqual(admission.immutableBase, { content: 'before\n' });
});

test('Read, Glob, and Grep observe only the accepted managed tree', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the accepted inspection test');
    return;
  }
  const sourceRoot = await createRepository(t);
  await writeFile(join(sourceRoot, 'notes.txt'), 'durable accepted line\n', 'utf8');
  await writeFile(join(sourceRoot, 'worker.ts'), 'export const durableWorker = true;\n', 'utf8');
  git(sourceRoot, ['add', 'notes.txt', 'worker.ts']);
  commit(sourceRoot, 'accepted inspection baseline');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-inspection-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  t.after(() => rootOwner.close());
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  t.after(() => stores.sessionStore.close?.());
  const session = await openGitoxideManagedSessionOwnerInternal({
    storageRootLease: rootOwner.lease,
    stores,
    ...helper,
    sourceRoot,
    sessionId: 'session-accepted-inspection',
  });

  await writeFile(join(sourceRoot, 'notes.txt'), 'attached checkout drift\n', 'utf8');
  await writeFile(join(sourceRoot, 'untracked.ts'), 'durable but not accepted\n', 'utf8');

  assert.deepEqual(
    await session.inspection.execute({ kind: 'read', path: 'notes.txt' }),
    { kind: 'read', content: 'durable accepted line\n' },
  );
  assert.deepEqual(
    await session.inspection.execute({ kind: 'glob', path: '.', pattern: '**/*.ts', limit: 200 }),
    { kind: 'glob', files: ['worker.ts'] },
  );
  assert.deepEqual(
    await session.inspection.execute({
      kind: 'grep',
      path: '.',
      pattern: 'durable(?:Worker)?',
      glob: '**/*',
      maxCountPerFile: 10,
      limit: 200,
      timeoutMs: 10_000,
    }),
    {
      kind: 'grep',
      matches: [
        'notes.txt:1:durable accepted line',
        'worker.ts:1:export const durableWorker = true;',
      ],
    },
  );
});

test('fails closed when the source advances after its managed epoch opens', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the source drift test');
    return;
  }
  const sourceRoot = await createRepository(t);
  await writeFile(join(sourceRoot, 'notes.txt'), 'before\n', 'utf8');
  git(sourceRoot, ['add', 'notes.txt']);
  commit(sourceRoot, 'baseline');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-session-drift-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  t.after(() => rootOwner.close());
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  t.after(() => stores.sessionStore.close?.());
  const common = {
    storageRootLease: rootOwner.lease,
    stores,
    ...helper,
    sourceRoot,
    sessionId: 'session-managed-drift',
  } as const;
  await openGitoxideManagedSessionOwnerInternal(common);
  await writeFile(join(sourceRoot, 'notes.txt'), 'source advanced\n', 'utf8');
  git(sourceRoot, ['add', 'notes.txt']);
  commit(sourceRoot, 'advance');
  await assert.rejects(
    openGitoxideManagedSessionOwnerInternal(common),
    /source or durable epoch has drifted/i,
  );
});

test('retries an exact import after the publishing process exits before baseline commit', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the baseline crash test');
    return;
  }
  const sourceRoot = await createRepository(t);
  await writeFile(join(sourceRoot, 'notes.txt'), 'before\n', 'utf8');
  git(sourceRoot, ['add', 'notes.txt']);
  commit(sourceRoot, 'baseline');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-session-crash-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await resolveStorageRoot({ path: root, kind: 'interactive' });
  const fixturePath = join(root, 'managed-session-crash-fixture.json');
  await writeFile(
    fixturePath,
    `${JSON.stringify({
      storageRoot: root,
      sourceRoot,
      sessionId: 'session-managed-crash',
      helperPath: helper.helperPath,
    })}\n`,
    'utf8',
  );
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dirname, 'fixtures', 'gitoxide-managed-session-owner-crash-child.js'),
      fixturePath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [exitCode] = (await once(child, 'exit')) as [number | null];
  assert.equal(exitCode, 74, Buffer.concat(stderr).toString('utf8'));

  const rootCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  t.after(() => rootOwner.close());
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  t.after(() => stores.sessionStore.close?.());
  const recovered = await openGitoxideManagedSessionOwnerInternal({
    storageRootLease: rootOwner.lease,
    stores,
    invocationOwnerToken: helper.invocationOwnerToken,
    helperCapability: helper.helperCapability,
    sourceRoot,
    sessionId: 'session-managed-crash',
  });
  const admission = await recovered.writeEdit.admitManagedMutation({
    operationId: 'operation-after-baseline-recovery',
    toolName: 'Write',
    persistedArgs: { path: 'notes.txt', content: 'after\n' },
    abortSignal: new AbortController().signal,
  });
  assert.deepEqual(admission.immutableBase, { content: 'before\n' });
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
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath: helperPath,
    expectedSha256: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`,
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
      'list_tree_files',
      'grep_tree_files',
    ],
  });
  return {
    invocationOwnerToken,
    helperPath,
    helperCapability: await admitGitoxideHelperArtifactInternal({
      releaseOwnerToken,
      invocationOwnerToken,
      claim,
    }),
  };
}

async function createRepository(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-session-source-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  git(path, ['init', '--quiet', '--object-format=sha1']);
  return path;
}

function commit(cwd: string, message: string): void {
  git(cwd, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
