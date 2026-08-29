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

import * as nodeCrypto from 'node:crypto';
import type { Hash } from 'node:crypto';
import { decodeAgentRunHeader, type AgentRunHeader } from './agent-run.js';
import { encodeCanonicalRuntimeEvent } from './canonical-runtime-event.js';
import { isRecord } from './record-schema.js';
import type { RuntimeEvent } from './runtime-event.js';
import { stableJsonStringify } from './tool-args-identity.js';

export type RuntimeBoundaryDigest = `sha256:${string}`;

export interface RuntimePrefixIdentityV1 {
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
}

export interface RuntimePrefixPositionV1 {
  lastEventSeq: number;
  eventCount: number;
  lastEventId: string;
}

export interface RuntimePrefixRowV1 {
  eventSeq: number;
  event: RuntimeEvent;
}

export interface ImmutableRuntimePrefixV1 {
  protocol: 'immutable_runtime_prefix_v1';
  identity: RuntimePrefixIdentityV1;
  position: RuntimePrefixPositionV1;
  prefixDigest: RuntimeBoundaryDigest;
  events: readonly RuntimeEvent[];
}

export interface RuntimePrefixSegmentV1 {
  protocol: 'runtime_prefix_segment_v1';
  identity: RuntimePrefixIdentityV1;
  position: RuntimePrefixPositionV1;
  prefixDigest: RuntimeBoundaryDigest;
}

export interface RuntimeBoundaryCursorV1 {
  protocol: 'runtime_boundary_cursor_v1';
  segments: readonly [RuntimePrefixSegmentV1, ...RuntimePrefixSegmentV1[]];
  manifestDigest: RuntimeBoundaryDigest;
}

export interface ContinuationClaimV1 {
  protocol: 'continuation_claim_v1';
  claimId: string;
  boundaryDigest: RuntimeBoundaryDigest;
  boundary: RuntimeBoundaryCursorV1;
  providerProjectionVersion: 1;
  providerReplayDigest: RuntimeBoundaryDigest;
  target: {
    sessionId: string;
    invocationId: string;
    runId: string;
    turnId: string;
  };
  /** Exact pre-provider target Run header used by both normal admission and crash repair. */
  targetRunHeader: AgentRunHeader;
  claimedAt: number;
}

export interface ManagedWorkspaceContinuationBoundaryV1 {
  protocol: 'managed_workspace_continuation_boundary_v1';
  storageRootId: string;
  repositoryId: string;
  workspaceId: string;
  workspaceEpochId: string;
  workspaceInstanceId: string;
  workspaceVersionId: string;
  acceptedEventId: string;
  revision: number;
  objectFormat: 'sha1' | 'sha256';
  sourceCommitOid: string;
  sourceTreeOid: string;
  commitOid: string;
  treeOid: string;
  materializationProfileDigest: RuntimeBoundaryDigest;
  policyHash: RuntimeBoundaryDigest;
  executionProfileDigest: RuntimeBoundaryDigest;
}

export interface ContinuationClaimV2 extends Omit<ContinuationClaimV1, 'protocol'> {
  protocol: 'continuation_claim_v2';
  workspaceBoundary: ManagedWorkspaceContinuationBoundaryV1;
}

export type ContinuationClaim = ContinuationClaimV1 | ContinuationClaimV2;

export function buildImmutableRuntimePrefix(
  identity: RuntimePrefixIdentityV1,
  rows: readonly RuntimePrefixRowV1[],
): ImmutableRuntimePrefixV1 {
  const canonicalRows = canonicalizePrefixRows(identity, rows);
  const last = canonicalRows.at(-1);
  if (!last) throw new Error('immutable RuntimeEvent prefix is empty');
  return {
    protocol: 'immutable_runtime_prefix_v1',
    identity: { ...identity },
    position: {
      lastEventSeq: last.eventSeq,
      eventCount: canonicalRows.length,
      lastEventId: last.event.id,
    },
    prefixDigest: digestCanonicalRuntimePrefix(identity, canonicalRows),
    events: canonicalRows.map((row) => row.event),
  };
}

export function digestRuntimePrefix(
  identity: RuntimePrefixIdentityV1,
  rows: readonly RuntimePrefixRowV1[],
): RuntimeBoundaryDigest {
  return digestCanonicalRuntimePrefix(identity, canonicalizePrefixRows(identity, rows));
}

