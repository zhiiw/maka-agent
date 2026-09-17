/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with this
 * work for additional information regarding copyright ownership. The ASF
 * licenses this file to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { MakaTool, ToolRuntimeInput } from '@maka/runtime/tool-runtime';
import type { RuntimeCommitSink } from '@maka/runtime/runtime-commit-sink';
import { readPage, readParameters, resolveReadInput } from '@maka/runtime/read-page';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import { createGitoxideWorkspaceBaselineOwnerInternal } from './gitoxide-workspace-baseline-owner-internal.js';
import { prepareGitoxideRuntimeMutationInternal } from './gitoxide-runtime-mutation-internal.js';
import { readGitoxideTreeFileInternal } from './gitoxide-repository-admission-authority-internal.js';

export interface GitoxideManagedSessionCapability {
  readonly kind: 'gitoxide_managed_files_session';
}

type ReopenInput = Parameters<
  ReturnType<typeof createGitoxideWorkspaceBaselineOwnerInternal>['reopen']
>[0];
type Prepare = NonNullable<ToolRuntimeInput['prepareManagedMutation']>;
interface SessionExecution {
  readonly projectTools: (tools: readonly MakaTool[]) => readonly MakaTool[];
  readonly sessionId: string;
  readonly runtimeCommitSink: RuntimeCommitSink;
  readonly prepareManagedMutation: Prepare;
  readonly readAcceptedFile: (
    path: string,
    abortSignal?: AbortSignal,
  ) => ReturnType<typeof readGitoxideTreeFileInternal>;
}
const sessions = new WeakMap<GitoxideManagedSessionCapability, SessionExecution>();

/** Publish a Session only after its session-keyed accepted workspace is verifiable. */
export async function createGitoxideManagedSessionInternal(
  stores: InteractiveExecutionStoresWriter,
  input: Omit<ReopenInput, 'acceptedRepositoryOwnerToken' | 'workspaceKey'> & {
    readonly sessionId: string;
    readonly sourcePath: string;
    readonly connectionId: string;
    readonly connectionSlug: string;
    readonly model: string;
    readonly name: string;
  },
): Promise<{ readonly created: boolean; readonly capability: GitoxideManagedSessionCapability }> {
  input = { ...input };
  for (const value of [
    input.sessionId,
    input.sourcePath,
    input.repositoryPath,
    input.connectionId,
    input.connectionSlug,
    input.model,
    input.name,
  ]) {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.includes('\0') ||
      Buffer.byteLength(value) > 4096
    )
      throw new Error('Invalid managed session creation input');
  }
  if (!isAbsolute(input.sourcePath) || !isAbsolute(input.repositoryPath))
    throw new Error('Managed session paths must be absolute');
  input.abortSignal?.throwIfAborted();
  const createInput = Object.freeze({
    cwd: input.sourcePath,
    name: input.name,
    llmConnectionId: input.connectionId,
    llmConnectionSlug: input.connectionSlug,
    model: input.model,
    toolProfile: 'managed-files-v1' as const,
    toolMode: 'direct' as const,
    permissionMode: 'ask' as const,
    collaborationMode: 'agent' as const,
    orchestrationMode: 'default' as const,
  });
  const requestFingerprint = `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        'maka-managed-session-create-v1',
        input.sessionId,
        input.repositoryPath,
        createInput,
      ]),
    )
    .digest('hex')}`;
  const probe = await stores.sessionStore.probeStableSessionCreate(
    input.sessionId,
    requestFingerprint,
  );
  if (probe.kind === 'conflict') throw new Error('Managed session creation conflict');
  // Never create a visible Session before the accepted epoch and object graph exist.
  const capability = await openGitoxideManagedSessionInternal(stores, {
    sessionId: input.sessionId,
    workspaceKey: input.sessionId,
    repositoryPath: input.repositoryPath,
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    abortSignal: input.abortSignal,
  });
  input.abortSignal?.throwIfAborted();
  const result = await stores.sessionStore.createStableSession({
    sessionId: input.sessionId,
    requestFingerprint,
    input: createInput,
  });
  if (result.kind === 'conflict') throw new Error('Managed session creation conflict');
  if (
    result.record.header.toolProfile !== 'managed-files-v1' ||
    result.record.header.cwd !== input.sourcePath
  )
    throw new Error('Managed session persisted identity mismatch');
  return Object.freeze({ created: result.kind === 'created', capability });
}

