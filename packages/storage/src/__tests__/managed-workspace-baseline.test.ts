import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, before, test } from 'node:test';
import { openManagedWorkspaceOwner } from '../managed-workspace-owner.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
let gitExecutablePath: string;
let gitExecutableSha256: `sha256:${string}`;

before(async () => {
  gitExecutablePath = await findGitExecutable();
  gitExecutableSha256 = await sha256File(gitExecutablePath);
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('opens one canonical baseline from a durable verified Git receipt', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const input = {
      ...openRequest(sourceRoot),
      policyHash: `sha256:${'1'.repeat(64)}` as const,
    };

    const first = await owner.openManagedWorkspaceBaseline(runtimeStore, input);
    const retry = await owner.openManagedWorkspaceBaseline(runtimeStore, input);

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.deepEqual(retry.receipt, first.receipt);
    assert.equal(first.head.commitOid, first.binding.baselineCommitOid);
    assert.equal(first.head.treeOid, first.binding.baselineTreeOid);
    assert.equal(first.receipt.changedFileCount, 2);
    assert.equal(first.receipt.deletedFileCount, 0);
    assert.match(first.receipt.treeDeltaDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(
      await runtimeStore.readWorkspaceHead(input.workspaceId, input.workspaceEpochId),
      first.head,
    );
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, {
        ...input,
        policyHash: `sha256:${'9'.repeat(64)}`,
      }),
      /does not match its verified Git boundary/u,
    );

    const unrelatedStore = createSqliteRuntimeStore(join(root, 'other-root', 'runtime.sqlite'));
    try {
      await assert.rejects(
        owner.openManagedWorkspaceBaseline(unrelatedStore, input),
        /belongs to a different storage root/u,
      );
    } finally {
      unrelatedStore.close();
    }

    const receiptPath = join(dirname(first.binding.worktreePath), 'baseline-receipt.json');
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        ...first.receipt,
        treeDeltaDigest: `sha256:${'f'.repeat(64)}`,
      })}\n`,
      'utf8',
    );
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, input),
      /does not match its verified Git boundary/u,
    );
    await writeFile(receiptPath, `${JSON.stringify(first.receipt)}\n`, 'utf8');

    const bindingPath = join(dirname(first.binding.worktreePath), 'binding.json');
    await rm(receiptPath);
    await rm(bindingPath);
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, input),
      /baseline receipt is unavailable/u,
    );
    await assert.rejects(readFile(bindingPath, 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(
      await runtimeStore.readWorkspaceHead(input.workspaceId, input.workspaceEpochId),
      first.head,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('reuses an orphan receipt after interruption before SQLite acceptance', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let interruptOnce = true;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      failpoint(point) {
        if (point === 'after_baseline_receipt' && interruptOnce) {
          interruptOnce = false;
          throw new Error('simulated interruption after durable baseline receipt');
        }
      },
    });
    const input = {
      ...openRequest(sourceRoot),
      policyHash: `sha256:${'2'.repeat(64)}` as const,
    };

    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, input),
      /simulated interruption/u,
    );
    assert.equal(
      await runtimeStore.readWorkspaceHead(input.workspaceId, input.workspaceEpochId),
      undefined,
    );

    const recovered = await owner.openManagedWorkspaceBaseline(runtimeStore, input);
    assert.equal(recovered.created, true);
    assert.equal(recovered.receipt.baselineAcceptedEventId, recovered.head.acceptedEventId);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('keeps an orphan receipt across SQLite rollback and accepts it on retry', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  let interruptOnce = true;
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'), {
    failpoint(point) {
      if (point === 'after_workspace_version_event_insert' && interruptOnce) {
        interruptOnce = false;
        throw new Error('simulated SQLite baseline rollback');
      }
    },
  });
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const input = {
      ...openRequest(sourceRoot),
      policyHash: `sha256:${'3'.repeat(64)}` as const,
    };

    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, input),
      /simulated SQLite baseline rollback/u,
    );
    assert.equal(
      await runtimeStore.readWorkspaceHead(input.workspaceId, input.workspaceEpochId),
      undefined,
    );

    const recovered = await owner.openManagedWorkspaceBaseline(runtimeStore, input);
    assert.equal(recovered.created, true);
    assert.equal(recovered.receipt.workspaceVersionId, recovered.head.workspaceVersionId);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('accepts the same durable receipt after a real process crash before SQLite authority', {
  timeout: 60_000,
}, async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const policyHash = `sha256:${'4'.repeat(64)}` as const;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/git-workspace-service-crash-child.js', import.meta.url))],
    {
      env: {
        ...process.env,
        MAKA_GIT_WORKSPACE_STORAGE: storageRoot,
        MAKA_GIT_WORKSPACE_SOURCE: sourceRoot,
        MAKA_GIT_WORKSPACE_EXECUTABLE: gitExecutablePath,
        MAKA_GIT_WORKSPACE_SHA256: gitExecutableSha256,
        MAKA_GIT_WORKSPACE_FAILPOINT: 'after_baseline_receipt',
        MAKA_GIT_WORKSPACE_ACTION: 'baseline-receipt',
        MAKA_GIT_WORKSPACE_POLICY_HASH: policyHash,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    await waitForReady(child, 30_000);
    const durableBeforeCrash = JSON.parse(
      await readFile(baselineReceiptPath(storageRoot, openRequest(sourceRoot)), 'utf8'),
    );
    child.kill('SIGKILL');
    await waitForExit(child);

    const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
    const rootOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(rootOwner);
    const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
    try {
      const owner = await openManagedWorkspaceOwner({
        rootOwner,
        gitRuntime: {
          executablePath: gitExecutablePath,
          expectedSha256: gitExecutableSha256,
        },
      });
      const accepted = await owner.openManagedWorkspaceBaseline(runtimeStore, {
        ...openRequest(sourceRoot),
        policyHash,
      });
      assert.equal(accepted.created, true);
      assert.equal(accepted.receipt.baselineAcceptedEventId, accepted.head.acceptedEventId);
      assert.deepEqual(accepted.receipt, durableBeforeCrash);
      await owner.close();
    } finally {
      runtimeStore.close();
      await rootOwner.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-workspace-baseline-'));
  cleanup.push(root);
  return root;
}

async function findGitExecutable(): Promise<string> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const { stdout } = await execFileAsync(command, ['git'], { encoding: 'utf8' });
  const first = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) throw new Error('Git executable is unavailable for integration tests');
  return realpath(first);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function createEligibleSource(sourceRoot: string): Promise<string> {
  await mkdir(sourceRoot, { recursive: true });
  await git(sourceRoot, 'init', '--quiet');
  await writeFile(join(sourceRoot, 'tracked.txt'), 'tracked\n', 'utf8');
  await writeFile(join(sourceRoot, '.gitignore'), '.maka-workspace.json\n', 'utf8');
  await writeFile(join(sourceRoot, '.maka-workspace.json'), '{"host":"metadata"}\n', 'utf8');
  await git(sourceRoot, 'add', 'tracked.txt', '.gitignore');
  await git(
    sourceRoot,
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@maka.invalid',
    'commit',
    '--quiet',
    '-m',
    'source baseline',
  );
  return realpath(sourceRoot);
}

function openRequest(sourceRoot: string) {
  return {
    repositoryId: 'repository_11111111111111111111111111111111',
    workspaceId: 'workspace_22222222222222222222222222222222',
    workspaceEpochId: 'epoch_33333333333333333333333333333333',
    workspaceInstanceId: 'instance_44444444444444444444444444444444',
    sourceRoot,
  } as const;
}

function baselineReceiptPath(
  storageRoot: string,
  identity: ReturnType<typeof openRequest>,
): string {
  const compact = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
  return join(
    storageRoot,
    'managed-workspaces',
    'w',
    compact(identity.workspaceId),
    'e',
    compact(identity.workspaceEpochId),
    'i',
    compact(identity.workspaceInstanceId),
    'baseline-receipt.json',
  );
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function waitForReady(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Managed baseline crash child did not become ready: ${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk: unknown) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: unknown) => {
      stderr += String(chunk);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Managed baseline crash child exited early: ${code}/${signal} ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
}
