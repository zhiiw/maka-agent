import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RuntimeEvent } from '@maka/core';
import {
  createSqliteRuntimeStore,
  type SqliteRuntimeStoreFailpoint,
} from '../sqlite-runtime-store.js';

const childMode = process.env.MAKA_SQLITE_CRASH_CHILD;

if (childMode?.startsWith('race_')) {
  await runRaceChild(childMode);
} else if (childMode) {
  await runCrashChild(childMode);
} else {
  describe('SqliteRuntimeStore real-process recovery races', () => {
    it('converges two concurrent exact recovery bundle commits', { timeout: 30_000 }, async () => {
      await withRecoveryRace(['race_completed', 'race_completed'], async (results, store) => {
        assert.deepEqual(
          results.map((result) => result.code),
          [0, 0],
        );
        assert.deepEqual(
          (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          [
            'call-event-1',
            'dispatch-event-1',
            'reconcile-event-1',
            'response-event-1',
            'recovery-decision-event-1',
          ],
        );
      });
    });

    it('allows only one winner for concurrent completed and parked bundles', {
      timeout: 30_000,
    }, async () => {
      await withRecoveryRace(['race_completed', 'race_parked'], async (results, store) => {
        assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
        const operation = await store.readToolOperation('operation-1');
        assert.ok(
          operation?.currentState === 'outcome_committed' ||
            operation?.currentState === 'recovery_parked',
        );
      });
    });

    it('serializes projection rebuild against a concurrent recovery bundle commit', {
      timeout: 30_000,
    }, async () => {
      await withRecoveryRace(['race_completed', 'race_rebuild'], async (results, store) => {
        assert.deepEqual(
          results.map((result) => result.code),
          [0, 0],
        );
        assert.deepEqual(
          (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          [
            'call-event-1',
            'dispatch-event-1',
            'reconcile-event-1',
            'response-event-1',
            'recovery-decision-event-1',
          ],
        );
        assert.equal(
          (await store.readToolOperation('operation-1'))?.currentState,
          'outcome_committed',
        );
      });
    });
  });

  describe('SqliteRuntimeStore real-process crash boundaries', {
    skip: process.platform === 'win32',
  }, () => {
    it('rolls back a process killed inside T1', { timeout: 30_000 }, async () => {
      await withKilledChild('inside_t1', async (store) => {
        assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), []);
        assert.deepEqual(await store.listUnsettledToolOperations(), []);
      });
    });

    it('retains a prepared operation when killed after T1 and a possible side effect', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('after_effect', async (store, markerPath) => {
        assert.equal(await readFile(markerPath, 'utf8'), 'effect-happened');
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          ['call-event-1', 'dispatch-event-1'],
        );
        assert.deepEqual(
          (await store.listUnsettledToolOperations()).map((operation) => operation.operationId),
          ['operation-1'],
        );
      });
    });

    it('rolls back a process killed inside T2 without losing T1', { timeout: 30_000 }, async () => {
      await withKilledChild('inside_t2', async (store) => {
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          ['call-event-1', 'dispatch-event-1'],
        );
        assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      });
    });

    it('retains the committed outcome when killed after T2', { timeout: 30_000 }, async () => {
      await withKilledChild('after_t2', async (store) => {
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          ['call-event-1', 'dispatch-event-1', 'response-event-1'],
        );
        assert.equal(
          (await store.readToolOperation('operation-1'))?.currentState,
          'outcome_committed',
        );
        assert.deepEqual(await store.listUnsettledToolOperations(), []);
      });
    });

    it('rolls back a process killed inside the recovery bundle transaction', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('inside_recovery_bundle', async (store) => {
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          ['call-event-1', 'dispatch-event-1'],
        );
        assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      });
    });

    it('rolls back a process killed after the recovery decision insert', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('inside_recovery_decision', async (store) => {
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          ['call-event-1', 'dispatch-event-1'],
        );
        assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      });
    });

    it('rolls back a process killed after the recovery outcome insert', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('inside_recovery_outcome', async (store) => {
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          ['call-event-1', 'dispatch-event-1'],
        );
        assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      });
    });

    it('retains a complete recovery bundle after process death', { timeout: 30_000 }, async () => {
      await withKilledChild('after_recovery_bundle', async (store) => {
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          [
            'call-event-1',
            'dispatch-event-1',
            'reconcile-event-1',
            'response-event-1',
            'recovery-decision-event-1',
          ],
        );
        assert.equal(
          (await store.readToolOperation('operation-1'))?.currentState,
          'outcome_committed',
        );
      });
    });
  });
}

