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
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import { decodeHostedExecutionStartInput } from '../protocol/index.js';
import {
  hostedExecutionRunProfile,
  projectHostedExecutionTools,
} from '../server/hosted-execution-tool-profile.js';

test('hosted execution tool profiles are durable Session creation inputs', () => {
  const decoded = decodeHostedExecutionStartInput({
    executionId: '00000000-0000-4000-8000-000000000001',
    session: {
      workspace: { kind: 'host_path', path: '/workspace' },
      modelTarget: {
        kind: 'explicit',
        connectionId: 'connection-1',
        connectionSlug: 'provider',
        model: 'model',
      },
      toolProfile: 'headless-coding-v1',
    },
    content: { text: 'solve' },
  });
  assert.equal(decoded.session.toolProfile, 'headless-coding-v1');
  assert.equal(
    decodeHostedExecutionStartInput({
      ...decoded,
      session: { ...decoded.session, toolProfile: 'managed-coding-v1' },
    }).session.toolProfile,
    'managed-coding-v1',
  );
  assert.equal(
    decodeHostedExecutionStartInput({
      ...decoded,
      session: { ...decoded.session, toolProfile: 'managed-coding-v2' },
    }).session.toolProfile,
    'managed-coding-v2',
  );
  assert.throws(
    () =>
      decodeHostedExecutionStartInput({
        ...decoded,
        session: { ...decoded.session, toolProfile: 'unknown-profile' },
      }),
    /Invalid Session tool profile/u,
  );
});

test('the headless coding profile freezes prompt, tools, memory, and foreground Bash', async () => {
  const profile = hostedExecutionRunProfile('headless-coding-v1');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'apply_patch',
  ]);
  assert.equal(profile.memoryExtraction, false);
  assert.equal(
    profile.systemPrompt,
    [
      'Complete the task by acting with the available tools, not by narrating.',
      'Prefer Read, Glob, and Grep for inspection, Edit and Write for file changes, and Bash for shell commands and tests.',
      'Verify the result when practical.',
      'Stop when the task is complete.',
    ].join('\n'),
  );

  const original: MakaTool = {
    name: 'Bash',
    description: 'Product Bash',
    parameters: z.object({
      command: z.string(),
      run_in_background: z.boolean().optional(),
      pty: z.boolean().optional(),
    }),
    impl: async () => 'ok',
  };
  const profileTools = projectHostedExecutionTools(
    [
      original,
      ...profile.toolNames
        .filter((name) => name !== 'Bash')
        .map(
          (name): MakaTool => ({
            name,
            description: name,
            parameters: z.object({}),
            impl: async () => 'ok',
          }),
        ),
      {
        name: 'ScheduledTask',
        description: 'Must stay outside the profile ceiling',
        parameters: z.object({}),
        impl: async () => 'scheduled',
      },
    ],
    'headless-coding-v1',
  );
  assert.deepEqual(
    profileTools.map(({ name }) => name),
    profile.toolNames,
  );
  const bash = profileTools[0];
  assert.ok(bash);
  const schema = bash.parameters as z.ZodType;
  assert.equal((await schema.safeParseAsync({ command: 'true' })).success, true);
  assert.equal(
    (await schema.safeParseAsync({ command: 'true', run_in_background: true })).success,
    false,
  );
  assert.equal((await schema.safeParseAsync({ command: 'true', pty: true })).success, false);
});

test('the WorkHub coordination profile has conversational authority but zero tools', () => {
  const profile = hostedExecutionRunProfile('workhub-coordination-v1');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, []);
  assert.equal(profile.memoryExtraction, false);
  assert.match(profile.systemPrompt, /conversational coordinator for WorkHub/u);
  assert.match(profile.systemPrompt, /no tools, filesystem authority/u);

  const productTool: MakaTool = {
    name: 'Read',
    description: 'Read files',
    parameters: z.object({}),
    impl: async () => 'not reachable',
  };
  assert.deepEqual(projectHostedExecutionTools([productTool], 'workhub-coordination-v1'), []);
});

