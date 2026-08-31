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
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGitoxideManagedGcOwnerInternal } from '../server/gitoxide-managed-gc-owner-internal.js';
import {
  admitGitoxideHelperArtifactInternal,
  GITOXIDE_HELPER_OPERATIONS_INTERNAL,
  type GitoxideHelperInvocationCapability,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import { gitoxideMutationCandidateReceiptRootInternal } from '../server/gitoxide-mutation-candidate-receipt-authority-internal.js';

test('collects only expired restore orphans and converges interrupted tombstones', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-gc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epoch = 'epoch_gc';
  const orphans = join(root, 'gitoxide-managed-restores', epoch, 'orphans');
  const expired = join(orphans, 'expired');
  const retained = join(orphans, 'retained');
  const interrupted = join(orphans, '.gc-interrupted');
  for (const path of [expired, retained, interrupted]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'content.txt'), path, 'utf8');
  }
  await utimes(expired, 1, 1);
  const owner = createGitoxideManagedGcOwnerInternal({
    storageRoot: root,
    workspaceEpochId: epoch,
    now: () => 10_000,
  });

  assert.deepEqual(await owner.collectRestoreOrphans({ olderThanMs: 5_000, maxEntries: 8 }), {
    protocol: 'gitoxide_managed_gc_v1',
    collected: 2,
    retained: 1,
  });
  assert.deepEqual(await readdir(orphans), ['retained']);
});

test('a new process converges an orphan after the collector is killed post-rename', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-gc-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epoch = 'epoch_gc_crash';
  const orphans = join(root, 'gitoxide-managed-restores', epoch, 'orphans');
  const expired = join(orphans, 'expired');
  await mkdir(expired, { recursive: true });
  await writeFile(join(expired, 'content.txt'), 'recover me\n', 'utf8');
  await utimes(expired, 1, 1);
  const fixturePath = join(root, 'gc-crash-fixture.json');
  await writeFile(fixturePath, `${JSON.stringify({ root, epoch })}\n`, 'utf8');

  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, 'fixtures', 'gitoxide-managed-gc-crash-child.js'), fixturePath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [exitCode] = (await once(child, 'exit')) as [number | null];
  assert.equal(exitCode, 76, Buffer.concat(stderr).toString('utf8'));
  assert.equal((await readdir(orphans)).length, 1);
  assert.match((await readdir(orphans))[0] ?? '', /^\.gc-/u);

  const recovered = createGitoxideManagedGcOwnerInternal({
    storageRoot: root,
    workspaceEpochId: epoch,
  });
  assert.deepEqual(await recovered.collectRestoreOrphans({ olderThanMs: 60_000, maxEntries: 8 }), {
    protocol: 'gitoxide_managed_gc_v1',
    collected: 1,
    retained: 0,
  });
  assert.deepEqual(await readdir(orphans), []);
});

test('retires only expired mutation candidates outside durable retention roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-candidate-gc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceId = `workspace_${'1'.repeat(32)}`;
  const workspaceEpochId = `epoch_${'2'.repeat(32)}`;
  const candidateRoot = gitoxideMutationCandidateReceiptRootInternal(root, {
    workspaceId,
    workspaceEpochId,
  });
  await mkdir(candidateRoot, { recursive: true });
  const protectedOperation = operationIdentity('protected-operation');
  const obsoleteOperation = operationIdentity('obsolete-operation');
  await writeCandidateReceipt(candidateRoot, workspaceId, workspaceEpochId, protectedOperation);
  await writeCandidateReceipt(candidateRoot, workspaceId, workspaceEpochId, obsoleteOperation);
  for (const name of await readdir(candidateRoot)) await utimes(join(candidateRoot, name), 1, 1);
  const retired: string[] = [];
  const owner = createGitoxideManagedGcOwnerInternal({
    storageRoot: root,
    workspaceId,
    workspaceEpochId,
    repositoryPath: join(root, 'managed.git'),
    invocationOwnerToken: {},
    helperCapability: {} as GitoxideHelperInvocationCapability,
    readCandidateRetentionRoots: async () => ({
      acceptedCommitOid: 'a'.repeat(40),
      protectedOperationIdentitySha256: [protectedOperation],
    }),
    retireCandidateRef: async (input) => {
      retired.push(input.candidateRef);
      return {
        kind: 'candidate_ref_retired',
        protocolVersion: 1,
        objectFormat: 'sha1',
        acceptedCommitOid: input.expectedAcceptedCommitOid,
        candidateCommitOid: input.expectedCandidateCommitOid,
        acceptedRef: input.acceptedRef,
        candidateRef: input.candidateRef,
        replayed: false,
        managedTreePolicyVersion: 3,
      };
    },
    now: () => 10_000,
  });

  assert.deepEqual(await owner.collectMutationCandidates({ olderThanMs: 5_000, maxEntries: 8 }), {
    protocol: 'gitoxide_managed_gc_v1',
    collected: 1,
    retained: 1,
  });
  assert.deepEqual(retired, [`refs/maka/candidates/${obsoleteOperation.slice(7)}`]);
  assert.deepEqual(await readdir(candidateRoot), [`${protectedOperation.slice(7)}.json`]);
});

