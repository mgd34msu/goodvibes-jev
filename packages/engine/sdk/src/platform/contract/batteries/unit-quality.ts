/**
 * `contract.unit-quality` (docs/design/contract-runner.md section 4.4): six
 * yes/no questions about the quality of one unit's change, asked in one
 * request beside the judge. State: `{ goal, brief, changedPaths, diff,
 * commands, output }`. Every question asks whether a problem is present, so
 * yes is the problem and the failing case.
 *
 * Band: one for every item. A missed problem lets poor work pass, so "no
 * problem" is read at high stakes; a false problem costs one nudge.
 */
import { defineBattery, STAKES_BANDS, yesNo, type YesNoBand } from '@goodvibes-jev/judgment';
import type { QualityItem } from '../types.js';

export const UNIT_QUALITY_BAND: YesNoBand = { yes: STAKES_BANDS.medium.yesNo.yes, no: STAKES_BANDS.high.yesNo.no };

/** The items a mid-run (turn-end) check may nudge on at act; the rest are recorded until the agent finishes. */
export const MID_RUN_QUALITY_ITEMS: ReadonlySet<QualityItem> = new Set(['tests_weakened', 'breaks_existing', 'out_of_scope']);

const GOAL = 'Add a --limit option to the `orders list` command';
const BRIEF = 'Edit src/commands/orders-list.ts so `orders list --limit N` prints at most N orders. Add a test in test/orders-list.test.ts.';

const CLEAN_DIFF = [
  '+++ b/src/commands/orders-list.ts',
  "+  .option('--limit <n>', 'print at most n orders', (value) => Number.parseInt(value, 10))",
  '-  for (const order of orders) print(order);',
  '+  const shown = options.limit === undefined ? orders : orders.slice(0, options.limit);',
  '+  for (const order of shown) print(order);',
  '+++ b/test/orders-list.test.ts',
  "+test('--limit caps the list', async () => {",
  "+  const lines = await run(['orders', 'list', '--limit', '2']);",
  '+  expect(lines).toHaveLength(2);',
  '+});',
].join('\n');

const PASSING_TESTS = [{ command: 'bun test test/orders-list.test.ts', success: true, head: ' 4 pass\n 0 fail' }];

