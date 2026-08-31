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

import { resolveCurrentProcessManagedToolchainInternal } from '../../server/current-process-managed-toolchain-internal.js';
import { verifyManagedToolchainForInvocationInternal } from '../../server/managed-toolchain-artifact-authority-internal.js';

const resourcesRoot = process.argv[2];
if (!resourcesRoot) throw new Error('resources root is required');
const invocationOwnerToken = {};
const capability = await resolveCurrentProcessManagedToolchainInternal({
  invocationOwnerToken,
  resourcesRoot,
});
const verified = await verifyManagedToolchainForInvocationInternal(
  invocationOwnerToken,
  capability,
  'hermetic_observation_v2',
);
process.stdout.write(
  `${JSON.stringify({
    nodeVersion: verified.nodeVersion,
    identityDigest: verified.identityDigest,
    entrypointName: verified.entrypointPath.split(/[\\/]/u).at(-1),
  })}\n`,
);