export function runtimePrefixSegment(prefix: ImmutableRuntimePrefixV1): RuntimePrefixSegmentV1 {
  if (prefix.protocol !== 'immutable_runtime_prefix_v1') {
    throw new Error('Invalid immutable RuntimeEvent prefix protocol');
  }
  const rebuilt = buildImmutableRuntimePrefix(
    prefix.identity,
    prefix.events.map((event, index) => ({ eventSeq: index + 1, event })),
  );
  if (stableJsonStringify(rebuilt.position) !== stableJsonStringify(prefix.position)) {
    throw new Error('Immutable RuntimeEvent prefix position mismatch');
  }
  if (rebuilt.prefixDigest !== prefix.prefixDigest) {
    throw new Error('Immutable RuntimeEvent prefix digest mismatch');
  }
  return decodeRuntimePrefixSegment({
    protocol: 'runtime_prefix_segment_v1',
    identity: rebuilt.identity,
    position: rebuilt.position,
    prefixDigest: rebuilt.prefixDigest,
  });
}

export function createRuntimeBoundaryCursor(
  segments: readonly [RuntimePrefixSegmentV1, ...RuntimePrefixSegmentV1[]],
): RuntimeBoundaryCursorV1 {
  const canonicalSegments = segments.map(decodeRuntimePrefixSegment) as [
    RuntimePrefixSegmentV1,
    ...RuntimePrefixSegmentV1[],
  ];
  const sessionId = canonicalSegments[0].identity.sessionId;
  const invocationIds = new Set<string>();
  const runIds = new Set<string>();
  const turnIds = new Set<string>();
  for (const segment of canonicalSegments) {
    if (segment.identity.sessionId !== sessionId) {
      throw new Error('Runtime boundary segments must belong to the same session');
    }
    if (runIds.has(segment.identity.runId)) {
      throw new Error('Runtime boundary lineage contains a duplicate runId');
    }
    runIds.add(segment.identity.runId);
    if (invocationIds.has(segment.identity.invocationId)) {
      throw new Error('Runtime boundary lineage contains a duplicate invocationId');
    }
    invocationIds.add(segment.identity.invocationId);
    if (turnIds.has(segment.identity.turnId)) {
      throw new Error('Runtime boundary lineage contains a duplicate turnId');
    }
    turnIds.add(segment.identity.turnId);
  }
  return {
    protocol: 'runtime_boundary_cursor_v1',
    segments: canonicalSegments,
    manifestDigest: digestRuntimeBoundaryManifest(canonicalSegments),
  };
}

export function digestRuntimeBoundaryManifest(
  segments: readonly [RuntimePrefixSegmentV1, ...RuntimePrefixSegmentV1[]],
): RuntimeBoundaryDigest {
  const canonicalSegments = segments.map(decodeRuntimePrefixSegment);
  const json = stableJsonStringify({
    protocol: 'runtime_boundary_cursor_v1',
    segments: canonicalSegments,
  });
  const hash = nodeCrypto.createHash('sha256');
  updateLengthPrefixed(hash, Buffer.from('maka.runtime-boundary-manifest.v1', 'utf8'));
  updateLengthPrefixed(hash, Buffer.from(json, 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

export function digestWorkspaceBoundContinuationBoundary(
  boundary: RuntimeBoundaryCursorV1,
  workspaceBoundary: ManagedWorkspaceContinuationBoundaryV1,
): RuntimeBoundaryDigest {
  const runtime = decodeRuntimeBoundaryCursor(boundary);
  const workspace = decodeManagedWorkspaceContinuationBoundary(workspaceBoundary);
  const hash = nodeCrypto.createHash('sha256');
  updateLengthPrefixed(hash, Buffer.from('maka.workspace-bound-continuation.v1', 'utf8'));
  updateLengthPrefixed(
    hash,
    Buffer.from(
      stableJsonStringify({
        protocol: 'workspace_bound_continuation_boundary_v1',
        runtime,
        workspace,
      }),
      'utf8',
    ),
  );
  return `sha256:${hash.digest('hex')}`;
}

export function decodeRuntimePrefixSegment(value: unknown): RuntimePrefixSegmentV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['protocol', 'identity', 'position', 'prefixDigest']) ||
    value.protocol !== 'runtime_prefix_segment_v1'
  ) {
    throw new Error('Invalid RuntimeEvent prefix segment');
  }
  return {
    protocol: 'runtime_prefix_segment_v1',
    identity: decodePrefixIdentity(value.identity),
    position: decodePrefixPosition(value.position),
    prefixDigest: decodeBoundaryDigest(value.prefixDigest),
  };
}

