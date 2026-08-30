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

import {
  createManagedDependencySnapshotAuthority,
  type ManagedDependencySnapshotFailpoint,
} from '../../managed-dependency-environment.js';

const storageRoot = process.env.MAKA_DEPENDENCY_SNAPSHOT_STORAGE_ROOT;
const sourceDependencyRoot = process.env.MAKA_DEPENDENCY_SNAPSHOT_SOURCE_ROOT;
const failpoint = process.env
  .MAKA_DEPENDENCY_SNAPSHOT_CRASH_POINT as ManagedDependencySnapshotFailpoint;
if (!storageRoot || !sourceDependencyRoot || !failpoint) {
  throw new Error('Missing managed dependency snapshot crash fixture input');
}

const authority = await createManagedDependencySnapshotAuthority({
  storageRoot,
  nodeRuntime: {
    version: process.versions.node,
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  },
  failpoint(point) {
    if (point === failpoint) process.exit(79);
  },
});
await authority.acquire({
  sourceDependencyRoot,
  manifestBytes: Buffer.from('{"name":"fixture","private":true}\n'),
  lockfileBytes: Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{}}\n'),
});
throw new Error('Managed dependency snapshot crash failpoint was not reached');
