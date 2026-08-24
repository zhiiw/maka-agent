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

export const MANAGED_NPM_PACKAGE_MANAGER_VERSION = '12.0.2';

export function isManagedNpmNodeVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major === 26) return true;
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  return false;
}

export interface ManagedNpmRuntimeCapability {
  readonly npmVersion: typeof MANAGED_NPM_PACKAGE_MANAGER_VERSION;
  readonly nodeVersion: string;
  readonly nodeAbi: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Canonical root whose release owner supplied the attested runtime. */
  readonly resourcesRoot: string;
  readonly nodeExecutablePath: string;
  readonly npmRuntimeRoot: string;
  readonly npmCliPath: string;
  readonly runtimeIdentitySha256: `sha256:${string}`;
}
