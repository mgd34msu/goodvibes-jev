// stored-readings.ts
//
// The committed store of Jev readings the offline gates check against, shared
// by each gate's live reader and the gate itself, the same pattern as
// etc/credential-key-readings.json. A reading is stored under the content
// hash of the exact state it was read from, so a changed input has no stored
// reading and must be read again; the gates never call Jev.
//
// A stored file names the decision (`name@version`) and the model it was read
// on. When either changes, every stored reading is stale: the gate reports the
// inputs as unread and the reader reads them all again.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createSystemOnePort,
  judgmentConfigFromEnv,
  PINNED_MODEL,
  type Battery,
  type BatteryItems,
  type JudgmentPort,
  type YesNoReading,
} from '@goodvibes-jev/judgment';

/** One yes/no answer as stored: the verdict and outcome the battery's band gave, and the probability. */
export interface StoredAnswer {
  readonly verdict: 'yes' | 'no' | 'uncertain';
  readonly outcome: 'act' | 'confirm' | 'escalate';
  readonly probability: number;
}

/** The answers read about one state, by question name, and an optional label naming what was read. */
export interface StoredEntry {
  readonly subject?: string;
  readonly answers: Readonly<Record<string, StoredAnswer>>;
}

export interface StoredReadings {
  readonly decision: string;
  readonly model: string;
  readonly readings: Readonly<Record<string, StoredEntry>>;
}

/** Serializes a JSON value with object keys sorted, so equal states hash equally whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The content hash a state's reading is stored under: the first 16 hex digits of its canonical SHA-256. */
export function stateHash(state: unknown): string {
  return createHash('sha256').update(canonical(state)).digest('hex').slice(0, 16);
}

/** `name@version`, the decision a stored file was read with. */
export function decisionId(battery: Battery<BatteryItems>): string {
  return `${battery.name}@${battery.version}`;
}

/** The model a battery's readings come from: its pinned model, else the judgment package's pinned default. */
export function readingModel(battery: Battery<BatteryItems>): string {
  return battery.model ?? PINNED_MODEL;
}

export function loadStoredReadings(path: string): StoredReadings | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as StoredReadings;
}

/**
 * The stored readings a gate may use: the file's readings when it was read
 * with this battery's decision and model, else none (every input is unread).
 */
export function currentReadings(path: string, battery: Battery<BatteryItems>): Readonly<Record<string, StoredEntry>> {
  const stored = loadStoredReadings(path);
  if (stored === null || stored.decision !== decisionId(battery) || stored.model !== readingModel(battery)) return {};
  return stored.readings;
}

/** Writes the store with one reading per line, sorted by hash, so a diff shows exactly the readings that changed. */
export function saveStoredReadings(path: string, readings: StoredReadings): void {
  const lines = Object.entries(readings.readings)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hash, entry]) => `    ${JSON.stringify(hash)}: ${JSON.stringify(entry)}`);
  const body = lines.length === 0 ? '{}' : `{\n${lines.join(',\n')}\n  }`;
  writeFileSync(path, `{\n  "decision": ${JSON.stringify(readings.decision)},\n  "model": ${JSON.stringify(readings.model)},\n  "readings": ${body}\n}\n`, 'utf-8');
}

/** A yes/no reading as it is stored. */
export function storedAnswer(reading: YesNoReading): StoredAnswer {
  return { verdict: reading.verdict, outcome: reading.outcome, probability: Number(reading.probability.toFixed(4)) };
}

/** A settled answer: the band concluded it and code may act on it without a person confirming. */
export function isSettled(answer: StoredAnswer | undefined, verdict: 'yes' | 'no'): boolean {
  return answer !== undefined && answer.verdict === verdict && answer.outcome === 'act';
}

/** How a stored answer reads in a gate's failure text. */
export function describeAnswer(answer: StoredAnswer): string {
  return `${answer.verdict}, ${answer.outcome}, probability ${answer.probability}`;
}

/** The port a reader asks through, built from the environment (TYPESAFE_API_KEY). */
export function readerPort(): JudgmentPort {
  return createSystemOnePort(judgmentConfigFromEnv(process.env));
}
