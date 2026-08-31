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
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openInteractiveExecutionStoresForRead } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
} from '@maka/storage/root-authority';
import {
  connectClient,
  ExecutionFixture,
  PROCESS_TIMEOUT_MS,
  withTimeout,
} from './fixtures/execution-host-suite.js';
import { GITOXIDE_HELPER_OPERATIONS_INTERNAL } from '../server/gitoxide-helper-artifact-authority-internal.js';

const MODEL_ID = 'moonshot-managed-v2-fixture';
const API_KEY = 'managed-v2-fixture-key';

test('packaged managed-coding-v2 resumes after Host death without replaying a completed Node test', {
  timeout: 90_000,
}, async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the packaged v2 crash gate');
    return;
  }
  const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-managed-v2-crash-')));
  const root = join(base, 'root');
  const executionId = randomUUID();
  await mkdir(root);
  await mkdir(join(root, 'node_modules', 'fixture-dependency'), { recursive: true });
  await Promise.all([
    writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8'),
    writeFile(join(root, 'package.json'), '{"name":"managed-v2-fixture","private":true}\n', 'utf8'),
    writeFile(
      join(root, 'package-lock.json'),
      '{"name":"managed-v2-fixture","lockfileVersion":3,"packages":{}}\n',
      'utf8',
    ),
    writeFile(
      join(root, 'node_modules', 'fixture-dependency', 'package.json'),
      '{"name":"fixture-dependency","type":"module","exports":"./index.js"}\n',
      'utf8',
    ),
    writeFile(
      join(root, 'node_modules', 'fixture-dependency', 'index.js'),
      'export const answer = 42;\n',
      'utf8',
    ),
  ]);
  await writeFile(
    join(root, 'managed.test.mjs'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { answer } from 'fixture-dependency';",
      "test('accepted world with leased dependencies', () => assert.equal(answer, 42));",
      '',
    ].join('\n'),
    'utf8',
  );
  git(root, ['init', '--quiet', '--object-format=sha1']);
  git(root, ['add', '.gitignore', 'managed.test.mjs', 'package.json', 'package-lock.json']);
  git(root, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'managed v2 baseline',
  ]);

  const electronExecutable = resolveElectronExecutable();
  const resourcesRoot = await preparePackagedResources(base, helperPath, electronExecutable);
  const provider = await startManagedNodeTestProvider();
  t.after(() => provider.close());
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const connectionId = await configureProvider(capability, provider.baseUrl);
  const fixture = new ExecutionFixture(base, root, capability, executionId);
  try {
    const firstHost = await fixture.startHost(undefined, true, {
      packagedResourcesRoot: resourcesRoot,
      runtimeExecutablePath: electronExecutable,
      useProductionBackend: true,
    });
    const firstClient = await connectClient(root);
    assert.deepEqual(await firstClient.request('host.execution-profiles.query', {}), {
      profiles: process.platform === 'win32' ? [] : ['managed-coding-v2'],
    });
    const startRequest = firstClient.request('hosted.execution.start', {
      executionId,
      session: {
        workspace: { kind: 'host_path', path: root },
        modelTarget: {
          kind: 'explicit',
          connectionId,
          connectionSlug: 'managed-v2-provider',
          model: MODEL_ID,
        },
        permissionMode: 'bypass',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        toolProfile: 'managed-coding-v2',
      },
      content: { text: 'Run managed.test.mjs and report the result.' },
    });
    if (process.platform === 'win32') {
      try {
        const projection = await startRequest;
        assert.equal(projection.kind, 'indeterminate');
        assert.ok((projection.failureReason ?? '').length > 0);
        assert.equal(provider.requests.length, 0);
      } finally {
        await firstClient.close();
        await fixture.stopHost(firstHost);
      }
      return;
    }
    const start = startRequest.then(
      () => undefined,
      () => undefined,
    );
    const startFailure = startRequest.then(
      (projection) =>
        Promise.reject(
          new Error(
            `hosted execution settled before the Node test result: ${JSON.stringify(projection)}`,
          ),
        ),
      (error: unknown) =>
        Promise.reject(
          new Error(
            `hosted execution failed before the Node test result: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ),
        ),
    );
    const completedToolResult = await Promise.race([
      provider.waitForCompletedToolResult(),
      startFailure,
    ]).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; durable snapshot: ${readDurableExecutionSnapshot(root, executionId)}`,
        { cause: error },
      );
    });
    assert.deepEqual(readManagedNodeTestResult(completedToolResult), {
      protocolVersion: 1,
      kind: 'node_test_observation',
      passed: 1,
      failed: 0,
    });
    await fixture.killHost(firstHost);
    await withTimeout(start, PROCESS_TIMEOUT_MS, 'crashed hosted execution did not close');
    await firstClient.close().catch(() => undefined);

    const secondHost = await fixture.startHost(undefined, true, {
      packagedResourcesRoot: resourcesRoot,
      runtimeExecutablePath: electronExecutable,
      useProductionBackend: true,
    });
    const secondClient = await connectClient(root);
    try {
      await provider.waitForResumedCompletion();
      const admission = await waitForContinuationAdmission(fixture, executionId);
      const terminal = await waitForTerminalTurn(secondClient, executionId, admission.turnId);
      assert.equal(terminal.status, 'completed');
    } finally {
      await secondClient.close();
      await fixture.stopHost(secondHost);
    }

    assert.equal(provider.requests.length, 3);
    assert.match(JSON.stringify(provider.requests[1]), /ManagedNodeTest/u);
    assert.match(JSON.stringify(provider.requests[2]), /ManagedNodeTest/u);
    const readerOwner = await tryAcquireInteractiveRootReader(capability);
    assert.ok(readerOwner);
    if (!readerOwner) throw new Error('Unable to read managed v2 fixture root');
    const reader = await openInteractiveExecutionStoresForRead(readerOwner.lease);
    try {
      const runs = await reader.agentRunStore.listSessionRuns(executionId);
      const events = (
        await Promise.all(
          runs.map((run) =>
            reader.runtimeEventStore.readImmutableRuntimeEvents(executionId, run.runId),
          ),
        )
      ).flat();
      assert.equal(
        events.filter(
          (event) =>
            event.content?.kind === 'function_call' && event.content.name === 'ManagedNodeTest',
        ).length,
        1,
      );
      assert.equal(
        events.filter(
          (event) =>
            event.content?.kind === 'function_response' && event.content.name === 'ManagedNodeTest',
        ).length,
        1,
      );
    } finally {
      await reader.sessionStore.close?.();
      await readerOwner.close();
    }
  } finally {
    await fixture.close();
  }
});

