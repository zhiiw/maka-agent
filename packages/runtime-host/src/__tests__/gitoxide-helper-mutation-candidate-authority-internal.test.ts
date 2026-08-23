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
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WorkspaceHeadRecordV1 } from '@maka/core/workspace-version-authority';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  type GitoxideHelperInvocationCapability,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  createGitoxideMutationCandidateAuthorityInternal,
  gitoxideManagedRepositoryPathInternal,
  gitoxideMutationCandidateReceiptRootInternal,
  GitoxideMutationCandidateAuthorityError,
} from '../server/gitoxide-helper-mutation-candidate-authority-internal.js';
import {
  admitGitoxideRepositoryInternal,
  importAdmittedGitoxideRepositoryInternal,
} from '../server/gitoxide-repository-admission-authority-internal.js';

interface AdmittedHelper {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
}

let admittedHelperPromise: Promise<AdmittedHelper | undefined> | undefined;

test('rejects candidate authority creation after its storage-root lease closes', async (t) => {
  const fixture = await candidateFixture(t);
  if (!fixture) return;
  await fixture.rootOwner.close();

  await assert.rejects(
    createGitoxideMutationCandidateAuthorityInternal({
      ...fixture.helper,
      storageRootLease: fixture.rootOwner.lease,
      baseHead: fixture.baseHead,
    }),
    (error) => error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
  );
});

test('persists and revalidates an exact Gitoxide candidate without advancing accepted truth', async (t) => {
  const fixture = await candidateFixture(t);
  if (!fixture) return;
  const authority = await createGitoxideMutationCandidateAuthorityInternal({
    ...fixture.helper,
    storageRootLease: fixture.rootOwner.lease,
    baseHead: fixture.baseHead,
  });
  const input = {
    operationId: 'operation-candidate-1',
    path: 'docs/result.txt',
    content: 'candidate result\n',
    executionProfileDigest: `sha256:${'a'.repeat(64)}` as const,
  };

  const first = await authority.capture(input);
  assert.equal(
    gitBare(fixture.repositoryPath, ['rev-parse', 'refs/maka/accepted']),
    fixture.baseHead.commitOid,
  );
  assert.equal(
    gitBare(fixture.repositoryPath, ['rev-parse', first.receipt.candidateRef]),
    first.receipt.candidateCommitOid,
  );

  const reopened = await createGitoxideMutationCandidateAuthorityInternal({
    ...fixture.helper,
    storageRootLease: fixture.rootOwner.lease,
    baseHead: fixture.baseHead,
  });
  const retry = await reopened.capture(input);
  assert.deepEqual(retry.receipt, first.receipt);
  assert.notEqual(retry.candidateCapability, first.candidateCapability);
});

test('rejects a candidate proof whose receipt was recomposed around a valid capability', async (t) => {
  const fixture = await candidateFixture(t);
  if (!fixture) return;
  const authority = await createGitoxideMutationCandidateAuthorityInternal({
    ...fixture.helper,
    storageRootLease: fixture.rootOwner.lease,
    baseHead: fixture.baseHead,
  });
  const proof = await authority.capture({
    operationId: 'operation-recomposed-proof-1',
    path: 'docs/result.txt',
    content: 'candidate result\n',
    executionProfileDigest: `sha256:${'a'.repeat(64)}`,
  });

  assert.throws(
    () =>
      authority.validate({
        candidateCapability: proof.candidateCapability,
        receipt: { ...proof.receipt, repositoryId: 'forged-repository' },
      }),
    (error) =>
      error instanceof GitoxideMutationCandidateAuthorityError &&
      error.code === 'gitoxide_mutation_candidate_identity_conflict',
  );
});

test('promotes an exact candidate only after the caller presents its owner-bound proof', async (t) => {
  const fixture = await candidateFixture(t);
  if (!fixture) return;
  const authority = await createGitoxideMutationCandidateAuthorityInternal({
    ...fixture.helper,
    storageRootLease: fixture.rootOwner.lease,
    baseHead: fixture.baseHead,
  });
  const proof = await authority.capture({
    operationId: 'operation-promote-1',
    path: 'docs/promoted.txt',
    content: 'promoted result\n',
    executionProfileDigest: `sha256:${'b'.repeat(64)}`,
  });

  await authority.promote(proof);
  assert.equal(
    gitBare(fixture.repositoryPath, ['rev-parse', 'refs/maka/accepted']),
    proof.receipt.candidateCommitOid,
  );
  await authority.promote(proof);
});

