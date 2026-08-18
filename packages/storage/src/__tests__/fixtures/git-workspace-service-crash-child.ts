import { writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createGitWorkspaceService } from '../../git-workspace-service.js';
import { requireManagedBaselineReceiptAuthorityInternal } from '../../managed-baseline-receipt-authority-internal.js';
import { requireManagedMutationCandidateAuthorityInternal } from '../../managed-mutation-candidate-authority-internal.js';
import { openManagedWorkspaceOwner } from '../../managed-workspace-owner.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../../root-authority.js';
import { createSqliteRuntimeStore } from '../../sqlite-runtime-store.js';

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

if (process.env.MAKA_GIT_WORKSPACE_ACTION === 'mutation-admission') {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  if (!rootOwner) throw new Error('Unable to acquire mutation-admission crash-child root owner');
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const owner = await openManagedWorkspaceOwner({ rootOwner, gitRuntime });
  const accepted = await owner.openManagedWorkspaceBaseline(runtimeStore, request);
  await owner.admitManagedWorkspaceMutation(accepted.executionHandle, {
    operationId: 'operation-real-process-admission',
    expectedPaths: ['tracked.txt'],
    executionProfileDigest: `sha256:${'e'.repeat(64)}`,
  });
  writeSync(1, 'READY\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Managed mutation admission crash child unexpectedly resumed');
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