test('packaged managed-coding-v2 resumes after Host death without replaying a completed Node command', {
  timeout: 90_000,
}, async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the packaged v3 crash gate');
    return;
  }
  const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-managed-v3-crash-')));
  const root = join(base, 'root');
  const executionId = randomUUID();
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(
    join(root, 'scripts', 'check.mjs'),
    [
      'console.log(JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH }));',
      'process.exitCode = 7;',
      '',
    ].join('\n'),
    'utf8',
  );
  git(root, ['init', '--quiet', '--object-format=sha1']);
  git(root, ['add', 'scripts/check.mjs']);
  git(root, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'managed v3 baseline',
  ]);

  const electronExecutable = resolveElectronExecutable();
  const resourcesRoot = await preparePackagedResources(base, helperPath, electronExecutable);
  const provider = await startManagedNodeRunProvider();
  t.after(() => provider.close());
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const connectionId = await configureProvider(capability, provider.baseUrl);
  const fixture = new ExecutionFixture(base, root, capability, executionId);
  try {
    const firstHost = await fixture.startHost(undefined, true, {
      packagedResourcesRoot: resourcesRoot,
      runtimeExecutablePath: electronExecutable,
      useProductionBackend: true,
    });
    const firstClient = await connectClient(root);
    assert.deepEqual(await firstClient.request('host.execution-profiles.query', {}), {
      profiles: process.platform === 'win32' ? [] : ['managed-coding-v2'],
    });
    const startRequest = firstClient.request('hosted.execution.start', {
      executionId,
      session: {
        workspace: { kind: 'host_path', path: root },
        modelTarget: {
          kind: 'explicit',
          connectionId,
          connectionSlug: 'managed-v3-provider',
          model: MODEL_ID,
        },
        permissionMode: 'bypass',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        toolProfile: 'managed-coding-v2',
      },
      content: { text: 'Run scripts/check.mjs with the exact requested arguments.' },
    });
    if (process.platform === 'win32') {
      try {
        const projection = await startRequest;
        assert.equal(projection.kind, 'indeterminate');
        assert.ok((projection.failureReason ?? '').length > 0);
        assert.equal(provider.requests.length, 0);
      } finally {
        await firstClient.close();
        await fixture.stopHost(firstHost);
      }
      return;
    }
    const start = startRequest.then(
      () => undefined,
      () => undefined,
    );
    const startFailure = startRequest.then(
      (projection) =>
        Promise.reject(
          new Error(
            `hosted execution settled before the Node command result: ${JSON.stringify(projection)}`,
          ),
        ),
      (error: unknown) =>
        Promise.reject(
          new Error(
            `hosted execution failed before the Node command result: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ),
        ),
    );
    const completedToolResult = await Promise.race([
      provider.waitForCompletedToolResult(),
      startFailure,
    ]);
    assert.deepEqual(readManagedNodeRunResult(completedToolResult), {
      protocolVersion: 1,
      kind: 'node_command_observation',
      exitCode: 7,
      stdout: '{"argv":["--check","src/index.js"],"path":""}\n',
      stderr: '',
    });
    await fixture.killHost(firstHost);
    await withTimeout(start, PROCESS_TIMEOUT_MS, 'crashed hosted execution did not close');
    await firstClient.close().catch(() => undefined);

    const secondHost = await fixture.startHost(undefined, true, {
      packagedResourcesRoot: resourcesRoot,
      runtimeExecutablePath: electronExecutable,
      useProductionBackend: true,
    });
    const secondClient = await connectClient(root);
    try {
      await provider.waitForResumedCompletion();
      const admission = await waitForContinuationAdmission(fixture, executionId);
      const terminal = await waitForTerminalTurn(secondClient, executionId, admission.turnId);
      assert.equal(terminal.status, 'completed');
    } finally {
      await secondClient.close();
      await fixture.stopHost(secondHost);
    }

    assert.equal(provider.requests.length, 3);
    assert.match(JSON.stringify(provider.requests[1]), /ManagedNodeRun/u);
    assert.match(JSON.stringify(provider.requests[2]), /ManagedNodeRun/u);
    const readerOwner = await tryAcquireInteractiveRootReader(capability);
    assert.ok(readerOwner);
    if (!readerOwner) throw new Error('Unable to read managed v3 fixture root');
    const reader = await openInteractiveExecutionStoresForRead(readerOwner.lease);
    try {
      const runs = await reader.agentRunStore.listSessionRuns(executionId);
      const events = (
        await Promise.all(
          runs.map((run) =>
            reader.runtimeEventStore.readImmutableRuntimeEvents(executionId, run.runId),
          ),
        )
      ).flat();
      assert.equal(
        events.filter(
          (event) =>
            event.content?.kind === 'function_call' && event.content.name === 'ManagedNodeRun',
        ).length,
        1,
      );
      assert.equal(
        events.filter(
          (event) =>
            event.content?.kind === 'function_response' && event.content.name === 'ManagedNodeRun',
        ).length,
        1,
      );
    } finally {
      await reader.sessionStore.close?.();
      await readerOwner.close();
    }
  } finally {
    await fixture.close();
  }
});

test('packaged managed-coding-v2 resumes after Host death without replaying an accepted workspace transform', {
  timeout: 90_000,
}, async (t) => {
  const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!helperPath) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the packaged v2 crash gate');
    return;
  }
  const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-managed-v2-crash-')));
  const root = join(base, 'root');
  const executionId = randomUUID();
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(
    join(root, 'scripts', 'generate.mjs'),
    [
      "import { writeFile } from 'node:fs/promises';",
      'await writeFile(process.env.MAKA_OUTPUT_PATH, `generated:${process.argv[2]}\\n`);',
      "console.log('generated one accepted file');",
      '',
    ].join('\n'),
    'utf8',
  );
  git(root, ['init', '--quiet', '--object-format=sha1']);
  git(root, ['add', 'scripts/generate.mjs']);
  git(root, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'managed v2 baseline',
  ]);

  const electronExecutable = resolveElectronExecutable();
  const resourcesRoot = await preparePackagedResources(base, helperPath, electronExecutable);
  const provider = await startManagedNodeTransformProvider();
  t.after(() => provider.close());
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const connectionId = await configureProvider(capability, provider.baseUrl);
  const fixture = new ExecutionFixture(base, root, capability, executionId);
  try {
    const firstHost = await fixture.startHost(undefined, true, {
      packagedResourcesRoot: resourcesRoot,
      runtimeExecutablePath: electronExecutable,
      useProductionBackend: true,
    });
    const firstClient = await connectClient(root);
    assert.deepEqual(await firstClient.request('host.execution-profiles.query', {}), {
      profiles: process.platform === 'win32' ? [] : ['managed-coding-v2'],
    });
    const startRequest = firstClient.request('hosted.execution.start', {
      executionId,
      session: {
        workspace: { kind: 'host_path', path: root },
        modelTarget: {
          kind: 'explicit',
          connectionId,
          connectionSlug: 'managed-v2-provider',
          model: MODEL_ID,
        },
        permissionMode: 'bypass',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        toolProfile: 'managed-coding-v2',
      },
      content: { text: 'Generate one accepted workspace output.' },
    });
    if (process.platform === 'win32') {
      try {
        const projection = await startRequest;
        assert.equal(projection.kind, 'indeterminate');
        assert.ok((projection.failureReason ?? '').length > 0);
        assert.equal(provider.requests.length, 0);
      } finally {
        await firstClient.close();
        await fixture.stopHost(firstHost);
      }
      return;
    }
    const start = startRequest.then(
      () => undefined,
      () => undefined,
    );
    const startFailure = startRequest.then(
      (projection) =>
        Promise.reject(
          new Error(
            `hosted execution settled before the workspace transform result: ${JSON.stringify(projection)}`,
          ),
        ),
      (error: unknown) =>
        Promise.reject(
          new Error(
            `hosted execution failed before the workspace transform result: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ),
        ),
    );
    const completedToolResult = await Promise.race([
      provider.waitForCompletedToolResult(),
      startFailure,
    ]);
    assert.deepEqual(readManagedNodeTransformResult(completedToolResult), {
      protocolVersion: 1,
      kind: 'workspace_transform',
      path: 'generated/output.txt',
      bytes: Buffer.byteLength('generated:stable\n'),
    });
    await fixture.killHost(firstHost);
    await withTimeout(start, PROCESS_TIMEOUT_MS, 'crashed hosted execution did not close');
    await firstClient.close().catch(() => undefined);

    const secondHost = await fixture.startHost(undefined, true, {
      packagedResourcesRoot: resourcesRoot,
      runtimeExecutablePath: electronExecutable,
      useProductionBackend: true,
    });
    const secondClient = await connectClient(root);
    try {
      await provider.waitForResumedCompletion();
      const admission = await waitForContinuationAdmission(fixture, executionId);
      const terminal = await waitForTerminalTurn(secondClient, executionId, admission.turnId);
      assert.equal(terminal.status, 'completed');
    } finally {
      await secondClient.close();
      await fixture.stopHost(secondHost);
    }

    assert.equal(provider.requests.length, 3);
    assert.match(JSON.stringify(provider.requests[1]), /ManagedNodeTransform/u);
    assert.match(JSON.stringify(provider.requests[2]), /ManagedNodeTransform/u);
    const readerOwner = await tryAcquireInteractiveRootReader(capability);
    assert.ok(readerOwner);
    if (!readerOwner) throw new Error('Unable to read managed v2 fixture root');
    const reader = await openInteractiveExecutionStoresForRead(readerOwner.lease);
    try {
      const runs = await reader.agentRunStore.listSessionRuns(executionId);
      const events = (
        await Promise.all(
          runs.map((run) =>
            reader.runtimeEventStore.readImmutableRuntimeEvents(executionId, run.runId),
          ),
        )
      ).flat();
      assert.equal(
        events.filter(
          (event) =>
            event.content?.kind === 'function_call' &&
            event.content.name === 'ManagedNodeTransform',
        ).length,
        1,
      );
      assert.equal(
        events.filter(
          (event) =>
            event.content?.kind === 'function_response' &&
            event.content.name === 'ManagedNodeTransform',
        ).length,
        1,
      );
      const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        const successorCount = database
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_workspace_versions WHERE origin_kind = 'successor'",
          )
          .get() as { count: number };
        const reservationCount = database
          .prepare('SELECT COUNT(*) AS count FROM runtime_managed_mutation_reservations')
          .get() as { count: number };
        assert.equal(successorCount.count, 1);
        assert.equal(reservationCount.count, 0);
      } finally {
        database.close();
      }
    } finally {
      await reader.sessionStore.close?.();
      await readerOwner.close();
    }
  } finally {
    await fixture.close();
  }
});

