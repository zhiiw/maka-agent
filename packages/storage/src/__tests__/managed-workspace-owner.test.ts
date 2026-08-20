import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  RuntimeEvent,
  RuntimeEventManagedWorkspaceMutationV1,
} from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import {
  ManagedWorkspaceOwnerError,
  openManagedWorkspaceOwner,
  type ManagedWorkspaceExecutionHandle,
  type ManagedWorkspaceExecutionScope,
} from '../managed-workspace-owner.js';
import {
  managedWorkspaceExecutionAuthorityTestSupport,
  ManagedWorkspaceExecutionAuthorityError,
} from '../managed-workspace-execution-authority-internal.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import { readActiveManagedMutationInternal } from '../workspace-version-authority-internal.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
const {
  inspectHandle: inspectManagedWorkspaceExecutionHandleInternal,
  inspectScope: inspectManagedWorkspaceExecutionScopeInternal,
} = managedWorkspaceExecutionAuthorityTestSupport;
let gitExecutablePath: string;
let gitExecutableSha256: `sha256:${string}`;
const TEST_MUTATION_PROFILE = `sha256:${'a'.repeat(64)}` as const;
const RUN_REAL_PROCESS_CRASH_TESTS = process.env.MAKA_STORAGE_STRESS === '1';

before(async () => {
  gitExecutablePath = await findGitExecutable();
  gitExecutableSha256 = await sha256File(gitExecutablePath);
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('admits exactly one managed workspace owner for an interactive root owner', async () => {
  const storageRoot = await temporaryRoot();
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  try {
    const managedOwner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });

    await assert.rejects(
      openManagedWorkspaceOwner({
        rootOwner,
        gitRuntime: {
          executablePath: gitExecutablePath,
          expectedSha256: gitExecutableSha256,
        },
      }),
      isOwnerError('managed_workspace_owner_conflict'),
    );
    await managedOwner.close();
    await managedOwner.close();
  } finally {
    await rootOwner.close();
  }
});

test('releases a partial owner claim when pinned Git initialization fails', async () => {
  const storageRoot = await temporaryRoot();
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  try {
    await assert.rejects(
      openManagedWorkspaceOwner({
        rootOwner,
        gitRuntime: {
          executablePath: gitExecutablePath,
          expectedSha256: `sha256:${'0'.repeat(64)}`,
        },
      }),
      isOwnerError('managed_workspace_owner_unavailable'),
    );

    const retry = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    assert.equal(retry.state, 'ready');
    await retry.close();
  } finally {
    await rootOwner.close();
  }
});

