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

import { createHash } from 'node:crypto';
import type { GitReviewFile, GitReviewSnapshot } from '@maka/core/git-review';
import { countDiffLineStats } from '@maka/core/unified-diff';
import { createUnifiedDiff } from '@maka/runtime/unified-diff';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import {
  compareAcceptedTreesWithGitoxideHelperInternal,
  type GitoxideAcceptedTreesComparedV1,
} from './gitoxide-helper-invocation-internal.js';

const REVIEW_FILES_ENCODED_BUDGET = 512 * 1024;

export interface GitoxideManagedReviewBoundaryInternal {
  readonly baselineCommitOid: string;
  readonly baselineTreeOid: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
}

export interface GitoxideManagedReviewOwnerInternal {
  diff(abortSignal?: AbortSignal): Promise<GitoxideAcceptedTreesComparedV1>;
  read(sessionId: string, abortSignal?: AbortSignal): Promise<GitReviewSnapshot>;
}

export function createGitoxideManagedReviewOwnerInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly readReviewBoundary: () => Promise<GitoxideManagedReviewBoundaryInternal>;
}): GitoxideManagedReviewOwnerInternal {
  const owner: GitoxideManagedReviewOwnerInternal = {
    async diff(abortSignal?: AbortSignal): Promise<GitoxideAcceptedTreesComparedV1> {
      abortSignal?.throwIfAborted();
      const boundary = await input.readReviewBoundary();
      abortSignal?.throwIfAborted();
      const compared = await compareAcceptedTreesWithGitoxideHelperInternal({
        invocationOwnerToken: input.invocationOwnerToken,
        capability: input.helperCapability,
        repositoryPath: input.repositoryPath,
        baselineCommitOid: boundary.baselineCommitOid,
        acceptedCommitOid: boundary.acceptedCommitOid,
        managedTreePolicyVersion: 3,
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (
        compared.baselineCommitOid !== boundary.baselineCommitOid ||
        compared.baselineTreeOid !== boundary.baselineTreeOid ||
        compared.acceptedCommitOid !== boundary.acceptedCommitOid ||
        compared.acceptedTreeOid !== boundary.acceptedTreeOid
      ) {
        throw new Error('Gitoxide managed review conflicts with its durable workspace boundary');
      }
      return compared;
    },
    async read(sessionId: string, abortSignal?: AbortSignal): Promise<GitReviewSnapshot> {
      const compared = await owner.diff(abortSignal);
      const files: GitReviewFile[] = [];
      let encodedBytes = 0;
      for (const change of compared.changes) {
        const file = toReviewFile(change);
        const nextBytes = Buffer.byteLength(JSON.stringify(file), 'utf8');
        if (encodedBytes + nextBytes > REVIEW_FILES_ENCODED_BUDGET) break;
        files.push(file);
        encodedBytes += nextBytes;
      }
      return {
        source: 'branch',
        repositoryRoot: `maka-managed://${sessionId}`,
        currentBranch: null,
        baseBranch: null,
        baseBranchOptions: [],
        revision: createHash('sha256')
          .update(
            JSON.stringify({
              baselineCommitOid: compared.baselineCommitOid,
              baselineTreeOid: compared.baselineTreeOid,
              acceptedCommitOid: compared.acceptedCommitOid,
              acceptedTreeOid: compared.acceptedTreeOid,
              changes: compared.changes,
            }),
          )
          .digest('hex'),
        files,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        truncated: compared.truncated || files.length < compared.changes.length,
      };
    },
  };
  return Object.freeze(owner);
}

function toReviewFile(change: GitoxideAcceptedTreesComparedV1['changes'][number]): GitReviewFile {
  const diff = reviewDiff(change);
  return {
    path: change.path,
    status: change.status === 'added' || change.status === 'deleted' ? change.status : 'modified',
    diff,
    ...countDiffLineStats(diff),
  };
}

function reviewDiff(change: GitoxideAcceptedTreesComparedV1['changes'][number]): string {
  if (change.status === 'mode_changed') {
    return [
      `diff --git a/${change.path} b/${change.path}`,
      `old mode ${change.oldExecutable ? '100755' : '100644'}`,
      `new mode ${change.newExecutable ? '100755' : '100644'}`,
    ].join('\n');
  }
  if (!change.diffable) {
    const oldPath = change.status === 'added' ? '/dev/null' : `a/${change.path}`;
    const newPath = change.status === 'deleted' ? '/dev/null' : `b/${change.path}`;
    return `Binary or oversized files ${oldPath} and ${newPath} differ\n`;
  }
  if (change.status === 'deleted') {
    return deletedUnifiedDiff(change.path, change.oldContent!);
  }
  return (
    createUnifiedDiff(change.path, change.oldContent, change.newContent!) ??
    `Binary or oversized files a/${change.path} and b/${change.path} differ\n`
  );
}

function deletedUnifiedDiff(path: string, content: string): string {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > 800) {
    return `Binary or oversized files a/${path} and /dev/null differ\n`;
  }
  return [
    `--- a/${path}`,
    '+++ /dev/null',
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((line) => `-${line}`),
  ].join('\n');
}
