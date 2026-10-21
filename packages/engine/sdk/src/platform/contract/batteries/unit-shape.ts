import { nativeContractSourceData } from '../native-source.js';
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
 * Review, test and verification readings describe read-only work. The plan
 * checker maps them to research units so requested reviews can execute.
 *
 * Bands: the role is read at medium stakes. `narrows` is read at medium
 * stakes on both sides: every contract criterion is judged again at the
 * deliverable check at high stakes (section 6.4), so a unit that narrows the
 * scope it serves cannot pass the contract, and a narrowing read wrongly as
 * none costs a fix round, not a wrong acceptance.
 *
 * Consumers use scope probabilities to identify missing work. Uncertainty
 * about the role alone does not stop an otherwise valid unit.
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

/** The roles Jev can read; read-only variants share the research execution role. */
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
const NARROWS_QUESTION = 'Does `unit` do less than `requirement` sets (fewer substantive items, a smaller area or a weaker standard) with neither this unit, `otherUnits`, nor the supplied actual `hostOperations` covering the rest? Match native plan-validation and acceptance requirements to hostOperations, not to worker-authored self-approval. The listed host operations describe the executing runtime, not a worker promise or a claim that an approval already passed. All substantive requested work still needs coverage by units; host checking cannot substitute for missing source review, implementation or deliverables.';
const NARROWS_CRITERIA = {
  true: 'Some substantive requested work is covered by neither this unit nor another unit; automatic host checking cannot replace that missing work',
  false: 'The units cover the substantive requested work, while the actual host handles native planning and acceptance checks without worker self-approval',
} as const;

/** The question name a requirement is asked under. */
const narrowsKey = (id: string): string => `narrows_${id}`;
const hostKey = (id: string): string => `host_${id}`;

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
  /** Complete native source retained while examining derived work. */
  readonly nativeSource?: import('../types.js').NativeContractSource | undefined;
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
  /** Whether the complete requirement is covered by actual runtime checking, rather than worker work. */
  readonly hostCovered?: YesNoReading;
}

export interface UnitShapeRun {
  readonly role: ChoiceReading<UnitShapeRole>;
  readonly acceptanceProblem: YesNoReading;
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
  readonly expect: { readonly role?: UnitShapeRole; readonly narrows?: Readonly<Record<string, 'yes' | 'no'>>; readonly acceptanceProblem?: 'yes' | 'no' };
}

export interface UnitShape extends NamedDecision {
  read(port: JudgmentPort, input: UnitShapeInput, options?: CallOptions): Promise<UnitShapeRun>;
}

function questionsFor(input: UnitShapeInput): Record<string, Question> {
  return {
    role: ROLE_QUESTION,
    acceptance_problem: noul({
      question: 'Examine each entry of unit.criteria separately: separate entries are already independently judged. Does any SINGLE entry make this worker’s acceptance circular, assign host-only approval to the worker, or combine independent obligations so that its rejection cannot identify a specific repair?',
      interpretation: [
        'A prerequisite that this very acceptance check already passed is circular. The host performs this check after the work is returned.',
        'Requirements about the BEHAVIOR OF SOFTWARE being implemented are substantive work: implementing or testing a program that publishes only after approval is NOT circular and should read no.',
        'Ordinary test commands and auditing existing approval records are substantive work, not host-only approval operations.',
        'Keep naturally connected facts about one behavior together. Separate entries for read scope, semantic assessment and preservation are independently repairable and should read no.',
        'Preserve every original requirement and mandatory host check; repair only defective derived criteria, never waive approval or narrow the work.',
      ],
    }, { true: 'A single derived entry has a circular prerequisite, requires this worker to execute host-only approval, or bundles independently repairable obligations.', false: 'Each derived entry describes independently checkable substantive work; required software approval behavior is valid, and actual host acceptance is performed by the runtime.' }),
    ...Object.fromEntries(input.requirements.flatMap(requirement => [
      [hostKey(requirement.id), noul({ question: 'Is this ENTIRE requirement solely about the native plan-validation or acceptance operations that hostOperations actually enforces? Answer yes only when those host operations fully cover the requirement. Source review, implementation, tests requested as deliverables, and artifact creation remain worker work. A requirement to implement or change a checker is worker work. For mixed requirements that also demand substantive work, answer no. This classifies responsibility; it never asserts that work or approval has passed.', requirement: requirement.text })],
      [narrowsKey(requirement.id), noul({ question: NARROWS_QUESTION, requirement: requirement.text }, NARROWS_CRITERIA)],
    ])),
  };
}

type Label = 'yes' | 'no';
type Sibling = readonly [title: string, goal: string, criteria: readonly string[]];

