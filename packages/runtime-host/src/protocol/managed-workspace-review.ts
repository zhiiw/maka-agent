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
const RESTORE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const VERSION_ID_PATTERN = /^version_[a-z0-9_-]{1,96}$/u;

export interface ManagedWorkspaceReviewQueryInput {
  readonly sessionId: string;
}

export interface ManagedWorkspaceReviewQueryResult {
  readonly kind: 'accepted_review';
  readonly sourceKind: 'git_repository_v1' | 'filesystem_snapshot_v1';
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

export interface ManagedWorkspaceSourceBranchPublishInput {
  readonly sessionId: string;
  readonly publishId: string;
}

export interface ManagedWorkspaceSourceBranchPublishResult {
  readonly kind: 'accepted_source_branch_published';
  readonly publishId: string;
  readonly sourceBaseCommitOid: string;
  readonly sourceBaseTreeOid: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly publishedCommitOid: string;
  readonly publishedRef: string;
  readonly replayed: boolean;
}

export interface ManagedWorkspaceRestoreInput {
  readonly sessionId: string;
  readonly restoreId: string;
}

export interface ManagedWorkspaceRestoreResult {
  readonly kind: 'accepted_snapshot_restored';
  readonly restoreId: string;
  readonly destinationPath: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly filesMaterialized: number;
  readonly bytesMaterialized: number;
}

export interface ManagedWorkspaceHistoryInput {
  readonly sessionId: string;
  readonly limit: number;
}

export interface ManagedWorkspaceHistoryEntry {
  readonly workspaceVersionId: string;
  readonly parentWorkspaceVersionId: string | null;
  readonly commitOid: string;
  readonly treeOid: string;
  readonly acceptedEventId: string;
  readonly committedAt: number;
  readonly kind: 'baseline' | 'tool_mutation' | 'history_restore';
  readonly changedFileCount: number;
}

export interface ManagedWorkspaceHistoryResult {
  readonly kind: 'accepted_history';
  readonly headWorkspaceVersionId: string;
  readonly versions: readonly ManagedWorkspaceHistoryEntry[];
  readonly hasMore: boolean;
}

export interface ManagedWorkspaceHistoricalRestoreInput {
  readonly sessionId: string;
  readonly workspaceVersionId: string;
  readonly restoreId: string;
}

export interface ManagedWorkspaceHistoricalRestoreResult extends ManagedWorkspaceRestoreResult {
  readonly workspaceVersionId: string;
}

export interface ManagedWorkspaceHistoryUndoInput {
  readonly sessionId: string;
  readonly workspaceVersionId: string;
  readonly restoreId: string;
}

export interface ManagedWorkspaceHistoryUndoResult {
  readonly kind: 'accepted_history_successor';
  readonly restoreId: string;
  readonly targetWorkspaceVersionId: string;
  readonly workspaceVersionId: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly revision: number;
  readonly created: boolean;
}

export interface ManagedWorkspaceRebaselineInput {
  readonly sessionId: string;
  readonly rebaselineId: string;
}

export interface ManagedWorkspaceRebaselineResult {
  readonly kind: 'managed_workspace_rebaselined';
  readonly rebaselineId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly baselineWorkspaceVersionId: string;
  readonly sourceKind: 'git_repository_v1' | 'filesystem_snapshot_v1';
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
  'managed-workspace.source-branch.publish.mutate': defineOperation<
    ManagedWorkspaceSourceBranchPublishInput,
    ManagedWorkspaceSourceBranchPublishResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput(value) {
      const record = requireExactRecord(value, 'managed workspace source branch publication', [
        'sessionId',
        'publishId',
      ]);
      const publishId = requireEntityId(record.publishId, 'managed source branch publication id');
      if (!PUBLISH_ID_PATTERN.test(publishId)) {
        throw invalidProtocolFrame('Invalid managed source branch publication id');
      }
      return {
        sessionId: requireEntityId(
          record.sessionId,
          'managed source branch publication Session id',
        ),
        publishId,
      };
    },
    decodeOutput: decodeManagedWorkspaceSourceBranchPublishResult,
    assertOutputForInput(input, output) {
      if (
        output.publishId !== input.publishId ||
        output.publishedRef !== `refs/heads/maka/${input.publishId}`
      ) {
        throw invalidProtocolFrame(
          'Managed workspace source branch publication conflicts with its request',
        );
      }
    },
  }),
  'managed-workspace.restore.mutate': defineOperation<
    ManagedWorkspaceRestoreInput,
    ManagedWorkspaceRestoreResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput(value) {
      const record = requireExactRecord(value, 'managed workspace restore', [
        'sessionId',
        'restoreId',
      ]);
      const restoreId = requireEntityId(record.restoreId, 'managed restore id');
      if (!RESTORE_ID_PATTERN.test(restoreId)) {
        throw invalidProtocolFrame('Invalid managed restore id');
      }
      return {
        sessionId: requireEntityId(record.sessionId, 'managed restore Session id'),
        restoreId,
      };
    },
    decodeOutput: decodeManagedWorkspaceRestoreResult,
    assertOutputForInput(input, output) {
      if (output.restoreId !== input.restoreId) {
        throw invalidProtocolFrame('Managed workspace restore conflicts with its request');
      }
    },
  }),
  'managed-workspace.history.query': defineOperation<
    ManagedWorkspaceHistoryInput,
    ManagedWorkspaceHistoryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput(value) {
      const record = requireExactRecord(value, 'managed workspace history query', [
        'sessionId',
        'limit',
      ]);
      if (
        !Number.isSafeInteger(record.limit) ||
        (record.limit as number) < 1 ||
        (record.limit as number) > 100
      ) {
        throw invalidProtocolFrame('Invalid managed history limit');
      }
      return {
        sessionId: requireEntityId(record.sessionId, 'managed history Session id'),
        limit: record.limit as number,
      };
    },
    decodeOutput: decodeManagedWorkspaceHistoryResult,
    assertOutputForInput(input, output) {
      if (output.versions.length > input.limit) {
        throw invalidProtocolFrame('Managed workspace history exceeds its requested limit');
      }
    },
  }),
  'managed-workspace.history.restore.mutate': defineOperation<
    ManagedWorkspaceHistoricalRestoreInput,
    ManagedWorkspaceHistoricalRestoreResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput(value) {
      const record = requireExactRecord(value, 'managed workspace historical restore', [
        'sessionId',
        'workspaceVersionId',
        'restoreId',
      ]);
      const workspaceVersionId = requireEntityId(
        record.workspaceVersionId,
        'managed history workspace version id',
      );
      const restoreId = requireEntityId(record.restoreId, 'managed historical restore id');
      if (!VERSION_ID_PATTERN.test(workspaceVersionId) || !RESTORE_ID_PATTERN.test(restoreId)) {
        throw invalidProtocolFrame('Invalid managed historical restore identity');
      }
      return {
        sessionId: requireEntityId(record.sessionId, 'managed historical restore Session id'),
        workspaceVersionId,
        restoreId,
      };
    },
    decodeOutput: decodeManagedWorkspaceHistoricalRestoreResult,
    assertOutputForInput(input, output) {
      if (
        output.restoreId !== input.restoreId ||
        output.workspaceVersionId !== input.workspaceVersionId
      ) {
        throw invalidProtocolFrame('Managed historical restore conflicts with its request');
      }
    },
  }),
  'managed-workspace.history.undo.mutate': defineOperation<
    ManagedWorkspaceHistoryUndoInput,
    ManagedWorkspaceHistoryUndoResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput(value) {
      const record = requireExactRecord(value, 'managed workspace history undo', [
        'sessionId',
        'workspaceVersionId',
        'restoreId',
      ]);
      const workspaceVersionId = requireEntityId(
        record.workspaceVersionId,
        'managed history undo workspace version id',
      );
      const restoreId = requireEntityId(record.restoreId, 'managed history undo id');
      if (!VERSION_ID_PATTERN.test(workspaceVersionId) || !RESTORE_ID_PATTERN.test(restoreId)) {
        throw invalidProtocolFrame('Invalid managed history undo identity');
      }
      return {
        sessionId: requireEntityId(record.sessionId, 'managed history undo Session id'),
        workspaceVersionId,
        restoreId,
      };
    },
    decodeOutput: decodeManagedWorkspaceHistoryUndoResult,
    assertOutputForInput(input, output) {
      if (
        output.restoreId !== input.restoreId ||
        output.targetWorkspaceVersionId !== input.workspaceVersionId
      ) {
        throw invalidProtocolFrame('Managed history undo conflicts with its request');
      }
    },
  }),
  'managed-workspace.rebaseline.mutate': defineOperation<
    ManagedWorkspaceRebaselineInput,
    ManagedWorkspaceRebaselineResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput(value) {
      const record = requireExactRecord(value, 'managed workspace rebaseline', [
        'sessionId',
        'rebaselineId',
      ]);
      const rebaselineId = requireEntityId(record.rebaselineId, 'managed rebaseline id');
      if (!PUBLISH_ID_PATTERN.test(rebaselineId)) {
        throw invalidProtocolFrame('Invalid managed rebaseline identity');
      }
      return {
        sessionId: requireEntityId(record.sessionId, 'managed rebaseline Session id'),
        rebaselineId,
      };
    },
    decodeOutput: decodeManagedWorkspaceRebaselineResult,
    assertOutputForInput(input, output) {
      if (output.rebaselineId !== input.rebaselineId) {
        throw invalidProtocolFrame('Managed rebaseline conflicts with its request');
      }
    },
  }),
} as const;