function readDurableExecutionSnapshot(root: string, sessionId: string): string {
  const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
  try {
    return JSON.stringify({
      runtimeEvents: database
        .prepare(
          `SELECT event_kind AS eventKind, payload_json AS payloadJson
           FROM runtime_events
           WHERE session_id = ?
           ORDER BY committed_at, event_seq`,
        )
        .all(sessionId),
      toolJournal: database
        .prepare(
          `SELECT state, runtime_event_id AS runtimeEventId, metadata_json AS metadataJson
           FROM tool_journal_events
           WHERE invocation_id IN (
             SELECT DISTINCT invocation_id FROM runtime_events WHERE session_id = ?
           )
           ORDER BY journal_seq`,
        )
        .all(sessionId),
    });
  } finally {
    database.close();
  }
}

async function configureProvider(
  capability: Awaited<ReturnType<typeof resolveStorageRoot>>,
  baseUrl: string,
): Promise<string> {
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to own managed v2 fixture root');
  try {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'managed-v2-provider',
        name: 'Managed v2 provider',
        providerType: 'moonshot',
        baseUrl,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') throw new Error('Provider connection was not committed');
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) throw new Error('Provider connection is missing');
    assert.equal(
      (
        await policy.credentialVault.set({
          locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
          expected: null,
          secret: API_KEY,
        })
      ).kind,
      'committed',
    );
    const prepared = await policy.operations.beginModelFetch(connection.connectionId);
    assert.equal(prepared.kind, 'ready');
    if (prepared.kind !== 'ready') throw new Error('Provider model fetch was not admitted');
    assert.equal(
      (
        await policy.operations.completeModelFetch(prepared.ticket, {
          models: [
            {
              id: MODEL_ID,
              capabilities: { chat: true, functionCalling: true },
              contextWindow: 8_192,
              maxOutputTokens: 256,
            },
          ],
          source: 'fetched',
          fetchedAt: Date.now(),
        })
      ).kind,
      'committed',
    );
    return connection.connectionId;
  } finally {
    await owner.close();
  }
}

