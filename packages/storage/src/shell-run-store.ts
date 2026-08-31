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

import {
  assertShellRunIdentifier,
  assertShellRunPatch,
  assertShellRunSessionId,
  isShellRunSourceOperationId,
  nextShellRunRecord,
  normalizeShellRunRecord,
  shellRunNotFoundError,
  type ShellRunRecord,
  type ShellRunPatch,
  type ShellRunStore,
} from '@maka/core/shell-run';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

export interface ClosableShellRunStore extends ShellRunStore {
  claimShellRun(record: ShellRunRecord): Promise<{ created: boolean; record: ShellRunRecord }>;
  readShellRunBySourceOperation(
    sessionId: string,
    sourceOperationId: string,
  ): Promise<ShellRunRecord | undefined>;
  ready(): Promise<void>;
  close(): void;
}

export function createSqliteShellRunStore(workspaceRoot: string): ClosableShellRunStore {
  return new SqliteShellRunStore(workspaceRoot);
}

class SqliteShellRunStore implements ClosableShellRunStore {
  readonly #lease: OperationalStateDatabaseLease;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(workspaceRoot);
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async createShellRun(record: ShellRunRecord): Promise<ShellRunRecord> {
    assertShellRunSessionId(record.sessionId);
    assertShellRunIdentifier(record.shellRunId);
    const normalized = normalizeShellRunRecord(record, record.sessionId, record.shellRunId);
    this.#lease.transaction('write', () => {
      const result = this.#lease.database
        .prepare(`
          INSERT OR IGNORE INTO core_shell_runs(
            session_id, shell_run_id, source_operation_id, source_request_hash,
            started_at, record_json
          ) VALUES ($session, $shell, $operation, $request, $started, $record)
        `)
        .run({
          $session: normalized.sessionId,
          $shell: normalized.shellRunId,
          $operation: normalized.sourceOperationId ?? null,
          $request: normalized.sourceRequestHash ?? null,
          $started: normalized.startedAt,
          $record: JSON.stringify(normalized, sanitizeJson),
        });
      if (result.changes !== 1) {
        throw new Error(`ShellRun already exists: ${normalized.shellRunId}`);
      }
    });
    return normalized;
  }

  async claimShellRun(
    record: ShellRunRecord,
  ): Promise<{ created: boolean; record: ShellRunRecord }> {
    assertShellRunSessionId(record.sessionId);
    assertShellRunIdentifier(record.shellRunId);
    const normalized = normalizeShellRunRecord(record, record.sessionId, record.shellRunId);
    if (!normalized.sourceOperationId || !normalized.sourceRequestHash) {
      throw new Error('Durable ShellRun claim requires a source operation identity');
    }
    const sourceOperationId = normalized.sourceOperationId;
    const sourceRequestHash = normalized.sourceRequestHash;
    return this.#lease.transaction('write', () => {
      const existing = readSqliteShellRunBySourceOperation(
        this.#lease.database,
        normalized.sessionId,
        sourceOperationId,
      );
      if (existing) {
        if (existing.sourceRequestHash !== sourceRequestHash) {
          throw new Error('ShellRun source operation request does not match its durable claim');
        }
        return { created: false, record: existing };
      }
      const result = this.#lease.database
        .prepare(`
          INSERT INTO core_shell_runs(
            session_id, shell_run_id, source_operation_id, source_request_hash,
            started_at, record_json
          ) VALUES ($session, $shell, $operation, $request, $started, $record)
        `)
        .run({
          $session: normalized.sessionId,
          $shell: normalized.shellRunId,
          $operation: sourceOperationId,
          $request: sourceRequestHash,
          $started: normalized.startedAt,
          $record: JSON.stringify(normalized, sanitizeJson),
        });
      if (result.changes !== 1) throw new Error('Failed to claim durable ShellRun operation');
      return { created: true, record: normalized };
    });
  }

  async readShellRunBySourceOperation(
    sessionId: string,
    sourceOperationId: string,
  ): Promise<ShellRunRecord | undefined> {
    assertShellRunSessionId(sessionId);
    if (!isShellRunSourceOperationId(sourceOperationId)) {
      throw new Error('Invalid ShellRun source operation id');
    }
    return readSqliteShellRunBySourceOperation(this.#lease.database, sessionId, sourceOperationId);
  }

  async updateShellRun(
    sessionId: string,
    shellRunId: string,
    patch: ShellRunPatch,
  ): Promise<ShellRunRecord> {
    assertShellRunSessionId(sessionId);
    assertShellRunIdentifier(shellRunId);
    assertShellRunPatch(patch);
    return this.#lease.transaction('write', () => {
      const current = readSqliteShellRun(this.#lease.database, sessionId, shellRunId);
      const next = nextShellRunRecord(current, patch);
      if (next === current) return current;
      const result = this.#lease.database
        .prepare(`
          UPDATE core_shell_runs
          SET started_at = ?, record_json = ?
          WHERE session_id = ? AND shell_run_id = ?
        `)
        .run(next.startedAt, JSON.stringify(next, sanitizeJson), sessionId, shellRunId);
      if (result.changes !== 1) throw new Error(`Failed to update shell run ${shellRunId}`);
      return next;
    });
  }

  async readShellRun(sessionId: string, shellRunId: string): Promise<ShellRunRecord> {
    assertShellRunSessionId(sessionId);
    assertShellRunIdentifier(shellRunId);
    return readSqliteShellRun(this.#lease.database, sessionId, shellRunId);
  }

  async listSessionShellRuns(sessionId: string): Promise<ShellRunRecord[]> {
    assertShellRunSessionId(sessionId);
    const rows = this.#lease.database
      .prepare(`
        SELECT shell_run_id, record_json
        FROM core_shell_runs
        WHERE session_id = ?
        ORDER BY started_at, shell_run_id
      `)
      .all(sessionId) as Array<{ shell_run_id?: unknown; record_json?: unknown }>;
    return rows.map((row) => {
      if (typeof row.shell_run_id !== 'string' || typeof row.record_json !== 'string') {
        throw new Error('Invalid SQLite ShellRun row');
      }
      return normalizeShellRunRecord(JSON.parse(row.record_json), sessionId, row.shell_run_id);
    });
  }

  close(): void {
    this.#lease.close();
  }
}

