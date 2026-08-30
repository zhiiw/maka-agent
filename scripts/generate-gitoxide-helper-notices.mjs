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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(repoRoot, 'native/gitoxide-helper/Cargo.toml');
const lockPath = join(repoRoot, 'native/gitoxide-helper/Cargo.lock');
const outputPath = join(
  repoRoot,
  'apps/desktop/.generated/gitoxide-helper/THIRD_PARTY_NOTICES.txt',
);
const metadata = JSON.parse(
  execFileSync(
    process.env.CARGO ?? 'cargo',
    ['metadata', '--manifest-path', manifestPath, '--locked', '--format-version', '1'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ),
);
const rootPackage = metadata.packages.find((pkg) => pkg.name === 'maka-gitoxide-helper');
if (!rootPackage || !metadata.resolve) throw new Error('Gitoxide Cargo metadata is incomplete');
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
const productionIds = new Set();
const pending = [rootPackage.id];
while (pending.length > 0) {
  const id = pending.pop();
  if (productionIds.has(id)) continue;
  productionIds.add(id);
  const node = nodes.get(id);
  if (!node) throw new Error(`Missing Cargo resolve node: ${id}`);
  for (const dep of node.deps) {
    if (dep.dep_kinds.some(({ kind }) => kind !== 'dev')) pending.push(dep.pkg);
  }
}

const sections = [...productionIds]
  .filter((id) => id !== rootPackage.id)
  .map((id) => packageById.get(id))
  .sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'),
  )
  .map((pkg) => {
    if (!pkg?.license) throw new Error(`${pkg?.name ?? 'unknown'}: missing SPDX license metadata`);
    const directory = dirname(pkg.manifest_path);
    const licenseFiles = readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    const source = pkg.repository ?? pkg.homepage ?? pkg.source ?? 'unknown';
    const notices =
      licenseFiles.length > 0
        ? licenseFiles.map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8') }))
        : [declaredLicenseFallback(pkg, source)];
    return [
      `${pkg.name}@${pkg.version}`,
      `SPDX license: ${pkg.license}`,
      `Source: ${source}`,
      ...notices.flatMap(({ name, text }) => [
        '',
        `----- ${name} -----`,
        text.replace(/\r\n?/gu, '\n').trimEnd(),
      ]),
    ].join('\n');
  });

const output = `Maka Gitoxide helper Cargo dependency notices
================================================

Generated from the exact locked production dependency graph.
Manifest: ${relative(repoRoot, manifestPath).replaceAll('\\', '/')}
Cargo.lock SHA-256: ${createHash('sha256').update(readFileSync(lockPath)).digest('hex')}

${sections.join('\n\n================================================\n\n')}
`;
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output);
console.log(`[gitoxide-helper-notices] wrote ${outputPath}`);

function declaredLicenseFallback(pkg, source) {
  if (/Apache-2\.0/u.test(pkg.license)) {
    return { name: 'Apache-2.0.txt', text: readFileSync(join(repoRoot, 'LICENSE'), 'utf8') };
  }
  if (/MIT/u.test(pkg.license)) {
    return {
      name: 'MIT.txt',
      text: `Copyright notice: not included in the published crate
Cargo authors: ${pkg.authors.length > 0 ? pkg.authors.join(', ') : 'not included'}
Source: ${source}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
    };
  }
  throw new Error(`${pkg.name}@${pkg.version}: packaged crate has no license text`);
}
