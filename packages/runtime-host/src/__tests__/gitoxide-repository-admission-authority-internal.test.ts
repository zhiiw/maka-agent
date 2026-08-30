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
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  admitGitoxideHelperArtifactInternal,
  GitoxideHelperArtifactAuthorityError,
  type GitoxideHelperOperationInternal,
  type GitoxideHelperInvocationCapability,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  admitGitoxideRepositoryInternal,
  createGitoxideCandidateInternal,
  GitoxideRepositoryAdmissionAuthorityError,
  importAdmittedGitoxideRepositoryInternal,
  promoteGitoxideCandidateInternal,
  readGitoxideTreeFileInternal,
  reopenGitoxideAcceptedRepositoryInternal,
  requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal,
  requireGitoxideRepositoryAdmissionInternal,
} from '../server/gitoxide-repository-admission-authority-internal.js';
import { GitoxideHelperInvocationError } from '../server/gitoxide-helper-invocation-internal.js';
import {
  createGitoxideMutationCandidateAuthorityInternal,
  gitoxideMutationCandidateReceiptRootInternal,
  GitoxideMutationCandidateAuthorityError,
} from '../server/gitoxide-mutation-candidate-receipt-authority-internal.js';

interface AdmittedHelper {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly helperArtifactSha256: `sha256:${string}`;
}

let admittedHelperPromise: Promise<AdmittedHelper | undefined> | undefined;

test('applies admission cancellation before repository path preflight', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    admitGitoxideRepositoryInternal({
      invocationOwnerToken: {},
      helperCapability: {} as GitoxideHelperInvocationCapability,
      admissionOwnerToken: {},
      repositoryPath: join(tmpdir(), 'missing-gitoxide-admission-repository'),
      abortSignal: controller.signal,
    }),
    (error) =>
      error instanceof GitoxideHelperInvocationError &&
      error.code === 'gitoxide_helper_invocation_aborted',
  );
});

test('issues an opaque owner-bound admission capability from the exact helper observation', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'hello from admission authority\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const expectedCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
  const expectedTree = git(repositoryPath, ['rev-parse', 'HEAD^{tree}']);
  const admissionOwnerToken = {};

  const result = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });

  assert.equal(result.kind, 'accepted');
  if (result.kind !== 'accepted') return;
  assert.deepEqual(result.capability, { kind: 'gitoxide_repository_admission_capability_v1' });
  assert.throws(
    () => requireGitoxideRepositoryAdmissionInternal({}, result.capability),
    (error) =>
      error instanceof GitoxideRepositoryAdmissionAuthorityError &&
      error.code === 'gitoxide_repository_admission_capability_invalid',
  );
  assert.deepEqual(
    requireGitoxideRepositoryAdmissionInternal(admissionOwnerToken, result.capability),
    {
      protocolVersion: 1,
      repositoryPath,
      objectFormat: 'sha1',
      headCommitOid: expectedCommit,
      headTreeOid: expectedTree,
      helperArtifactSha256: helper.helperArtifactSha256,
      managedTreePolicyVersion: 3,
    },
  );
});

test('returns a policy rejection without issuing an admission capability', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha256');

  assert.deepEqual(
    await admitGitoxideRepositoryInternal({
      ...helper,
      admissionOwnerToken: {},
      repositoryPath,
    }),
    {
      kind: 'repository_rejected',
      protocolVersion: 1,
      reason: 'unsupported_object_format',
      objectFormat: 'sha256',
      supportedObjectFormats: ['sha1'],
    },
  );
});

test('imports only the exact repository identity bound to the admission capability', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'hello from source import authority\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const expectedCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
  const expectedTree = git(repositoryPath, ['rev-parse', 'HEAD^{tree}']);
  const admissionOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const destinationRepositoryPath = join(repositoryPath, 'managed.git');
  const acceptedRepositoryOwnerToken = {};

  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath,
  });

  assert.equal(imported.sourceHeadCommitOid, expectedCommit);
  assert.equal(imported.sourceTreeOid, expectedTree);
  assert.equal(imported.baselineTreeOid, expectedTree);
  assert.equal(
    gitBare(destinationRepositoryPath, ['rev-parse', 'refs/maka/accepted']),
    imported.baselineCommitOid,
  );
  await assert.rejects(
    importAdmittedGitoxideRepositoryInternal({
      admissionOwnerToken: {},
      repositoryCapability: admitted.capability,
      acceptedRepositoryOwnerToken,
      destinationRepositoryPath: join(repositoryPath, 'forged.git'),
    }),
    (error) =>
      error instanceof GitoxideRepositoryAdmissionAuthorityError &&
      error.code === 'gitoxide_repository_admission_capability_invalid',
  );
});