function readSqliteShellRun(
  db: import('node:sqlite').DatabaseSync,
  sessionId: string,
  shellRunId: string,
): ShellRunRecord {
  const row = db
    .prepare(`
      SELECT record_json
      FROM core_shell_runs
      WHERE session_id = ? AND shell_run_id = ?
    `)
    .get(sessionId, shellRunId) as { record_json?: unknown } | undefined;
  if (!row) throw shellRunNotFoundError(shellRunId);
  if (typeof row.record_json !== 'string') throw new Error('Invalid SQLite ShellRun row');
  return normalizeShellRunRecord(JSON.parse(row.record_json), sessionId, shellRunId);
}

function readSqliteShellRunBySourceOperation(
  db: import('node:sqlite').DatabaseSync,
  sessionId: string,
  sourceOperationId: string,
): ShellRunRecord | undefined {
  const row = db
    .prepare(`
      SELECT shell_run_id, source_operation_id, source_request_hash, record_json
      FROM core_shell_runs
      WHERE session_id = ? AND source_operation_id = ?
    `)
    .get(sessionId, sourceOperationId) as
    | {
        shell_run_id?: unknown;
        source_operation_id?: unknown;
        source_request_hash?: unknown;
        record_json?: unknown;
      }
    | undefined;
  if (!row) return undefined;
  if (
    typeof row.shell_run_id !== 'string' ||
    typeof row.source_operation_id !== 'string' ||
    typeof row.source_request_hash !== 'string' ||
    typeof row.record_json !== 'string'
  ) {
    throw new Error('Invalid SQLite ShellRun source-operation row');
  }
  const record = normalizeShellRunRecord(JSON.parse(row.record_json), sessionId, row.shell_run_id);
  if (
    row.source_operation_id !== sourceOperationId ||
    record.sourceOperationId !== row.source_operation_id ||
    record.sourceRequestHash !== row.source_request_hash
  ) {
    throw new Error('SQLite ShellRun source-operation row does not match its durable record');
  }
  return record;
}

function sanitizeJson(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
