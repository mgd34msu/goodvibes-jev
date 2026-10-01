import { describe, expect, test } from 'bun:test';
import {
  asArray,
  asRecord,
  bestId,
  bestStatus,
  bestTitle,
  compactJson,
  countFrom,
  firstArray,
  firstArrayAtPath,
  firstString,
  formatBytes,
  readPath,
} from './object';

describe('object helpers', () => {
  test('normalizes records and arrays defensively', () => {
    expect(asRecord({ ok: true })).toEqual({ ok: true });
    expect(asRecord(null)).toEqual({});
    expect(asArray(['a'])).toEqual(['a']);
    expect(asArray({ not: 'array' })).toEqual([]);
  });

  test('reads common identity, title, and status fields', () => {
    const provider = {
      providerId: 'openai',
      label: 'OpenAI',
      authFreshness: 'healthy',
    };

    expect(bestId(provider)).toBe('openai');
    expect(bestTitle(provider)).toBe('OpenAI');
    expect(bestStatus(provider)).toBe('healthy');
  });

  test('reads nested paths and first matching typed fields', () => {
    const payload = {
      session: {
        messages: [{ body: 'hello' }],
      },
      counts: {
        tasks: 3,
      },
    };

    expect(readPath(payload, ['session', 'messages'])).toEqual([{ body: 'hello' }]);
    expect(firstArray(payload.session, ['messages'])).toEqual([{ body: 'hello' }]);
    expect(firstArrayAtPath(payload, [['session', 'messages']])).toEqual([{ body: 'hello' }]);
    expect(firstString(payload.session.messages[0], ['body'])).toBe('hello');
    expect(countFrom(payload.counts, ['tasks'])).toBe(3);
  });

  test('serializes compact debug JSON', () => {
    expect(compactJson({ ok: true })).toContain('"ok": true');
  });

  test('formats byte sizes honestly, never fabricating a value for a missing one', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(151_396)).toBe('147.8 KB');
    expect(formatBytes(149_815_296)).toBe('142.9 MB');
    expect(formatBytes(1_181_116_006)).toBe('1.1 GB');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});
