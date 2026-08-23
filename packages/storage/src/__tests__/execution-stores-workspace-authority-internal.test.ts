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
import { after, test } from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '../execution-stores.js';
import { requireExecutionStoresWorkspaceMutationAuthorityInternal } from '../execution-stores-workspace-authority-internal.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);

test('binds the private workspace mutation authority to authentic execution stores', async () => {
  assert.throws(
    () => requireExecutionStoresWorkspaceMutationAuthorityInternal({}),
    /workspace mutation authority is unavailable/u,
  );
  const base = await mkdtemp(join(tmpdir(), 'maka-execution-workspace-authority-'));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: join(base, 'interactive'), kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    const authority = requireExecutionStoresWorkspaceMutationAuthorityInternal(stores);
    assert.equal(await authority.readHead('workspace-missing', 'epoch-missing'), undefined);
    assert.equal(await authority.readVersion('version-missing'), undefined);
    authority.adoptRootForManagedExecution();
    const accepted = await authority.commitBaseline({
      epochOpenedEventId: 'gitoxide-epoch-opened-1',
      baselineAcceptedEventId: 'gitoxide-baseline-accepted-1',
      committedAt: 0,
      epoch: {
        repositoryId: 'repository_11111111111111111111111111111111',
        workspaceId: 'workspace_22222222222222222222222222222222',
        workspaceEpochId: 'epoch_33333333333333333333333333333333',
        workspaceInstanceId: 'instance_44444444444444444444444444444444',
        mode: 'managed_worktree',
        objectFormat: 'sha1',
        sourceCommitOid: '1'.repeat(40),
        sourceTreeOid: '2'.repeat(40),
        materializationProfileDigest: `sha256:${'3'.repeat(64)}`,
        materializationSemantics: 'git_tree_materialized_with_fixed_config_v1',
        policyHash: `sha256:${'4'.repeat(64)}`,
      },
      baseline: {
        workspaceVersionId: 'version_55555555555555555555555555555555',
        commitOid: '5'.repeat(40),
        treeOid: '2'.repeat(40),
        treeDeltaDigest: `sha256:${'6'.repeat(64)}`,
        changedFileCount: 1,
        deletedFileCount: 0,
      },
    });
    assert.equal(accepted.created, true);
    assert.equal(
      (await authority.readHead(accepted.head.workspaceId, accepted.head.workspaceEpochId))
        ?.workspaceVersionId,
      accepted.head.workspaceVersionId,
    );
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});
