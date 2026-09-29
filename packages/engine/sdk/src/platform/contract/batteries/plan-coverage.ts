/**
 * `contract.plan-coverage` (docs/design/contract-runner.md section 3.4): does
 * the plan's list of contract criteria leave out anything the user stated?
 *
 * Every contract criterion quotes the user's exact words (code check 4 holds
 * before the Jev checks run), so code lays the request out by where the
 * quotes sit ({@link quoteLayout}) and one request asks one narrow question
 * about each part. The state is `{ request }`; each question carries its part:
 * - `unquoted_<n>`, for each run of the request no quote covers (usually "and"
 *   or ". Then"; a dropped requirement shows up here as its own words): do
 *   `words` ask for something, limit it, or say how it must be done? A run
 *   with no letter or digit in it states nothing and is not asked about.
 * - `falls_short_<n>`, for each quoted region with the criteria whose quotes
 *   overlap it: do `words` ask for something none of `criteria` requires, or
 *   set a higher standard than they do? This finds a criterion that quotes
 *   the user but states less than the quote (a count or a behaviour dropped).
 *
 * Why the parts: the earlier single question ("does `request` state a
 * requirement, limit or preference that none of `criteria` covers?") leaned
 * the right way on real plans but never surely. In the contract proof run,
 * plans whose criteria covered their ask read 0.18 to 0.39, below the high
 * no band, and each went through two repairs the planner could not act on
 * (its criteria grew from 8 to 16 and the reading did not move). Asked part
 * by part (calibration, 2026-09-29), the three durations plans read every
 * part at or below 0.28, so each clears; the version plan reads every part
 * at or below 0.19 except its delegation criterion (0.34), which is asked to
 * be restated in the user's words. The fixtures below include those plans.
 *
 * Bands: a requirement no criterion covers is never judged, since every
 * check after planning judges the criteria, so "nothing is missing" keeps
 * high stakes on the no side; a false gap costs a repair, so the yes side is
 * medium.
 *
 * What code does with each part's reading (composed in plan-checks.ts): a
 * reading that leans yes is a problem at any outcome. A reading that leans no
 * but does not reach the no band (above 0.3 under the high band, so
 * uncertain) is also a problem, sent to the planner with the words it
 * concerns: restating the criterion in the user's words settles it, where the
 * old whole-request problem gave the planner nothing to change. A no at act
 * or confirm clears its part; the plan's action records the parts that
 * cleared at confirm.
 */
import {
  askAs,
  assertBand,
  checkEachFixture,
  decisionHeader,
  fixtureCheck,
  leansYes,
  normalizeForMatch,
  noul,
  readYesNo,
  recordAction,
  recordReadings,
  STAKES_BANDS,
  type CallOptions,
  type FixtureCheck,
  type JudgmentPort,
  type NamedDecision,
  type NoulResponse,
  type Outcome,
  type Question,
  type YesNoBand,
  type YesNoReading,
} from '@goodvibes-jev/judgment';

/** The band on every part: yes side medium (a false gap costs a repair), no side high (a missed requirement is never judged). */
export const COVERAGE_BAND: YesNoBand = { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence };

const UNQUOTED_QUESTION = 'Do `words`, read in `request`, ask for something, limit it, or say how it must be done?';
const UNQUOTED_CRITERIA = {
  true: 'The words state a requirement, limit or preference of their own',
  false: 'The words only join or introduce the parts of the request around them',
} as const;
const FALLS_SHORT_QUESTION = 'Does `words` ask for something that none of `criteria` requires, or set a higher standard than they do?';
const FALLS_SHORT_CRITERIA = {
  true: 'Part of what the words ask for is required by none of the criteria, or is held to a lower standard',
  false: 'The criteria together require everything the words ask for, at the standard they set, possibly in other words or with more detail',
} as const;

export interface CoverageCriterion {
  readonly id: string;
  readonly text: string;
  readonly quote: string | undefined;
}

export interface CoverageInput {
  readonly request: string;
  readonly criteria: readonly CoverageCriterion[];
}