async function startManagedNodeTestProvider(): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly unknown[];
  waitForCompletedToolResult(): Promise<unknown>;
  waitForResumedCompletion(): Promise<void>;
  close(): Promise<void>;
}> {
  const requests: unknown[] = [];
  let completedToolResult!: (request: unknown) => void;
  let resumedCompletion!: () => void;
  const completedToolResultReached = new Promise<unknown>((resolve) => {
    completedToolResult = resolve;
  });
  const resumedCompletionReached = new Promise<void>((resolve) => {
    resumedCompletion = resolve;
  });
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      if (body.stream !== true) {
        respondSummary(response);
        return;
      }
      requests.push(body);
      if (requests.length === 1) {
        respondToolCall(response, 'ManagedNodeTest', {
          relativePaths: ['managed.test.mjs'],
        });
        return;
      }
      if (requests.length === 2) {
        completedToolResult(body);
        return;
      }
      respondText(response, 'Managed Node test passed after recovery.');
      resumedCompletion();
    })().catch((error) => response.destroy(error as Error));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    waitForCompletedToolResult: () =>
      withTimeout(
        completedToolResultReached,
        PROCESS_TIMEOUT_MS * 5,
        'provider did not observe the completed Node test result',
      ),
    waitForResumedCompletion: () =>
      withTimeout(
        resumedCompletionReached,
        PROCESS_TIMEOUT_MS * 3,
        'resumed Host did not complete the provider turn',
      ),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