export function decodeRuntimeBoundaryCursor(value: unknown): RuntimeBoundaryCursorV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['protocol', 'segments', 'manifestDigest']) ||
    value.protocol !== 'runtime_boundary_cursor_v1' ||
    !Array.isArray(value.segments) ||
    value.segments.length === 0
  ) {
    throw new Error('Invalid RuntimeEvent boundary cursor');
  }
  const segments = value.segments.map(decodeRuntimePrefixSegment) as [
    RuntimePrefixSegmentV1,
    ...RuntimePrefixSegmentV1[],
  ];
  const cursor = createRuntimeBoundaryCursor(segments);
  const manifestDigest = decodeBoundaryDigest(value.manifestDigest);
  if (cursor.manifestDigest !== manifestDigest) {
    throw new Error('RuntimeEvent boundary manifest digest mismatch');
  }
  return cursor;
}

export function decodeContinuationClaim(value: unknown): ContinuationClaim {
  const isV2 = isRecord(value) && value.protocol === 'continuation_claim_v2';
  const expectedKeys = [
    'protocol',
    'claimId',
    'boundaryDigest',
    'boundary',
    ...(isV2 ? ['workspaceBoundary'] : []),
    'providerProjectionVersion',
    'providerReplayDigest',
    'target',
    'targetRunHeader',
    'claimedAt',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, expectedKeys) ||
    (value.protocol !== 'continuation_claim_v1' && value.protocol !== 'continuation_claim_v2') ||
    !isNonEmptyString(value.claimId) ||
    !isRecord(value.target) ||
    !hasExactKeys(value.target, ['sessionId', 'invocationId', 'runId', 'turnId']) ||
    !isNonEmptyString(value.target.sessionId) ||
    !isNonEmptyString(value.target.invocationId) ||
    !isNonEmptyString(value.target.runId) ||
    !isNonEmptyString(value.target.turnId) ||
    value.providerProjectionVersion !== 1 ||
    !Number.isSafeInteger(value.claimedAt) ||
    (value.claimedAt as number) < 0
  ) {
    throw new Error('Invalid continuation claim');
  }
  const boundary = decodeRuntimeBoundaryCursor(value.boundary);
  const boundaryDigest = decodeBoundaryDigest(value.boundaryDigest);
  const providerReplayDigest = decodeBoundaryDigest(value.providerReplayDigest);
  const workspaceBoundary = isV2
    ? decodeManagedWorkspaceContinuationBoundary(value.workspaceBoundary)
    : undefined;
  const expectedBoundaryDigest = workspaceBoundary
    ? digestWorkspaceBoundContinuationBoundary(boundary, workspaceBoundary)
    : boundary.manifestDigest;
  if (boundaryDigest !== expectedBoundaryDigest) {
    throw new Error(
      workspaceBoundary
        ? 'Continuation claim workspace boundary digest mismatch'
        : 'Continuation claim boundary digest mismatch',
    );
  }
  const source = boundary.segments.at(-1)!;
  if (value.target.sessionId !== source.identity.sessionId) {
    throw new Error('Continuation claim target session differs from source boundary');
  }
  const targetRunId = value.target.runId;
  if (boundary.segments.some((segment) => segment.identity.runId === targetRunId)) {
    throw new Error('Continuation claim target runId reuses source identity');
  }
  const targetInvocationId = value.target.invocationId;
  if (boundary.segments.some((segment) => segment.identity.invocationId === targetInvocationId)) {
    throw new Error('Continuation claim target invocationId reuses source identity');
  }
  const targetTurnId = value.target.turnId;
  if (boundary.segments.some((segment) => segment.identity.turnId === targetTurnId)) {
    throw new Error('Continuation claim target turnId reuses source identity');
  }
  const targetRunHeader = decodeAgentRunHeader(value.targetRunHeader);
  const continuationSource = targetRunHeader.continuationSource;
  if (
    targetRunHeader.runId !== targetRunId ||
    targetRunHeader.invocationId !== targetInvocationId ||
    targetRunHeader.sessionId !== value.target.sessionId ||
    targetRunHeader.turnId !== targetTurnId ||
    targetRunHeader.status !== 'created' ||
    targetRunHeader.createdAt !== value.claimedAt ||
    targetRunHeader.updatedAt !== value.claimedAt ||
    targetRunHeader.completedAt !== undefined ||
    targetRunHeader.failureClass !== undefined ||
    targetRunHeader.failureMessage !== undefined ||
    !continuationSource ||
    !('protocol' in continuationSource) ||
    continuationSource.protocol !==
      (workspaceBoundary ? 'continuation_source_v3' : 'continuation_source_v2') ||
    continuationSource.claimId !== value.claimId ||
    continuationSource.boundaryDigest !== boundaryDigest ||
    continuationSource.sourceInvocationId !== source.identity.invocationId ||
    continuationSource.sourceRunId !== source.identity.runId ||
    continuationSource.sourceTurnId !== source.identity.turnId ||
    continuationSource.sourceRuntimeEventHighWater !== source.position.lastEventSeq ||
    continuationSource.sourcePrefixDigest !== source.prefixDigest ||
    continuationSource.replayManifestDigest !== boundary.manifestDigest
  ) {
    throw new Error('Continuation claim target Run header mismatch');
  }
  const claim = {
    protocol: workspaceBoundary
      ? ('continuation_claim_v2' as const)
      : ('continuation_claim_v1' as const),
    claimId: value.claimId,
    boundaryDigest,
    boundary,
    ...(workspaceBoundary ? { workspaceBoundary } : {}),
    providerProjectionVersion: 1,
    providerReplayDigest,
    target: {
      sessionId: value.target.sessionId,
      invocationId: value.target.invocationId,
      runId: value.target.runId,
      turnId: value.target.turnId,
    },
    targetRunHeader,
    claimedAt: value.claimedAt as number,
  };
  return claim as ContinuationClaim;
}

