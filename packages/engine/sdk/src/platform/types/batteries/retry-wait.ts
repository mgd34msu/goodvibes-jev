/**
 * `engine.provider.retry-wait`: which number in a provider's error message,
 * if any, states how long to wait before retrying, and in which unit it is
 * stated (milliseconds, seconds or minutes)? Read by Jev in place of the
 * regex the ProviderError constructor ran on every 429 message
 * (`retry[-_\s]?after[:=\s]+(\d+)`, taken as seconds), which missed "try
 * again in 20s", "retryDelay": "17s" and "retry in 2 minutes", and read a
 * millisecond value as seconds.
 *
 * A candidate selection plus a unit choice, all in one request (the
 * skill-suggestion cookbook's two-question shape, with the unit beside it):
 * one Choice over the number spans and "none", one Noul per span on whether
 * it is the wait, and one Choice for the unit. The spans are found by a
 * number tokenizer ({@link numberSpans}), grammar, not a decision. Code turns
 * the chosen number and unit into milliseconds. The questions, criteria,
 * bands and fixtures live here.
 *
 * Bands: low stakes. A wrong wait mistimes one cooldown or one "Retry in"
 * line, and the provider's next response corrects it.
 */
import {
  askAs,
  checkEachFixture,
  choice,
  decisionHeader,
  fixtureCheck,
  LIMITS,
  NONE,
  noul,
  readChoice,
  readYesNo,
  recordAction,
  recordReadings,
  STAKES_BANDS,
  type CallOptions,
  type ChoiceReading,
  type EntryType,
  type FixtureCheck,
  type JudgmentPort,
  type NamedDecision,
  type NoulResponse,
  type Outcome,
  type Question,
  type YesNoReading,
} from '@goodvibes-jev/judgment/decisions';
import { judgmentPort } from '@goodvibes-jev/engine/errors';

const LOW = STAKES_BANDS.low;

const PICK_BAND = LOW.confidence;
const FIT_BAND = LOW.yesNo;
const UNIT_BAND = LOW.confidence;

const PICK_INSTRUCTIONS =
  '`message` is an error message a model provider returned; `status` is its HTTP status when known. Each entry of `numbers` is one number written in the message, by id, with the text just before and after it. Which number is the time the provider says to wait before sending the request again? Choose none when no number in the message is such a wait.';
const NONE_OPTION = 'No number in the message is a wait before retrying: they are limits, counts, usage figures, codes, names or dates.';

const FIT_INSTRUCTIONS = 'Is number `number` the amount of time the provider says to wait before sending the request again?';
const FIT_CRITERIA = {
  true: 'The number is the length of the wait before retrying, as in "try again in 20s", "retry-after: 30", "retry_after_ms=1500" or "retryDelay": "17s".',
  false: 'The number is something else: a rate or quota limit, a count of tokens or requests, a usage figure, a status or error code, part of a model, organization or request id, or part of a date or time of day.',
} as const;

const UNIT_INSTRUCTIONS =
  'In which unit does `message` state the wait before retrying? Take the unit written with the number or named in its field; a bare Retry-After or retry_after value with no unit is in seconds.';
const UNIT_OPTIONS = {
  ms: 'Milliseconds: ms, millis, milliseconds, or a field named in milliseconds such as retry_after_ms',
  s: 'Seconds: s, sec, secs, seconds, or a bare Retry-After or retry_after value',
  min: 'Minutes: m, min, mins, minutes',
} as const;

export type RetryWaitUnit = keyof typeof UNIT_OPTIONS;

const UNIT_ANSWERS = Object.keys(UNIT_OPTIONS);

/** Milliseconds per unit; code does the conversion, never the model. */
const MS_PER_UNIT: Readonly<Record<RetryWaitUnit, number>> = { ms: 1, s: 1_000, min: 60_000 };

/** Long provider bodies say what they mean in their opening; the same clip the failure reading uses. */
export const MAX_RETRY_WAIT_MESSAGE_CHARS = 2_000;

/** Characters of text shown on each side of a number. */
const ADJACENT_CHARS = 32;

