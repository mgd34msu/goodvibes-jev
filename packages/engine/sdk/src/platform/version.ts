import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let version = '2.0.23';
try {
  // The engine manifest: packages/engine/package.json, three levels above sdk/src/platform (and sdk/dist/platform).
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf-8'));
  version = pkg.version ?? version;
} catch {
  // Keep the baked value when package.json is not available.
}

export const VERSION = version;
