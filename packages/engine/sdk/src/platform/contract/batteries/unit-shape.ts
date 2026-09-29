/**
 * `contract.unit-shape` (docs/design/contract-runner.md section 3.4): what
 * kind of work a planned unit is, and whether it does less than the contract
 * criteria it serves. One request per unit about
 * `{ goal, unit: { title, goal, brief, criteria }, otherUnits: [{ title, goal, criteria }] }`
 * asks `role` and one `narrows_<id>` question for each contract criterion
 * the unit serves, the criterion riding in the question as `requirement`.
 * `otherUnits` carries the other units' criteria, so a unit that takes one
 * module while a sibling takes the other is seen to be made up by it.
 *
 * Jev verifies inside every unit, so a unit whose job is to review, test or
 * verify other units is refused and the planner folds the check into the
 * criteria of the unit it would verify.
 *
 * Why one narrows question per requirement: one question per unit against
 * all its requirements at once, with the other units shown by title, never
 * settled on real plans. In the contract proof run every unit of plans whose
 * units did all their criteria asked read 0.17 to 0.5, below the no band, so
 * each plan went through two repairs the planner could not act on. Asked one
 * requirement at a time, with the other units' criteria in view, the same
 * units read 38 of their 42 requirements no at act (calibration,
 * 2026-09-29); the rest lean no below act and clear. The fixtures below
 * include those units as the planner wrote them.
 *
 * Bands: the role is read at medium stakes. `narrows` is read at medium
 * stakes on both sides: every contract criterion is judged again at the
 * deliverable check at high stakes (section 6.4), so a unit that narrows the
 * scope it serves cannot pass the contract, and a narrowing read wrongly as
 * none costs a fix round, not a wrong acceptance.
 *
 * What code does with the readings (composed in plan-checks.ts): a `narrows`
 * reading that leans yes is a problem at any outcome. One that leans no
 * clears its requirement at any outcome; below act the unit's action records
 * the requirement as cleared below act, and the deliverable check judges it
 * again. The role acts only at act.
 */
import {
  askAs,
  assertBand,
  checkEachFixture,
  checkReading,
  choice,
  decisionHeader,
  noul,
  readChoice,
  readYesNo,
  recordAction,
  recordReadings,
  STAKES_BANDS,
  type CallOptions,
  type ChoiceBand,
  type ChoiceReading,
  type ChoiceResponse,
  type FixtureCheck,
  type JudgmentPort,
  type NamedDecision,
  type NoulResponse,
  type Question,
  type YesNoBand,
  type YesNoReading,
} from '@goodvibes-jev/judgment';
import { PROOF_PLANS, type ProofPlan, type ProofUnit } from './plan-coverage.js';

/** The roles Jev can read; `review`, `test` and `verify` are never allowed as units. */
export const UNIT_SHAPE_ROLES = {
  implement: 'Changes files or produces the deliverable itself, including writing code, tests or documentation',
  research: 'Reads code, documents or data and reports what it found, changing nothing',
  design: 'Produces a plan or design as its answer, changing nothing',
  review: "Examines other units' finished work and reports findings or opinions about it",
  test: "Only runs tests or checks against other units' work and reports the results, writing nothing",
  verify: "Only confirms or signs off that other units' work is correct or complete",
} as const;
export type UnitShapeRole = keyof typeof UNIT_SHAPE_ROLES;

/** Roles that exist only to check other units' work. */
export const VERIFICATION_ROLES: readonly UnitShapeRole[] = ['review', 'test', 'verify'];

export const ROLE_BAND: ChoiceBand<UnitShapeRole> = STAKES_BANDS.medium.confidence;
export const NARROWS_BAND: YesNoBand = { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.medium.confidence };

const ROLE_QUESTION = choice('What kind of work does `unit` do?', UNIT_SHAPE_ROLES);
const NARROWS_QUESTION = 'Does `unit` do less than `requirement` sets (fewer items, a smaller area or a weaker standard) with no entry of `otherUnits` doing the rest?';
const NARROWS_CRITERIA = {
  true: 'Some of what the requirement asks for is done by neither the unit nor any other unit',
  false: 'Everything the requirement asks for is done by the unit or by another unit, possibly in other words',
} as const;

/** The question name a requirement is asked under. */
const narrowsKey = (id: string): string => `narrows_${id}`;

