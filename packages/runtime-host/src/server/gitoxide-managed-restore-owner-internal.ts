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
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import { materializeAcceptedTreeWithGitoxideHelperInternal } from './gitoxide-helper-invocation-internal.js';

const RESTORE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export interface GitoxideManagedRestoreResultInternal {
  readonly protocol: 'gitoxide_managed_restore_v1';
  readonly restoreId: string;
  readonly destinationPath: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly filesMaterialized: number;
  readonly bytesMaterialized: number;
}

export interface GitoxideManagedRestoreOwnerInternal {
  restore(
    restoreId: string,
    abortSignal?: AbortSignal,
  ): Promise<GitoxideManagedRestoreResultInternal>;
}

export function createGitoxideManagedRestoreOwnerInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly storageRoot: string;
  readonly workspaceEpochId: string;
  readonly readAcceptedIdentity: () => Promise<{
    readonly commitOid: string;
    readonly treeOid: string;
  }>;
}): GitoxideManagedRestoreOwnerInternal {
  const inflight = new Map<string, Promise<GitoxideManagedRestoreResultInternal>>();
  const owner: GitoxideManagedRestoreOwnerInternal = {
    restore(restoreId, abortSignal) {
      if (!RESTORE_ID_PATTERN.test(restoreId)) {
        return Promise.reject(new Error('Gitoxide managed restore identity is invalid'));
      }
      const existing = inflight.get(restoreId);
      if (existing) return existing;
      const started = restoreOnce(input, restoreId, abortSignal).finally(() => {
        if (inflight.get(restoreId) === started) inflight.delete(restoreId);
      });
      inflight.set(restoreId, started);
      return started;
    },
  };
  return Object.freeze(owner);
}

async function restoreOnce(
  input: Parameters<typeof createGitoxideManagedRestoreOwnerInternal>[0],
  restoreId: string,
  abortSignal?: AbortSignal,
): Promise<GitoxideManagedRestoreResultInternal> {
  abortSignal?.throwIfAborted();
  const accepted = await input.readAcceptedIdentity();
  abortSignal?.throwIfAborted();
  const ownerRoot = join(input.storageRoot, 'gitoxide-managed-restores', input.workspaceEpochId);
  const orphanRoot = join(ownerRoot, 'orphans');
  const restoreRoot = join(ownerRoot, restoreId);
  const stagingPath = join(restoreRoot, 'workspace.staging');
  const destinationPath = join(restoreRoot, 'workspace');
  const intentPath = join(restoreRoot, 'restore-intent.json');
  const receiptPath = join(restoreRoot, 'restore-receipt.json');
  await mkdir(orphanRoot, { recursive: true });
  await mkdir(restoreRoot, { recursive: true });
  await rotateIfPresent(stagingPath, orphanRoot, `${restoreId}-staging`);
  await rotateIfPresent(destinationPath, orphanRoot, `${restoreId}-workspace`);
  await rm(receiptPath, { force: true });
  await rm(intentPath, { force: true });
  await writeJsonAtomically(intentPath, {
    protocol: 'gitoxide_managed_restore_intent_v1',
    restoreId,
    acceptedCommitOid: accepted.commitOid,
    acceptedTreeOid: accepted.treeOid,
  });
  const materialized = await materializeAcceptedTreeWithGitoxideHelperInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    capability: input.helperCapability,
    repositoryPath: input.repositoryPath,
    acceptedCommitOid: accepted.commitOid,
    destinationPath: stagingPath,
    managedTreePolicyVersion: 3,
    ...(abortSignal ? { abortSignal } : {}),
  });
  if (materialized.acceptedTreeOid !== accepted.treeOid) {
    throw new Error('Gitoxide managed restore conflicts with the durable accepted tree');
  }
  abortSignal?.throwIfAborted();
  await rename(stagingPath, destinationPath);
  const result: GitoxideManagedRestoreResultInternal = Object.freeze({
    protocol: 'gitoxide_managed_restore_v1' as const,
    restoreId,
    destinationPath,
    acceptedCommitOid: materialized.acceptedCommitOid,
    acceptedTreeOid: materialized.acceptedTreeOid,
    filesMaterialized: materialized.filesMaterialized,
    bytesMaterialized: materialized.bytesMaterialized,
  });
  await writeJsonAtomically(receiptPath, result);
  await rm(intentPath, { force: true });
  return result;
}

async function rotateIfPresent(path: string, orphanRoot: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Gitoxide managed restore artifact identity is invalid');
  }
  await rename(path, join(orphanRoot, `${label}-${randomUUID()}`));
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, path);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
