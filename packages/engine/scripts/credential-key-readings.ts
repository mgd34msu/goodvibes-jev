// credential-key-readings.ts
//
// The stored `config.credential-key` readings of every config schema key the
// declared secret-bearing list does not name, shared by the live reader
// (read-credential-keys.ts, `bun run credential-keys:read`) and the offline
// pre-commit check (check-credential-scope.ts). Each reading is kept with the
// description it was read from, so a changed description is read again.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_SCHEMA } from '../sdk/src/platform/config/schema.ts';
import { isDeclaredSecretBearingConfigKey } from '../sdk/src/platform/config/secret-bearing-config-keys.ts';

export const READINGS_PATH = resolve(import.meta.dir, '..', 'etc', 'credential-key-readings.json');

export interface StoredCredentialKeyReading {
  readonly description: string;
  readonly verdict: 'yes' | 'no' | 'uncertain';
  readonly outcome: 'act' | 'confirm' | 'escalate';
  readonly probability: number;
}

export interface CredentialKeyReadings {
  readonly decision: string;
  readonly model: string;
  readonly readings: Readonly<Record<string, StoredCredentialKeyReading>>;
}

/** Every schema key the declared list does not name, with its description, sorted by key. */
export function undeclaredSchemaKeys(): { readonly key: string; readonly description: string }[] {
  return CONFIG_SCHEMA
    .filter((setting) => !isDeclaredSecretBearingConfigKey(setting.key))
    .map((setting) => ({ key: setting.key, description: setting.description ?? '' }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function loadCredentialKeyReadings(): CredentialKeyReadings | null {
  if (!existsSync(READINGS_PATH)) return null;
  return JSON.parse(readFileSync(READINGS_PATH, 'utf-8')) as CredentialKeyReadings;
}

export function saveCredentialKeyReadings(readings: CredentialKeyReadings): void {
  const sorted = Object.fromEntries(Object.entries(readings.readings).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(READINGS_PATH, `${JSON.stringify({ ...readings, readings: sorted }, null, 2)}\n`, 'utf-8');
}
