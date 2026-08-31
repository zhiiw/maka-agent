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

import { randomUUID } from 'node:crypto';
import { lstat, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import { retireCandidateRefWithGitoxideHelperInternal } from './gitoxide-helper-invocation-internal.js';
import {
  gitoxideMutationCandidateReceiptRootInternal,
  readGitoxideMutationCandidateReceiptInternal,
} from './gitoxide-mutation-candidate-receipt-authority-internal.js';

export interface GitoxideManagedGcResultInternal {
  readonly protocol: 'gitoxide_managed_gc_v1';
  readonly collected: number;
  readonly retained: number;
}

export interface GitoxideManagedGcOwnerInternal {
  collectRestoreOrphans(input: {
    readonly olderThanMs: number;
    readonly maxEntries: number;
  }): Promise<GitoxideManagedGcResultInternal>;
  collectMutationCandidates(input: {
    readonly olderThanMs: number;
    readonly maxEntries: number;
  }): Promise<GitoxideManagedGcResultInternal>;
}

export type GitoxideManagedGcFailpoint =
  | 'after_restore_orphan_tombstone'
  | 'after_candidate_ref_retired'
  | 'after_candidate_receipt_tombstone';

export function createGitoxideManagedGcOwnerInternal(input: {
  readonly storageRoot: string;
  readonly workspaceEpochId: string;
  readonly workspaceId?: string;
  readonly repositoryPath?: string;
  readonly invocationOwnerToken?: object;
  readonly helperCapability?: GitoxideHelperInvocationCapability;
  readonly readCandidateRetentionRoots?: () => Promise<{
    readonly acceptedCommitOid: string;
    readonly protectedOperationIdentitySha256: readonly `sha256:${string}`[];
  }>;
  readonly retireCandidateRef?: typeof retireCandidateRefWithGitoxideHelperInternal;
  readonly now?: () => number;
  readonly failpoint?: (point: GitoxideManagedGcFailpoint) => void | Promise<void>;
}): GitoxideManagedGcOwnerInternal {
  const now = input.now ?? Date.now;
  let restoreInflight: Promise<GitoxideManagedGcResultInternal> | undefined;
  let candidateInflight: Promise<GitoxideManagedGcResultInternal> | undefined;
  return Object.freeze({
    collectRestoreOrphans(request: { readonly olderThanMs: number; readonly maxEntries: number }) {
      if (
        !Number.isSafeInteger(request.olderThanMs) ||
        request.olderThanMs < 0 ||
        !Number.isSafeInteger(request.maxEntries) ||
        request.maxEntries < 1 ||
        request.maxEntries > 256
      ) {
        return Promise.reject(new Error('Gitoxide managed GC policy is invalid'));
      }
      if (restoreInflight) return restoreInflight;
      const started = collect(
        join(input.storageRoot, 'gitoxide-managed-restores', input.workspaceEpochId, 'orphans'),
        request.olderThanMs,
        request.maxEntries,
        now(),
        input.failpoint,
      ).finally(() => {
        if (restoreInflight === started) restoreInflight = undefined;
      });
      restoreInflight = started;
      return started;
    },
    collectMutationCandidates(request: {
      readonly olderThanMs: number;
      readonly maxEntries: number;
    }) {
      assertPolicy(request);
      if (
        !input.workspaceId ||
        !input.repositoryPath ||
        !input.invocationOwnerToken ||
        !input.helperCapability ||
        !input.readCandidateRetentionRoots
      ) {
        return Promise.reject(new Error('Gitoxide candidate GC authority is unavailable'));
      }
      if (candidateInflight) return candidateInflight;
      const started = collectMutationCandidates(
        {
          root: gitoxideMutationCandidateReceiptRootInternal(input.storageRoot, {
            workspaceId: input.workspaceId,
            workspaceEpochId: input.workspaceEpochId,
          }),
          workspaceId: input.workspaceId,
          workspaceEpochId: input.workspaceEpochId,
          repositoryPath: input.repositoryPath,
          invocationOwnerToken: input.invocationOwnerToken,
          helperCapability: input.helperCapability,
          readRetentionRoots: input.readCandidateRetentionRoots,
          retireCandidateRef:
            input.retireCandidateRef ?? retireCandidateRefWithGitoxideHelperInternal,
        },
        request.olderThanMs,
        request.maxEntries,
        now(),
        input.failpoint,
      ).finally(() => {
        if (candidateInflight === started) candidateInflight = undefined;
      });
      candidateInflight = started;
      return started;
    },
  });
}

function assertPolicy(request: {
  readonly olderThanMs: number;
  readonly maxEntries: number;
}): void {
  if (
    !Number.isSafeInteger(request.olderThanMs) ||
    request.olderThanMs < 0 ||
    !Number.isSafeInteger(request.maxEntries) ||
    request.maxEntries < 1 ||
    request.maxEntries > 256
  ) {
    throw new Error('Gitoxide managed GC policy is invalid');
  }
}

async function collectMutationCandidates(
  input: {
    readonly root: string;
    readonly workspaceId: string;
    readonly workspaceEpochId: string;
    readonly repositoryPath: string;
    readonly invocationOwnerToken: object;
    readonly helperCapability: GitoxideHelperInvocationCapability;
    readonly readRetentionRoots: () => Promise<{
      readonly acceptedCommitOid: string;
      readonly protectedOperationIdentitySha256: readonly `sha256:${string}`[];
    }>;
    readonly retireCandidateRef: typeof retireCandidateRefWithGitoxideHelperInternal;
  },
  olderThanMs: number,
  maxEntries: number,
  now: number,
  failpoint?: (point: GitoxideManagedGcFailpoint) => void | Promise<void>,
): Promise<GitoxideManagedGcResultInternal> {
  const rootInfo = await lstat(input.root).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (!rootInfo)
    return Object.freeze({ protocol: 'gitoxide_managed_gc_v1', collected: 0, retained: 0 });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Gitoxide candidate GC root identity is invalid');
  }
  const entries = await readdir(input.root, { withFileTypes: true });
  if (entries.length > 4096) throw new Error('Gitoxide candidate GC inventory is unbounded');
  const roots = await input.readRetentionRoots();
  const protectedOperations = new Set(roots.protectedOperationIdentitySha256);
  let collected = 0;
  let retained = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(input.root, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Gitoxide candidate GC artifact identity is invalid');
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Gitoxide candidate GC artifact identity changed during collection');
    }
    const interrupted = /^\.gc-[0-9a-f-]{36}$/u.test(entry.name);
    if (interrupted) {
      if (collected >= maxEntries) {
        retained += 1;
        continue;
      }
      await rm(path, { force: true });
      collected += 1;
      continue;
    }
    if (!/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
      throw new Error('Gitoxide candidate GC receipt name is invalid');
    }
    const expired = now - info.mtimeMs >= olderThanMs;
    const operationIdentitySha256 = `sha256:${entry.name.slice(0, 64)}` as const;
    if (!expired || protectedOperations.has(operationIdentitySha256) || collected >= maxEntries) {
      retained += 1;
      continue;
    }
    const receipt = await readGitoxideMutationCandidateReceiptInternal(path);
    if (
      !receipt ||
      receipt.workspaceId !== input.workspaceId ||
      receipt.workspaceEpochId !== input.workspaceEpochId ||
      receipt.operationIdentitySha256 !== operationIdentitySha256 ||
      receipt.acceptedRef !== 'refs/maka/accepted' ||
      receipt.candidateRef !== `refs/maka/candidates/${entry.name.slice(0, 64)}`
    ) {
      throw new Error('Gitoxide candidate GC receipt identity is invalid');
    }
    await input.retireCandidateRef({
      invocationOwnerToken: input.invocationOwnerToken,
      capability: input.helperCapability,
      repositoryPath: input.repositoryPath,
      acceptedRef: receipt.acceptedRef,
      expectedAcceptedCommitOid: roots.acceptedCommitOid,
      candidateRef: receipt.candidateRef,
      expectedCandidateCommitOid: receipt.candidateCommitOid,
      managedTreePolicyVersion: 3,
    });
    await failpoint?.('after_candidate_ref_retired');
    const tombstone = join(input.root, `.gc-${randomUUID()}`);
    await rename(path, tombstone);
    await failpoint?.('after_candidate_receipt_tombstone');
    await rm(tombstone, { force: true });
    collected += 1;
  }
  return Object.freeze({ protocol: 'gitoxide_managed_gc_v1', collected, retained });
}

