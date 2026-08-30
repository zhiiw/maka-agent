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
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from 'node:test';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_OBSERVED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TEST_FILES = 64;
const PORTABLE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

interface InspectRequest {
  readonly protocolVersion: 1;
  readonly operation: 'inspect_file_v1';
  readonly relativePath: string;
}

interface RunNodeTestsRequest {
  readonly protocolVersion: 1;
  readonly operation: 'run_node_tests_v1';
  readonly relativePaths: readonly string[];
}

type ManagedCommandRequest = InspectRequest | RunNodeTestsRequest;

const raw = await readBoundedStdin();
const request = decodeRequest(JSON.parse(raw) as unknown);
if (request.operation === 'inspect_file_v1') {
  const observation = await observeFile(request.relativePath);
  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: 1,
      kind: 'file_observation',
      nodeVersion: process.versions.node,
      ...observation,
    })}\n`,
  );
} else {
  const files = await Promise.all(request.relativePaths.map(observeFile));
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  const responseWrite = process.stdout.write.bind(process.stdout);
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  try {
    const stream = run({
      cwd: process.cwd(),
      files: [...request.relativePaths],
      isolation: 'none',
      concurrency: false,
      timeout: 25_000,
    });
    for await (const event of stream) {
      if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
      if (event.data.details.type === 'suite') continue;
      if (
        event.data.nesting === 0 &&
        event.data.line === 1 &&
        event.data.column === 1 &&
        request.relativePaths.includes(event.data.name)
      ) {
        continue;
      }
      if (event.type === 'test:fail') {
        counts.failed += 1;
      } else if (event.data.skip !== undefined) {
        counts.skipped += 1;
      } else if (event.data.todo !== undefined) {
        counts.todo += 1;
      } else {
        counts.passed += 1;
      }
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  process.exitCode = 0;
  responseWrite(
    `${JSON.stringify({
      protocolVersion: 1,
      kind: 'node_test_observation',
      nodeVersion: process.versions.node,
      files,
      ...counts,
    })}\n`,
  );
}

function decodeRequest(value: unknown): ManagedCommandRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Managed command request must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join('\0');
  const relativePaths = record.relativePaths;
  if (
    keys === ['operation', 'protocolVersion', 'relativePaths'].sort().join('\0') &&
    record.protocolVersion === 1 &&
    record.operation === 'run_node_tests_v1' &&
    Array.isArray(relativePaths) &&
    relativePaths.length > 0 &&
    relativePaths.length <= MAX_TEST_FILES &&
    relativePaths.every(
      (path): path is string =>
        typeof path === 'string' && isPortableRelativePath(path) && /\.(?:cjs|mjs|js)$/u.test(path),
    ) &&
    new Set(relativePaths).size === relativePaths.length &&
    [...relativePaths].sort().every((path, index) => path === relativePaths[index])
  ) {
    return record as unknown as RunNodeTestsRequest;
  }
  if (
    keys !== ['operation', 'protocolVersion', 'relativePath'].sort().join('\0') ||
    record.protocolVersion !== 1 ||
    record.operation !== 'inspect_file_v1' ||
    typeof record.relativePath !== 'string' ||
    !isPortableRelativePath(record.relativePath)
  ) {
    throw new Error('Managed command request is invalid');
  }
  return record as unknown as InspectRequest;
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

async function readBoundedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Managed command request is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