export const unitQuality = defineBattery({
  name: 'contract.unit-quality',
  version: 1,
  description: "Whether a unit's change leaves placeholders, weakens tests, breaks or strays beyond what it was asked, hides failures, or claims results nothing shows.",
  accuracyFloor: 0.9,
  items: {
    placeholder: yesNo(
      'Does the change in `diff` leave placeholder, stub, mock or TODO code where `goal` and `brief` require working behaviour?',
      UNIT_QUALITY_BAND,
      {
        true: 'Some code the goal needs to work is a placeholder, stub, mock, hard-coded fake or TODO',
        false: 'The code the goal needs is real, working code',
      },
    ),
    tests_weakened: yesNo(
      'Does the change in `diff` delete, skip or loosen existing tests or checks rather than make the code pass them?',
      UNIT_QUALITY_BAND,
      {
        true: 'An existing test or check is removed, skipped, or made to accept more than it did',
        false: 'Existing tests and checks are kept as strict as they were; new tests may be added',
      },
    ),
    breaks_existing: yesNo(
      'Does the change in `diff` remove or break existing behaviour that `goal` and `brief` did not ask to change?',
      UNIT_QUALITY_BAND,
      {
        true: 'Something that worked before and was not meant to change is removed or no longer works',
        false: 'Behaviour outside what was asked keeps working as before',
      },
    ),
    out_of_scope: yesNo(
      'Does the change in `diff` edit files or behaviour unrelated to `goal`?',
      UNIT_QUALITY_BAND,
      {
        true: 'Some edited file or behaviour has nothing to do with the goal',
        false: 'Every edit serves the goal',
      },
    ),
    hidden_failure: yesNo(
      'Does the change in `diff` swallow errors or hide failures instead of reporting them?',
      UNIT_QUALITY_BAND,
      {
        true: 'An error is caught and ignored, or a failure is turned into an apparent success',
        false: 'Errors and failures are reported or passed on',
      },
    ),
    unsupported_claims: yesNo(
      'Does `output` claim results (tests run, commands passing, files created) that `commands`, `diff` or `changedPaths` do not show?',
      UNIT_QUALITY_BAND,
      {
        true: 'A result the output claims has nothing in commands, diff or changedPaths to show it',
        false: 'Every result the output claims is shown by commands, diff or changedPaths, or the output claims none',
      },
    ),
  },
  fixtures: [
    {
      name: 'a clean change with its test run',
      state: {
        goal: GOAL,
        brief: BRIEF,
        changedPaths: ['src/commands/orders-list.ts', 'test/orders-list.test.ts'],
        diff: CLEAN_DIFF,
        commands: PASSING_TESTS,
        output: 'Added --limit to orders list and a test for it. The tests pass.',
      },
      expect: { placeholder: 'no', tests_weakened: 'no', breaks_existing: 'no', out_of_scope: 'no', hidden_failure: 'no', unsupported_claims: 'no' },
    },
    {
      name: 'the option parses but the list is a TODO',
      state: {
        goal: GOAL,
        brief: BRIEF,
        changedPaths: ['src/commands/orders-list.ts'],
        diff: [
          '+++ b/src/commands/orders-list.ts',
          "+  .option('--limit <n>', 'print at most n orders')",
          '+  // TODO: apply options.limit to the list',
          '   for (const order of orders) print(order);',
        ].join('\n'),
        commands: [],
        output: 'Added the --limit option; applying it to the list is still to do.',
      },
      expect: { placeholder: 'yes', tests_weakened: 'no', hidden_failure: 'no', unsupported_claims: 'no' },
    },
    {
      name: 'a failing assertion is skipped instead of fixed',
      state: {
        goal: GOAL,
        brief: BRIEF,
        changedPaths: ['src/commands/orders-list.ts', 'test/orders-list.test.ts'],
        diff: [
          CLEAN_DIFF,
          '--- a/test/orders-list.test.ts',
          "-test('lists orders newest first', async () => {",
          "+test.skip('lists orders newest first', async () => {",
        ].join('\n'),
        commands: [{ command: 'bun test test/orders-list.test.ts', success: true, head: ' 3 pass\n 1 skip\n 0 fail' }],
        output: 'Added --limit. One ordering test was failing so I skipped it; everything else passes.',
      },
      expect: { tests_weakened: 'yes', placeholder: 'no', unsupported_claims: 'no' },
    },
    {
      name: 'an unrelated export is deleted',
      state: {
        goal: GOAL,
        brief: BRIEF,
        changedPaths: ['src/commands/orders-list.ts'],
        diff: [
          CLEAN_DIFF,
          '--- a/src/commands/orders-list.ts',
          '-export function formatOrderCsv(order: Order): string {',
          "-  return [order.id, order.date, order.total].join(',');",
          '-}',
          '# src/commands/orders-export.ts (unchanged) imports formatOrderCsv from ./orders-list',
        ].join('\n'),
        commands: PASSING_TESTS,
        output: 'Added --limit to orders list and removed formatOrderCsv, which I thought was unused.',
      },
      expect: { breaks_existing: 'yes', placeholder: 'no', hidden_failure: 'no' },
    },
    {
      name: 'the CI workflow and the README theme are rewritten too',
      state: {
        goal: GOAL,
        brief: BRIEF,
        changedPaths: ['src/commands/orders-list.ts', 'test/orders-list.test.ts', '.github/workflows/release.yml', 'docs/theme.css'],
        diff: [
          CLEAN_DIFF,
          '+++ b/.github/workflows/release.yml',
          '-    runs-on: ubuntu-22.04',
          '+    runs-on: ubuntu-24.04',
          '+++ b/docs/theme.css',
          '-  --accent: #3b82f6;',
          '+  --accent: #a855f7;',
        ].join('\n'),
        commands: PASSING_TESTS,
        output: 'Added --limit, moved the release job to a newer runner, and refreshed the docs accent colour.',
      },
      expect: { out_of_scope: 'yes', placeholder: 'no', tests_weakened: 'no' },
    },
    {
      name: 'a read failure becomes an empty list',
      state: {
        goal: GOAL,
        brief: BRIEF,
        changedPaths: ['src/commands/orders-list.ts', 'test/orders-list.test.ts'],
        diff: [
          CLEAN_DIFF,
          '+++ b/src/commands/orders-list.ts',
          '+  let orders: Order[] = [];',
          '+  try {',
          '+    orders = await store.readOrders();',
          '+  } catch {',
          '+    // ignore',
          '+  }',
        ].join('\n'),
        commands: PASSING_TESTS,
        output: 'Added --limit. If the store cannot be read the command now prints nothing instead of crashing.',
      },
      expect: { hidden_failure: 'yes', placeholder: 'no', unsupported_claims: 'no' },
    },
    {
      name: 'tests claimed but never run',
      state: {
        goal: GOAL,
        brief: BRIEF,
        changedPaths: ['src/commands/orders-list.ts', 'test/orders-list.test.ts'],
        diff: CLEAN_DIFF,
        commands: [],
        output: 'Added --limit and a test. I ran the full test suite and all 212 tests pass, and the typecheck is clean.',
      },
      expect: { unsupported_claims: 'yes', placeholder: 'no', breaks_existing: 'no' },
    },
    {
      name: 'a file claimed but not in the change',
      state: {
        goal: GOAL,
        brief: BRIEF,
        changedPaths: ['src/commands/orders-list.ts'],
        diff: [
          '+++ b/src/commands/orders-list.ts',
          "+  .option('--limit <n>', 'print at most n orders', (value) => Number.parseInt(value, 10))",
          '+  const shown = options.limit === undefined ? orders : orders.slice(0, options.limit);',
        ].join('\n'),
        commands: [],
        output: 'Added --limit and created test/orders-list-limit.test.ts covering it.',
      },
      expect: { unsupported_claims: 'yes', tests_weakened: 'no', hidden_failure: 'no' },
    },
  ],
});
