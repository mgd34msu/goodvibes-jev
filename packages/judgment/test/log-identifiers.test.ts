import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionOf, hashState, isoTime, readingsOf, SqliteDecisionLog, truthOf, type DecisionTruth, type NewDecisionEntry } from '../src/index.ts';

const collisionUuid = '01a126ad-991e-7023-9665-055983b11cdd';
const encodedCollision = 'abkbcgkn-jjbo-hacd-jggf-affjidlbbmnn';
const entry: NewDecisionEntry = {
  at: isoTime(new Date('2026-10-01T00:00:00Z')), context: { battery: 'test.identifiers', site: 'calibration', fixture: 'one' },
  stateHash: hashState('one'), requestedModel: 'test', model: 'test', status: 'answered', questions: {}, answers: {},
  latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 }, requestId: undefined,
};
const truth: DecisionTruth = { source: 'fixture', checks: [
  { fixture: 'one', aspect: 'answer', expected: 'yes', got: 'yes', correct: true, signal: 0.99, outcome: 'act' },
] };

/** The generator override cannot escape the synchronous record call. */
function recordUuid(log: SqliteDecisionLog, uuid: string): ReturnType<SqliteDecisionLog['record']> {
  const original = Bun.randomUUIDv7;
  Bun.randomUUIDv7 = (() => uuid) as typeof Bun.randomUUIDv7;
  try { return log.record(entry); } finally { Bun.randomUUIDv7 = original; }
}

describe('opaque generated SQLite decision identifiers', () => {
  test('the confirmed UUID collision becomes an exact alphabetic key without losing the recorded entry', () => {
    using log = new SqliteDecisionLog(':memory:');
    const id = recordUuid(log, collisionUuid);
    expect<string>(id).toBe(encodedCollision);
    expect(id).toMatch(/^[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/);
    expect(log.get(id)).toEqual({ ...entry, id, notes: [] });
    expect(log.get(collisionUuid)).toBeUndefined();
  });

  test('every hexadecimal nibble has a distinct image, preserving all UUID bits and separators', () => {
    using log = new SqliteDecisionLog(':memory:');
    expect<string>(recordUuid(log, '01234567-89ab-7cde-8f01-23456789abcd')).toBe('abcdefgh-ijkl-hmno-ipab-cdefghijklmn');
    const ids = [...'0123456789abcdef'].map((nibble) => recordUuid(log, `00000000-0000-7000-8000-00000000000${nibble}`));
    expect(new Set(ids).size).toBe(16);
    expect(ids.map((id) => id.at(-1)).join('')).toBe('abcdefghijklmnop');
    // Mapping just decimal digits would collapse 0/a, 1/b, ..., 5/f.
    expect(ids[0]).not.toBe(ids[10]);
    expect(ids[5]).not.toBe(ids[15]);
    for (const id of ids) expect(log.get(id)?.id).toBe(id);
  });

  test('an actual duplicate generator output still fails its primary-key insert without overwriting', () => {
    using log = new SqliteDecisionLog(':memory:');
    const id = recordUuid(log, collisionUuid);
    log.attach(id, { kind: 'action', action: 'original' });
    expect(() => recordUuid(log, collisionUuid)).toThrow();
    expect(log.query()).toHaveLength(1);
    expect(actionOf(log.get(id)!)).toBe('original');
  });

  test('legacy and new keys persist and accept readings, action and truth unchanged across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decision-identifiers-'));
    const path = join(dir, 'mixed.sqlite');
    let generated = '';
    try {
      {
        using log = new SqliteDecisionLog(path);
        using db = new Database(path);
        db.query('INSERT INTO decisions (id, entry) VALUES (?, ?)').run(collisionUuid, JSON.stringify(entry));
        generated = recordUuid(log, collisionUuid);
        for (const id of [collisionUuid, generated]) {
          log.attach(id, { kind: 'readings', readings: { answer: { outcome: 'act', probability: 0.99 } } });
          log.attach(id, { kind: 'action', action: `kept:${id}` });
          log.attach(id, { kind: 'truth', truth });
        }
      }
      {
        using log = new SqliteDecisionLog(path);
        using db = new Database(path);
        expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
        // Equal timestamps use deterministic lexical tie-breaking, not inferred chronology.
        expect(log.query().map((row) => String(row.id))).toEqual([collisionUuid, generated].sort().reverse());
        for (const id of [collisionUuid, generated]) {
          const saved = log.get(id)!;
          expect<string>(saved.id).toBe(id);
          expect(readingsOf(saved)).toEqual({ answer: { outcome: 'act', probability: 0.99 } });
          expect(actionOf(saved)).toBe(`kept:${id}`);
          expect(truthOf(saved)).toEqual(truth);
          log.attach(id, { kind: 'action', action: 'updated after reopen' });
          expect(actionOf(log.get(id)!)).toBe('updated after reopen');
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
