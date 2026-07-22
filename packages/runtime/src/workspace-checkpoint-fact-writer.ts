import {
  RUNTIME_FACT_WRITE_CAPABILITY_V1,
  type RuntimeEvent,
  type RuntimeEventStore,
} from '@maka/core';
import {
  parseWorkspaceRuntimeFact,
  WORKSPACE_CHECKPOINT_FACT_KIND,
  WORKSPACE_RUNTIME_FACT_VERSION,
  WORKSPACE_TRANSITION_FACT_KIND,
  type WorkspaceCheckpointFact,
  type WorkspaceTransitionFact,
} from './workspace-checkpoint.js';

interface WorkspaceFactWriterIdentity {
  runtimeEventStore: RuntimeEventStore;
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  eventId: string;
  ts: number;
}

export interface CommitWorkspaceCheckpointFactInput extends WorkspaceFactWriterIdentity {
  fact: WorkspaceCheckpointFact;
}

export interface CommitWorkspaceTransitionFactInput extends WorkspaceFactWriterIdentity {
  fact: WorkspaceTransitionFact;
}

export async function commitWorkspaceCheckpointFact(
  input: CommitWorkspaceCheckpointFactInput,
): Promise<RuntimeEvent> {
  return commitWorkspaceFact(input, WORKSPACE_CHECKPOINT_FACT_KIND, 'checkpoint');
}

export async function commitWorkspaceTransitionFact(
  input: CommitWorkspaceTransitionFactInput,
): Promise<RuntimeEvent> {
  return commitWorkspaceFact(input, WORKSPACE_TRANSITION_FACT_KIND, 'transition');
}

async function commitWorkspaceFact(
  input: CommitWorkspaceCheckpointFactInput | CommitWorkspaceTransitionFactInput,
  kind: typeof WORKSPACE_CHECKPOINT_FACT_KIND | typeof WORKSPACE_TRANSITION_FACT_KIND,
  expectedStatus: 'checkpoint' | 'transition',
): Promise<RuntimeEvent> {
  if (input.runtimeEventStore.runtimeFactWriteCapability !== RUNTIME_FACT_WRITE_CAPABILITY_V1) {
    throw new Error('Runtime fact writer capability is unavailable for workspace facts');
  }
  const runtimeFact = {
    kind,
    version: WORKSPACE_RUNTIME_FACT_VERSION,
    legacyProjection: 'invisible' as const,
    payload: input.fact,
  };
  if (parseWorkspaceRuntimeFact(runtimeFact).status !== expectedStatus) {
    throw new Error('Invalid canonical workspace fact');
  }
  const event: RuntimeEvent = {
    id: input.eventId,
    sessionId: input.sessionId,
    invocationId: input.invocationId,
    runId: input.runId,
    turnId: input.turnId,
    ts: input.ts,
    partial: false,
    role: 'system',
    author: 'system',
    actions: { runtimeFact },
  };
  await input.runtimeEventStore.appendRuntimeEvent(input.sessionId, input.runId, event, {
    durable: true,
  });
  return event;
}
