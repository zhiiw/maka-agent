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

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MANAGED_MUTATION_EXECUTION_PROFILE_V1 } from '@maka/core/runtime-event';
import type { WorkspaceHeadRecordV1 } from '@maka/core/workspace-version-authority';
import { withProcessLifetimeFileUpdateLock } from '@maka/storage/process-lifetime-file-update-lock';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  type StorageRootLease,
} from '@maka/storage/root-authority';
import { syncDirectory } from '@maka/storage/stable-storage';
import {
  createGitoxideCandidateInternal,
  type GitoxideAcceptedRepositoryCapability,
  type GitoxideCandidateOutcomeCapability,
  requireGitoxideAcceptedRepositoryInternal,
  requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal,
} from './gitoxide-repository-admission-authority-internal.js';

const ACCEPTED_REF = 'refs/maka/accepted';
const MAX_RECEIPT_BYTES = 32 * 1024;
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RECEIPT_KEYS = [
  'schemaVersion',
  'protocol',
  'repositoryId',
  'workspaceId',
  'workspaceEpochId',
  'workspaceVersionId',
  'baseAcceptedEventId',
  'baseHeadRevision',
  'baseCommitOid',
  'baseTreeOid',
  'objectFormat',
  'operationIdentitySha256',
  'acceptedRef',
  'disposition',
  'helperArtifactSha256',
  'managedTreePolicyVersion',
  'requestDigestSha256',
  'candidateRef',
  'candidateCommitOid',
  'candidateTreeOid',
  'resultBlobOid',
  'path',
  'contentSha256',
  'executionProfileDigest',
] as const;

export interface GitoxideMutationCandidateReceiptV1 {
  readonly schemaVersion: 1;
  readonly protocol: 'maka_gitoxide_candidate_receipt_v1';
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceVersionId: string;
  readonly baseAcceptedEventId: string;
  readonly baseHeadRevision: number;
  readonly baseCommitOid: string;
  readonly baseTreeOid: string;
  readonly objectFormat: 'sha1';
  readonly operationIdentitySha256: `sha256:${string}`;
  readonly acceptedRef: typeof ACCEPTED_REF;
  readonly disposition: 'published' | 'no_change';
  readonly helperArtifactSha256: `sha256:${string}`;
  readonly managedTreePolicyVersion: 3;
  readonly requestDigestSha256: string;
  readonly candidateRef: string;
  readonly candidateCommitOid: string;
  readonly candidateTreeOid: string;
  readonly resultBlobOid: string;
  readonly path: string;
  readonly contentSha256: `sha256:${string}`;
  readonly executionProfileDigest: `sha256:${string}`;
}

export interface GitoxideMutationCandidateCaptureInput {
  readonly operationId: string;
  readonly path: string;
  readonly content: string;
  readonly executionProfileDigest: `sha256:${string}`;
  readonly abortSignal?: AbortSignal;
}

export interface GitoxideMutationCandidateProofV1 {
  readonly receipt: GitoxideMutationCandidateReceiptV1;
  readonly candidateOutcomeCapability: GitoxideCandidateOutcomeCapability;
}

export interface GitoxideMutationCandidateAuthorityInternal {
  capture(input: GitoxideMutationCandidateCaptureInput): Promise<GitoxideMutationCandidateProofV1>;
  validate(proof: GitoxideMutationCandidateProofV1): GitoxideMutationCandidateReceiptV1;
}

export type GitoxideMutationCandidateFailpoint = 'after_candidate_ref' | 'after_candidate_receipt';

export class GitoxideMutationCandidateAuthorityError extends Error {
  constructor(
    readonly code:
      | 'gitoxide_mutation_candidate_request_invalid'
      | 'gitoxide_mutation_candidate_receipt_invalid'
      | 'gitoxide_mutation_candidate_identity_conflict',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitoxideMutationCandidateAuthorityError';
  }
}

