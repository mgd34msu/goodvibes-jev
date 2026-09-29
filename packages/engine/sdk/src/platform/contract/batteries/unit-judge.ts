/**
 * `contract.unit-judge` (docs/design/contract-runner.md section 4.4): the judge
 * pattern over one unit's work. One request per check asks, for each judged
 * criterion, whether the output fails it or the evidence fails to show it is
 * met, and once whether the output fails the unit's goal.
 *
 * Bands: a false pass accepts failing work, so the pass (no) side carries the
 * higher stakes; a false fail costs one nudge. `contract.acceptanceStakes`
 * chooses between the two declared bands and nothing else; `critical` never
 * passes a criterion on a reading alone, so the owner confirms every pass.
 *
 * Readings to verdicts (section 4.5) sit beside the bands in
 * {@link criterionVerdict}; the group and deliverable judges use the same
 * bands and the same mapping.
 */
import { defineJudge, leansYes, STAKES_BANDS, type Judge, type JudgeFixture, type YesNoBand, type YesNoReading } from '@goodvibes-jev/judgment';
import type { ContractAcceptanceStakes } from '../config.js';
import type { CriterionVerdict } from '../types.js';

/** The two pass bands `contract.acceptanceStakes` chooses between. */
export const UNIT_JUDGE_BANDS: Readonly<Record<ContractAcceptanceStakes, YesNoBand>> = {
  high: { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence },
  critical: { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.critical.confidence },
};

/**
 * A criterion or goal verdict from its judge reading, where yes means it
 * fails. Leaning yes (the reading's likelier side is "fails") is unmet at any
 * outcome, including a reading too weak to settle in the band: failing closed
 * costs one nudge. Met needs a no at act; a weaker no, or a reading leaning no
 * that did not settle, is unshown.
 */
export function criterionVerdict(reading: YesNoReading): CriterionVerdict {
  if (reading.verdict === 'yes' || (reading.verdict === 'uncertain' && leansYes(reading.probability))) return 'unmet';
  return reading.verdict === 'no' && reading.outcome === 'act' ? 'met' : 'unshown';
}

const SLUGIFY_CRITERIA = [
  'slugify lowercases every letter of its input',
  'slugify turns each run of spaces or punctuation into a single hyphen',
  'The tests for slugify pass',
] as const;

const FORMAT_BYTES_CRITERIA = [
  "formatBytes(1024) returns '1 KB'",
  "formatBytes(0) returns '0 B'",
] as const;

/** An engineer's final output: a short summary, then the JSON completion report the unit prompt asks for. */
function withReport(summary: string, report: Record<string, unknown>): string {
  return `${summary}\n\n\`\`\`json\n${JSON.stringify({ version: 1, archetype: 'engineer', ...report }, null, 2)}\n\`\`\``;
}

const RETRY_GOAL = 'fetchWithRetry retries a failed request before giving up';
const RETRY_CRITERIA = ['fetchWithRetry retries a failed request up to 3 times', 'The project typechecks'] as const;