/** Bind a verified existing epoch, never implicitly import a checkout or change mode. */
export async function openGitoxideManagedSessionInternal(
  stores: InteractiveExecutionStoresWriter,
  input: Omit<ReopenInput, 'acceptedRepositoryOwnerToken'> & { readonly sessionId: string },
): Promise<GitoxideManagedSessionCapability> {
  input = { ...input };
  if (!input.sessionId.trim() || Buffer.byteLength(input.sessionId) > 1024)
    throw new Error('Invalid managed session identity');
  const owner = createGitoxideWorkspaceBaselineOwnerInternal(stores);
  const acceptedRepositoryOwnerToken = {};
  // Do not retain the opening caller's signal for later turns.
  const { abortSignal, sessionId, ...binding } = input;
  const reopen = (signal?: AbortSignal) =>
    owner.reopen({
      ...binding,
      acceptedRepositoryOwnerToken,
      abortSignal: signal,
    });
  await reopen(abortSignal);
  const readAcceptedFile: SessionExecution['readAcceptedFile'] = async (path, signal) => {
    const acceptedRepositoryCapability = await reopen(signal);
    return readGitoxideTreeFileInternal({
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability,
      path,
      abortSignal: signal,
    });
  };
  const readTool: MakaTool = Object.freeze({
    name: 'Read',
    activityKind: 'read',
    categoryHint: 'read',
    recoveryMode: 'replay_safe',
    description:
      'Read a bounded text page from the current accepted Git tree. Use a canonical repository-relative path, or the complete next object from the previous page. Does not read the user checkout, images, or runtime resources.',
    parameters: readParameters,
    async impl(input, context) {
      if (context.sessionId !== sessionId)
        throw new Error('Managed read does not belong to this session');
      const args = readParameters.parse(input);
      const { path } = resolveReadInput(args);
      const file = await readAcceptedFile(path, context.abortSignal);
      return readPage(file.content, args);
    },
  } satisfies MakaTool);
  const capability = Object.freeze({ kind: 'gitoxide_managed_files_session' as const });
  sessions.set(
    capability,
    Object.freeze({
      projectTools: (tools: readonly MakaTool[]) =>
        tools
          .filter((tool) => ['Read', 'Write', 'Edit'].includes(tool.name))
          .map((tool) => (tool.name === 'Read' ? readTool : tool)),
      sessionId,
      runtimeCommitSink: stores.runtimeEventStore,
      async prepareManagedMutation(request) {
        if (request.sessionId !== sessionId)
          throw new Error('Managed mutation does not belong to this session');
        // Snapshot before reopen, which may repair the accepted-ref projection.
        const { toolName, abortSignal } = request;
        const args = structuredClone(request.args);
        const acceptedRepositoryCapability = await reopen(abortSignal);
        const prepared = await prepareGitoxideRuntimeMutationInternal(stores, {
          workspaceKey: binding.workspaceKey,
          acceptedRepositoryOwnerToken,
          acceptedRepositoryCapability,
          toolName,
          args,
          abortSignal,
        });
        return Object.freeze({
          ...prepared,
          commitOutcome(outcome, result) {
            if (outcome.runtimeEvent.sessionId !== sessionId)
              return Promise.reject(new Error('Managed outcome does not belong to this session'));
            return prepared.commitOutcome(outcome, result);
          },
        } satisfies Awaited<ReturnType<Prepare>>);
      },
      readAcceptedFile,
    } satisfies SessionExecution),
  );
  return capability;
}

/** Host backend composition must bind both the session and the exact ledger group. */
export function requireGitoxideManagedSessionInternal(
  capability: GitoxideManagedSessionCapability,
  sessionId: string,
  runtimeCommitSink: RuntimeCommitSink | undefined,
): SessionExecution {
  const record = sessions.get(capability);
  if (!record || record.sessionId !== sessionId || record.runtimeCommitSink !== runtimeCommitSink)
    throw new Error('Managed session does not match backend identity and execution stores');
  return record;
}