async function startManagedNodeRunProvider(): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly unknown[];
  waitForCompletedToolResult(): Promise<unknown>;
  waitForResumedCompletion(): Promise<void>;
  close(): Promise<void>;
}> {
  const requests: unknown[] = [];
  let completedToolResult!: (request: unknown) => void;
  let resumedCompletion!: () => void;
  const completedToolResultReached = new Promise<unknown>((resolve) => {
    completedToolResult = resolve;
  });
  const resumedCompletionReached = new Promise<void>((resolve) => {
    resumedCompletion = resolve;
  });
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      if (body.stream !== true) {
        respondSummary(response);
        return;
      }
      requests.push(body);
      if (requests.length === 1) {
        respondToolCall(response, 'ManagedNodeRun', {
          entryPath: 'scripts/check.mjs',
          args: ['--check', 'src/index.js'],
        });
        return;
      }
      if (requests.length === 2) {
        completedToolResult(body);
        return;
      }
      respondText(response, 'Managed Node command completed after recovery.');
      resumedCompletion();
    })().catch((error) => response.destroy(error as Error));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    waitForCompletedToolResult: () =>
      withTimeout(
        completedToolResultReached,
        PROCESS_TIMEOUT_MS * 5,
        'provider did not observe the completed Node command result',
      ),
    waitForResumedCompletion: () =>
      withTimeout(
        resumedCompletionReached,
        PROCESS_TIMEOUT_MS * 3,
        'resumed Host did not complete the provider turn',
      ),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

