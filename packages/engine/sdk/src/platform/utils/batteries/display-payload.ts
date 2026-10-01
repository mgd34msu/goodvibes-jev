/**
 * `engine.errors.display-payload`: which bracketed parts of an error message
 * are machine payload (a JSON object or array, an echo of a request or
 * response body, a stack trace, a schema dump) rather than words the message
 * says to its reader? Read by Jev in place of the two regexes error-display.ts
 * used to blank every `{...}` and `[...]` of up to 500 characters, which also
 * blanked the file names, option names and value lists a message refers to.
 *
 * One yes/no per span, all about the same message, so every span of one
 * message shares a request (the parallel questions cookbook). The spans are
 * found by a bracket-balancing scan ({@link payloadSpans}), grammar, not a
 * decision. The question set grows with the message, so this is a named
 * decision of its own rather than a fixed-question battery; its one question,
 * band and fixtures live here.
 *
 * Band: low stakes. The reading changes what one error line shows a person: a
 * wrong yes hides a word the message needed, a wrong no leaves a JSON echo in
 * the line. The full error stays in logs and the structured error.
 */
import {
  askAs,
  checkEachFixture,
  checkReading,
  decisionHeader,
  estimateTokens,
  LIMITS,
  mapLimit,
  noul,
  readYesNo,
  recordAction,
  recordReadings,
  STAKES_BANDS,
  type CallOptions,
  type JudgmentPort,
  type NamedDecision,
  type NoulResponse,
  type Question,
  type YesNoReading,
} from '@goodvibes-jev/judgment/decisions';

export const PAYLOAD_BAND = STAKES_BANDS.low.yesNo;

const PAYLOAD_INSTRUCTIONS =
  '`message` is an error message shown to a person. `spans` lists the bracketed parts of it, by id. Is span `span` machine payload, such as a JSON object or array, an echo of a request or response body, a stack trace or a schema dump, rather than part of what the message says to its reader?';
const PAYLOAD_CRITERIA = {
  true: 'The span is data for a program: a JSON object or array, a copied request or response body, a stack trace, or a schema. The message still says what went wrong without it.',
  false: 'The span is part of what the message tells the reader: a name, file, option, field, value, status or list of accepted choices the sentence refers to, without which the message is incomplete.',
} as const;

/** Error messages longer than this are read and shown from their opening; the display shows far less. */
export const MAX_DISPLAY_MESSAGE_CHARS = 4_000;

/** Requests in flight at once when one message needs more than one. */
const REQUEST_CONCURRENCY = 4;

/** One bracketed part of a message: its number (1-based, in order), where it sits, and its text. */
export interface PayloadSpan {
  readonly number: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * A placeholder redaction.ts writes into text (`[REDACTED]`,
 * `[REDACTED_API_KEY]`, `[REDACTED_TEXT length=12]`). It is this module's
 * own output, not something the message's author wrote, so it is neither
 * payload nor asked about: removing it would turn `/home/[REDACTED]/x` into a
 * wrong path.
 */
const REDACTION_PLACEHOLDER = /^\[REDACTED(?:_[A-Z_]+)?(?: length=\d+)?\]$/;

const CLOSER: Readonly<Record<string, string>> = { '{': '}', '[': ']' };

/**
 * The outermost balanced `{...}` and `[...]` parts of `message`, in order.
 * Brackets inside a double-quoted string within a part do not count, so a
 * JSON value holding a `]` stays one part. An unbalanced bracket starts no
 * part. Redaction placeholders are left out.
 */
export function payloadSpans(message: string): PayloadSpan[] {
  const spans: PayloadSpan[] = [];
  let index = 0;
  while (index < message.length) {
    const opener = message[index]!;
    if (CLOSER[opener] === undefined) {
      index += 1;
      continue;
    }
    const end = balancedEnd(message, index);
    if (end === undefined) {
      index += 1;
      continue;
    }
    const text = message.slice(index, end);
    if (!REDACTION_PLACEHOLDER.test(text)) spans.push({ number: spans.length + 1, start: index, end, text });
    index = end;
  }
  return spans;
}

/** Index just past the bracket closing the one at `start`, or undefined when it never closes. */
function balancedEnd(message: string, start: number): number | undefined {
  const stack: string[] = [];
  let inString = false;
  for (let index = start; index < message.length; index += 1) {
    const char = message[index]!;
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && stack.length > 0) {
      inString = true;
    } else if (CLOSER[char] !== undefined) {
      stack.push(CLOSER[char]!);
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) return index + 1;
    }
  }
  return undefined;
}

export interface DisplayPayloadFixture {
  readonly name: string;
  readonly message: string;
  /** The expected answer for each labelled span, by number (1-based, as {@link payloadSpans} finds them). */
  readonly expect: Readonly<Record<number, 'yes' | 'no'>>;
}

/** The readings for one message's spans, and the record of what the site did with them. */
export interface DisplayPayloadRun {
  readonly readings: ReadonlyMap<number, YesNoReading>;
  recordAction(action: string): void;
}

export interface DisplayPayload extends NamedDecision {
  /** One reading per span, by span number. */
  read(port: JudgmentPort, message: string, spans: readonly PayloadSpan[], options?: CallOptions): Promise<DisplayPayloadRun>;
}

const keyFor = (span: PayloadSpan): string => `payload_${span.number}`;
const idFor = (span: PayloadSpan): string => `s${span.number}`;
const questionFor = (span: PayloadSpan): Question => noul({ question: PAYLOAD_INSTRUCTIONS, span: idFor(span) }, PAYLOAD_CRITERIA);

const stateFor = (message: string, spans: readonly PayloadSpan[]) => ({
  message,
  spans: Object.fromEntries(spans.map((span) => [idFor(span), span.text])),
});

