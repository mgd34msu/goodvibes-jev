// no-todo-markers.ts
//
// CI gate: flags unfinished-code markers in non-exempt source. Recorded
// literal judgment fixture data is classified separately from implementation.
//
// Usage:
//   bun run todo:check
//   bun scripts/no-todo-markers.ts
//
// Exempt paths (never flagged):
//   - vendor/ (nested)
//   - generated/ (nested)
//   - *.test.ts and *.spec.ts files
//   - node_modules/ (nested)
//   - dist/ (nested)
//
// Confirmed unfinished work fails; inconclusive evidence remains advisory.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { resolve, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceMarkerFindings } from './no-todo-marker-rules.ts';
import { loadStaticSourceReadings } from './static-source-readings.ts';
import { scanTargetsFromEnvironment } from './check-internal-identifiers.ts';
import type { InternalIdentifierCandidate } from './internal-identifier-rule.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TODO_ROOT = process.env.TODO_ROOT ?? resolve(__dirname, '..');

// ─── Configuration ──────────────────────────────────────────────────────────

/** Source extensions we care about. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/**
 * Exemption predicates applied to the relative path (forward-slash normalised).
 * A file is skipped if ANY predicate returns true.
 */
const EXEMPT: Array<(rel: string) => boolean> = [
  (rel) => rel.includes('/vendor/')    || rel.startsWith('vendor/'),
  (rel) => rel.includes('/generated/') || rel.startsWith('generated/'),
  (rel) => /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(rel),
  (rel) => rel.includes('/node_modules/') || rel.startsWith('node_modules/'),
  (rel) => rel.includes('/dist/')     || rel.startsWith('dist/'),
];

/** Directory names to never descend into. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.cache', 'coverage', '.turbo']);

// ─── Helpers ────────────────────────────────────────────────────────────────

function isExempt(absPath: string, root = TODO_ROOT): boolean {
  const rel = relative(root, absPath).replace(/\\/g, '/');
  return EXEMPT.some((p) => p(rel));
}

function walkSourceFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) results.push(...walkSourceFiles(full));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

// ─── Scan roots ─────────────────────────────────────────────────────────────

// Scan only the package source tree, scripts/ is build tooling, not published source.
const SCAN_ROOTS = [
  // The old packages/* are the engine's top-level package directories.
  ...['contracts', 'daemon-sdk', 'errors', 'operator-sdk', 'peer-sdk', 'sdk', 'terminal-shell',
    'toolchain', 'transport-core', 'transport-http', 'transport-realtime'].map((pkg) => resolve(TODO_ROOT, pkg)),
];

// ─── Main ───────────────────────────────────────────────────────────────────

interface Finding {
  rel: string;
  line: number;
  col: number;
  marker: string;
  text: string;
}

export function collectDeferredSourceCandidates(root = TODO_ROOT, targets?: readonly string[]): InternalIdentifierCandidate[] {
  const roots = targets?.map(path => resolve(root, path)) ?? SCAN_ROOTS;
  return roots.flatMap(path => {
    if (!statSync(path, { throwIfNoEntry: false })) return [];
    const paths = statSync(path).isFile() ? [path] : walkSourceFiles(path);
    return paths.filter(path => !isExempt(path, root)).map(path => ({ relPath: relative(root, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));
  });
}

if (import.meta.main) {
  const readings = loadStaticSourceReadings(process.env.STATIC_SOURCE_READINGS_PATH);
  const findings: Finding[] = [];
  const candidates = collectDeferredSourceCandidates(TODO_ROOT, scanTargetsFromEnvironment(process.env.TODO_DIRS_JSON));
  for (const { relPath, text } of candidates) {
    for (const finding of sourceMarkerFindings(relPath, text, readings)) findings.push({ rel: relPath, ...finding });
  }
  const advisories = findings.filter(finding => finding.marker === 'evidence-held');
  const violations = findings.filter(finding => finding.marker !== 'evidence-held');
  for (const [label, group] of [['ADVISORY', advisories], ['FAIL', violations]] as const) {
    if (group.length === 0) continue;
    console.error(`todo-check: ${label}, ${group.length} ${label === 'ADVISORY' ? 'inconclusive reading(s); source review required' : 'confirmed unfinished-work finding(s)'}:\n`);
    for (const finding of group.slice(0, 100)) {
      console.error(`  ${finding.rel}:${finding.line}:${finding.col} [${finding.marker}]`);
      console.error(`    ${finding.text}\n`);
    }
    if (group.length > 100) console.error(`... ${group.length - 100} additional findings`);
  }
  if (violations.length > 0) process.exit(1);
  console.log(`todo-check: OK, no confirmed unfinished-work findings; ${advisories.length} inconclusive advisories.`);
}
