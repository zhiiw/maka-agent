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
// Electron boundary: actual preload → main → elected dev Host → SQLite/Gitoxide.
// Unlike standard E2E this does not install a fake Runtime/backend.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron, expect } from '@playwright/test';
import {
  resolveStorageRoot,
  resolveExistingStorageRootControlDirectory,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { createProjectCatalog } from '@maka/storage/project-catalog';
import { createSettingsStore } from '@maka/storage/settings-store';
import { buildFixtureEnv } from './fixture-env.mjs';
import { closeElectronApplication } from './electron-lifecycle.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
assert.ok(helperPath, 'Set MAKA_GITOXIDE_HELPER_PATH to the built native helper');
const executablePath = await realpath(helperPath);
const bytes = await readFile(executablePath);
const root = await mkdtemp(join(tmpdir(), 'maka-managed-electron-'));
const userData = join(root, 'user-data');
const workspace = join(userData, 'workspaces', 'default');
const source = join(root, 'source');
const home = join(root, 'home');
await Promise.all([mkdir(source), mkdir(home), mkdir(userData)]);
console.log(`Evidence directory: ${root}`);
const git = (...args) =>
  promisify(execFile)('git', ['-C', source, ...args], { timeout: 10000, windowsHide: true });
await git('init', '--object-format=sha1');
await writeFile(join(source, 'tracked.txt'), 'baseline\n');
await git('add', 'tracked.txt');
await git(
  '-c',
  'user.name=Smoke',
  '-c',
  'user.email=smoke@example.invalid',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-m',
  'baseline',
);
const requests = [];
const interruptTurn = process.argv.includes('--interrupt-turn');
let waitingForCompletion = false;
let operationStep = 0;
const operations = [
  { name: 'Write', input: { path: 'tracked.txt', content: 'written\n' } },
  { name: 'Edit', input: { path: 'tracked.txt', old_string: 'written', new_string: 'edited' } },
  { name: 'Read', input: { path: 'tracked.txt' } },
];
let restarted = false;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2 * 1024 * 1024) {
      res.writeHead(413).end();
      return;
    }
  }
  const body = JSON.parse(raw || '{}');
  requests.push({ path: req.url, body });
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'smoke-title',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'Managed files smoke task' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    return;
  }
  if (interruptTurn && !restarted && operationStep === operations.length) {
    // A real model request containing all tool results is our observable barrier.
    // Leave the response open: the turn cannot finish before the Host is killed.
    waitingForCompletion = true;
    return;
  }
  const operation = restarted
    ? operationStep++ === 0
      ? { name: 'Read', input: { path: 'tracked.txt' } }
      : undefined
    : operations[operationStep++];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: {
      id: `smoke-${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  if (operation) {
    event('content_block_start', {
      index: 0,
      content_block: {
        type: 'tool_use',
        id: `smoke-tool-${operationStep}`,
        name: operation.name,
        input: {},
      },
    });
    event('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(operation.input) },
    });
  } else {
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', {
      index: 0,
      delta: {
        type: 'text_delta',
        text: restarted ? 'MANAGED_DESKTOP_REOPEN_OK' : 'MANAGED_DESKTOP_SMOKE_OK',
      },
    });
  }
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: { stop_reason: operation ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  event('message_stop', {});
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
let page;
const logs = [];
try {
  const capability = await resolveStorageRoot({ path: workspace, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const catalog = await stores.connectionCatalog.getSnapshot();
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: catalog.revision,
      connection: {
        slug: 'smoke',
        name: 'Local smoke model',
        providerType: 'anthropic',
        enabled: true,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        enabledModelIds: ['claude-sonnet-4-5-20250929'],
      },
    });
    assert.equal(created.kind, 'committed');
    const connection = created.snapshot.connections.find((item) => item.slug === 'smoke');
    assert.ok(connection);
    assert.equal(
      (
        await stores.credentialVault.set({
          locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
          expected: null,
          secret: 'local-smoke-only',
        })
      ).kind,
      'committed',
    );
    const fetch = await stores.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetch.kind, 'ready');
    const models = await stores.operations.completeModelFetch(fetch.ticket, {
      models: [{ id: 'claude-sonnet-4-5-20250929' }],
      source: 'fallback',
      fetchedAt: 0,
    });
    assert.equal(models.kind, 'committed');
    assert.equal(
      (
        await stores.connectionCatalog.setDefaultTarget({
          expectedCatalogRevision: models.snapshot.revision,
          target: { connectionId: connection.connectionId, modelId: 'claude-sonnet-4-5-20250929' },
        })
      ).kind,
      'committed',
    );
  } finally {
    await owner.close();
  }
  const catalog = createProjectCatalog(workspace);
  const project = await catalog.register(source);
  await writeFile(
    join(workspace, 'project-preferences.json'),
    JSON.stringify({ version: 1, selections: { [capability.rootId]: project.id } }),
  );
  await createSettingsStore(workspace).update({ personalization: { uiLocale: 'en' } });
  const env = buildFixtureEnv(userData, home);
  // Exercise the shipped/default resume gate, not a developer's inherited opt-in.
  delete env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME;
  for (const key of Object.keys(env)) if (key.startsWith('MAKA_E2E')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  env.MAKA_MANAGED_SMOKE_ROOT = root;
  env.MAKA_MANAGED_FILES_DEV_HELPER = JSON.stringify({
    schemaVersion: 1,
    executablePath,
    expectedBytes: bytes.length,
    expectedSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    platform: process.platform,
    arch: process.arch,
  });
  app = await electron.launch({
    args: [join(repo, 'scripts/desktop-managed-smoke-entry.cjs')],
    cwd: join(repo, 'apps/desktop'),
    env,
    timeout: 30000,
  });
  app.process().stderr?.on('data', (chunk) => logs.push(chunk.toString()));
  await expect
    .poll(
      () => {
        page = app.windows().find((candidate) => {
          const url = candidate.url();
          return url.includes('/index.html') && !url.includes('surface=');
        });
        return Boolean(page);
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await expect(page.locator('.maka-composer-editor [contenteditable="true"]')).toBeVisible({
    timeout: 30000,
  });
  await page.locator('.maka-composer-plus-menu').click();
  await page.getByRole('menuitemcheckbox', { name: 'Managed files task' }).click();
  await page.keyboard.press('Escape');
  await page
    .locator('.maka-composer-editor [contenteditable="true"]')
    .fill('Write tracked.txt to written, edit written to edited, then read it.');
  await expect(page.locator('.maka-composer button[type="submit"]')).toBeEnabled();
  await page.locator('.maka-composer button[type="submit"]').click();
  if (interruptTurn) {
    await expect.poll(() => waitingForCompletion, { timeout: 30000 }).toBe(true);
  } else {
    await expect(page.getByText('MANAGED_DESKTOP_SMOKE_OK', { exact: true })).toBeVisible({
      timeout: 30000,
    });
  }
  assert.ok(requests.length > 0);
  const finalRequest = requests.filter(({ body }) => body.stream).at(-1);
  const results = finalRequest.body.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === 'tool_result');
  assert.equal(results.length, 3);
  assert.equal(
    results.some((result) => result.is_error),
    false,
  );
  assert.match(JSON.stringify(results.at(-1)), /edited/);
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'baseline\n');
  await page.screenshot({ path: join(root, 'desktop.png') });
  const readMutations = () => {
    const db = new DatabaseSync(join(workspace, 'runtime.sqlite'), { readOnly: true });
    try {
      return db
        .prepare('SELECT payload_json FROM runtime_events ORDER BY rowid')
        .all()
        .map(({ payload_json }) => JSON.parse(payload_json))
        .filter(
          (event) =>
            ['Write', 'Edit'].includes(event.content?.name) ||
            event.actions?.workspaceFact?.kind === 'maka.workspace.version_accepted',
        );
    } finally {
      db.close();
    }
  };
  const mutationsBefore = readMutations();
  assert.equal(
    mutationsBefore.filter((event) => event.content?.kind === 'function_response').length,
    2,
  );
  const { controlDirectory } = await resolveExistingStorageRootControlDirectory(capability);
  const registration = JSON.parse(
    await readFile(join(controlDirectory, 'registration.json'), 'utf8'),
  );
  assert.equal(registration.rootId, capability.rootId);
  assert.equal(registration.state, 'ready');
  assert.ok(Number.isSafeInteger(registration.pid) && registration.pid > 0);
  // Desktop may launch through a utility process. Verify the actual Host command,
  // not an assumed direct-parent topology, against this newly created root.
  const command =
    process.platform === 'win32'
      ? (
          await promisify(execFile)(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${registration.pid}').CommandLine`,
            ],
            { timeout: 10000, windowsHide: true },
          )
        ).stdout.trim()
      : (
          await promisify(execFile)('ps', ['-o', 'args=', '-p', String(registration.pid)], {
            timeout: 10000,
          })
        ).stdout.trim();
  assert.ok(command.includes(capability.rootId), 'Host must name the isolated root ID');
  assert.ok(command.includes(workspace), 'Host must name the isolated workspace path');
  assert.ok(command.includes('--expected-root-id'), 'Host must use verified-root startup');
  process.kill(registration.pid, 'SIGKILL');
  await closeElectronApplication(app, 5000);
  app = undefined;
  restarted = true;
  operationStep = 0;
  app = await electron.launch({
    args: [join(repo, 'scripts/desktop-managed-smoke-entry.cjs')],
    cwd: join(repo, 'apps/desktop'),
    env,
    timeout: 30000,
  });
  app.process().stderr?.on('data', (chunk) => logs.push(chunk.toString()));
  await expect
    .poll(
      () => {
        page = app
          .windows()
          .find(
            (candidate) =>
              candidate.url().includes('/index.html') && !candidate.url().includes('surface='),
          );
        return Boolean(page);
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await page
    .getByText('Managed files smoke task', { exact: true })
    .first()
    .click({ timeout: 30000 });
  if (interruptTurn) {
    await page
      .getByRole('button', { name: 'Continue this turn', exact: true })
      .click({ timeout: 30000 });
    await expect(
      page
        .locator('.maka-turn-failed-banner')
        .getByText('Resuming interrupted tasks is not enabled.', { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    assert.equal(
      requests.filter(({ body }) => body.stream).length,
      4,
      'Disabled continuation must not launch another model invocation',
    );
  } else {
    await expect(page.getByText('MANAGED_DESKTOP_SMOKE_OK', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await page
      .locator('.maka-composer-editor [contenteditable="true"]')
      .fill('Read tracked.txt after restarting. Do not write or edit.');
    await page.locator('.maka-composer button[type="submit"]').click();
  }
  if (!interruptTurn) {
    await expect(page.getByText('MANAGED_DESKTOP_REOPEN_OK', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    const afterRequest = requests.filter(({ body }) => body.stream).at(-1);
    const afterResults = afterRequest.body.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === 'tool_result');
    assert.equal(
      afterResults.length,
      4,
      'Reopened model history includes the three durable results and new Read',
    );
    assert.match(JSON.stringify(afterResults.at(-1)), /edited/);
    assert.equal(Boolean(afterResults.at(-1)?.is_error), false);
  }
  assert.deepEqual(
    readMutations(),
    mutationsBefore,
    'Reopen must preserve the exact Write/Edit outcomes and successors',
  );
  const reopened = JSON.parse(await readFile(join(controlDirectory, 'registration.json'), 'utf8'));
  assert.equal(reopened.rootId, capability.rootId);
  assert.notEqual(reopened.hostEpoch, registration.hostEpoch);
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'baseline\n');
  await page.screenshot({ path: join(root, 'reopened.png') });
  await writeFile(
    join(root, 'restart-evidence.json'),
    JSON.stringify(
      {
        oldEpoch: registration.hostEpoch,
        newEpoch: reopened.hostEpoch,
        mutationEvents: mutationsBefore.map((event) => event.id),
        checkpoint: interruptTurn
          ? 'tool results durable; model completion pending; Continue rejected by default resume gate'
          : 'completed turn; not an in-flight mutation crash',
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: ${interruptTurn ? 'interrupted turn remains safely blocked by resume gate' : 'completed turn reopens with accepted Read'} after Host kill and Desktop restart; mutation events unchanged.`,
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(root, 'failure.png'), timeout: 5000 }).catch(() => {});
  }
  throw error;
} finally {
  try {
    if (app) await closeElectronApplication(app, 5000);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await writeFile(join(root, 'logs.txt'), logs.join(''));
    await writeFile(join(root, 'model-requests.json'), JSON.stringify(requests, null, 2));
  }
}