/**
 * Splits spans into consecutive groups, each one request within the
 * documented limits (state plus every question under maxRequestTokens, state
 * plus the longest question under maxStateWithQuestionTokens), estimated as
 * the port validates them.
 */
function packRequests(message: string, spans: readonly PayloadSpan[]): PayloadSpan[][] {
  const groups: PayloadSpan[][] = [];
  let group: PayloadSpan[] = [];
  for (const span of spans) {
    const candidate = [...group, span];
    const state = estimateTokens(stateFor(message, candidate));
    const questions = candidate.map((entry) => estimateTokens(questionFor(entry)));
    const fits = state + questions.reduce((sum, tokens) => sum + tokens, 0) <= LIMITS.maxRequestTokens
      && state + Math.max(...questions) <= LIMITS.maxStateWithQuestionTokens;
    if (group.length > 0 && !fits) {
      groups.push(group);
      group = [span];
    } else {
      group = candidate;
    }
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

export function defineDisplayPayload(spec: {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly accuracyFloor: number;
  readonly fixtures: readonly DisplayPayloadFixture[];
}): DisplayPayload {
  const header = decisionHeader(spec);
  const labels = spec.fixtures.flatMap((fixture) => Object.values(fixture.expect));
  if (!labels.includes('yes') || !labels.includes('no')) throw new RangeError(`decision ${spec.name}: fixtures need at least one yes and one no`);
  for (const fixture of spec.fixtures) {
    const count = payloadSpans(fixture.message).length;
    for (const number of Object.keys(fixture.expect).map(Number)) {
      if (!(number >= 1 && number <= count)) throw new RangeError(`decision ${spec.name}: fixture ${fixture.name} labels unknown span #${number}`);
    }
  }

  const askGroup = async (port: JudgmentPort, message: string, group: readonly PayloadSpan[], options: CallOptions) => {
    const questions = Object.fromEntries(group.map((span) => [keyFor(span), questionFor(span)]));
    const result = await askAs(port, spec, 'battery', stateFor(message, group), questions, options);
    const answers = result.answers as Record<string, NoulResponse>;
    const readings = group.map((span): [number, YesNoReading] => [span.number, readYesNo(answers[keyFor(span)]!, PAYLOAD_BAND)]);
    recordReadings(port, result, Object.fromEntries(readings.map(([number, reading]) => [`#${number}`, reading])));
    return { readings, decisionId: result.decisionId };
  };

  const decision: DisplayPayload = {
    ...header,
    async read(port, message, spans, options = {}) {
      if (spans.length === 0) return { readings: new Map(), recordAction: () => undefined };
      const groups = await mapLimit(packRequests(message, spans), REQUEST_CONCURRENCY, (group) => askGroup(port, message, group, options));
      return {
        readings: new Map(groups.flatMap((group) => group.readings)),
        recordAction: (action) => {
          for (const group of groups) recordAction(port, group.decisionId, action);
        },
      };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const { readings } = await decision.read(port, fixture.message, payloadSpans(fixture.message), run);
        return Object.entries(fixture.expect).map(([number, expected]) =>
          checkReading(fixture.name, `#${number}`, expected, readings.get(Number(number))!, 'payload'));
      }),
  };
  return decision;
}

export const displayPayload = defineDisplayPayload({
  name: 'engine.errors.display-payload',
  version: 1,
  description: 'Which bracketed parts of an error message are machine payload (a JSON object or array, a request or response echo, a stack trace or a schema dump) rather than part of the human-readable message.',
  accuracyFloor: 0.9,
  fixtures: [
    {
      name: 'provider error body after the status',
      message: 'Request failed with status 400: {"error":{"message":"Invalid model id","type":"invalid_request_error","param":"model"}}',
      expect: { 1: 'yes' },
    },
    {
      name: 'echoed tool arguments',
      message: 'Tool call rejected: arguments [{"path":"src/a.ts","content":"export const a = 1;\\n"}] did not match the tool schema',
      expect: { 1: 'yes' },
    },
    {
      name: 'schema dump after a validation failure',
      message: 'Validation failed for the plan: {"type":"object","required":["steps"],"properties":{"steps":{"type":"array"}}}',
      expect: { 1: 'yes' },
    },
    {
      name: 'bracketed file name',
      message: 'Cannot read settings file [config/settings.json]: permission denied',
      expect: { 1: 'no' },
    },
    {
      name: 'list of accepted values',
      message: 'Unknown format "xml". Expected one of [json, yaml, toml].',
      expect: { 1: 'no' },
    },
    {
      name: 'named placeholder in a sentence',
      message: 'Missing value for {workspace}: set it in the project settings before running the task',
      expect: { 1: 'no' },
    },
    {
      name: 'bracketed status words',
      message: 'Upstream gateway answered [503 Service Unavailable]; the provider may be down',
      expect: { 1: 'no' },
    },
    {
      name: 'model name kept, usage echo removed',
      message: 'Rate limit reached for model [gpt-4o] {"limit_tokens":30000,"used_tokens":29870,"requested_tokens":1200}',
      expect: { 1: 'no', 2: 'yes' },
    },
    {
      name: 'response headers echo',
      message: 'Stream ended early {"headers":{"content-type":"text/event-stream","x-request-id":"req_91ab"},"bytes":0}',
      expect: { 1: 'yes' },
    },
    {
      name: 'stack trace in brackets',
      message: 'Hook script failed [Error: boom\n    at run (/app/hooks/pre.js:10:5)\n    at main (/app/hooks/pre.js:20:3)]',
      expect: { 1: 'yes' },
    },
    {
      name: 'field name in brackets',
      message: 'Invalid value for field [maxTokens]: expected a positive number',
      expect: { 1: 'no' },
    },
  ],
});
