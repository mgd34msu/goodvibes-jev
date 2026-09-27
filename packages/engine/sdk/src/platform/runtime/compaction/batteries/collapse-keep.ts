/**
 * `engine.compaction.collapse-keep`: which collapsed messages carry something
 * the continuation still depends on? The collapse strategy's handoff promises
 * to preserve key decisions and outcomes; this decision picks the messages
 * that hold them. One yes/no per message, all about the same numbered
 * conversation, so the questions for one conversation share a request (the
 * parallel questions cookbook). A conversation too long for one request is
 * split into consecutive runs of messages, as few as the documented request
 * limits allow (LIMITS in the judgment port); the packing is token counting,
 * code.
 *
 * The question set grows with the conversation, so this is a named decision
 * of its own rather than a fixed-question battery; its one question, band and
 * fixtures live here.
 *
 * Band: medium stakes. A missed message is lost from the handoff the agent
 * resumes on; a wrong pick only spends handoff space. The compaction quality
 * score judges the finished handoff afterwards.
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
  recordReadings,
  STAKES_BANDS,
  type CallOptions,
  type JudgmentPort,
  type NamedDecision,
  type NoulResponse,
  type Question,
  type YesNoReading,
} from '@goodvibes-jev/judgment';

export const KEEP_BAND = STAKES_BANDS.medium.yesNo;

const KEEP_INSTRUCTIONS =
  '`conversation` is part of an agent work session, one numbered message per entry. Does message `message` state a decision, an outcome, a user requirement or constraint, a file change, or an open task that the rest of the work still depends on?';
const KEEP_CRITERIA = {
  true: 'The message itself states a decision, a result, a requirement or constraint, a change made to a file, or work still to do, that someone continuing the work would need to know.',
  false: 'The message is greeting, thanks, acknowledgement, narration of what the agent is about to look at, a bare tool call or raw output with no conclusion, or anything the continuation does not need.',
} as const;

/** Most characters of one message a request carries; longer messages are clipped with a note. */
export const MAX_JUDGED_MESSAGE_CHARS = 6_000;

/** Pair requests in flight at once when a conversation needs more than one. */
const REQUEST_CONCURRENCY = 4;

/** One message to judge: its position in the conversation (1-based) and its rendered text ("user: ...", "assistant: ...", "tool result (...): ..."). */
export interface KeepEntry {
  readonly number: number;
  readonly text: string;
}

export interface CollapseKeepFixture {
  readonly name: string;
  /** Rendered messages, numbered from 1 in order. */
  readonly messages: readonly string[];
  /** The expected answer for each labelled message, by number. */
  readonly expect: Readonly<Record<number, 'yes' | 'no'>>;
}

export interface CollapseKeep extends NamedDecision {
  /** One reading per entry, by entry number. */
  select(port: JudgmentPort, entries: readonly KeepEntry[], options?: CallOptions): Promise<Map<number, YesNoReading>>;
}

const clipText = (text: string): string =>
  text.length <= MAX_JUDGED_MESSAGE_CHARS ? text : `${text.slice(0, MAX_JUDGED_MESSAGE_CHARS)} [${text.length - MAX_JUDGED_MESSAGE_CHARS} more characters]`;

const lineFor = (entry: KeepEntry): string => `#${entry.number} ${clipText(entry.text)}`;
const keyFor = (entry: KeepEntry): string => `keep_${entry.number}`;
const questionFor = (entry: KeepEntry): Question => noul({ question: KEEP_INSTRUCTIONS, message: `#${entry.number}` }, KEEP_CRITERIA);

/** Separator between rendered messages, and its JSON-escaped length. */
const SEPARATOR = '\n\n';
const ESCAPED_SEPARATOR_CHARS = JSON.stringify(SEPARATOR).length - 2;
/** JSON length of the state with an empty conversation. */
const EMPTY_STATE_CHARS = JSON.stringify({ conversation: '' }).length;

/**
 * Splits entries into consecutive runs, each run one request within the
 * documented limits: the state plus every question under maxRequestTokens,
 * the state plus the longest question under maxStateWithQuestionTokens,
 * both estimated exactly as the port validates them.
 */
