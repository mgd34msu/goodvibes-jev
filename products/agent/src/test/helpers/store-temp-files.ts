import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * Leftover temp files beside `path`, by shape rather than by exact name.
 *
 * src/utils/store-file.ts picks a fresh temp name per write (pid plus a
 * sequence number), so a test that hardcodes one name silently stops checking
 * anything the moment that name changes. This matches any `<file>.*.tmp`
 * sibling instead, which is what "the writer cleaned up after itself" actually
 * means.
 */
export function leftoverStoreTempFiles(path: string): readonly string[] {
  const name = basename(path);
  try {
    return readdirSync(dirname(path)).filter(
      (entry) => entry !== name && entry.startsWith(`${name}.`) && entry.endsWith('.tmp'),
    );
  } catch {
    return [];
  }
}