async function startManagedNodeTransformProvider(): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly unknown[];
  waitForCompletedToolResult(): Promise<unknown>;
  waitForResumedCompletion(): Promise<void>;
  close(): Promise<void>;
}> {
  const requests: unknown[] = [];
  let completedToolResult!: (request: unknown) => void;
  let resumedCompletion!: () => void;
  const completedToolResultReached = new Promise<unknown>((resolve) => {
    completedToolResult = resolve;
  });
  const resumedCompletionReached = new Promise<void>((resolve) => {
    resumedCompletion = resolve;
  });
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      if (body.stream !== true) {
        respondSummary(response);
        return;
      }
      requests.push(body);
      if (requests.length === 1) {
        respondToolCall(response, 'ManagedNodeTransform', {
          entryPath: 'scripts/generate.mjs',
          path: 'generated/output.txt',
          args: ['stable'],
        });
        return;
      }
      if (requests.length === 2) {
        completedToolResult(body);
        return;
      }
      respondText(response, 'Managed workspace transform completed after recovery.');
      resumedCompletion();
    })().catch((error) => response.destroy(error as Error));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    waitForCompletedToolResult: () =>
      withTimeout(
        completedToolResultReached,
        PROCESS_TIMEOUT_MS * 5,
        'provider did not observe the completed workspace transform result',
      ),
    waitForResumedCompletion: () =>
      withTimeout(
        resumedCompletionReached,
        PROCESS_TIMEOUT_MS * 3,
        'resumed Host did not complete the workspace transform turn',
      ),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

