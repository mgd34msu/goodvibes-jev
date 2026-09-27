/**
 * `contract.criterion-shape` (docs/design/contract-runner.md section 3.4): can
 * a contract criterion be judged from the finished work, and is it only about
 * how agents are arranged? Two yes/no questions about `{ request, criterion }`,
 * asked in one request per criterion.
 *
 * A criterion no check can confirm would hold every unit that serves it open
 * forever, and a topology-only criterion ("one agent per package") is met or
 * missed by the plan's shape, not by the work, so code gives it a disposition
 * instead of judging it (plan-checks.ts). Both questions are medium stakes: a
 * wrong reading costs one planner repair.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const MEDIUM = STAKES_BANDS.medium.yesNo;

const FANOUT_ASK = 'Spin up one agent per package to update the lint config in each of the five packages, all running in parallel.';

export const criterionShape = defineBattery({
  name: 'contract.criterion-shape',
  version: 1,
  description: 'Whether a contract criterion can be confirmed or refuted from the finished work, and whether it can only be met by an arrangement of agents rather than by the work.',
  accuracyFloor: 0.9,
  items: {
    checkable: yesNo(
      'Can `criterion` be confirmed or refuted from the finished work: its files, its output, or commands run against it?',
      MEDIUM,
    ),
    topology_only: yesNo(
      'Can `criterion` only be satisfied by a particular arrangement of agents (how many run, whether in parallel, one per item) rather than by the work itself?',
      MEDIUM,
    ),
  },
  fixtures: [
    {
      name: 'flag behaviour',
      state: {
        request: 'Add a --verbose flag to the CLI that prints debug lines.',
        criterion: 'Running the CLI with --verbose prints debug lines',
      },
      expect: { checkable: 'yes', topology_only: 'no' },
    },
    {
      name: 'tests pass',
      state: {
        request: 'Fix the flaky retry logic in the HTTP client and make sure nothing else breaks.',
        criterion: 'The existing test suite passes',
      },
      expect: { checkable: 'yes', topology_only: 'no' },
    },
    {
      name: 'every package updated',
      state: { request: FANOUT_ASK, criterion: 'Each of the five packages has the updated lint config' },
      expect: { checkable: 'yes', topology_only: 'no' },
    },
    {
      name: 'one agent per package',
      state: { request: FANOUT_ASK, criterion: 'Each package is handled by its own agent, with the agents running in parallel' },
      expect: { checkable: 'no', topology_only: 'yes' },
    },
    {
      name: 'exact agent count',
      state: {
        request: 'Use three agents at the same time to translate the docs into French, German and Spanish.',
        criterion: 'Exactly three agents work on the translation at the same time',
      },
      expect: { topology_only: 'yes' },
    },
    {
      name: 'user satisfaction',
      state: {
        request: 'Redesign the settings page so it is easier to use.',
        criterion: 'The user is happy with the new settings page',
      },
      expect: { checkable: 'no', topology_only: 'no' },
    },
    {
      name: 'future adoption',
      state: {
        request: 'Write a style guide for our Go services that the team can adopt.',
        criterion: 'The whole team follows the style guide from next quarter onward',
      },
      expect: { checkable: 'no', topology_only: 'no' },
    },
  ],
});
