/** Jev reads schedule meaning; code owns quantities, calendars and validation. */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { askAs, checkEachFixture, choice, decisionHeader, fixtureCheck, readChoice, recordAction, recordReadings, type CallOptions, type ChoiceCriteria, type JudgmentPort, type NamedDecision } from '@goodvibes-jev/judgment/decisions';
import { getNextAutomationOccurrence, normalizeAtSchedule, normalizeCronSchedule, normalizeEverySchedule, type AutomationScheduleDefinition } from './schedules.js';

const SCHEDULE_READING_NAME = 'automation.schedule';
const SCHEDULE_READING_HEADER = { name: SCHEDULE_READING_NAME, version: 1, description: 'Read one supported schedule from the complete phrase and source clock/timezone.', accuracyFloor: 0.95 };
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

const BAND = { actAt: 0.95, confirmAt: 0.95 };
const UNKNOWN = 'Unknown, ambiguous, contradictory, negated, invalid, or not exactly representable by the offered choices. Never approximate.';
const range = (max: number): Record<string, string> => Object.fromEntries(Array.from({ length: max }, (_, n) => [String(n), String(n)]));
const UNITS: Readonly<Record<string, number>> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };

export interface ScheduleReadingInput {
  readonly phrase: string;
  /** Captured once at submission; transport retries must not move a relative schedule. */
  readonly now: number;
  /** Actual source timezone, including the local IANA zone when no override was supplied. */
  readonly timezone: string;
  readonly staggerMs?: number | undefined;
}
type ScheduleConclusion =
  | { readonly kind: 'ready'; readonly schedule: AutomationScheduleDefinition }
  | { readonly kind: 'unknown'; readonly reason: 'unsupported' | 'unqualified' | 'invalid' };
export type ScheduleReading = ScheduleConclusion & { readonly confidence: number | null };

