import type {
  ToolReconcileDecision,
  ToolRecoveryContract,
  UnsettledToolOperation,
} from './tool-recovery-contract.js';

export type ReadOnlyFileObservation =
  | { status: 'missing' }
  | { status: 'text'; content: string }
  | { status: 'unreadable' };

export interface ReadOnlyFileRecoveryObserver {
  readText(path: string): Promise<ReadOnlyFileObservation>;
}

type FileToolObservation =
  | { status: 'invalid_args' }
  | ({ path: string } & ReadOnlyFileObservation);

export interface WriteEditRecoveryContracts {
  Write: ReadOnlyFileRecoveryContract;
  Edit: ReadOnlyFileRecoveryContract;
}

type ReadOnlyFileRecoveryContract = ToolRecoveryContract<FileToolObservation> & {
  observe(operation: UnsettledToolOperation): Promise<FileToolObservation>;
  decide(input: {
    operation: UnsettledToolOperation;
    observation: FileToolObservation;
  }): ToolReconcileDecision;
};

export function createWriteEditRecoveryContracts(
  observer: ReadOnlyFileRecoveryObserver,
): WriteEditRecoveryContracts {
  return {
    Write: {
      id: 'maka.tool.write.reconcile',
      version: 1,
      mode: 'reconcile_then_decide',
      observe: (operation) => observeFileTarget(observer, operation, parseWriteArgs),
      decide: ({ operation, observation }) => decideWrite(operation, observation),
    },
    Edit: {
      id: 'maka.tool.edit.reconcile',
      version: 1,
      mode: 'reconcile_then_decide',
      observe: (operation) => observeFileTarget(observer, operation, parseEditArgs),
      decide: ({ operation, observation }) => decideEdit(operation, observation),
    },
  };
}

async function observeFileTarget(
  observer: ReadOnlyFileRecoveryObserver,
  operation: UnsettledToolOperation,
  parseArgs: (args: unknown) => { path: string } | undefined,
): Promise<FileToolObservation> {
  const args = parseArgs(operation.args);
  if (!args) return { status: 'invalid_args' };
  return { path: args.path, ...(await observer.readText(args.path)) };
}

function decideWrite(
  operation: UnsettledToolOperation,
  observation: FileToolObservation,
): ToolReconcileDecision {
  const args = parseWriteArgs(operation.args);
  if (!args || observation.status === 'invalid_args') {
    return parked('write_arguments_invalid');
  }
  if (observation.status === 'missing') {
    return {
      result: 'not_applied',
      reasonCode: 'write_target_missing',
      nextAction: 'retry_allowed',
    };
  }
  if (observation.status === 'unreadable') return parked('write_target_unreadable');
  if (observation.content === args.content) {
    return {
      result: 'applied',
      reasonCode: 'write_postcondition_matches',
      nextAction: 'synthesize_response',
      synthesizedResult: {
        ok: true,
        path: args.path,
        bytes: Buffer.byteLength(args.content, 'utf8'),
        recovered: true,
      },
    };
  }
  return parked('write_postcondition_conflict');
}

function decideEdit(
  operation: UnsettledToolOperation,
  observation: FileToolObservation,
): ToolReconcileDecision {
  const args = parseEditArgs(operation.args);
  if (!args || observation.status === 'invalid_args') return parked('edit_arguments_invalid');
  if (observation.status !== 'text') {
    return parked(
      observation.status === 'missing' ? 'edit_target_missing' : 'edit_target_unreadable',
    );
  }
  const oldMatches = countOccurrences(observation.content, args.oldString);
  const newMatches = countOccurrences(observation.content, args.newString);
  if (
    (args.oldString === args.newString && oldMatches === 1) ||
    (oldMatches === 0 && (args.newString.length === 0 || newMatches === 1))
  ) {
    return {
      result: 'applied',
      reasonCode: 'edit_postcondition_matches',
      nextAction: 'synthesize_response',
      synthesizedResult: {
        ok: true,
        path: args.path,
        replacements: 1,
        recovered: true,
      },
    };
  }
  if (oldMatches === 1 && (args.newString.length === 0 || newMatches === 0)) {
    return {
      result: 'not_applied',
      reasonCode: 'edit_precondition_matches',
      nextAction: 'retry_allowed',
    };
  }
  return parked('edit_state_ambiguous');
}

function parked(reasonCode: string): ToolReconcileDecision {
  return { result: 'conflict', reasonCode, nextAction: 'park' };
}

function parseWriteArgs(args: unknown): { path: string; content: string } | undefined {
  if (!isRecord(args)) return undefined;
  return typeof args.path === 'string' && args.path.length > 0 && typeof args.content === 'string'
    ? { path: args.path, content: args.content }
    : undefined;
}

function parseEditArgs(
  args: unknown,
): { path: string; oldString: string; newString: string } | undefined {
  if (!isRecord(args)) return undefined;
  return typeof args.path === 'string' &&
    args.path.length > 0 &&
    typeof args.old_string === 'string' &&
    args.old_string.length > 0 &&
    typeof args.new_string === 'string'
    ? { path: args.path, oldString: args.old_string, newString: args.new_string }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= content.length - needle.length) {
    const found = content.indexOf(needle, cursor);
    if (found < 0) break;
    count += 1;
    cursor = found + needle.length;
  }
  return count;
}
