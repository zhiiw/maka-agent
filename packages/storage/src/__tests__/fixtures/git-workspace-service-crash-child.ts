import { writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createGitWorkspaceService } from '../../git-workspace-service.js';
import { requireManagedBaselineReceiptAuthorityInternal } from '../../managed-baseline-receipt-authority-internal.js';
import { requireManagedMutationCandidateAuthorityInternal } from '../../managed-mutation-candidate-authority-internal.js';
import { openManagedWorkspaceOwner } from '../../managed-workspace-owner.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../../root-authority.js';
import { createSqliteRuntimeStore } from '../../sqlite-runtime-store.js';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import type { RuntimeEventManagedWorkspaceMutationV1 } from '@maka/core/runtime-event';

const storageRoot = requiredEnv('MAKA_GIT_WORKSPACE_STORAGE');
const gitRuntime = {
  executablePath: requiredEnv('MAKA_GIT_WORKSPACE_EXECUTABLE'),
  expectedSha256: requiredEnv('MAKA_GIT_WORKSPACE_SHA256') as `sha256:${string}`,
};
const failpoint = (point: string) => {
  if (point !== requiredEnv('MAKA_GIT_WORKSPACE_FAILPOINT')) return;
  writeSync(1, 'READY\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const request = {
  repositoryId: 'repository_11111111111111111111111111111111',
  workspaceId: 'workspace_22222222222222222222222222222222',
  workspaceEpochId: 'epoch_33333333333333333333333333333333',
  workspaceInstanceId: 'instance_44444444444444444444444444444444',
  sourceRoot: requiredEnv('MAKA_GIT_WORKSPACE_SOURCE'),
} as const;

if (process.env.MAKA_GIT_WORKSPACE_ACTION === 'baseline-receipt') {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  if (!rootOwner) throw new Error('Unable to acquire crash-child root owner');
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const owner = await openManagedWorkspaceOwner({ rootOwner, gitRuntime, failpoint });
  await owner.openManagedWorkspaceBaseline(runtimeStore, request);
  throw new Error('Managed baseline crash child missed its failpoint');
}

if (process.env.MAKA_GIT_WORKSPACE_ACTION === 'execution-admission') {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  if (!rootOwner) throw new Error('Unable to acquire crash-child root owner');
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const owner = await openManagedWorkspaceOwner({ rootOwner, gitRuntime, failpoint });
  const accepted = await owner.openManagedWorkspaceBaseline(runtimeStore, request);
  await owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => undefined);
  throw new Error('Managed execution admission crash child missed its failpoint');
}

if (process.env.MAKA_GIT_WORKSPACE_ACTION === 'managed-mutation-owner') {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  if (!rootOwner) throw new Error('Unable to acquire crash-child root owner');
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const owner = await openManagedWorkspaceOwner({
    rootOwner,
    gitRuntime,
    failpoint,
    filesystemWorker: {
      mutationExecutionProfileDigest: `sha256:${'a'.repeat(64)}`,
      async execute(input) {
        if (input.operation.kind !== 'write') throw new Error('Expected managed Write');
        const path = join(input.cwd, input.operation.path);
        writeFileSync(path, input.operation.content, 'utf8');
        return {
          kind: 'write' as const,
          ok: true as const,
          path,
          bytes: Buffer.byteLength(input.operation.content, 'utf8'),
        };
      },
    },
  });
  const accepted = await owner.openManagedWorkspaceBaseline(runtimeStore, request);
  const operationId = 'operation-real-process-managed-write';
  const toolCallId = 'call-real-process-managed-write';
  const args = { path: 'tracked.txt', content: 'accepted before process crash\n' };
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
  await admission.execute(async () => {
    const result = await owner.executeManagedMutationFilesystemOperation({
      kind: 'write',
      path: args.path,
      content: args.content,
    });
    if (result.kind !== 'write') throw new Error('Expected managed Write result');
    const content = {
      kind: 'file_write' as const,
      path: result.path,
      bytes: result.bytes,
    };
    return {
      content,
      isError: false,
      durationMs: 1,
      durableOutcome: {
        id: `${operationId}_response`,
        sessionId: 'session-real-process-managed-write',
        invocationId: 'invocation-real-process-managed-write',
        runId: 'run-real-process-managed-write',
        turnId: 'turn-real-process-managed-write',
        ts: 20,
        partial: false,
        role: 'tool' as const,
        author: 'tool' as const,
        origin: 'provider' as const,
        modelVisibility: 'visible' as const,
        content: {
          kind: 'function_response' as const,
          id: toolCallId,
          name: 'Write',
          result: content,
        },
        refs: { operationId, toolCallId },
        actions: { stateDelta: { durationMs: 1 } },
      },
    };
  });
  throw new Error('Managed mutation owner crash child missed its failpoint');
}

