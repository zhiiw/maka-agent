import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { ToolOutcomeUnknownError } from '@maka/core/events';
import type {
  RuntimeCommitSink,
  ToolOutcomeCommit,
  ToolPreparedCommit,
} from '../runtime-commit-sink.js';
import {
  ToolRuntime,
  type MakaTool,
  type RuntimeManagedMutationAdmission,
  type ToolRuntimeInput,
} from '../tool-runtime.js';

describe('ToolRuntime durable boundary', () => {
  it('does not invoke the tool or publish a result when T1 fails', async () => {
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => {
        throw new Error('T1 unavailable');
      },
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /T1 unavailable/,
    );

    assert.equal(implementationCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
    assert.equal(
      harness.messages.some((message) => message.type === 'tool_result'),
      false,
    );
  });

  it('does not invoke a tool when another local dispatcher already owns its operation', async () => {
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: false, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /already claimed/,
    );

    assert.equal(implementationCalls, 0);
    assert.deepEqual(
      harness.events.map((event) => event.type),
      ['tool_start'],
    );
    assert.deepEqual(
      harness.messages.map((message) => message.type),
      ['tool_call'],
    );
  });

  it('refuses durable tool execution when the turn carries no run id', async () => {
    let preparedCalls = 0;
    let implementationCalls = 0;
    const harness = makeHarness(
      {
        commitToolPrepared: async () => {
          preparedCalls += 1;
          return { created: true, runtimeEventSeq: 1 };
        },
        commitToolOutcome: async () => {
          throw new Error('must not reach T2');
        },
      },
      undefined,
      null,
    );

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /Durable tool execution requires a run id/,
    );

    assert.equal(preparedCalls, 0);
    assert.equal(implementationCalls, 0);
  });

  it('does not cross T1 when durable dispatch is already aborted', async () => {
    let preparedCalls = 0;
    let implementationCalls = 0;
    const controller = new AbortController();
    controller.abort(new Error('stop before start'));
    const harness = makeHarness({
      commitToolPrepared: async () => {
        preparedCalls += 1;
        return { created: true, runtimeEventSeq: 1 };
      },
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
        controller.signal,
      ),
      /stop before start/,
    );

    assert.equal(preparedCalls, 0);
    assert.equal(implementationCalls, 0);
  });

  it('commits T1 before implementation and T2 before publishing the result', async () => {
    const order: string[] = [];
    const prepared: ToolPreparedCommit[] = [];
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness(
      {
        commitToolPrepared: async (input) => {
          prepared.push(input);
          order.push('t1');
          return { created: true, runtimeEventSeq: 1 };
        },
        commitToolOutcome: async (input) => {
          outcomes.push(input);
          order.push('t2');
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      order,
    );

    const result = await harness.execute(
      tool(() => {
        order.push('impl');
        return { ok: true, text: 'done' };
      }),
    );

    assert.deepEqual(result, { ok: true, text: 'done' });
    assert.deepEqual(order, ['t1', 'impl', 't2', 'published-result']);
    assert.equal(prepared[0]?.runtimeEvent.content?.kind, 'function_call');
    assert.equal(
      prepared[0]?.dispatchRuntimeEvent.actions?.toolDispatch?.protocol,
      't1_after_preflight_v1',
    );
    assert.equal(prepared[0]?.dispatchRuntimeEvent.content, undefined);
    assert.equal(outcomes[0]?.runtimeEvent.content?.kind, 'function_response');
    assert.equal(prepared[0]?.operationId, outcomes[0]?.operationId);
    assert.equal(prepared[0]?.runtimeEvent.refs?.operationId, prepared[0]?.operationId);
    assert.equal(prepared[0]?.dispatchRuntimeEvent.refs?.operationId, prepared[0]?.operationId);
    assert.equal(outcomes[0]?.runtimeEvent.refs?.operationId, prepared[0]?.operationId);
  });

  it('adopts an owner-committed managed successor without invoking generic T2', async () => {
    const order: string[] = [];
    const prepared: ToolPreparedCommit[] = [];
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async (input) => {
          prepared.push(input);
          order.push('t1');
          return { created: true, runtimeEventSeq: 1 };
        },
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      order,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          order.push('admit');
          return managedAdmission(async (operation) => {
            order.push('lease-enter');
            const value = await operation();
            order.push('successor-bundle');
            return {
              kind: 'workspace_successor_committed',
              value,
              durableOutcome: managedOutcomeEvent(operationId, value.outcome.content, false, {
                durationMs: value.outcome.durationMs,
              }),
            };
          }, order);
        },
      },
    );
    const managedTool = tool(() => {
      order.push('impl');
      return { ok: true };
    });
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    assert.deepEqual(await harness.execute(managedTool), { ok: true });
    assert.deepEqual(order, [
      'admit',
      't1',
      'lease-enter',
      'impl',
      'successor-bundle',
      'published-result',
      'dispose',
    ]);
    assert.deepEqual(
      prepared[0]?.dispatchRuntimeEvent.actions?.toolDispatch?.managedMutation,
      managedMutationDispatch(),
    );
  });

  it('leaves a managed T1 unsettled without publishing or writing generic T2', async () => {
    let genericOutcomeCalls = 0;
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async () =>
          managedAdmission(async (operation) => {
            await operation();
            return { kind: 'unsettled', error: new Error('candidate state is unknown') };
          }),
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /candidate state is unknown/i);
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
    assert.equal(
      harness.messages.some((message) => message.type === 'tool_result'),
      false,
    );
  });

  it('fail-stops a thrown managed settlement instead of falling back to generic T2', async () => {
    let genericOutcomeCalls = 0;
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async () =>
          managedAdmission(async (operation) => {
            await operation();
            throw new Error('owner settlement channel failed');
          }),
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /owner settlement channel failed/i);
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('fail-stops a managed success with no durable outcome instead of writing generic T2', async () => {
    let genericOutcomeCalls = 0;
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async () =>
          managedAdmission(async (operation) => {
            const value = await operation();
            return {
              kind: 'workspace_successor_committed',
              value,
            } as never;
          }),
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /durable outcome/i);
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('adopts an owner-committed safe discard without invoking generic T2', async () => {
    let genericOutcomeCalls = 0;
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            await operation();
            const result = { error: 'candidate was safely discarded' };
            return {
              kind: 'safely_discarded',
              providerResult: result,
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: result },
                true,
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    assert.deepEqual(await harness.execute(managedTool), {
      error: 'candidate was safely discarded',
    });
    assert.equal(genericOutcomeCalls, 0);
    const published = harness.events.at(-1);
    assert.equal(published?.type, 'tool_result');
    assert.equal(published?.type === 'tool_result' && published.isError, true);
  });

  it('rejects a safe discard whose live error differs from its durable result', async () => {
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            await operation();
            return {
              kind: 'safely_discarded',
              providerResult: { error: 'live provider error A' },
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: { error: 'durable replay error B' } },
                true,
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /mismatched durable outcome/i);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('fail-stops safe-discard canonicalization without writing generic T2', async () => {
    let genericOutcomeCalls = 0;
    let operationId = '';
    const providerResult = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get: () => {
        throw new Error('provider result getter exploded');
      },
    });
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            await operation();
            return {
              kind: 'safely_discarded',
              providerResult,
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: { error: 'discarded' } },
                true,
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(
      harness.execute(managedTool),
      /provider result getter exploded|byte limit exceeded/i,
    );
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('fail-stops an oversized safe discard before durable publication', async () => {
    let genericOutcomeCalls = 0;
    let operationId = '';
    const oversized = { error: 'x'.repeat(128) };
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            await operation();
            return {
              kind: 'safely_discarded',
              providerResult: oversized,
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: oversized },
                true,
                {
                  origin: 'code_mode',
                  modelVisibility: 'hidden',
                  toolCallId: 'nested-call-1',
                  parentToolCallId: 'exec-1',
                  parentOperationId: 'exec-op-1',
                },
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.executeNested(managedTool, 32), /byte limit exceeded/i);
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(JSON.stringify(harness.events).includes(oversized.error), false);
  });

  it('rejects a durable managed response with a different code-mode envelope', async () => {
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            const value = await operation();
            return {
              kind: 'workspace_successor_committed',
              value,
              durableOutcome: managedOutcomeEvent(operationId, value.outcome.content, false, {
                durationMs: value.outcome.durationMs,
                origin: 'code_mode',
                // The live nested call is hidden. A visible durable replay is
                // a different provider contract and must never be adopted.
                modelVisibility: 'visible',
                toolCallId: 'nested-call-1',
                parentToolCallId: 'exec-1',
                parentOperationId: 'exec-op-1',
              }),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.executeNested(managedTool), /mismatched durable outcome/i);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('refuses a managed mutation before T1 when host admission is unavailable', async () => {
    let preparedCalls = 0;
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => {
        preparedCalls += 1;
        return { created: true, runtimeEventSeq: 1 };
      },
      commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
    });
    const managedTool = tool(() => {
      implementationCalls += 1;
      return { ok: true };
    });
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    assert.deepEqual(await harness.execute(managedTool), {
      error: 'Managed workspace mutation admission is unavailable before T1',
    });
    assert.equal(preparedCalls, 0);
    assert.equal(implementationCalls, 0);
  });

  it('rejects an oversized nested result before durable publication', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const oversized = { text: 'x'.repeat(128) };

    const result = await harness.executeNested(
      tool(() => oversized),
      32,
    );

    assert.equal((result as { error?: unknown }).error, 'Tool result byte limit exceeded');
    assert.equal(JSON.stringify(harness.events).includes(oversized.text), false);
    const durableResult = outcomes[0]?.runtimeEvent.content;
    assert.equal(
      durableResult?.kind === 'function_response'
        ? JSON.stringify(durableResult.result).includes(oversized.text)
        : false,
      false,
    );
  });

  it('uses serialized bytes before publishing a nested string result', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });

    const result = await harness.executeNested(
      tool(() => '\0'.repeat(10)),
      32,
    );

    assert.equal((result as { error?: unknown }).error, 'Tool result byte limit exceeded');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.runtimeEvent.content?.kind, 'function_response');
    assert.equal(
      outcomes[0]?.runtimeEvent.content?.kind === 'function_response' &&
        outcomes[0].runtimeEvent.content.isError,
      true,
    );
    assert.equal(JSON.stringify(outcomes).includes('\\u0000'), false);
    assert.equal(JSON.stringify(harness.events).includes('\\u0000'), false);
  });

  it('rejects an array whose toJSON expands beyond the nested result limit', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const resultArray: unknown[] = [];
    Object.defineProperty(resultArray, 'toJSON', {
      value: () => 'x'.repeat(128),
    });

    const result = await harness.executeNested(
      tool(() => resultArray),
      32,
    );

    assert.equal((result as { error?: unknown }).error, 'Tool result byte limit exceeded');
    assert.equal(JSON.stringify(outcomes).includes('x'.repeat(128)), false);
    assert.equal(JSON.stringify(harness.events).includes('x'.repeat(128)), false);
  });

  it('rejects a non-JSON nested result before coercion can expand it', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const callable = () => null;
    callable.toString = () => 'NON_JSON_RESULT'.repeat(32);

    const result = await harness.executeNested(
      tool(() => callable),
      32,
    );

    assert.equal((result as { error?: unknown }).error, 'Tool result byte limit exceeded');
    assert.equal(JSON.stringify(outcomes).includes('NON_JSON_RESULT'), false);
    assert.equal(JSON.stringify(harness.events).includes('NON_JSON_RESULT'), false);
  });

  it('persists nested CodeMode identity across durable and legacy tool activity', async () => {
    const prepared: ToolPreparedCommit[] = [];
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async (input) => {
        prepared.push(input);
        return { created: true, runtimeEventSeq: 1 };
      },
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });

    await harness.executeNested(tool(() => ({ ok: true })));

    for (const event of [
      prepared[0]?.runtimeEvent,
      prepared[0]?.dispatchRuntimeEvent,
      outcomes[0]?.runtimeEvent,
    ]) {
      assert.equal(event?.origin, 'code_mode');
      assert.equal(event?.modelVisibility, 'hidden');
      assert.equal(event?.refs?.parentToolCallId, 'exec-1');
      assert.equal(event?.refs?.parentOperationId, 'exec-op-1');
    }
    for (const event of harness.events) {
      if (event.type !== 'tool_start' && event.type !== 'tool_result') continue;
      assert.equal(event.origin, 'code_mode');
      assert.equal(event.modelVisibility, 'hidden');
      assert.equal(event.parentToolCallId, 'exec-1');
      assert.equal(event.parentOperationId, 'exec-op-1');
    }
    for (const message of harness.messages) {
      if (message.type !== 'tool_call' && message.type !== 'tool_result') continue;
      assert.equal(message.origin, 'code_mode');
      assert.equal(message.modelVisibility, 'hidden');
      assert.equal(message.parentToolCallId, 'exec-1');
      assert.equal(message.parentOperationId, 'exec-op-1');
    }
  });

  it('links nested live output to the outer exec activity', async () => {
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
    });

    await harness.executeNested(
      tool((_input, context) => {
        context.emitOutput('stdout', 'working\n');
        return { ok: true };
      }),
    );

    const output = harness.events.find((event) => event.type === 'tool_output_delta');
    assert.ok(output);
    assert.equal(output.origin, 'code_mode');
    assert.equal(output.modelVisibility, 'hidden');
    assert.equal(output.parentToolCallId, 'exec-1');
    assert.equal(output.parentOperationId, 'exec-op-1');
  });

  it('retains nested identity when the tool settles with an error', async () => {
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
    });

    await harness.executeNested(
      tool(() => {
        throw new Error('nested failure');
      }),
    );

    const result = harness.events.find(
      (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
        event.type === 'tool_result' && event.toolUseId === 'nested-call-1',
    );
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.equal(result.origin, 'code_mode');
    assert.equal(result.modelVisibility, 'hidden');
    assert.equal(result.parentToolCallId, 'exec-1');
    assert.equal(result.parentOperationId, 'exec-op-1');
    const stored = harness.messages.find(
      (message): message is Extract<StoredMessage, { type: 'tool_result' }> =>
        message.type === 'tool_result' && message.toolUseId === 'nested-call-1',
    );
    assert.equal(stored?.origin, 'code_mode');
    assert.equal(stored?.modelVisibility, 'hidden');
  });

  it('wraps business-domain kind values as canonical JSON tool results', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const output = {
      kind: 'plan_submitted',
      proposal: { proposalId: 'proposal-1' },
      storeVersion: 1,
    };

    assert.deepEqual(await harness.execute(tool(() => output)), output);
    const response = outcomes[0]?.runtimeEvent.content;
    assert.equal(response?.kind, 'function_response');
    assert.deepEqual(response?.kind === 'function_response' ? response.result : undefined, {
      kind: 'json',
      value: output,
    });
    const message = harness.messages.find((candidate) => candidate.type === 'tool_result');
    assert.deepEqual(message?.type === 'tool_result' ? message.content : undefined, {
      kind: 'json',
      value: output,
    });
  });

  it('does not publish an implementation result when T2 fails', async () => {
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => {
        throw new Error('T2 unavailable');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /T2 unavailable/,
    );

    assert.equal(implementationCalls, 1);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
    assert.equal(
      harness.messages.some((message) => message.type === 'tool_result'),
      false,
    );
  });

  it('commits a normalized error outcome before returning a thrown tool failure to the model', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });

    await harness.execute(
      tool(() => {
        throw new Error('tool exploded');
      }),
    );

    const response = outcomes[0]?.runtimeEvent.content;
    assert.equal(response?.kind, 'function_response');
    assert.equal(response?.kind === 'function_response' && response.isError, true);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result' && event.isError),
      true,
    );
  });

  it('commits outcome_unknown as a structured non-retryable tool failure', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const uncertain = tool(() => {
      throw new ToolOutcomeUnknownError('Provider disconnected after accepting the action');
    });
    uncertain.recoveryMode = 'never_auto_retry';

    const result = await harness.execute(uncertain);

    assert.deepEqual(result, {
      error: 'outcome_unknown: Provider disconnected after accepting the action',
    });
    const response = outcomes[0]?.runtimeEvent.content;
    assert.equal(response?.kind, 'function_response');
    assert.equal(response?.kind === 'function_response' && response.isError, true);
    assert.deepEqual(response?.kind === 'function_response' ? response.result : undefined, {
      kind: 'text',
      text: 'outcome_unknown: Provider disconnected after accepting the action',
      uncertainOutcome: {
        code: 'outcome_unknown',
        retrySafe: false,
      },
    });
    const message = harness.messages.find((candidate) => candidate.type === 'tool_result');
    assert.deepEqual(message?.type === 'tool_result' ? message.content : undefined, {
      kind: 'text',
      text: 'outcome_unknown: Provider disconnected after accepting the action',
      uncertainOutcome: {
        code: 'outcome_unknown',
        retrySafe: false,
      },
    });
  });
});