test('replays promotion from the strict durable receipt without recreating the mutation', async (t) => {
  const fixture = await candidateFixture(t);
  if (!fixture) return;
  const operationId = 'operation-durable-promote-1';
  const authority = await createGitoxideMutationCandidateAuthorityInternal({
    ...fixture.helper,
    storageRoot: fixture.storageRoot,
    baseHead: fixture.baseHead,
  });
  const proof = await authority.capture({
    operationId,
    path: 'docs/recovered.txt',
    content: 'recovered result\n',
    executionProfileDigest: `sha256:${'c'.repeat(64)}`,
  });
  const reopened = await createGitoxideMutationCandidateAuthorityInternal({
    ...fixture.helper,
    storageRoot: fixture.storageRoot,
    baseHead: fixture.baseHead,
  });

  const receipt = await reopened.promoteDurable(operationId);

  assert.deepEqual(receipt, proof.receipt);
  assert.equal(
    gitBare(fixture.repositoryPath, ['rev-parse', 'refs/maka/accepted']),
    proof.receipt.candidateCommitOid,
  );
});

test('converges when execution stops after candidate ref publication and rejects receipt tampering', async (t) => {
  const fixture = await candidateFixture(t);
  if (!fixture) return;
  let stopped = false;
  const interrupted = await createGitoxideMutationCandidateAuthorityInternal({
    ...fixture.helper,
    storageRootLease: fixture.rootOwner.lease,
    baseHead: fixture.baseHead,
    failpoint(point) {
      if (point === 'after_candidate_ref' && !stopped) {
        stopped = true;
        throw new Error('simulated stop after candidate ref');
      }
    },
  });
  const input = {
    operationId: 'operation-crash-1',
    path: 'nested/result.txt',
    content: 'crash-safe candidate\n',
    executionProfileDigest: `sha256:${'b'.repeat(64)}` as const,
  };
  await assert.rejects(interrupted.capture(input), /simulated stop/u);

  const reopened = await createGitoxideMutationCandidateAuthorityInternal({
    ...fixture.helper,
    storageRootLease: fixture.rootOwner.lease,
    baseHead: fixture.baseHead,
  });
  const recovered = await reopened.capture(input);
  assert.equal(
    gitBare(fixture.repositoryPath, ['rev-parse', recovered.receipt.candidateRef]),
    recovered.receipt.candidateCommitOid,
  );

  const receiptRoot = gitoxideMutationCandidateReceiptRootInternal(
    fixture.storageRoot,
    fixture.baseHead,
  );
  const [receiptName] = (await readdir(receiptRoot)).filter((name) => name.endsWith('.json'));
  assert.ok(receiptName);
  const receiptPath = join(receiptRoot, receiptName);
  const tampered = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
  tampered.candidateTreeOid = 'f'.repeat(40);
  await writeFile(receiptPath, `${JSON.stringify(tampered)}\n`, 'utf8');
  await assert.rejects(
    reopened.capture(input),
    (error) =>
      error instanceof GitoxideMutationCandidateAuthorityError &&
      error.code === 'gitoxide_mutation_candidate_identity_conflict',
  );
});

