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

import type { GitReviewFile, GitReviewSnapshot } from '@maka/core/git-review';
import { requireEncodedByteLimit, requireEntityId, requireExactRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

const RESULT_MAX_BYTES = 640 * 1024;
const REVIEW_MAX_FILES = 200;
const REVISION_PATTERN = /^[0-9a-f]{64}$/u;
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const PUBLISH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface ManagedWorkspaceReviewQueryInput {
  readonly sessionId: string;
}

export interface ManagedWorkspaceReviewQueryResult {
  readonly kind: 'accepted_review';
  readonly snapshot: GitReviewSnapshot;
}

export interface ManagedWorkspacePublishInput {
  readonly sessionId: string;
  readonly publishId: string;
}

export interface ManagedWorkspacePublishResult {
  readonly kind: 'accepted_snapshot_published';
  readonly publishId: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly publishedRef: string;
  readonly replayed: boolean;
}

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;

export const MANAGED_WORKSPACE_REVIEW_OPERATION_SPECS = {
  'managed-workspace.review.query': defineOperation<
    ManagedWorkspaceReviewQueryInput,
    ManagedWorkspaceReviewQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput(value) {
      const record = requireExactRecord(value, 'managed workspace review query', ['sessionId']);
      return { sessionId: requireEntityId(record.sessionId, 'managed review Session id') };
    },
    decodeOutput: decodeManagedWorkspaceReviewQueryResult,
  }),
  'managed-workspace.publish.mutate': defineOperation<
    ManagedWorkspacePublishInput,
    ManagedWorkspacePublishResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput(value) {
      const record = requireExactRecord(value, 'managed workspace publication', [
        'sessionId',
        'publishId',
      ]);
      const publishId = requireEntityId(record.publishId, 'managed publication id');
      if (!PUBLISH_ID_PATTERN.test(publishId)) {
        throw invalidProtocolFrame('Invalid managed publication id');
      }
      return {
        sessionId: requireEntityId(record.sessionId, 'managed publication Session id'),
        publishId,
      };
    },
    decodeOutput: decodeManagedWorkspacePublishResult,
    assertOutputForInput(input, output) {
      if (
        output.publishId !== input.publishId ||
        output.publishedRef !== `refs/maka/published/${input.publishId}`
      ) {
        throw invalidProtocolFrame('Managed workspace publication conflicts with its request');
      }
    },
  }),
} as const;

export function decodeManagedWorkspacePublishResult(value: unknown): ManagedWorkspacePublishResult {
  const record = requireExactRecord(value, 'managed workspace publication result', [
    'kind',
    'publishId',
    'acceptedCommitOid',
    'acceptedTreeOid',
    'publishedRef',
    'replayed',
  ]);
  if (
    record.kind !== 'accepted_snapshot_published' ||
    typeof record.publishId !== 'string' ||
    !PUBLISH_ID_PATTERN.test(record.publishId) ||
    typeof record.acceptedCommitOid !== 'string' ||
    !SHA1_PATTERN.test(record.acceptedCommitOid) ||
    typeof record.acceptedTreeOid !== 'string' ||
    !SHA1_PATTERN.test(record.acceptedTreeOid) ||
    typeof record.publishedRef !== 'string' ||
    record.publishedRef !== `refs/maka/published/${record.publishId}` ||
    typeof record.replayed !== 'boolean'
  ) {
    throw invalidProtocolFrame('Invalid managed workspace published ref');
  }
  return {
    kind: 'accepted_snapshot_published',
    publishId: record.publishId,
    acceptedCommitOid: record.acceptedCommitOid,
    acceptedTreeOid: record.acceptedTreeOid,
    publishedRef: record.publishedRef,
    replayed: record.replayed,
  };
}

export function decodeManagedWorkspaceReviewQueryResult(
  value: unknown,
): ManagedWorkspaceReviewQueryResult {
  requireEncodedByteLimit(value, 'managed workspace review result', RESULT_MAX_BYTES);
  const record = requireExactRecord(value, 'managed workspace review result', ['kind', 'snapshot']);
  if (record.kind !== 'accepted_review') {
    throw invalidProtocolFrame('Invalid managed workspace review result kind');
  }
  return { kind: 'accepted_review', snapshot: decodeSnapshot(record.snapshot) };
}

function decodeSnapshot(value: unknown): GitReviewSnapshot {
  const record = requireExactRecord(value, 'managed workspace review snapshot', [
    'source',
    'repositoryRoot',
    'currentBranch',
    'baseBranch',
    'baseBranchOptions',
    'revision',
    'files',
    'additions',
    'deletions',
    'truncated',
  ]);
  if (
    record.source !== 'branch' ||
    typeof record.repositoryRoot !== 'string' ||
    !record.repositoryRoot.startsWith('maka-managed://') ||
    record.currentBranch !== null ||
    record.baseBranch !== null ||
    !Array.isArray(record.baseBranchOptions) ||
    record.baseBranchOptions.length !== 0 ||
    typeof record.revision !== 'string' ||
    !REVISION_PATTERN.test(record.revision) ||
    !Array.isArray(record.files) ||
    record.files.length > REVIEW_MAX_FILES ||
    !record.files.every(isReviewFile) ||
    !isCount(record.additions) ||
    !isCount(record.deletions) ||
    typeof record.truncated !== 'boolean'
  ) {
    throw invalidProtocolFrame('Invalid managed workspace review snapshot');
  }
  const files = record.files as GitReviewFile[];
  if (
    files.reduce((sum, file) => sum + file.additions, 0) !== record.additions ||
    files.reduce((sum, file) => sum + file.deletions, 0) !== record.deletions ||
    new Set(files.map((file) => file.path)).size !== files.length
  ) {
    throw invalidProtocolFrame('Managed workspace review totals conflict with its files');
  }
  return {
    source: 'branch',
    repositoryRoot: record.repositoryRoot,
    currentBranch: null,
    baseBranch: null,
    baseBranchOptions: [],
    revision: record.revision,
    files,
    additions: record.additions,
    deletions: record.deletions,
    truncated: record.truncated,
  };
}

function isReviewFile(value: unknown): value is GitReviewFile {
  try {
    const record = requireExactRecord(value, 'managed workspace review file', [
      'path',
      'status',
      'diff',
      'additions',
      'deletions',
    ]);
    return (
      typeof record.path === 'string' &&
      record.path.length > 0 &&
      Buffer.byteLength(record.path, 'utf8') <= 4096 &&
      !record.path.includes('\0') &&
      ['added', 'modified', 'deleted'].includes(String(record.status)) &&
      typeof record.diff === 'string' &&
      Buffer.byteLength(record.diff, 'utf8') <= 32 * 1024 + 8192 &&
      isCount(record.additions) &&
      isCount(record.deletions)
    );
  } catch {
    return false;
  }
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
