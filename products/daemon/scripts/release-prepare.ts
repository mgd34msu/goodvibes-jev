#!/usr/bin/env bun
/** Explicit local release mechanics only. Never invoked by build, install or startup. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withBuildPreparationLock } from './build-preparation-lock.ts';

export type BumpKind = 'patch' | 'minor' | 'major';
export interface PrepareArgs {
  readonly bump: BumpKind | { readonly exact: string } | null;
  readonly changelog: boolean;
  readonly date?: string;
}
const USAGE = 'Usage: release:prepare (--patch | --minor | --major | --version X.Y.Z | --no-bump) (--date YYYY-MM-DD | --no-changelog)';

function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error(`Version is not semver: ${version}`);
  }
  const parts = version.split(/[.+-]/).slice(0, 3).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version components exceed safe integer range');
  return parts;
}

/** Explicit arithmetic; this does not choose the product's release/version policy. */
export function bumpVersion(current: string, kind: BumpKind): string {
  const [major, minor, patch] = versionParts(current) as [number, number, number];
  if (!['major', 'minor', 'patch'].includes(kind)) throw new Error('Unknown bump kind');
  const next = kind === 'major' ? `${major + 1}.0.0` : kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  versionParts(next);
  return next;
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('Date must be a real YYYY-MM-DD calendar date');
  }
}

/** Insert before the first section, retaining the introduction and all previous notes. */
export function scaffoldChangelogText(changelog: string, version: string, date: string): string {
  versionParts(version); validateDate(date);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^##[ \\t]*\\[${escaped}\\](?:[ \\t]|\\r?$)`, 'm').test(changelog)) return changelog;
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n';
  const section = [`## [${version}] - ${date}`, '', '### Changes', '', '- ', '', ''].join(eol);
  const first = changelog.search(/^##[ \t]+/m);
  return first === -1 ? `${changelog.trimEnd()}${eol}${eol}${section}` : `${changelog.slice(0, first)}${section}${changelog.slice(first)}`;
}

export function parseArgs(argv: readonly string[]): PrepareArgs {
  let bump: PrepareArgs['bump'] = null;
  let modes = 0;
  let noChangelog = false;
  let date: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-bump') { modes++; bump = null; }
    else if (arg === '--patch' || arg === '--minor' || arg === '--major') { modes++; bump = arg.slice(2) as BumpKind; }
    else if (arg === '--version') {
      const exact = argv[++i];
      if (!exact || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(exact)) throw new Error(USAGE);
      versionParts(exact); modes++; bump = { exact };
    } else if (arg === '--no-changelog' && !noChangelog) noChangelog = true;
    else if (arg === '--date' && date === undefined) {
      date = argv[++i];
      if (date === undefined) throw new Error(USAGE);
      validateDate(date);
    } else throw new Error(USAGE);
  }
  if (modes !== 1 || (noChangelog ? date !== undefined : date === undefined)) throw new Error(USAGE);
  return { bump, changelog: !noChangelog, ...(date === undefined ? {} : { date }) };
}

/** Locate the one root-level version value, preserving whitespace, escapes and dependencies. */
export function rewriteManifestVersion(text: string, version: string): string {
  versionParts(version);
  const manifest = JSON.parse(text) as { name?: unknown; private?: unknown; version?: unknown };
  if (manifest?.name !== '@goodvibes-jev/daemon' || manifest.private !== true || typeof manifest.version !== 'string') {
    throw new Error('Expected the private @goodvibes-jev/daemon manifest');
  }
  versionParts(manifest.version);
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)];
  let depth = 0;
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token[0] === '{' || token[0] === '[') depth++;
    else if (token[0] === '}' || token[0] === ']') depth--;
    else if (depth === 1 && token[0].startsWith('"') && tokens[i + 1]?.[0] === ':' && JSON.parse(token[0]) === 'version') {
      const value = tokens[i + 2]!;
      if (!value[0].startsWith('"')) throw new Error('Manifest version must be a string');
      spans.push({ start: value.index!, end: value.index! + value[0].length });
    }
  }
  if (spans.length !== 1) throw new Error('Manifest must have exactly one top-level version');
  const span = spans[0]!;
  return text.slice(0, span.start) + JSON.stringify(version) + text.slice(span.end);
}

/** Validate every input before writing. Repeating exact/no-bump preparation is byte-idempotent. */
function prepareReleaseFiles(
  root: string, argv: readonly string[],
  write: (path: string, text: string) => void = writeFileSync,
): readonly string[] {
  const args = parseArgs(argv);
  const manifestPath = join(root, 'package.json');
  const manifestText = readFileSync(manifestPath, 'utf8');
  const current: unknown = (JSON.parse(manifestText) as { version?: unknown }).version;
  if (typeof current !== 'string') throw new Error('Manifest version must be a string');
  const version = args.bump === null ? current : typeof args.bump === 'string' ? bumpVersion(current, args.bump) : args.bump.exact;
  const manifestAfter = rewriteManifestVersion(manifestText, version);
  const versionPath = join(root, 'src/version.ts');
  const source = readFileSync(versionPath, 'utf8');
  const fallback = /^let _version = '[^'\r\n]*';$/gm;
  if ([...source.matchAll(fallback)].length !== 1) throw new Error('Expected exactly one compiled version fallback');
  const readmePath = join(root, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');
  const files = [
    { path: manifestPath, before: manifestText, after: args.bump === null ? manifestText : manifestAfter },
    { path: versionPath, before: source, after: source.replace(fallback, `let _version = '${version}';`) },
    // The private product README currently has no badge; preserve that choice.
    { path: readmePath, before: readme, after: readme.replace(/version-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?-blue\.svg/g, `version-${version}-blue.svg`) },
  ];
  if (args.changelog) {
    const path = join(root, 'CHANGELOG.md');
    // Require an existing caller-owned changelog. No implicit ownership or migration.
    if (!existsSync(path)) throw new Error('Provide a product CHANGELOG.md before preparing release notes');
    const before = readFileSync(path, 'utf8');
    files.push({ path, before, after: scaffoldChangelogText(before, version, args.date!) });
  }
  const changed = files.filter((file) => file.before !== file.after);
  const attempted: typeof changed = [];
  try {
    for (const file of changed) {
      // Include the failing write: a filesystem error can follow partial truncation.
      attempted.push(file);
      write(file.path, file.after);
    }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const file of attempted.reverse()) {
      try { write(file.path, file.before); } catch (restoreError) { failures.push(restoreError); }
    }
    throw new AggregateError(failures, failures.length === 1
      ? 'Release preparation failed; original files restored'
      : 'Release preparation failed and restoration was incomplete; inspect the affected files');
  }
  return changed.map((file) => file.path);
}

/** Serialize the complete read/validate/write/compensation operation. */
export async function prepareRelease(
  root: string, argv: readonly string[],
  write: (path: string, text: string) => void = writeFileSync,
  timeoutMs?: number,
): Promise<readonly string[]> {
  parseArgs(argv); // Invalid requests cannot acquire ownership or touch files.
  return withBuildPreparationLock(root, () => prepareReleaseFiles(root, argv, write), timeoutMs);
}

if (import.meta.main) {
  try {
    const changed = await prepareRelease(join(import.meta.dir, '..'), process.argv.slice(2));
    console.log(`[release:prepare] ${changed.length} local files updated. Review the diff and complete any scaffolded notes.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  }
}
