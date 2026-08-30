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

import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export type ResumableWorkspaceSourceKindInternal = 'git_repository_v1' | 'filesystem_snapshot_v1';

export interface ResumableWorkspaceSourceAdmissionCapabilityInternal {
  readonly kind: 'resumable_workspace_source_admission_capability_v1';
}

export interface ResumableWorkspaceSourceAdmissionInternal {
  readonly protocolVersion: 1;
  readonly kind: ResumableWorkspaceSourceKindInternal;
  readonly sourceRoot: string;
}

interface CapabilityRecord {
  readonly ownerToken: object;
  readonly admission: ResumableWorkspaceSourceAdmissionInternal;
}

const capabilities = new WeakMap<object, CapabilityRecord>();

export class ResumableWorkspaceSourceAdmissionError extends Error {
  constructor(
    readonly code:
      | 'resumable_workspace_source_invalid'
      | 'resumable_workspace_source_admission_capability_invalid',
  ) {
    super(
      code === 'resumable_workspace_source_invalid'
        ? 'Resumable workspace source must be a real directory'
        : 'Resumable workspace source admission capability is invalid',
    );
    this.name = 'ResumableWorkspaceSourceAdmissionError';
  }
}

/**
 * Classifies one canonical source root before any durable task fact is written.
 * A Git marker owns the route even when malformed: downstream Git admission
 * must reject it instead of silently importing it as an ordinary directory.
 */
export async function admitResumableWorkspaceSourceInternal(input: {
  readonly ownerToken: object;
  readonly sourceRoot: string;
  readonly abortSignal?: AbortSignal;
}): Promise<ResumableWorkspaceSourceAdmissionCapabilityInternal> {
  input.abortSignal?.throwIfAborted();
  const sourceInfo = await lstat(input.sourceRoot).catch(() => undefined);
  if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new ResumableWorkspaceSourceAdmissionError('resumable_workspace_source_invalid');
  }
  const sourceRoot = await realpath(input.sourceRoot);
  input.abortSignal?.throwIfAborted();
  const kind = (await hasGitIdentity(sourceRoot)) ? 'git_repository_v1' : 'filesystem_snapshot_v1';
  const capability = Object.freeze({
    kind: 'resumable_workspace_source_admission_capability_v1' as const,
  });
  capabilities.set(capability, {
    ownerToken: input.ownerToken,
    admission: Object.freeze({ protocolVersion: 1 as const, kind, sourceRoot }),
  });
  return capability;
}

export function requireResumableWorkspaceSourceAdmissionInternal(
  ownerToken: object,
  capability: ResumableWorkspaceSourceAdmissionCapabilityInternal,
): ResumableWorkspaceSourceAdmissionInternal {
  const record = capabilities.get(capability);
  if (!record || record.ownerToken !== ownerToken) {
    throw new ResumableWorkspaceSourceAdmissionError(
      'resumable_workspace_source_admission_capability_invalid',
    );
  }
  return record.admission;
}

async function hasGitIdentity(sourceRoot: string): Promise<boolean> {
  if (await pathExists(join(sourceRoot, '.git'))) return true;
  const [head, objects, refs] = await Promise.all([
    lstat(join(sourceRoot, 'HEAD')).catch(() => undefined),
    lstat(join(sourceRoot, 'objects')).catch(() => undefined),
    lstat(join(sourceRoot, 'refs')).catch(() => undefined),
  ]);
  return Boolean(
    head?.isFile() &&
      !head.isSymbolicLink() &&
      objects?.isDirectory() &&
      !objects.isSymbolicLink() &&
      refs?.isDirectory() &&
      !refs.isSymbolicLink(),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