/** Lexical candidates only. Jev, never token position or an English regex, assigns their role. */
function quantityCandidates(phrase: string) {
  const candidates = [{ id: 'one', value: 1, literal: null as string | null, start: null as number | null, end: null as number | null }];
  for (const match of phrase.matchAll(/[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    candidates.push({ id: `literal_${candidates.length}`, value: Number(match[0]), literal: match[0], start: match.index, end: match.index + match[0].length });
  }
  return candidates;
}

/**
 * Same closed-parts pattern as the foundation date reader, in one batched call.
 * All supported historical families are retained; unsupported free-form dates,
 * compound intervals and unoffered word amounts stay unknown, never rounded.
 * The port alone owns transport retry. Failure/cancellation is operational, not
 * a semantic answer; no confirm/escalate reading becomes a human question.
 */
interface NaturalLanguageScheduleDecision extends NamedDecision {
  read(input: ScheduleReadingInput, options?: CallOptions & { readonly port?: JudgmentPort }): Promise<ScheduleReading>;
}

export const scheduleReading: NaturalLanguageScheduleDecision = {
  ...decisionHeader({ ...SCHEDULE_READING_HEADER, fixtures }),
  async read(input, options = {}) {
    const source = Object.freeze({ phrase: input.phrase, now: input.now, timezone: input.timezone,
      ...(input.staggerMs === undefined ? {} : { staggerMs: input.staggerMs }) });
    options.signal?.throwIfAborted();
    if (!source.phrase.trim() || !Number.isSafeInteger(source.now) || source.now <= 0 || !Number.isFinite(new Date(source.now).getTime())) return { kind: 'unknown', reason: 'invalid', confidence: null };
    // Validate the source zone before any semantic request; no guessed UTC fallback.
    new Intl.DateTimeFormat('en-US', { timeZone: source.timezone }).format(source.now);
    const quantities = quantityCandidates(source.phrase);
    const questions = {
      shape: choice('Which single schedule does the entire phrase request? Preserve the distinction between a fixed interval (every day) and calendar recurrence (daily). Reject multiple schedules, negation, contradictions and unsupported dates; do not ignore any qualifier.', {
        interval: 'A fixed interval: every N seconds/minutes/hours/days, or every singular unit (N=1).',
        delay: 'Once after N seconds/minutes/hours/days from the source clock.',
        hourly: 'Hourly, on the hour.',
        daily: 'Every calendar day at a time (midnight for bare daily).',
        weekly: 'Every calendar week on Sunday at a time (midnight for bare weekly).',
        weekdays: 'Every Monday through Friday at a time (midnight if unstated).',
        weekends: 'Every Saturday and Sunday at a time (midnight if unstated).',
        weekday: 'Every occurrence of one named weekday at a time (midnight if unstated).',
        next_time: 'Once at the next occurrence of a stated time of day, today or a later day if already past.',
        unknown: UNKNOWN,
      }),
      complete: choice('Can the complete phrase be represented exactly by one offered shape and its offered quantities, units and time parts in source.timezone? All qualifiers must be satisfied. Invalid times (such as 25:00 or 13pm), conflicting alternatives, negation, other timezones, unsupported dates/amounts and uncertain intent require unknown. No missing part may be invented except the documented midnight/Sunday/singular-unit defaults.', { yes: 'Exactly representable.', unknown: UNKNOWN }),
      quantity: choice('For interval or delay, which exact quantity is requested? one means an explicitly singular unit or one. Other candidates carry literal source offsets; select only the literal that states the requested amount. Do not select a different number from elsewhere in the phrase. If no exact offered quantity represents it, choose unknown.', {
        ...Object.fromEntries(quantities.map(q => [q.id, q.literal === null ? 'Exactly one unit (singular unit or one).' : `${q.literal}, at UTF-16 offsets [${q.start}, ${q.end}). Numerical value ${q.value}.`])), unknown: UNKNOWN,
      }),
      unit: choice('For interval or delay, which fixed duration unit is requested? A day is exactly 24 hours, not a wall-clock recurrence.', { second: 'seconds', minute: 'minutes', hour: 'hours', day: 'days', unknown: UNKNOWN }),
      hour: choice('For calendar recurrence or next_time, what is the exact 24-hour hour? Convert a stated am/pm time. Midnight is the documented default only for an unstated recurring time. Invalid or ambiguous time requires unknown.', { ...range(24), unknown: UNKNOWN }),
      minute: choice('For calendar recurrence or next_time, what is the exact minute (0 through 59)? A stated whole hour means minute zero; midnight is the documented recurring default. Invalid or ambiguous time requires unknown.', { ...range(60), unknown: UNKNOWN }),
      weekday: choice('For the weekday shape, which single weekday is requested?', { '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday', '5': 'Friday', '6': 'Saturday', unknown: UNKNOWN }),
    };
    const port = options.port ?? judgmentPort(SCHEDULE_READING_NAME);
    const result = await askAs(port, SCHEDULE_READING_HEADER, 'date-parts', { source: { ...source, nowIso: new Date(source.now).toISOString(), localClock: new Intl.DateTimeFormat('en-CA', { timeZone: source.timezone, dateStyle: 'full', timeStyle: 'long' }).format(source.now) }, quantityCandidates: quantities }, questions, { ...options, site: options.site ?? SCHEDULE_READING_NAME });
    options.signal?.throwIfAborted();
    options.beforeAttempt?.();
    const parts = Object.fromEntries(Object.entries(result.answers).map(([key, answer]) => [key, readChoice<ChoiceCriteria>(answer, BAND)]));
    const finish = (conclusion: ScheduleConclusion): ScheduleReading => {
      const confidence = Math.min(...used.map(key => parts[key]?.confidence ?? 0));
      const reading = { ...conclusion, confidence };
      recordReadings(port, result, { parts, reading });
      recordAction(port, result.decisionId, reading.kind === 'ready' ? `schedule:${reading.schedule.kind}` : `unknown:${reading.reason}`);
      return reading;
    };
    const used = ['shape', 'complete'];
    const shape = parts.shape?.choice;
    if (shape === 'interval' || shape === 'delay') used.push('quantity', 'unit');
    else if (shape !== 'hourly') used.push('hour', 'minute');
    if (shape === 'weekday') used.push('weekday');
    if (used.some(key => !parts[key] || parts[key]!.outcome !== 'act')) return finish({ kind: 'unknown', reason: 'unqualified' });
    if (used.some(key => parts[key]!.choice === 'unknown') || parts.complete!.choice !== 'yes') return finish({ kind: 'unknown', reason: 'unsupported' });
    try {
      let schedule: AutomationScheduleDefinition;
      if (shape === 'interval' || shape === 'delay') {
        const amount = quantities.find(q => q.id === parts.quantity!.choice)?.value;
        const unit = UNITS[parts.unit!.choice];
        const duration = (amount ?? NaN) * (unit ?? NaN);
        if (!Number.isSafeInteger(duration) || duration <= 0) throw new RangeError('Invalid duration');
        const at = source.now + duration;
        if (shape === 'delay' && (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime()))) throw new RangeError('Invalid timestamp');
        schedule = shape === 'interval' ? normalizeEverySchedule(duration) : normalizeAtSchedule(at);
      } else {
        const hour = Number(parts.hour?.choice); const minute = Number(parts.minute?.choice);
        if (shape !== 'hourly' && (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59)) throw new RangeError('Invalid time');
        const dow = shape === 'weekly' ? '0' : shape === 'weekdays' ? '1-5' : shape === 'weekends' ? '0,6' : shape === 'weekday' ? parts.weekday!.choice : '*';
        if (shape === 'weekday' && !['0', '1', '2', '3', '4', '5', '6'].includes(dow)) throw new RangeError('Invalid weekday');
        if (!['hourly', 'daily', 'weekly', 'weekdays', 'weekends', 'weekday', 'next_time'].includes(shape ?? '')) throw new RangeError('Invalid shape');
        const cron = normalizeCronSchedule(shape === 'hourly' ? '0 * * * *' : `${minute} ${hour} * * ${dow}`, source.timezone, shape === 'next_time' ? 0 : source.staggerMs);
        schedule = shape === 'next_time' ? normalizeAtSchedule(getNextAutomationOccurrence(cron, source.now)!) : cron;
      }
      return finish({ kind: 'ready', schedule });
    } catch {
      return finish({ kind: 'unknown', reason: 'invalid' });
    }
  },
  checkFixtures: (port, options = {}) => checkEachFixture(fixtures, options, async (fixture, run) => {
    const input: ScheduleReadingInput = { phrase: fixture.phrase, now, timezone: 'timezone' in fixture ? fixture.timezone! : 'UTC' };
    const reading = await scheduleReading.read(input, { ...run, port });
    const got = reading.kind === 'unknown' ? 'unknown' : reading.schedule.kind === 'cron' ? `cron:${reading.schedule.expression}`
      : reading.schedule.kind === 'every' ? `every:${reading.schedule.intervalMs}` : `at:${reading.schedule.at}`;
    return fixtureCheck(fixture.name, 'schedule', fixture.expect, got, reading.confidence ?? 0, reading.kind === 'ready' ? 'act' : 'escalate');
  }),
};

/** Public entry point delegates to the exact owner registered for calibration. */
export function readNaturalLanguageSchedule(
  input: ScheduleReadingInput,
  options: CallOptions & { readonly port?: JudgmentPort } = {},
): Promise<ScheduleReading> {
  return scheduleReading.read(input, options);
}
