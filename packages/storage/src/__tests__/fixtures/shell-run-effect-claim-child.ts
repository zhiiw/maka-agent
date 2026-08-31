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

import { existsSync, writeSync } from 'node:fs';
import type { ShellRunRecord } from '@maka/core/shell-run';
import { createSqliteShellRunStore } from '../../shell-run-store.js';

const root = requiredEnv('MAKA_SHELL_EFFECT_CLAIM_ROOT');
const startPath = requiredEnv('MAKA_SHELL_EFFECT_CLAIM_START');
const shellRunId = requiredEnv('MAKA_SHELL_EFFECT_CLAIM_ID');

writeSync(1, 'READY\n');
while (!existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

const store = createSqliteShellRunStore(root);
try {
  const claim = await store.claimShellRun(record(shellRunId));
  writeSync(
    1,
    `${JSON.stringify({ created: claim.created, shellRunId: claim.record.shellRunId })}\n`,
  );
} finally {
  store.close();
}

function record(id: string): ShellRunRecord {
  return {
    shellRunId: id,
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    sourceOperationId: 'operation-1',
    sourceRequestHash: `sha256:${'a'.repeat(64)}`,
    cwd: '/workspace',
    command: 'durable-effect',
    status: 'starting',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