export interface UnitShapeUnit {
  readonly title: string;
  readonly goal: string;
  readonly brief: string;
  readonly criteria: readonly string[];
}

export interface UnitShapeSibling {
  readonly title: string;
  readonly goal: string;
  readonly criteria: readonly string[];
}

/** A contract criterion the unit serves. */
export interface UnitShapeRequirement {
  readonly id: string;
  readonly text: string;
}

export interface UnitShapeInput {
  /** The contract goal. */
  readonly goal: string;
  readonly unit: UnitShapeUnit;
  readonly otherUnits: readonly UnitShapeSibling[];
  /** One `narrows` question each; none asks only the role. */
  readonly requirements: readonly UnitShapeRequirement[];
}

/** A unit as a plan holds it: what {@link unitShapeInput} reads. */
export interface ShapedUnit {
  readonly title: string;
  readonly goal: string;
  readonly brief: string;
  readonly criteria: readonly { readonly text: string; readonly serves: readonly string[] }[];
}

/** What `contract.unit-shape` reads about `unit` in a plan with `units` and contract `criteria`. */
export function unitShapeInput(
  goal: string,
  criteria: readonly UnitShapeRequirement[],
  units: readonly ShapedUnit[],
  unit: ShapedUnit,
): UnitShapeInput {
  const served = new Set(unit.criteria.flatMap((criterion) => criterion.serves));
  return {
    goal,
    unit: { title: unit.title, goal: unit.goal, brief: unit.brief, criteria: unit.criteria.map((criterion) => criterion.text) },
    otherUnits: units.filter((other) => other !== unit).map((other) => ({ title: other.title, goal: other.goal, criteria: other.criteria.map((criterion) => criterion.text) })),
    requirements: criteria.filter((criterion) => served.has(criterion.id)).map(({ id, text }) => ({ id, text })),
  };
}

export interface RequirementReading extends UnitShapeRequirement {
  readonly reading: YesNoReading;
}

export interface UnitShapeRun {
  readonly role: ChoiceReading<UnitShapeRole>;
  /** One reading per requirement, in order. */
  readonly narrows: readonly RequirementReading[];
  readonly decisionId: string | undefined;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  recordAction(action: string): void;
}

export interface UnitShapeFixture {
  readonly name: string;
  readonly input: UnitShapeInput;
  /** `narrows` labels every requirement of the input by id. */
  readonly expect: { readonly role?: UnitShapeRole; readonly narrows?: Readonly<Record<string, 'yes' | 'no'>> };
}

export interface UnitShape extends NamedDecision {
  read(port: JudgmentPort, input: UnitShapeInput, options?: CallOptions): Promise<UnitShapeRun>;
}

function questionsFor(input: UnitShapeInput): Record<string, Question> {
  return {
    role: ROLE_QUESTION,
    ...Object.fromEntries(input.requirements.map((requirement) => [narrowsKey(requirement.id), noul({ question: NARROWS_QUESTION, requirement: requirement.text }, NARROWS_CRITERIA)])),
  };
}

type Label = 'yes' | 'no';
type Sibling = readonly [title: string, goal: string, criteria: readonly string[]];

/** A written fixture: requirements get ids c1, c2... and `narrows` labels them in order; without it only the role is asked. */
function fixture(
  name: string,
  goal: string,
  requirements: readonly string[],
  unit: UnitShapeUnit,
  otherUnits: readonly Sibling[],
  expect: { readonly role?: UnitShapeRole; readonly narrows?: readonly Label[] },
): UnitShapeFixture {
  const ids = requirements.map((_, index) => `c${index + 1}`);
  const labels = expect.narrows;
  return {
    name,
    input: {
      goal,
      unit,
      otherUnits: otherUnits.map(([title, siblingGoal, criteria]) => ({ title, goal: siblingGoal, criteria })),
      requirements: labels === undefined ? [] : requirements.map((text, index) => ({ id: ids[index]!, text })),
    },
    expect: {
      ...(expect.role === undefined ? {} : { role: expect.role }),
      ...(labels === undefined ? {} : { narrows: Object.fromEntries(ids.map((id, index) => [id, labels[index]!])) }),
    },
  };
}

