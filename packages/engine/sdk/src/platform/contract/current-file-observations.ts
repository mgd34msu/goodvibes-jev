import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { summarizeError } from '../utils/error-display.js';

/** Actual file identity observations shared by native checks and repair context. */
export function currentFileObservations(cwd: string, paths: readonly string[], options: { readonly includeText?: boolean } = {}): JsonValue[] {
  return [...new Set(paths)].flatMap<JsonValue>(path => {
    const parts = path.split('/');
    if (isAbsolute(path) || parts.some(part => ['..', '.git', '.goodvibes'].includes(part))) return [];
    try {
      if (!lstatSync(cwd).isDirectory()) return [];
      // lstat on the leaf alone still follows symlinked parent directories.
      // Current host observations must stay inside the checked physical tree.
      for (let index = 1; index < parts.length; index++)
        if (!lstatSync(join(cwd, ...parts.slice(0, index))).isDirectory()) return [];
      const absolute = join(cwd, path);
      if (!lstatSync(absolute).isFile()) return [];
      const bytes = readFileSync(absolute);
      const text = options.includeText && !bytes.includes(0) ? bytes.toString('utf8') : undefined;
      return [{ operation: 'read-current-file', source: 'native-host-filesystem', success: true,
        path, bytes: bytes.length, binary: bytes.includes(0), sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(text !== undefined && Buffer.from(text, 'utf8').equals(bytes) ? { text } : {}),
        meaning: 'Actual bytes read from the current checked tree. This establishes current file identity, not semantic correctness, archive integrity, a worker execution or native approval.' }];
    } catch (error) {
      return [{ operation: 'read-current-file', source: 'native-host-filesystem', success: false, path,
        error: summarizeError(error), meaning: 'Current file identity could not be established.' }];
    }
  });
}
