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
import { writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_OBSERVED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TEST_FILES = 64;
const PORTABLE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

if (process.argv[2] === 'maka-node-tests-v1') {
  const { dependencyRoot, relativePaths } = decodeNodeTestInvocation(process.argv.slice(3));
  if (dependencyRoot) registerDependencyResolution(dependencyRoot);
  for (const relativePath of relativePaths) {
    await import(pathToFileURL(join(process.cwd(), ...relativePath.split('/'))).href);
  }
} else if (process.argv[2] === 'maka-observe-file-v1') {
  const relativePath = decodeObservationPaths(process.argv.slice(3), 1)[0];
  if (!relativePath) throw new Error('Managed command observation path is missing');
  const observation = await observeFile(relativePath);
  writeJsonResponseAndExit({
    protocolVersion: 1,
    kind: 'file_observation',
    nodeVersion: process.versions.node,
    ...observation,
  });
} else if (process.argv[2] === 'maka-observe-files-v1') {
  const relativePaths = decodeObservationPaths(process.argv.slice(3), MAX_TEST_FILES);
  const files = await Promise.all(relativePaths.map(observeFile));
  writeJsonResponseAndExit({
    protocolVersion: 1,
    kind: 'file_observations',
    nodeVersion: process.versions.node,
    files,
  });
} else {
  throw new Error('Managed command helper invocation is invalid');
}

function decodeNodeTestInvocation(values: readonly string[]): {
  readonly dependencyRoot?: string;
  readonly relativePaths: readonly string[];
} {
  const separator = values.indexOf('--');
  const dependencyArgs = separator === -1 ? [] : values.slice(0, separator);
  const relativePaths = separator === -1 ? values : values.slice(separator + 1);
  const dependencyRoot =
    dependencyArgs.length === 0
      ? undefined
      : dependencyArgs.length === 2 && dependencyArgs[0] === '--dependency-root'
        ? dependencyArgs[1]
        : null;
  if (
    dependencyRoot === null ||
    (dependencyRoot !== undefined &&
      (!isAbsolute(dependencyRoot) ||
        dependencyRoot.includes('\0') ||
        Buffer.byteLength(dependencyRoot, 'utf8') > 4096)) ||
    relativePaths.length === 0 ||
    relativePaths.length > MAX_TEST_FILES ||
    !relativePaths.every(
      (path) => isPortableRelativePath(path) && /\.(?:cjs|mjs|js)$/u.test(path),
    ) ||
    new Set(relativePaths).size !== relativePaths.length ||
    [...relativePaths].sort().some((path, index) => path !== relativePaths[index])
  ) {
    throw new Error('Managed Node test invocation is invalid');
  }
  return dependencyRoot === undefined
    ? { relativePaths }
    : { dependencyRoot, relativePaths };
}

function decodeObservationPaths(
  values: readonly string[],
  maximumPaths: number,
): readonly string[] {
  if (
    values.length === 0 ||
    values.length > maximumPaths ||
    !values.every(isPortableRelativePath) ||
    new Set(values).size !== values.length ||
    [...values].sort().some((path, index) => path !== values[index])
  ) {
    throw new Error('Managed command observation path list is invalid');
  }
  return values;
}

function writeJsonResponseAndExit(value: Readonly<Record<string, unknown>>): never {
  const response = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  try {
    let offset = 0;
    while (offset < response.length) {
      const written = writeSync(1, response, offset, response.length - offset);
      if (written <= 0) return process.exit(1);
      offset += written;
    }
  } catch {
    return process.exit(1);
  }
  return process.exit(0);
}

function registerDependencyResolution(dependencyRoot: string): void {
  const dependencyParentURL = pathToFileURL(join(dependencyRoot, '__maka_anchor__.mjs')).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!isBarePackageSpecifier(specifier)) return nextResolve(specifier, context);
      return nextResolve(specifier, { ...context, parentURL: dependencyParentURL });
    },
  });
}

function isBarePackageSpecifier(specifier: string): boolean {
  return /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:\/[^\\]*)?$/u.test(specifier);
}
async function observeFile(relativePath: string): Promise<{
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
}> {
  const path = join(process.cwd(), ...relativePath.split('/'));
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_OBSERVED_FILE_BYTES) {
      throw new Error('Managed command observed file is invalid or too large');
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < info.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, info.size - position),
        position,
      );
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== info.size) {
      throw new Error('Managed command observed file changed while read');
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error('Managed command observed file changed while read');
    }
    return {
      relativePath,
      bytes: info.size,
      sha256: `sha256:${digest.digest('hex')}`,
    };
  } finally {
    await file.close();
  }
}

function isPortableRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    !value.includes('\\') &&
    value.split('/').every((segment) => PORTABLE_PATH_SEGMENT.test(segment) && segment !== '..')
  );
}