test('rejects a helper without candidate/read attestation before claiming the import destination', async (t) => {
  const helper = await admittedHelperWithOperations(['inspect_repository', 'import_source_head']);
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'feature attestation\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
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
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const destinationRepositoryPath = join(repositoryPath, 'must-not-be-claimed.git');

  await assert.rejects(
    importAdmittedGitoxideRepositoryInternal({
      admissionOwnerToken,
      repositoryCapability: admitted.capability,
      acceptedRepositoryOwnerToken: {},
      destinationRepositoryPath,
    }),
    (error) =>
      error instanceof GitoxideHelperArtifactAuthorityError &&
      error.code === 'gitoxide_helper_release_claim_unsupported',
  );
  await assert.rejects(stat(destinationRepositoryPath), { code: 'ENOENT' });
});

test('publishes an operation-bound candidate without advancing accepted authority', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'hello from candidate authority\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
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
  const acceptedRepositoryOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const destinationRepositoryPath = join(repositoryPath, 'managed.git');
  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath,
  });

  const candidateOwnerToken = {};
  const candidate = await createGitoxideCandidateInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    operationId: 'operation-1',
    path: 'docs/result.txt',
    content: 'candidate result\n',
  });
  assert.equal(candidate.kind, 'candidate_published');
  if (candidate.kind !== 'candidate_published') return;

  assert.equal(candidate.baseCommitOid, imported.baselineCommitOid);
  assert.equal(candidate.baseTreeOid, imported.baselineTreeOid);
  assert.equal(
    candidate.candidateRef,
    `refs/maka/candidates/${createHash('sha256').update('operation-1').digest('hex')}`,
  );
  assert.equal(
    gitBare(destinationRepositoryPath, ['rev-parse', 'refs/maka/accepted']),
    imported.baselineCommitOid,
  );
  assert.equal(
    gitBare(destinationRepositoryPath, ['rev-parse', candidate.candidateRef]),
    candidate.candidateCommitOid,
  );
  assert.deepEqual(candidate.candidateOutcomeCapability, {
    kind: 'gitoxide_candidate_outcome_capability_v1',
  });
  const candidateProof = requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    candidateOutcomeCapability: candidate.candidateOutcomeCapability,
  });
  assert.equal(candidateProof.operationId, 'operation-1');
  assert.equal(candidateProof.acceptedRef, 'refs/maka/accepted');
  assert.equal(candidateProof.objectFormat, 'sha1');
  assert.equal(candidateProof.managedTreePolicyVersion, 3);
  assert.match(candidateProof.helperArtifactSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(candidateProof.requestDigestSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    candidateProof.resultContentSha256,
    `sha256:${createHash('sha256').update('candidate result\n').digest('hex')}`,
  );
  assert.throws(
    () =>
      requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
        acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
        candidateOwnerToken: {},
        candidateOutcomeCapability: candidate.candidateOutcomeCapability,
      }),
    GitoxideRepositoryAdmissionAuthorityError,
  );

  const secondAcceptedRepositoryOwnerToken = {};
  const sameContentOtherRepository = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken: secondAcceptedRepositoryOwnerToken,
    destinationRepositoryPath: join(repositoryPath, 'managed-other.git'),
  });
  assert.throws(
    () =>
      requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
        acceptedRepositoryOwnerToken: secondAcceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: sameContentOtherRepository.acceptedRepositoryCapability,
        candidateOwnerToken,
        candidateOutcomeCapability: candidate.candidateOutcomeCapability,
      }),
    GitoxideRepositoryAdmissionAuthorityError,
  );

  const acceptedRead = await readGitoxideTreeFileInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    path: 'hello.txt',
  });
  assert.equal(acceptedRead.content, 'hello from candidate authority\n');

  const noChangeOperationId = 'operation-no-change';
  const noChange = await createGitoxideCandidateInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    operationId: noChangeOperationId,
    path: 'hello.txt',
    content: 'hello from candidate authority\n',
  });
  assert.equal(noChange.kind, 'candidate_no_change');
  assert.equal(
    gitBare(destinationRepositoryPath, ['rev-parse', noChange.candidateRef]),
    noChange.candidateCommitOid,
  );
  assert.equal(noChange.candidateTreeOid, imported.baselineTreeOid);
  assert.equal(
    requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
      candidateOwnerToken,
      candidateOutcomeCapability: noChange.candidateOutcomeCapability,
    }).disposition,
    'no_change',
  );

  const exactRetry = await createGitoxideCandidateInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    operationId: 'operation-1',
    path: 'docs/result.txt',
    content: 'candidate result\n',
  });
  assert.equal(exactRetry.kind, 'candidate_published');
  if (exactRetry.kind !== 'candidate_published') return;
  assert.equal(exactRetry.candidateCommitOid, candidate.candidateCommitOid);
  assert.equal(exactRetry.candidateTreeOid, candidate.candidateTreeOid);

  const second = await createGitoxideCandidateInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    operationId: 'operation-2',
    path: 'docs/next.txt',
    content: 'next candidate\n',
  });
  assert.equal(second.kind, 'candidate_published');
  if (second.kind !== 'candidate_published') return;
  assert.equal(second.baseCommitOid, imported.baselineCommitOid);
  assert.notEqual(second.candidateRef, candidate.candidateRef);
  const nextAcceptedRepositoryOwnerToken = {};
  const promoted = await promoteGitoxideCandidateInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    candidateOutcomeCapability: candidate.candidateOutcomeCapability,
    nextAcceptedRepositoryOwnerToken,
  });
  assert.equal(promoted.kind, 'candidate_promoted');
  assert.equal(promoted.replayed, false);
  assert.equal(promoted.acceptedCommitOid, candidate.candidateCommitOid);
  assert.equal(
    gitBare(destinationRepositoryPath, ['rev-parse', 'refs/maka/accepted']),
    candidate.candidateCommitOid,
  );
  const promotedRead = await readGitoxideTreeFileInternal({
    acceptedRepositoryOwnerToken: nextAcceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: promoted.acceptedRepositoryCapability,
    path: 'docs/result.txt',
  });
  assert.equal(promotedRead.content, 'candidate result\n');
  const replayedOwnerToken = {};
  const replayed = await promoteGitoxideCandidateInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    candidateOwnerToken,
    candidateOutcomeCapability: candidate.candidateOutcomeCapability,
    nextAcceptedRepositoryOwnerToken: replayedOwnerToken,
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.acceptedCommitOid, candidate.candidateCommitOid);
  const reopenedOwnerToken = {};
  const reopened = await reopenGitoxideAcceptedRepositoryInternal({
    invocationOwnerToken: helper.invocationOwnerToken,
    helperCapability: helper.helperCapability,
    acceptedRepositoryOwnerToken: reopenedOwnerToken,
    repositoryPath: destinationRepositoryPath,
    acceptedRef: 'refs/maka/accepted',
    expectedAcceptedCommitOid: candidate.candidateCommitOid,
    expectedAcceptedTreeOid: candidate.candidateTreeOid,
    managedTreePolicyVersion: 3,
  });
  const reopenedRead = await readGitoxideTreeFileInternal({
    acceptedRepositoryOwnerToken: reopenedOwnerToken,
    acceptedRepositoryCapability: reopened.acceptedRepositoryCapability,
    path: 'docs/result.txt',
  });
  assert.equal(reopenedRead.content, 'candidate result\n');
  await assert.rejects(
    createGitoxideCandidateInternal({
      acceptedRepositoryOwnerToken: {},
      acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
      candidateOwnerToken,
      operationId: 'forged-operation',
      path: 'forged.txt',
      content: 'forged\n',
    }),
    (error) =>
      error instanceof GitoxideRepositoryAdmissionAuthorityError &&
      error.code === 'gitoxide_repository_admission_capability_invalid',
  );
});