test('creates an accepted managed baseline only through the active owner', async () => {
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

    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const { binding, receipt } = inspectManagedWorkspaceExecutionHandleInternal(
      accepted.executionHandle,
    );

    assert.equal(binding.sourceTreeOid, binding.baselineTreeOid);
    assert.notEqual(binding, receipt.binding);
    assert.deepEqual(binding, receipt.binding);
    assert.equal(existsSync(join(binding.worktreePath, '.maka-workspace.json')), false);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('publishes only a revocable execution scope through its accepted handle', async () => {
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
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    assert.equal('binding' in accepted, false);
    assert.equal('receipt' in accepted, false);
    let retainedScope: unknown;
    const execution = await owner.withManagedWorkspaceExecution(
      accepted.executionHandle,
      async (scope) => {
        retainedScope = scope;
        assert.equal('cwd' in scope, false);
        assert.equal(scope.kind, 'managed_workspace_execution_scope_v1');
        await assert.rejects(
          () =>
            owner.executeReadOnlyFilesystemOperation(scope, {
              kind: 'read',
              path: 'README.md',
            }),
          (error) =>
            error instanceof ManagedWorkspaceOwnerError &&
            error.code === 'managed_workspace_worker_unavailable',
        );
        return 'admitted';
      },
    );

    assert.equal(execution, 'admitted');
    assert.deepEqual(retainedScope, { kind: 'managed_workspace_execution_scope_v1' });
    assert.throws(
      () =>
        inspectManagedWorkspaceExecutionScopeInternal({
          kind: 'managed_workspace_execution_scope_v1',
        }),
      (error) =>
        error instanceof ManagedWorkspaceExecutionAuthorityError &&
        error.code === 'managed_workspace_execution_scope_invalid',
    );
    assert.throws(
      () =>
        inspectManagedWorkspaceExecutionScopeInternal(
          retainedScope as ManagedWorkspaceExecutionScope,
        ),
      (error) =>
        error instanceof ManagedWorkspaceExecutionAuthorityError &&
        error.code === 'managed_workspace_execution_scope_expired',
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('freezes canonical Write/Edit admission from the owner-bound head and worker profile', async () => {
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
      filesystemWorker: {
        mutationExecutionProfileDigest: TEST_MUTATION_PROFILE,
        async execute() {
          throw new Error('worker must not execute during admission');
        },
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    const inputPath = process.platform === 'win32' ? 'dir\\tracked.txt' : 'dir/tracked.txt';
    const admission = await owner.admitManagedWorkspaceMutation(accepted.executionHandle, {
      operationId: 'operation-managed-write-1',
      toolName: 'Write',
      persistedArgs: { path: inputPath, content: 'updated\n' },
      abortSignal: new AbortController().signal,
    });

    assert.deepEqual(admission.durableDispatch, {
      protocol: 'managed_mutation_v1',
      repositoryId: accepted.head.repositoryId,
      workspaceId: accepted.head.workspaceId,
      workspaceEpochId: accepted.head.workspaceEpochId,
      workspaceInstanceId: openRequest(sourceRoot).workspaceInstanceId,
      objectFormat: 'sha1',
      baseWorkspaceVersionId: accepted.head.workspaceVersionId,
      baseAcceptedEventId: accepted.head.acceptedEventId,
      baseHeadRevision: accepted.head.revision,
      baseCommitOid: accepted.head.commitOid,
      baseTreeOid: accepted.head.treeOid,
      baseBlobOid: null,
      expectedPaths: ['dir/tracked.txt'],
      executionProfileDigest: admission.durableDispatch.executionProfileDigest,
    });
    assert.equal(admission.canonicalPath, 'dir/tracked.txt');
    assert.match(admission.durableDispatch.executionProfileDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal('executionProfileDigest' in admission, false);

    await admission.dispose();
    const editAdmission = await owner.admitManagedWorkspaceMutation(accepted.executionHandle, {
      operationId: 'operation-managed-edit-1',
      toolName: 'Edit',
      persistedArgs: {
        path: 'tracked.txt',
        old_string: 'tracked',
        new_string: 'after',
      },
      abortSignal: new AbortController().signal,
    });
    assert.deepEqual(editAdmission.durableDispatch.expectedPaths, ['tracked.txt']);
    assert.equal(editAdmission.canonicalPath, 'tracked.txt');
    assert.equal(editAdmission.durableDispatch.baseBlobOid, gitBlobOid('tracked\n'));
    await editAdmission.dispose();
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('accepts a worker-owned Write only after capturing its Git candidate', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const operationId = 'operation-managed-write-success';
  const toolCallId = 'call-managed-write-success';
  const args = { path: 'tracked.txt', content: 'updated by managed worker\n' };
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      filesystemWorker: {
        mutationExecutionProfileDigest: TEST_MUTATION_PROFILE,
        async execute(input) {
          assert.equal(input.operation.kind, 'write');
          if (input.operation.kind !== 'write') throw new Error('expected Write');
          const target = join(input.cwd, input.operation.path);
          return {
            kind: 'write' as const,
            ok: true as const,
            path: target,
            bytes: Buffer.byteLength(input.operation.content, 'utf8'),
            resultBlobOid: gitBlobOid(input.operation.content),
            resultContent: input.operation.content,
          };
        },
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const admission = await owner.admitManagedWorkspaceMutation(accepted.executionHandle, {
      operationId,
      toolName: 'Write',
      persistedArgs: args,
      abortSignal: new AbortController().signal,
    });
    await commitManagedMutationT1(runtimeStore, admission.durableDispatch, {
      operationId,
      toolCallId,
      args,
    });

    const settlement = await admission.execute(async () => {
      const result = await owner.executeManagedMutationFilesystemOperation(
        { kind: 'write', path: args.path, content: args.content },
        new AbortController().signal,
      );
      assert.equal(result.kind, 'write');
      const content = {
        kind: 'file_write' as const,
        path: result.kind === 'write' ? result.path : args.path,
        bytes: result.kind === 'write' ? result.bytes : 0,
      };
      return {
        content,
        isError: false,
        durationMs: 1,
        durableOutcome: managedMutationOutcome(operationId, toolCallId, content),
      };
    });

    assert.equal(settlement.kind, 'workspace_successor_committed');
    const head = await runtimeStore.readWorkspaceHead(
      accepted.head.workspaceId,
      accepted.head.workspaceEpochId,
    );
    assert.equal(head?.revision, 2);
    assert.notEqual(head?.commitOid, accepted.head.commitOid);
    const { binding } = inspectManagedWorkspaceExecutionHandleInternal(accepted.executionHandle);
    assert.equal(await readFile(join(binding.worktreePath, 'tracked.txt'), 'utf8'), args.content);
    const events = await runtimeStore.readSessionRuntimeEvents('session-managed-mutation');
    assert.equal(
      events.some((event) => event.id === `${operationId}_response`),
      true,
    );

    const secondOperationId = 'operation-managed-write-success-2';
    const secondToolCallId = 'call-managed-write-success-2';
    const secondArgs = { path: 'tracked.txt', content: 'second managed version\n' };
    const secondAdmission = await owner.admitManagedWorkspaceMutation(accepted.executionHandle, {
      operationId: secondOperationId,
      toolName: 'Write',
      persistedArgs: secondArgs,
      abortSignal: new AbortController().signal,
    });
    assert.equal(secondAdmission.durableDispatch.baseHeadRevision, 2);
    await commitManagedMutationT1(runtimeStore, secondAdmission.durableDispatch, {
      operationId: secondOperationId,
      toolCallId: secondToolCallId,
      args: secondArgs,
    });
    await secondAdmission.execute(async () => {
      const result = await owner.executeManagedMutationFilesystemOperation(
        { kind: 'write', path: secondArgs.path, content: secondArgs.content },
        new AbortController().signal,
      );
      assert.equal(result.kind, 'write');
      const content = {
        kind: 'file_write' as const,
        path: result.kind === 'write' ? result.path : secondArgs.path,
        bytes: result.kind === 'write' ? result.bytes : 0,
      };
      return {
        content,
        isError: false,
        durationMs: 1,
        durableOutcome: managedMutationOutcome(secondOperationId, secondToolCallId, content),
      };
    });
    const secondHead = await runtimeStore.readWorkspaceHead(
      accepted.head.workspaceId,
      accepted.head.workspaceEpochId,
    );
    assert.equal(secondHead?.revision, 3);
    assert.equal(
      await readFile(join(binding.worktreePath, 'tracked.txt'), 'utf8'),
      secondArgs.content,
    );

    await owner.close();
    await rootOwner.close();
    const reopenedRootOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(reopenedRootOwner);
    const reopenedOwner = await openManagedWorkspaceOwner({
      rootOwner: reopenedRootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      filesystemWorker: {
        mutationExecutionProfileDigest: TEST_MUTATION_PROFILE,
        async execute() {
          throw new Error('worker must not execute while reopening an accepted successor');
        },
      },
    });
    const reopened = await reopenedOwner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    assert.equal(reopened.head.revision, 3);
    assert.equal(reopened.head.commitOid, secondHead?.commitOid);
    assert.equal(
      inspectManagedWorkspaceExecutionHandleInternal(reopened.executionHandle).candidateReceipt
        ?.candidateCommitOid,
      secondHead?.commitOid,
    );
    await reopenedOwner.close();
    await reopenedRootOwner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects same-path external content without letting the detached Edit overwrite it', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const operationId = 'operation-managed-edit-same-path-drift';
  const toolCallId = 'call-managed-edit-same-path-drift';
  const args = { path: 'tracked.txt', old_string: 'tracked', new_string: 'updated' };
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      filesystemWorker: {
        mutationExecutionProfileDigest: TEST_MUTATION_PROFILE,
        async execute(input) {
          assert.equal(input.operation.kind, 'edit');
          if (input.operation.kind !== 'edit') throw new Error('expected Edit');
          const target = join(input.cwd, input.operation.path);
          return {
            kind: 'edit' as const,
            ok: true as const,
            path: target,
            replacements: 1 as const,
            matchedVia: 'exact' as const,
            startLine: 1,
            endLine: 1,
            // The detached transform is derived from Git base content and must
            // not overwrite the externally modified projection.
            resultBlobOid: gitBlobOid('updated\n'),
            resultContent: 'updated\n',
          };
        },
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const admission = await owner.admitManagedWorkspaceMutation(accepted.executionHandle, {
      operationId,
      toolName: 'Edit',
      persistedArgs: args,
      abortSignal: new AbortController().signal,
    });
    await commitManagedMutationT1(runtimeStore, admission.durableDispatch, {
      operationId,
      toolCallId,
      toolName: 'Edit',
      args,
    });
    const { binding } = inspectManagedWorkspaceExecutionHandleInternal(accepted.executionHandle);
    await writeFile(join(binding.worktreePath, args.path), 'tracked\nEXTERNAL\n', 'utf8');

    await assert.rejects(
      admission.execute(async () => {
        const result = await owner.executeManagedMutationFilesystemOperation(
          {
            kind: 'edit',
            path: args.path,
            oldString: args.old_string,
            newString: args.new_string,
          },
          new AbortController().signal,
        );
        const content = { kind: 'json' as const, value: result };
        return {
          content,
          isError: false,
          durationMs: 1,
          durableOutcome: managedMutationOutcome(operationId, toolCallId, content, false, 'Edit'),
        };
      }),
      /external changes/u,
    );
    assert.equal(
      await readFile(join(binding.worktreePath, args.path), 'utf8'),
      'tracked\nEXTERNAL\n',
    );
    assert.equal(
      (
        await runtimeStore.readWorkspaceHead(
          accepted.head.workspaceId,
          accepted.head.workspaceEpochId,
        )
      )?.revision,
      1,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('atomically settles post-T1 failure and successful no-effect Writes without advancing the head', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const operationId = 'operation-managed-write-no-effect-error';
  const toolCallId = 'call-managed-write-no-effect-error';
  const args = { path: 'tracked.txt', content: 'unused\n' };
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      filesystemWorker: {
        mutationExecutionProfileDigest: TEST_MUTATION_PROFILE,
        async execute(input) {
          assert.equal(input.operation.kind, 'write');
          if (input.operation.kind !== 'write') throw new Error('expected Write');
          const target = join(input.cwd, input.operation.path);
          return {
            kind: 'write' as const,
            ok: true as const,
            path: target,
            bytes: Buffer.byteLength(input.operation.content, 'utf8'),
            resultBlobOid: gitBlobOid(input.operation.content),
            resultContent: input.operation.content,
          };
        },
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const controller = new AbortController();
    const admission = await owner.admitManagedWorkspaceMutation(accepted.executionHandle, {
      operationId,
      toolName: 'Write',
      persistedArgs: args,
      abortSignal: controller.signal,
    });
    await commitManagedMutationT1(runtimeStore, admission.durableDispatch, {
      operationId,
      toolCallId,
      args,
    });
    const result = { kind: 'text' as const, text: 'Write failed before changing the workspace' };
    controller.abort(new Error('cancelled after T1'));
    let operationProofCalls = 0;

    const settlement = await admission.execute(async () => {
      operationProofCalls += 1;
      return {
        content: result,
        isError: true,
        durationMs: 1,
        durableOutcome: managedMutationOutcome(operationId, toolCallId, result, true),
      };
    });

    assert.equal(operationProofCalls, 1);
    assert.equal(settlement.kind, 'operation_failed_no_effect_committed');
    assert.equal(
      (
        await runtimeStore.readWorkspaceHead(
          accepted.head.workspaceId,
          accepted.head.workspaceEpochId,
        )
      )?.revision,
      1,
    );
    assert.equal(
      (await runtimeStore.readToolOperation(operationId))?.currentState,
      'outcome_committed',
    );
    assert.equal(
      await readActiveManagedMutationInternal(
        runtimeStore,
        openRequest(sourceRoot).workspaceInstanceId,
      ),
      undefined,
    );

    await runtimeStore.rebuildWorkspaceVersionProjections();
    assert.equal(
      await readActiveManagedMutationInternal(
        runtimeStore,
        openRequest(sourceRoot).workspaceInstanceId,
      ),
      undefined,
    );

    const noChangeOperationId = 'operation-managed-write-no-change';
    const noChangeToolCallId = 'call-managed-write-no-change';
    const noChangeArgs = { path: 'tracked.txt', content: 'tracked\n' };
    const noChangeAdmission = await owner.admitManagedWorkspaceMutation(accepted.executionHandle, {
      operationId: noChangeOperationId,
      toolName: 'Write',
      persistedArgs: noChangeArgs,
      abortSignal: new AbortController().signal,
    });
    await commitManagedMutationT1(runtimeStore, noChangeAdmission.durableDispatch, {
      operationId: noChangeOperationId,
      toolCallId: noChangeToolCallId,
      args: noChangeArgs,
    });
    const noChangeContent = {
      kind: 'file_write' as const,
      path: 'tracked.txt',
      bytes: Buffer.byteLength(noChangeArgs.content, 'utf8'),
    };
    const noChangeSettlement = await noChangeAdmission.execute(async () => {
      await owner.executeManagedMutationFilesystemOperation(
        { kind: 'write', path: noChangeArgs.path, content: noChangeArgs.content },
        new AbortController().signal,
      );
      return {
        content: noChangeContent,
        isError: false,
        durationMs: 1,
        durableOutcome: managedMutationOutcome(
          noChangeOperationId,
          noChangeToolCallId,
          noChangeContent,
        ),
      };
    });
    assert.equal(noChangeSettlement.kind, 'no_workspace_change_committed');
    assert.equal(
      (
        await runtimeStore.readWorkspaceHead(
          accepted.head.workspaceId,
          accepted.head.workspaceEpochId,
        )
      )?.revision,
      1,
    );
    await runtimeStore.rebuildWorkspaceVersionProjections();
    assert.equal(
      await readActiveManagedMutationInternal(
        runtimeStore,
        openRequest(sourceRoot).workspaceInstanceId,
      ),
      undefined,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('converges a managed Write after a real process crash between SQLite acceptance and Git projection', {
  skip: !RUN_REAL_PROCESS_CRASH_TESTS,
  timeout: 60_000,
}, async () => {
  const root = await temporaryRoot();
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const storageRoot = join(root, 'storage');
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/git-workspace-service-crash-child.js', import.meta.url))],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MAKA_GIT_WORKSPACE_ACTION: 'managed-mutation-owner',
        MAKA_GIT_WORKSPACE_STORAGE: storageRoot,
        MAKA_GIT_WORKSPACE_SOURCE: sourceRoot,
        MAKA_GIT_WORKSPACE_EXECUTABLE: gitExecutablePath,
        MAKA_GIT_WORKSPACE_SHA256: gitExecutableSha256,
        MAKA_GIT_WORKSPACE_FAILPOINT: 'after_managed_successor_commit',
      },
    },
  );
  try {
    await waitForReady(child, 30_000);
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
        filesystemWorker: {
          mutationExecutionProfileDigest: TEST_MUTATION_PROFILE,
          async execute() {
            throw new Error('reopen must project the accepted candidate without rerunning Write');
          },
        },
      });
      const reopened = await owner.openManagedWorkspaceBaseline(
        runtimeStore,
        openRequest(sourceRoot),
      );
      assert.equal(reopened.head.revision, 2);
      const { binding } = inspectManagedWorkspaceExecutionHandleInternal(reopened.executionHandle);
      assert.equal(
        await readFile(join(binding.worktreePath, 'tracked.txt'), 'utf8'),
        'accepted before process crash\n',
      );
      assert.equal(
        (await runtimeStore.readToolOperation('operation-real-process-managed-write'))
          ?.currentState,
        'outcome_committed',
      );
      assert.equal(
        await readActiveManagedMutationInternal(runtimeStore, binding.workspaceInstanceId),
        undefined,
      );
      await owner.close();
    } finally {
      runtimeStore.close();
      await rootOwner.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('does not let caller-mutated head state or a shadowed public reader forge execution authority', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let callbackCalled = false;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const forgedHead = {
      ...accepted.head,
      workspaceVersionId: `version_${'a'.repeat(32)}`,
      commitOid: 'a'.repeat(40),
      treeOid: 'b'.repeat(40),
      revision: accepted.head.revision + 1,
    };
    assert.throws(() => Object.assign(accepted.head, forgedHead), TypeError);
    Object.defineProperty(runtimeStore, 'readWorkspaceHead', {
      configurable: true,
      value: async () => forgedHead,
    });

    await owner.withManagedWorkspaceExecution(accepted.executionHandle, async (scope) => {
      callbackCalled = true;
      const context = inspectManagedWorkspaceExecutionScopeInternal(scope);
      assert.equal(context.head.workspaceVersionId, accepted.head.workspaceVersionId);
      assert.equal(context.head.commitOid, accepted.head.commitOid);
      assert.equal(context.head.treeOid, accepted.head.treeOid);
    });
    assert.equal(callbackCalled, true);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('quarantines drift introduced after execution artifact verification before publishing cwd', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let executionFailpointArmed = false;
  let callbackCalled = false;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      async failpoint(point) {
        if (
          executionFailpointArmed &&
          (point as string) === 'after_execution_artifact_verification'
        ) {
          executionFailpointArmed = false;
          const acceptedEvidence = inspectManagedWorkspaceExecutionHandleInternal(
            accepted.executionHandle,
          );
          await writeFile(
            join(acceptedEvidence.binding.worktreePath, 'tracked.txt'),
            'external drift after verification\n',
            'utf8',
          );
        }
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    executionFailpointArmed = true;

    await assert.rejects(
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {
        callbackCalled = true;
      }),
      isOwnerError('managed_workspace_quarantined'),
    );

    assert.equal(callbackCalled, false);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects execution when runtime.sqlite detaches from its canonical path after verification', {
  skip:
    process.platform === 'win32'
      ? 'Open SQLite files cannot be renamed reliably on Windows'
      : false,
}, async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const databasePath = join(storageRoot, 'runtime.sqlite');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(databasePath);
  let executionFailpointArmed = false;
  let callbackCalled = false;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      async failpoint(point) {
        if (
          executionFailpointArmed &&
          (point as string) === 'after_execution_artifact_verification'
        ) {
          executionFailpointArmed = false;
          await rename(databasePath, `${databasePath}.detached`);
        }
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    executionFailpointArmed = true;

    await assert.rejects(
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {
        callbackCalled = true;
      }),
      /database file identity changed|belongs to a different storage root/u,
    );
    assert.equal(callbackCalled, false);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects a forged execution handle before invoking the tool callback', async () => {
  const storageRoot = await temporaryRoot();
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  let callbackCalled = false;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });

    await assert.rejects(
      owner.withManagedWorkspaceExecution(
        Object.freeze({
          kind: 'managed_workspace_execution_handle_v1',
        }) as ManagedWorkspaceExecutionHandle,
        async () => {
          callbackCalled = true;
        },
      ),
      isOwnerError('managed_workspace_execution_handle_invalid'),
    );

    assert.equal(callbackCalled, false);
    await owner.close();
  } finally {
    await rootOwner.close();
  }
});

test('rejects an execution handle issued by another managed workspace owner', async () => {
  const root = await temporaryRoot();
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const leftCapability = await resolveStorageRoot({
    path: join(root, 'left-storage'),
    kind: 'interactive',
  });
  const rightCapability = await resolveStorageRoot({
    path: join(root, 'right-storage'),
    kind: 'interactive',
  });
  const leftRootOwner = await tryAcquireInteractiveRootOwner(leftCapability);
  const rightRootOwner = await tryAcquireInteractiveRootOwner(rightCapability);
  assert.ok(leftRootOwner);
  assert.ok(rightRootOwner);
  const leftStore = createSqliteRuntimeStore(join(leftCapability.canonicalPath, 'runtime.sqlite'));
  try {
    const leftOwner = await openManagedWorkspaceOwner({
      rootOwner: leftRootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const rightOwner = await openManagedWorkspaceOwner({
      rootOwner: rightRootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await leftOwner.openManagedWorkspaceBaseline(
      leftStore,
      openRequest(sourceRoot),
    );

    await assert.rejects(
      rightOwner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {}),
      isOwnerError('managed_workspace_execution_handle_invalid'),
    );

    await leftOwner.close();
    await rightOwner.close();
  } finally {
    leftStore.close();
    await leftRootOwner.close();
    await rightRootOwner.close();
  }
});

test('drains an admitted managed execution before owner close completes', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let releaseExecution!: () => void;
  const executionMayFinish = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  let executionAdmitted!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    executionAdmitted = resolve;
  });
  let executing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    executing = owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {
      executionAdmitted();
      await executionMayFinish;
    });
    await executionStarted;

    let closeSettled = false;
    closing = owner.close().then(() => {
      closeSettled = true;
    });
    assert.equal(
      await Promise.race([closing.then(() => 'closed'), delay(250, 'pending')]),
      'pending',
    );
    assert.equal(closeSettled, false);
    await assert.rejects(
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {}),
      isOwnerError('managed_workspace_owner_closing'),
    );

    releaseExecution();
    await executing;
    await closing;
    assert.equal(owner.state, 'closed');
  } finally {
    releaseExecution();
    await Promise.allSettled([executing, closing].filter((value) => value !== undefined));
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('routes read-only execution through the owner-bound worker bridge', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const workerCalls: Array<{ cwd: string; operation: { kind: string } }> = [];
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      filesystemWorker: {
        mutationExecutionProfileDigest: TEST_MUTATION_PROFILE,
        async execute(input) {
          workerCalls.push(input);
          return { kind: 'read', content: 'ok' };
        },
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    await owner.withManagedWorkspaceExecution(accepted.executionHandle, async (scope) => {
      assert.deepEqual(
        await owner.executeReadOnlyFilesystemOperation(scope, {
          kind: 'read',
          path: 'README.md',
        }),
        { kind: 'read', content: 'ok' },
      );
    });

    assert.equal(workerCalls.length, 1);
    assert.equal(workerCalls[0]?.operation.kind, 'read');
    assert.equal(workerCalls[0]?.cwd.endsWith('worktree'), true);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('revokes the scope and releases owner residency when the filesystem worker fails', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let retainedScope: ManagedWorkspaceExecutionScope | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      filesystemWorker: {
        mutationExecutionProfileDigest: TEST_MUTATION_PROFILE,
        async execute() {
          throw new Error('simulated filesystem worker crash');
        },
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    await assert.rejects(
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async (scope) => {
        retainedScope = scope;
        return await owner.executeReadOnlyFilesystemOperation(scope, {
          kind: 'read',
          path: 'README.md',
        });
      }),
      /simulated filesystem worker crash/u,
    );

    if (!retainedScope) throw new Error('Execution callback did not expose its scope');
    const expiredScope = retainedScope;
    assert.throws(
      () => inspectManagedWorkspaceExecutionScopeInternal(expiredScope),
      /execution scope has expired/u,
    );
    await owner.close();
    assert.equal(owner.state, 'closed');
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects owner close reentrancy from an active execution callback', async () => {
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
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    await owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {
      const disposition = await Promise.race([
        owner.close().then(
          () => 'closed' as const,
          (error: unknown) => error,
        ),
        delay(250, 'pending' as const),
      ]);
      assert.ok(isOwnerError('managed_workspace_owner_reentrant_close')(disposition));
    });

    assert.equal(owner.state, 'ready');
    await owner.close();
    assert.equal(owner.state, 'closed');
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('allows concurrent read-only scopes for one handle and close drains both', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseSecond!: () => void;
  const secondReleased = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let bothAdmitted!: () => void;
  const bothScopesActive = new Promise<void>((resolve) => {
    bothAdmitted = resolve;
  });
  let activeScopes = 0;
  let executions: Promise<void>[] = [];
  let closing: Promise<void> | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const execute = (released: Promise<void>) =>
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async (scope) => {
        assert.equal(inspectManagedWorkspaceExecutionScopeInternal(scope).workspaceEffect, 'none');
        activeScopes += 1;
        if (activeScopes === 2) bothAdmitted();
        await released;
        activeScopes -= 1;
      });

    executions = [execute(firstReleased), execute(secondReleased)];
    assert.equal(
      await Promise.race([bothScopesActive.then(() => 'active'), delay(20_000, 'timeout')]),
      'active',
    );
    assert.equal(activeScopes, 2);

    closing = owner.close();
    assert.equal(
      await Promise.race([closing.then(() => 'closed'), delay(250, 'pending')]),
      'pending',
    );
    releaseFirst();
    assert.equal(
      await Promise.race([closing.then(() => 'closed'), delay(250, 'pending')]),
      'pending',
    );
    releaseSecond();
    await Promise.all(executions);
    await closing;
    assert.equal(owner.state, 'closed');
  } finally {
    releaseFirst();
    releaseSecond();
    await Promise.allSettled([...executions, closing].filter((value) => value !== undefined));
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('expires the execution scope and releases owner residency when its callback rejects', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let retainedScope: ManagedWorkspaceExecutionScope | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    await assert.rejects(
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async (scope) => {
        retainedScope = scope;
        throw new Error('simulated managed tool failure');
      }),
      /simulated managed tool failure/u,
    );
    if (!retainedScope) throw new Error('Execution callback did not expose its scope');
    const expiredScope = retainedScope;
    assert.throws(
      () => inspectManagedWorkspaceExecutionScopeInternal(expiredScope),
      /execution scope has expired/u,
    );
    await owner.close();
    assert.equal(owner.state, 'closed');
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('drains an admitted workspace operation before closing and rejects new work', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let releaseOperation!: () => void;
  const operationMayFinish = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  let operationAdmitted!: () => void;
  const operationReachedFailpoint = new Promise<void>((resolve) => {
    operationAdmitted = resolve;
  });
  let creating:
    | ReturnType<
        Awaited<ReturnType<typeof openManagedWorkspaceOwner>>['openManagedWorkspaceBaseline']
      >
    | undefined;
  let closing: Promise<void> | undefined;
  let rootClosing: Promise<void> | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      failpoint: async (point) => {
        if (point !== 'after_worktree_materialized') return;
        operationAdmitted();
        await operationMayFinish;
      },
    });
    creating = owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot));
    await operationReachedFailpoint;

    let closeSettled = false;
    closing = owner.close().then(() => {
      closeSettled = true;
    });
    let rootCloseSettled = false;
    rootClosing = rootOwner.close().then(() => {
      rootCloseSettled = true;
    });
    const rootCloseDisposition = await Promise.race([
      rootClosing.then(() => 'closed' as const),
      delay(250, 'pending' as const),
    ]);

    assert.equal(owner.state, 'closing');
    assert.equal(closeSettled, false);
    assert.equal(rootCloseSettled, false);
    assert.equal(rootCloseDisposition, 'pending');
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot)),
      isOwnerError('managed_workspace_owner_closing'),
    );

    releaseOperation();
    await creating;
    await closing;
    await rootClosing;
    assert.equal(owner.state, 'closed');
  } finally {
    releaseOperation();
    await Promise.allSettled(
      [creating, closing, rootClosing].filter((value) => value !== undefined),
    );
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects external drift instead of reopening a non-ready workspace', async () => {
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
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const { binding } = inspectManagedWorkspaceExecutionHandleInternal(accepted.executionHandle);
    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'external drift\n', 'utf8');

    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot)),
      (error: unknown) =>
        error instanceof ManagedWorkspaceOwnerError &&
        error.code === 'managed_workspace_quarantined',
    );

    assert.equal(existsSync(binding.worktreePath), false);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

function isOwnerError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ManagedWorkspaceOwnerError && error.code === code;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-workspace-owner-'));
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

async function commitManagedMutationT1(
  store: ReturnType<typeof createSqliteRuntimeStore>,
  managedMutation: Readonly<RuntimeEventManagedWorkspaceMutationV1>,
  input: {
    operationId: string;
    toolCallId: string;
    toolName?: 'Write' | 'Edit';
    args:
      | { path: string; content: string }
      | { path: string; old_string: string; new_string: string };
  },
): Promise<void> {
  const identity = {
    sessionId: 'session-managed-mutation',
    invocationId: 'invocation-managed-mutation',
    runId: 'run-managed-mutation',
    turnId: 'turn-managed-mutation',
  };
  const toolName = input.toolName ?? 'Write';
  const canonicalArgsHash = canonicalToolArgsHash(toolName, input.args);
  await store.commitToolPrepared({
    operationId: input.operationId,
    journalEventId: `${input.operationId}_prepared`,
    runtimeEvent: {
      id: `${input.operationId}_call`,
      ...identity,
      ts: 10,
      partial: false,
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: input.toolCallId,
        name: toolName,
        args: input.args,
      },
      refs: { operationId: input.operationId, toolCallId: input.toolCallId },
    },
    dispatchRuntimeEvent: {
      id: `${input.operationId}_dispatch`,
      ...identity,
      ts: 10,
      partial: false,
      role: 'system',
      author: 'system',
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1',
          operationId: input.operationId,
          providerToolCallId: input.toolCallId,
          toolName,
          canonicalArgsHash,
          recoveryMode: 'reconcile',
          managedMutation,
        },
      },
      refs: { operationId: input.operationId, toolCallId: input.toolCallId },
    },
    providerToolCallId: input.toolCallId,
    toolName,
    canonicalArgsHash,
    recoveryMode: 'reconcile',
    committedAt: 10,
  });
}