/** A stretch of the request that one or more criteria quote. */
export interface QuotedRegion {
  readonly words: string;
  readonly criteria: readonly CoverageCriterion[];
}

export interface QuoteLayout {
  /** The request as quotes are matched against it (whitespace collapsed, curly quotes folded). */
  readonly request: string;
  /** Runs of the request no quote covers, in order, each with a letter or digit in it. */
  readonly unquoted: readonly string[];
  /** Quoted regions in order; criteria whose quotes overlap share one. */
  readonly regions: readonly QuotedRegion[];
}

type Span = readonly [start: number, end: number];

/** Every place `quote` occurs in `text`. */
function occurrences(text: string, quote: string): Span[] {
  const spans: Span[] = [];
  if (quote.length === 0) return spans;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) spans.push([at, at + quote.length]);
  return spans;
}

/** A run of text states something only when it has a letter or a digit. */
const HAS_WORDS = /[\p{L}\p{N}]/u;

/**
 * Where the criteria's quotes sit in the request. A quote found nowhere (code
 * check 4 turns that into a problem of its own) covers nothing, so its words
 * stay unquoted. Regions come from each quote's first place in the request.
 */
export function quoteLayout(input: CoverageInput): QuoteLayout {
  const request = normalizeForMatch(input.request);
  const placed = input.criteria.map((criterion) => ({ criterion, spans: occurrences(request, normalizeForMatch(criterion.quote ?? '')) }));
  const covered = new Array<boolean>(request.length).fill(false);
  for (const { spans } of placed) for (const [start, end] of spans) covered.fill(true, start, end);
  // `normalizeForMatch` leaves no newline, so one marks the covered characters.
  const unquoted = request.split('').map((char, index) => (covered[index] ? '\n' : char)).join('').split('\n')
    .map((run) => run.trim())
    .filter((run) => HAS_WORDS.test(run));
  const firsts = placed.filter((entry) => entry.spans.length > 0).sort((a, b) => a.spans[0]![0] - b.spans[0]![0]);
  const merged: { start: number; end: number; criteria: CoverageCriterion[] }[] = [];
  for (const { criterion, spans } of firsts) {
    const [start, end] = spans[0]!;
    const last = merged.at(-1);
    if (last !== undefined && start < last.end) {
      last.end = Math.max(last.end, end);
      last.criteria.push(criterion);
    } else {
      merged.push({ start, end, criteria: [criterion] });
    }
  }
  return { request, unquoted, regions: merged.map((region) => ({ words: request.slice(region.start, region.end), criteria: region.criteria })) };
}

/** One part of the request and its reading. */
export interface CoveragePart {
  readonly kind: 'unquoted' | 'falls-short';
  readonly words: string;
  /** The criteria quoting a falls-short region; empty for unquoted words. */
  readonly criteria: readonly CoverageCriterion[];
  readonly reading: YesNoReading;
}

export interface CoverageRun {
  readonly parts: readonly CoveragePart[];
  readonly decisionId: string | undefined;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  recordAction(action: string): void;
}

export interface CoverageFixture extends CoverageInput {
  readonly name: string;
  readonly expect: { readonly uncovered: 'yes' | 'no' };
}

export interface PlanCoverage extends NamedDecision {
  read(port: JudgmentPort, input: CoverageInput, options?: CallOptions): Promise<CoverageRun>;
}

interface AskedPart {
  readonly key: string;
  readonly kind: CoveragePart['kind'];
  readonly words: string;
  readonly criteria: readonly CoverageCriterion[];
  readonly question: Question;
}

function askedParts(layout: QuoteLayout): AskedPart[] {
  return [
    ...layout.unquoted.map((words, index): AskedPart => ({
      key: `unquoted_${index + 1}`, kind: 'unquoted', words, criteria: [],
      question: noul({ question: UNQUOTED_QUESTION, words }, UNQUOTED_CRITERIA),
    })),
    ...layout.regions.map((region, index): AskedPart => ({
      key: `falls_short_${index + 1}`, kind: 'falls-short', words: region.words, criteria: region.criteria,
      question: noul({ question: FALLS_SHORT_QUESTION, words: region.words, criteria: region.criteria.map((criterion) => criterion.text) }, FALLS_SHORT_CRITERIA),
    })),
  ];
}