/** A Choice holds at most this many candidates beside its "none" option. */
const MAX_NUMBERS = LIMITS.maxChoiceOptions - 1;

/** One number written in a message: its id, where it sits, its text and value, and the text around it. */
export interface NumberSpan {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly value: number;
  readonly before: string;
  readonly after: string;
}

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';

/** Index just past the run of digits starting at `index`. */
function digitsEnd(text: string, index: number): number {
  let end = index;
  while (isDigit(text[end])) end += 1;
  return end;
}

/**
 * Every number written in `message`, in order, numbered `n1`, `n2`, ...: a
 * run of digits, with comma groups of exactly three digits ("1,500") and one
 * decimal part ("1.5") taken as part of it. Grammar only: nothing here
 * decides which number, if any, is a wait. A message with more numbers than
 * one Choice can hold offers the first ones that fit.
 */
export function numberSpans(message: string): NumberSpan[] {
  const spans: NumberSpan[] = [];
  let index = 0;
  while (index < message.length && spans.length < MAX_NUMBERS) {
    if (!isDigit(message[index])) {
      index += 1;
      continue;
    }
    const start = index;
    let end = digitsEnd(message, start);
    while (message[end] === ',' && digitsEnd(message, end + 1) - (end + 1) === 3) end = digitsEnd(message, end + 1);
    if (message[end] === '.' && isDigit(message[end + 1])) end = digitsEnd(message, end + 1);
    const text = message.slice(start, end);
    spans.push({
      id: `n${spans.length + 1}`,
      start,
      end,
      text,
      value: Number(text.replaceAll(',', '')),
      before: message.slice(Math.max(0, start - ADJACENT_CHARS), start),
      after: message.slice(end, end + ADJACENT_CHARS),
    });
    index = end;
  }
  return spans;
}

/** The error evidence a retry-wait reading is about. */
export interface RetryWaitEvidence {
  readonly message: string;
  readonly status?: number | undefined;
}

/** One reading: the chosen number and unit, the wait code made of them, and what code may do with it. */
export interface RetryWaitReading {
  /** The number the reading chose, when one reads as the wait. */
  readonly span: NumberSpan | undefined;
  readonly unit: ChoiceReading<RetryWaitUnit>;
  /** The chosen number in milliseconds; undefined when no number reads as the wait. */
  readonly waitMs: number | undefined;
  readonly outcome: Outcome;
  readonly pick: ChoiceReading;
  readonly fits: Readonly<Record<string, YesNoReading>>;
  recordAction(action: string): void;
}

export interface RetryWaitFixture {
  readonly name: string;
  readonly message: string;
  readonly status?: number;
  /** The wait the message states, as the number's exact text and its unit, or none. */
  readonly expect: typeof NONE | { readonly number: string; readonly unit: RetryWaitUnit };
}

export interface RetryWait extends NamedDecision {
  /** Reads `evidence` over `spans` (from {@link numberSpans}); needs at least one span. */
  read(port: JudgmentPort, evidence: RetryWaitEvidence, spans: readonly NumberSpan[], options?: CallOptions): Promise<RetryWaitReading>;
}

const fitKey = (span: NumberSpan): string => `fits_${span.id}`;

function questionsFor(spans: readonly NumberSpan[]): Record<string, Question> {
  const options: Record<string, EntryType> = { ...Object.fromEntries(spans.map((span) => [span.id, null])), [NONE]: NONE_OPTION };
  const questions: Record<string, Question> = { pick: choice(PICK_INSTRUCTIONS, options), unit: choice(UNIT_INSTRUCTIONS, UNIT_OPTIONS) };
  for (const span of spans) questions[fitKey(span)] = noul({ question: FIT_INSTRUCTIONS, number: span.id }, FIT_CRITERIA);
  return questions;
}

const stateFor = (evidence: RetryWaitEvidence, spans: readonly NumberSpan[]) => ({
  ...(evidence.status === undefined ? {} : { status: evidence.status }),
  message: evidence.message,
  numbers: Object.fromEntries(spans.map((span) => [span.id, { number: span.text, before: span.before, after: span.after }])),
});

