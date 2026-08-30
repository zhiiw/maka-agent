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

import { isCanonicalManagedMutationPathV1 } from '@maka/core/runtime-event';
import type { FilesystemWorkerClientOperation } from '@maka/runtime/filesystem-worker';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import {
  grepGitoxideTreeFilesInternal,
  listGitoxideTreeFilesInternal,
  readGitoxideTreeFileInternal,
  reopenGitoxideAcceptedRepositoryInternal,
} from './gitoxide-repository-admission-authority-internal.js';

const ACCEPTED_REF = 'refs/maka/accepted';
const MAX_QUERY_RESULTS = 200;

export type GitoxideManagedInspectionOperationInternal = Extract<
  FilesystemWorkerClientOperation,
  { kind: 'read' | 'glob' | 'grep' }
>;

export type GitoxideManagedInspectionResultInternal =
  | { readonly kind: 'read'; readonly content: string }
  | { readonly kind: 'glob'; readonly files: readonly string[] }
  | { readonly kind: 'grep'; readonly matches: readonly string[] };

export interface GitoxideManagedInspectionOwnerInternal {
  execute(
    operation: GitoxideManagedInspectionOperationInternal,
    abortSignal?: AbortSignal,
  ): Promise<GitoxideManagedInspectionResultInternal>;
}

export function createGitoxideManagedInspectionOwnerInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly readAcceptedIdentity: () => Promise<{
    readonly commitOid: string;
    readonly treeOid: string;
  }>;
}): GitoxideManagedInspectionOwnerInternal {
  const owner: GitoxideManagedInspectionOwnerInternal = {
    async execute(
      operation: GitoxideManagedInspectionOperationInternal,
      abortSignal?: AbortSignal,
    ): Promise<GitoxideManagedInspectionResultInternal> {
      abortSignal?.throwIfAborted();
      const identity = await input.readAcceptedIdentity();
      abortSignal?.throwIfAborted();
      const acceptedRepositoryOwnerToken = {};
      const accepted = await reopenGitoxideAcceptedRepositoryInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        helperCapability: input.helperCapability,
        acceptedRepositoryOwnerToken,
        repositoryPath: input.repositoryPath,
        acceptedRef: ACCEPTED_REF,
        expectedAcceptedCommitOid: identity.commitOid,
        expectedAcceptedTreeOid: identity.treeOid,
        managedTreePolicyVersion: 3,
        ...(abortSignal ? { abortSignal } : {}),
      });
      const capability = accepted.acceptedRepositoryCapability;
      switch (operation.kind) {
        case 'read': {
          const path = requireManagedPath(operation.path);
          const result = await readGitoxideTreeFileInternal({
            acceptedRepositoryOwnerToken,
            acceptedRepositoryCapability: capability,
            path,
            ...(abortSignal ? { abortSignal } : {}),
          });
          if (operation.offset === undefined && operation.limit === undefined) {
            return Object.freeze({ kind: 'read' as const, content: result.content });
          }
          const lines = result.content.split('\n');
          const start = operation.offset ?? 0;
          const end = operation.limit === undefined ? lines.length : start + operation.limit;
          return Object.freeze({
            kind: 'read' as const,
            content: lines.slice(start, end).join('\n'),
          });
        }
        case 'glob': {
          const result = await listGitoxideTreeFilesInternal({
            acceptedRepositoryOwnerToken,
            acceptedRepositoryCapability: capability,
            path: requireManagedQueryPath(operation.path),
            pattern: operation.pattern,
            limit: Math.min(operation.limit ?? MAX_QUERY_RESULTS, MAX_QUERY_RESULTS),
            ...(abortSignal ? { abortSignal } : {}),
          });
          return Object.freeze({ kind: 'glob' as const, files: Object.freeze([...result.files]) });
        }
        case 'grep': {
          const result = await grepGitoxideTreeFilesInternal({
            acceptedRepositoryOwnerToken,
            acceptedRepositoryCapability: capability,
            path: requireManagedQueryPath(operation.path),
            pattern: operation.pattern,
            ...(operation.glob === undefined ? {} : { glob: operation.glob }),
            maxCountPerFile: operation.maxCountPerFile,
            limit: Math.min(operation.limit, MAX_QUERY_RESULTS),
            timeoutMs: operation.timeoutMs,
            ...(abortSignal ? { abortSignal } : {}),
          });
          return Object.freeze({
            kind: 'grep' as const,
            matches: Object.freeze([...result.matches]),
          });
        }
      }
      throw new Error('Gitoxide managed inspection operation is unsupported');
    },
  };
  return Object.freeze(owner);
}

function requireManagedPath(value: string): string {
  if (!isCanonicalManagedMutationPathV1(value)) {
    throw new Error('Gitoxide managed inspection path must already be canonical');
  }
  return value;
}

function requireManagedQueryPath(value: string): string {
  return value === '.' ? value : requireManagedPath(value);
}
