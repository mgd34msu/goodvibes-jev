/**
 * The stale 'server' error-kind docs gate in error-contract-check.ts: each
 * checked file passes only with a stored settled-no reading of its current
 * text. Stored-reading fixtures stand in for Jev; no model is called.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, type FileReading } from '../scripts/file-readings.ts';
import {
  DECISION,
  MODEL,
  staleServerKindFindings,
  type StaleServerKindReadings,
} from '../scripts/stale-server-kind-readings.ts';

const DOC = 'docs/error-kinds.md';
// The old gate flagged this through its "typed 'server' kind" shape, though it
// only says the kind was replaced.
const MIGRATION_NOTE = "## Migrating\n\nEarlier releases had a typed 'server' kind for every 5xx. It was split into 'service' and 'internal'.\n";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rootWith(text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-stale-kind-'));
  roots.push(root);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, DOC), text, 'utf-8');
  return root;
}

function stored(text: string, reading: FileReading, overrides: Partial<Pick<StaleServerKindReadings, 'decision' | 'model'>> = {}): StaleServerKindReadings {
  return { decision: DECISION, model: MODEL, ...overrides, readings: { [DOC]: { sha256: sha256(text), ...reading } } };
}

describe('stale server error-kind docs gate', () => {
  test('a migration note read as a settled no passes', () => {
    const root = rootWith(MIGRATION_NOTE);
    expect(staleServerKindFindings(root, [DOC], stored(MIGRATION_NOTE, { verdict: 'no', outcome: 'act', probability: 0.04 }))).toEqual([]);
  });

  test('a file read as yes fails with its path', () => {
    const text = "Handle `kind: 'server'` with a retry banner.\n";
    const findings = staleServerKindFindings(rootWith(text), [DOC], stored(text, { verdict: 'yes', outcome: 'act', probability: 0.91 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`${DOC} still documents stale SDKErrorKind 'server'`);
  });

  test('an uncertain reading and a no below act both fail closed', () => {
    const root = rootWith(MIGRATION_NOTE);
    for (const reading of [
      { verdict: 'uncertain', outcome: 'escalate', probability: 0.5 },
      { verdict: 'no', outcome: 'confirm', probability: 0.42 },
    ] as const) {
      const findings = staleServerKindFindings(root, [DOC], stored(MIGRATION_NOTE, reading));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('no settled reading');
    }
  });

  test('a file whose text changed since its reading must be read again', () => {
    const root = rootWith(`${MIGRATION_NOTE}\nOne more line.\n`);
    const findings = staleServerKindFindings(root, [DOC], stored(MIGRATION_NOTE, { verdict: 'no', outcome: 'act', probability: 0.04 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('bun run error-kinds:read');
  });

  test('readings from another decision version or model do not count', () => {
    const root = rootWith(MIGRATION_NOTE);
    const settled = { verdict: 'no', outcome: 'act', probability: 0.04 } as const;
    expect(staleServerKindFindings(root, [DOC], stored(MIGRATION_NOTE, settled, { decision: 'errors.stale-server-kind@0' }))[0]).toContain('bun run error-kinds:read');
    expect(staleServerKindFindings(root, [DOC], stored(MIGRATION_NOTE, settled, { model: 'jev-0.0.1' }))[0]).toContain('bun run error-kinds:read');
    expect(staleServerKindFindings(root, [DOC], null)[0]).toContain('bun run error-kinds:read');
  });
});