test('publishes a durable operation-bound candidate receipt and rejects tampering', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const sourceRepositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(sourceRepositoryPath, 'hello.txt'), 'durable candidate base\n');
  git(sourceRepositoryPath, ['add', 'hello.txt']);
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
  const storageRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'maka-gitoxide-candidate-receipt-')),
  );
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const rootCapability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  t.after(() => rootOwner.close());

  const admissionOwnerToken = {};
  const acceptedRepositoryOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath: sourceRepositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath: join(storageRoot, 'managed.git'),
  });
  const baseHead = {
    repositoryId: 'repository_11111111111111111111111111111111',
    workspaceId: 'workspace_22222222222222222222222222222222',
    workspaceEpochId: 'epoch_33333333333333333333333333333333',
    workspaceVersionId: 'version_44444444444444444444444444444444',
    acceptedEventId: 'baseline-event-1',
    commitOid: imported.baselineCommitOid,
    treeOid: imported.baselineTreeOid,
    revision: 1,
  } as const;
  const authority = await createGitoxideMutationCandidateAuthorityInternal({
    storageRootLease: rootOwner.lease,
    baseHead,
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    projectionOwnerToken: {},
  });
  const request = {
    operationId: 'operation-durable-receipt',
    path: 'docs/result.txt',
    content: 'durable result\n',
    executionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  } as const;

  const first = await authority.capture(request);
  assert.equal(authority.validate(first), first.receipt);
  assert.equal(first.receipt.disposition, 'published');
  assert.equal(first.receipt.baseCommitOid, baseHead.commitOid);
  assert.equal(first.receipt.baseTreeOid, baseHead.treeOid);
  assert.equal(first.receipt.path, request.path);
  assert.equal(first.receipt.contentSha256, sha256(request.content));
  assert.deepEqual((await authority.capture(request)).receipt, first.receipt);

  const receiptPath = join(
    gitoxideMutationCandidateReceiptRootInternal(storageRoot, baseHead),
    `${sha256(request.operationId).slice(7)}.json`,
  );
  const tampered = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
  tampered.path = 'forged.txt';
  await writeFile(receiptPath, `${JSON.stringify(tampered)}\n`, 'utf8');
  await assert.rejects(
    authority.capture(request),
    (error) =>
      error instanceof GitoxideMutationCandidateAuthorityError &&
      error.code === 'gitoxide_mutation_candidate_identity_conflict',
  );
});