const OUTCOME_RANK: Readonly<Record<Outcome, number>> = { act: 2, confirm: 1, escalate: 0 };

/**
 * The plan-level answer the parts give, for calibration: uncovered when any
 * part leans yes. Uncovered acts when a part reads yes at act; covered acts
 * only when every part reads no at act, and confirms when every part reads no
 * at act or confirm.
 */
export function coverageConclusion(parts: readonly CoveragePart[]): { readonly uncovered: 'yes' | 'no'; readonly signal: number; readonly outcome: Outcome } {
  const worst = Math.max(...parts.map((part) => part.reading.probability));
  if (leansYes(worst)) {
    const yes = parts.filter((part) => part.reading.verdict === 'yes').map((part) => part.reading.outcome);
    const outcome = yes.sort((a, b) => OUTCOME_RANK[b] - OUTCOME_RANK[a])[0] ?? 'escalate';
    return { uncovered: 'yes', signal: worst, outcome };
  }
  const outcomes = parts.map((part) => (part.reading.verdict === 'no' ? part.reading.outcome : 'escalate'));
  const outcome = outcomes.sort((a, b) => OUTCOME_RANK[a] - OUTCOME_RANK[b])[0] ?? 'act';
  return { uncovered: 'no', signal: 1 - worst, outcome };
}

/** A plan's criteria as `[id, text, quote]`. */
type CriterionRow = readonly [id: string, text: string, quote: string];
const criteriaOf = (rows: readonly CriterionRow[]): CoverageCriterion[] => rows.map(([id, text, quote]) => ({ id, text, quote }));

/** A unit as the proof-run planner wrote it; each criterion is `[text, served contract criterion ids]`. */
export interface ProofUnit {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly brief: string;
  readonly criteria: readonly { readonly text: string; readonly serves: readonly string[] }[];
}

/** A plan a real planner model wrote, trimmed to what the plan batteries read. */
export interface ProofPlan {
  readonly ask: string;
  readonly goal: string;
  readonly criteria: readonly CoverageCriterion[];
  readonly units: readonly ProofUnit[];
}

const proofUnit = (id: string, title: string, goal: string, brief: string, criteria: readonly (readonly [string, readonly string[]])[]): ProofUnit =>
  ({ id, title, goal, brief, criteria: criteria.map(([text, serves]) => ({ text, serves })) });

const DURATIONS_ASK = "Add src/parse.ts exporting parseDuration(text), which turns strings such as 1h30m, 45s or 2h into a number of seconds and throws a RangeError whose message names the input for malformed text, and src/format.ts exporting formatDuration(seconds), which renders 5405 as '1h 30m 5s', leaves out zero parts and gives '0s' for zero. Give each module its own test file under test/ with at least 12 test cases. Then wire both into src/cli.ts so that `bun src/cli.ts normalize <text>` prints formatDuration(parseDuration(text)), and for malformed input prints the error message to stderr and exits with code 2. Every exported function needs a JSDoc comment with an @example line, and README.md needs a Usage section showing the normalize command with one example.";
const VERSION_ASK = "Do this yourself in this session, without delegating to sub-agents or any other agent: add src/version.ts exporting a function versionLabel() that returns 'durations 0.1.0', built from VERSION in src/index.ts, and a test for it in test/version.test.ts.";

/**
 * Plans gemini-3-flash-preview wrote as the planner in the contract proof run
 * (scripts/contract-proof.ts, 2026-09-29), each covering its ask and each
 * sent back by the old checks: the durations plan's first version and its
 * last (after two repairs), its middle version's criteria, and the version
 * plan's last. The fixtures of this battery and of `contract.unit-shape` read
 * them as written, and alter them to make plans that really miss or narrow.
 */