export function decodeManagedWorkspaceContinuationBoundary(
  value: unknown,
): ManagedWorkspaceContinuationBoundaryV1 {
  const keys = [
    'protocol',
    'storageRootId',
    'repositoryId',
    'workspaceId',
    'workspaceEpochId',
    'workspaceInstanceId',
    'workspaceVersionId',
    'acceptedEventId',
    'revision',
    'objectFormat',
    'sourceCommitOid',
    'sourceTreeOid',
    'commitOid',
    'treeOid',
    'materializationProfileDigest',
    'policyHash',
    'executionProfileDigest',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.protocol !== 'managed_workspace_continuation_boundary_v1' ||
    typeof value.storageRootId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.storageRootId) ||
    typeof value.repositoryId !== 'string' ||
    !/^repository_[0-9a-f]{32}$/u.test(value.repositoryId) ||
    typeof value.workspaceId !== 'string' ||
    !/^workspace_[0-9a-f]{32}$/u.test(value.workspaceId) ||
    typeof value.workspaceEpochId !== 'string' ||
    !/^epoch_[0-9a-f]{32}$/u.test(value.workspaceEpochId) ||
    typeof value.workspaceInstanceId !== 'string' ||
    !/^instance_[0-9a-f]{32}$/u.test(value.workspaceInstanceId) ||
    typeof value.workspaceVersionId !== 'string' ||
    !/^version_[0-9a-f]{32}$/u.test(value.workspaceVersionId) ||
    !isNonEmptyString(value.acceptedEventId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) <= 0 ||
    (value.objectFormat !== 'sha1' && value.objectFormat !== 'sha256') ||
    typeof value.sourceCommitOid !== 'string' ||
    typeof value.sourceTreeOid !== 'string' ||
    !oidMatchesFormat(value.sourceCommitOid, value.objectFormat) ||
    !oidMatchesFormat(value.sourceTreeOid, value.objectFormat) ||
    typeof value.commitOid !== 'string' ||
    typeof value.treeOid !== 'string' ||
    !oidMatchesFormat(value.commitOid, value.objectFormat) ||
    !oidMatchesFormat(value.treeOid, value.objectFormat) ||
    !isBoundaryDigest(value.materializationProfileDigest) ||
    !isBoundaryDigest(value.policyHash) ||
    !isBoundaryDigest(value.executionProfileDigest)
  ) {
    throw new Error('Invalid managed workspace continuation boundary');
  }
  return {
    protocol: 'managed_workspace_continuation_boundary_v1',
    storageRootId: value.storageRootId,
    repositoryId: value.repositoryId,
    workspaceId: value.workspaceId,
    workspaceEpochId: value.workspaceEpochId,
    workspaceInstanceId: value.workspaceInstanceId,
    workspaceVersionId: value.workspaceVersionId,
    acceptedEventId: value.acceptedEventId,
    revision: value.revision as number,
    objectFormat: value.objectFormat,
    sourceCommitOid: value.sourceCommitOid,
    sourceTreeOid: value.sourceTreeOid,
    commitOid: value.commitOid,
    treeOid: value.treeOid,
    materializationProfileDigest: value.materializationProfileDigest,
    policyHash: value.policyHash,
    executionProfileDigest: value.executionProfileDigest,
  };
}