test('converges a ref-only candidate publication by replaying the pure request', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const sourceRepositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(sourceRepositoryPath, 'hello.txt'), 'ref-only base\n');
  git(sourceRepositoryPath, ['add', 'hello.txt']);
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
  const storageRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'maka-gitoxide-candidate-replay-')),
  );
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const rootCapability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  t.after(() => rootOwner.close());
  const admissionOwnerToken = {};
  const acceptedRepositoryOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath: sourceRepositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath: join(storageRoot, 'managed.git'),
  });
  const baseHead = {
    repositoryId: 'repository_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    workspaceId: 'workspace_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    workspaceEpochId: 'epoch_cccccccccccccccccccccccccccccccc',
    workspaceVersionId: 'version_dddddddddddddddddddddddddddddddd',
    acceptedEventId: 'baseline-event-replay',
    commitOid: imported.baselineCommitOid,
    treeOid: imported.baselineTreeOid,
    revision: 1,
  } as const;
  let stopped = false;
  const interrupted = await createGitoxideMutationCandidateAuthorityInternal({
    storageRootLease: rootOwner.lease,
    baseHead,
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    projectionOwnerToken: {},
    failpoint: (point) => {
      if (!stopped && point === 'after_candidate_ref') {
        stopped = true;
        throw new Error('simulated process stop after candidate ref');
      }
    },
  });
  const request = {
    operationId: 'operation-ref-only',
    path: 'result.txt',
    content: 'replayed pure result\n',
    executionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  } as const;
  await assert.rejects(interrupted.capture(request), /simulated process stop/);

  const recovered = await createGitoxideMutationCandidateAuthorityInternal({
    storageRootLease: rootOwner.lease,
    baseHead,
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    projectionOwnerToken: {},
  });
  const proof = await recovered.capture(request);
  assert.equal(proof.receipt.disposition, 'published');
  assert.equal(recovered.validate(proof), proof.receipt);
});