/**
 * What code may do with a reading. A confident none is itself an answer. A
 * chosen number stands only when its own Noul is a yes (a Choice always has a
 * winner), and acts only when the pick, its fit and the unit all act.
 */
function readingOutcome(pick: ChoiceReading, winnerFit: YesNoReading | undefined, unit: ChoiceReading): Outcome {
  if (pick.choice === NONE) return pick.outcome;
  if (winnerFit?.verdict !== 'yes') return 'escalate';
  const outcomes = [pick.outcome, winnerFit.outcome, unit.outcome];
  if (outcomes.includes('escalate')) return 'escalate';
  return outcomes.every((outcome) => outcome === 'act') ? 'act' : 'confirm';
}

/** The span a fixture's expected number names; exactly one must carry that text. */
function expectedSpan(fixture: RetryWaitFixture, spans: readonly NumberSpan[]): NumberSpan | undefined {
  if (fixture.expect === NONE) return undefined;
  const { number } = fixture.expect;
  const matches = spans.filter((span) => span.text === number);
  if (matches.length !== 1) throw new RangeError(`fixture ${fixture.name}: expected number "${number}" must appear exactly once, found ${matches.length}`);
  return matches[0];
}

export function defineRetryWait(spec: {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly accuracyFloor: number;
  readonly fixtures: readonly RetryWaitFixture[];
}): RetryWait {
  const header = decisionHeader(spec);
  for (const fixture of spec.fixtures) {
    if (numberSpans(fixture.message).length === 0) throw new RangeError(`decision ${spec.name}: fixture ${fixture.name} has no number to choose from`);
    expectedSpan(fixture, numberSpans(fixture.message));
  }

  const decision: RetryWait = {
    ...header,
    async read(port, evidence, spans, options = {}) {
      if (spans.length === 0) throw new RangeError(`decision ${spec.name}: needs at least one number span`);
      const result = await askAs(port, spec, 'battery', stateFor(evidence, spans), questionsFor(spans), options);
      const answers = result.answers as Record<string, unknown>;
      const pick = readChoice(answers['pick'] as Parameters<typeof readChoice>[0], PICK_BAND);
      const unit = readChoice(answers['unit'] as Parameters<typeof readChoice>[0], UNIT_BAND) as ChoiceReading<RetryWaitUnit>;
      const fits = Object.fromEntries(spans.map((span) => [span.id, readYesNo(answers[fitKey(span)] as NoulResponse, FIT_BAND)]));
      const winnerFit = fits[pick.choice];
      const outcome = readingOutcome(pick, winnerFit, unit);
      // A fitting winner is reported even when not acted on, so a reviewer sees what was read.
      const span = winnerFit?.verdict === 'yes' ? spans.find((entry) => entry.id === pick.choice) : undefined;
      const waitMs = span === undefined ? undefined : Math.round(span.value * MS_PER_UNIT[unit.choice]);
      recordReadings(port, result, { chosen: span?.text ?? null, unit, waitMs: waitMs ?? null, pick, fits });
      return { span, unit, waitMs, outcome, pick, fits, recordAction: (action) => recordAction(port, result.decisionId, action) };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const spans = numberSpans(fixture.message);
        const reading = await decision.read(port, { message: fixture.message, status: fixture.status }, spans, run);
        const expected = expectedSpan(fixture, spans);
        const checks: FixtureCheck[] = [
          fixtureCheck(fixture.name, 'wait', expected?.id ?? NONE, reading.span?.id ?? NONE, reading.pick.confidence, reading.outcome),
        ];
        if (fixture.expect !== NONE) {
          checks.push(fixtureCheck(fixture.name, 'unit', fixture.expect.unit, reading.unit.choice, reading.unit.confidence, reading.unit.outcome, { answers: UNIT_ANSWERS }));
        }
        return checks;
      }),
  };
  return decision;
}

