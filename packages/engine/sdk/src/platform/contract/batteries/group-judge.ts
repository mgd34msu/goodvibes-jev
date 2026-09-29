/**
 * `contract.group-judge` (docs/design/contract-runner.md section 6.4): the
 * judge pattern over a group once every unit in it passed. `goal` is the
 * group's goal, `criteria` its criteria, `output` the units' answers, and
 * `evidence` the group's diff since it started, its gate results in the
 * contract's tree, and each unit's criteria with their verdicts.
 *
 * Bands: the unit judge's two declared bands, chosen by
 * `contract.acceptanceStakes` (a false pass accepts failing work), and its
 * mapping from readings to verdicts ({@link groupVerdict}).
 */
import { defineJudge, type Judge, type JudgeFixture, type YesNoBand, type YesNoReading } from '@goodvibes-jev/judgment';
import type { ContractAcceptanceStakes } from '../config.js';
import type { CriterionVerdict } from '../types.js';
import { criterionVerdict, UNIT_JUDGE_BANDS } from './unit-judge.js';

/** A group criterion or goal verdict from its reading: the unit judge's mapping (section 4.5), since the bands are the same. */
export const groupVerdict: (reading: YesNoReading) => CriterionVerdict = criterionVerdict;

const MODULES_GOAL = 'A CSV parser and a JSON formatter, each tested, ready for the convert command';
const MODULES_CRITERIA = [
  'parseCsv and formatJson are both exported from src/index.ts',
  'The tests for both modules pass',
] as const;

const MODULE_UNITS = [
  { id: 'u1', title: 'CSV parser', criteria: [{ id: 'u1.c1', text: 'src/csv.ts parses quoted fields and its tests pass', verdict: 'met' }] },
  { id: 'u2', title: 'JSON formatter', criteria: [{ id: 'u2.c1', text: 'src/json.ts formats records as pretty JSON and its tests pass', verdict: 'met' }] },
];

