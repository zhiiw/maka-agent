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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '../execution-stores.js';
import {
  issueExecutionStoresWorkspaceBaselineAuthorityInternal,
  issueExecutionStoresWorkspaceMutationAuthorityInternal,
  requireExecutionStoresWorkspaceBaselineAuthorityInternal,
  requireExecutionStoresWorkspaceMutationAuthorityInternal,
} from '../execution-stores-workspace-authority-internal.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';

test('binds each workspace mutation verifier to its execution-stores owner capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-execution-workspace-authority-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  if (!rootOwner) return;
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  try {
    const ownerToken = {};
    const authorityCapability = issueExecutionStoresWorkspaceMutationAuthorityInternal({
      ownerToken,
      stores,
      verifyCandidate: () => {
        throw new Error('not used');
      },
    });
    const secondOwnerToken = {};
    const secondAuthorityCapability = issueExecutionStoresWorkspaceMutationAuthorityInternal({
      ownerToken: secondOwnerToken,
      stores,
      verifyCandidate: () => {
        throw new Error('not used');
      },
    });
    assert.ok(
      requireExecutionStoresWorkspaceMutationAuthorityInternal(
        secondOwnerToken,
        secondAuthorityCapability,
      ),
    );
    assert.throws(
      () => requireExecutionStoresWorkspaceMutationAuthorityInternal({}, authorityCapability),
      /capability is invalid/i,
    );
    const authority = requireExecutionStoresWorkspaceMutationAuthorityInternal(
      ownerToken,
      authorityCapability,
    );
    assert.equal(
      await authority.readEpoch(
        'workspace_'.concat('1'.repeat(32)),
        'epoch_'.concat('2'.repeat(32)),
      ),
      undefined,
    );
    assert.equal(await authority.readMutationEvidence('operation-missing'), undefined);
    assert.equal(
      await authority.readHead(
        'workspace_'.concat('1'.repeat(32)),
        'epoch_'.concat('2'.repeat(32)),
      ),
      undefined,
    );
  } finally {
    await stores.sessionStore.close?.();
    await rootOwner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps baseline descriptors behind an owner-bound imported-repository proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-execution-workspace-baseline-authority-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  if (!rootOwner) return;
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  try {
    const ownerToken = {};
    const baselineCapability = issueExecutionStoresWorkspaceBaselineAuthorityInternal({
      ownerToken,
      stores,
      verifyBaseline: () => {
        throw new Error('unknown imported repository proof');
      },
    });
    assert.throws(
      () => requireExecutionStoresWorkspaceBaselineAuthorityInternal({}, baselineCapability),
      /capability is invalid/i,
    );
    const authority = requireExecutionStoresWorkspaceBaselineAuthorityInternal(
      ownerToken,
      baselineCapability,
    );
    await assert.rejects(authority.commitBaseline({}), /unknown imported repository proof/i);
  } finally {
    await stores.sessionStore.close?.();
    await rootOwner.close();
    await rm(root, { recursive: true, force: true });
  }
});