export const PROOF_PLANS: { readonly durations: ProofPlan; readonly durationsFirst: ProofPlan; readonly durationsMiddle: ProofPlan; readonly version: ProofPlan } = {
  durations: {
    ask: DURATIONS_ASK,
    goal: 'Add duration parsing and formatting modules with a CLI interface, comprehensive tests, and updated documentation.',
    criteria: criteriaOf([
      ['c1', 'Add src/parse.ts exporting parseDuration(text)', 'Add src/parse.ts exporting parseDuration(text)'],
      ['c2', 'parseDuration turns strings such as 1h30m, 45s or 2h into a number of seconds', 'turns strings such as 1h30m, 45s or 2h into a number of seconds'],
      ['c3', 'parseDuration throws a RangeError whose message names the input for malformed text', 'throws a RangeError whose message names the input for malformed text'],
      ['c4', 'Add src/format.ts exporting formatDuration(seconds)', 'src/format.ts exporting formatDuration(seconds)'],
      ['c5', "formatDuration renders 5405 as '1h 30m 5s'", "renders 5405 as '1h 30m 5s'"],
      ['c6', 'formatDuration leaves out zero parts', 'leaves out zero parts'],
      ['c7', "formatDuration gives '0s' for zero", "gives '0s' for zero"],
      ['c8', 'Each module has its own test file under test/', 'Give each module its own test file under test/'],
      ['c9', 'At least 12 test cases for the parse module', 'at least 12 test cases'],
      ['c10', 'At least 12 test cases for the format module', 'at least 12 test cases'],
      ['c11', 'Wire both into src/cli.ts so that `bun src/cli.ts normalize <text>` prints formatDuration(parseDuration(text))', 'wire both into src/cli.ts so that `bun src/cli.ts normalize <text>` prints formatDuration(parseDuration(text))'],
      ['c12', 'For malformed input, print the error message to stderr', 'for malformed input prints the error message to stderr'],
      ['c13', 'For malformed input, exit with code 2', 'exits with code 2'],
      ['c14', 'Every exported function needs a JSDoc comment with an @example line', 'Every exported function needs a JSDoc comment with an @example line'],
      ['c15', 'README.md needs a Usage section', 'README.md needs a Usage section'],
      ['c16', 'README.md shows the normalize command with one example', 'showing the normalize command with one example'],
    ]),
    units: [
      proofUnit('u1', 'Implement parseDuration', 'Create parseDuration in src/parse.ts with full requirements', "Create src/parse.ts and export parseDuration(text). It must convert duration strings (e.g., '1h30m', '45s', '2h') into a number of seconds. If the input is malformed, it must throw a RangeError whose message explicitly includes the input string. The function must include a JSDoc comment with at least one @example line.", [['src/parse.ts exports parseDuration(text)', ['c1']], ['parseDuration converts strings like 1h30m to seconds', ['c2']], ['parseDuration throws RangeError naming the input for malformed text', ['c3']], ['parseDuration has JSDoc with @example', ['c14']]]),
      proofUnit('u2', 'Test parseDuration', 'Verify parseDuration with at least 12 test cases', 'Create test/parse.test.ts. It must import parseDuration from src/parse.ts and contain at least 12 test cases using bun:test. Tests must cover valid duration strings, malformed strings (verifying RangeError and the error message content), and various unit combinations.', [['test/parse.test.ts is created', ['c8']], ['test/parse.test.ts contains at least 12 test cases for parseDuration', ['c9']]]),
      proofUnit('u3', 'Implement formatDuration', 'Create formatDuration in src/format.ts with full requirements', "Create src/format.ts and export formatDuration(seconds). It must render 5405 as '1h 30m 5s', omit components that are zero, and return '0s' when the input is 0. The function must include a JSDoc comment with at least one @example line.", [['src/format.ts exports formatDuration(seconds)', ['c4']], ["formatDuration renders 5405 as '1h 30m 5s'", ['c5']], ["formatDuration leaves out zero parts and returns '0s' for 0", ['c6', 'c7']], ['formatDuration has JSDoc with @example', ['c14']]]),
      proofUnit('u4', 'Test formatDuration', 'Verify formatDuration with at least 12 test cases', 'Create test/format.test.ts. It must import formatDuration from src/format.ts and contain at least 12 test cases using bun:test. Tests must cover zero, single units, multiple units, and large values to ensure proper formatting and omission of zero parts.', [['test/format.test.ts is created', ['c8']], ['test/format.test.ts contains at least 12 test cases for formatDuration', ['c10']]]),
      proofUnit('u5', 'Integrate CLI and Update README', 'Create CLI entry point and documentation', "Create src/cli.ts and update README.md. src/cli.ts must implement the 'normalize' command: it takes a text argument, parses it with parseDuration, and prints the result of formatDuration to stdout. If parsing fails, it must print the RangeError message to stderr and exit with code 2. Update README.md to include a 'Usage' section showing an example of `bun src/cli.ts normalize 1h30m`.", [['`bun src/cli.ts normalize <text>` prints formatted duration', ['c11']], ['CLI prints error to stderr and exits with code 2 on malformed input', ['c12', 'c13']], ['README.md has a Usage section with a normalize example', ['c15', 'c16']]]),
    ],
  },
  durationsFirst: {
    ask: DURATIONS_ASK,
    goal: 'Add duration parsing and formatting modules with a CLI interface and documentation.',
    criteria: criteriaOf([
      ['c1', 'Add src/parse.ts exporting parseDuration(text), which turns strings such as 1h30m, 45s or 2h into a number of seconds', 'Add src/parse.ts exporting parseDuration(text), which turns strings such as 1h30m, 45s or 2h into a number of seconds'],
      ['c2', 'parseDuration throws a RangeError whose message names the input for malformed text', 'throws a RangeError whose message names the input for malformed text'],
      ['c3', "Add src/format.ts exporting formatDuration(seconds), which renders 5405 as '1h 30m 5s', leaves out zero parts and gives '0s' for zero", "src/format.ts exporting formatDuration(seconds), which renders 5405 as '1h 30m 5s', leaves out zero parts and gives '0s' for zero"],
      ['c4', 'Provide test/parse.test.ts and test/format.test.ts each with at least 12 test cases', 'Give each module its own test file under test/ with at least 12 test cases'],
      ['c5', 'Add src/cli.ts where `bun src/cli.ts normalize <text>` prints formatDuration(parseDuration(text))', 'wire both into src/cli.ts so that `bun src/cli.ts normalize <text>` prints formatDuration(parseDuration(text))'],
      ['c6', 'CLI prints malformed input error message to stderr and exits with code 2', 'for malformed input prints the error message to stderr and exits with code 2'],
      ['c7', 'Every exported function has a JSDoc comment with an @example line', 'Every exported function needs a JSDoc comment with an @example line'],
      ['c8', 'README.md contains a Usage section showing the normalize command with one example', 'README.md needs a Usage section showing the normalize command with one example'],
    ]),
    units: [
      proofUnit('u1', 'Implement parseDuration', 'Create parseDuration function with JSDoc and validation', "Implement parseDuration in src/parse.ts to convert strings like '1h30m' to seconds, throwing RangeError on failure.", [['parseDuration(text) converts 1h30m, 45s, 2h to seconds', ['c1']], ['RangeError message contains the input for malformed text', ['c2']], ['parseDuration has JSDoc with @example', ['c7']]]),
      proofUnit('u2', 'Test parseDuration', 'Verify parseDuration with 12+ test cases', 'Create test/parse.test.ts and add at least 12 test cases covering various inputs and error conditions.', [['test/parse.test.ts exists with >= 12 test cases', ['c4']]]),
      proofUnit('u3', 'Implement formatDuration', 'Create formatDuration function with JSDoc', "Implement formatDuration in src/format.ts to convert seconds to strings like '1h 30m 5s', handling zeros correctly.", [["formatDuration(5405) returns '1h 30m 5s'", ['c3']], ["formatDuration(0) returns '0s' and zero parts are omitted", ['c3']], ['formatDuration has JSDoc with @example', ['c7']]]),
      proofUnit('u4', 'Test formatDuration', 'Verify formatDuration with 12+ test cases', 'Create test/format.test.ts and add at least 12 test cases covering various inputs.', [['test/format.test.ts exists with >= 12 test cases', ['c4']]]),
      proofUnit('u5', 'CLI and README Integration', 'Wire parse and format into CLI and update README', "Create src/cli.ts to handle 'normalize' command, including error handling and exit codes. Update README.md with usage instructions.", [['bun src/cli.ts normalize <text> works correctly', ['c5']], ['CLI exits with code 2 and prints to stderr on error', ['c6']], ['README.md has Usage section with normalize example', ['c8']]]),
    ],
  },
  durationsMiddle: {
    ask: DURATIONS_ASK,
    goal: 'Add duration parsing and formatting modules with a CLI interface and documentation.',
    criteria: criteriaOf([
      ['c1', 'Add src/parse.ts exporting parseDuration(text), which turns strings such as 1h30m, 45s or 2h into a number of seconds', 'Add src/parse.ts exporting parseDuration(text), which turns strings such as 1h30m, 45s or 2h into a number of seconds'],
      ['c2', 'The parseDuration function throws a RangeError whose message names the input for malformed text', 'throws a RangeError whose message names the input for malformed text'],
      ['c3', "Add src/format.ts exporting formatDuration(seconds), which renders 5405 as '1h 30m 5s', leaves out zero parts and gives '0s' for zero", "src/format.ts exporting formatDuration(seconds), which renders 5405 as '1h 30m 5s', leaves out zero parts and gives '0s' for zero"],
      ['c4', 'Provide separate test files for parse and format under test/ with at least 12 test cases each', 'Give each module its own test file under test/ with at least 12 test cases'],
      ['c5', 'Create src/cli.ts so that `bun src/cli.ts normalize <text>` prints the formatted duration', 'wire both into src/cli.ts so that `bun src/cli.ts normalize <text>` prints formatDuration(parseDuration(text))'],
      ['c6', 'The CLI prints the error message to stderr and exits with code 2 for malformed input', 'for malformed input prints the error message to stderr and exits with code 2'],
      ['c7', 'Every exported function has a JSDoc comment with an @example line', 'Every exported function needs a JSDoc comment with an @example line'],
      ['c8', 'README.md contains a Usage section showing the normalize command with one example', 'README.md needs a Usage section showing the normalize command with one example'],
    ]),
    units: [],
  },
  version: {
    ask: VERSION_ASK,
    goal: 'Implement src/version.ts and test/version.test.ts to provide a versionLabel function built from VERSION in src/index.ts without delegation.',
    criteria: criteriaOf([
      ['c1', 'The session output confirms the agent performed the task directly without invoking sub-agents or delegation tools.', 'Do this yourself in this session, without delegating to sub-agents or any other agent'],
      ['c2', 'The file src/version.ts is created.', 'add src/version.ts'],
      ['c3', 'The function versionLabel() is exported from src/version.ts.', 'exporting a function versionLabel()'],
      ['c4', "The function versionLabel() returns the string 'durations 0.1.0'.", "returns 'durations 0.1.0'"],
      ['c5', 'The function versionLabel() is implemented using the VERSION constant imported from src/index.ts.', 'built from VERSION in src/index.ts'],
      ['c6', 'The file test/version.test.ts is created containing a test for versionLabel() that passes.', 'a test for it in test/version.test.ts'],
    ]),
    units: [
      proofUnit('u1', 'Implement versionLabel and test/version.test.ts', 'Create src/version.ts and test/version.test.ts to export and verify versionLabel() using VERSION from src/index.ts.', "Read src/index.ts to confirm the VERSION constant. Create src/version.ts importing VERSION and exporting versionLabel() which returns `durations ${VERSION}` (evaluating to 'durations 0.1.0'). Create test/version.test.ts using bun:test to import and assert that versionLabel() returns 'durations 0.1.0'. Run the tests to ensure success. All actions must be taken directly by the agent without delegating to any other agent or sub-agent tool.", [['The agent did not use any sub-agent or delegation tools during the session.', ['c1']], ['src/version.ts exists and exports versionLabel().', ['c2', 'c3']], ["versionLabel() returns 'durations 0.1.0' by importing and using VERSION from src/index.ts.", ['c4', 'c5']], ['test/version.test.ts exists and its test for versionLabel() passes.', ['c6']]]),
    ],
  },
};