test('the managed coding profile reads and mutates only the accepted Git tree', () => {
  const profile = hostedExecutionRunProfile('managed-coding-v1');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, ['Read', 'Glob', 'Grep', 'Write', 'Edit']);
  assert.equal(profile.memoryExtraction, false);
  assert.match(profile.systemPrompt, /managed Git workspace/u);
  assert.match(profile.systemPrompt, /Read, Glob, and Grep/u);

  const tools = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'].map(
    (name): MakaTool => ({
      name,
      description: name,
      parameters: z.object({}),
      impl: async () => 'not used by managed mutation execution',
    }),
  );
  const selected = projectHostedExecutionTools(tools, 'managed-coding-v1');
  assert.deepEqual(
    selected.map(({ name }) => name),
    ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
  );
  for (const tool of selected.slice(0, 3)) {
    assert.equal(tool.recoveryMode, 'replay_safe');
    assert.equal(tool.durableExecutionProfile, undefined);
  }
  for (const tool of selected.slice(3)) {
    assert.equal(tool.recoveryMode, 'reconcile');
    assert.equal(tool.durableExecutionProfile, 'managed_mutation_v2');
  }
});

test('managed coding v2 adds only the durable accepted-world Node test', () => {
  const profile = hostedExecutionRunProfile('managed-coding-v2');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ManagedNodeTest']);
  assert.match(profile.systemPrompt, /immutable read-only dependency snapshot/u);

  const tools = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ManagedNodeTest', 'Bash'].map(
    (name): MakaTool => ({
      name,
      description: name,
      parameters: z.object({}),
      impl: async () => 'not used',
    }),
  );
  const selected = projectHostedExecutionTools(tools, 'managed-coding-v2');
  assert.deepEqual(
    selected.map(({ name }) => name),
    ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ManagedNodeTest'],
  );
  assert.equal(selected.at(-1)?.recoveryMode, 'replay_safe');
  assert.equal(selected.at(-1)?.durableExecutionProfile, 'managed_observation_v2');
});

test('managed coding v3 adds only an explicit hermetic accepted-world Node entrypoint', () => {
  const profile = hostedExecutionRunProfile('managed-coding-v3');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, [
    'Read',
    'Glob',
    'Grep',
    'Write',
    'Edit',
    'ManagedNodeTest',
    'ManagedNodeRun',
  ]);
  assert.match(profile.systemPrompt, /explicit accepted-workspace Node entrypoint/u);

  const tools = [
    'Read',
    'Glob',
    'Grep',
    'Write',
    'Edit',
    'ManagedNodeTest',
    'ManagedNodeRun',
    'Bash',
  ].map(
    (name): MakaTool => ({
      name,
      description: name,
      parameters: z.object({}),
      impl: async () => 'not used',
    }),
  );
  const selected = projectHostedExecutionTools(tools, 'managed-coding-v3');
  assert.deepEqual(
    selected.map(({ name }) => name),
    ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ManagedNodeTest', 'ManagedNodeRun'],
  );
  assert.equal(selected.at(-1)?.recoveryMode, 'replay_safe');
  assert.equal(selected.at(-1)?.durableExecutionProfile, 'managed_observation_v3');
});

test('managed coding v4 adds one owner-controlled accepted-world workspace transform', () => {
  const profile = hostedExecutionRunProfile('managed-coding-v4');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, [
    'Read',
    'Glob',
    'Grep',
    'Write',
    'Edit',
    'ManagedNodeTest',
    'ManagedNodeRun',
    'ManagedNodeTransform',
  ]);
  assert.match(profile.systemPrompt, /one bounded UTF-8 workspace file/u);
  const tools = [...profile.toolNames, 'Bash'].map(
    (name): MakaTool => ({
      name,
      description: name,
      parameters: z.object({}),
      impl: async () => 'not used',
    }),
  );
  const selected = projectHostedExecutionTools(tools, 'managed-coding-v4');
  assert.equal(selected.at(-1)?.name, 'ManagedNodeTransform');
  assert.equal(selected.at(-1)?.recoveryMode, 'reconcile');
  assert.equal(selected.at(-1)?.durableExecutionProfile, 'managed_mutation_v2');
});