export function decodeManagedWorkspaceRebaselineResult(
  value: unknown,
): ManagedWorkspaceRebaselineResult {
  const record = requireExactRecord(value, 'managed workspace rebaseline result', [
    'kind',
    'rebaselineId',
    'workspaceId',
    'workspaceEpochId',
    'baselineWorkspaceVersionId',
    'sourceKind',
  ]);
  if (
    record.kind !== 'managed_workspace_rebaselined' ||
    typeof record.rebaselineId !== 'string' ||
    !PUBLISH_ID_PATTERN.test(record.rebaselineId) ||
    typeof record.workspaceId !== 'string' ||
    !/^workspace_[a-f0-9]{32}$/u.test(record.workspaceId) ||
    typeof record.workspaceEpochId !== 'string' ||
    !/^epoch_[a-f0-9]{32}$/u.test(record.workspaceEpochId) ||
    typeof record.baselineWorkspaceVersionId !== 'string' ||
    !VERSION_ID_PATTERN.test(record.baselineWorkspaceVersionId) ||
    (record.sourceKind !== 'git_repository_v1' && record.sourceKind !== 'filesystem_snapshot_v1')
  ) {
    throw invalidProtocolFrame('Invalid managed workspace rebaseline result');
  }
  return record as unknown as ManagedWorkspaceRebaselineResult;
}

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