async function withRecoveryRace(
  modes: readonly [RecoveryRaceMode, RecoveryRaceMode],
  inspect: (
    results: Array<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>,
    store: ReturnType<typeof createSqliteRuntimeStore>,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-recovery-race-'));
  const dbPath = join(root, 'runtime.sqlite');
  const setup = createSqliteRuntimeStore(dbPath);
  try {
    await setup.commitToolPrepared(preparedCommit('reconcile'));
  } finally {
    setup.close();
  }

  const children = modes.map((mode) =>
    spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        MAKA_SQLITE_CRASH_CHILD: mode,
        MAKA_SQLITE_CRASH_DB: dbPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  try {
    await Promise.all(children.map((child) => waitForReady(child)));
    for (const child of children) child.stdin?.end('GO\n');
    const results = await Promise.all(children.map((child) => waitForExit(child)));
    const store = createSqliteRuntimeStore(dbPath);
    try {
      await inspect(results, store);
    } finally {
      store.close();
    }
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(root, { recursive: true, force: true });
  }
}

type RecoveryRaceMode = 'race_completed' | 'race_parked' | 'race_rebuild';

async function withKilledChild(
  mode: string,
  inspect: (
    store: ReturnType<typeof createSqliteRuntimeStore>,
    markerPath: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-crash-'));
  const dbPath = join(root, 'runtime.sqlite');
  const markerPath = join(root, 'effect.marker');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      MAKA_SQLITE_CRASH_CHILD: mode,
      MAKA_SQLITE_CRASH_DB: dbPath,
      MAKA_SQLITE_CRASH_MARKER: markerPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForReady(child);
    child.kill('SIGKILL');
    await new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
    const store = createSqliteRuntimeStore(dbPath);
    try {
      await inspect(store, markerPath);
    } finally {
      store.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
    child.once('error', reject);
  });
}

function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) resolve();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('exit', (code, signal) => {
      reject(new Error(`crash child exited before READY: code=${code} signal=${signal} ${stderr}`));
    });
    child.once('error', reject);
  });
}

async function runRaceChild(mode: string): Promise<void> {
  writeSync(1, 'READY\n');
  await new Promise<void>((resolve, reject) => {
    process.stdin.once('data', () => resolve());
    process.stdin.once('error', reject);
  });
  const store = createSqliteRuntimeStore(requiredEnv('MAKA_SQLITE_CRASH_DB'));
  try {
    if (mode === 'race_rebuild') {
      await store.rebuildToolProjectionsFromRuntimeEvents();
    } else {
      await store.commitToolRecoveryBundle(
        mode === 'race_completed' ? completedRecoveryBundle() : parkedRecoveryBundle(),
      );
    }
  } finally {
    store.close();
  }
}

async function runCrashChild(mode: string): Promise<void> {
  const dbPath = requiredEnv('MAKA_SQLITE_CRASH_DB');
  const markerPath = requiredEnv('MAKA_SQLITE_CRASH_MARKER');
  let runtimeInsertCount = 0;
  const failpoint = (point: SqliteRuntimeStoreFailpoint) => {
    if (mode === 'inside_recovery_bundle' && point === 'after_recovery_reconcile') {
      blockUntilKilled();
    }
    if (mode === 'inside_recovery_decision' && point === 'after_recovery_decision') {
      blockUntilKilled();
    }
    if (mode === 'inside_recovery_outcome' && point === 'after_recovery_outcome') {
      blockUntilKilled();
    }
    if (point !== 'after_runtime_event_insert') return;
    runtimeInsertCount += 1;
    if (mode === 'inside_t1' && runtimeInsertCount === 1) blockUntilKilled();
    if (mode === 'inside_t2' && runtimeInsertCount === 2) blockUntilKilled();
  };
  const store = createSqliteRuntimeStore(dbPath, { failpoint });
  if (
    mode === 'inside_recovery_bundle' ||
    mode === 'inside_recovery_outcome' ||
    mode === 'inside_recovery_decision' ||
    mode === 'after_recovery_bundle'
  ) {
    await store.commitToolPrepared(preparedCommit('reconcile'));
    await store.commitToolRecoveryBundle(completedRecoveryBundle());
    if (mode === 'after_recovery_bundle') blockUntilKilled();
    throw new Error(`Unknown recovery crash child mode ${mode}`);
  }
  await store.commitToolPrepared(preparedCommit());
  if (mode === 'after_effect') {
    writeFileSync(markerPath, 'effect-happened');
    blockUntilKilled();
  }
  await store.commitToolOutcome(outcomeCommit());
  if (mode === 'after_t2') blockUntilKilled();
  throw new Error(`Unknown crash child mode ${mode}`);
}