const FIXTURES: readonly JudgeFixture[] = [
  {
    name: 'both modules exported and tested',
    goal: MODULES_GOAL,
    criteria: MODULES_CRITERIA,
    output: 'u1 "CSV parser": Added parseCsv in src/csv.ts with tests.\nu2 "JSON formatter": Added formatJson in src/json.ts with tests.',
    evidence: {
      changedPaths: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts', 'src/index.ts'],
      diff: [
        '+++ b/src/index.ts',
        "+export { parseCsv } from './csv';",
        "+export { formatJson } from './json';",
      ].join('\n'),
      omitted: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts'],
      gates: [{ gate: 'test', passed: true, output: ' 9 pass\n 0 fail\nRan 9 tests across 2 files.' }],
      units: MODULE_UNITS,
    },
    expect: { verdict: 'pass', unmet: [] },
  },
  {
    name: 'the formatter is never exported',
    goal: MODULES_GOAL,
    criteria: MODULES_CRITERIA,
    output: 'u1 "CSV parser": Added parseCsv in src/csv.ts with tests.\nu2 "JSON formatter": Added formatJson in src/json.ts with tests.',
    evidence: {
      changedPaths: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts', 'src/index.ts'],
      diff: ['+++ b/src/index.ts', "+export { parseCsv } from './csv';"].join('\n'),
      omitted: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts'],
      gates: [{ gate: 'test', passed: true, output: ' 9 pass\n 0 fail\nRan 9 tests across 2 files.' }],
      units: MODULE_UNITS,
    },
    expect: { verdict: 'fail', unmet: [0] },
  },
  {
    name: 'the tests fail once both modules sit together',
    goal: MODULES_GOAL,
    criteria: MODULES_CRITERIA,
    output: 'u1 "CSV parser": Added parseCsv in src/csv.ts with tests.\nu2 "JSON formatter": Added formatJson in src/json.ts with tests.',
    evidence: {
      changedPaths: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts', 'src/index.ts'],
      diff: [
        '+++ b/src/index.ts',
        "+export { parseCsv } from './csv';",
        "+export { formatJson } from './json';",
      ].join('\n'),
      omitted: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts'],
      gates: [{
        gate: 'test',
        passed: false,
        output: "src/json.test.ts:\n(fail) formatJson > formats a parsed row\n  error: Cannot find name 'Row' imported from './csv'\n 7 pass\n 2 fail",
      }],
      units: MODULE_UNITS,
    },
    expect: { verdict: 'fail', unmet: [1] },
  },
  {
    name: 'every criterion holds but the group does not do its job: the two halves disagree on the record shape',
    goal: 'Orders can be exported and re-imported without losing data',
    criteria: ['exportOrders writes orders.json', 'importOrders reads orders.json'],
    output: 'u1 "Export": exportOrders writes orders.json as an array of { id, total }.\nu2 "Import": importOrders reads orders.json as an object keyed by order id.',
    evidence: {
      changedPaths: ['src/export.ts', 'src/import.ts'],
      diff: [
        '+++ b/src/export.ts',
        '+export function exportOrders(orders: Order[]): void {',
        "+  writeFileSync('orders.json', JSON.stringify(orders.map((o) => ({ id: o.id, total: o.total }))));",
        '+}',
        '+++ b/src/import.ts',
        '+export function importOrders(): Record<string, Order> {',
        "+  return JSON.parse(readFileSync('orders.json', 'utf-8')) as Record<string, Order>;",
        '+}',
      ].join('\n'),
      omitted: [],
      gates: [{ gate: 'typecheck', passed: true, output: '' }],
      units: [
        { id: 'u1', title: 'Export', criteria: [{ id: 'u1.c1', text: 'exportOrders writes orders.json', verdict: 'met' }] },
        { id: 'u2', title: 'Import', criteria: [{ id: 'u2.c1', text: 'importOrders reads orders.json', verdict: 'met' }] },
      ],
    },
    expect: { verdict: 'fail', unmet: [] },
  },
  {
    name: 'login and the session guard work together',
    goal: 'Admins log in with a password, and admin pages need a session',
    criteria: ['POST /login with the right password sets a session cookie', 'Admin pages answer 401 to a request without a session'],
    output: 'u1 "Login route": POST /login checks the password hash and sets the sid cookie.\nu2 "Session guard": requireSession answers 401 without a valid sid and is applied to every /admin route.',
    evidence: {
      changedPaths: ['src/routes/login.ts', 'src/middleware/session.ts', 'src/routes/admin.ts', 'test/auth.test.ts'],
      diff: [
        '+++ b/src/routes/login.ts',
        "+router.post('/login', async (req, res) => {",
        '+  if (!(await verifyPassword(req.body.password))) return res.status(401).end();',
        "+  res.cookie('sid', await sessions.create(), { httpOnly: true, sameSite: 'strict' }).status(204).end();",
        '+});',
        '+++ b/src/middleware/session.ts',
        '+export async function requireSession(req, res, next) {',
        "+  if (!(await sessions.valid(req.cookies.sid))) return res.status(401).end();",
        '+  next();',
        '+}',
        '+++ b/src/routes/admin.ts',
        "+adminRouter.use(requireSession);",
      ].join('\n'),
      omitted: ['test/auth.test.ts'],
      gates: [{ gate: 'test', passed: true, output: " 6 pass\n 0 fail\n(pass) login sets sid\n(pass) /admin without sid is 401\n(pass) /admin with sid is 200" }],
      units: [
        { id: 'u1', title: 'Login route', criteria: [{ id: 'u1.c1', text: 'POST /login sets a session cookie for the right password', verdict: 'met' }] },
        { id: 'u2', title: 'Session guard', criteria: [{ id: 'u2.c1', text: 'requireSession answers 401 without a session', verdict: 'met' }] },
      ],
    },
    expect: { verdict: 'pass', unmet: [] },
  },
  {
    name: 'every criterion holds but the results cannot be paged: the cursor is never read',
    goal: 'Search results can be paged through, 20 at a time',
    criteria: ['GET /search returns at most 20 results', 'GET /search includes a nextCursor when more results exist'],
    output: 'u1 "Page size": /search returns at most 20 results.\nu2 "Cursor": /search adds nextCursor, the id of the last result, when there are more; a client sends it back as ?cursor= to get the next page.',
    evidence: {
      changedPaths: ['src/routes/search.ts'],
      diff: [
        '--- a/src/routes/search.ts',
        '+++ b/src/routes/search.ts',
        '@@ the whole file after the change @@',
        " import { index } from '../search/index';",
        " export const router = Router();",
        " router.get('/search', async (req, res) => {",
        '-  const results = await index.query(req.query.q);',
        '+  const results = await index.query(req.query.q, { limit: 21 });',
        '+  const page = results.slice(0, 20);',
        '+  res.json({ results: page, ...(results.length > 20 ? { nextCursor: page.at(-1).id } : {}) });',
        ' });',
        '# index.query(q, { limit }) always starts from the first match; it takes no cursor or offset option.',
      ].join('\n'),
      omitted: [],
      gates: [{ gate: 'test', passed: false, output: ' 4 pass\n 1 fail\n(fail) search paging > the second page starts after the first\n  expected the first result of ?cursor=r20 to be r21, received r1' }],
      units: [
        { id: 'u1', title: 'Page size', criteria: [{ id: 'u1.c1', text: '/search returns at most 20 results', verdict: 'met' }] },
        { id: 'u2', title: 'Cursor', criteria: [{ id: 'u2.c1', text: '/search includes nextCursor when more results exist', verdict: 'met' }] },
      ],
    },
    expect: { verdict: 'fail', unmet: [] },
  },
];

function groupJudge(name: string, band: YesNoBand): Judge {
  return defineJudge({
    name,
    version: 1,
    description: "Whether a group's combined work meets each of the group's criteria, shown by its units' answers and the group's evidence, and whether it achieves the group's goal.",
    accuracyFloor: 0.9,
    band,
    fixtures: FIXTURES,
  });
}

/** The group judge under each acceptance-stakes band, each its own named decision; the fixtures and questions are the same. */
export const GROUP_JUDGES: Readonly<Record<ContractAcceptanceStakes, Judge>> = {
  high: groupJudge('contract.group-judge', UNIT_JUDGE_BANDS.high),
  critical: groupJudge('contract.group-judge.critical', UNIT_JUDGE_BANDS.critical),
};

/** The instance at the default `high` stakes. */
export const groupJudgeDecision = GROUP_JUDGES.high;
