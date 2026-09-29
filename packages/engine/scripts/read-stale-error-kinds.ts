#!/usr/bin/env bun
// read-stale-error-kinds.ts: reads, through Jev (`errors.stale-server-kind`),
// whether each consumer-facing error doc and worker test error-contract-check.ts
// guards still presents 'server' as an SDK error kind, and stores the readings
// in etc/stale-server-kind-readings.json for the offline check. Only files
// whose text has no stored reading are read; a long file is read in fixed
// windows, all in flight together, and reads yes when any window does.
//
//   bun run error-kinds:read          (needs TYPESAFE_API_KEY)
//   bun run error-kinds:read --all    (reads every file again)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSystemOnePort, judgmentConfigFromEnv, type YesNoReading } from '@goodvibes-jev/judgment';
import { staleServerKind } from './batteries/stale-server-kind.ts';
import { fileReading, isSettledNo, numberedText, sha256, windowsOf } from './file-readings.ts';
import {
  CHECKED_FILES,
  currentErrorKinds,
  DECISION,
  ENGINE_ROOT,
  loadStaleServerKindReadings,
  MODEL,
  saveStaleServerKindReadings,
  WINDOW,
  type StoredStaleServerKindReading,
} from './stale-server-kind-readings.ts';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { all: { type: 'boolean' } } });
const SITE = 'errors.stale-server-kind.docs';

const port = createSystemOnePort(judgmentConfigFromEnv(process.env));
const stored = loadStaleServerKindReadings();
const reuse = values.all !== true && stored?.decision === DECISION && stored.model === MODEL;
const currentKinds = currentErrorKinds();

const readings: Record<string, StoredStaleServerKindReading> = {};
const toRead: { rel: string; text: string; hash: string }[] = [];
for (const rel of CHECKED_FILES) {
  const text = readFileSync(resolve(ENGINE_ROOT, rel), 'utf-8');
  const hash = sha256(text);
  const previous = reuse ? stored?.readings[rel] : undefined;
  if (previous?.sha256 === hash) readings[rel] = previous;
  else toRead.push({ rel, text, hash });
}

await Promise.all(toRead.map(async ({ rel, text, hash }) => {
  const windows = await Promise.all(windowsOf(text, WINDOW).map(async (window): Promise<YesNoReading> => {
    const run = await staleServerKind.run(port, { path: rel, currentKinds, text: numberedText(window) }, { site: SITE });
    run.recordAction(`stored:${run.readings.stale.verdict}`);
    return run.readings.stale;
  }));
  readings[rel] = { sha256: hash, ...fileReading(windows) };
}));

saveStaleServerKindReadings({ decision: DECISION, model: MODEL, readings });
console.log(`[error-kinds] ${toRead.length} read, ${CHECKED_FILES.length - toRead.length} reused, ${CHECKED_FILES.length} checked files`);
const open = Object.entries(readings).filter(([, reading]) => !isSettledNo(reading));
for (const [rel, reading] of open) console.log(`[error-kinds] ${rel}: ${reading.verdict} (${reading.outcome}, probability ${reading.probability})`);
