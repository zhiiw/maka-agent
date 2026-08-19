import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatGitHubOutputs, planTests } from './ci-test-plan.mjs';

const graph = Object.freeze({
  dirs: Object.freeze(['packages/storage']),
  dependents: new Map([['packages/storage', new Set()]]),
  testDirs: new Set(['packages/storage']),
});

describe('managed-workspace recovery CI selection', () => {
  for (const [name, changedFile, expectedStandardWorkspaces] of [
    ['recovery workflow', '.github/workflows/macos-recovery.yml', []],
    [
      'inventory test',
      'packages/storage/src/__tests__/managed-mutation-candidate-authority.test.ts',
      ['packages/storage'],
    ],
    ['production owner', 'packages/storage/src/managed-workspace-owner.ts', ['packages/storage']],
  ]) {
    it(`selects the workspace lane for a ${name} change`, () => {
      const plan = planTests([changedFile], { graph });

      assert.equal(plan.recoveryInventory, true);
      assert.equal(plan.workspaceTestsSelected, true);
      assert.deepEqual(plan.standardWorkspaces, expectedStandardWorkspaces);
      assert.match(formatGitHubOutputs(plan), /^workspace_tests_selected=true$/m);
    });
  }
});
