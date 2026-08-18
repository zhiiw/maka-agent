import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createExecutionRuntimeHostComposition } from '../../server/execution-composition.js';

const [rootPath, expectedRootId, gitExecutablePath, gitDigest, sessionId, turnId] =
  process.argv.slice(2);
if (
  !rootPath ||
  !expectedRootId ||
  !gitExecutablePath ||
  !gitDigest?.startsWith('sha256:') ||
  !sessionId ||
  !turnId
) {
  throw new Error(
    'usage: managed-workspace-write-edit-host-crash <root> <root-id> <git> <digest> <session> <turn>',
  );
}

// Resolve the root before candidate startup so this fixture proves it is using
// the same durable owner identity that the parent prepared.
const capability = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
if (capability.rootId !== expectedRootId) {
  throw new Error('Managed mutation crash fixture resolved a different storage root');
}
const owner = await tryAcquireInteractiveRootOwner(capability);
if (!owner) throw new Error('Managed mutation crash fixture cannot own the root');
const hostEpoch = 'managed-write-crash-host';
const composition = await createExecutionRuntimeHostComposition(
  {
    owner,
    hostEpoch,
    acquireResidency: () => ({ release() {} }),
    retainUntilProcessExit: () => undefined,
    requestDrain: () => undefined,
  },
  {
    managedWorkspaceGitRuntime: {
      executablePath: gitExecutablePath,
      expectedSha256: gitDigest as `sha256:${string}`,
    },
  },
  {
    managedWorkspaceOwnerFailpoint(point) {
      if (point === 'after_managed_successor_commit') process.exit(73);
    },
  },
);

const context = {
  hostEpoch,
  connectionId: 'managed-write-crash-client',
  surface: 'tui' as const,
  principal: 'local_os_user' as const,
  acquireResidency: () => ({ release() {} }),
};

await composition.recover();
process.send?.({ type: 'ready' });
const started = await composition.handlers['turn.start'](
  {
    sessionId,
    turnId,
    content: { text: 'Write the requested managed workspace file.' },
  },
  context,
);
if (!started.ok || started.result.kind !== 'started') {
  throw new Error(`Managed mutation crash fixture could not start: ${JSON.stringify(started)}`);
}

// The owner failpoint exits after the SQLite successor/T2 transaction and
// before the Git projection is accepted. Reaching this wait means the intended
// production boundary was not crossed.
await new Promise<never>(() => undefined);