async function collect(
  orphanRoot: string,
  olderThanMs: number,
  maxEntries: number,
  now: number,
  failpoint?: (point: GitoxideManagedGcFailpoint) => void | Promise<void>,
): Promise<GitoxideManagedGcResultInternal> {
  let root;
  try {
    root = await lstat(orphanRoot);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return Object.freeze({
        protocol: 'gitoxide_managed_gc_v1' as const,
        collected: 0,
        retained: 0,
      });
    }
    throw error;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('Gitoxide managed GC root identity is invalid');
  }
  const entries = await readdir(orphanRoot, { withFileTypes: true });
  if (entries.length > 4096) throw new Error('Gitoxide managed GC inventory is unbounded');
  let collected = 0;
  let retained = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(orphanRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Gitoxide managed GC artifact identity is invalid');
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Gitoxide managed GC artifact identity changed during collection');
    }
    const interrupted = entry.name.startsWith('.gc-');
    const expired = now - info.mtimeMs >= olderThanMs;
    if ((!interrupted && !expired) || collected >= maxEntries) {
      retained += 1;
      continue;
    }
    const tombstonePath = interrupted ? path : join(orphanRoot, `.gc-${randomUUID()}`);
    if (!interrupted) {
      await rename(path, tombstonePath);
      await failpoint?.('after_restore_orphan_tombstone');
    }
    await rm(tombstonePath, { recursive: true, force: true });
    collected += 1;
  }
  return Object.freeze({
    protocol: 'gitoxide_managed_gc_v1' as const,
    collected,
    retained,
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