// `null` means the turn carries no run id at all; `undefined` keeps the default.
function makeHarness(
  sink: RuntimeCommitSink,
  order?: string[],
  runId: string | null = 'run-1',
  overrides: Partial<ToolRuntimeInput> = {},
) {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'model-1',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: nextNow(),
    getPermissionPauseTarget: () => null,
    ...(runId ? { runId } : {}),
    runtimeCommitSink: sink,
    ...overrides,
  });
  return {
    messages,
    events,
    execute: async (target: MakaTool, abortSignal: AbortSignal = new AbortController().signal) =>
      (
        await runtime.settleToolCall({
          tool: target,
          turnId: 'turn-1',
          toolCallId: 'provider-call-1',
          input: {},
          abortSignal,
          eventSink: {
            push: (event) => {
              events.push(event);
              if (event.type === 'tool_result') order?.push('published-result');
            },
            pushAndWaitUntilConsumed: async (event) => {
              events.push(event);
              if (event.type === 'tool_result') order?.push('published-result');
            },
          },
        })
      ).result,
    executeNested: async (target: MakaTool, maxResultBytes?: number) =>
      (
        await runtime.settleToolCall({
          tool: target,
          turnId: 'turn-1',
          toolCallId: 'nested-call-1',
          input: {},
          abortSignal: new AbortController().signal,
          eventSink: {
            push: (event) => events.push(event),
            pushAndWaitUntilConsumed: async (event) => {
              events.push(event);
            },
          },
          origin: 'code_mode',
          parentToolCallId: 'exec-1',
          parentOperationId: 'exec-op-1',
          ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
        })
      ).result,
  };
}

