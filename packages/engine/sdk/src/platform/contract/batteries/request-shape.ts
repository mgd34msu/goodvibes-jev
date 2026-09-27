/**
 * `contract.request-shape` (docs/design/contract-runner.md section 3.1): what
 * the person's request says about how the work may be done, read before any
 * planning. Four yes/no questions about `{ request }`, asked in one request.
 *
 * It replaces the delegation, parallel fan-out, no-write and design-only
 * phrase lists the WRFC routing and batch policy used to guess the same things.
 *
 * Bands: a wrong "the user forbids delegation" or "the user forbids writing"
 * costs a slower or read-only contract, while a wrong "no" does work the user
 * told us not to do, so the no side carries the higher stakes. Parallel agents
 * and attempts only shape the plan, so both sides are low stakes.
 */
import { defineBattery, STAKES_BANDS, yesNo, type JudgmentPort, type YesNoBand, type YesNoReading } from '@goodvibes-jev/judgment';
import type { RequestShape, ShapeReading } from '../types.js';

/** Yes read at medium stakes, no at high: a false "no" acts against the user's words. */
const PERMISSION_BAND: YesNoBand = { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence };

export const requestShape = defineBattery({
  name: 'contract.request-shape',
  version: 1,
  description: 'How the person asked for the work to be done: whether they forbid delegating it, ask for parallel agents, forbid changing files, or ask for several attempts to pick from.',
  accuracyFloor: 0.9,
  items: {
    forbids_delegation: yesNo(
      'Does the user forbid handing this work to other agents or sub-agents, or ask that it be done without delegating?',
      PERMISSION_BAND,
    ),
    requests_parallel_agents: yesNo(
      'Does the user ask for separate agents working in parallel, or one agent per item?',
      STAKES_BANDS.low.yesNo,
    ),
    forbids_writing: yesNo(
      'Does the user forbid changing files, or ask only for a design, plan or report without edits?',
      PERMISSION_BAND,
    ),
    asks_for_attempts: yesNo(
      'Does the user ask for several independent attempts at the same work so the best one can be picked?',
      STAKES_BANDS.low.yesNo,
    ),
  },
  fixtures: [
    {
      name: 'do it yourself, no sub-agents',
      state: { request: "Fix the null check in src/auth/session.ts yourself, don't hand this off to sub-agents." },
      expect: { forbids_delegation: 'yes', requests_parallel_agents: 'no', forbids_writing: 'no', asks_for_attempts: 'no' },
    },
    {
      name: 'in this session without spawning agents',
      state: { request: 'Please do this in this session without spawning any agents: rename getUser to fetchUser everywhere.' },
      expect: { forbids_delegation: 'yes', requests_parallel_agents: 'no', forbids_writing: 'no', asks_for_attempts: 'no' },
    },
    {
      name: 'one agent per package in parallel',
      state: { request: 'Spin up one agent per package to update the lint config in each of the five packages, all running in parallel.' },
      expect: { forbids_delegation: 'no', requests_parallel_agents: 'yes', forbids_writing: 'no', asks_for_attempts: 'no' },
    },
    {
      name: 'separate agents for each module at once',
      state: { request: 'Have separate agents write the unit tests for each of the three modules at the same time.' },
      expect: { forbids_delegation: 'no', requests_parallel_agents: 'yes', forbids_writing: 'no', asks_for_attempts: 'no' },
    },
    {
      name: 'report only, no file changes',
      state: { request: "Review the caching layer and write me a report on its failure modes. Don't change any files." },
      expect: { forbids_delegation: 'no', requests_parallel_agents: 'no', forbids_writing: 'yes', asks_for_attempts: 'no' },
    },
    {
      name: 'plan only, no edits yet',
      state: { request: 'Draft a migration plan for moving from Postgres 13 to 16. I only want the plan, no edits yet.' },
      expect: { forbids_delegation: 'no', requests_parallel_agents: 'no', forbids_writing: 'yes', asks_for_attempts: 'no' },
    },
    {
      name: 'three approaches, keep the fastest',
      state: { request: 'Try three different approaches to speeding up the image resize function and keep whichever is fastest.' },
      expect: { forbids_delegation: 'no', forbids_writing: 'no', asks_for_attempts: 'yes' },
    },
    {
      name: 'two independent implementations to compare',
      state: { request: 'Write two independent implementations of the rate limiter so I can compare them and choose one.' },
      expect: { forbids_delegation: 'no', forbids_writing: 'no', asks_for_attempts: 'yes' },
    },
    {
      name: 'plain feature request',
      state: { request: 'Add a --verbose flag to the CLI and document it in the README.' },
      expect: { forbids_delegation: 'no', requests_parallel_agents: 'no', forbids_writing: 'no', asks_for_attempts: 'no' },
    },
    {
      name: 'no delegation and read only',
      state: { request: "Don't delegate this: look through the job logs and tell me why last night's export failed, but don't touch anything." },
      expect: { forbids_delegation: 'yes', requests_parallel_agents: 'no', forbids_writing: 'yes', asks_for_attempts: 'no' },
    },
  ],
});

export type RequestShapeQuestion = keyof typeof requestShape.items;

/** The site every request-shape read is attributed to in the decision log. */
export const REQUEST_SHAPE_SITE = 'contract.request-shape';

function toShapeReading(reading: YesNoReading): ShapeReading {
  return { verdict: reading.verdict, probability: reading.probability, outcome: reading.outcome };
}

/** Reads the four shape questions about `ask` in one request. */
export async function readRequestShape(
  port: JudgmentPort,
  ask: string,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<{ readonly shape: RequestShape; readonly usage: { readonly inputTokens: number; readonly outputTokens: number } }> {
  const run = await requestShape.run(port, { request: ask }, {
    site: REQUEST_SHAPE_SITE,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const { readings, result } = run;
  run.recordAction('shaped');
  return {
    shape: {
      forbids_delegation: toShapeReading(readings.forbids_delegation),
      requests_parallel_agents: toShapeReading(readings.requests_parallel_agents),
      forbids_writing: toShapeReading(readings.forbids_writing),
      asks_for_attempts: toShapeReading(readings.asks_for_attempts),
      decisionIds: result.decisionId === undefined ? [] : [result.decisionId],
    },
    usage: result.usage,
  };
}

/** A shape question read yes at act: the only reading code acts on as "the user asked for this". */
export function saysYesAtAct(reading: ShapeReading): boolean {
  return reading.verdict === 'yes' && reading.outcome === 'act';
}

/** A shape question read no at act. */
export function saysNoAtAct(reading: ShapeReading): boolean {
  return reading.verdict === 'no' && reading.outcome === 'act';
}

/**
 * Whether the contract must run in session mode (section 6.6). Delegation is
 * allowed only on a no at act; a yes at any outcome, or a reading that
 * escalates, keeps the work in the session.
 */
export function delegationForbidden(shape: RequestShape): boolean {
  return !saysNoAtAct(shape.forbids_delegation);
}

/**
 * Whether the owner must say if files may change before planning starts: the
 * forbids-writing reading settled on neither side at act.
 */
export function writingUnclear(shape: RequestShape): boolean {
  return !saysYesAtAct(shape.forbids_writing) && !saysNoAtAct(shape.forbids_writing);
}