function readManagedNodeTestResult(request: unknown): Readonly<Record<string, unknown>> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Provider request is invalid');
  }
  const messages = (request as { readonly messages?: unknown }).messages;
  if (!Array.isArray(messages)) throw new Error('Provider request has no messages');
  const toolMessage = messages.find(
    (message): message is { readonly role: 'tool'; readonly content: string } =>
      !!message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as { readonly role?: unknown }).role === 'tool' &&
      typeof (message as { readonly content?: unknown }).content === 'string',
  );
  if (!toolMessage) throw new Error('Provider request has no tool result');
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(toolMessage.content) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Managed Node test returned a non-JSON result: ${toolMessage.content}`, {
      cause: error,
    });
  }
  return Object.freeze({
    protocolVersion: value.protocolVersion,
    kind: value.kind,
    passed: value.passed,
    failed: value.failed,
  });
}

function readManagedNodeRunResult(request: unknown): Readonly<Record<string, unknown>> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Provider request is invalid');
  }
  const messages = (request as { readonly messages?: unknown }).messages;
  if (!Array.isArray(messages)) throw new Error('Provider request has no messages');
  const toolMessage = messages.find(
    (message): message is { readonly role: 'tool'; readonly content: string } =>
      !!message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as { readonly role?: unknown }).role === 'tool' &&
      typeof (message as { readonly content?: unknown }).content === 'string',
  );
  if (!toolMessage) throw new Error('Provider request has no tool result');
  const value = JSON.parse(toolMessage.content) as Record<string, unknown>;
  return Object.freeze({
    protocolVersion: value.protocolVersion,
    kind: value.kind,
    exitCode: value.exitCode,
    stdout: value.stdout,
    stderr: value.stderr,
  });
}

function readManagedNodeTransformResult(request: unknown): Readonly<Record<string, unknown>> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Provider request is invalid');
  }
  const messages = (request as { readonly messages?: unknown }).messages;
  if (!Array.isArray(messages)) throw new Error('Provider request has no messages');
  const toolMessage = messages.find(
    (message): message is { readonly role: 'tool'; readonly content: string } =>
      !!message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as { readonly role?: unknown }).role === 'tool' &&
      typeof (message as { readonly content?: unknown }).content === 'string',
  );
  if (!toolMessage) throw new Error('Provider request has no tool result');
  const value = JSON.parse(toolMessage.content) as Record<string, unknown>;
  return Object.freeze({
    protocolVersion: value.protocolVersion,
    kind: value.kind,
    path: value.path,
    bytes: value.bytes,
  });
}

async function preparePackagedResources(
  base: string,
  helperInputPath: string,
  electronExecutable: string,
): Promise<string> {
  const resourcesRoot = join(base, 'resources');
  const gitoxideRoot = join(resourcesRoot, 'gitoxide');
  const executableName =
    process.platform === 'win32' ? 'maka-gitoxide-helper.exe' : 'maka-gitoxide-helper';
  const helperPath = join(gitoxideRoot, executableName);
  await mkdir(gitoxideRoot, { recursive: true });
  await copyFile(await realpath(helperInputPath), helperPath);
  if (process.platform !== 'win32') await chmod(helperPath, 0o755);
  const [helperBytes, helperInfo] = await Promise.all([readFile(helperPath), stat(helperPath)]);
  await writeFile(
    join(resourcesRoot, 'gitoxide-helper.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      protocol: 'maka_gitoxide_helper_release_v1',
      provider: 'maka/gitoxide-helper',
      platform: process.platform,
      arch: process.arch,
      protocolVersion: 1,
      executableRelativePath: `gitoxide/${executableName}`,
      bytes: helperInfo.size,
      sha256: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`,
      supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
      distributionReady: true,
    })}\n`,
    'utf8',
  );

  const commandRoot = join(resourcesRoot, 'managed-command');
  const entrypointPath = join(commandRoot, 'managed-command-helper-main.js');
  await mkdir(commandRoot);
  await copyFile(
    resolve(import.meta.dirname, '..', 'server', 'managed-command-helper-main.js'),
    entrypointPath,
  );
  const entrypoint = await readFile(entrypointPath);
  const nodeVersion = execFileSync(electronExecutable, ['-p', 'process.versions.node'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  await writeFile(
    join(resourcesRoot, 'managed-command-toolchain.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      protocol: 'maka_managed_command_toolchain_release_v2',
      provider: 'maka/managed-command-toolchain',
      platform: process.platform,
      arch: process.arch,
      nodeVersion,
      profileVersion: 1,
      entrypointRelativePath: 'managed-command/managed-command-helper-main.js',
      entrypointBytes: (await stat(entrypointPath)).size,
      entrypointSha256: `sha256:${createHash('sha256').update(entrypoint).digest('hex')}`,
      allowedEffectClasses: ['hermetic_observation_v2', 'workspace_transform_v1'],
      distributionReady: true,
    })}\n`,
    'utf8',
  );
  if (process.platform === 'win32') {
    const sandboxInputPath = process.env.MAKA_WINDOWS_SANDBOX_PATH;
    assert.ok(
      sandboxInputPath,
      'MAKA_WINDOWS_SANDBOX_PATH is required for the Windows packaged v2 crash gate',
    );
    const sandboxRoot = join(resourcesRoot, 'windows-sandbox');
    await mkdir(sandboxRoot);
    await copyFile(await realpath(sandboxInputPath), join(sandboxRoot, 'maka-windows-sandbox.exe'));
  }
  return resourcesRoot;
}

