#!/usr/bin/env bun
// read-license-names.ts: reads, through Jev (`engine.gates.copyleft-license`),
// whether each distinct free-text license name in the SBOM denotes an AGPL,
// GPL, LGPL or SSPL license, and stores the readings by content hash in
// etc/copyleft-license-readings.json for the offline license policy
// (scripts/sbom-license-policy.ts). Only names with no stored reading are
// asked; readings of names no longer in the SBOM are dropped.
//
//   bun run sbom:generate && bun run license-names:read          (needs TYPESAFE_API_KEY)
//   bun run license-names:read [path/to/sbom.cdx.json] [--all]

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mapLimit } from '@goodvibes-jev/judgment';
import { copyleftLicense } from './ci-readings/copyleft-license.ts';
import { licenseNames, licenseNameState, READINGS_PATH, type Sbom } from './ci-readings/license-names.ts';
import {
  currentReadings,
  decisionId,
  isSettled,
  readerPort,
  readingModel,
  saveStoredReadings,
  stateHash,
  storedAnswer,
  type StoredEntry,
} from './ci-readings/stored-readings.ts';

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: { all: { type: 'boolean' } } });
const CONCURRENCY = 8;
const SITE = 'engine.gates.copyleft-license.sbom';

const sbomPath = resolve(positionals[0] ?? resolve(import.meta.dir, '..', 'sbom.cdx.json'));
if (!existsSync(sbomPath)) {
  console.error(`[license-names] no SBOM at ${sbomPath}; run \`bun run sbom:generate\` first`);
  process.exit(1);
}
const names = licenseNames(JSON.parse(readFileSync(sbomPath, 'utf8')) as Sbom);

const port = readerPort();
const stored = values.all === true ? {} : currentReadings(READINGS_PATH, copyleftLicense);
const readings: Record<string, StoredEntry> = {};
const toRead = names.filter((name) => {
  const hash = stateHash(licenseNameState(name));
  const previous = stored[hash];
  if (previous === undefined) return true;
  readings[hash] = previous;
  return false;
});

await mapLimit(toRead, CONCURRENCY, async (name) => {
  const run = await copyleftLicense.run(port, licenseNameState(name), { site: SITE });
  readings[stateHash(licenseNameState(name))] = { subject: name, answers: { copyleft: storedAnswer(run.readings.copyleft) } };
});

saveStoredReadings(READINGS_PATH, { decision: decisionId(copyleftLicense), model: readingModel(copyleftLicense), readings });
console.log(`[license-names] ${toRead.length} read, ${names.length - toRead.length} reused, ${names.length} distinct license name(s) in ${sbomPath}`);
for (const name of names) {
  const answer = readings[stateHash(licenseNameState(name))]!.answers['copyleft']!;
  if (!isSettled(answer, 'no')) console.log(`  "${name}"  ${answer.verdict}, ${answer.outcome}, ${answer.probability}: the license policy blocks it`);
}