export function decodeManagedWorkspaceSourceBranchPublishResult(
  value: unknown,
): ManagedWorkspaceSourceBranchPublishResult {
  const record = requireExactRecord(value, 'managed workspace source branch publication result', [
    'kind',
    'publishId',
    'sourceBaseCommitOid',
    'sourceBaseTreeOid',
    'acceptedCommitOid',
    'acceptedTreeOid',
    'publishedCommitOid',
    'publishedRef',
    'replayed',
  ]);
  if (
    record.kind !== 'accepted_source_branch_published' ||
    typeof record.publishId !== 'string' ||
    !PUBLISH_ID_PATTERN.test(record.publishId) ||
    typeof record.sourceBaseCommitOid !== 'string' ||
    !SHA1_PATTERN.test(record.sourceBaseCommitOid) ||
    typeof record.sourceBaseTreeOid !== 'string' ||
    !SHA1_PATTERN.test(record.sourceBaseTreeOid) ||
    typeof record.acceptedCommitOid !== 'string' ||
    !SHA1_PATTERN.test(record.acceptedCommitOid) ||
    typeof record.acceptedTreeOid !== 'string' ||
    !SHA1_PATTERN.test(record.acceptedTreeOid) ||
    typeof record.publishedCommitOid !== 'string' ||
    !SHA1_PATTERN.test(record.publishedCommitOid) ||
    typeof record.publishedRef !== 'string' ||
    record.publishedRef !== `refs/heads/maka/${record.publishId}` ||
    typeof record.replayed !== 'boolean'
  ) {
    throw invalidProtocolFrame('Invalid managed workspace source branch published ref');
  }
  return record as unknown as ManagedWorkspaceSourceBranchPublishResult;
}