/** A written fixture: requirements get numbered IDs and `narrows` labels them in order; without it only the role is asked. */
function fixture(
  name: string,
  goal: string,
  requirements: readonly string[],
  unit: UnitShapeUnit,
  otherUnits: readonly Sibling[],
  expect: { readonly role?: UnitShapeRole; readonly narrows?: readonly Label[]; readonly acceptanceProblem?: Label },
): UnitShapeFixture {
  const ids = requirements.map((_, index) => `requirement-${index + 1}`);
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
      ...(expect.acceptanceProblem === undefined ? {} : { acceptanceProblem: expect.acceptanceProblem }),
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
const { durations, combinedDurationRequirements, version } = PROOF_PLANS;

const FIXTURES: readonly UnitShapeFixture[] = [
  fixture('current host approval is circular', 'Review assigned source', [], {
    title: 'Source review', goal: 'Review assigned source', brief: 'Read and assess the assigned source.',
    criteria: ['All assigned source is reviewed and this native unit acceptance check has already passed'],
  }, [], { acceptanceProblem: 'yes' }),
  fixture('the host performs native validation', 'Review assigned source with native Jev acceptance', ['Have native Jev validate the plan and each unit result'], {
    title: 'Source review', goal: 'Review assigned source', brief: 'Read and assess the assigned source; return the result for automatic host checking.',
    criteria: ['Actual returned receipts cover all assigned ranges', 'The review gives source-supported findings or concrete no-defect assessments'],
  }, [], { role: 'research', narrows: ['no'], acceptanceProblem: 'no' }),
  fixture('separate review obligations identify the missing work', 'Review assigned source', [], {
    title: 'Source review', goal: 'Review assigned source', brief: 'Read and assess the assigned source; the host checks the result automatically.',
    criteria: ['Returned read receipts cover every assigned range without truncation', 'The assessment explains connected behavior and relevant existing tests, with evidenced findings or concrete no-defect conclusions', 'Prior findings are preserved and no production files are changed'],
  }, [], { acceptanceProblem: 'no' }),
  fixture('testing the checker implementation is substantive work', 'Fix approval enforcement', [], {
    title: 'Enforce approval', goal: 'Reject output before native approval', brief: 'Implement the output gate and test its rejection and acceptance behavior.',
    criteria: ['A rejected draft never reaches successful completion', 'After the evaluator approves a completed result, the result reaches the user'],
  }, [], { acceptanceProblem: 'no' }),
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
  // Units satisfy the labelled requirements, including work shared with sibling units.
  proofFixture('captured planner example: parseDuration', durations, 'duration-parser', { 'parser-export': 'no', 'duration-parsing': 'no', 'malformed-input-error': 'no', 'function-examples': 'no' }),
  proofFixture('captured planner example: parse tests', durations, 'parser-tests', { 'separate-test-files': 'no', 'parser-test-cases': 'no' }),
  proofFixture('captured planner example: formatDuration', durations, 'duration-formatter', { 'formatter-export': 'no', 'formatted-duration': 'no', 'omit-zero-components': 'no', 'format-zero': 'no', 'function-examples': 'no' }),
  proofFixture('captured planner example: format tests', durations, 'formatter-tests', { 'separate-test-files': 'no', 'formatter-test-cases': 'no' }),
  proofFixture('captured planner example: CLI and README', durations, 'cli-and-readme', { 'normalize-command': 'no', 'cli-error-output': 'no', 'cli-error-exit': 'no', 'readme-usage': 'no', 'readme-command-example': 'no' }),
  proofFixture('combined requirement example: parseDuration', combinedDurationRequirements, 'duration-parser', { 'duration-parser': 'no', 'malformed-input-error': 'no', 'function-examples': 'no' }),
  proofFixture('combined requirement example: parse tests', combinedDurationRequirements, 'parser-tests', { 'module-test-cases': 'no' }),
  proofFixture('combined requirement example: formatDuration', combinedDurationRequirements, 'duration-formatter', { 'duration-formatter': 'no', 'function-examples': 'no' }),
  proofFixture('combined requirement example: format tests', combinedDurationRequirements, 'formatter-tests', { 'module-test-cases': 'no' }),
  // The generic CLI success statement has no settled label for the exact-output requirement.
  proofFixture('combined requirement example: CLI and README', combinedDurationRequirements, 'cli-and-readme', { 'cli-error-handling': 'no', 'readme-usage-example': 'no' }),
  proofFixture('captured version-label task', version, 'version-label', { 'no-delegation': 'no', 'version-module': 'no', 'version-label-export': 'no', 'version-label-output': 'no', 'version-constant': 'no', 'version-label-test': 'no' }),
  // The same units altered to really narrow.
  proofFixture('parser example halves the test count', durations, 'parser-tests', { 'separate-test-files': 'no', 'parser-test-cases': 'yes' }, withUnit('parser-tests', (unit) => ({
    ...unit, goal: 'Verify parseDuration with at least 6 test cases', brief: unit.brief.replace('at least 12 test cases', 'at least 6 test cases'),
    criteria: replaceCriterion(unit, 1, 'test/parse.test.ts contains at least 6 test cases for parseDuration'),
  }))),
  proofFixture('formatter example drops zero handling', durations, 'duration-formatter', { 'formatter-export': 'no', 'formatted-duration': 'no', 'omit-zero-components': 'yes', 'format-zero': 'yes' }, withUnit('duration-formatter', (unit) => ({
    ...unit, brief: "Create src/format.ts and export formatDuration(seconds). It must render 5405 as '1h 30m 5s'. The function must include a JSDoc comment with at least one @example line.",
    criteria: replaceCriterion(unit, 2, 'formatDuration renders hours, minutes and seconds'),
  }))),
  proofFixture('CLI example weakens the error path', durations, 'cli-and-readme', { 'normalize-command': 'no', 'cli-error-output': 'yes', 'cli-error-exit': 'yes', 'readme-usage': 'no', 'readme-command-example': 'no' }, withUnit('cli-and-readme', (unit) => ({
    ...unit, brief: unit.brief.replace('it must print the RangeError message to stderr and exit with code 2', 'it must print an error and exit with a non-zero code'),
    criteria: replaceCriterion(unit, 1, 'CLI prints an error and exits non-zero on malformed input'),
  }))),
  proofFixture('parser example without sibling formatter tests', durations, 'parser-tests', { 'separate-test-files': 'yes', 'parser-test-cases': 'no' }, (units) => units.filter((unit) => unit.id !== 'formatter-tests')),
  proofFixture('version example hard-codes the label', version, 'version-label', { 'version-label-output': 'no', 'version-constant': 'yes', 'version-label-test': 'no' }, withUnit('version-label', (unit) => ({
    ...unit, goal: 'Create src/version.ts and test/version.test.ts to export and verify versionLabel().',
    brief: "Create src/version.ts exporting versionLabel() which returns the literal string 'durations 0.1.0'. Create test/version.test.ts using bun:test to import and assert that versionLabel() returns 'durations 0.1.0'. Run the tests to ensure success. All actions must be taken directly by the agent without delegating to any other agent or sub-agent tool.",
    criteria: replaceCriterion(unit, 2, "versionLabel() returns 'durations 0.1.0'."),
  }))),
  proofFixture('combined parser example handles hours and minutes only', combinedDurationRequirements, 'duration-parser', { 'duration-parser': 'yes', 'malformed-input-error': 'no' }, withUnit('duration-parser', (unit) => ({
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
  version: 5,
  description: 'A unit’s work role, independently checkable derived acceptance criteria, and coverage of the original requirements it serves.',
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
      hostOperations: {
        meaning: 'Actual contract runtime responsibilities; these operations do not execute as extra worker units. No past or current approval is asserted here.',
        beforeWork: 'The host runs Jev plan checks before accepting the plan for execution.',
        unitCompletion: 'The host holds each worker result and invokes Jev acceptance and quality checks before the unit can pass.',
        integration: 'The host checks completed groups and the combined deliverable with Jev before the contract can pass.',
        source: 'contract/planner.ts, contract/agent-hooks.ts and contract/completion.ts enforce these operations.',
      },
      ...(input.nativeSource === undefined ? {} : { nativeSource: nativeContractSourceData(input.nativeSource) }),
      unit: { title: unit.title, goal: unit.goal, brief: unit.brief, criteria: [...unit.criteria] },
      otherUnits: input.otherUnits.map((other) => ({ title: other.title, goal: other.goal, criteria: [...other.criteria] })),
    };
    const result = await askAs(port, HEADER, 'battery', state, questionsFor(input), options);
    const answers = result.answers as Readonly<Record<string, unknown>>;
    const role = readChoice(answers['role'] as ChoiceResponse<typeof UNIT_SHAPE_ROLES>, ROLE_BAND);
    const acceptanceProblem = readYesNo(answers['acceptance_problem'] as NoulResponse, NARROWS_BAND);
    const narrows = input.requirements.map((requirement): RequirementReading => ({ ...requirement,
      hostCovered: readYesNo(answers[hostKey(requirement.id)] as NoulResponse, NARROWS_BAND),
      reading: readYesNo(answers[narrowsKey(requirement.id)] as NoulResponse, NARROWS_BAND) }));
    recordReadings(port, result, { role, acceptanceProblem, narrows });
    return { role, acceptanceProblem, narrows, decisionId: result.decisionId, usage: result.usage, recordAction: (action) => recordAction(port, result.decisionId, action) };
  },
  checkFixtures: (port, options = {}) =>
    checkEachFixture(FIXTURES, options, async (entry, run) => {
      const { role, narrows, acceptanceProblem } = await unitShape.read(port, entry.input, run);
      const checks: FixtureCheck[] = entry.expect.role === undefined ? [] : [checkReading(entry.name, 'role', entry.expect.role, role)];
      if (entry.expect.acceptanceProblem !== undefined) checks.push(checkReading(entry.name, 'acceptance_problem', entry.expect.acceptanceProblem, acceptanceProblem));
      for (const { id, reading, hostCovered } of narrows) {
        const expected = entry.expect.narrows![id]!;
        if (hostCovered?.verdict === 'yes' && hostCovered.outcome === 'act')
          checks.push(checkReading(entry.name, `host ${id}`, expected === 'no' ? 'yes' : 'no', hostCovered, 'host'));
        else checks.push(checkReading(entry.name, `narrows ${id}`, expected, reading, 'narrows'));
      }
      return checks;
    }),
};
