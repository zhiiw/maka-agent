export const RECOVERY_TEST_INVENTORIES = Object.freeze({
  'managed-workspace': Object.freeze({
    environment: Object.freeze({ MAKA_STORAGE_STRESS: '1' }),
    // This inventory owns both the executable evidence and the CI surfaces
    // that select it. Keep production owners, crash fixtures, and workflows
    // here so the planner cannot drift into a partial second list.
    selectionFiles: Object.freeze([
      '.github/workflows/ci.yml',
      '.github/workflows/macos-recovery.yml',
      '.github/workflows/windows-recovery.yml',
      'scripts/ci-test-plan.mjs',
      'scripts/ci-test-plan.test.mjs',
      'scripts/recovery-test-inventory.mjs',
      'scripts/run-recovery-test-inventory.mjs',
      'packages/storage/src/git-workspace-service.ts',
      'packages/storage/src/managed-mutation-candidate-authority-internal.ts',
      'packages/storage/src/managed-workspace-owner.ts',
      'packages/storage/src/managed-workspace-execution-authority-internal.ts',
      'packages/storage/src/managed-workspace-worker-bridge-internal.ts',
      'packages/storage/src/sqlite-runtime-schema.ts',
      'packages/storage/src/sqlite-runtime-store.ts',
      'packages/storage/src/workspace-version-authority-internal.ts',
      'packages/runtime/src/tool-runtime.ts',
      'packages/runtime/src/filesystem-worker/client.ts',
      'packages/runtime/src/filesystem-worker/operations.ts',
      'packages/runtime/src/filesystem-worker/protocol.ts',
      'packages/runtime-host/src/server/execution-composition.ts',
      'packages/runtime-host/src/server/managed-workspace-mutation-session.ts',
      'packages/storage/src/__tests__/managed-workspace-baseline.test.ts',
      'packages/storage/src/__tests__/git-workspace-service.test.ts',
      'packages/storage/src/__tests__/managed-mutation-candidate-authority.test.ts',
      'packages/storage/src/__tests__/managed-workspace-owner.test.ts',
      'packages/storage/src/__tests__/sqlite-runtime-crash.test.ts',
      'packages/storage/src/__tests__/sqlite-recovery-concurrency.test.ts',
      'packages/storage/src/__tests__/fixtures/git-workspace-service-crash-child.ts',
      'packages/storage/src/__tests__/fixtures/sqlite-recovery-concurrency-child.ts',
      'packages/runtime/src/__tests__/filesystem-worker.test.ts',
      'packages/runtime-host/src/__tests__/managed-workspace-write-edit-crash.test.ts',
      'packages/runtime-host/src/__tests__/fixtures/managed-workspace-write-edit-host-crash.ts',
    ]),
    testNamePattern:
      'real process crash|real process is killed|real crash|real-process crash|crash after baseline ref publication|durable managed mutation ownership',
    testFiles: Object.freeze([
      'packages/storage/dist/__tests__/managed-workspace-baseline.test.js',
      'packages/storage/dist/__tests__/git-workspace-service.test.js',
      'packages/storage/dist/__tests__/managed-mutation-candidate-authority.test.js',
      'packages/storage/dist/__tests__/managed-workspace-owner.test.js',
      'packages/storage/dist/__tests__/sqlite-runtime-crash.test.js',
      'packages/storage/dist/__tests__/sqlite-recovery-concurrency.test.js',
      'packages/runtime-host/dist/__tests__/managed-workspace-write-edit-crash.test.js',
    ]),
    expectedByPlatform: Object.freeze({
      darwin: Object.freeze({ tests: 31, pass: 31, skipped: 0 }),
      linux: Object.freeze({ tests: 31, pass: 31, skipped: 0 }),
      // The Windows release contains the sandbox broker, but the recovery
      // runner does not currently build/package that Rust artifact. Keep the
      // full Host test visible as an explicit platform evidence gap.
      win32: Object.freeze({ tests: 31, pass: 30, skipped: 1 }),
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
