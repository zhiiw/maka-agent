import { posix } from 'node:path';

/**
 * Returns the canonical Git path when the input belongs to the managed source
 * tree, otherwise undefined. Callers retain ownership of their public error.
 */
export function canonicalManagedMutationPath(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.length > 4096 ||
    normalized.includes('\0') ||
    normalized.includes(':') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    posix.normalize(normalized) !== normalized
  ) {
    return undefined;
  }
  const firstSegment = normalized.split('/')[0]!;
  if (
    (process.platform === 'win32'
      ? firstSegment.toLowerCase() === '.git'
      : firstSegment === '.git') ||
    (process.platform === 'win32'
      ? firstSegment.toLowerCase() === 'node_modules'
      : firstSegment === 'node_modules')
  ) {
    return undefined;
  }
  return normalized;
}