function oidMatchesFormat(value: string, format: 'sha1' | 'sha256'): boolean {
  return new RegExp(`^[0-9a-f]{${format === 'sha1' ? 40 : 64}}$`, 'u').test(value);
}

function isBoundaryDigest(value: unknown): value is RuntimeBoundaryDigest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function canonicalizePrefixRows(
  identity: RuntimePrefixIdentityV1,
  rows: readonly RuntimePrefixRowV1[],
): RuntimePrefixRowV1[] {
  const canonicalIdentity = decodePrefixIdentity(identity);
  const canonicalRows: RuntimePrefixRowV1[] = [];
  for (const [index, row] of rows.entries()) {
    const expectedEventSeq = index + 1;
    if (
      !Number.isSafeInteger(row.eventSeq) ||
      row.eventSeq <= 0 ||
      row.eventSeq !== expectedEventSeq
    ) {
      throw new Error(
        `immutable RuntimeEvent event_seq gap: expected ${expectedEventSeq}, received ${String(row.eventSeq)}`,
      );
    }
    const event = encodeCanonicalRuntimeEvent(row.event).event;
    if (event.partial === true) {
      throw new Error(`immutable RuntimeEvent prefix contains partial snapshot ${event.id}`);
    }
    if (
      event.sessionId !== canonicalIdentity.sessionId ||
      event.invocationId !== canonicalIdentity.invocationId ||
      event.runId !== canonicalIdentity.runId ||
      event.turnId !== canonicalIdentity.turnId
    ) {
      throw new Error(`immutable RuntimeEvent identity mismatch for ${event.id}`);
    }
    canonicalRows.push({ eventSeq: row.eventSeq, event });
  }
  return canonicalRows;
}

function digestCanonicalRuntimePrefix(
  identity: RuntimePrefixIdentityV1,
  rows: readonly RuntimePrefixRowV1[],
): RuntimeBoundaryDigest {
  const hash = nodeCrypto.createHash('sha256');
  updateLengthPrefixed(hash, Buffer.from('maka.runtime-prefix.v1', 'utf8'));
  updateLengthPrefixed(hash, Buffer.from(stableJsonStringify(identity), 'utf8'));
  for (const row of rows) {
    hash.update(uint64be(row.eventSeq));
    updateLengthPrefixed(hash, Buffer.from(encodeRuntimePrefixV1Event(row.event), 'utf8'));
  }
  return `sha256:${hash.digest('hex')}`;
}

function encodeRuntimePrefixV1Event(event: RuntimeEvent): string {
  const canonical = encodeCanonicalRuntimeEvent(event);
  const content = canonical.event.content;
  if (content?.kind !== 'text' || content.origin?.kind !== 'legacy_automation') {
    return canonical.json;
  }
  // v1 identity binds the bytes released writers used, while callers consume
  // the semantic legacy marker. Changing these bytes would orphan continuations.
  return stableJsonStringify({
    ...canonical.event,
    content: {
      ...content,
      origin: { kind: 'automation', automationId: content.origin.automationId },
    },
  });
}

function decodePrefixIdentity(value: unknown): RuntimePrefixIdentityV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['sessionId', 'invocationId', 'runId', 'turnId']) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.invocationId) ||
    !isNonEmptyString(value.runId) ||
    !isNonEmptyString(value.turnId)
  ) {
    throw new Error('Invalid RuntimeEvent prefix identity');
  }
  return {
    sessionId: value.sessionId,
    invocationId: value.invocationId,
    runId: value.runId,
    turnId: value.turnId,
  };
}

function decodePrefixPosition(value: unknown): RuntimePrefixPositionV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['lastEventSeq', 'eventCount', 'lastEventId']) ||
    !Number.isSafeInteger(value.lastEventSeq) ||
    (value.lastEventSeq as number) <= 0 ||
    !Number.isSafeInteger(value.eventCount) ||
    value.eventCount !== value.lastEventSeq ||
    !isNonEmptyString(value.lastEventId)
  ) {
    throw new Error('Invalid RuntimeEvent prefix position');
  }
  return {
    lastEventSeq: value.lastEventSeq as number,
    eventCount: value.eventCount as number,
    lastEventId: value.lastEventId,
  };
}

function decodeBoundaryDigest(value: unknown): RuntimeBoundaryDigest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid RuntimeEvent boundary digest');
  }
  return value as RuntimeBoundaryDigest;
}

function updateLengthPrefixed(hash: Hash, bytes: Uint8Array): void {
  hash.update(uint64be(bytes.byteLength));
  hash.update(bytes);
}

function uint64be(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('RuntimeEvent boundary length is not a safe integer');
  }
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