const FIXTURES: readonly JudgeFixture[] = [
  {
    name: 'all criteria met, with tests shown passing',
    goal: 'Add a slugify helper that turns titles into URL slugs',
    criteria: SLUGIFY_CRITERIA,
    output: 'Added slugify in src/slug.ts with tests in src/slug.test.ts. The tests pass.',
    evidence: {
      changedPaths: ['src/slug.ts', 'src/slug.test.ts'],
      diff: [
        '+++ b/src/slug.ts',
        '+export function slugify(title: string): string {',
        "+  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
        '+}',
        '+++ b/src/slug.test.ts',
        "+test('lowercases', () => expect(slugify('Hello World')).toBe('hello-world'));",
        "+test('collapses runs', () => expect(slugify('a  --  b!!c')).toBe('a-b-c'));",
        "+test('trims edges', () => expect(slugify('  Hi!  ')).toBe('hi'));",
      ].join('\n'),
      omitted: [],
      gates: [{ gate: 'typecheck', passed: true }],
      commands: [{ command: 'bun test src/slug.test.ts', success: true, head: ' 3 pass\n 0 fail\nRan 3 tests across 1 file.' }],
    },
    expect: { verdict: 'pass', unmet: [] },
  },
  {
    name: 'one criterion unmet: only single spaces become hyphens',
    goal: 'Add a slugify helper that turns titles into URL slugs',
    criteria: SLUGIFY_CRITERIA,
    output: 'Added slugify in src/slug.ts with a test. The tests pass.',
    evidence: {
      changedPaths: ['src/slug.ts', 'src/slug.test.ts'],
      diff: [
        '+++ b/src/slug.ts',
        '+export function slugify(title: string): string {',
        "+  return title.toLowerCase().replace(/ /g, '-');",
        '+}',
        '+++ b/src/slug.test.ts',
        "+test('lowercases', () => expect(slugify('Hello World')).toBe('hello-world'));",
      ].join('\n'),
      omitted: [],
      gates: [{ gate: 'typecheck', passed: true }],
      commands: [
        { command: 'bun test src/slug.test.ts', success: true, head: ' 1 pass\n 0 fail' },
        { command: `bun -e "import {slugify} from './src/slug'; console.log(slugify('a  --  b!!c'))"`, success: true, head: 'a---b!!c' },
      ],
    },
    expect: { verdict: 'fail', unmet: [1] },
  },
  {
    name: 'every criterion met but the goal is not: the reset route sends nothing',
    goal: 'Users who forgot their password can reset it: they request a reset and receive an email with a reset link',
    criteria: ['A POST /password-reset route exists', 'POST /password-reset responds with status 202'],
    output: 'Added the POST /password-reset route. It responds 202.',
    evidence: {
      changedPaths: ['src/routes/password-reset.ts'],
      diff: [
        '+++ b/src/routes/password-reset.ts',
        "+router.post('/password-reset', (_req, res) => {",
        '+  res.status(202).end();',
        '+});',
      ].join('\n'),
      omitted: [],
      gates: [{ gate: 'typecheck', passed: true }],
      commands: [{ command: 'curl -s -o /dev/null -w "%{http_code}" -X POST localhost:3000/password-reset', success: true, head: '202' }],
    },
    expect: { verdict: 'fail', unmet: [] },
  },
  {
    name: 'evidence missing for a claim: tests said to pass but never run',
    goal: "Teach parseDuration to read seconds, so '90s' means 90",
    criteria: ["parseDuration('90s') returns 90", '`bun test` exits with status 0 after the change'],
    output: "Added the 's' suffix to parseDuration. All tests pass.",
    evidence: {
      changedPaths: ['src/duration.ts'],
      diff: [
        '+++ b/src/duration.ts',
        "+  if (text.endsWith('s')) return Number(text.slice(0, -1));",
      ].join('\n'),
      omitted: [],
      gates: [],
      commands: [{ command: `bun -e "import {parseDuration} from './src/duration'; console.log(parseDuration('90s'))"`, success: true, head: '90' }],
    },
    expect: { verdict: 'fail', unmet: [1] },
  },
  {
    name: 'regression pair, first check: zero bytes unmet',
    goal: 'Add formatBytes, which renders a byte count in human units',
    criteria: FORMAT_BYTES_CRITERIA,
    output: 'Added formatBytes in src/bytes.ts.',
    evidence: {
      changedPaths: ['src/bytes.ts'],
      diff: [
        '+++ b/src/bytes.ts',
        "+const UNITS = ['B', 'KB', 'MB', 'GB'];",
        '+export function formatBytes(n: number): string {',
        '+  const i = Math.floor(Math.log(n) / Math.log(1024));',
        '+  return `${Math.round(n / 1024 ** i)} ${UNITS[i]}`;',
        '+}',
      ].join('\n'),
      omitted: [],
      gates: [],
      commands: [
        { command: `bun -e "import {formatBytes} from './src/bytes'; console.log(formatBytes(1024))"`, success: true, head: '1 KB' },
        { command: `bun -e "import {formatBytes} from './src/bytes'; console.log(formatBytes(0))"`, success: true, head: 'NaN undefined' },
      ],
    },
    expect: { verdict: 'fail', unmet: [1] },
  },
  {
    name: 'regression pair, second check: zero fixed, 1024 broken',
    goal: 'Add formatBytes, which renders a byte count in human units',
    criteria: FORMAT_BYTES_CRITERIA,
    output: 'Fixed formatBytes(0); it now returns 0 B.',
    evidence: {
      changedPaths: ['src/bytes.ts'],
      diff: [
        '+++ b/src/bytes.ts',
        "+const UNITS = ['B', 'KB', 'MB', 'GB'];",
        '+export function formatBytes(n: number): string {',
        "+  if (n === 0) return '0 B';",
        '+  const i = Math.floor(Math.log(n) / Math.log(1000));',
        '+  return `${(n / 1000 ** i).toFixed(2)} ${UNITS[i]}`;',
        '+}',
      ].join('\n'),
      omitted: [],
      gates: [],
      commands: [
        { command: `bun -e "import {formatBytes} from './src/bytes'; console.log(formatBytes(1024))"`, success: true, head: '1.02 KB' },
        { command: `bun -e "import {formatBytes} from './src/bytes'; console.log(formatBytes(0))"`, success: true, head: '0 B' },
      ],
    },
    expect: { verdict: 'fail', unmet: [0] },
  },
  {
    name: 'a written deliverable that meets its criteria',
    goal: 'Write a short design note choosing a cache for the session store',
    criteria: ['The note names the cache it recommends', 'The note gives at least one reason for the choice'],
    output:
      'Design note: session store cache.\n\nRecommendation: use Redis.\n\nReasons: sessions must survive a restart of any one web server, and Redis is already run in production for the job queue, so it adds no new service.',
    evidence: { changedPaths: [], diff: '', omitted: [], gates: [], commands: [] },
    expect: { verdict: 'pass', unmet: [] },
  },
  {
    name: 'a completion report at the end, claims verified, some files omitted from the diff',
    goal: 'Add a slugify helper that turns titles into URL slugs',
    criteria: SLUGIFY_CRITERIA,
    output: withReport('Added slugify in src/slug.ts with tests; the tests pass.', {
      summary: 'Added slugify and its tests.',
      gatheredContext: ['src/util has no slug helper yet'],
      plannedActions: ['write src/slug.ts', 'write src/slug.test.ts'],
      appliedChanges: ['slugify lowercases, collapses runs of non-alphanumerics to one hyphen and trims hyphens'],
      filesCreated: ['src/slug.ts', 'src/slug.test.ts'],
      filesModified: ['src/index.ts'],
      filesDeleted: [],
      decisions: [{ what: 'a regular expression over [^a-z0-9]', why: 'one pass covers spaces and punctuation' }],
      issues: [],
      uncertainties: [],
    }),
    evidence: {
      changedPaths: ['src/slug.ts', 'src/slug.test.ts', 'src/index.ts'],
      diff: [
        '+++ b/src/slug.ts',
        '+export function slugify(title: string): string {',
        "+  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
        '+}',
      ].join('\n'),
      omitted: ['src/slug.test.ts', 'src/index.ts'],
      claims: { kind: 'files_verified', summary: '3/3 claimed paths found on disk; changed since baseline: 3 paths; kind: files_verified', missingPaths: [] },
      gates: [{ gate: 'typecheck', passed: true, skipped: false, output: '' }],
      commands: [{ command: 'bun test src/slug.test.ts', success: true, head: ' 3 pass\n 0 fail\nRan 3 tests across 1 file.' }],
    },
    expect: { verdict: 'pass', unmet: [] },
  },
  {
    name: 'a failing typecheck gate under a report that says all is well',
    goal: RETRY_GOAL,
    criteria: RETRY_CRITERIA,
    output: withReport('Added fetchWithRetry with up to 3 retries. Everything builds.', {
      summary: 'Added fetchWithRetry.',
      appliedChanges: ['fetchWithRetry retries up to 3 times'],
      filesCreated: ['src/retry.ts'],
      filesModified: [],
      filesDeleted: [],
      issues: [],
      uncertainties: [],
    }),
    evidence: {
      changedPaths: ['src/retry.ts'],
      diff: [
        '+++ b/src/retry.ts',
        'export async function fetchWithRetry(url: string): Promise<Response> {',
        '+  let lastError: unknown;',
        '+  for (let attempt = 0; attempt <= 3; attempt += 1) {',
        '+    try { return await fetch(url); } catch (error) { lastError = error; }',
        '+  }',
        '+  const failed: Response = lastError;',
        '+  return failed;',
        '+}',
      ].join('\n'),
      omitted: [],
      claims: { kind: 'files_verified', summary: '1/1 claimed paths found on disk; changed since baseline: 1 path; kind: files_verified', missingPaths: [] },
      gates: [{ gate: 'typecheck', passed: false, skipped: false, output: "src/retry.ts(6,9): error TS2322: Type 'unknown' is not assignable to type 'Response'." }],
      commands: [],
    },
    expect: { verdict: 'fail', unmet: [1] },
  },
  {
    name: 'a test file claimed in the report but missing on disk',
    goal: RETRY_GOAL,
    criteria: ['fetchWithRetry retries a failed request up to 3 times', 'test/retry.test.ts tests the retry count'],
    output: withReport('Added fetchWithRetry and a test for it in test/retry.test.ts.', {
      summary: 'Added fetchWithRetry and its test.',
      appliedChanges: ['fetchWithRetry retries up to 3 times', 'test/retry.test.ts checks the retry count'],
      filesCreated: ['src/retry.ts', 'test/retry.test.ts'],
      filesModified: [],
      filesDeleted: [],
      issues: [],
      uncertainties: [],
    }),
    evidence: {
      changedPaths: ['src/retry.ts'],
      diff: [
        '+++ b/src/retry.ts',
        '+const MAX_RETRIES = 3;',
        'export async function fetchWithRetry(url: string): Promise<Response> {',
        '+  for (let retry = 0; ; retry += 1) {',
        '+    try { return await fetch(url); } catch (error) { if (retry === MAX_RETRIES) throw error; }',
        '+  }',
        '+}',
      ].join('\n'),
      omitted: [],
      claims: { kind: 'unverified', summary: '1/2 claimed paths found on disk; missing: test/retry.test.ts; changed since baseline: 1 path; kind: unverified', missingPaths: ['test/retry.test.ts'] },
      gates: [{ gate: 'typecheck', passed: true, skipped: false, output: '' }],
      commands: [{
        command: `bun -e "import {fetchWithRetry} from './src/retry'; let calls = 0; globalThis.fetch = async () => { calls += 1; throw new Error('down'); }; await fetchWithRetry('x').catch(() => console.log('calls', calls))"`,
        success: true,
        head: 'calls 4',
      }],
    },
    expect: { verdict: 'fail', unmet: [1] },
  },
];

function unitJudge(name: string, band: YesNoBand): Judge {
  return defineJudge({
    name,
    version: 1,
    description: "Whether a unit's work meets each of its acceptance criteria, shown by its output and evidence, and whether it achieves the unit's goal.",
    accuracyFloor: 0.9,
    band,
    fixtures: FIXTURES,
  });
}

/**
 * The unit judge under each acceptance-stakes band; the fixtures and questions
 * are the same. Each instance is its own named decision, so calibration shows
 * the outcomes each band gives and the decision log says which band read a check.
 */
export const UNIT_JUDGES: Readonly<Record<ContractAcceptanceStakes, Judge>> = {
  high: unitJudge('contract.unit-judge', UNIT_JUDGE_BANDS.high),
  critical: unitJudge('contract.unit-judge.critical', UNIT_JUDGE_BANDS.critical),
};

/** The instance at the default `high` stakes. */
export const unitJudgeDecision = UNIT_JUDGES.high;
