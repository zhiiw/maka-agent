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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const workflowPath = join(
  import.meta.dirname,
  '../.github/workflows/gitoxide-helper-admission.yml',
);

test('runs the packaged managed-npm contract on its minimum supported Node 22 runtime', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /node-version: ['"]?22\.22\.2['"]?/u);
  assert.doesNotMatch(workflow, /node-version: ['"]?22\.19\.0['"]?/u);
});

test('provisions each production filesystem sandbox before the managed continuation crash test', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /sudo apt-get update && sudo apt-get install -y bubblewrap/u);
  assert.match(workflow, /apparmor_restrict_unprivileged_userns/u);
  assert.match(workflow, /experiments\/windows-sandbox\/launcher[\s\S]*cargo build --locked/u);
  assert.match(workflow, /MAKA_WINDOWS_SANDBOX_PATH:/u);
});