/**
 * A fixture from a proof-run plan, optionally altered. Only the labelled
 * requirements are asked: each narrows question is independent of the
 * others, so leaving one out changes no other reading.
 */
function proofFixture(
  name: string,
  plan: ProofPlan,
  unitId: string,
  narrows: Readonly<Record<string, Label>>,
  alter: (units: readonly ProofUnit[]) => readonly ProofUnit[] = (units) => units,
): UnitShapeFixture {
  const units = alter(plan.units);
  const unit = units.find((candidate) => candidate.id === unitId)!;
  const input = unitShapeInput(plan.goal, plan.criteria, units, unit);
  return {
    name,
    input: { ...input, requirements: input.requirements.filter((requirement) => narrows[requirement.id] !== undefined) },
    expect: { role: 'implement', narrows },
  };
}

/** `units` with unit `id` replaced by `change(unit)`. */
const withUnit = (id: string, change: (unit: ProofUnit) => ProofUnit) => (units: readonly ProofUnit[]): readonly ProofUnit[] =>
  units.map((unit) => (unit.id === id ? change(unit) : unit));
/** A unit's criteria with the one at `index` replaced. */
const replaceCriterion = (unit: ProofUnit, index: number, text: string, serves?: readonly string[]): ProofUnit['criteria'] =>
  unit.criteria.map((criterion, at) => (at === index ? { text, serves: serves ?? criterion.serves } : criterion));

const RENAME_GOAL = 'Rename getUser to fetchUser across the whole codebase';
const RENAME_CRITERIA = ['Every definition of and call to getUser in the codebase is renamed to fetchUser'];
const EXPORT_GOAL = 'Report export in CSV, JSON and XML formats';
const EXPORT_CRITERIA = ['Reports can be exported as CSV, JSON and XML'];
const LIMITER_GOAL = 'A token bucket rate limiter for the API gateway';
const LIMITER_CRITERIA = ['Requests over the configured rate get a 429 response'];
const LIMITER_UNIT: Sibling = ['Implement the limiter', 'Write the token bucket rate limiter', ['Requests over the configured rate get a 429 response']];
const EXPORT_UNITS: readonly Sibling[] = [['CSV export', 'Add CSV export', ['Reports export as CSV']], ['JSON export', 'Add JSON export', ['Reports export as JSON']], ['XML export', 'Add XML export', ['Reports export as XML']]];
const { durations, durationsFirst, version } = PROOF_PLANS;

