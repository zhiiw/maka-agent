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
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectCollaborationTools } from '@maka/runtime/plan-mode';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import type {
  AcquireManagedDependencyEnvironmentInput,
  ManagedDependencyEnvironmentAuthority,
  ManagedDependencyEnvironmentIdentityV1,
} from '@maka/storage/managed-dependency-environment';
import type { ManagedWorkspaceFilesystemWorker } from '@maka/storage/managed-workspace-owner';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
  type GitoxideHelperInvocationCapability,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import { createGitoxideManagedInspectionComposition } from '../server/gitoxide-managed-inspection.js';

const fakeNpmRuntime = Object.freeze({
  npmVersion: '12.0.2' as const,
  nodeVersion: '24.15.0',
  nodeAbi: '137',
  platform: process.platform,
  arch: process.arch,
  resourcesRoot: join(tmpdir(), 'not-used-packaged-resources'),
  nodeExecutablePath: process.execPath,
  npmRuntimeRoot: join(tmpdir(), 'not-used-npm-runtime'),
  npmCliPath: join(tmpdir(), 'not-used-npm-cli.js'),
  runtimeIdentitySha256: `sha256:${'1'.repeat(64)}` as const,
});

test('keeps provisioning-backed managed inspection out of read-only Plan Mode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-inspection-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const composition = await createGitoxideManagedInspectionComposition({
    storageRoot: root,
    invocationOwnerToken: {},
    helperCapability: Object.freeze({
      kind: 'gitoxide_helper_invocation_capability_v1' as const,
    }),
    npmRuntime: fakeNpmRuntime,
    dependencyAuthority: inertDependencyAuthority(),
    filesystemWorker: rejectingFilesystemWorker(),
  });
  t.after(() => composition.close());

  assert.equal(composition.tool.categoryHint, 'custom_tool');
  assert.equal(composition.tool.recoveryMode, 'never_auto_retry');
  assert.deepEqual(
    selectCollaborationTools({
      mode: 'plan',
      tools: [composition.tool],
      hasActiveExecution: false,
    }),
    [],
  );
  await assert.rejects(
    Promise.resolve(
      composition.tool.impl(
        { kind: 'read', path: 'foo/../node_modules/escape.js' },
        toolContext(root),
      ),
    ),
    /dot-dot/u,
  );
});

test('reads source and dependency files through the real Gitoxide product data plane', async (t) => {
  const admittedHelper = await admitRealHelper();
  if (!admittedHelper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the product composition test');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'maka-gitoxide-inspection-product-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const dependencyRoot = join(root, 'leased', 'node_modules');
  await Promise.all([
    mkdir(join(sourceRoot, 'src'), { recursive: true }),
    mkdir(join(dependencyRoot, 'fixture-package'), { recursive: true }),
  ]);
  const manifestText = '{"name":"fixture","version":"1.0.0"}\n';
  const lockfileText = '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n';
  await Promise.all([
    writeFile(join(sourceRoot, 'package.json'), manifestText),
    writeFile(join(sourceRoot, 'package-lock.json'), lockfileText),
    writeFile(join(sourceRoot, 'src', 'index.ts'), 'export const answer = 42;\n'),
    writeFile(
      join(dependencyRoot, 'fixture-package', 'package.json'),
      '{"name":"fixture-package"}\n',
    ),
  ]);
  git(sourceRoot, ['init', '--quiet']);
  git(sourceRoot, ['add', '.']);
  git(sourceRoot, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);

  const identities: ManagedDependencyEnvironmentIdentityV1[] = [];
  let closed = false;
  const dependencyAuthority: ManagedDependencyEnvironmentAuthority = Object.freeze({
    async acquire(
      identity: ManagedDependencyEnvironmentIdentityV1,
      source: AcquireManagedDependencyEnvironmentInput,
    ) {
      identities.push(identity);
      assert.equal(Buffer.from(source.manifestBytes).toString('utf8'), manifestText);
      assert.equal(Buffer.from(source.lockfileBytes).toString('utf8'), lockfileText);
      return Object.freeze({
        environmentId: identity.environmentId,
        dependencyRoot,
        async release() {},
      });
    },
    async close() {
      closed = true;
    },
  });
  const seenCwds: string[] = [];
  const filesystemWorker: ManagedWorkspaceFilesystemWorker = {
    async execute(input) {
      seenCwds.push(input.cwd);
      assert.equal(input.operation.kind, 'read');
      if (input.operation.kind !== 'read') throw new Error('unexpected operation');
      return {
        kind: 'read',
        content: await readFile(join(input.cwd, input.operation.path), 'utf8'),
      };
    },
  };
  const composition = await createGitoxideManagedInspectionComposition({
    storageRoot: root,
    invocationOwnerToken: admittedHelper.invocationOwnerToken,
    helperCapability: admittedHelper.helperCapability,
    npmRuntime: fakeNpmRuntime,
    dependencyAuthority,
    filesystemWorker,
  });

  const source = await composition.tool.impl(
    { kind: 'read', path: 'src/index.ts' },
    toolContext(sourceRoot),
  );
  assert.deepEqual(source.result, { kind: 'read', content: 'export const answer = 42;\n' });
  assert.equal(source.dependencyEnvironmentId, undefined);
  assert.equal(identities.length, 0);
  assert.equal(seenCwds.length, 0);

  const dependency = await composition.tool.impl(
    { kind: 'read', path: 'node_modules/fixture-package/package.json' },
    toolContext(sourceRoot),
  );
  assert.deepEqual(dependency.result, {
    kind: 'read',
    content: '{"name":"fixture-package"}\n',
  });
  assert.equal(identities.length, 1);
  assert.equal(seenCwds[0], dependencyRoot);
  await composition.close();
  assert.equal(closed, true);
});

function inertDependencyAuthority(): ManagedDependencyEnvironmentAuthority {
  return Object.freeze({
    async acquire() {
      throw new Error('not used');
    },
    async close() {},
  });
}

function rejectingFilesystemWorker(): ManagedWorkspaceFilesystemWorker {
  return {
    async execute() {
      throw new Error('not used');
    },
  };
}

function toolContext(cwd: string): MakaToolContext {
  return {
    sessionId: 'session-managed-inspection',
    turnId: 'turn-managed-inspection',
    toolCallId: 'tool-managed-inspection',
    cwd,
    abortSignal: new AbortController().signal,
  } as MakaToolContext;
}

interface AdmittedHelper {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
}

async function admitRealHelper(): Promise<AdmittedHelper | undefined> {
  const executablePath = process.env.MAKA_GITOXIDE_HELPER_PATH;
  if (!executablePath) return undefined;
  const canonicalPath = await realpath(executablePath);
  const bytes = await readFile(canonicalPath);
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath: canonicalPath,
    expectedSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    expectedBytes: (await stat(canonicalPath)).size,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
  });
  return {
    invocationOwnerToken,
    helperCapability: await admitGitoxideHelperArtifactInternal({
      releaseOwnerToken,
      invocationOwnerToken,
      claim,
    }),
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: join(cwd, '.home'),
      GIT_CONFIG_GLOBAL: join(cwd, '.missing-global-config'),
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}
