import { DurableToolExecutionUnsettledError } from './durable-tool-execution.js';
import {
  FilesystemWorkerClientError,
  type FilesystemWorkerClient,
  type FilesystemWorkerExecuteInput,
} from './filesystem-worker/client.js';
import type {
  PrepareFileMutationInput,
  PreparedFileMutationCarrier,
  PreparedFileMutationExecutionContext,
} from './local-file-checkpoint-carrier.js';
import type { CurrentFileCheckpointState } from './prepared-file-mutation.js';
import type { PreparedFileMutationFact } from './tool-recovery-facts.js';

/**
 * Host-side checkpoint preparation/observation with worker-owned mutation.
 * There is deliberately no host-local apply fallback once a worker is wired.
 */
export class WorkerBackedFileCheckpointCarrier implements PreparedFileMutationCarrier {
  constructor(
    private readonly local: PreparedFileMutationCarrier,
    private readonly worker: Pick<FilesystemWorkerClient, 'execute'>,
  ) {}

  async supports(workspaceRoot: string, targetPath: string): Promise<boolean> {
    return (await this.local.supports?.(workspaceRoot, targetPath)) ?? true;
  }

  async prepare(input: PrepareFileMutationInput): Promise<PreparedFileMutationFact> {
    return await this.local.prepare(input);
  }

  async inspect(fact: PreparedFileMutationFact): Promise<CurrentFileCheckpointState> {
    return await this.local.inspect(fact);
  }

  async readCurrentContent(fact: PreparedFileMutationFact): Promise<Uint8Array | undefined> {
    return await this.local.readCurrentContent(fact);
  }

  async apply(
    fact: PreparedFileMutationFact,
    expectedContent: Uint8Array,
    context?: PreparedFileMutationExecutionContext,
  ): Promise<void> {
    await applyPreparedFileThroughWorker(this.worker, fact, expectedContent, context);
  }
}

export async function applyPreparedFileThroughWorker(
  worker: Pick<FilesystemWorkerClient, 'execute'>,
  fact: PreparedFileMutationFact,
  expectedContent: Uint8Array,
  context?: PreparedFileMutationExecutionContext,
): Promise<void> {
  const input: FilesystemWorkerExecuteInput = {
    operation: {
      kind: 'prepared_file_apply',
      path: fact.canonicalPath,
      fact,
      expectedContentBase64: Buffer.from(expectedContent).toString('base64'),
    },
    cwd: context?.cwd ?? fact.workspaceRoot,
    mode: context?.mode ?? 'ask',
    ...(context?.permissionProfile ? { permissionProfile: context.permissionProfile } : {}),
    ...(context?.additionalGrant ? { additionalGrant: context.additionalGrant } : {}),
    ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
  };
  try {
    await worker.execute(input);
  } catch (error) {
    if (
      error instanceof FilesystemWorkerClientError &&
      [
        'effect_unsettled',
        'timeout',
        'aborted',
        'response_overflow',
        'worker_crashed',
        'invalid_response',
        'response_id_mismatch',
        'response_kind_mismatch',
      ].includes(error.reason)
    ) {
      throw new DurableToolExecutionUnsettledError('effect_may_have_started', error);
    }
    throw error;
  }
}
