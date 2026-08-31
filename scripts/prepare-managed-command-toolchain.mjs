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

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_ENTRYPOINT_BYTES = 4 * 1024 * 1024;
const ENTRYPOINT_RELATIVE_PATH = 'managed-command/managed-command-helper-main.js';

export async function prepareManagedCommandToolchain({
  sourceEntrypointPath,
  outputRoot,
  platform,
  arch,
  nodeVersion,
}) {
  if (
    typeof sourceEntrypointPath !== 'string' ||
    typeof outputRoot !== 'string' ||
    !['win32', 'darwin', 'linux'].includes(platform) ||
    typeof arch !== 'string' ||
    !/^[a-z0-9_]+$/u.test(arch) ||
    typeof nodeVersion !== 'string' ||
    !/^24\.[0-9]+\.[0-9]+$/u.test(nodeVersion)
  ) {
    throw new Error('Managed command toolchain preparation input is invalid');
  }
  const sourceInfo = await lstat(sourceEntrypointPath);
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    sourceInfo.size < 1 ||
    sourceInfo.size > MAX_ENTRYPOINT_BYTES
  ) {
    throw new Error('Managed command entrypoint must be a bounded regular file');
  }

  const runtimeRoot = join(outputRoot, 'managed-command');
  const entrypointPath = join(runtimeRoot, 'managed-command-helper-main.js');
  const manifestPath = join(outputRoot, 'managed-command-toolchain.json');
  const manifestTempPath = `${manifestPath}.tmp`;
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(manifestTempPath, { force: true });
  await mkdir(runtimeRoot, { recursive: true });
  await copyFile(sourceEntrypointPath, entrypointPath);
  const copiedInfo = await lstat(entrypointPath);
  if (!copiedInfo.isFile() || copiedInfo.isSymbolicLink() || copiedInfo.size !== sourceInfo.size) {
    throw new Error('Prepared managed command entrypoint does not match its build output');
  }
  const entrypointSha256 = await sha256File(entrypointPath);
  await writeFile(
    manifestTempPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        protocol: 'maka_managed_command_toolchain_release_v2',
        provider: 'maka/managed-command-toolchain',
        platform,
        arch,
        nodeVersion,
        profileVersion: 1,
        entrypointRelativePath: ENTRYPOINT_RELATIVE_PATH,
        entrypointBytes: copiedInfo.size,
        entrypointSha256,
        allowedEffectClasses: ['hermetic_observation_v2', 'workspace_transform_v1'],
        distributionReady: true,
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  await rename(manifestTempPath, manifestPath);
  return { entrypointPath, manifestPath, entrypointSha256 };
}

async function sha256File(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return `sha256:${digest.digest('hex')}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const result = await prepareManagedCommandToolchain({
    sourceEntrypointPath: join(
      repoRoot,
      'packages',
      'runtime-host',
      'dist',
      'server',
      'managed-command-helper-main.js',
    ),
    outputRoot: join(repoRoot, 'apps', 'desktop', '.generated', 'managed-command-toolchain'),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: rootManifest.releaseToolchain?.node,
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  console.log(
    `[managed-command-toolchain] prepared ${manifest.entrypointRelativePath} (${manifest.entrypointBytes} bytes)`,
  );
}
