#!/usr/bin/env bun
// read-credential-keys.ts: reads, through Jev, whether each config schema key
// the declared secret-bearing list does not name holds a credential, and
// stores the readings in etc/credential-key-readings.json for the offline
// pre-commit check (check-credential-scope.ts). Only keys with no stored
// reading, or whose description changed since it was read, are asked; keys no
// longer in the schema, or now declared, are dropped.
//
//   bun run credential-keys:read          (needs TYPESAFE_API_KEY)
//   bun run credential-keys:read --all    (reads every key again)

import { parseArgs } from 'node:util';
import { createSystemOnePort, judgmentConfigFromEnv } from '@goodvibes-jev/judgment';
import { credentialKey } from '../sdk/src/platform/config/batteries/credential-key.ts';
import {
  loadCredentialKeyReadings,
  saveCredentialKeyReadings,
  undeclaredSchemaKeys,
  type StoredCredentialKeyReading,
} from './credential-key-readings.ts';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { all: { type: 'boolean' } } });
const CONCURRENCY = 8;
const SITE = 'config.credential-key.schema';

const port = createSystemOnePort(judgmentConfigFromEnv(process.env));
const decision = `${credentialKey.name}@${credentialKey.version}`;
const model = credentialKey.model ?? port.model;
const stored = loadCredentialKeyReadings();
const reuse = values.all !== true && stored?.decision === decision && stored.model === model;

const keys = undeclaredSchemaKeys();
const readings: Record<string, StoredCredentialKeyReading> = {};
const toRead = keys.filter(({ key, description }) => {
  const previous = reuse ? stored?.readings[key] : undefined;
  if (previous !== undefined && previous.description === description) {
    readings[key] = previous;
    return false;
  }
  return true;
});

let next = 0;
async function worker(): Promise<void> {
  while (next < toRead.length) {
    const { key, description } = toRead[next++]!;
    const run = await credentialKey.run(port, { key, description }, { site: SITE });
    const reading = run.readings.credential;
    readings[key] = { description, verdict: reading.verdict, outcome: reading.outcome, probability: Number(reading.probability.toFixed(4)) };
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toRead.length) }, worker));

saveCredentialKeyReadings({ decision, model, readings });
const credentials = Object.entries(readings).filter(([, reading]) => reading.verdict === 'yes').map(([key]) => key);
console.log(`[credential-keys] ${toRead.length} read, ${keys.length - toRead.length} reused, ${keys.length} undeclared schema keys`);
if (credentials.length > 0) console.log(`[credential-keys] read as credentials (declare them in SECRET_BEARING_CONFIG_PATHS): ${credentials.join(', ')}`);