/** A proof plan's criteria with some left out (`drop`) or restated to say less (`restate`). */
function altered(plan: ProofPlan, change: { readonly drop?: readonly string[]; readonly restate?: Readonly<Record<string, string>> }): CoverageCriterion[] {
  return plan.criteria
    .filter((criterion) => !(change.drop ?? []).includes(criterion.id))
    .map((criterion) => ({ ...criterion, text: change.restate?.[criterion.id] ?? criterion.text }));
}

const proofFixture = (name: string, plan: ProofPlan, uncovered: 'yes' | 'no', criteria: readonly CoverageCriterion[] = plan.criteria): CoverageFixture =>
  ({ name, request: plan.ask, criteria, expect: { uncovered } });

const CSV_REQUEST = 'Add CSV export to the reports page, limit it to 10,000 rows, and keep the existing PDF export working.';
const { durations, durationsFirst, durationsMiddle, version } = PROOF_PLANS;

const FIXTURES: readonly CoverageFixture[] = [
  {
    name: 'row limit left out',
    request: CSV_REQUEST,
    criteria: criteriaOf([['c1', 'The reports page offers a CSV export', 'Add CSV export to the reports page'], ['c2', 'The existing PDF export still works', 'keep the existing PDF export working']]),
    expect: { uncovered: 'yes' },
  },
  {
    name: 'every part covered',
    request: CSV_REQUEST,
    criteria: criteriaOf([['c1', 'The reports page offers a CSV export', 'Add CSV export to the reports page'], ['c2', 'A CSV export contains at most 10,000 rows', 'limit it to 10,000 rows'], ['c3', 'The existing PDF export still works', 'keep the existing PDF export working']]),
    expect: { uncovered: 'no' },
  },
  {
    name: 'dependency preference left out',
    request: 'Write a Python script that renames photos by date taken. It must not overwrite existing files, and use only the standard library.',
    criteria: criteriaOf([['c1', 'The script renames each photo by the date it was taken', 'Write a Python script that renames photos by date taken'], ['c2', 'The script never overwrites an existing file', 'It must not overwrite existing files']]),
    expect: { uncovered: 'yes' },
  },
  {
    name: 'second feature left out',
    request: "Make the login form accessible and add a 'remember me' checkbox.",
    criteria: criteriaOf([['c1', 'The login form meets accessibility requirements for labels, focus order and contrast', 'Make the login form accessible']]),
    expect: { uncovered: 'yes' },
  },
  {
    name: 'hands-off limit left out',
    request: "Upgrade the app to React 18, and don't touch the webpack config.",
    criteria: criteriaOf([['c1', 'The app builds and runs on React 18', 'Upgrade the app to React 18']]),
    expect: { uncovered: 'yes' },
  },
  {
    name: 'single requirement covered',
    request: 'Fix the typo in the README heading.',
    criteria: criteriaOf([['c1', 'The typo in the README heading is corrected', 'Fix the typo in the README heading']]),
    expect: { uncovered: 'no' },
  },
  {
    name: 'each test case covered',
    request: 'Add unit tests for the date parser covering leap years and invalid input.',
    criteria: criteriaOf([['c1', 'Unit tests for the date parser exist', 'Add unit tests for the date parser'], ['c2', 'The tests cover leap-year dates', 'covering leap years'], ['c3', 'The tests cover invalid input', 'invalid input']]),
    expect: { uncovered: 'no' },
  },
  {
    name: 'limit covered in other words',
    request: 'Speed up the search endpoint; it should respond in under 200ms for typical queries.',
    criteria: criteriaOf([['c1', 'Typical queries to the search endpoint get a response in less than 200 milliseconds', 'Speed up the search endpoint; it should respond in under 200ms for typical queries']]),
    expect: { uncovered: 'no' },
  },
  proofFixture('proof: durations plan after two repairs, 16 criteria', durations, 'no'),
  proofFixture('proof: first durations plan, 8 criteria', durationsFirst, 'no'),
  proofFixture('proof: middle durations plan, 8 criteria', durationsMiddle, 'no'),
  proofFixture('proof: version plan', version, 'no'),
  proofFixture('proof durations: exit code 2 dropped', durations, 'yes', altered(durations, { drop: ['c13'] })),
  proofFixture('proof durations: JSDoc rule dropped', durations, 'yes', altered(durations, { drop: ['c14'] })),
  proofFixture('proof durations: README dropped', durations, 'yes', altered(durations, { drop: ['c15', 'c16'] })),
  proofFixture('proof durations: test count dropped', durations, 'yes', altered(durations, { drop: ['c9', 'c10'] })),
  proofFixture('proof durations: CLI output restated away', durations, 'yes', altered(durations, { restate: { c11: 'Wire both into src/cli.ts' } })),
  proofFixture('proof first durations: CLI error path dropped', durationsFirst, 'yes', altered(durationsFirst, { drop: ['c6'] })),
  proofFixture('proof first durations: zero handling restated away', durationsFirst, 'yes', altered(durationsFirst, { restate: { c3: "Add src/format.ts exporting formatDuration(seconds), which renders 5405 as '1h 30m 5s'" } })),
  proofFixture('proof first durations: test count restated away', durationsFirst, 'yes', altered(durationsFirst, { restate: { c4: 'Provide test/parse.test.ts and test/format.test.ts' } })),
  proofFixture('proof version: no-delegation rule dropped', version, 'yes', altered(version, { drop: ['c1'] })),
  proofFixture('proof version: test restated to a file', version, 'yes', altered(version, { restate: { c6: 'The file test/version.test.ts is created.' } })),
];