const service = createGitWorkspaceService({
  storageRoot,
  gitRuntime,
  failpoint,
});

const binding = await service.createManagedWorkspaceFromSource(request);

if (
  process.env.MAKA_GIT_WORKSPACE_ACTION === 'mutation-capture' ||
  process.env.MAKA_GIT_WORKSPACE_ACTION === 'mutation-discard'
) {
  const baseline = await requireManagedBaselineReceiptAuthorityInternal(service).issue(binding);
  const candidateRequest = {
    binding,
    operationId: 'operation-real-process-candidate',
    baseHead: {
      repositoryId: binding.repositoryId,
      workspaceId: binding.workspaceId,
      workspaceEpochId: binding.workspaceEpochId,
      workspaceVersionId: baseline.workspaceVersionId,
      acceptedEventId: baseline.baselineAcceptedEventId,
      commitOid: binding.baselineCommitOid,
      treeOid: binding.baselineTreeOid,
      revision: 1,
    },
    expectedPaths: ['docs/a.md'],
    executionProfileDigest: `sha256:${'e'.repeat(64)}` as const,
  };
  writeFileSync(join(binding.worktreePath, 'docs', 'a.md'), 'candidate from child\n', 'utf8');
  const outputPath = requiredEnv('MAKA_GIT_WORKSPACE_MUTATION_OUTPUT');
  if (process.env.MAKA_GIT_WORKSPACE_ACTION === 'mutation-capture') {
    writeFileSync(outputPath, `${JSON.stringify({ candidateRequest })}\n`, 'utf8');
    await requireManagedMutationCandidateAuthorityInternal(service).capture(candidateRequest);
  } else {
    const receipt =
      await requireManagedMutationCandidateAuthorityInternal(service).capture(candidateRequest);
    writeFileSync(outputPath, `${JSON.stringify({ binding, receipt })}\n`, 'utf8');
    await requireManagedMutationCandidateAuthorityInternal(service).discard(receipt);
  }
  throw new Error('Managed mutation crash child missed its failpoint');
}

if (process.env.MAKA_GIT_WORKSPACE_ACTION === 'quarantine') {
  writeFileSync(
    requiredEnv('MAKA_GIT_WORKSPACE_BINDING_OUTPUT'),
    `${JSON.stringify(binding)}\n`,
    'utf8',
  );
  await service.quarantineManagedWorkspace(binding, 'crash_convergence_test');
}

throw new Error('Git workspace crash child missed its failpoint');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function commitManagedMutationT1(
  store: ReturnType<typeof createSqliteRuntimeStore>,
  managedMutation: Readonly<RuntimeEventManagedWorkspaceMutationV1>,
  input: {
    operationId: string;
    toolCallId: string;
    args: { path: string; content: string };
  },
): Promise<void> {
  const identity = {
    sessionId: 'session-real-process-managed-write',
    invocationId: 'invocation-real-process-managed-write',
    runId: 'run-real-process-managed-write',
    turnId: 'turn-real-process-managed-write',
  };
  const canonicalArgsHash = canonicalToolArgsHash('Write', input.args);
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
        name: 'Write',
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
          toolName: 'Write',
          canonicalArgsHash,
          recoveryMode: 'reconcile',
          managedMutation,
        },
      },
      refs: { operationId: input.operationId, toolCallId: input.toolCallId },
    },
    providerToolCallId: input.toolCallId,
    toolName: 'Write',
    canonicalArgsHash,
    recoveryMode: 'reconcile',
    committedAt: 10,
  });
}
