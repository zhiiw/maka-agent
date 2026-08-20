import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { isBuiltinFilesystemWorkerSandboxAvailable } from '@maka/runtime/sandbox';
import { createSqliteRuntimeStore } from '@maka/storage';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';

const execFileAsync = promisify(execFile);
const MODEL_ID = 'managed-write-crash-model';
const CONNECTION_SLUG = 'managed-write-crash-provider';
const API_KEY = 'managed-write-crash-key';

test('production Host real process crash reopens a managed Write without rerunning it', {
  timeout: 120_000,
  skip: isBuiltinFilesystemWorkerSandboxAvailable()
    ? false
    : 'The current test process has no packaged filesystem sandbox worker',
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-managed-write-host-crash-'));
  const root = join(base, 'interactive');
  const source = join(base, 'source');
  const provider = await startManagedWriteProvider();
  let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
  let restartedOwner: Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>> | undefined;
  try {
    await createSourceRepository(source);
    const canonicalSource = await realpath(source);
    const gitExecutablePath = await findGitExecutable();
    const expectedSha256 = await sha256File(gitExecutablePath);
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const setupOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(setupOwner);
    if (!setupOwner) return;
    let sessionId: string;
    try {
      const policy = await openInteractiveRuntimePolicyStoresForWrite(setupOwner.lease);
      const created = await policy.connectionCatalog.create({
        expectedCatalogRevision: 0,
        connection: {
          slug: CONNECTION_SLUG,
          name: 'Managed Write crash provider',
          providerType: 'moonshot',
          baseUrl: provider.baseUrl,
          enabled: true,
          enabledModelIds: [MODEL_ID],
        },
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const connection = created.snapshot.connections[0];
      assert.ok(connection);
      if (!connection) return;
      assert.equal(
        (
          await policy.credentialVault.set({
            locator: {
              scope: 'connection',
              connectionId: connection.connectionId,
              kind: 'api_key',
            },
            expected: null,
            secret: API_KEY,
          })
        ).kind,
        'committed',
      );
      await publishModel(policy, connection.connectionId);
      const execution = await openInteractiveExecutionStoresForWrite(setupOwner.lease);
      const session = await execution.sessionStore.create({
        cwd: canonicalSource,
        backend: 'ai-sdk',
        llmConnectionSlug: CONNECTION_SLUG,
        model: MODEL_ID,
        permissionMode: 'bypass',
        toolProfile: 'managed-coding-v1',
      });
      sessionId = session.id;
      await execution.sessionStore.close?.();
    } finally {
      await setupOwner.close();
    }

    const turnId = 'managed-write-crash-turn';
    const child = fork(
      new URL('./fixtures/managed-workspace-write-edit-host-crash.js', import.meta.url),
      [root, capability.rootId, gitExecutablePath, expectedSha256, sessionId, turnId],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    await waitForChildMessage(child, 'ready');
    const crash = await waitForExit(child);
    assert.deepEqual(crash, { code: 73, signal: null });

    const afterCrashOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(afterCrashOwner);
    if (!afterCrashOwner) return;
    let acceptedCommitOid: string;
    try {
      const execution = await openInteractiveExecutionStoresForWrite(afterCrashOwner.lease);
      const identity = managedMutationIdentity(canonicalSource, sessionId);
      const head = await readWorkspaceHead(root, identity);
      assert.equal(head?.revision, 2);
      assert.ok(head?.commitOid);
      if (!head) return;
      acceptedCommitOid = head.commitOid;
      assert.equal(await countToolOutcomes(execution, sessionId, 'Write', false), 1);
      await execution.sessionStore.close?.();
    } finally {
      await afterCrashOwner.close();
    }

    restartedOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(restartedOwner);
    if (!restartedOwner) return;
    const context: ConnectionContext = {
      hostEpoch: 'managed-write-restart-host',
      connectionId: 'managed-write-restart-client',
      surface: 'tui',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    composition = await createExecutionRuntimeHostComposition(
      {
        owner: restartedOwner,
        hostEpoch: context.hostEpoch,
        acquireResidency: context.acquireResidency,
        retainUntilProcessExit: () => undefined,
        requestDrain: () => undefined,
      },
      {
        managedWorkspaceGitRuntime: { executablePath: gitExecutablePath, expectedSha256 },
      },
    );
    await composition.recover();
    const probeTurn = 'managed-write-reopen-probe';
    const started = await composition.handlers['turn.start'](
      {
        sessionId,
        turnId: probeTurn,
        content: { text: 'Confirm the managed workspace is available.' },
      },
      context,
    );
    assert.equal(started.ok, true);
    if (!started.ok || started.result.kind !== 'started') return;
    await waitForTerminal(composition, sessionId, probeTurn, context);

    const execution = await openInteractiveExecutionStoresForWrite(restartedOwner.lease);
    assert.equal(await countToolOutcomes(execution, sessionId, 'Write', false), 1);
    assert.equal(await countToolOutcomes(execution, sessionId, 'Edit', true), 1);
    const identity = managedMutationIdentity(canonicalSource, sessionId);
    const head = await readWorkspaceHead(root, identity);
    assert.equal(head?.commitOid, acceptedCommitOid);
    await execution.sessionStore.close?.();

    const binding = await readOnlyBinding(root);
    assert.equal(await readFile(join(binding.worktreePath, 'result.txt'), 'utf8'), 'managed\n');
    assert.equal(provider.streamRequests, 3);
    assert.equal(provider.writeToolCalls, 1);
    assert.equal(provider.editToolCalls, 1);
  } finally {
    await composition?.close();
    await restartedOwner?.close();
    await provider.close();
    await rm(base, { recursive: true, force: true });
  }
});

async function countToolOutcomes(
  stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>,
  sessionId: string,
  toolName: 'Write' | 'Edit',
  isError: boolean,
): Promise<number> {
  const runs = await stores.agentRunStore.listSessionRuns(sessionId);
  const ledgers = await Promise.all(
    runs.map((run) => stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, run.runId)),
  );
  return ledgers
    .flat()
    .filter(
      (event) =>
        event.content?.kind === 'function_response' &&
        event.content.name === toolName &&
        (event.content.isError === true) === isError,
    ).length;
}

async function waitForTerminal(
  composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>,
  sessionId: string,
  turnId: string,
  context: ConnectionContext,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const queried = await composition.handlers['turn.query']({ sessionId, turnId }, context);
    assert.equal(queried.ok, true);
    if (queried.ok && ['completed', 'failed', 'cancelled'].includes(queried.result.status)) {
      assert.equal(queried.result.status, 'completed');
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Managed workspace reopen probe did not settle');
}

async function startManagedWriteProvider(): Promise<{
  readonly baseUrl: string;
  readonly streamRequests: number;
  readonly writeToolCalls: number;
  readonly editToolCalls: number;
  close(): Promise<void>;
}> {
  let streamRequests = 0;
  let writeToolCalls = 0;
  let editToolCalls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const body = JSON.parse(await readBody(request)) as { stream?: unknown };
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'managed-write-nonstream',
            object: 'chat.completion',
            created: 1,
            model: MODEL_ID,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'managed' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      streamRequests += 1;
      if (streamRequests === 1) {
        writeToolCalls += 1;
        respondToolCall(response, 'Write', { path: 'result.txt', content: 'managed\n' });
      } else if (streamRequests === 2) {
        editToolCalls += 1;
        respondToolCall(response, 'Edit', {
          path: 'result.txt',
          old_string: 'not-present',
          new_string: 'must-not-appear',
        });
      } else {
        respondText(response, 'Managed workspace reopened without replaying Write.');
      }
    })().catch((error) => response.destroy(error as Error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get streamRequests() {
      return streamRequests;
    },
    get writeToolCalls() {
      return writeToolCalls;
    },
    get editToolCalls() {
      return editToolCalls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function respondToolCall(
  response: ServerResponse,
  toolName: string,
  args: Record<string, unknown>,
): void {
  respondChunks(response, [
    {
      id: 'managed-write-tool-call',
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
                id: 'managed-write-call-1',
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'managed-write-tool-call',
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
}

function respondText(response: ServerResponse, text: string): void {
  respondChunks(response, [
    {
      id: 'managed-write-text',
      object: 'chat.completion.chunk',
      created: 2,
      model: MODEL_ID,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      id: 'managed-write-text',
      object: 'chat.completion.chunk',
      created: 2,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
}

function respondChunks(response: ServerResponse, chunks: readonly unknown[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function publishModel(
  policy: Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>,
  connectionId: string,
): Promise<void> {
  const prepared = await policy.operations.beginModelFetch(connectionId);
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind !== 'ready') return;
  const committed = await policy.operations.completeModelFetch(prepared.ticket, {
    models: [
      {
        id: MODEL_ID,
        capabilities: { chat: true, functionCalling: true },
        contextWindow: 32_768,
        maxOutputTokens: 64,
      },
    ],
    source: 'fetched',
    fetchedAt: Date.now(),
  });
  assert.equal(committed.kind, 'committed');
}

async function createSourceRepository(source: string): Promise<void> {
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'tracked.txt'), 'baseline\n', 'utf8');
  await writeFile(join(source, '.gitignore'), '.maka-workspace.json\n', 'utf8');
  await git(source, 'init', '--quiet');
  await git(source, 'add', 'tracked.txt', '.gitignore');
  await git(
    source,
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@maka.invalid',
    'commit',
    '--quiet',
    '-m',
    'baseline',
  );
}

async function findGitExecutable(): Promise<string> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const { stdout } = await execFileAsync(command, ['git'], { encoding: 'utf8' });
  const first = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) throw new Error('Git executable is unavailable');
  return realpath(first);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const executable = await findGitExecutable();
  const { stdout } = await execFileAsync(executable, ['-C', cwd, ...args], {
    encoding: 'utf8',
  });
  return stdout.trim();
}

function managedMutationIdentity(sourceRoot: string, sessionId: string) {
  return {
    workspaceId: `workspace_${domainDigest('session', sourceRoot, sessionId)}`,
    workspaceEpochId: `epoch_${domainDigest('epoch', sourceRoot, sessionId)}`,
  };
}

async function readWorkspaceHead(
  root: string,
  identity: ReturnType<typeof managedMutationIdentity>,
) {
  const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'), { readOnly: true });
  try {
    return await store.readWorkspaceHead(identity.workspaceId, identity.workspaceEpochId);
  } finally {
    store.close();
  }
}

function domainDigest(domain: string, ...values: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(`maka-managed-mutation-${domain}-v1\0`, 'utf8');
  for (const value of values) {
    hash.update(value, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex').slice(0, 32);
}

async function readOnlyBinding(root: string): Promise<{ worktreePath: string }> {
  const files = await findNamedFiles(join(root, 'managed-workspaces'), 'binding.json');
  assert.equal(files.length, 1);
  const value = JSON.parse(await readFile(files[0]!, 'utf8')) as { worktreePath?: unknown };
  assert.equal(typeof value.worktreePath, 'string');
  return { worktreePath: value.worktreePath as string };
}

async function findNamedFiles(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await findNamedFiles(path, name)));
    else if (entry.isFile() && entry.name === name) found.push(path);
  }
  return found;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function waitForChildMessage(child: ReturnType<typeof fork>, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Child did not publish ${type}`)), 30_000);
    child.on('message', (message: unknown) => {
      if ((message as { type?: unknown })?.type !== type) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Child exited before ${type}: ${String(code ?? signal)}`));
    });
  });
}

function waitForExit(child: ReturnType<typeof fork>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Managed mutation crash child did not exit'));
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
