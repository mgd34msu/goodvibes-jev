import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, type ChoiceQuestion, type JudgmentPort } from '../port/types.ts';
import { assertConfidenceBand, outcomeForConfidence, type ConfidenceBand, type Outcome } from '../readings/bands.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from './common.ts';

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** Years offered as options: a century back and thirty years ahead of today. */
const YEARS_BACK = 100;
const YEARS_AHEAD = 30;

/**
 * Date-parts extraction (the date extraction cookbook). Jev reads dates as
 * text and is unreliable at comparing them, so it only reads the parts, each
 * a small closed Choice with an explicit "none" so a missing part is reported
 * rather than guessed. Code assembles the date, resolves relative references
 * against a given today, fills in an unstated year, and owns every comparison.
 */
export interface DatePartsSpec extends PatternHeader {
  /** Confidence floor on the weakest part used; below it the date goes to review. */
  readonly band: ConfidenceBand;
  readonly fixtures: readonly {
    readonly name: string;
    readonly document: string;
    /** The date wanted, e.g. "the deadline to return the form". */
    readonly role: string;
    /** YYYY-MM-DD the relative references resolve against. */
    readonly today: string;
    /** YYYY-MM-DD, or 'none' when the document does not state it. */
    readonly expect: string;
  }[];
}

export interface ExtractedDate {
  /** YYYY-MM-DD, or null when the parts do not make a date. */
  readonly date: string | null;
  /** The weakest confidence among the parts used, or null when none was used. */
  readonly confidence: number | null;
  readonly outcome: Outcome;
  /** Why the date is missing, when it is. */
  readonly note: string;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

export interface DatePartsReader extends NamedDecision {
  extract(port: JudgmentPort, document: string, role: string, today: string, options?: CallOptions): Promise<ExtractedDate>;
}

type Part = { readonly choice: string; readonly confidence: number };
type Parts = Readonly<Record<'mode' | 'month' | 'day' | 'year' | 'day_anchor' | 'weekday' | 'week_offset', Part>>;

const ABSENT = 'The document does not state this, or it is not this kind of date.';

export function dateQuestions(role: string, todayYear: number): Readonly<Record<keyof Parts, ChoiceQuestion>> {
  const years: Record<string, string | null> = {};
  for (let year = todayYear - YEARS_BACK; year <= todayYear + YEARS_AHEAD; year++) years[String(year)] = null;
  return {
    mode: choice(
      `How is ${role} written? 'absolute' is a calendar date naming a month (e.g. 'August 14', 'the 3rd of March'); 'relative' is given relative to today (today, tomorrow, the day after tomorrow, or a named weekday such as 'next Thursday'); 'none' means the document does not state this date.`,
      { absolute: null, relative: null, none: null },
    ),
    month: choice(`If ${role} is an absolute calendar date, which month is it in?`, {
      ...Object.fromEntries(MONTHS.map((month) => [month, null])),
      none: ABSENT,
    }),
    day: choice(`If ${role} is an absolute calendar date, which day of the month (1-31)?`, {
      ...Object.fromEntries(Array.from({ length: 31 }, (_, i) => [String(i + 1), null])),
      none: ABSENT,
    }),
    year: choice(
      `If ${role} is an absolute calendar date, which year? Pick 'none' if the document states no year, or 'out_of_range' if a year is stated but not in the list.`,
      {
        ...years,
        out_of_range: 'A year is stated for this date but is outside the listed range.',
        none: 'No year is stated for this date.',
      },
    ),
    day_anchor: choice(
      `If ${role} is relative to today, which day is it? 'today', 'tomorrow', 'day_after' (the day after tomorrow), or 'weekday' (a named day of the week).`,
      { today: null, tomorrow: null, day_after: null, weekday: null, none: ABSENT },
    ),
    weekday: choice(`If ${role} names a day of the week, which one?`, {
      ...Object.fromEntries(WEEKDAYS.map((day) => [day, null])),
      none: ABSENT,
    }),
    week_offset: choice(
      `If ${role} names a weekday, which week is it in? 'next' for 'next Thursday' or 'Thursday next week'; 'current' for 'this Thursday'; 'none' for a bare weekday with no qualifier.`,
      { current: null, next: null, none: ABSENT },
    ),
  };
}

const DAY_MS = 86_400_000;

function parseDay(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) throw new RangeError(`"${iso}" is not a YYYY-MM-DD date`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== iso) throw new RangeError(`"${iso}" is not a real date`);
  return date;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
/** Monday = 0 ... Sunday = 6. */
const weekdayIndex = (date: Date): number => (date.getUTCDay() + 6) % 7;

/** A calendar date, or null when the parts do not form one (February 30). */
function calendarDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/**
 * Which date a named weekday points to: a bare weekday is the next one on or
 * after today; 'next' is that weekday in the following calendar week;
 * 'current' is that weekday in this calendar week.
 */
export function resolveWeekday(today: Date, weekday: (typeof WEEKDAYS)[number], weekOffset: string): Date {
  const target = WEEKDAYS.indexOf(weekday);
  const monday = addDays(today, -weekdayIndex(today));
  if (weekOffset === 'next') return addDays(monday, 7 + target);
  if (weekOffset === 'current') return addDays(monday, target);
  return addDays(today, (target - weekdayIndex(today) + 7) % 7);
}

/** Builds the date from the parts, in code. Confidence is the weakest part the shape used. */
export function assembleDate(
  parts: Parts,
  today: Date,
  band: ConfidenceBand,
): { date: string | null; confidence: number | null; outcome: Outcome; note: string } {
  const used: number[] = [parts.mode.confidence];
  const done = (date: Date | null, note = '') => {
    const confidence = Math.min(...used);
    return {
      date: date === null ? null : isoDay(date),
      confidence,
      outcome: date === null ? ('escalate' as const) : outcomeForConfidence(confidence, band),
      note,
    };
  };
  const mode = parts.mode.choice;
  if (mode === 'none') return done(null, 'no such date stated');
  if (mode === 'absolute') {
    used.push(parts.month.confidence, parts.day.confidence, parts.year.confidence);
    const monthIndex = MONTHS.indexOf(parts.month.choice as (typeof MONTHS)[number]);
    const day = Number(parts.day.choice);
    if (monthIndex < 0 || !Number.isInteger(day)) return done(null, 'absolute date incomplete');
    if (parts.year.choice === 'out_of_range') return done(null, 'year outside the listed range');
    if (parts.year.choice === 'none') {
      const thisYear = calendarDate(today.getUTCFullYear(), monthIndex + 1, day);
      if (thisYear === null) return done(null, `impossible date: ${parts.month.choice} ${day}`);
      // No year stated: this year, moved to next year when it is more than a month past.
      if (thisYear.getTime() < today.getTime() - 31 * DAY_MS) {
        return done(calendarDate(today.getUTCFullYear() + 1, monthIndex + 1, day));
      }
      return done(thisYear);
    }
    const stated = calendarDate(Number(parts.year.choice), monthIndex + 1, day);
    return stated === null ? done(null, `impossible date: ${parts.year.choice}-${parts.month.choice}-${day}`) : done(stated);
  }
  if (mode === 'relative') {
    used.push(parts.day_anchor.confidence);
    const anchor = parts.day_anchor.choice;
    if (anchor === 'today') return done(today);
    if (anchor === 'tomorrow') return done(addDays(today, 1));
    if (anchor === 'day_after') return done(addDays(today, 2));
    if (anchor === 'weekday') {
      used.push(parts.weekday.confidence, parts.week_offset.confidence);
      if (!WEEKDAYS.includes(parts.weekday.choice as (typeof WEEKDAYS)[number])) return done(null, 'relative weekday not read');
      return done(resolveWeekday(today, parts.weekday.choice as (typeof WEEKDAYS)[number], parts.week_offset.choice));
    }
    return done(null, 'relative day not read');
  }
  return done(null, `unrecognized mode: ${mode}`);
}

export function defineDatePartsReader(spec: DatePartsSpec): DatePartsReader {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  assertConfidenceBand(spec.band);
  for (const fixture of spec.fixtures) {
    parseDay(fixture.today);
    if (fixture.expect !== 'none') parseDay(fixture.expect);
  }

  const reader: DatePartsReader = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async extract(port, document, role, today, options = {}) {
      const todayDate = parseDay(today);
      const questions = dateQuestions(role, todayDate.getUTCFullYear());
      const result = await askAs(port, spec, 'date-parts', document, questions, options);
      const parts = Object.fromEntries(
        Object.entries(result.answers).map(([name, answer]) => [name, { choice: answer.choice, confidence: answer.confidence }]),
      ) as Parts;
      const assembled = assembleDate(parts, todayDate, spec.band);
      recordReadings(port, result, { ...assembled, today, parts });
      return { ...assembled, decisionId: result.decisionId, recordAction: (a) => recordAction(port, result.decisionId, a) };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const got = await reader.extract(port, fixture.document, fixture.role, fixture.today, { site: 'calibration', ...options });
        const gotDate = got.date ?? 'none';
        checks.push({
          fixture: fixture.name,
          aspect: 'date',
          expected: fixture.expect,
          got: gotDate,
          correct: gotDate === fixture.expect,
          signal: got.confidence ?? 0,
          outcome: got.outcome,
        });
      }
      return checks;
    },
  };
  return reader;
}
