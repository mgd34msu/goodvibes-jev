import { describe, expect, test } from 'bun:test';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readNaturalLanguageSchedule } from '@goodvibes-jev/engine/sdk/platform/automation';

const now = Date.parse('2026-07-10T23:50:00Z');
function fixture(parts: Record<string, string>, weak?: string) {
  return fakePort((name, question) => question.type === 'noul' ? noulAnswer(name === weak ? 0.5 : parts[name] === 'yes' ? 0.99 : 0.01) : choiceAnswer(question, parts[name] ?? (name === 'format' ? 'natural' : 'unknown'), name === weak ? 0.7 : 0.99));
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
    expect(requests).toHaveLength(shape === 'hourly' ? 3 : 4);
    expect(requests[0]!.state).toBe(phrase);
    if (shape !== 'hourly') expect(requests[2]!.state).toMatchObject({ phrase, timezone: 'America/New_York' });
  });

  test.each([
    ['every 30 minutes', 'interval', 'stated', 'minute', 1_800_000],
    ['repeat each 30 minutes', 'interval', 'stated', 'minute', 1_800_000],
    ['every hour', 'interval', 'singular', 'hour', 3_600_000],
    ['every day', 'interval', 'singular', 'day', 86_400_000],
    ['in 2 hours', 'delay', 'stated', 'hour', 7_200_000],
  ])('%s preserves exact duration arithmetic', async (phrase, shape, quantity, unit, duration) => {
    const { result } = await read(phrase, { shape, quantity, unit });
    expect(result).toMatchObject({ kind: 'ready', schedule: shape === 'delay' ? { kind: 'at', at: now + duration } : { kind: 'every', intervalMs: duration } });
  });

  test('literal provenance retains signs, decimals, conflicting quantities and exact offsets', async () => {
    const phrase = 'every -2.5 or 30 minutes';
    const { result, requests } = await read(phrase, { shape: 'interval', quantity: 'unknown', unit: 'minute' });
    expect(result.kind).toBe('unknown');
    expect(requests[2]!.state).toMatchObject({ quantityCandidates: [
      { id: 'one', value: 1, literal: null, start: null, end: null },
      { id: 'literal_1', value: -2.5, literal: '-2.5', start: 6, end: 10 },
      { id: 'literal_2', value: 30, literal: '30', start: 14, end: 16 },
    ] });
  });

  test.each(['every 0 minutes', 'every -2 hours', 'every 1e100 days'])('%s fails deterministic ranges even with strong semantic answers', async phrase => {
    const { result } = await read(phrase, { shape: 'interval', quantity: 'stated', unit: 'minute' });
    expect(result).toMatchObject({ kind: 'unknown', reason: 'invalid' });
  });

  test('an interval never requests unused calendar parts', async () => {
    const { result, requests } = await read('every 30 minutes', { shape: 'interval', quantity: 'stated', unit: 'minute' });
    expect(result.kind).toBe('ready');
    expect(requests.map(request => Object.keys(request.questions))).toEqual([['format'], ['shape'], ['quantity', 'unit'], ['complete', 'timing', 'conditions']]);
  });

  test('a retired owner cannot start the shape or parts request', async () => {
    const abort = new AbortController();
    const f = fakePort((name, question) => {
      abort.abort();
      return choiceAnswer(question, 'natural', 0.99);
    });
    await expect(readNaturalLanguageSchedule({ phrase: 'every 30 minutes', now, timezone: 'UTC' }, { port: f.port, signal: abort.signal })).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
    expect(Object.keys(f.requests[0]!.questions)).toEqual(['format']);
  });

  test.each(['format', 'shape', 'quantity', 'unit'])('unqualified %s never becomes a partial schedule', async weak => {
    const f = fixture({ shape: 'interval', quantity: 'stated', unit: 'minute' }, weak);
    expect(await readNaturalLanguageSchedule({ phrase: 'every 30 minutes', now, timezone: 'UTC' }, { port: f.port })).toMatchObject({ kind: 'unknown', reason: 'unqualified' });
  });
  test.each(['hour', 'minute', 'weekday'])('unqualified %s never becomes a calendar schedule', async weak => {
    const f = fixture({ shape: 'weekday', hour: '9', minute: '0', weekday: '1' }, weak);
    expect((await readNaturalLanguageSchedule({ phrase: 'every Monday at nine', now, timezone: 'UTC' }, { port: f.port })).kind).toBe('unknown');
  });

  test.each(['later', 'every 20 or 30 minutes', 'do not schedule it daily', 'at 25:00', 'at 13pm', 'February 30 at noon', 'at 9am Tokyo time', 'every thirty-seven minutes', 'every 30 minutes except on weekends'])('ambiguous or unsupported: %s has no regex fallback', async phrase => {
    const { result } = await read(phrase, { shape: 'unknown', complete: 'unknown' });
    expect(result.kind).toBe('unknown');
  });

  test('source zone determines rollover, not the process local day', async () => {
    const { result } = await read('at 9am', { shape: 'next_time', hour: '9', minute: '0' }, 'Asia/Tokyo');
    expect(result).toMatchObject({ kind: 'ready', schedule: { kind: 'at', at: Date.parse('2026-07-11T00:00:00Z') } });
  });
  test.each(['2026-11-12T14:30Z', '2026-11-12T14:30:00Z', '2026-11-12T14:30:00.123+02:00'])('an exact zoned ISO timestamp is selected then validated: %s', async literal => {
    const phrase = `At ${literal} remind me to check the deploy.`;
    const { result, requests } = await read(phrase, { format: 'timestamp', timestamp: 'stated' });
    expect(result).toMatchObject({ kind: 'ready', schedule: { kind: 'at', at: Date.parse(literal) } });
    expect(requests.map(request => Object.keys(request.questions))).toEqual([['format'], ['timestamp'], ['complete', 'timing', 'conditions']]);
    expect(requests[1]!.state).toMatchObject({ timestampLiterals: { stated: literal } });
    expect(JSON.stringify(requests.map(request => request.questions))).not.toContain(literal);
  });
  test.each(['0 9 * * 1-5', '*/15 9-17 * * 1-5'])('a literal cron uses the actual cron validator: %s', async expression => {
    const { result, requests } = await read(`Run the audit with cron ${expression}.`, { format: 'cron', cron: 'stated' }, 'America/New_York');
    expect(result).toMatchObject({ kind: 'ready', schedule: { kind: 'cron', expression, timezone: 'America/New_York' } });
    expect(requests.map(request => Object.keys(request.questions))).toEqual([['format'], ['cron'], ['complete', 'timing', 'conditions']]);
  });
  test('Jev selects the requested timestamp after a quoted example', async () => {
    const phrase = 'The example says "at 2026-11-11T09:00:00Z". Remind me at 2026-11-12T14:30:00Z.';
    const { result, requests } = await read(phrase, { format: 'timestamp', timestamp: 'candidate_2' });
    expect(result).toMatchObject({ kind: 'ready', schedule: { kind: 'at', at: Date.parse('2026-11-12T14:30:00Z') } });
    expect(requests[1]!.state).toMatchObject({ timestampLiterals: { candidate_1: '2026-11-11T09:00:00Z', candidate_2: '2026-11-12T14:30:00Z' } });
  });
  test('Jev selects the requested cron after a quoted example', async () => {
    const phrase = 'The example uses "cron 0 8 * * *". Run the audit with cron 0 9 * * 1-5.';
    const { result } = await read(phrase, { format: 'cron', cron: 'candidate_2' });
    expect(result).toMatchObject({ kind: 'ready', schedule: { kind: 'cron', expression: '0 9 * * 1-5' } });
  });
  test.each(['2026-02-30T14:30:00Z', '2025-02-29T14:30:00Z', '2026-11-12T24:00:00Z', '2026-11-12T14:30:60Z', '2026-11-12T14:30:00+25:00'])('strong ISO role cannot authorize an impossible timestamp: %s', async literal => {
    const { result } = await read(`Remind me at ${literal}.`, { format: 'timestamp', timestamp: 'stated' });
    expect(result).toMatchObject({ kind: 'unknown', reason: 'invalid' });
  });
  test('an ISO timestamp without an explicit zone remains unsupported', async () => {
    const { result } = await read('At 2026-11-12T14:30:00 remind me.', { format: 'timestamp', timestamp: 'unknown' });
    expect(result).toMatchObject({ kind: 'unknown', reason: 'unsupported' });
  });
  test('strong cron role cannot authorize out-of-range fields', async () => {
    const { result } = await read('Run the audit with cron 99 9 * * 1-5.', { format: 'cron', cron: 'stated' });
    expect(result).toMatchObject({ kind: 'unknown', reason: 'invalid' });
  });
  test('a six-field cron cannot bypass the scheduler five-field grammar', async () => {
    const { result } = await read('Run the audit with cron 0 0 9 * * 1-5.', { format: 'cron', cron: 'stated' });
    expect(result).toMatchObject({ kind: 'unknown', reason: 'invalid' });
  });
  test.each(['timestamp', 'cron'])('an unqualified exact %s role never becomes a schedule', async format => {
    const phrase = format === 'timestamp' ? 'At 2026-11-12T14:30:00Z remind me.' : 'Run the audit with cron 0 9 * * 1-5.';
    const f = fixture({ format, [format]: 'stated' }, format);
    expect(await readNaturalLanguageSchedule({ phrase, now, timezone: 'UTC' }, { port: f.port })).toMatchObject({ kind: 'unknown', reason: 'unqualified' });
  });
  test('protected phrase material is refused before port use', async () => {
    const f = fixture({ shape: 'interval', quantity: 'stated', unit: 'minute' });
    await expect(readNaturalLanguageSchedule({ phrase: 'Every 30 minutes; card 4111111111111111.', now, timezone: 'UTC' }, { port: f.port })).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
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
  expect(decision.fixtureCount).toBeGreaterThanOrEqual(35);
  const f = fixture({ shape: 'unknown', complete: 'unknown' });
  const checks = await decision.checkFixtures(f.port);
  expect(checks).toHaveLength(decision.fixtureCount);
  expect(checks.some(check => !check.correct)).toBe(true);
  expect(checks.every(check => Number.isFinite(check.signal))).toBe(true);
  expect(f.requests.every(request => request.context?.battery === 'automation.schedule')).toBe(true);
});
