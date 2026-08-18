export const RECOVERY_TEST_INVENTORIES = Object.freeze({
  'managed-workspace': Object.freeze({
    environment: Object.freeze({ MAKA_STORAGE_STRESS: '1' }),
    testNamePattern:
      'real process crash|real process is killed|real crash|real-process crash|crash after baseline ref publication|durable managed mutation ownership',
    testFiles: Object.freeze([
      'packages/storage/dist/__tests__/managed-workspace-baseline.test.js',
      'packages/storage/dist/__tests__/git-workspace-service.test.js',
      'packages/storage/dist/__tests__/managed-mutation-candidate-authority.test.js',
      'packages/storage/dist/__tests__/sqlite-runtime-crash.test.js',
      'packages/storage/dist/__tests__/sqlite-recovery-concurrency.test.js',
    ]),
    expectedByPlatform: Object.freeze({
      darwin: Object.freeze({ tests: 28, pass: 28, skipped: 0 }),
      linux: Object.freeze({ tests: 28, pass: 28, skipped: 0 }),
      win32: Object.freeze({ tests: 28, pass: 28, skipped: 0 }),
    }),
  }),
});

export function requireRecoveryTestInventory(name, platform = process.platform) {
  const inventory = RECOVERY_TEST_INVENTORIES[name];
  if (!inventory) throw new Error(`Unknown recovery test inventory: ${name}`);
  const expected = inventory.expectedByPlatform[platform];
  if (!expected) {
    throw new Error(`Recovery test inventory ${name} has no evidence contract for ${platform}`);
  }
  return { ...inventory, expected };
}
