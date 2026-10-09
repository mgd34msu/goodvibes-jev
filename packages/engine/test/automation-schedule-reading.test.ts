import { describe, expect, test } from 'bun:test';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { readNaturalLanguageSchedule } from '@goodvibes-jev/engine/sdk/platform/automation';

const now = Date.parse('2026-07-10T23:50:00Z');
function fixture(parts: Record<string, string>, weak?: string) {
  return fakePort((name, question) => choiceAnswer(question, parts[name] ?? (name === 'complete' ? 'yes' : 'unknown'), name === weak ? 0.7 : 0.99));
}
async function read(phrase: string, parts: Record<string, string>, timezone = 'UTC', clock = now) {
  const f = fixture(parts);
  return { result: await readNaturalLanguageSchedule({ phrase, now: clock, timezone }, { port: f.port }), ...f };
}

describe('engine-owned natural-language schedule reading', () => {
  test.each([
    ['every weekday at 9am', 'weekdays', '9', '0', 'unknown', '0 9 * * 1-5'],
    ['on each working day, run at nine in the morning', 'weekdays', '9', '0', 'unknown', '0 9 * * 1-5'],
    ['daily at 6pm', 'daily', '18', '0', 'unknown', '0 18 * * *'],
    ['every day at 08:30', 'daily', '8', '30', 'unknown', '30 8 * * *'],
    ['every monday at 9am', 'weekday', '9', '0', '1', '0 9 * * 1'],
    ['every weekend at 10am', 'weekends', '10', '0', 'unknown', '0 10 * * 0,6'],
    ['hourly', 'hourly', 'unknown', 'unknown', 'unknown', '0 * * * *'],
    ['daily', 'daily', '0', '0', 'unknown', '0 0 * * *'],
    ['weekly', 'weekly', '0', '0', 'unknown', '0 0 * * 0'],
  ])('%s uses qualified parts, not an English phrase matcher', async (phrase, shape, hour, minute, weekday, expression) => {
    const { result, requests } = await read(phrase, { shape, hour, minute, weekday }, 'America/New_York');
    expect(result).toMatchObject({ kind: 'ready', schedule: { kind: 'cron', expression, timezone: 'America/New_York' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toMatchObject({ source: { phrase, now, timezone: 'America/New_York' } });
  });

  test.each([
    ['every 30 minutes', 'interval', 'literal_1', 'minute', 1_800_000],
    ['repeat each 30 minutes', 'interval', 'literal_1', 'minute', 1_800_000],
    ['every hour', 'interval', 'one', 'hour', 3_600_000],
    ['every day', 'interval', 'one', 'day', 86_400_000],
    ['in 2 hours', 'delay', 'literal_1', 'hour', 7_200_000],
  ])('%s preserves exact duration arithmetic', async (phrase, shape, quantity, unit, duration) => {
    const { result } = await read(phrase, { shape, quantity, unit });
    expect(result).toMatchObject({ kind: 'ready', schedule: shape === 'delay' ? { kind: 'at', at: now + duration } : { kind: 'every', intervalMs: duration } });
  });

  test('literal provenance retains signs, decimals, conflicting quantities and exact offsets', async () => {
    const phrase = 'every -2.5 or 30 minutes';
    const { result, requests } = await read(phrase, { shape: 'unknown', complete: 'unknown' });
    expect(result.kind).toBe('unknown');
    expect(requests[0]!.state).toMatchObject({ quantityCandidates: [
      { id: 'one', value: 1, literal: null, start: null, end: null },
      { id: 'literal_1', value: -2.5, literal: '-2.5', start: 6, end: 10 },
      { id: 'literal_2', value: 30, literal: '30', start: 14, end: 16 },
    ] });
  });

  test.each(['every 0 minutes', 'every -2 hours', 'every 1e100 days'])('%s fails deterministic ranges even with strong semantic answers', async phrase => {
    const { result } = await read(phrase, { shape: 'interval', quantity: 'literal_1', unit: 'minute' });
    expect(result).toMatchObject({ kind: 'unknown', reason: 'invalid' });
  });

  test.each(['shape', 'complete', 'quantity', 'unit'])('unqualified %s never becomes a partial schedule', async weak => {
    const f = fixture({ shape: 'interval', quantity: 'literal_1', unit: 'minute' }, weak);
    expect(await readNaturalLanguageSchedule({ phrase: 'every 30 minutes', now, timezone: 'UTC' }, { port: f.port })).toMatchObject({ kind: 'unknown', reason: 'unqualified' });
  });
  test.each(['hour', 'minute', 'weekday'])('unqualified %s never becomes a calendar schedule', async weak => {
    const f = fixture({ shape: 'weekday', hour: '9', minute: '0', weekday: '1' }, weak);
    expect((await readNaturalLanguageSchedule({ phrase: 'every Monday at nine', now, timezone: 'UTC' }, { port: f.port })).kind).toBe('unknown');
  });

  test.each(['later', 'every 20 or 30 minutes', 'do not schedule it daily', 'at 25:00', 'at 13pm', 'February 30 at noon', 'at 9am Tokyo time', 'every thirty-seven minutes'])('ambiguous or unsupported: %s has no regex fallback', async phrase => {
    const { result } = await read(phrase, { shape: 'unknown', complete: 'unknown' });
    expect(result.kind).toBe('unknown');
  });

  test('source zone determines rollover, not the process local day', async () => {
    const { result } = await read('at 9am', { shape: 'next_time', hour: '9', minute: '0' }, 'Asia/Tokyo');
    expect(result).toMatchObject({ kind: 'ready', schedule: { kind: 'at', at: Date.parse('2026-07-11T00:00:00Z') } });
  });
  test('DST spring gap uses the next real occurrence, without inventing a nonexistent time', async () => {
    const { result } = await read('at 2:30am', { shape: 'next_time', hour: '2', minute: '30' }, 'America/New_York', Date.parse('2026-03-08T05:00:00Z'));
    expect(result).toMatchObject({ kind: 'ready', schedule: { kind: 'at', at: Date.parse('2026-03-09T06:30:00Z') } });
  });
  test('DST repeated hour selects the next real occurrence after the captured clock', async () => {
    const { result } = await read('at 1:30am', { shape: 'next_time', hour: '1', minute: '30' }, 'America/New_York', Date.parse('2026-11-01T05:45:00Z'));
    expect(result).toMatchObject({ kind: 'ready', schedule: { kind: 'at', at: Date.parse('2026-11-01T06:30:00Z') } });
  });

  test('empty, invalid source clock, or invalid timezone do not ask Jev', async () => {
    const f = fixture({});
    expect((await readNaturalLanguageSchedule({ phrase: '', now, timezone: 'UTC' }, { port: f.port })).kind).toBe('unknown');
    expect((await readNaturalLanguageSchedule({ phrase: 'daily', now: NaN, timezone: 'UTC' }, { port: f.port })).kind).toBe('unknown');
    await expect(readNaturalLanguageSchedule({ phrase: 'daily', now, timezone: 'invalid/zone' }, { port: f.port })).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
});

test('schedule reading is discoverable for live calibration without implying a live pass', async () => {
  const { registry } = await import('../sdk/src/platform/automation/judgment-registry.ts');
  const decision = registry.list()[0]!;
  expect(decision.name).toBe('automation.schedule');
  expect(decision.fixtureCount).toBe(18);
  const f = fixture({ shape: 'unknown', complete: 'unknown' });
  const checks = await decision.checkFixtures(f.port);
  expect(checks).toHaveLength(18);
  expect(checks.some(check => !check.correct)).toBe(true);
  expect(checks.every(check => Number.isFinite(check.signal))).toBe(true);
  expect(f.requests.every(request => request.context?.battery === 'automation.schedule')).toBe(true);
});