function blockUntilKilled(): never {
  writeSync(1, 'READY\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('unreachable');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function preparedCommit(recoveryMode: 'replay_safe' | 'reconcile' = 'replay_safe') {
  return {
    operationId: 'operation-1',
    journalEventId: 'journal-prepared-1',
    runtimeEvent: functionCallEvent(),
    dispatchRuntimeEvent: toolDispatchEvent(recoveryMode),
    providerToolCallId: 'provider-call-1',
    toolName: 'Read',
    canonicalArgsHash: 'sha256:ca1c32b2363423dbe2d9b7d7a8e2afdd335bb7e7cbb7c95975e8dbbf32e4d134',
    recoveryMode,
    committedAt: 1,
  };
}

function outcomeCommit() {
  return {
    operationId: 'operation-1',
    journalEventId: 'journal-outcome-1',
    runtimeEvent: functionResponseEvent(),
    committedAt: 2,
  };
}

function toolDispatchEvent(
  recoveryMode: 'replay_safe' | 'reconcile' = 'replay_safe',
): RuntimeEvent {
  return {
    id: 'dispatch-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash:
          'sha256:ca1c32b2363423dbe2d9b7d7a8e2afdd335bb7e7cbb7c95975e8dbbf32e4d134',
        recoveryMode,
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  };
}

function functionCallEvent(): RuntimeEvent {
  return {
    id: 'call-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: 'provider-call-1',
      name: 'Read',
      args: { path: '/workspace/README.md' },
    },
  };
}

function functionResponseEvent(): RuntimeEvent {
  return {
    id: 'response-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Read',
      result: 'contents',
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  };
}

function completedRecoveryBundle() {
  return {
    operationId: 'operation-1',
    reconcileRuntimeEvent: reconcileEvent(
      'reconcile-event-1',
      'matches_expected_state',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ),
    outcomeRuntimeEvent: functionResponseEvent(),
    decisionRuntimeEvent: recoveryDecisionEvent({
      id: 'recovery-decision-event-1',
      disposition: 'completed',
      reasonCode: 'reconcile_matches_expected_state',
      outcomeEventId: 'response-event-1',
      evidenceEventIds: [
        'call-event-1',
        'dispatch-event-1',
        'reconcile-event-1',
        'response-event-1',
      ],
    }),
  };
}

function parkedRecoveryBundle() {
  return {
    operationId: 'operation-1',
    reconcileRuntimeEvent: reconcileEvent(
      'reconcile-parked-event-1',
      'matches_prior_state',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ),
    decisionRuntimeEvent: recoveryDecisionEvent({
      id: 'recovery-parked-decision-event-1',
      disposition: 'parked',
      reasonCode: 'reconcile_matches_prior_state',
      evidenceEventIds: ['call-event-1', 'dispatch-event-1', 'reconcile-parked-event-1'],
    }),
  };
}

function reconcileEvent(
  id: string,
  observation: 'matches_expected_state' | 'matches_prior_state',
  observationDigest: `sha256:${string}`,
): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 3,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolRecovery: {
        kind: 'maka.tool.reconcile_result',
        version: 1,
        payload: {
          protocol: 'tool_reconcile_v1',
          operationId: 'operation-1',
          observation,
          observationSchema: 'state_identity_v1',
          observationDigest,
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  };
}

function recoveryDecisionEvent(
  input:
    | {
        id: string;
        disposition: 'completed';
        reasonCode: 'reconcile_matches_expected_state';
        outcomeEventId: string;
        evidenceEventIds: string[];
      }
    | {
        id: string;
        disposition: 'parked';
        reasonCode: 'reconcile_matches_prior_state';
        evidenceEventIds: string[];
      },
): RuntimeEvent {
  const payload =
    input.disposition === 'completed'
      ? {
          protocol: 'tool_recovery_v1' as const,
          operationId: 'operation-1',
          disposition: 'completed' as const,
          reasonCode: input.reasonCode,
          outcomeEventId: input.outcomeEventId,
          evidenceEventIds: input.evidenceEventIds,
        }
      : {
          protocol: 'tool_recovery_v1' as const,
          operationId: 'operation-1',
          disposition: 'parked' as const,
          reasonCode: input.reasonCode,
          evidenceEventIds: input.evidenceEventIds,
        };
  return {
    id: input.id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 5,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolRecovery: {
        kind: 'maka.tool.recovery_decision',
        version: 1,
        payload,
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  };
}