test('reopens and completes a candidate after the owner process is killed post-ref', async (t) => {
  const fixture = await candidateFixture(t);
  if (!fixture) return;
  const input = {
    operationId: 'operation-process-crash-1',
    path: 'process/result.txt',
    content: 'process crash candidate\n',
    executionProfileDigest: `sha256:${'c'.repeat(64)}` as const,
  };
  const readyPath = join(dirname(fixture.storageRoot), 'candidate-ready');
  const inputPath = join(dirname(fixture.storageRoot), 'candidate-crash-input.json');
  await writeFile(
    inputPath,
    JSON.stringify({
      helperPath: process.env.MAKA_GITOXIDE_HELPER_PATH,
      storageRoot: fixture.storageRoot,
      baseHead: fixture.baseHead,
      capture: input,
      readyPath,
    }),
  );
  await fixture.rootOwner.close();
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./fixtures/gitoxide-candidate-crash-child.js', import.meta.url)),
      inputPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  try {
    await waitForPath(readyPath, 20_000, child, stdout, stderr);
    child.kill('SIGKILL');
    await waitForExit(child, 10_000);

    const reopenedRootOwner = await tryAcquireInteractiveRootOwner(fixture.rootCapability);
    assert.ok(reopenedRootOwner);
    t.after(() => reopenedRootOwner.close());
    const reopened = await createGitoxideMutationCandidateAuthorityInternal({
      ...fixture.helper,
      storageRootLease: reopenedRootOwner.lease,
      baseHead: fixture.baseHead,
    });
    const recovered = await reopened.capture(input);
    assert.equal(
      gitBare(fixture.repositoryPath, ['rev-parse', recovered.receipt.candidateRef]),
      recovered.receipt.candidateCommitOid,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

async function candidateFixture(t: TestContext) {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return undefined;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-candidate-owner-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const rootCapability = await resolveStorageRoot({
    path: join(root, 'storage'),
    kind: 'interactive',
  });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  t.after(() => (rootOwner.closed ? undefined : rootOwner.close()));
  const storageRoot = rootOwner.capability.canonicalPath;
  git(root, ['init', '--quiet', '--object-format=sha1', sourceRoot]);
  await writeFile(join(sourceRoot, 'hello.txt'), 'candidate base\n');
  git(sourceRoot, ['add', 'hello.txt']);
  git(sourceRoot, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const admissionOwnerToken = {};
  const managedRepositoryOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath: sourceRoot,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return undefined;
  const sourceHead: WorkspaceHeadRecordV1 = {
    repositoryId: `repository_${'1'.repeat(32)}`,
    workspaceId: `workspace_${'2'.repeat(32)}`,
    workspaceEpochId: `epoch_${'3'.repeat(32)}`,
    workspaceVersionId: `version_${'4'.repeat(32)}`,
    acceptedEventId: 'accepted-event-1',
    commitOid: git(sourceRoot, ['rev-parse', 'HEAD']),
    treeOid: git(sourceRoot, ['rev-parse', 'HEAD^{tree}']),
    revision: 1,
  };
  const repositoryPath = gitoxideManagedRepositoryPathInternal(storageRoot, sourceHead);
  await mkdir(dirname(repositoryPath), { recursive: true });
  const imported = await importAdmittedGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    managedRepositoryOwnerToken,
    destinationRepositoryPath: repositoryPath,
    baselineRef: 'refs/maka/accepted',
  });
  assert.equal(imported.sourceHeadCommitOid, sourceHead.commitOid);
  assert.equal(imported.sourceTreeOid, sourceHead.treeOid);
  const baseHead: WorkspaceHeadRecordV1 = {
    ...sourceHead,
    commitOid: imported.baselineCommitOid,
    treeOid: imported.baselineTreeOid,
  };
  return { helper, storageRoot, rootCapability, rootOwner, repositoryPath, baseHead };
}

async function admittedHelper(): Promise<AdmittedHelper | undefined> {
  if (admittedHelperPromise) return admittedHelperPromise;
  admittedHelperPromise = (async () => {
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
    });
    const helperCapability = await admitGitoxideHelperArtifactInternal({
      releaseOwnerToken,
      invocationOwnerToken,
      claim,
    });
    return { invocationOwnerToken, helperCapability };
  })();
  return admittedHelperPromise;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function gitBare(repositoryPath: string, args: readonly string[]): string {
  return execFileSync('git', ['--git-dir', repositoryPath, ...args], {
    encoding: 'utf8',
  }).trim();
}

async function waitForPath(
  path: string,
  timeoutMs: number,
  child: ReturnType<typeof spawn>,
  stdout: Buffer[],
  stderr: Buffer[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (
      await stat(path)
        .then(() => true)
        .catch(() => false)
    )
      return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Crash fixture exited before ready: ${Buffer.concat(stdout).toString('utf8')} ${Buffer.concat(stderr).toString('utf8')}`,
      );
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for candidate crash fixture');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.once('exit', () => resolve());
        child.once('error', reject);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for candidate crash fixture exit')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