export async function createGitoxideMutationCandidateAuthorityInternal(input: {
  readonly storageRootLease: StorageRootLease<'interactive', 'write'>;
  readonly baseHead: WorkspaceHeadRecordV1;
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly failpoint?: (point: GitoxideMutationCandidateFailpoint) => void | Promise<void>;
}): Promise<GitoxideMutationCandidateAuthorityInternal> {
  await assertStorageRootLease(input.storageRootLease, 'interactive', 'write');
  const rootContext = await runWithStorageRootLease(
    input.storageRootLease,
    'interactive',
    'write',
    async (storageRoot) => {
      const accepted = requireGitoxideAcceptedRepositoryInternal(
        input.acceptedRepositoryOwnerToken,
        input.acceptedRepositoryCapability,
      );
      const repositoryPath = await realpath(accepted.repositoryPath);
      const repositoryInfo = await lstat(repositoryPath);
      assertWithin(storageRoot, repositoryPath, 'Gitoxide accepted repository');
      if (
        !repositoryInfo.isDirectory() ||
        repositoryInfo.isSymbolicLink() ||
        repositoryInfo.dev !== accepted.repositoryDev ||
        repositoryInfo.ino !== accepted.repositoryIno ||
        accepted.acceptedRef !== ACCEPTED_REF ||
        accepted.acceptedCommitOid !== input.baseHead.commitOid ||
        accepted.acceptedTreeOid !== input.baseHead.treeOid ||
        accepted.managedTreePolicyVersion !== 3
      ) {
        throw new GitoxideMutationCandidateAuthorityError(
          'gitoxide_mutation_candidate_identity_conflict',
          'Gitoxide accepted repository does not match the durable workspace head',
        );
      }
      const receiptRoot = gitoxideMutationCandidateReceiptRootInternal(storageRoot, input.baseHead);
      await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
      const canonicalReceiptRoot = await realpath(receiptRoot);
      assertWithin(storageRoot, canonicalReceiptRoot, 'Gitoxide candidate receipt root');
      if (process.platform !== 'win32') await chmod(canonicalReceiptRoot, 0o700);
      const receiptRootInfo = await lstat(canonicalReceiptRoot);
      if (!receiptRootInfo.isDirectory() || receiptRootInfo.isSymbolicLink()) {
        throw new GitoxideMutationCandidateAuthorityError(
          'gitoxide_mutation_candidate_identity_conflict',
          'Gitoxide candidate receipt root is not an owned directory',
        );
      }
      return {
        storageRoot,
        repositoryPath,
        repositoryIdentity: Object.freeze({
          dev: repositoryInfo.dev,
          ino: repositoryInfo.ino,
        }),
        canonicalReceiptRoot,
        receiptRootIdentity: Object.freeze({
          dev: receiptRootInfo.dev,
          ino: receiptRootInfo.ino,
        }),
      };
    },
  );

  const candidateOwnerToken = {};
  const issuedProofs = new WeakMap<
    GitoxideMutationCandidateProofV1,
    GitoxideMutationCandidateReceiptV1
  >();
  const capture = async (
    request: GitoxideMutationCandidateCaptureInput,
  ): Promise<GitoxideMutationCandidateProofV1> => {
    assertCaptureInput(request);
    return runWithStorageRootLease(
      input.storageRootLease,
      'interactive',
      'write',
      async (storageRoot) => {
        if (storageRoot !== rootContext.storageRoot) {
          throw new GitoxideMutationCandidateAuthorityError(
            'gitoxide_mutation_candidate_identity_conflict',
            'Gitoxide candidate authority storage root identity changed',
          );
        }
        await assertDirectoryIdentity(
          rootContext.canonicalReceiptRoot,
          rootContext.receiptRootIdentity,
        );
        await assertDirectoryIdentity(rootContext.repositoryPath, rootContext.repositoryIdentity);
        const operationIdentitySha256 = sha256(request.operationId);
        const receiptPath = join(
          rootContext.canonicalReceiptRoot,
          `${operationIdentitySha256.slice(7)}.json`,
        );
        return withProcessLifetimeFileUpdateLock(receiptPath, async () => {
          request.abortSignal?.throwIfAborted();
          const durable = await readReceipt(receiptPath);
          const candidate = await createGitoxideCandidateInternal({
            acceptedRepositoryOwnerToken: input.acceptedRepositoryOwnerToken,
            acceptedRepositoryCapability: input.acceptedRepositoryCapability,
            candidateOwnerToken,
            operationId: request.operationId,
            path: request.path,
            content: request.content,
            abortSignal: request.abortSignal,
          });
          const candidateEvidence = requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
            acceptedRepositoryOwnerToken: input.acceptedRepositoryOwnerToken,
            acceptedRepositoryCapability: input.acceptedRepositoryCapability,
            candidateOwnerToken,
            candidateOutcomeCapability: candidate.candidateOutcomeCapability,
          });
          if (
            candidateEvidence.baseCommitOid !== input.baseHead.commitOid ||
            candidateEvidence.baseTreeOid !== input.baseHead.treeOid
          ) {
            throw new GitoxideMutationCandidateAuthorityError(
              'gitoxide_mutation_candidate_identity_conflict',
              'Gitoxide candidate does not descend from the durable workspace head',
            );
          }
          const expected = freezeReceipt({
            schemaVersion: 1,
            protocol: 'maka_gitoxide_candidate_receipt_v1',
            repositoryId: input.baseHead.repositoryId,
            workspaceId: input.baseHead.workspaceId,
            workspaceEpochId: input.baseHead.workspaceEpochId,
            workspaceVersionId: input.baseHead.workspaceVersionId,
            baseAcceptedEventId: input.baseHead.acceptedEventId,
            baseHeadRevision: input.baseHead.revision,
            baseCommitOid: input.baseHead.commitOid,
            baseTreeOid: input.baseHead.treeOid,
            objectFormat: 'sha1',
            operationIdentitySha256,
            acceptedRef: ACCEPTED_REF,
            disposition: candidateEvidence.disposition,
            helperArtifactSha256: candidateEvidence.helperArtifactSha256,
            managedTreePolicyVersion: candidateEvidence.managedTreePolicyVersion,
            requestDigestSha256: candidateEvidence.requestDigestSha256,
            candidateRef: candidateEvidence.candidateRef,
            candidateCommitOid: candidateEvidence.candidateCommitOid,
            candidateTreeOid: candidateEvidence.candidateTreeOid,
            resultBlobOid: candidateEvidence.resultBlobOid,
            path: candidateEvidence.path,
            contentSha256: sha256(request.content),
            executionProfileDigest: request.executionProfileDigest,
          });
          if (durable && !isDeepStrictEqual(durable, expected)) {
            throw new GitoxideMutationCandidateAuthorityError(
              'gitoxide_mutation_candidate_identity_conflict',
              'Durable Gitoxide candidate receipt conflicts with the exact operation candidate',
            );
          }
          if (!durable) {
            await input.failpoint?.('after_candidate_ref');
            await writeReceiptAtomic(receiptPath, expected);
            await input.failpoint?.('after_candidate_receipt');
          }
          const receipt = durable ?? expected;
          const proof = Object.freeze({
            receipt,
            candidateOutcomeCapability: candidate.candidateOutcomeCapability,
          });
          issuedProofs.set(proof, receipt);
          return proof;
        });
      },
    );
  };

  return Object.freeze({
    capture,
    validate(proof: GitoxideMutationCandidateProofV1) {
      const issuedReceipt = issuedProofs.get(proof);
      if (!issuedReceipt || proof.receipt !== issuedReceipt) {
        throw new GitoxideMutationCandidateAuthorityError(
          'gitoxide_mutation_candidate_identity_conflict',
          'Gitoxide candidate proof was not issued by this authority',
        );
      }
      const candidate = requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
        acceptedRepositoryOwnerToken: input.acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: input.acceptedRepositoryCapability,
        candidateOwnerToken,
        candidateOutcomeCapability: proof.candidateOutcomeCapability,
      });
      if (sha256(candidate.operationId) !== proof.receipt.operationIdentitySha256) {
        throw new GitoxideMutationCandidateAuthorityError(
          'gitoxide_mutation_candidate_identity_conflict',
          'Gitoxide candidate operation identity does not match its durable receipt',
        );
      }
      if (
        candidate.disposition !== proof.receipt.disposition ||
        candidate.objectFormat !== proof.receipt.objectFormat ||
        candidate.acceptedRef !== proof.receipt.acceptedRef ||
        candidate.baseCommitOid !== proof.receipt.baseCommitOid ||
        candidate.baseTreeOid !== proof.receipt.baseTreeOid ||
        candidate.helperArtifactSha256 !== proof.receipt.helperArtifactSha256 ||
        candidate.managedTreePolicyVersion !== proof.receipt.managedTreePolicyVersion ||
        candidate.requestDigestSha256 !== proof.receipt.requestDigestSha256 ||
        candidate.resultContentSha256 !== proof.receipt.contentSha256 ||
        candidate.candidateRef !== proof.receipt.candidateRef ||
        candidate.candidateCommitOid !== proof.receipt.candidateCommitOid ||
        candidate.candidateTreeOid !== proof.receipt.candidateTreeOid ||
        candidate.resultBlobOid !== proof.receipt.resultBlobOid ||
        candidate.path !== proof.receipt.path
      ) {
        throw new GitoxideMutationCandidateAuthorityError(
          'gitoxide_mutation_candidate_identity_conflict',
          'Gitoxide candidate capability does not match its durable receipt',
        );
      }
      return issuedReceipt;
    },
  });
}