function managedAdmission(
  execute: RuntimeManagedMutationAdmission['execute'],
  order?: string[],
): RuntimeManagedMutationAdmission {
  return {
    durableDispatch: managedMutationDispatch(),
    execute,
    dispose: async () => {
      order?.push('dispose');
    },
  };
}

function managedOutcomeEvent(
  operationId: string,
  result: unknown,
  isError: boolean,
  options: {
    durationMs?: number;
    origin?: 'provider' | 'code_mode';
    modelVisibility?: 'visible' | 'hidden';
    toolCallId?: string;
    parentToolCallId?: string;
    parentOperationId?: string;
  } = {},
) {
  const toolCallId = options.toolCallId ?? 'provider-call-1';
  return {
    id: `${operationId}_response`,
    invocationId: 'run-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 100,
    partial: false,
    role: 'tool' as const,
    author: 'tool' as const,
    origin: options.origin ?? ('provider' as const),
    modelVisibility: options.modelVisibility ?? ('visible' as const),
    content: {
      kind: 'function_response' as const,
      id: toolCallId,
      name: 'Write',
      result,
      ...(isError ? { isError: true } : {}),
    },
    refs: {
      operationId,
      toolCallId,
      ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
      ...(options.parentOperationId ? { parentOperationId: options.parentOperationId } : {}),
    },
    actions: { stateDelta: { durationMs: options.durationMs ?? 0 } },
  };
}

function managedMutationDispatch() {
  return {
    protocol: 'managed_mutation_v1' as const,
    repositoryId: 'repository_11111111111111111111111111111111',
    workspaceId: 'workspace_22222222222222222222222222222222',
    workspaceEpochId: 'epoch_33333333333333333333333333333333',
    workspaceInstanceId: 'instance_44444444444444444444444444444444',
    objectFormat: 'sha1' as const,
    baseWorkspaceVersionId: 'version_55555555555555555555555555555555',
    baseAcceptedEventId: 'baseline-event-1',
    baseHeadRevision: 1,
    baseCommitOid: '1'.repeat(40),
    baseTreeOid: '2'.repeat(40),
    expectedPaths: ['notes.txt'],
    executionProfileDigest: `sha256:${'a'.repeat(64)}` as const,
  };
}

function tool(impl: MakaTool['impl']): MakaTool {
  return {
    name: 'Read',
    description: 'read',
    parameters: {},
    recoveryMode: 'replay_safe',
    impl,
  };
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/repo',
    cwd: '/workspace/repo',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

function nextNow(): () => number {
  let value = 0;
  return () => ++value;
}
