#!/usr/bin/env bun
// read-package-readmes.ts: reads, through Jev (`engine.gates.package-readme`),
// whether each released package's README documents the package and, for a
// public package, whether it describes the package in stale internal or
// umbrella terms, and stores the readings by content hash in
// etc/package-readme-readings.json for offline editorial advisories alongside
// the deterministic package metadata check
// (scripts/package-metadata-check.ts). Both questions ride one request per
// README. Only READMEs with no stored reading are asked; readings of text no
// longer current are dropped.
//
//   bun run package-readmes:read          (needs TYPESAFE_API_KEY)
//   bun run package-readmes:read --all    (reads every README again)

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { packageReadme } from './ci-readings/package-readme.ts';
import { READINGS_PATH, readmeProblems, readmeQuestions, readmeState } from './ci-readings/package-readmes.ts';
import {
  currentReadings,
  decisionId,
  readerPort,
  readingModel,
  saveStoredReadings,
  stateHash,
  storedAnswer,
  type StoredEntry,
} from './ci-readings/stored-readings.ts';
import { packageDirs, publicPackageDirs, SDK_ROOT } from './release-shared.ts';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { all: { type: 'boolean' } } });
const SITE = 'engine.gates.package-readme.release';

const port = readerPort();
const stored = values.all === true ? {} : currentReadings(READINGS_PATH, packageReadme);
const readings: Record<string, StoredEntry> = {};
let read = 0;

for (const dir of packageDirs) {
  const state = readmeState(resolve(SDK_ROOT, dir));
  const hash = stateHash(state);
  const asked = readmeQuestions(publicPackageDirs.includes(dir));
  const previous = stored[hash] ?? readings[hash];
  if (previous !== undefined && asked.every((question) => previous.answers[question] !== undefined)) {
    readings[hash] = previous;
    continue;
  }
  const run = await packageReadme.run(port, state, { site: SITE, only: asked });
  const answers = Object.fromEntries(asked.map((question) => [question, storedAnswer(run.readings[question])]));
  readings[hash] = { subject: `${dir}/README.md`, answers };
  read += 1;
}

saveStoredReadings(READINGS_PATH, { decision: decisionId(packageReadme), model: readingModel(packageReadme), readings });
console.log(`[package-readmes] ${read} read, ${packageDirs.length - read} reused, ${packageDirs.length} package README(s)`);
for (const dir of packageDirs) {
  const state = readmeState(resolve(SDK_ROOT, dir));
  const entry = readings[stateHash(state)]!;
  console.log(`  ${dir}/README.md  ${Object.entries(entry.answers).map(([question, answer]) => `${question}: ${answer.verdict}, ${answer.outcome}, ${answer.probability}`).join('; ')}`);
  for (const problem of readmeProblems(dir, state, publicPackageDirs.includes(dir), readings)) console.log(`    ${problem}`);
}
