/** Discoverable calibration fixtures; deterministic source tests do not claim a live model pass. */
import { BatteryRegistry, checkEachFixture, fixtureCheck } from '@goodvibes-jev/judgment';
import { readNaturalLanguageSchedule, scheduleReadingHeader, type ScheduleReadingInput } from './schedule-reading.js';

const now = Date.parse('2026-07-10T23:50:00Z');
const fixtures = [
  { name: 'weekday morning', phrase: 'every weekday at 9am', expect: 'cron:0 9 * * 1-5' },
  { name: 'weekday paraphrase', phrase: 'on each working day, run at nine in the morning', expect: 'cron:0 9 * * 1-5' },
  { name: 'fixed interval', phrase: 'every 30 minutes', expect: 'every:1800000' },
  { name: 'singular interval', phrase: 'every hour', expect: 'every:3600000' },
  { name: 'relative delay', phrase: 'in 2 hours', expect: `at:${now + 7_200_000}` },
  { name: 'calendar daily', phrase: 'daily at 6pm', expect: 'cron:0 18 * * *' },
  { name: 'weekly default', phrase: 'weekly', expect: 'cron:0 0 * * 0' },
  { name: 'weekend', phrase: 'every weekend at 10am', expect: 'cron:0 10 * * 0,6' },
  { name: 'named weekday', phrase: 'every monday at 8:30', expect: 'cron:30 8 * * 1' },
  { name: 'source zone rollover', phrase: 'at 9am', timezone: 'Asia/Tokyo', expect: `at:${Date.parse('2026-07-11T00:00:00Z')}` },
  ...['later', 'every 20 or 30 minutes', 'do not schedule it daily', 'at 25:00', 'at 13pm', 'February 30 at noon', 'at 9am Tokyo time', 'every thirty-seven minutes'].map(phrase => ({ name: phrase, phrase, expect: 'unknown' })),
];
export const registry = new BatteryRegistry();
registry.register({
  ...scheduleReadingHeader,
  fixtureCount: fixtures.length,
  checkFixtures: (port, options = {}) => checkEachFixture(fixtures, options, async (fixture, run) => {
    const input: ScheduleReadingInput = { phrase: fixture.phrase, now, timezone: 'timezone' in fixture ? fixture.timezone! : 'UTC' };
    const reading = await readNaturalLanguageSchedule(input, { ...run, port });
    const got = reading.kind === 'unknown' ? 'unknown' : reading.schedule.kind === 'cron' ? `cron:${reading.schedule.expression}`
      : reading.schedule.kind === 'every' ? `every:${reading.schedule.intervalMs}` : `at:${reading.schedule.at}`;
    return fixtureCheck(fixture.name, 'schedule', fixture.expect, got, reading.confidence ?? 0, reading.kind === 'ready' ? 'act' : 'escalate');
  }),
});