const FIXTURES: readonly UnitShapeFixture[] = [
  fixture('full rename', RENAME_GOAL, RENAME_CRITERIA, {
    title: 'Rename getUser', goal: 'Rename getUser to fetchUser everywhere',
    brief: 'Find every definition, import and call of getUser anywhere in the repository and rename it to fetchUser, including tests and docs.',
    criteria: ['No reference to getUser remains anywhere in the repository'],
  }, [], { role: 'implement', narrows: ['no'] }),
  fixture('rename limited to one folder', RENAME_GOAL, RENAME_CRITERIA, {
    title: 'Rename getUser in the API layer', goal: 'Rename getUser to fetchUser in src/api',
    brief: 'Rename getUser to fetchUser in the files under src/api only. Leave the other folders as they are.',
    criteria: ['No reference to getUser remains in src/api'],
  }, [], { role: 'implement', narrows: ['yes'] }),
  fixture('half the scope with a sibling for the rest', EXPORT_GOAL, EXPORT_CRITERIA, {
    title: 'CSV and JSON export', goal: 'Add CSV and JSON report export',
    brief: 'Add CSV and JSON writers in src/export and wire them into the export menu. XML is handled by the XML export unit.',
    criteria: ['Reports export as CSV', 'Reports export as JSON'],
  }, [['XML export', 'Add XML report export', ['Reports export as XML']]], { role: 'implement', narrows: ['no'] }),
  fixture('format dropped with no sibling', EXPORT_GOAL, EXPORT_CRITERIA, {
    title: 'Report export', goal: 'Add CSV and JSON report export',
    brief: 'Add CSV and JSON writers in src/export and wire them into the export menu. XML can come later.',
    criteria: ['Reports export as CSV', 'Reports export as JSON'],
  }, [], { role: 'implement', narrows: ['yes'] }),
  fixture('weaker performance target', 'The search endpoint answers typical queries in under 200 ms', ['Typical queries to the search endpoint get a response in under 200 ms'], {
    title: 'Search speed-up', goal: 'Make search somewhat faster',
    brief: 'Look for easy wins in the search handler, such as caching, and apply the ones that help. Any improvement is fine.',
    criteria: ['Search is faster than before'],
  }, [], { role: 'implement', narrows: ['yes'] }),
  fixture('investigation that reports', 'Find out why the nightly export job fails', ['The cause of the nightly export failure is identified with evidence from the logs'], {
    title: 'Diagnose the export failure', goal: 'Identify the cause of the nightly export failure',
    brief: 'Read the job logs and the export code, find what makes the job fail, and report the cause with the log lines that show it. Do not change anything.',
    criteria: ['The report names the cause of the nightly export failure', 'The report quotes the log lines that show the cause'],
  }, [], { role: 'research', narrows: ['no'] }),
  fixture('migration plan', 'A plan for moving the database from Postgres 13 to 16', ['The plan lists every step of the upgrade in order', 'The plan says how to roll back each step'], {
    title: 'Write the upgrade plan', goal: 'Write a step-by-step Postgres 13 to 16 upgrade plan',
    brief: 'Study the current database setup and write an ordered upgrade plan with a rollback for every step. Return the plan as your answer; change no files.',
    criteria: ['The plan lists every upgrade step in the order the steps must run', 'The plan gives a rollback for every step'],
  }, [], { role: 'design', narrows: ['no', 'no'] }),
  fixture('code review of a sibling', LIMITER_GOAL, LIMITER_CRITERIA, {
    title: 'Review the limiter', goal: 'Review the rate limiter written by the implementation unit',
    brief: 'Read the diff the implementation unit produced for the rate limiter and write review comments on its design, naming and edge cases.',
    criteria: ['The review comments on every changed file'],
  }, [LIMITER_UNIT], { role: 'review' }),
  fixture('test run of siblings', 'CSV and JSON report export', ['Reports export as CSV and JSON'], {
    title: 'Run the test suite', goal: "Run the tests against the other units' changes",
    brief: 'After the export units finish, run bun test and the end-to-end suite against their changes and report which tests pass and which fail. Do not write or change any code or tests.',
    criteria: ['The report lists the result of every test run'],
  }, EXPORT_UNITS.slice(0, 2), { role: 'test' }),
  fixture('sign-off of siblings', RENAME_GOAL, RENAME_CRITERIA, {
    title: 'Confirm the rename', goal: "Confirm the other units' rename is complete and correct",
    brief: 'Once the rename units finish, confirm that their work is complete and correct and sign it off.',
    criteria: ['The rename is confirmed complete'],
  }, [['Rename in src', 'Rename getUser in src', ['No reference to getUser remains in src']], ['Rename in test', 'Rename getUser in test', ['No reference to getUser remains in test']]], { role: 'verify' }),
  fixture('integration unit combining the parts', 'A convert command that reads a CSV file and writes it as JSON', ['convert <in.csv> <out.json> writes the CSV rows as a JSON array of objects'], {
    title: 'Integrate the convert command', goal: 'Combine the CSV parser and the JSON formatter into the convert command',
    brief: 'Wire parseCsv and formatJson into src/cli/convert.ts, export both from src/index.ts, resolve any conflicts between the two parts, and make the whole test suite pass.',
    criteria: ['convert in.csv out.json writes the rows of in.csv as a JSON array', 'The whole test suite passes with both parts in place'],
  }, [['CSV parser', 'Add parseCsv', ['parseCsv returns the rows of a CSV text']], ['JSON formatter', 'Add formatJson', ['formatJson writes rows as a JSON array of objects']]], { role: 'implement', narrows: ['no'] }),
  fixture('integration unit merging export writers into the menu', EXPORT_GOAL, EXPORT_CRITERIA, {
    title: 'Integrate the export formats', goal: 'Bring the three export writers together behind the export menu',
    brief: 'Take the CSV, JSON and XML writers the other units wrote, register all three in src/export/index.ts and the export menu, update the docs page that lists the formats, and fix whatever the combination breaks.',
    criteria: ['The export menu offers CSV, JSON and XML', 'Choosing each format writes a file in that format'],
  }, EXPORT_UNITS, { role: 'implement', narrows: ['no'] }),
  fixture('find every reader of a setting', 'Find out where the app reads DATABASE_URL', ['Every place that reads DATABASE_URL is listed'], {
    title: 'Locate DATABASE_URL reads', goal: 'List every place the code reads DATABASE_URL',
    brief: 'Search the repository for every read of the DATABASE_URL environment variable and report each file and line. Change nothing.',
    criteria: ['The report lists every file and line that reads DATABASE_URL'],
  }, [], { role: 'research', narrows: ['no'] }),
  fixture('survey of queue libraries', 'Know which queue libraries support delayed and repeatable jobs', ['BullMQ, Bee-Queue and Agenda are each checked for delayed and repeatable jobs'], {
    title: 'Survey queue libraries', goal: 'Report which of BullMQ, Bee-Queue and Agenda support delayed and repeatable jobs',
    brief: 'Read the documentation of BullMQ, Bee-Queue and Agenda and report, for each, whether it supports delayed jobs and repeatable jobs, with a link to the page that says so. Change nothing in the repository.',
    criteria: ['The report covers BullMQ, Bee-Queue and Agenda', 'For each library the report says whether it supports delayed and repeatable jobs, with a link'],
  }, [], { role: 'research', narrows: ['no'] }),
  fixture('billing schema design', 'A database schema for multi-tenant billing', ['The schema gives every table, column and key billing needs, with tenants kept apart'], {
    title: 'Design the billing schema', goal: 'Design the tables, columns and keys for multi-tenant billing',
    brief: 'Design the database schema for multi-tenant billing: every table with its columns, types, keys and indexes, and how tenant data is kept apart. Return the design as your answer; do not write migrations or change any files.',
    criteria: ['The design lists every table with its columns, types and keys', "The design says how each tenant's rows are kept apart"],
  }, [], { role: 'design', narrows: ['no'] }),
  fixture('API specification for a new endpoint', 'A specification for the /v2 orders endpoint', ['The specification gives the paths, parameters, responses and pagination of /v2/orders'], {
    title: 'Specify /v2/orders', goal: 'Write the API specification for /v2/orders',
    brief: 'Write a specification for the /v2/orders endpoint: paths, query parameters, response bodies, error codes and how pagination works. Give it as your answer; do not implement it.',
    criteria: ['The specification covers paths, query parameters, responses and error codes', 'The specification says how pagination works'],
  }, [], { role: 'design', narrows: ['no'] }),
  fixture('security review of a sibling', 'Session login for the admin console', ['Admins log in with a password and get a session cookie'], {
    title: 'Security review of login', goal: "Review the login unit's finished code for security problems",
    brief: "When the login unit finishes, read its diff and write review comments on any security problems (cookie flags, password handling, timing), naming the file and line of each.",
    criteria: ['The review names the file and line of every problem it raises'],
  }, [['Implement login', 'Add password login with a session cookie', ['Admins log in with a password and get a session cookie']]], { role: 'review' }),
  fixture('readability review of a sibling', 'A CSV parser for the import command', ['parseCsvLine keeps commas inside quoted fields'], {
    title: 'Review the parser code', goal: "Give feedback on the parser unit's code",
    brief: "Examine the parser unit's finished code and report suggestions about naming, structure and readability. Do not change the code.",
    criteria: ['The feedback covers naming, structure and readability'],
  }, [['Write the parser', 'Add parseCsvLine', ['parseCsvLine keeps commas inside quoted fields']]], { role: 'review' }),
  fixture('end-to-end run of siblings', 'Customers can pay with saved cards at checkout', ["Checkout offers the customer's saved cards"], {
    title: 'Run the checkout end-to-end suite', goal: "Run the end-to-end checkout tests against the other units' changes",
    brief: 'After the saved-cards units finish, run the end-to-end checkout suite against their changes and report which scenarios pass and which fail. Write no code and no tests.',
    criteria: ['The report gives the result of every checkout scenario'],
  }, [['Saved cards API', 'Store and list saved cards', ['The API stores and lists saved cards']], ['Checkout UI', 'Show saved cards at checkout', ['Checkout shows the saved cards']]], { role: 'test' }),
  fixture('typecheck and lint run of siblings', 'Move the settings code to the new config loader', ['Every service reads its settings through loadConfig'], {
    title: 'Check the migration builds', goal: "Run the typecheck and lint against the migration units' changes",
    brief: 'Once the migration units finish, run the typecheck and the linter over their changes and report every error found. Do not fix anything.',
    criteria: ['The report lists every typecheck and lint error'],
  }, [['Migrate billing', 'Billing reads loadConfig', ['Billing reads its settings through loadConfig']], ['Migrate search', 'Search reads loadConfig', ['Search reads its settings through loadConfig']]], { role: 'test' }),
  fixture('sign-off of the export units', EXPORT_GOAL, EXPORT_CRITERIA, {
    title: 'Sign off the exports', goal: "Confirm the export units' work covers all three formats",
    brief: 'When the three export units are done, confirm that together they cover CSV, JSON and XML and sign the work off as complete.',
    criteria: ['The export work is signed off as complete'],
  }, EXPORT_UNITS, { role: 'verify' }),
  fixture('approval of a sibling limiter', LIMITER_GOAL, LIMITER_CRITERIA, {
    title: 'Approve the limiter', goal: "Confirm the limiter unit's work is correct before it ships",
    brief: 'Once the limiter unit finishes, confirm that its limiter is correct and complete, and approve it for release.',
    criteria: ['The limiter is confirmed correct and approved'],
  }, [LIMITER_UNIT], { role: 'verify' }),
  // The proof-run plans as the planner wrote them: every unit does all its requirements asked, with siblings making up shared ones.
  proofFixture('proof durations u1: parseDuration', durations, 'u1', { c1: 'no', c2: 'no', c3: 'no', c14: 'no' }),
  proofFixture('proof durations u2: parse tests', durations, 'u2', { c8: 'no', c9: 'no' }),
  proofFixture('proof durations u3: formatDuration', durations, 'u3', { c4: 'no', c5: 'no', c6: 'no', c7: 'no', c14: 'no' }),
  proofFixture('proof durations u4: format tests', durations, 'u4', { c8: 'no', c10: 'no' }),
  proofFixture('proof durations u5: CLI and README', durations, 'u5', { c11: 'no', c12: 'no', c13: 'no', c15: 'no', c16: 'no' }),
  proofFixture('proof first durations u1: parseDuration', durationsFirst, 'u1', { c1: 'no', c2: 'no', c7: 'no' }),
  proofFixture('proof first durations u2: parse tests', durationsFirst, 'u2', { c4: 'no' }),
  proofFixture('proof first durations u3: formatDuration', durationsFirst, 'u3', { c3: 'no', c7: 'no' }),
  proofFixture('proof first durations u4: format tests', durationsFirst, 'u4', { c4: 'no' }),
  // c5 is left unasked: "normalize works correctly" states less than c5's exact output, but not clearly so.
  proofFixture('proof first durations u5: CLI and README', durationsFirst, 'u5', { c6: 'no', c8: 'no' }),
  proofFixture('proof version u1: the whole task', version, 'u1', { c1: 'no', c2: 'no', c3: 'no', c4: 'no', c5: 'no', c6: 'no' }),
  // The same units altered to really narrow.
  proofFixture('proof durations u2 halves the test count', durations, 'u2', { c8: 'no', c9: 'yes' }, withUnit('u2', (unit) => ({
    ...unit, goal: 'Verify parseDuration with at least 6 test cases', brief: unit.brief.replace('at least 12 test cases', 'at least 6 test cases'),
    criteria: replaceCriterion(unit, 1, 'test/parse.test.ts contains at least 6 test cases for parseDuration'),
  }))),
  proofFixture('proof durations u3 drops zero handling', durations, 'u3', { c4: 'no', c5: 'no', c6: 'yes', c7: 'yes' }, withUnit('u3', (unit) => ({
    ...unit, brief: "Create src/format.ts and export formatDuration(seconds). It must render 5405 as '1h 30m 5s'. The function must include a JSDoc comment with at least one @example line.",
    criteria: replaceCriterion(unit, 2, 'formatDuration renders hours, minutes and seconds'),
  }))),
  proofFixture('proof durations u5 weakens the error path', durations, 'u5', { c11: 'no', c12: 'yes', c13: 'yes', c15: 'no', c16: 'no' }, withUnit('u5', (unit) => ({
    ...unit, brief: unit.brief.replace('it must print the RangeError message to stderr and exit with code 2', 'it must print an error and exit with a non-zero code'),
    criteria: replaceCriterion(unit, 1, 'CLI prints an error and exits non-zero on malformed input'),
  }))),
  proofFixture('proof durations u2 with the format test unit gone', durations, 'u2', { c8: 'yes', c9: 'no' }, (units) => units.filter((unit) => unit.id !== 'u4')),
  proofFixture('proof version u1 hard-codes the label', version, 'u1', { c4: 'no', c5: 'yes', c6: 'no' }, withUnit('u1', (unit) => ({
    ...unit, goal: 'Create src/version.ts and test/version.test.ts to export and verify versionLabel().',
    brief: "Create src/version.ts exporting versionLabel() which returns the literal string 'durations 0.1.0'. Create test/version.test.ts using bun:test to import and assert that versionLabel() returns 'durations 0.1.0'. Run the tests to ensure success. All actions must be taken directly by the agent without delegating to any other agent or sub-agent tool.",
    criteria: replaceCriterion(unit, 2, "versionLabel() returns 'durations 0.1.0'."),
  }))),
  proofFixture('proof first durations u1 handles hours and minutes only', durationsFirst, 'u1', { c1: 'yes', c2: 'no' }, withUnit('u1', (unit) => ({
    ...unit, brief: "Implement parseDuration in src/parse.ts to convert hour and minute strings like '1h30m' or '2h' to seconds, throwing RangeError on failure.",
    criteria: replaceCriterion(unit, 0, 'parseDuration(text) converts hour and minute strings such as 1h30m and 2h to seconds'),
  }))),
];