export function decodeManagedWorkspaceRestoreResult(value: unknown): ManagedWorkspaceRestoreResult {
  const record = requireExactRecord(value, 'managed workspace restore result', [
    'kind',
    'restoreId',
    'destinationPath',
    'acceptedCommitOid',
    'acceptedTreeOid',
    'filesMaterialized',
    'bytesMaterialized',
  ]);
  if (
    record.kind !== 'accepted_snapshot_restored' ||
    typeof record.restoreId !== 'string' ||
    !RESTORE_ID_PATTERN.test(record.restoreId) ||
    typeof record.destinationPath !== 'string' ||
    record.destinationPath.length === 0 ||
    Buffer.byteLength(record.destinationPath, 'utf8') > 4096 ||
    record.destinationPath.includes('\0') ||
    typeof record.acceptedCommitOid !== 'string' ||
    !SHA1_PATTERN.test(record.acceptedCommitOid) ||
    typeof record.acceptedTreeOid !== 'string' ||
    !SHA1_PATTERN.test(record.acceptedTreeOid) ||
    !isCount(record.filesMaterialized) ||
    !isCount(record.bytesMaterialized)
  ) {
    throw invalidProtocolFrame('Invalid managed workspace restore result');
  }
  return {
    kind: 'accepted_snapshot_restored',
    restoreId: record.restoreId,
    destinationPath: record.destinationPath,
    acceptedCommitOid: record.acceptedCommitOid,
    acceptedTreeOid: record.acceptedTreeOid,
    filesMaterialized: record.filesMaterialized,
    bytesMaterialized: record.bytesMaterialized,
  };
}

export function decodeManagedWorkspaceHistoricalRestoreResult(
  value: unknown,
): ManagedWorkspaceHistoricalRestoreResult {
  const record = requireExactRecord(value, 'managed workspace historical restore result', [
    'kind',
    'restoreId',
    'workspaceVersionId',
    'destinationPath',
    'acceptedCommitOid',
    'acceptedTreeOid',
    'filesMaterialized',
    'bytesMaterialized',
  ]);
  const restored = decodeManagedWorkspaceRestoreResult({
    kind: record.kind,
    restoreId: record.restoreId,
    destinationPath: record.destinationPath,
    acceptedCommitOid: record.acceptedCommitOid,
    acceptedTreeOid: record.acceptedTreeOid,
    filesMaterialized: record.filesMaterialized,
    bytesMaterialized: record.bytesMaterialized,
  });
  if (
    typeof record.workspaceVersionId !== 'string' ||
    !VERSION_ID_PATTERN.test(record.workspaceVersionId)
  ) {
    throw invalidProtocolFrame('Invalid managed historical restore result');
  }
  return { ...restored, workspaceVersionId: record.workspaceVersionId };
}

export function decodeManagedWorkspaceHistoryUndoResult(
  value: unknown,
): ManagedWorkspaceHistoryUndoResult {
  const record = requireExactRecord(value, 'managed workspace history successor', [
    'kind',
    'restoreId',
    'targetWorkspaceVersionId',
    'workspaceVersionId',
    'acceptedCommitOid',
    'acceptedTreeOid',
    'revision',
    'created',
  ]);
  if (
    record.kind !== 'accepted_history_successor' ||
    typeof record.restoreId !== 'string' ||
    !RESTORE_ID_PATTERN.test(record.restoreId) ||
    typeof record.targetWorkspaceVersionId !== 'string' ||
    !VERSION_ID_PATTERN.test(record.targetWorkspaceVersionId) ||
    typeof record.workspaceVersionId !== 'string' ||
    !VERSION_ID_PATTERN.test(record.workspaceVersionId) ||
    record.workspaceVersionId === record.targetWorkspaceVersionId ||
    typeof record.acceptedCommitOid !== 'string' ||
    !SHA1_PATTERN.test(record.acceptedCommitOid) ||
    typeof record.acceptedTreeOid !== 'string' ||
    !SHA1_PATTERN.test(record.acceptedTreeOid) ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1 ||
    typeof record.created !== 'boolean'
  ) {
    throw invalidProtocolFrame('Invalid managed workspace history successor');
  }
  return {
    kind: 'accepted_history_successor',
    restoreId: record.restoreId,
    targetWorkspaceVersionId: record.targetWorkspaceVersionId,
    workspaceVersionId: record.workspaceVersionId,
    acceptedCommitOid: record.acceptedCommitOid,
    acceptedTreeOid: record.acceptedTreeOid,
    revision: record.revision as number,
    created: record.created,
  };
}