const HEADER = {
  name: 'contract.plan-coverage',
  version: 2,
  description: "Whether the user's request states a requirement, limit or preference the plan's contract criteria leave out: each run of the request no criterion quotes, and each quoted region against the criteria quoting it.",
  accuracyFloor: 0.9,
} as const;

assertBand(COVERAGE_BAND);

export const planCoverage: PlanCoverage = {
  ...decisionHeader({ ...HEADER, fixtures: FIXTURES }),
  async read(port, input, options = {}) {
    const layout = quoteLayout(input);
    const asked = askedParts(layout);
    const result = await askAs(port, HEADER, 'battery', { request: layout.request }, Object.fromEntries(asked.map((part) => [part.key, part.question])), options);
    const answers = result.answers as Readonly<Record<string, NoulResponse>>;
    const parts = asked.map((part): CoveragePart => ({ kind: part.kind, words: part.words, criteria: part.criteria, reading: readYesNo(answers[part.key]!, COVERAGE_BAND) }));
    recordReadings(port, result, { parts: parts.map((part) => ({ kind: part.kind, words: part.words, criteria: part.criteria.map((criterion) => criterion.id), reading: part.reading })) });
    return { parts, decisionId: result.decisionId, usage: result.usage, recordAction: (action) => recordAction(port, result.decisionId, action) };
  },
  checkFixtures: (port, options = {}) =>
    checkEachFixture(FIXTURES, options, async (fixture, run): Promise<FixtureCheck> => {
      const { parts } = await planCoverage.read(port, fixture, run);
      const conclusion = coverageConclusion(parts);
      return fixtureCheck(fixture.name, 'uncovered', fixture.expect.uncovered, conclusion.uncovered, conclusion.signal, conclusion.outcome, { answers: ['yes', 'no'] });
    }),
};