export function gitoxideMutationCandidateReceiptRootInternal(
  storageRoot: string,
  head: Pick<WorkspaceHeadRecordV1, 'workspaceId' | 'workspaceEpochId'>,
): string {
  return join(
    resolve(storageRoot),
    'managed-workspaces',
    'gitoxide-candidates',
    identityDigest(head),
  );
}

function identityDigest(
  head: Pick<WorkspaceHeadRecordV1, 'workspaceId' | 'workspaceEpochId'>,
): string {
  return createHash('sha256')
    .update(`${head.workspaceId}\0${head.workspaceEpochId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function assertCaptureInput(input: GitoxideMutationCandidateCaptureInput): void {
  if (
    input.operationId.length === 0 ||
    Buffer.byteLength(input.operationId, 'utf8') > 1024 ||
    input.executionProfileDigest !== MANAGED_MUTATION_EXECUTION_PROFILE_V1
  ) {
    throw new GitoxideMutationCandidateAuthorityError(
      'gitoxide_mutation_candidate_request_invalid',
      'Gitoxide mutation candidate request is invalid',
    );
  }
}

async function readReceipt(path: string): Promise<GitoxideMutationCandidateReceiptV1 | undefined> {
  const before = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECEIPT_BYTES) {
    throw invalidReceipt('Candidate receipt must be a bounded regular file');
  }
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(path, flags).catch((error: unknown) => {
    throw invalidReceipt('Candidate receipt cannot be opened without following links', error);
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_RECEIPT_BYTES) {
      throw invalidReceipt('Candidate receipt must be a bounded regular file');
    }
    const bytes = Buffer.alloc(Math.min(MAX_RECEIPT_BYTES + 1, opened.size + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_RECEIPT_BYTES || offset !== opened.size) {
      throw invalidReceipt('Candidate receipt changed size while being read');
    }
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw invalidReceipt('Candidate receipt identity changed while being read');
    }
    return decodeReceipt(JSON.parse(bytes.subarray(0, offset).toString('utf8')));
  } catch (error) {
    if (error instanceof GitoxideMutationCandidateAuthorityError) throw error;
    throw invalidReceipt('Candidate receipt is not strict JSON', error);
  } finally {
    await handle.close();
  }
}

function decodeReceipt(value: unknown): GitoxideMutationCandidateReceiptV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidReceipt('Candidate receipt must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('\0') !== [...RECEIPT_KEYS].sort().join('\0') ||
    record.schemaVersion !== 1 ||
    record.protocol !== 'maka_gitoxide_candidate_receipt_v1' ||
    typeof record.repositoryId !== 'string' ||
    typeof record.workspaceId !== 'string' ||
    typeof record.workspaceEpochId !== 'string' ||
    typeof record.workspaceVersionId !== 'string' ||
    typeof record.baseAcceptedEventId !== 'string' ||
    !Number.isSafeInteger(record.baseHeadRevision) ||
    (record.baseHeadRevision as number) < 1 ||
    typeof record.baseCommitOid !== 'string' ||
    !SHA1_PATTERN.test(record.baseCommitOid) ||
    typeof record.baseTreeOid !== 'string' ||
    !SHA1_PATTERN.test(record.baseTreeOid) ||
    record.objectFormat !== 'sha1' ||
    typeof record.operationIdentitySha256 !== 'string' ||
    !SHA256_PATTERN.test(record.operationIdentitySha256) ||
    record.acceptedRef !== ACCEPTED_REF ||
    (record.disposition !== 'published' && record.disposition !== 'no_change') ||
    typeof record.helperArtifactSha256 !== 'string' ||
    !SHA256_PATTERN.test(record.helperArtifactSha256) ||
    record.managedTreePolicyVersion !== 3 ||
    typeof record.requestDigestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(record.requestDigestSha256) ||
    typeof record.candidateRef !== 'string' ||
    !record.candidateRef.startsWith('refs/maka/candidates/') ||
    typeof record.candidateCommitOid !== 'string' ||
    !SHA1_PATTERN.test(record.candidateCommitOid) ||
    typeof record.candidateTreeOid !== 'string' ||
    !SHA1_PATTERN.test(record.candidateTreeOid) ||
    typeof record.resultBlobOid !== 'string' ||
    !SHA1_PATTERN.test(record.resultBlobOid) ||
    typeof record.path !== 'string' ||
    typeof record.contentSha256 !== 'string' ||
    !SHA256_PATTERN.test(record.contentSha256) ||
    typeof record.executionProfileDigest !== 'string' ||
    !SHA256_PATTERN.test(record.executionProfileDigest)
  ) {
    throw invalidReceipt('Candidate receipt has an invalid envelope');
  }
  return freezeReceipt(record as unknown as GitoxideMutationCandidateReceiptV1);
}

function freezeReceipt(
  value: GitoxideMutationCandidateReceiptV1,
): GitoxideMutationCandidateReceiptV1 {
  return Object.freeze({ ...value });
}

async function writeReceiptAtomic(
  path: string,
  receipt: GitoxideMutationCandidateReceiptV1,
): Promise<void> {
  const encoded = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RECEIPT_BYTES) {
    throw invalidReceipt('Candidate receipt exceeds its byte limit');
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function assertWithin(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new GitoxideMutationCandidateAuthorityError(
    'gitoxide_mutation_candidate_request_invalid',
    `${label} escapes the storage root`,
  );
}

function invalidReceipt(message: string, cause?: unknown): GitoxideMutationCandidateAuthorityError {
  return new GitoxideMutationCandidateAuthorityError(
    'gitoxide_mutation_candidate_receipt_invalid',
    message,
    cause === undefined ? undefined : { cause },
  );
}

async function assertDirectoryIdentity(
  path: string,
  expected: Readonly<{ dev: number; ino: number }>,
): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== expected.dev ||
    info.ino !== expected.ino
  ) {
    throw new GitoxideMutationCandidateAuthorityError(
      'gitoxide_mutation_candidate_identity_conflict',
      'Gitoxide candidate receipt root identity changed',
    );
  }
}
