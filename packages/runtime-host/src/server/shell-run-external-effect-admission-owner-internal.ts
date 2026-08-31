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

import { EXTERNAL_EFFECT_EXECUTION_PROFILE_V1_DIGEST } from '@maka/core/runtime-event';
import type {
  RuntimeExternalEffectAdmission,
  RuntimeExternalEffectExecution,
} from '@maka/runtime/tool-runtime';
import type {
  ManagedNodeTestExecutionRootOwnerInternal,
  ManagedNodeTestSourceOwnerInternal,
} from './managed-node-test-admission-owner-internal.js';
import { readManagedObservationExecutionRootInternal } from './managed-node-test-admission-owner-internal.js';

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 600_000;

interface ShellRunExternalEffectAdmissionRequestInternal {
  readonly operationId: string;
  readonly toolName: string;
  readonly persistedArgs: unknown;
  readonly abortSignal: AbortSignal;
}

export interface ShellRunExternalEffectAdmissionOwnerInternal {
  admit(
    input: ShellRunExternalEffectAdmissionRequestInternal,
  ): Promise<RuntimeExternalEffectAdmission>;
}

export function createShellRunExternalEffectAdmissionOwnerInternal(input: {
  readonly executionRootOwner: ManagedNodeTestExecutionRootOwnerInternal;
  readonly sourceOwner: ManagedNodeTestSourceOwnerInternal;
}): ShellRunExternalEffectAdmissionOwnerInternal {
  return Object.freeze({
    async admit(request: ShellRunExternalEffectAdmissionRequestInternal) {
      request.abortSignal.throwIfAborted();
      assertAdmissionRequest(request);
      const boundary = await input.sourceOwner.readAcceptedBoundary(request.abortSignal);
      request.abortSignal.throwIfAborted();
      const executionRootLease = await input.executionRootOwner.allocate();
      let admitted = false;
      try {
        const executionRoot = readManagedObservationExecutionRootInternal(executionRootLease);
        const materialized = await input.sourceOwner.materializeAcceptedTree({
          destinationPath: executionRoot.inputRoot,
          acceptedCommitOid: boundary.acceptedCommitOid,
          acceptedTreeOid: boundary.acceptedTreeOid,
          abortSignal: request.abortSignal,
        });
        if (
          materialized.acceptedCommitOid !== boundary.acceptedCommitOid ||
          materialized.acceptedTreeOid !== boundary.acceptedTreeOid
        ) {
          throw new Error('ShellRun external-effect materialization conflicts with accepted head');
        }
        request.abortSignal.throwIfAborted();
        let state: 'open' | 'running' | 'settled' | 'disposed' = 'open';
        let operation: Promise<unknown> | undefined;
        const admission: RuntimeExternalEffectAdmission = Object.freeze({
          durableDispatch: Object.freeze({
            protocol: 'external_effect_v1',
            effectClass: 'external_effect_v1',
            operationId: request.operationId,
            idempotencyKey: request.operationId,
            targetAuthority: 'shell_run_v1',
            reconciliationContract: 'shell_run_terminal_or_park_v1',
            ...boundary,
            objectFormat: 'sha1',
            executionProfileDigest: EXTERNAL_EFFECT_EXECUTION_PROFILE_V1_DIGEST,
          }),
          execute<T>(
            effect: (execution: RuntimeExternalEffectExecution) => Promise<T>,
          ): Promise<T> {
            if (state !== 'open') {
              return Promise.reject(
                new Error(
                  state === 'disposed'
                    ? 'ShellRun external-effect admission is disposed'
                    : 'ShellRun external-effect operation was already invoked',
                ),
              );
            }
            state = 'running';
            const current = effect(
              Object.freeze({
                cwd: executionRoot.inputRoot,
                scratchRoot: executionRoot.scratchRoot,
              }),
            ).finally(() => {
              if (state === 'running') state = 'settled';
            });
            operation = current;
            return current;
          },
          async dispose() {
            if (state === 'disposed') return;
            await operation?.catch(() => undefined);
            state = 'disposed';
            await input.executionRootOwner.release(executionRootLease);
          },
        });
        admitted = true;
        return admission;
      } finally {
        if (!admitted) await input.executionRootOwner.release(executionRootLease);
      }
    },
  });
}

function assertAdmissionRequest(input: {
  readonly operationId: string;
  readonly toolName: string;
  readonly persistedArgs: unknown;
}): void {
  if (!OPERATION_ID_PATTERN.test(input.operationId) || input.toolName !== 'Bash') {
    throw new Error('ShellRun external-effect operation identity is invalid');
  }
  if (!isRecord(input.persistedArgs)) {
    throw new Error('ShellRun external-effect arguments are invalid');
  }
  const keys = Object.keys(input.persistedArgs).sort();
  if (
    keys.some((key) => key !== 'command' && key !== 'timeout_ms') ||
    typeof input.persistedArgs.command !== 'string' ||
    input.persistedArgs.command.length === 0 ||
    Buffer.byteLength(input.persistedArgs.command, 'utf8') > MAX_COMMAND_BYTES ||
    (input.persistedArgs.timeout_ms !== undefined &&
      (!Number.isSafeInteger(input.persistedArgs.timeout_ms) ||
        (input.persistedArgs.timeout_ms as number) <= 0 ||
        (input.persistedArgs.timeout_ms as number) > MAX_TIMEOUT_MS))
  ) {
    throw new Error('ShellRun external-effect arguments are invalid');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
