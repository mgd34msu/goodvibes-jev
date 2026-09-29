// stale-server-kind-readings.ts
//
// The stored `errors.stale-server-kind` readings of every consumer-facing
// error doc and worker test error-contract-check.ts guards, shared by the live
// reader (read-stale-error-kinds.ts, `bun run error-kinds:read`) and the
// offline check. Each reading is kept with the sha256 of the file text it was
// read from, so a changed file is read again.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { staleServerKind } from './batteries/stale-server-kind.ts';
import { isSettledNo, sha256, type FileReading, type WindowSize } from './file-readings.ts';

export const ENGINE_ROOT = resolve(import.meta.dir, '..');
export const READINGS_PATH = resolve(ENGINE_ROOT, 'etc', 'stale-server-kind-readings.json');

/** The files whose text must not present 'server' as an error kind, relative to packages/engine. */
export const CHECKED_FILES: readonly string[] = [
  'docs/browser-integration.md',
  'docs/error-handling.md',
  'docs/error-kinds.md',
  'docs/expo-integration.md',
  'docs/react-native-integration.md',
  'docs/web-ui-integration.md',
  'test/workers/SETUP.md',
  'test/workers/workers.test.ts',
  'test/workers-wrangler/wrangler.test.ts',
];

/** How much of a file one reading sees: a request buffer size. */
export const WINDOW: WindowSize = { maxLines: 200, maxChars: 8_000 };

/** The decision and model a stored set of readings must come from to count. */
export const DECISION = `${staleServerKind.name}@${staleServerKind.version}`;
export const MODEL = staleServerKind.model!;

export interface StoredStaleServerKindReading extends FileReading {
  readonly sha256: string;
}

export interface StaleServerKindReadings {
  readonly decision: string;
  readonly model: string;
  readonly readings: Readonly<Record<string, StoredStaleServerKindReading>>;
}

export function loadStaleServerKindReadings(path: string = READINGS_PATH): StaleServerKindReadings | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as StaleServerKindReadings;
}

export function saveStaleServerKindReadings(readings: StaleServerKindReadings, path: string = READINGS_PATH): void {
  const sorted = Object.fromEntries(Object.entries(readings.readings).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify({ ...readings, readings: sorted }, null, 2)}\n`, 'utf-8');
}

/** The members of the `SDKErrorKind` union in errors/src/index.ts, in declared order. */
export function currentErrorKinds(root: string = ENGINE_ROOT): string[] {
  const source = readFileSync(resolve(root, 'errors/src/index.ts'), 'utf-8');
  const union = /export\s+type\s+SDKErrorKind\s*=\s*([\s\S]*?);/.exec(source)?.[1];
  if (union === undefined) throw new Error('errors/src/index.ts must export SDKErrorKind');
  return [...union.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

/**
 * One message per checked file that does not pass: no stored reading for its
 * current text (or readings from another decision or model), or a stored
 * reading other than a settled no. Offline; reads only files and the store.
 */
export function staleServerKindFindings(
  root: string,
  files: readonly string[],
  stored: StaleServerKindReadings | null,
): string[] {
  const findings: string[] = [];
  const current = stored !== null && stored.decision === DECISION && stored.model === MODEL;
  for (const rel of files) {
    const reading = current ? stored.readings[rel] : undefined;
    if (reading === undefined || reading.sha256 !== sha256(readFileSync(resolve(root, rel), 'utf-8'))) {
      findings.push(`${rel} has no ${DECISION} reading for its current text; run \`bun run error-kinds:read\` and commit etc/stale-server-kind-readings.json`);
      continue;
    }
    if (reading.verdict === 'yes') {
      findings.push(`${rel} still documents stale SDKErrorKind 'server' (probability ${reading.probability}, ${reading.outcome})`);
    } else if (!isSettledNo(reading)) {
      findings.push(`${rel} has no settled reading on stale SDKErrorKind 'server' (${reading.verdict}, ${reading.outcome}, probability ${reading.probability}); only a settled no passes, so reword the file until it reads clearly`);
    }
  }
  return findings;
}
