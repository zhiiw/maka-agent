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
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  createManagedDependencySnapshotAuthority,
  requireManagedDependencySnapshotLeaseAccessInternal,
  type ManagedDependencySnapshotFailpoint,
} from '../managed-dependency-environment.js';

const PACKAGE_JSON = Buffer.from('{"name":"fixture","private":true}\n');
const PACKAGE_LOCK = Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{}}\n');
const execFileAsync = promisify(execFile);
const crashChildEntrypoint = fileURLToPath(
  new URL('./fixtures/managed-dependency-snapshot-crash-child.js', import.meta.url),
);
const leaseConsumerOwnerToken = {};

test('imports a pre-provisioned npm dependency tree into immutable owned bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-snapshot-'));
  const sourceRoot = await createSourceDependencyTree(root, 'source', 'trusted\n');
  const authority = await createAuthority(join(root, 'storage'));
  t.after(async () => {
    await authority.close();
    await rm(root, { recursive: true, force: true });
  });

  const lease = await authority.acquire({
    sourceDependencyRoot: sourceRoot,
    manifestBytes: PACKAGE_JSON,
    lockfileBytes: PACKAGE_LOCK,
  });
  assert.match(lease.environmentId, /^sha256:[0-9a-f]{64}$/u);
  assert.match(lease.contentTreeSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.throws(
    () => requireManagedDependencySnapshotLeaseAccessInternal({}, lease),
    /lease capability is invalid/u,
  );
  assert.throws(
    () =>
      requireManagedDependencySnapshotLeaseAccessInternal(leaseConsumerOwnerToken, {
        environmentId: lease.environmentId,
        contentTreeSha256: lease.contentTreeSha256,
        release: lease.release,
      }),
    /lease capability is invalid/u,
  );
  const access = requireManagedDependencySnapshotLeaseAccessInternal(
    leaseConsumerOwnerToken,
    lease,
  );
  assert.equal(
    await readFile(join(access.dependencyRoot, 'fixture-package', 'index.js'), 'utf8'),
    'trusted\n',
  );

  await writeFile(join(sourceRoot, 'fixture-package', 'index.js'), 'mutated\n', 'utf8');
  assert.equal(
    await readFile(join(access.dependencyRoot, 'fixture-package', 'index.js'), 'utf8'),
    'trusted\n',
  );
  await lease.release();
  assert.throws(
    () => requireManagedDependencySnapshotLeaseAccessInternal(leaseConsumerOwnerToken, lease),
    /lease capability is invalid/u,
  );
});

test('rejects source drift between observation and owned copy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-snapshot-drift-'));
  const sourceRoot = await createSourceDependencyTree(root, 'source', 'before\n');
  const authority = await createAuthority(join(root, 'storage'), async (point) => {
    if (point === 'after_source_observation') {
      await writeFile(join(sourceRoot, 'fixture-package', 'index.js'), 'after\n', 'utf8');
    }
  });
  t.after(async () => {
    await authority.close();
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    authority.acquire({
      sourceDependencyRoot: sourceRoot,
      manifestBytes: PACKAGE_JSON,
      lockfileBytes: PACKAGE_LOCK,
    }),
    /changed while it was imported/u,
  );
});

test('does not reuse a logical environment for different dependency bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-snapshot-conflict-'));
  const firstSource = await createSourceDependencyTree(root, 'source-a', 'first\n');
  const secondSource = await createSourceDependencyTree(root, 'source-b', 'second\n');
  const authority = await createAuthority(join(root, 'storage'));
  t.after(async () => {
    await authority.close();
    await rm(root, { recursive: true, force: true });
  });

  const first = await authority.acquire({
    sourceDependencyRoot: firstSource,
    manifestBytes: PACKAGE_JSON,
    lockfileBytes: PACKAGE_LOCK,
  });
  await first.release();
  await assert.rejects(
    authority.acquire({
      sourceDependencyRoot: secondSource,
      manifestBytes: PACKAGE_JSON,
      lockfileBytes: PACKAGE_LOCK,
    }),
    /does not match the imported source snapshot/u,
  );
});

test('enforces the source byte budget before publishing an artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-snapshot-budget-'));
  const sourceRoot = await createSourceDependencyTree(root, 'source', 'too-large\n');
  await mkdir(join(root, 'storage'), { recursive: true });
  const authority = await createManagedDependencySnapshotAuthority({
    storageRoot: join(root, 'storage'),
    leaseConsumerOwnerToken,
    nodeRuntime: {
      version: process.versions.node,
      abi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    },
    maxSnapshotBytes: 4,
  });
  t.after(async () => {
    await authority.close();
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    authority.acquire({
      sourceDependencyRoot: sourceRoot,
      manifestBytes: PACKAGE_JSON,
      lockfileBytes: PACKAGE_LOCK,
    }),
    /snapshot byte budget/u,
  );
});

for (const failpoint of [
  'after_environment_publish',
  'after_environment_receipt_durable',
] as const satisfies readonly ManagedDependencySnapshotFailpoint[]) {
  test(`snapshot import converges after process exit at ${failpoint}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-dependency-snapshot-crash-'));
    const storageRoot = join(root, 'storage');
    const sourceRoot = await createSourceDependencyTree(root, 'source', 'crash-safe\n');
    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(
      execFileAsync(process.execPath, [crashChildEntrypoint], {
        env: {
          ...process.env,
          MAKA_DEPENDENCY_SNAPSHOT_STORAGE_ROOT: storageRoot,
          MAKA_DEPENDENCY_SNAPSHOT_SOURCE_ROOT: sourceRoot,
          MAKA_DEPENDENCY_SNAPSHOT_CRASH_POINT: failpoint,
        },
        windowsHide: true,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && Number(error.code) === 79,
    );

    const authority = await createAuthority(storageRoot);
    const lease = await authority.acquire({
      sourceDependencyRoot: sourceRoot,
      manifestBytes: PACKAGE_JSON,
      lockfileBytes: PACKAGE_LOCK,
    });
    const access = requireManagedDependencySnapshotLeaseAccessInternal(
      leaseConsumerOwnerToken,
      lease,
    );
    assert.equal(
      await readFile(join(access.dependencyRoot, 'fixture-package', 'index.js'), 'utf8'),
      'crash-safe\n',
    );
    await lease.release();
    await authority.close();
  });
}

async function createAuthority(
  storageRoot: string,
  failpoint?: (point: ManagedDependencySnapshotFailpoint) => void | Promise<void>,
) {
  await mkdir(storageRoot, { recursive: true });
  return await createManagedDependencySnapshotAuthority({
    storageRoot,
    leaseConsumerOwnerToken,
    nodeRuntime: {
      version: process.versions.node,
      abi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    },
    ...(failpoint ? { failpoint } : {}),
  });
}

async function createSourceDependencyTree(
  root: string,
  name: string,
  content: string,
): Promise<string> {
  const dependencyRoot = join(root, name, 'node_modules');
  await mkdir(join(dependencyRoot, 'fixture-package'), { recursive: true });
  await writeFile(join(dependencyRoot, 'fixture-package', 'index.js'), content, 'utf8');
  return dependencyRoot;
}
