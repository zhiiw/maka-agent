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
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSqliteShellRunStore } from '../shell-run-store.js';

const READY_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 30_000;

test('serializes one durable ShellRun effect claim across real processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-shell-effect-claim-'));
  const startPath = join(root, 'start');
  try {
    const children = ['shell-a', 'shell-b'].map((id) => spawnClaimChild(root, startPath, id));
    await Promise.all(children.map((child) => waitForReady(child)));
    await writeFile(startPath, 'start', 'utf8');
    const results = await Promise.all(children.map((child) => collect(child)));
    assert.deepEqual(
      results.map((result) => result.code),
      [0, 0],
    );
    const claims = results.map(
      (result) =>
        JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? '{}') as {
          created: boolean;
          shellRunId: string;
        },
    );
    assert.equal(claims.filter((claim) => claim.created).length, 1);
    assert.equal(claims[0]?.shellRunId, claims[1]?.shellRunId);

    const store = createSqliteShellRunStore(root);
    try {
      assert.equal(
        (await store.readShellRunBySourceOperation('session-1', 'operation-1'))?.shellRunId,
        claims[0]?.shellRunId,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function spawnClaimChild(root: string, startPath: string, shellRunId: string): ChildProcess {
  return spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/shell-run-effect-claim-child.js', import.meta.url))],
    {
      env: {
        ...process.env,
        MAKA_SHELL_EFFECT_CLAIM_ROOT: root,
        MAKA_SHELL_EFFECT_CLAIM_START: startPath,
        MAKA_SHELL_EFFECT_CLAIM_ID: shellRunId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
}

async function waitForReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('ShellRun claim child was not ready')),
      READY_TIMEOUT_MS,
    );
    const onData = (chunk: Buffer) => {
      if (!chunk.toString('utf8').includes('READY')) return;
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      resolve();
    };
    child.stdout?.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null) reject(new Error(`ShellRun claim child exited before ready: ${code}`));
    });
  });
}

async function collect(
  child: ChildProcess,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`ShellRun claim child timed out: ${stderr}`));
    }, EXIT_TIMEOUT_MS);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
