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
import test from 'node:test';
import { decodeManagedWorkspaceReviewQueryResult } from '../protocol/managed-workspace-review.js';

const valid = {
  kind: 'accepted_review',
  snapshot: {
    source: 'branch',
    repositoryRoot: 'maka-managed://session-1',
    currentBranch: null,
    baseBranch: null,
    baseBranchOptions: [],
    revision: 'a'.repeat(64),
    files: [
      {
        path: 'src/example.ts',
        status: 'modified',
        diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,1 +1,1 @@\n-old\n+new',
        additions: 1,
        deletions: 1,
      },
    ],
    additions: 1,
    deletions: 1,
    truncated: false,
  },
} as const;

test('managed Review protocol accepts one bounded accepted-tree projection', () => {
  assert.deepEqual(decodeManagedWorkspaceReviewQueryResult(valid), valid);
});

test('managed Review protocol rejects totals that do not match its files', () => {
  assert.throws(
    () =>
      decodeManagedWorkspaceReviewQueryResult({
        ...valid,
        snapshot: { ...valid.snapshot, additions: 2 },
      }),
    /totals conflict/u,
  );
});
