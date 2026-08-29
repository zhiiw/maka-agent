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
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_HELPER_BYTES = 256 * 1024 * 1024;
export const GITOXIDE_HELPER_RELEASE_OPERATIONS = Object.freeze([
  'inspect_repository',
  'import_source_head',
  'create_candidate',
  'promote_candidate',
  'observe_accepted_ref',
  'read_tree_file',
  'list_tree_files',
  'grep_tree_files',
  'compare_accepted_trees',
  'materialize_accepted_tree',
]);

export async function prepareGitoxideHelper({ sourceExecutablePath, outputRoot, platform, arch }) {
  if (
    typeof sourceExecutablePath !== 'string' ||
    typeof outputRoot !== 'string' ||
    !['win32', 'darwin', 'linux'].includes(platform) ||
    typeof arch !== 'string' ||
    !/^[a-z0-9_]+$/u.test(arch)
  )
    throw new Error('Gitoxide helper preparation input is invalid');
  const sourceInfo = await lstat(sourceExecutablePath);
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    sourceInfo.size < 1 ||
    sourceInfo.size > MAX_HELPER_BYTES
  ) {
    throw new Error('Gitoxide helper build output must be a bounded regular file');
  }
  const executableName = platform === 'win32' ? 'maka-gitoxide-helper.exe' : 'maka-gitoxide-helper';
  const runtimeRoot = join(outputRoot, 'gitoxide');
  const executablePath = join(runtimeRoot, executableName);
  const manifestPath = join(outputRoot, 'gitoxide-helper.json');
  const manifestTempPath = `${manifestPath}.tmp`;
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(manifestTempPath, { force: true });
  await mkdir(runtimeRoot, { recursive: true });
  await copyFile(sourceExecutablePath, executablePath);
  if (platform !== 'win32') await chmod(executablePath, 0o755);
  const copiedInfo = await lstat(executablePath);
  if (!copiedInfo.isFile() || copiedInfo.isSymbolicLink() || copiedInfo.size !== sourceInfo.size) {
    throw new Error('Prepared Gitoxide helper does not match its build output');
  }
  const sha256 = await sha256File(executablePath);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    manifestTempPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        protocol: 'maka_gitoxide_helper_release_v1',
        provider: 'maka/gitoxide-helper',
        platform,
        arch,
        protocolVersion: 1,
        executableRelativePath: `gitoxide/${executableName}`,
        bytes: copiedInfo.size,
        sha256,
        supportedOperations: GITOXIDE_HELPER_RELEASE_OPERATIONS,
        distributionReady: true,
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  await rename(manifestTempPath, manifestPath);
  return { executablePath, manifestPath, sha256 };
}

async function sha256File(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return `sha256:${digest.digest('hex')}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const executableName =
    process.platform === 'win32' ? 'maka-gitoxide-helper.exe' : 'maka-gitoxide-helper';
  const result = await prepareGitoxideHelper({
    sourceExecutablePath: join(
      repoRoot,
      'native',
      'gitoxide-helper',
      'target',
      'release',
      executableName,
    ),
    outputRoot: join(repoRoot, 'apps', 'desktop', '.generated', 'gitoxide-helper'),
    platform: process.platform,
    arch: process.arch,
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  console.log(
    `[gitoxide-helper] prepared ${manifest.executableRelativePath} (${manifest.bytes} bytes)`,
  );
}
