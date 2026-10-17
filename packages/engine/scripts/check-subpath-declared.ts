/**
 * Check published subpaths for every top-level platform module.
 * Internal child modules can be reached through their parent's public barrel.
 * The five daemon-owned modules listed below are deliberately reached through
 * control-plane verbs and configuration instead of direct consumer imports.
 * check-exports-coverage.ts records the ownership reason for each one.
 * A new undeclared module, or a stale entry after publishing one, fails.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const PACKAGE_DIR = resolve(SDK_ROOT, 'sdk');
const PLATFORM_DIR = resolve(PACKAGE_DIR, 'src', 'platform');

/** Daemon-owned modules exposed through control-plane methods, not SDK imports. */
const KNOWN_UNDECLARED: readonly string[] = [
  './platform/channel-profiles',
  './platform/channel-sync',
  './platform/checkin',
  './platform/principals',
  './platform/push',
];

function declaredSubpaths(): ReadonlySet<string> {
  const manifest = JSON.parse(readFileSync(join(SDK_ROOT, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  // The sdk's subpaths are the engine package's ./sdk/* exports.
  return new Set(
    Object.keys(manifest.exports ?? {})
      .filter((key) => key.startsWith('./sdk/'))
      .map((key) => `.${key.slice('./sdk'.length)}`),
  );
}

/** Top-level platform directories carrying a barrel file. */
function topLevelCapabilities(): readonly string[] {
  return readdirSync(PLATFORM_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(PLATFORM_DIR, entry.name, 'index.ts')))
    .map((entry) => `./platform/${entry.name}`)
    .sort();
}

export function findUndeclaredCapabilities(): readonly string[] {
  const declared = declaredSubpaths();
  return topLevelCapabilities().filter((subpath) => !declared.has(subpath));
}

function main(): void {
  const undeclared = findUndeclaredCapabilities();
  const known = new Set(KNOWN_UNDECLARED);
  const added = undeclared.filter((subpath) => !known.has(subpath));
  const fixed = KNOWN_UNDECLARED.filter((subpath) => !undeclared.includes(subpath));

  if (added.length === 0 && fixed.length === 0) {
    console.log(
      `subpath-declared: OK, ${String(topLevelCapabilities().length)} top-level capabilities, `
      + `${String(undeclared.length)} known-undeclared, no new ones.`,
    );
    return;
  }

  const lines: string[] = [];
  if (added.length > 0) {
    lines.push(
      'subpath-declared FAILED: a capability exists in source and cannot be imported',
      'from the published package. Consumers resolving the real tarball get ERR_PACKAGE_PATH_NOT_EXPORTED.',
      '',
      ...added.map((subpath) => `  + ${subpath}`),
      '',
      'Fix: add a ./sdk/<subpath> exports entry in the engine package.json pointing at its index,',
      'then verify against a PACKED TARBALL, source-tree resolution does not prove this.',
    );
  }
  if (fixed.length > 0) {
    lines.push(
      '',
      'These are now declared. Remove them from KNOWN_UNDECLARED:',
      ...fixed.map((subpath) => `  - ${subpath}`),
    );
  }
  console.error(lines.join('\n'));
  process.exitCode = 1;
}

main();