test('a new process converges a receipt after exact candidate-ref retirement', async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for candidate GC crash recovery');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-candidate-gc-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const repositoryPath = join(root, 'managed.git');
  await mkdir(source);
  execFileSync('git', ['-C', source, 'init', '--quiet', '--object-format=sha1']);
  await writeFile(join(source, 'notes.txt'), 'accepted\n', 'utf8');
  execFileSync('git', ['-C', source, 'add', 'notes.txt']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'accepted',
  ]);
  execFileSync('git', ['clone', '--quiet', '--bare', source, repositoryPath]);
  const acceptedCommitOid = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const operation = operationIdentity('crash-operation');
  const candidateRef = `refs/maka/candidates/${operation.slice(7)}`;
  execFileSync('git', [
    '--git-dir',
    repositoryPath,
    'update-ref',
    'refs/maka/accepted',
    acceptedCommitOid,
  ]);
  execFileSync('git', ['--git-dir', repositoryPath, 'update-ref', candidateRef, acceptedCommitOid]);
  const workspaceId = `workspace_${'5'.repeat(32)}`;
  const workspaceEpochId = `epoch_${'6'.repeat(32)}`;
  const candidateRoot = gitoxideMutationCandidateReceiptRootInternal(root, {
    workspaceId,
    workspaceEpochId,
  });
  await mkdir(candidateRoot, { recursive: true });
  await writeCandidateReceipt(
    candidateRoot,
    workspaceId,
    workspaceEpochId,
    operation,
    acceptedCommitOid,
  );
  const fixturePath = join(root, 'candidate-gc-crash.json');
  await writeFile(
    fixturePath,
    `${JSON.stringify({
      storageRoot: root,
      workspaceId,
      workspaceEpochId,
      repositoryPath,
      acceptedCommitOid,
      helperPath,
    })}\n`,
    'utf8',
  );
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dirname, 'fixtures', 'gitoxide-managed-candidate-gc-crash-child.js'),
      fixturePath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [exitCode] = (await once(child, 'exit')) as [number | null];
  assert.equal(exitCode, 80, Buffer.concat(stderr).toString('utf8'));
  assert.throws(() =>
    execFileSync('git', ['--git-dir', repositoryPath, 'show-ref', '--verify', candidateRef]),
  );
  assert.deepEqual(await readdir(candidateRoot), [`${operation.slice(7)}.json`]);

  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const helperBytes = await readFile(helperPath);
  const helperInfo = await stat(helperPath);
  const helperCapability = await admitGitoxideHelperArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim: issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
      executablePath: await realpath(helperPath),
      expectedSha256: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`,
      expectedBytes: helperInfo.size,
      platform: process.platform,
      arch: process.arch,
      protocolVersion: 1,
      supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
    }),
  });
  const recovered = createGitoxideManagedGcOwnerInternal({
    storageRoot: root,
    workspaceId,
    workspaceEpochId,
    repositoryPath,
    invocationOwnerToken,
    helperCapability,
    readCandidateRetentionRoots: async () => ({
      acceptedCommitOid,
      protectedOperationIdentitySha256: [],
    }),
  });
  assert.deepEqual(await recovered.collectMutationCandidates({ olderThanMs: 0, maxEntries: 1 }), {
    protocol: 'gitoxide_managed_gc_v1',
    collected: 1,
    retained: 0,
  });
  assert.deepEqual(await readdir(candidateRoot), []);
});

function operationIdentity(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

async function writeCandidateReceipt(
  root: string,
  workspaceId: string,
  workspaceEpochId: string,
  operationIdentitySha256: `sha256:${string}`,
  candidateCommitOid = 'f'.repeat(40),
): Promise<void> {
  const digest = operationIdentitySha256.slice(7);
  await writeFile(
    join(root, `${digest}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      protocol: 'maka_gitoxide_candidate_receipt_v1',
      repositoryId: `repository_${'3'.repeat(32)}`,
      workspaceId,
      workspaceEpochId,
      workspaceVersionId: `version_${'4'.repeat(32)}`,
      baseAcceptedEventId: 'accepted-event',
      baseHeadRevision: 1,
      baseCommitOid: 'b'.repeat(40),
      baseTreeOid: 'c'.repeat(40),
      objectFormat: 'sha1',
      operationIdentitySha256,
      acceptedRef: 'refs/maka/accepted',
      disposition: 'published',
      helperArtifactSha256: `sha256:${'d'.repeat(64)}`,
      managedTreePolicyVersion: 3,
      requestDigestSha256: 'e'.repeat(64),
      candidateRef: `refs/maka/candidates/${digest}`,
      candidateCommitOid,
      candidateTreeOid: '1'.repeat(40),
      resultBlobOid: '2'.repeat(40),
      path: 'notes.txt',
      contentSha256: `sha256:${'3'.repeat(64)}`,
      executionProfileDigest: `sha256:${'4'.repeat(64)}`,
    })}\n`,
    'utf8',
  );
}