function managedMutationOutcome(
  operationId: string,
  toolCallId: string,
  result: unknown,
  isError = false,
  toolName: 'Write' | 'Edit' = 'Write',
): RuntimeEvent {
  return {
    id: `${operationId}_response`,
    sessionId: 'session-managed-mutation',
    invocationId: 'invocation-managed-mutation',
    runId: 'run-managed-mutation',
    turnId: 'turn-managed-mutation',
    ts: 20,
    partial: false,
    role: 'tool',
    author: 'tool',
    origin: 'provider',
    modelVisibility: 'visible',
    content: {
      kind: 'function_response',
      id: toolCallId,
      name: toolName,
      result,
      ...(isError ? { isError: true } : {}),
    },
    refs: { operationId, toolCallId },
    actions: { stateDelta: { durationMs: 1 } },
  };
}

function gitBlobOid(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
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
    const timeout = setTimeout(() => {
      cleanupListeners();
      reject(new Error('Timed out waiting for managed mutation crash child'));
    }, timeoutMs);
    let stdout = '';
    let stderr = '';
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!stdout.includes('READY\n')) return;
      cleanupListeners();
      resolve();
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanupListeners();
      reject(
        new Error(
          `Managed mutation crash child exited before READY (${code ?? signal ?? 'unknown'}): ${stderr}`,
        ),
      );
    };
    const cleanupListeners = () => {
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
  return new Promise((resolve) => child.once('exit', () => resolve()));
}
