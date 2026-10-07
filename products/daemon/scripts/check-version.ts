import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A local binary must carry the current product version even without its manifest. */
export function checkBinaryVersion(root: string): void {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  if (manifest.name !== '@goodvibes-jev/daemon' || typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('Native build requires the @goodvibes-jev/daemon manifest and a nonempty version.');
  }
  const source = readFileSync(resolve(root, 'src/version.ts'), 'utf8');
  const fallbacks = [...source.matchAll(/^let _version = '([^']+)';$/gm)];
  if (fallbacks.length !== 1 || fallbacks[0]?.[1] !== manifest.version) {
    throw new Error('Daemon src/version.ts fallback must match package.json before a native build. This check does not prepare or bump a release.');
  }
}

if (import.meta.main) {
  try { checkBinaryVersion(resolve(dirname(fileURLToPath(import.meta.url)), '..')); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