export const retryWait = defineRetryWait({
  name: 'engine.provider.retry-wait',
  version: 1,
  description: 'Which number in a provider\'s error message states how long to wait before retrying, if any, and whether it is in milliseconds, seconds or minutes.',
  accuracyFloor: 0.9,
  fixtures: [
    {
      name: 'openai tokens-per-minute limit with a wait in seconds',
      status: 429,
      message: 'Rate limit reached for gpt-4o in organization org-abc123 on tokens per min (TPM): Limit 30000, Used 29870, Requested 1200. Please try again in 20s.',
      expect: { number: '20', unit: 's' },
    },
    {
      name: 'bare retry-after value',
      status: 429,
      message: 'Rate limited retry-after: 30',
      expect: { number: '30', unit: 's' },
    },
    {
      name: 'google retry delay in a json body',
      status: 429,
      message: '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"17s"}]}}',
      expect: { number: '17', unit: 's' },
    },
    {
      name: 'fractional seconds',
      status: 429,
      message: 'Request was throttled. Please try again in 1.5 seconds.',
      expect: { number: '1.5', unit: 's' },
    },
    {
      name: 'wait in milliseconds',
      status: 429,
      message: 'Rate limit exceeded for model mistral-large-2407. Retry after 850ms.',
      expect: { number: '850', unit: 'ms' },
    },
    {
      name: 'millisecond field',
      status: 429,
      message: 'Too many requests (limit 60 per minute); retry_after_ms=1500',
      expect: { number: '1500', unit: 'ms' },
    },
    {
      name: 'wait in minutes',
      status: 429,
      message: 'You have hit the limit of 500 requests per hour for this key. Try again in 5 minutes.',
      expect: { number: '5', unit: 'min' },
    },
    {
      name: 'short minute unit beside a per-minute limit',
      status: 429,
      message: 'Quota of 100 requests per minute exceeded; retry in 2 min',
      expect: { number: '2', unit: 'min' },
    },
    {
      name: 'limit per minute is not a wait',
      status: 429,
      message: 'Rate limit of 30000 tokens per minute exceeded. Reduce your request rate.',
      expect: NONE,
    },
    {
      name: 'token counts in a context overflow',
      status: 400,
      message: 'prompt is too long: 210000 tokens > 200000 maximum',
      expect: NONE,
    },
    {
      name: 'status codes in a gateway failure',
      status: 502,
      message: 'Upstream request failed: provider returned 503 Service Unavailable after 3 attempts',
      expect: NONE,
    },
    {
      name: 'reset time of day is not a wait length',
      status: 429,
      message: 'Daily quota of 1000 requests exhausted. The quota resets at 00:00 UTC.',
      expect: NONE,
    },
  ],
});

/** Readings of the same wording, so the cooldown and display paths of one failure ask once. */
const MEMO_LIMIT = 256;
const memo = new Map<string, Promise<number | undefined>>();

/**
 * The wait before retrying that a provider's message states, in
 * milliseconds, read by Jev. Undefined when the message holds no number, when
 * the reading finds no wait, or when the reading is too weak to act on; the
 * action taken is recorded on the decision. `site` names the decision site.
 */
export function readRetryWaitMs(evidence: RetryWaitEvidence, site: string): Promise<number | undefined> {
  const clipped: RetryWaitEvidence = { message: evidence.message.slice(0, MAX_RETRY_WAIT_MESSAGE_CHARS), status: evidence.status };
  const spans = numberSpans(clipped.message);
  if (spans.length === 0) return Promise.resolve(undefined);
  const key = JSON.stringify(clipped);
  const known = memo.get(key);
  if (known !== undefined) return known;
  const reading = (async () => {
    const run = await retryWait.read(judgmentPort(site), clipped, spans, { site });
    if (run.outcome === 'act' && run.waitMs !== undefined) {
      run.recordAction(`took a retry wait of ${run.waitMs}ms from the message (${run.span!.text} ${run.unit.choice})`);
      return run.waitMs;
    }
    run.recordAction(run.waitMs === undefined
      ? 'took no retry wait from the message: no number reads as the wait'
      : `took no retry wait from the message: the reading of ${run.span!.text} ${run.unit.choice} is ${run.outcome}, not act`);
    return undefined;
  })();
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  memo.set(key, reading);
  reading.catch(() => memo.delete(key));
  return reading;
}

/** Forgets remembered readings; for tests that swap the judgment port. */
export function forgetRetryWaitReadings(): void {
  memo.clear();
}
