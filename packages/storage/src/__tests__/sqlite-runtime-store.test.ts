import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { RuntimeEvent } from '@maka/core';
import {
  SQLITE_RUNTIME_SCHEMA_VERSION,
  createSqliteRuntimeStore,
  type SqliteRuntimeStoreFailpoint,
} from '../sqlite-runtime-store.js';

describe('SqliteRuntimeStore', () => {
  it('applies versioned migrations and reopens the same database without rewriting schema', async () => {
    await withStore(async (store, dbPath) => {
      assert.equal(SQLITE_RUNTIME_SCHEMA_VERSION, 5);
      assert.equal(store.schemaVersion(), SQLITE_RUNTIME_SCHEMA_VERSION);
      assert.equal(store.recoveryBundleCapability, 'tool_recovery_bundle_v1');
      assert.equal(store.journalMode(), 'wal');
      assert.equal(store.foreignKeysEnabled(), true);
      store.close();

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        assert.equal(reopened.schemaVersion(), SQLITE_RUNTIME_SCHEMA_VERSION);
        assert.deepEqual(await reopened.readRuntimeEvents('session-1', 'run-1'), []);
      } finally {
        reopened.close();
      }
    });
  });

  it('commits function_call, dispatch fact, and operation projection atomically in T1', async () => {
    await withStore(async (store) => {
      const call = functionCallEvent();
      const dispatch = toolDispatchEvent();

      const input = {
        operationId: 'operation-1',
        journalEventId: 'journal-prepared-1',
        runtimeEvent: call,
        dispatchRuntimeEvent: dispatch,
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
        committedAt: 10,
      } as const;
      const result = await store.commitToolPrepared(input);

      assert.equal(result.created, true);
      assert.equal(result.runtimeEventSeq, 2);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [call, dispatch]);
      assert.deepEqual(await store.readToolOperation('operation-1'), {
        operationId: 'operation-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
        currentState: 'prepared',
        callEventId: 'call-event-1',
        dispatchEventId: 'dispatch-event-1',
        version: 1,
      });
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared'],
      );
      assert.equal((await store.readToolJournal('operation-1'))[0]?.runtimeEventId, dispatch.id);
      assert.deepEqual(
        (await store.listUnsettledToolOperations()).map((operation) => operation.operationId),
        ['operation-1'],
      );
    });
  });

  it('claims an exact function_call that was committed while permission was pending', async () => {
    await withStore(async (store) => {
      const call = functionCallEvent();
      await store.appendRuntimeEvent('session-1', 'run-1', call);

      const result = await commitPrepared(store);

      assert.equal(result.created, true);
      assert.equal(result.runtimeEventSeq, 2);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [
        call,
        toolDispatchEvent(),
      ]);
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
    });
  });

  it('upgrades a populated schema 4 database without losing immutable events', async () => {
    await withStore(async (store, dbPath) => {
      const event = functionCallEvent();
      await store.appendRuntimeEvent('session-1', 'run-1', event);
      store.close();

      const legacy = new DatabaseSync(dbPath);
      try {
        legacy.exec('DROP TABLE runtime_capabilities');
        legacy.exec('PRAGMA user_version = 4');
      } finally {
        legacy.close();
      }

      const upgraded = createSqliteRuntimeStore(dbPath);
      try {
        assert.equal(upgraded.schemaVersion(), 5);
        assert.equal(upgraded.recoveryBundleCapability, 'tool_recovery_bundle_v1');
        assert.deepEqual(await upgraded.readImmutableRuntimeEvents('session-1', 'run-1'), [event]);
      } finally {
        upgraded.close();
      }
    });
  });

  it('fails closed when schema 5 does not declare the recovery bundle capability', async () => {
    await withStore(async (store, dbPath) => {
      store.close();
      const database = new DatabaseSync(dbPath);
      try {
        database.exec("DELETE FROM runtime_capabilities WHERE capability = 'tool_recovery_bundle'");
      } finally {
        database.close();
      }

      assert.throws(
        () => createSqliteRuntimeStore(dbPath),
        /runtime recovery capability tool_recovery_bundle@1 is unavailable/i,
      );
    });
  });

  it('rejects canonical recovery facts through the generic RuntimeEvent append path', async () => {
    await withStore(async (store) => {
      const recoveryFact = reconcileResultEvent();
      await assert.rejects(
        store.appendRuntimeEvent('session-1', 'run-1', recoveryFact),
        /recovery bundle writer/i,
      );
      await assert.rejects(
        store.importRuntimeEventsBatch({
          sessionId: 'session-1',
          runId: 'run-1',
          events: [recoveryFact],
        }),
        /recovery bundle writer/i,
      );
      await assert.rejects(
        store.ensureTerminalRuntimeEventDurable('session-1', 'run-1', {
          ...recoveryFact,
          id: 'terminal-recovery-event-1',
          status: 'completed',
          actions: {
            ...recoveryFact.actions,
            endInvocation: true,
          },
        }),
        /recovery bundle writer/i,
      );

      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
    });
  });

  it('rejects a reserved recovery fact hidden in the T1 function call', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-1',
          journalEventId: 'journal-prepared-1',
          runtimeEvent: functionCallEvent({
            actions: { toolRecovery: reconcileResultEvent().actions!.toolRecovery! },
          }),
          dispatchRuntimeEvent: toolDispatchEvent(),
          providerToolCallId: 'provider-call-1',
          toolName: 'Read',
          canonicalArgsHash: 'sha256:args-1',
          recoveryMode: 'replay_safe',
          committedAt: 10,
        }),
        /recovery bundle writer/i,
      );

      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
      assert.equal(await store.readToolOperation('operation-1'), undefined);
    });
  });

  it('rejects a reserved recovery fact hidden in the T1 dispatch', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-1',
          journalEventId: 'journal-prepared-1',
          runtimeEvent: functionCallEvent(),
          dispatchRuntimeEvent: toolDispatchEvent({
            actions: {
              toolDispatch: toolDispatchEvent().actions!.toolDispatch!,
              toolRecovery: reconcileResultEvent().actions!.toolRecovery!,
            },
          }),
          providerToolCallId: 'provider-call-1',
          toolName: 'Read',
          canonicalArgsHash: 'sha256:args-1',
          recoveryMode: 'replay_safe',
          committedAt: 10,
        }),
        /recovery bundle writer/i,
      );

      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
      assert.equal(await store.readToolOperation('operation-1'), undefined);
    });
  });

  it('atomically commits reconcile, matching outcome, and completed decision as one bundle', async () => {
    await withStore(async (store) => {
      await commitReconcilePrepared(store);
      const recoveryStore = store as Store & {
        commitToolRecoveryBundle(input: {
          operationId: string;
          reconcileRuntimeEvent: RuntimeEvent;
          outcomeRuntimeEvent: RuntimeEvent;
          decisionRuntimeEvent: RuntimeEvent;
        }): Promise<void>;
      };
      const reconcile = reconcileResultEvent();
      const outcome = functionResponseEvent({ ts: 21 });
      const decision = recoveryDecisionEvent();

      await recoveryStore.commitToolRecoveryBundle({
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcile,
        outcomeRuntimeEvent: outcome,
        decisionRuntimeEvent: decision,
      });

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
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared', 'reconcile_recorded', 'outcome_committed', 'recovery_decided'],
      );
      assert.equal(
        (await store.readToolOperation('operation-1'))?.currentState,
        'outcome_committed',
      );
      assert.equal(
        (await store.readToolOperation('operation-1'))?.resultEventId,
        'response-event-1',
      );
    });
  });

  it('rejects a reserved recovery fact hidden in a recovery bundle outcome', async () => {
    await withStore(async (store) => {
      await commitReconcilePrepared(store);

      await assert.rejects(
        store.commitToolRecoveryBundle({
          operationId: 'operation-1',
          reconcileRuntimeEvent: reconcileResultEvent(),
          outcomeRuntimeEvent: functionResponseEvent({
            ts: 21,
            actions: { toolRecovery: reconcileResultEvent().actions!.toolRecovery! },
          }),
          decisionRuntimeEvent: recoveryDecisionEvent(),
        }),
        /recovery bundle writer/i,
      );

      assert.deepEqual(
        (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['call-event-1', 'dispatch-event-1'],
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
    });
  });

  it('rolls back every recovery fact and outcome when the bundle fails after outcome', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      await commitReconcilePrepared(store);
      setFailpoint('after_recovery_outcome');

      await assert.rejects(
        store.commitToolRecoveryBundle({
          operationId: 'operation-1',
          reconcileRuntimeEvent: reconcileResultEvent(),
          outcomeRuntimeEvent: functionResponseEvent({ ts: 21 }),
          decisionRuntimeEvent: recoveryDecisionEvent(),
        }),
        /sqlite runtime failpoint: after_recovery_outcome/,
      );

      assert.deepEqual(
        (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['call-event-1', 'dispatch-event-1'],
      );
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared'],
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
    });
  });

  it('rolls back the reconcile fact when the recovery bundle fails immediately after it', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      await commitReconcilePrepared(store);
      setFailpoint('after_recovery_reconcile');

      await assert.rejects(
        store.commitToolRecoveryBundle({
          operationId: 'operation-1',
          reconcileRuntimeEvent: reconcileResultEvent(),
          outcomeRuntimeEvent: functionResponseEvent({ ts: 21 }),
          decisionRuntimeEvent: recoveryDecisionEvent(),
        }),
        /sqlite runtime failpoint: after_recovery_reconcile/,
      );

      assert.deepEqual(
        (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['call-event-1', 'dispatch-event-1'],
      );
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared'],
      );
      assert.deepEqual(
        (await store.listUnsettledToolOperations()).map((operation) => operation.operationId),
        ['operation-1'],
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      assert.equal((await store.readToolOperation('operation-1'))?.version, 1);
    });
  });

  it('rejects completed recovery without an outcome and leaves only the prepared boundary', async () => {
    await withStore(async (store) => {
      await commitReconcilePrepared(store);

      await assert.rejects(
        store.commitToolRecoveryBundle({
          operationId: 'operation-1',
          reconcileRuntimeEvent: reconcileResultEvent(),
          decisionRuntimeEvent: recoveryDecisionEvent(),
        }),
        /requires a persisted outcome/i,
      );

      assert.deepEqual(
        (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['call-event-1', 'dispatch-event-1'],
      );
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared'],
      );
    });
  });

  it('deduplicates an exact recovery bundle retry after the first commit succeeded', async () => {
    await withStore(async (store) => {
      await commitReconcilePrepared(store);
      const bundle = {
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcileResultEvent(),
        outcomeRuntimeEvent: functionResponseEvent({ ts: 21 }),
        decisionRuntimeEvent: recoveryDecisionEvent(),
      } as const;

      await store.commitToolRecoveryBundle(bundle);
      await store.commitToolRecoveryBundle(bundle);

      assert.equal((await store.readToolJournal('operation-1')).length, 4);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 5);
    });
  });

  it('atomically parks an operation and deduplicates the exact parked bundle', async () => {
    await withStore(async (store) => {
      await commitReconcilePrepared(store);
      const bundle = {
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcileResultEvent({
          actions: {
            toolRecovery: {
              kind: 'maka.tool.reconcile_result',
              version: 1,
              payload: {
                protocol: 'tool_reconcile_v1',
                operationId: 'operation-1',
                result: 'conflict',
                observationDigest: 'sha256:conflict',
                observedAt: '2026-07-25T00:00:00.000Z',
              },
            },
          },
        }),
        decisionRuntimeEvent: recoveryDecisionEvent({
          actions: {
            toolRecovery: {
              kind: 'maka.tool.recovery_decision',
              version: 1,
              payload: {
                protocol: 'tool_recovery_v1',
                operationId: 'operation-1',
                disposition: 'parked',
                reasonCode: 'reconcile_conflict',
                evidenceEventIds: ['call-event-1', 'dispatch-event-1', 'reconcile-event-1'],
              },
            },
          },
        }),
      } as const;

      await store.commitToolRecoveryBundle(bundle);
      await store.commitToolRecoveryBundle(bundle);

      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'recovery_parked');
      assert.deepEqual(await store.listUnsettledToolOperations(), []);
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared', 'reconcile_recorded', 'recovery_decided'],
      );

      assert.deepEqual(await store.rebuildToolProjectionsFromRuntimeEvents(), {
        operations: 1,
        journalEvents: 3,
      });
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'recovery_parked');
      assert.deepEqual(await store.listUnsettledToolOperations(), []);
    });
  });

  it('rolls back every T1 row when failure occurs after the RuntimeEvent insert', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      setFailpoint('after_runtime_event_insert');

      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-t1-failure',
          journalEventId: 'journal-t1-failure',
          runtimeEvent: functionCallEvent({ id: 'call-t1-failure' }),
          dispatchRuntimeEvent: toolDispatchEvent({
            id: 'dispatch-t1-failure',
            refs: { operationId: 'operation-t1-failure', toolCallId: 'provider-call-1' },
            actions: {
              toolDispatch: {
                protocol: 't1_after_preflight_v1',
                operationId: 'operation-t1-failure',
                providerToolCallId: 'provider-call-1',
                toolName: 'Read',
                canonicalArgsHash: 'sha256:t1-failure',
                recoveryMode: 'replay_safe',
              },
            },
          }),
          providerToolCallId: 'provider-call-1',
          toolName: 'Read',
          canonicalArgsHash: 'sha256:t1-failure',
          recoveryMode: 'replay_safe',
          committedAt: 11,
        }),
        /sqlite runtime failpoint: after_runtime_event_insert/,
      );

      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), []);
      assert.equal(await store.readToolOperation('operation-t1-failure'), undefined);
      assert.deepEqual(await store.readToolJournal('operation-t1-failure'), []);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 0);
    });
  });

  it('commits function_response, outcome journal fact, and projection atomically in T2', async () => {
    await withStore(async (store) => {
      await commitPrepared(store);
      const outcome = functionResponseEvent();

      const result = await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'journal-outcome-1',
        runtimeEvent: outcome,
        committedAt: 20,
      });

      assert.equal(result.created, true);
      assert.equal(result.runtimeEventSeq, 3);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [
        functionCallEvent(),
        toolDispatchEvent(),
        outcome,
      ]);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 3);
      assert.deepEqual(await store.readToolOperation('operation-1'), {
        operationId: 'operation-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
        currentState: 'outcome_committed',
        callEventId: 'call-event-1',
        dispatchEventId: 'dispatch-event-1',
        resultEventId: 'response-event-1',
        version: 2,
      });
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared', 'outcome_committed'],
      );
      assert.deepEqual(await store.listUnsettledToolOperations(), []);
    });
  });

  it('rejects a reserved recovery fact hidden in the normal T2 outcome', async () => {
    await withStore(async (store) => {
      await commitPrepared(store);

      await assert.rejects(
        store.commitToolOutcome({
          operationId: 'operation-1',
          journalEventId: 'journal-outcome-1',
          runtimeEvent: functionResponseEvent({
            actions: { toolRecovery: reconcileResultEvent().actions!.toolRecovery! },
          }),
          committedAt: 20,
        }),
        /recovery bundle writer/i,
      );

      assert.deepEqual(
        (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['call-event-1', 'dispatch-event-1'],
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
    });
  });

  it('rolls back T2 without hiding the previously committed prepared boundary', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      await commitPrepared(store);
      setFailpoint('after_runtime_event_insert');

      await assert.rejects(
        store.commitToolOutcome({
          operationId: 'operation-1',
          journalEventId: 'journal-outcome-failure',
          runtimeEvent: functionResponseEvent({ id: 'response-t2-failure' }),
          committedAt: 21,
        }),
        /sqlite runtime failpoint: after_runtime_event_insert/,
      );

      assert.deepEqual(
        (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['call-event-1', 'dispatch-event-1'],
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared'],
      );
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 2);
    });
  });

  it('deduplicates exact T1/T2 retries and rejects operation identity drift', async () => {
    await withStore(async (store) => {
      const firstPrepared = await commitPrepared(store);
      const duplicatePrepared = await commitPrepared(store);
      assert.equal(firstPrepared.created, true);
      assert.equal(duplicatePrepared.created, false);

      const firstOutcome = await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'journal-outcome-1',
        runtimeEvent: functionResponseEvent(),
        committedAt: 20,
      });
      const duplicateOutcome = await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'journal-outcome-1',
        runtimeEvent: functionResponseEvent(),
        committedAt: 20,
      });
      assert.equal(firstOutcome.created, true);
      assert.equal(duplicateOutcome.created, false);
      assert.equal((await store.readToolJournal('operation-1')).length, 2);
      assert.equal((await store.readRuntimeEvents('session-1', 'run-1')).length, 3);

      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-1',
          journalEventId: 'journal-prepared-drift',
          runtimeEvent: functionCallEvent(),
          dispatchRuntimeEvent: toolDispatchEvent({
            actions: {
              toolDispatch: {
                protocol: 't1_after_preflight_v1',
                operationId: 'operation-1',
                providerToolCallId: 'provider-call-1',
                toolName: 'Read',
                canonicalArgsHash: 'sha256:different-args',
                recoveryMode: 'replay_safe',
              },
            },
          }),
          providerToolCallId: 'provider-call-1',
          toolName: 'Read',
          canonicalArgsHash: 'sha256:different-args',
          recoveryMode: 'replay_safe',
          committedAt: 30,
        }),
        /operation identity conflict/,
      );
    });
  });

  it('rebuilds disposable tool projections from RuntimeEvent facts', async () => {
    await withStore(async (store) => {
      await commitPrepared(store);
      await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'journal-outcome-1',
        runtimeEvent: functionResponseEvent(),
        committedAt: 20,
      });

      const result = await store.rebuildToolProjectionsFromRuntimeEvents();

      assert.deepEqual(result, { operations: 1, journalEvents: 2 });
      assert.equal(
        (await store.readToolOperation('operation-1'))?.dispatchEventId,
        'dispatch-event-1',
      );
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => ({
          state: event.state,
          runtimeEventId: event.runtimeEventId,
        })),
        [
          { state: 'prepared', runtimeEventId: 'dispatch-event-1' },
          { state: 'outcome_committed', runtimeEventId: 'response-event-1' },
        ],
      );
    });
  });

  it('rebuilds the recovery journal tail in canonical RuntimeEvent sequence order', async () => {
    await withStore(async (store) => {
      await commitReconcilePrepared(store);
      await store.commitToolRecoveryBundle({
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcileResultEvent({ ts: 100 }),
        outcomeRuntimeEvent: functionResponseEvent({ ts: 100 }),
        decisionRuntimeEvent: recoveryDecisionEvent({ ts: 100 }),
      });

      const result = await store.rebuildToolProjectionsFromRuntimeEvents();

      assert.deepEqual(result, { operations: 1, journalEvents: 4 });
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => ({
          state: event.state,
          runtimeEventId: event.runtimeEventId,
        })),
        [
          { state: 'prepared', runtimeEventId: 'dispatch-event-1' },
          { state: 'reconcile_recorded', runtimeEventId: 'reconcile-event-1' },
          { state: 'outcome_committed', runtimeEventId: 'response-event-1' },
          { state: 'recovery_decided', runtimeEventId: 'recovery-decision-event-1' },
        ],
      );
    });
  });

  it('rejects projection rebuild when recovery facts violate physical event order', async () => {
    await withStore(async (store, dbPath) => {
      await commitReconcilePrepared(store);
      await store.commitToolRecoveryBundle({
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcileResultEvent(),
        outcomeRuntimeEvent: functionResponseEvent(),
        decisionRuntimeEvent: recoveryDecisionEvent(),
      });

      const database = new DatabaseSync(dbPath);
      try {
        database.exec(`
          UPDATE runtime_events SET event_seq = event_seq + 100
          WHERE event_id IN ('response-event-1', 'recovery-decision-event-1');
          UPDATE runtime_events SET event_seq = 4
          WHERE event_id = 'recovery-decision-event-1';
          UPDATE runtime_events SET event_seq = 5
          WHERE event_id = 'response-event-1';
        `);
      } finally {
        database.close();
      }

      await assert.rejects(
        store.rebuildToolProjectionsFromRuntimeEvents(),
        /canonical RuntimeEvent causal order/i,
      );
    });
  });

  it('rejects an unsupported recovery fact version read from SQLite', async () => {
    await withStore(async (store, dbPath) => {
      await commitReconcilePrepared(store);
      await store.commitToolRecoveryBundle({
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcileResultEvent(),
        outcomeRuntimeEvent: functionResponseEvent({ ts: 21 }),
        decisionRuntimeEvent: recoveryDecisionEvent(),
      });

      const database = new DatabaseSync(dbPath);
      try {
        const row = database
          .prepare('SELECT payload_json FROM runtime_events WHERE event_id = ?')
          .get('reconcile-event-1') as { payload_json: string };
        const malformed = JSON.parse(row.payload_json) as {
          actions: { toolRecovery: { version: number } };
        };
        malformed.actions.toolRecovery.version = 999;
        database
          .prepare('UPDATE runtime_events SET payload_json = ? WHERE event_id = ?')
          .run(JSON.stringify(malformed), 'reconcile-event-1');
      } finally {
        database.close();
      }

      await assert.rejects(
        store.readImmutableRuntimeEvents('session-1', 'run-1'),
        /Invalid RuntimeEvent schema/,
      );
      await assert.rejects(
        store.rebuildToolProjectionsFromRuntimeEvents(),
        /Invalid RuntimeEvent schema/,
      );
    });
  });

  it('coalesces stream chunks outside the immutable high-water ledger', async () => {
    await withStore(async (store) => {
      for (const [index, text] of ['hel', 'lo', '!'].entries()) {
        await store.appendRuntimeEvent(
          'session-1',
          'run-1',
          functionCallEvent({
            id: `partial-${index}`,
            ts: index + 1,
            partial: true,
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text },
            refs: { providerEventId: 'message-1' },
          }),
        );
      }

      const visible = await store.readRuntimeEvents('session-1', 'run-1');
      assert.equal(visible.length, 1);
      assert.deepEqual(visible[0]?.content, { kind: 'text', text: 'hello!' });
      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 0);
    });
  });

  it('replaces text and tool partial snapshots when their durable final arrives', async () => {
    await withStore(async (store) => {
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'text-partial',
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'working' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'tool-partial',
          partial: true,
          role: 'tool',
          author: 'tool',
          content: undefined,
          refs: { toolCallId: 'provider-call-1' },
        }),
      );
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'text-final',
          ts: 2,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'done' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionResponseEvent({
          refs: { toolCallId: 'provider-call-1' },
        }),
      );

      assert.deepEqual(
        (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['text-final', 'response-event-1'],
      );
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 2);
    });
  });
});

