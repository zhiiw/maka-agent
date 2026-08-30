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
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGitoxideManagedGcOwnerInternal } from '../server/gitoxide-managed-gc-owner-internal.js';

test('collects only expired restore orphans and converges interrupted tombstones', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-gc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epoch = 'epoch_gc';
  const orphans = join(root, 'gitoxide-managed-restores', epoch, 'orphans');
  const expired = join(orphans, 'expired');
  const retained = join(orphans, 'retained');
  const interrupted = join(orphans, '.gc-interrupted');
  for (const path of [expired, retained, interrupted]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'content.txt'), path, 'utf8');
  }
  await utimes(expired, 1, 1);
  const owner = createGitoxideManagedGcOwnerInternal({
    storageRoot: root,
    workspaceEpochId: epoch,
    now: () => 10_000,
  });

  assert.deepEqual(await owner.collectRestoreOrphans({ olderThanMs: 5_000, maxEntries: 8 }), {
    protocol: 'gitoxide_managed_gc_v1',
    collected: 2,
    retained: 1,
  });
  assert.deepEqual(await readdir(orphans), ['retained']);
});

test('a new process converges an orphan after the collector is killed post-rename', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-gc-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epoch = 'epoch_gc_crash';
  const orphans = join(root, 'gitoxide-managed-restores', epoch, 'orphans');
  const expired = join(orphans, 'expired');
  await mkdir(expired, { recursive: true });
  await writeFile(join(expired, 'content.txt'), 'recover me\n', 'utf8');
  await utimes(expired, 1, 1);
  const fixturePath = join(root, 'gc-crash-fixture.json');
  await writeFile(fixturePath, `${JSON.stringify({ root, epoch })}\n`, 'utf8');

  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, 'fixtures', 'gitoxide-managed-gc-crash-child.js'), fixturePath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [exitCode] = (await once(child, 'exit')) as [number | null];
  assert.equal(exitCode, 76, Buffer.concat(stderr).toString('utf8'));
  assert.equal((await readdir(orphans)).length, 1);
  assert.match((await readdir(orphans))[0] ?? '', /^\.gc-/u);

  const recovered = createGitoxideManagedGcOwnerInternal({
    storageRoot: root,
    workspaceEpochId: epoch,
  });
  assert.deepEqual(await recovered.collectRestoreOrphans({ olderThanMs: 60_000, maxEntries: 8 }), {
    protocol: 'gitoxide_managed_gc_v1',
    collected: 1,
    retained: 0,
  });
  assert.deepEqual(await readdir(orphans), []);
});
