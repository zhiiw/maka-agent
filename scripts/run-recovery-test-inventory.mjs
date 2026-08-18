import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { requireRecoveryTestInventory } from './recovery-test-inventory.mjs';

const name = process.argv[2];
if (!name || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/run-recovery-test-inventory.mjs <inventory>');
}

const inventory = requireRecoveryTestInventory(name);
for (const testFile of inventory.testFiles) {
  if (!existsSync(resolve(testFile))) {
    throw new Error(`Recovery test artifact is unavailable: ${testFile}`);
  }
}

const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    `--test-name-pattern=${inventory.testNamePattern}`,
    ...inventory.testFiles,
  ],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...inventory.environment },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20 * 60 * 1_000,
  },
);

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const summary = parseTapSummary(result.stdout ?? '');
for (const field of ['tests', 'pass', 'skipped']) {
  if (summary[field] !== inventory.expected[field]) {
    throw new Error(
      `Recovery inventory ${name} expected ${field}=${inventory.expected[field]}, observed ${summary[field]}`,
    );
  }
}

function parseTapSummary(output) {
  const read = (name) => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'mu'));
    if (!match) throw new Error(`Recovery test TAP summary is missing ${name}`);
    return Number(match[1]);
  };
  return {
    tests: read('tests'),
    pass: read('pass'),
    skipped: read('skipped'),
  };
}