function resolveElectronExecutable(): string {
  const distributionRoot = resolve(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return join(distributionRoot, 'electron.exe');
  if (process.platform === 'darwin') {
    return join(distributionRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  return join(distributionRoot, 'electron');
}

async function waitForContinuationAdmission(
  fixture: ExecutionFixture,
  sessionId: string,
): Promise<{ readonly turnId: string }> {
  return await withTimeout(
    (async () => {
      for (;;) {
        const admissions = (await fixture.readAdmissionChain()).filter(
          (entry) =>
            entry.sessionId === sessionId && entry.execution.kind === 'safe_boundary_continuation',
        );
        if (admissions.length === 1) return admissions[0]!;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })(),
    PROCESS_TIMEOUT_MS * 3,
    'automatic managed v2 continuation was not admitted',
  );
}

async function waitForTerminalTurn(
  client: Awaited<ReturnType<typeof connectClient>>,
  sessionId: string,
  turnId: string,
) {
  return await withTimeout(
    (async () => {
      for (;;) {
        const turn = await client.request('turn.query', { sessionId, turnId });
        if (['completed', 'failed', 'cancelled'].includes(turn.status)) return turn;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })(),
    PROCESS_TIMEOUT_MS * 3,
    'resumed managed v2 turn did not settle',
  );
}

function respondToolCall(
  response: ServerResponse,
  name: string,
  args: Record<string, unknown>,
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-managed-v2-tool',
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'managed-v2-tool-call',
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-managed-v2-tool',
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

function respondText(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-managed-v2-text',
      object: 'chat.completion.chunk',
      created: 2,
      model: MODEL_ID,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-managed-v2-text',
      object: 'chat.completion.chunk',
      created: 2,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

function respondSummary(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'chatcmpl-managed-v2-summary',
      object: 'chat.completion',
      created: 2,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'summary' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolveBody(body));
    request.on('error', reject);
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