export function packKeepRequests(entries: readonly KeepEntry[]): KeepEntry[][] {
  const runs: KeepEntry[][] = [];
  let run: KeepEntry[] = [];
  let stateChars = EMPTY_STATE_CHARS;
  let questionTokens = 0;
  let longestQuestion = 0;
  for (const entry of entries) {
    const lineChars = JSON.stringify(lineFor(entry)).length - 2 + (run.length > 0 ? ESCAPED_SEPARATOR_CHARS : 0);
    const tokens = estimateTokens(questionFor(entry));
    const stateTokens = Math.ceil((stateChars + lineChars) / 3);
    const fits = stateTokens + questionTokens + tokens <= LIMITS.maxRequestTokens
      && stateTokens + Math.max(longestQuestion, tokens) <= LIMITS.maxStateWithQuestionTokens;
    if (run.length > 0 && !fits) {
      runs.push(run);
      run = [];
      stateChars = EMPTY_STATE_CHARS + JSON.stringify(lineFor(entry)).length - 2;
      questionTokens = tokens;
      longestQuestion = tokens;
    } else {
      stateChars += lineChars;
      questionTokens += tokens;
      longestQuestion = Math.max(longestQuestion, tokens);
    }
    run.push(entry);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

export function defineCollapseKeep(spec: {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly accuracyFloor: number;
  readonly fixtures: readonly CollapseKeepFixture[];
}): CollapseKeep {
  const header = decisionHeader(spec);
  const labels = spec.fixtures.flatMap((fixture) => Object.values(fixture.expect));
  if (!labels.includes('yes') || !labels.includes('no')) throw new RangeError(`decision ${spec.name}: fixtures need at least one yes and one no`);
  for (const fixture of spec.fixtures) {
    for (const number of Object.keys(fixture.expect).map(Number)) {
      if (!(number >= 1 && number <= fixture.messages.length)) throw new RangeError(`decision ${spec.name}: fixture ${fixture.name} labels unknown message #${number}`);
    }
  }

  const askRun = async (port: JudgmentPort, run: readonly KeepEntry[], options: CallOptions): Promise<Array<[number, YesNoReading]>> => {
    const state = { conversation: run.map(lineFor).join(SEPARATOR) };
    const questions = Object.fromEntries(run.map((entry) => [keyFor(entry), questionFor(entry)]));
    const result = await askAs(port, spec, 'battery', state, questions, options);
    const answers = result.answers as Record<string, NoulResponse>;
    const readings = run.map((entry): [number, YesNoReading] => [entry.number, readYesNo(answers[keyFor(entry)]!, KEEP_BAND)]);
    recordReadings(port, result, Object.fromEntries(readings.map(([number, reading]) => [`#${number}`, reading])));
    return readings;
  };

  const decision: CollapseKeep = {
    ...header,
    async select(port, entries, options = {}) {
      if (entries.length === 0) return new Map();
      const runs = packKeepRequests(entries);
      const read = await mapLimit(runs, REQUEST_CONCURRENCY, (run) => askRun(port, run, options));
      return new Map(read.flat());
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const entries = fixture.messages.map((text, index) => ({ number: index + 1, text }));
        const readings = await decision.select(port, entries, run);
        return Object.entries(fixture.expect).map(([number, expected]) =>
          checkReading(fixture.name, `#${number}`, expected, readings.get(Number(number))!));
      }),
  };
  return decision;
}

const BACKUP_SESSION = [
  'user: The nightly backup job fails with "EACCES: permission denied, open /var/backups/app/db.dump". Find out why and fix it without running anything as root.',
  'assistant: Let me check who owns the backup directory. [calls exec {"command":"ls -ld /var/backups/app"}]',
  'tool result (exec): drwxr-xr-x 2 root root 4096 Sep 20 03:00 /var/backups/app',
  'assistant: The directory is owned by root and the job runs as the app user. Options: change the owner, or write to a directory the app user owns.',
  'user: Do not change ownership under /var. Write the dump to /srv/app/backups instead and keep 7 days of dumps.',
  'assistant: Updated scripts/backup.sh to write to /srv/app/backups and delete dumps older than 7 days. Still to do: update the systemd unit ReadWritePaths so the new path is allowed.',
  'user: thanks',
  "assistant: You're welcome.",
];

const RATE_LIMIT_SESSION = [
  'user: hi, are you there?',
  'assistant: Yes. What would you like to work on?',
  'user: Add rate limiting to POST /api/upload: 10 requests per minute per API key, and answer 429 with a Retry-After header when the limit is hit.',
  'assistant: Let me look at how the routes are registered first.',
  'assistant: [calls read {"path":"src/routes/index.ts"}]',
  'assistant: I added src/middleware/rate-limit.ts, a sliding-window limiter keyed by API key, and registered it on the upload route. It keeps its counters in memory for now.',
  'user: We run four instances behind the load balancer, so the counters have to live in Redis, not in memory.',
  'assistant: Sounds good, one moment.',
  'assistant: Switched the limiter to Redis INCR with a 60 second expiry, using the existing client from src/lib/redis.ts. The limiter tests still need to be written.',
];

export const collapseKeep = defineCollapseKeep({
  name: 'engine.compaction.collapse-keep',
  version: 1,
  description: 'Which messages of a collapsed conversation state a decision, an outcome, a requirement or constraint, a file change, or open work the continuation still depends on.',
  accuracyFloor: 0.9,
  fixtures: [
    {
      name: 'backup permission fix',
      messages: BACKUP_SESSION,
      expect: { 1: 'yes', 2: 'no', 5: 'yes', 6: 'yes', 7: 'no', 8: 'no' },
    },
    {
      name: 'upload rate limit',
      messages: RATE_LIMIT_SESSION,
      expect: { 1: 'no', 2: 'no', 3: 'yes', 4: 'no', 5: 'no', 6: 'yes', 7: 'yes', 8: 'no', 9: 'yes' },
    },
  ],
});
