/**
 * `contract.unit-shape` (docs/design/contract-runner.md section 3.4): what
 * kind of work a planned unit is, and whether it narrows the scope it serves.
 * Two questions, asked in one request per unit, about
 * `{ goal, criteria, unit: { title, goal, brief, criteria }, otherUnits }`:
 * `goal` is the contract goal, `criteria` the contract criteria this unit
 * serves, and `otherUnits` the rest of the plan, so a unit that deliberately
 * takes half the scope while a sibling takes the other half is not read as
 * narrowing.
 *
 * Jev verifies inside every unit, so a unit whose job is to review, test or
 * verify other units is refused and the planner folds the check into the
 * criteria of the unit it would verify.
 *
 * Bands: the role is read at medium stakes. A narrowed unit loses work the
 * user asked for, so "does not narrow" is read at high stakes.
 */
import { defineBattery, oneOf, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** The roles Jev can read; `review`, `test` and `verify` are never allowed as units. */
export const UNIT_SHAPE_ROLES = {
  implement: 'Changes files or produces the deliverable itself',
  research: 'Reads code, documents or data and reports what it found, changing nothing',
  design: 'Produces a plan or design as its answer, changing nothing',
  review: "Examines other units' finished work and reports findings or opinions about it",
  test: "Only runs tests or checks against other units' work and reports the results, writing nothing",
  verify: "Only confirms or signs off that other units' work is correct or complete",
} as const;
export type UnitShapeRole = keyof typeof UNIT_SHAPE_ROLES;

/** Roles that exist only to check other units' work. */
export const VERIFICATION_ROLES: readonly UnitShapeRole[] = ['review', 'test', 'verify'];

const RENAME_GOAL = 'Rename getUser to fetchUser across the whole codebase';
const RENAME_CRITERIA = ['Every definition of and call to getUser in the codebase is renamed to fetchUser'];
const EXPORT_GOAL = 'Report export in CSV, JSON and XML formats';

export const unitShape = defineBattery({
  name: 'contract.unit-shape',
  version: 1,
  description: 'What kind of work a planned unit is (implement, research, design, or a review, test or verify unit), and whether it leaves out or narrows what the criteria it serves require.',
  accuracyFloor: 0.9,
  items: {
    role: oneOf('What kind of work does `unit` do?', UNIT_SHAPE_ROLES, STAKES_BANDS.medium.confidence),
    narrows: yesNo(
      'Compared with what `criteria` require, does `unit` promise less (fewer items, a smaller area, or a weaker standard) without any entry of `otherUnits` making up the difference?',
      { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence },
      {
        true: '`unit` promises less than `criteria` require and no entry of `otherUnits` covers the rest',
        false: '`unit`, together with `otherUnits`, promises all that `criteria` require, at the standard they set',
      },
    ),
  },
  fixtures: [
    {
      name: 'full rename',
      state: {
        goal: RENAME_GOAL,
        criteria: RENAME_CRITERIA,
        unit: {
          title: 'Rename getUser',
          goal: 'Rename getUser to fetchUser everywhere',
          brief: 'Find every definition, import and call of getUser anywhere in the repository and rename it to fetchUser, including tests and docs.',
          criteria: ['No reference to getUser remains anywhere in the repository'],
        },
        otherUnits: [],
      },
      expect: { role: 'implement', narrows: 'no' },
    },
    {
      name: 'rename limited to one folder',
      state: {
        goal: RENAME_GOAL,
        criteria: RENAME_CRITERIA,
        unit: {
          title: 'Rename getUser in the API layer',
          goal: 'Rename getUser to fetchUser in src/api',
          brief: 'Rename getUser to fetchUser in the files under src/api only. Leave the other folders as they are.',
          criteria: ['No reference to getUser remains in src/api'],
        },
        otherUnits: [],
      },
      expect: { role: 'implement', narrows: 'yes' },
    },
    {
      name: 'half the scope with a sibling for the rest',
      state: {
        goal: EXPORT_GOAL,
        criteria: ['Reports can be exported as CSV, JSON and XML'],
        unit: {
          title: 'CSV and JSON export',
          goal: 'Add CSV and JSON report export',
          brief: 'Add CSV and JSON writers in src/export and wire them into the export menu. XML is handled by the XML export unit.',
          criteria: ['Reports export as CSV', 'Reports export as JSON'],
        },
        otherUnits: [{ title: 'XML export', goal: 'Add XML report export' }],
      },
      expect: { role: 'implement', narrows: 'no' },
    },
    {
      name: 'format dropped with no sibling',
      state: {
        goal: EXPORT_GOAL,
        criteria: ['Reports can be exported as CSV, JSON and XML'],
        unit: {
          title: 'Report export',
          goal: 'Add CSV and JSON report export',
          brief: 'Add CSV and JSON writers in src/export and wire them into the export menu. XML can come later.',
          criteria: ['Reports export as CSV', 'Reports export as JSON'],
        },
        otherUnits: [],
      },
      expect: { role: 'implement', narrows: 'yes' },
    },
    {
      name: 'weaker performance target',
      state: {
        goal: 'The search endpoint answers typical queries in under 200 ms',
        criteria: ['Typical queries to the search endpoint get a response in under 200 ms'],
        unit: {
          title: 'Search speed-up',
          goal: 'Make search somewhat faster',
          brief: 'Look for easy wins in the search handler, such as caching, and apply the ones that help. Any improvement is fine.',
          criteria: ['Search is faster than before'],
        },
        otherUnits: [],
      },
      expect: { role: 'implement', narrows: 'yes' },
    },
    {
      name: 'investigation that reports',
      state: {
        goal: 'Find out why the nightly export job fails',
        criteria: ['The cause of the nightly export failure is identified with evidence from the logs'],
        unit: {
          title: 'Diagnose the export failure',
          goal: 'Identify the cause of the nightly export failure',
          brief: 'Read the job logs and the export code, find what makes the job fail, and report the cause with the log lines that show it. Do not change anything.',
          criteria: ['The report names the cause of the nightly export failure', 'The report quotes the log lines that show the cause'],
        },
        otherUnits: [],
      },
      expect: { role: 'research', narrows: 'no' },
    },
    {
      name: 'migration plan',
      state: {
        goal: 'A plan for moving the database from Postgres 13 to 16',
        criteria: ['The plan lists every step of the upgrade in order', 'The plan says how to roll back each step'],
        unit: {
          title: 'Write the upgrade plan',
          goal: 'Write a step-by-step Postgres 13 to 16 upgrade plan',
          brief: 'Study the current database setup and write an ordered upgrade plan with a rollback for every step. Return the plan as your answer; change no files.',
          criteria: ['The plan lists every upgrade step in the order the steps must run', 'The plan gives a rollback for every step'],
        },
        otherUnits: [],
      },
      expect: { role: 'design', narrows: 'no' },
    },
    {
      name: 'code review of a sibling',
      state: {
        goal: 'A token bucket rate limiter for the API gateway',
        criteria: ['Requests over the configured rate get a 429 response'],
        unit: {
          title: 'Review the limiter',
          goal: 'Review the rate limiter written by the implementation unit',
          brief: 'Read the diff the implementation unit produced for the rate limiter and write review comments on its design, naming and edge cases.',
          criteria: ['The review comments on every changed file'],
        },
        otherUnits: [{ title: 'Implement the limiter', goal: 'Write the token bucket rate limiter' }],
      },
      expect: { role: 'review' },
    },
    {
      name: 'test run of siblings',
      state: {
        goal: 'CSV and JSON report export',
        criteria: ['Reports export as CSV and JSON'],
        unit: {
          title: 'Run the test suite',
          goal: "Run the tests against the other units' changes",
          brief: 'After the export units finish, run bun test and the end-to-end suite against their changes and report which tests pass and which fail. Do not write or change any code or tests.',
          criteria: ['The report lists the result of every test run'],
        },
        otherUnits: [{ title: 'CSV export', goal: 'Add CSV export' }, { title: 'JSON export', goal: 'Add JSON export' }],
      },
      expect: { role: 'test' },
    },
    {
      name: 'sign-off of siblings',
      state: {
        goal: 'Rename getUser to fetchUser across the whole codebase',
        criteria: RENAME_CRITERIA,
        unit: {
          title: 'Confirm the rename',
          goal: "Confirm the other units' rename is complete and correct",
          brief: 'Once the rename units finish, confirm that their work is complete and correct and sign it off.',
          criteria: ['The rename is confirmed complete'],
        },
        otherUnits: [{ title: 'Rename in src', goal: 'Rename getUser in src' }, { title: 'Rename in test', goal: 'Rename getUser in test' }],
      },
      expect: { role: 'verify' },
    },
  ],
});
