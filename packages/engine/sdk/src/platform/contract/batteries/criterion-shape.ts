/**
 * `contract.criterion-shape` (docs/design/contract-runner.md section 3.4): can
 * a contract criterion be judged from the finished work, is it only about how
 * agents are arranged, and is that arrangement one agent doing the work
 * alone? Three yes/no questions about `{ request, criterion }`, asked in one
 * request per criterion.
 *
 * A criterion no check can confirm would hold every unit that serves it open
 * forever, and a topology-only criterion ("one agent per package", or "do it
 * yourself without delegating") is met or missed by the plan's shape, not by
 * the work, so code gives it a disposition instead of judging it
 * (plan-checks.ts). An arrangement of agents includes using no other agent at
 * all: when the user forbids delegating, the contract runs in session mode
 * (section 6.6) and no sub-agent is ever spawned, which is exactly the
 * arrangement a `solo` criterion asks for, so it is met by structure. The
 * contract proof run showed why this matters: the planner wrote "The session
 * output confirms the agent performed the task directly without invoking
 * sub-agents or delegation tools" for such an ask, the old topology question
 * read it at 0.40 to 0.45, and it became a "cannot be checked" repair every
 * round. All three questions are medium stakes: a wrong reading costs one
 * planner repair, or leaves a criterion judged that structure already meets.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const MEDIUM = STAKES_BANDS.medium.yesNo;

const FANOUT_ASK = 'Spin up one agent per package to update the lint config in each of the five packages, all running in parallel.';
const SOLO_ASK = "Do this yourself in this session, without delegating to sub-agents or any other agent: add src/version.ts exporting a function versionLabel() that returns 'durations 0.1.0', built from VERSION in src/index.ts, and a test for it in test/version.test.ts.";

export const criterionShape = defineBattery({
  name: 'contract.criterion-shape',
  version: 2,
  description: 'Whether a contract criterion can be confirmed or refuted from the finished work, whether it can only be met by an arrangement of agents rather than by the work, and whether that arrangement is one agent working alone.',
  accuracyFloor: 0.9,
  items: {
    checkable: yesNo(
      'Can `criterion` be confirmed or refuted from the finished work: its files, its output, or commands run against it?',
      MEDIUM,
    ),
    topology_only: yesNo(
      'Can `criterion` only be satisfied by a particular arrangement of agents rather than by the work itself?',
      MEDIUM,
      {
        true: 'The criterion is about how agents are arranged: how many run, whether in parallel, one per item, or that the work is done without delegating to any other agent',
        false: 'The criterion is about the work: its files, its output or its behaviour, even if the work itself concerns agents or sessions',
      },
    ),
    solo: yesNo(
      'Is `criterion` a rule about who does the work, requiring the agent doing it to do all of it without handing any part to another agent?',
      MEDIUM,
      {
        true: 'The criterion is met by how the work is carried out: one agent does it all, with no delegation',
        false: 'The criterion is about what the work produces or does, even if the product itself concerns agents, sessions or delegation',
      },
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
      expect: { checkable: 'no', topology_only: 'yes', solo: 'no' },
    },
    {
      name: 'exact agent count',
      state: {
        request: 'Use three agents at the same time to translate the docs into French, German and Spanish.',
        criterion: 'Exactly three agents work on the translation at the same time',
      },
      expect: { topology_only: 'yes', solo: 'no' },
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
    // The delegation criteria the planner wrote in the contract proof run, one per plan version.
    {
      name: 'proof: session output confirms no delegation',
      state: { request: SOLO_ASK, criterion: 'The session output confirms the agent performed the task directly without invoking sub-agents or delegation tools.' },
      expect: { topology_only: 'yes', solo: 'yes' },
    },
    {
      name: 'proof: completed without delegating',
      state: { request: SOLO_ASK, criterion: 'The task is completed directly without delegating to any other agents.' },
      expect: { topology_only: 'yes', solo: 'yes' },
    },
    {
      name: 'proof: logs confirm no sub-agents',
      state: { request: SOLO_ASK, criterion: 'The session output logs confirm that no sub-agents or other agents were delegated to during the execution of the task.' },
      expect: { topology_only: 'yes', solo: 'yes' },
    },
    {
      name: 'a single agent does the migration',
      state: { request: 'Have a single agent move the billing service to the new config loader; do not split it up.', criterion: 'One agent does the whole billing migration, without handing parts to other agents' },
      expect: { topology_only: 'yes', solo: 'yes' },
    },
    {
      name: 'proof: the work itself in a do-it-yourself ask',
      state: { request: SOLO_ASK, criterion: "The function versionLabel() returns the string 'durations 0.1.0'." },
      expect: { checkable: 'yes', topology_only: 'no', solo: 'no' },
    },
    {
      name: 'an endpoint that lists agent sessions',
      state: { request: 'Add a /sessions endpoint that lists the active agent sessions.', criterion: 'GET /sessions returns every active agent session with its id and start time' },
      expect: { checkable: 'yes', topology_only: 'no', solo: 'no' },
    },
    {
      name: 'a flag that stops sub-agents',
      state: { request: 'Add a --no-delegate flag to the agent CLI so it never spawns sub-agents.', criterion: 'Running the agent CLI with --no-delegate spawns no sub-agent' },
      expect: { checkable: 'yes', topology_only: 'no', solo: 'no' },
    },
    {
      name: 'session transcript export',
      state: { request: 'Let users export a session transcript as Markdown.', criterion: 'Exporting a session writes its whole transcript as a Markdown file' },
      expect: { checkable: 'yes', topology_only: 'no', solo: 'no' },
    },
  ],
});
