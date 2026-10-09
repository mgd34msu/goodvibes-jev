import { describe, expect, test } from 'bun:test';
import { getNextAutomationOccurrence, normalizeCronSchedule } from '@goodvibes-jev/engine/sdk/platform/automation';

describe('automation cron uses requested timezone boundaries', () => {
  test.each([
    ['Monday west of UTC', '0 9 * * 1', 'America/New_York', '2026-07-10T23:50:00Z', '2026-07-13T13:00:00Z'],
    ['Sunday west of UTC', '0 0 * * 0', 'America/New_York', '2026-07-10T23:50:00Z', '2026-07-12T04:00:00Z'],
    ['weekday wraps east of UTC', '0 9 * * 1', 'Pacific/Auckland', '2026-07-12T22:00:00Z', '2026-07-19T21:00:00Z'],
    ['fractional-hour zone', '0 9 * * *', 'Asia/Kathmandu', '2026-07-10T23:50:00Z', '2026-07-11T03:15:00Z'],
    ['month boundary in requested zone', '0 9 1 8 *', 'Asia/Kathmandu', '2026-07-31T21:00:00Z', '2026-08-01T03:15:00Z'],
    ['strictly after matching time', '0 9 * * *', 'Asia/Kathmandu', '2026-07-11T03:15:00Z', '2026-07-12T03:15:00Z'],
    ['DST gap', '30 2 * * *', 'America/New_York', '2026-03-08T05:00:00Z', '2026-03-09T06:30:00Z'],
    ['DST fold after first occurrence', '30 1 * * *', 'America/New_York', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'],
  ])('%s', (_name, expression, timezone, after, expected) => {
    const schedule = normalizeCronSchedule(expression, timezone, 0);
    expect(getNextAutomationOccurrence(schedule, Date.parse(after))).toBe(Date.parse(expected));
  });
});

describe('requested-zone cron is independent of process-local DST setters', () => {
  test.each([
    ['America/New_York', 'America/New_York', '30 1 * * *', '2026-11-01T06:15:00Z', '2026-11-01T06:30:00Z'],
    ['America/New_York', 'America/New_York', '30 1 * * *', '2026-11-01T05:45:00Z', '2026-11-01T06:30:00Z'],
    ['America/New_York', 'UTC', '30 6 * * *', '2026-11-01T05:45:00Z', '2026-11-01T06:30:00Z'],
    ['America/New_York', 'America/New_York', '30 1 * * *', '2026-11-01T06:30:00Z', '2026-11-02T06:30:00Z'],
    ['Pacific/Auckland', 'Asia/Kathmandu', '0 9 * * *', '2026-07-11T03:15:00Z', '2026-07-12T03:15:00Z'],
  ])('process %s, requested %s, %s after %s', (processZone, timezone, expression, after, expected) => {
    const source = new URL('../sdk/src/platform/scheduler/scheduler.ts', import.meta.url).pathname;
    const script = `import { TaskScheduler } from ${JSON.stringify(source)}; const from = ${Date.parse(after)}; const next = new TaskScheduler('unused-test-store.json').getNextRun(${JSON.stringify(expression)}, new Date(from), ${JSON.stringify(timezone)}).getTime(); console.log(JSON.stringify({ next, after: from, forward: next > from }));`;
    // A broken local-calendar advance used to loop forever. Bound the owned
    // child so that regression fails rather than hanging the entire test lane.
    const result = Bun.spawnSync([process.execPath, '--eval', script], { env: { ...process.env, TZ: processZone }, stdout: 'pipe', stderr: 'pipe', timeout: 2000 });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ next: Date.parse(expected), after: Date.parse(after), forward: true });
  });
});
