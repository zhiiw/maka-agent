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
}

export type GitoxideManagedGcFailpoint = 'after_restore_orphan_tombstone';

export function createGitoxideManagedGcOwnerInternal(input: {
  readonly storageRoot: string;
  readonly workspaceEpochId: string;
  readonly now?: () => number;
  readonly failpoint?: (point: GitoxideManagedGcFailpoint) => void | Promise<void>;
}): GitoxideManagedGcOwnerInternal {
  const now = input.now ?? Date.now;
  let inflight: Promise<GitoxideManagedGcResultInternal> | undefined;
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
      if (inflight) return inflight;
      const started = collect(
        join(input.storageRoot, 'gitoxide-managed-restores', input.workspaceEpochId, 'orphans'),
        request.olderThanMs,
        request.maxEntries,
        now(),
        input.failpoint,
      ).finally(() => {
        if (inflight === started) inflight = undefined;
      });
      inflight = started;
      return started;
    },
  });
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
