/**
 * `contract.criterion-trace` (docs/design/contract-runner.md section 3.4): does
 * each contract criterion trace to the user's words? The fidelity pattern, one
 * check per criterion: claim = "The user requires: <text>", source = the ask,
 * quote = the words the planner cited.
 *
 * The quote is looked up in the ask by code first (plan-schema.ts check 4), so
 * a fabricated quote gets a precise repair message without a call; the pattern
 * repeats that lookup itself and reports `fabricated`.
 *
 * Band: a criterion wrongly read as supported binds every unit to something
 * the user never asked for, so the supports side is read at high stakes and
 * the rest at medium.
 */
import { defineFidelityChecker, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** The claim a criterion makes about the ask. */
export function traceClaim(criterionText: string): string {
  return `The user requires: ${criterionText}`;
}

const DEPLOY_ASK = 'Add a --dry-run flag to the deploy script that prints the commands it would run without running them.';
const API_ASK = 'Keep the existing /v1 API unchanged and add a new /v2 endpoint that returns paginated results.';
const DEPS_ASK = 'Write a script that renames photos by the date they were taken. Use only the standard library; no new dependencies.';

export const criterionTrace = defineFidelityChecker({
  name: 'contract.criterion-trace',
  version: 1,
  description: "Whether a contract criterion is something the user's request actually asks for, read against the words the planner quoted.",
  accuracyFloor: 0.9,
  band: { ...STAKES_BANDS.medium.confidence, perOption: { supports: STAKES_BANDS.high.confidence } },
  fixtures: [
    {
      name: 'flag stated outright',
      claim: traceClaim('The deploy script accepts a --dry-run flag'),
      source: DEPLOY_ASK,
      quote: 'Add a --dry-run flag to the deploy script',
      expect: 'supported',
    },
    {
      name: 'behaviour stated in other words',
      claim: traceClaim('With --dry-run, the deploy script prints each command instead of executing it'),
      source: DEPLOY_ASK,
      quote: 'prints the commands it would run without running them',
      expect: 'supported',
    },
    {
      name: 'standard library limit',
      claim: traceClaim('The rename script imports nothing outside the standard library'),
      source: DEPS_ASK,
      quote: 'Use only the standard library',
      expect: 'supported',
    },
    {
      name: 'replaces what the user said to keep',
      claim: traceClaim('The /v1 API is removed and replaced by the /v2 endpoint'),
      source: API_ASK,
      quote: 'add a new /v2 endpoint',
      expect: 'contradicted',
    },
    {
      name: 'adds a dependency the user ruled out',
      claim: traceClaim('The rename script uses the third-party Pillow package to read photo dates'),
      source: DEPS_ASK,
      quote: 'no new dependencies',
      expect: 'contradicted',
    },
    {
      name: 'requirement the ask never mentions',
      claim: traceClaim('The deploy script writes a log file of every run'),
      source: DEPLOY_ASK,
      quote: 'the deploy script',
      expect: 'unsupported',
    },
    {
      name: 'extra standard the ask does not set',
      claim: traceClaim('The /v2 endpoint responds in under 50 milliseconds'),
      source: API_ASK,
      quote: 'add a new /v2 endpoint',
      expect: 'unsupported',
    },
    {
      name: 'quote not in the ask',
      claim: traceClaim('The deploy script asks for confirmation before each command'),
      source: DEPLOY_ASK,
      quote: 'confirm before running each command',
      expect: 'fabricated',
    },
    {
      name: 'quote reworded from the ask',
      claim: traceClaim('The /v2 endpoint returns 50 results per page'),
      source: API_ASK,
      quote: 'return results in pages of 50',
      expect: 'fabricated',
    },
  ],
});
