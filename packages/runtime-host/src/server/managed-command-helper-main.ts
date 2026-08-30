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

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_OBSERVED_FILE_BYTES = 16 * 1024 * 1024;
const PORTABLE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

interface InspectRequest {
  readonly protocolVersion: 1;
  readonly operation: 'inspect_file_v1';
  readonly relativePath: string;
}

const raw = await readBoundedStdin();
const request = decodeRequest(JSON.parse(raw) as unknown);
const path = join(process.cwd(), ...request.relativePath.split('/'));
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
  if (position !== info.size) throw new Error('Managed command observed file changed while read');
  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: 1,
      kind: 'file_observation',
      nodeVersion: process.versions.node,
      relativePath: request.relativePath,
      bytes: info.size,
      sha256: `sha256:${digest.digest('hex')}`,
    })}\n`,
  );
} finally {
  await file.close();
}

function decodeRequest(value: unknown): InspectRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Managed command request must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join('\0');
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
