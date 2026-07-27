import { createHash } from 'node:crypto';

/**
 * Canonical identity for the exact provider-visible tool name and arguments.
 * This function is shared by T1 production writes and recovery validation so
 * persisted hashes cannot authenticate themselves.
 */
export function canonicalToolArgsHash(toolName: string, args: unknown): string {
  if (!toolName) throw new Error('Tool argument identity requires a tool name');
  const body = stableToolArgsStringify({ toolName, args });
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

export function stableToolArgsStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return `[${typeof value}]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    canonical[key] = canonicalize(record[key]);
  }
  return canonical;
}