test('recovers a ref-only candidate after the publishing process exits', async (t) => {
  const helper = await admittedHelper();
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helper || !helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper crash test');
    return;
  }
  const sourceRepositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(sourceRepositoryPath, 'hello.txt'), 'process crash base\n');
  git(sourceRepositoryPath, ['add', 'hello.txt']);
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
  const sourceHeadCommitOid = git(sourceRepositoryPath, ['rev-parse', 'HEAD']);
  const sourceTreeOid = git(sourceRepositoryPath, ['rev-parse', 'HEAD^{tree}']);
  const storageRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'maka-gitoxide-candidate-process-crash-')),
  );
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const destinationRepositoryPath = join(storageRoot, 'managed.git');
  const fixture = {
    storageRoot,
    sourceRepositoryPath,
    destinationRepositoryPath,
    helperPath: await realpath(helperPath),
    repositoryId: 'repository_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    workspaceId: 'workspace_ffffffffffffffffffffffffffffffff',
    workspaceEpochId: 'epoch_11111111111111111111111111111111',
    workspaceVersionId: 'version_22222222222222222222222222222222',
    acceptedEventId: 'baseline-event-process-crash',
    sourceHeadCommitOid,
    sourceTreeOid,
    operationId: 'operation-process-crash',
    path: 'result.txt',
    content: 'process recovered result\n',
  } as const;
  const fixturePath = join(storageRoot, 'candidate-crash-fixture.json');
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`, 'utf8');
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dirname, 'fixtures', 'gitoxide-candidate-receipt-crash-child.js'),
      fixturePath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [exitCode] = (await once(child, 'exit')) as [number | null];
  assert.equal(exitCode, 71, Buffer.concat(stderr).toString('utf8'));

  const rootCapability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(rootCapability);
  assert.ok(rootOwner);
  t.after(() => rootOwner.close());
  const admissionOwnerToken = {};
  const acceptedRepositoryOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath: sourceRepositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath,
  });
  const baseHead = {
    repositoryId: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    workspaceEpochId: fixture.workspaceEpochId,
    workspaceVersionId: fixture.workspaceVersionId,
    acceptedEventId: fixture.acceptedEventId,
    commitOid: imported.baselineCommitOid,
    treeOid: imported.baselineTreeOid,
    revision: 1,
  } as const;
  const authority = await createGitoxideMutationCandidateAuthorityInternal({
    storageRootLease: rootOwner.lease,
    baseHead,
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    projectionOwnerToken: {},
  });
  const proof = await authority.capture({
    operationId: fixture.operationId,
    path: fixture.path,
    content: fixture.content,
    executionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  });
  assert.equal(
    proof.receipt.candidateCommitOid,
    gitBare(destinationRepositoryPath, ['rev-parse', proof.receipt.candidateRef]),
  );
  assert.equal(authority.validate(proof), proof.receipt);
});

test('reads an immutable accepted-tree file without consulting the projection filesystem', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'package.json'), '{"name":"fixture","private":true}\n');
  git(repositoryPath, ['add', 'package.json']);
  git(repositoryPath, [
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
  const acceptedRepositoryOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath: join(repositoryPath, 'managed-tree-read.git'),
  });

  const result = await readGitoxideTreeFileInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
    path: 'package.json',
  });
  assert.equal(result.content, '{"name":"fixture","private":true}\n');
  assert.equal(result.acceptedCommitOid, imported.baselineCommitOid);
  assert.equal(result.acceptedTreeOid, imported.baselineTreeOid);
  await assert.rejects(
    readGitoxideTreeFileInternal({
      acceptedRepositoryOwnerToken: {},
      acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
      path: 'package.json',
    }),
    GitoxideRepositoryAdmissionAuthorityError,
  );
});

test('reuses the exact helper capability captured by repository admission', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'bind helper identity\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
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
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;

  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken: {},
    destinationRepositoryPath: join(repositoryPath, 'captured-helper-import.git'),
  });
  assert.equal(imported.sourceHeadCommitOid, git(repositoryPath, ['rev-parse', 'HEAD']));
});

async function admittedHelper(): Promise<AdmittedHelper | undefined> {
  if (admittedHelperPromise) return admittedHelperPromise;
  admittedHelperPromise = (async () => {
    const configuredHelperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
    if (!configuredHelperPath) return undefined;
    const helperPath = await realpath(configuredHelperPath);
    const helperBytes = await readFile(helperPath);
    const helperInfo = await stat(helperPath);
    const helperArtifactSha256 =
      `sha256:${createHash('sha256').update(helperBytes).digest('hex')}` as const;
    const releaseOwnerToken = {};
    const invocationOwnerToken = {};
    const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
      executablePath: helperPath,
      expectedSha256: helperArtifactSha256,
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
    return { invocationOwnerToken, helperCapability, helperArtifactSha256 };
  })();
  return admittedHelperPromise;
}

async function admittedHelperWithOperations(
  supportedOperations: readonly GitoxideHelperOperationInternal[],
): Promise<AdmittedHelper | undefined> {
  const configuredHelperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!configuredHelperPath) return undefined;
  const helperPath = await realpath(configuredHelperPath);
  const helperBytes = await readFile(helperPath);
  const helperInfo = await stat(helperPath);
  const helperArtifactSha256 =
    `sha256:${createHash('sha256').update(helperBytes).digest('hex')}` as const;
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath: helperPath,
    expectedSha256: helperArtifactSha256,
    expectedBytes: helperInfo.size,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
    supportedOperations,
  });
  const helperCapability = await admitGitoxideHelperArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim,
  });
  return { invocationOwnerToken, helperCapability, helperArtifactSha256 };
}

async function createRepository(t: TestContext, objectFormat: 'sha1' | 'sha256') {
  const repositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-admission-')));
  t.after(() => rm(repositoryPath, { recursive: true, force: true }));
  git(repositoryPath, ['init', '--quiet', `--object-format=${objectFormat}`]);
  return repositoryPath;
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