export function decodeManagedWorkspaceHistoryResult(value: unknown): ManagedWorkspaceHistoryResult {
  const record = requireExactRecord(value, 'managed workspace history result', [
    'kind',
    'headWorkspaceVersionId',
    'versions',
    'hasMore',
  ]);
  if (
    record.kind !== 'accepted_history' ||
    typeof record.headWorkspaceVersionId !== 'string' ||
    !VERSION_ID_PATTERN.test(record.headWorkspaceVersionId) ||
    !Array.isArray(record.versions) ||
    record.versions.length < 1 ||
    record.versions.length > 100 ||
    typeof record.hasMore !== 'boolean'
  ) {
    throw invalidProtocolFrame('Invalid managed workspace history result');
  }
  const versions = record.versions.map(decodeHistoryEntry);
  if (versions[0]?.workspaceVersionId !== record.headWorkspaceVersionId) {
    throw invalidProtocolFrame('Managed workspace history does not start at its head');
  }
  for (let index = 0; index < versions.length - 1; index += 1) {
    if (versions[index]?.parentWorkspaceVersionId !== versions[index + 1]?.workspaceVersionId) {
      throw invalidProtocolFrame('Managed workspace history lineage is discontinuous');
    }
  }
  const tail = versions.at(-1);
  if (
    !tail ||
    (record.hasMore
      ? tail.parentWorkspaceVersionId === null
      : tail.parentWorkspaceVersionId !== null)
  ) {
    throw invalidProtocolFrame('Managed workspace history pagination is inconsistent');
  }
  return {
    kind: 'accepted_history',
    headWorkspaceVersionId: record.headWorkspaceVersionId,
    versions,
    hasMore: record.hasMore,
  };
}

function decodeHistoryEntry(value: unknown): ManagedWorkspaceHistoryEntry {
  const record = requireExactRecord(value, 'managed workspace history entry', [
    'workspaceVersionId',
    'parentWorkspaceVersionId',
    'commitOid',
    'treeOid',
    'acceptedEventId',
    'committedAt',
    'kind',
    'changedFileCount',
  ]);
  if (
    typeof record.workspaceVersionId !== 'string' ||
    !VERSION_ID_PATTERN.test(record.workspaceVersionId) ||
    (record.parentWorkspaceVersionId !== null &&
      (typeof record.parentWorkspaceVersionId !== 'string' ||
        !VERSION_ID_PATTERN.test(record.parentWorkspaceVersionId))) ||
    typeof record.commitOid !== 'string' ||
    !SHA1_PATTERN.test(record.commitOid) ||
    typeof record.treeOid !== 'string' ||
    !SHA1_PATTERN.test(record.treeOid) ||
    typeof record.acceptedEventId !== 'string' ||
    record.acceptedEventId.length < 1 ||
    record.acceptedEventId.length > 256 ||
    !isCount(record.committedAt) ||
    (record.kind !== 'baseline' &&
      record.kind !== 'tool_mutation' &&
      record.kind !== 'history_restore') ||
    !isCount(record.changedFileCount) ||
    (record.kind === 'baseline') !== (record.parentWorkspaceVersionId === null)
  ) {
    throw invalidProtocolFrame('Invalid managed workspace history entry');
  }
  return {
    workspaceVersionId: record.workspaceVersionId,
    parentWorkspaceVersionId: record.parentWorkspaceVersionId,
    commitOid: record.commitOid,
    treeOid: record.treeOid,
    acceptedEventId: record.acceptedEventId,
    committedAt: record.committedAt,
    kind: record.kind,
    changedFileCount: record.changedFileCount,
  };
}

export function decodeManagedWorkspaceReviewQueryResult(
  value: unknown,
): ManagedWorkspaceReviewQueryResult {
  requireEncodedByteLimit(value, 'managed workspace review result', RESULT_MAX_BYTES);
  const record = requireExactRecord(value, 'managed workspace review result', [
    'kind',
    'sourceKind',
    'snapshot',
  ]);
  if (
    record.kind !== 'accepted_review' ||
    (record.sourceKind !== 'git_repository_v1' && record.sourceKind !== 'filesystem_snapshot_v1')
  ) {
    throw invalidProtocolFrame('Invalid managed workspace review result kind');
  }
  return {
    kind: 'accepted_review',
    sourceKind: record.sourceKind,
    snapshot: decodeSnapshot(record.snapshot),
  };
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