/** Every requirement a fixture asks about is labelled, and every label names one. */
function assertFixture(entry: UnitShapeFixture): void {
  const ids = entry.input.requirements.map((requirement) => requirement.id);
  const labelled = Object.keys(entry.expect.narrows ?? {});
  const matches = ids.length === labelled.length && ids.every((id) => labelled.includes(id));
  if (!matches) throw new RangeError(`contract.unit-shape: fixture ${entry.name} must label exactly the requirements it asks about`);
}

const HEADER = {
  name: 'contract.unit-shape',
  version: 2,
  description: 'What kind of work a planned unit is (implement, research, design, or a review, test or verify unit), and, for each contract criterion it serves, whether it does less than the criterion sets with no other unit doing the rest.',
  accuracyFloor: 0.9,
} as const;

assertBand(ROLE_BAND);
assertBand(NARROWS_BAND);
for (const entry of FIXTURES) assertFixture(entry);

export const unitShape: UnitShape = {
  ...decisionHeader({ ...HEADER, fixtures: FIXTURES }),
  async read(port, input, options = {}) {
    const { unit } = input;
    const state = {
      goal: input.goal,
      unit: { title: unit.title, goal: unit.goal, brief: unit.brief, criteria: [...unit.criteria] },
      otherUnits: input.otherUnits.map((other) => ({ title: other.title, goal: other.goal, criteria: [...other.criteria] })),
    };
    const result = await askAs(port, HEADER, 'battery', state, questionsFor(input), options);
    const answers = result.answers as Readonly<Record<string, unknown>>;
    const role = readChoice(answers['role'] as ChoiceResponse<typeof UNIT_SHAPE_ROLES>, ROLE_BAND);
    const narrows = input.requirements.map((requirement): RequirementReading => ({ ...requirement, reading: readYesNo(answers[narrowsKey(requirement.id)] as NoulResponse, NARROWS_BAND) }));
    recordReadings(port, result, { role, narrows });
    return { role, narrows, decisionId: result.decisionId, usage: result.usage, recordAction: (action) => recordAction(port, result.decisionId, action) };
  },
  checkFixtures: (port, options = {}) =>
    checkEachFixture(FIXTURES, options, async (entry, run) => {
      const { role, narrows } = await unitShape.read(port, entry.input, run);
      const checks: FixtureCheck[] = entry.expect.role === undefined ? [] : [checkReading(entry.name, 'role', entry.expect.role, role)];
      for (const { id, reading } of narrows) checks.push(checkReading(entry.name, `narrows ${id}`, entry.expect.narrows![id]!, reading, 'narrows'));
      return checks;
    }),
};
