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
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openStorageWriterComposition } from '@maka/storage/storage-writer-composition';
import { recoverShellRunToolOutcomes } from '../server/shell-run-recovery.js';

const CHILD_TIMEOUT_MS = 30_000;

test('a new process adopts a terminal ShellRun after the producer exits before Runtime T2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-shell-recovery-crash-'));
  const marker = join(root, 'effect-marker');
  let controlDirectory: string | undefined;
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/shell-run-recovery-crash-child.js', import.meta.url))],
      {
        env: {
          ...process.env,
          MAKA_SHELL_RECOVERY_ROOT: root,
          MAKA_SHELL_RECOVERY_MARKER: marker,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const childResult = await collectChild(child);
    assert.equal(childResult.code, 86, childResult.stderr);
    assert.match(childResult.stdout, /SHELL_TERMINAL_DURABLE/u);
    assert.equal(await readFile(marker, 'utf8'), 'x');

    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    controlDirectory = owner.controlDirectory;
    const storage = await openStorageWriterComposition(owner.lease);
    try {
      assert.deepEqual(
        await recoverShellRunToolOutcomes(
          storage.execution.runtimeEventStore,
          storage.shellRuns,
          ['session-1'],
          () => 50,
        ),
        { settled: 1, parked: 0 },
      );
      assert.equal(await readFile(marker, 'utf8'), 'x');
      assert.deepEqual(
        await recoverShellRunToolOutcomes(
          storage.execution.runtimeEventStore,
          storage.shellRuns,
          ['session-1'],
          () => 60,
        ),
        { settled: 0, parked: 0 },
      );
      const events = await storage.execution.runtimeEventStore.readImmutableRuntimeEvents(
        'session-1',
        'shell-recovery-run',
      );
      assert.equal(events.length, 3);
      const response = events.at(-1)?.content;
      assert.equal(response?.kind, 'function_response');
      if (response?.kind !== 'function_response') assert.fail('Recovery response is missing');
      assert.equal(response.isError, undefined);
    } finally {
      await storage.close();
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    if (controlDirectory) await rm(controlDirectory, { recursive: true, force: true });
  }
});

async function collectChild(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
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
      reject(new Error(`ShellRun recovery crash child timed out: ${stderr}`));
    }, CHILD_TIMEOUT_MS);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