type Store = ReturnType<typeof createSqliteRuntimeStore>;

async function withStore(
  run: (
    store: Store,
    dbPath: string,
    setFailpoint: (point: SqliteRuntimeStoreFailpoint | undefined) => void,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-runtime-'));
  const dbPath = join(root, 'runtime.sqlite');
  let failpoint: SqliteRuntimeStoreFailpoint | undefined;
  const store = createSqliteRuntimeStore(dbPath, {
    failpoint: (point) => {
      if (failpoint === point) throw new Error(`sqlite runtime failpoint: ${point}`);
    },
  });
  try {
    await run(store, dbPath, (point) => {
      failpoint = point;
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function functionCallEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
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
      args: { path: '/workspace/repo/README.md' },
    },
    ...overrides,
  };
}

function functionResponseEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
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
    ...overrides,
  };
}

function toolDispatchEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'dispatch-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 10,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
    ...overrides,
  };
}

function reconcileResultEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'reconcile-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 20,
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
          result: 'applied',
          observationDigest: 'sha256:observation-1',
          observedAt: '2026-07-25T00:00:00.000Z',
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
    ...overrides,
  };
}

function recoveryDecisionEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'recovery-decision-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 22,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolRecovery: {
        kind: 'maka.tool.recovery_decision',
        version: 1,
        payload: {
          protocol: 'tool_recovery_v1',
          operationId: 'operation-1',
          disposition: 'completed',
          reasonCode: 'reconcile_applied',
          outcomeEventId: 'response-event-1',
          evidenceEventIds: [
            'call-event-1',
            'dispatch-event-1',
            'reconcile-event-1',
            'response-event-1',
          ],
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
    ...overrides,
  };
}

function commitPrepared(store: Store) {
  return store.commitToolPrepared({
    operationId: 'operation-1',
    journalEventId: 'journal-prepared-1',
    runtimeEvent: functionCallEvent(),
    dispatchRuntimeEvent: toolDispatchEvent(),
    providerToolCallId: 'provider-call-1',
    toolName: 'Read',
    canonicalArgsHash: 'sha256:args-1',
    recoveryMode: 'replay_safe',
    committedAt: 10,
  });
}

function commitReconcilePrepared(store: Store) {
  return store.commitToolPrepared({
    operationId: 'operation-1',
    journalEventId: 'journal-prepared-1',
    runtimeEvent: functionCallEvent(),
    dispatchRuntimeEvent: toolDispatchEvent({
      actions: {
        toolDispatch: {
          ...toolDispatchEvent().actions!.toolDispatch!,
          recoveryMode: 'reconcile',
        },
      },
    }),
    providerToolCallId: 'provider-call-1',
    toolName: 'Read',
    canonicalArgsHash: 'sha256:args-1',
    recoveryMode: 'reconcile',
    committedAt: 10,
  });
}
