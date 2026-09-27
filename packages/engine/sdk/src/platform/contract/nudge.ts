/**
 * The nudge (docs/design/contract-runner.md section 4.7): the text a unit's
 * agent receives when a check finds its work does not pass, built in code with
 * its order and wording fixed here so they are reviewable in one place, and
 * its delivery to the agent.
 *
 * The met list restates every criterion whose latest verdict is met, as
 * binding: corrections must not silently break what works, and a correction
 * that does break one is caught by the regression rule (progress.ts). The
 * criteria belong to the contract, so nothing the agent writes can change them.
 */
import type { AgentMessageBus } from '../agents/message-bus.js';
import type { QualityGateResult } from './gates.js';
import type { Regression } from './progress.js';
import type {
  ContractUnit,
  Criterion,
  CriterionSeverity,
  CriterionVerdict,
  Nudge,
  NudgeDelivery,
  NudgeKind,
  QualityItem,
} from './types.js';

/** The id the runner registers on the message bus and sends mid-run nudges from. */
export const CONTRACT_RUNNER_AGENT_ID = 'contract-runner';

/** Lines of a failing gate's output a nudge carries, from the end, where failures print. */
export const NUDGE_GATE_TAIL_LINES = 40;

/** One fixed sentence per quality item read as a problem. */
export const QUALITY_PROBLEM_SENTENCES: Readonly<Record<QualityItem, string>> = {
  placeholder: 'Placeholder or stub code remains where working behaviour is required.',
  tests_weakened: 'Existing tests or checks were deleted, skipped or loosened instead of making the code pass them.',
  breaks_existing: 'Existing behaviour this unit was not asked to change was removed or broken.',
  out_of_scope: "Files or behaviour unrelated to this unit's goal were changed.",
  hidden_failure: 'Errors are swallowed or failures hidden instead of reported.',
  unsupported_claims: 'Your report claims results (tests run, commands passing, files created) that the commands, diff or changed files do not show.',
};

/** One fixed sentence per quality item whose reading did not settle: what evidence to show. */
export const QUALITY_EVIDENCE_SENTENCES: Readonly<Record<QualityItem, string>> = {
  placeholder: 'Show that no placeholder, stub or to-do marker remains where working behaviour is required.',
  tests_weakened: 'Show that no existing test or check was deleted, skipped or loosened.',
  breaks_existing: 'Show that existing behaviour outside this unit still works.',
  out_of_scope: "Show that every changed file serves this unit's goal.",
  hidden_failure: 'Show that errors are reported, not swallowed.',
  unsupported_claims: 'Show the command output behind each result your report claims.',
};

const HEADER = (checkNumber: number, title: string): string =>
  `Contract check ${checkNumber} on "${title}": the work does not pass yet. Fix what is listed, then finish your turn; it will be checked again.`;
const NOT_MET = 'Not met:';
const REGRESSED = (checks: string): string =>
  `Regressed (these were met at check ${checks} and are not met now; restore them without undoing other fixes):`;
const NOT_SHOWN = 'Not shown (show evidence that these are met: run the command that proves it, or cite the file and line):';
const GOAL_UNMET = (goal: string): string => `Goal: The work as a whole does not yet do what the unit is for: ${goal}`;
const QUALITY = 'Quality problems:';
const GATES = 'Gate failures:';
const CLAIMS = 'Claims not found on disk:';
const CLAIM_MISSING = (path: string): string => `- ${path} (claimed as created or modified; not present)`;
const CLAIM_NO_CHANGES = '- No changed files were found and your report names none; this unit must change files to meet its criteria.';
const ALREADY_MET = 'Already met (binding: do not break these):';

/** What one check found, as the nudge needs it. */
export interface NudgeFindings {
  /** The check's number within the unit: n in `<unitId>.k<n>`. */
  readonly checkNumber: number;
  /** The sections to include. */
  readonly kinds: readonly NudgeKind[];
  /** This check's verdict per judged criterion id. */
  readonly verdicts: ReadonlyMap<string, CriterionVerdict>;
  readonly regressions: readonly Regression[];
  readonly goalVerdict: CriterionVerdict;
  readonly qualityProblems: readonly QualityItem[];
  readonly qualityUnshown: readonly QualityItem[];
  readonly failedGates: readonly QualityGateResult[];
  /** Paths the report claimed that are not on disk; `noChanges` when nothing changed and nothing was claimed by a unit that must write. */
  readonly claims?: { readonly missingPaths: readonly string[]; readonly noChanges: boolean } | undefined;
}

/** n from a check id `<scope>.k<n>`. */
export function checkNumberOf(checkId: string): number {
  const match = /\.k(\d+)$/.exec(checkId);
  if (match === null) throw new RangeError(`not a check id: ${checkId}`);
  return Number(match[1]);
}

/** The criterion's severity from its most recent reading that has one (severity is read after a nudge, so it shows from the next one on). */
export function latestSeverity(criterion: Pick<Criterion, 'readings'>): CriterionSeverity | undefined {
  for (let index = criterion.readings.length - 1; index >= 0; index -= 1) {
    const severity = criterion.readings[index]!.severity;
    if (severity !== undefined) return severity;
  }
  return undefined;
}

/** The last `count` lines of `text`. */
function tailLines(text: string, count: number): string[] {
  const lines = text.trimEnd().split('\n');
  return lines.slice(Math.max(0, lines.length - count));
}

function line(criterion: Pick<Criterion, 'id' | 'text'>, suffix = ''): string {
  return `- [${criterion.id}] ${criterion.text}${suffix}`;
}

/** A section: its heading and lines, or nothing when it has no lines. */
function section(heading: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [heading, ...lines];
}

/** The criteria whose latest verdict is met: this check's verdict, or for a criterion it did not read, its status. */
function metCriteria(criteria: readonly Criterion[], verdicts: ReadonlyMap<string, CriterionVerdict>): Criterion[] {
  return criteria.filter((criterion) => criterion.disposition === 'judged' && (verdicts.get(criterion.id) ?? criterion.status) === 'met');
}

/**
 * Builds the nudge text for one check. Sections appear in a fixed order and
 * only for the kinds the check nudges on; a section with nothing in it is
 * left out.
 */
export function buildNudge(unit: Pick<ContractUnit, 'title' | 'goal' | 'criteria'>, findings: NudgeFindings): string {
  const has = (kind: NudgeKind): boolean => findings.kinds.includes(kind);
  const judged = unit.criteria.filter((criterion) => criterion.disposition === 'judged');
  const regressed = new Map(findings.regressions.map((regression) => [regression.criterionId, regression]));
  const withVerdict = (verdict: CriterionVerdict): Criterion[] => judged.filter((criterion) => findings.verdicts.get(criterion.id) === verdict);

  const notMet = has('unmet')
    ? withVerdict('unmet').filter((criterion) => !regressed.has(criterion.id)).map((criterion) => {
      const severity = latestSeverity(criterion);
      return line(criterion, severity === undefined ? '' : ` (${severity})`);
    })
    : [];
  const regressedCriteria = has('regression') ? judged.filter((criterion) => regressed.has(criterion.id)) : [];
  const metAt = [...new Set(regressedCriteria.map((criterion) => checkNumberOf(regressed.get(criterion.id)!.metAtCheckId)))].sort((a, b) => a - b);
  const notShown = has('unshown')
    ? [
      ...withVerdict('unshown').map((criterion) => line(criterion)),
      ...(findings.goalVerdict === 'unshown' ? [`- [goal] ${unit.goal}`] : []),
      ...findings.qualityUnshown.map((item) => `- [quality] ${QUALITY_EVIDENCE_SENTENCES[item]}`),
    ]
    : [];
  const gateLines = has('gate')
    ? findings.failedGates.map((gate) => [`- ${gate.gate}:`, ...tailLines(gate.output, NUDGE_GATE_TAIL_LINES).map((text) => `  ${text}`)].join('\n'))
    : [];
  const claimLines = has('claims') && findings.claims !== undefined
    ? [...findings.claims.missingPaths.map(CLAIM_MISSING), ...(findings.claims.noChanges ? [CLAIM_NO_CHANGES] : [])]
    : [];

  const body = [
    ...section(NOT_MET, notMet),
    ...section(REGRESSED(metAt.join(', ')), regressedCriteria.map((criterion) => line(criterion))),
    ...section(NOT_SHOWN, notShown),
    ...(has('unmet') && findings.goalVerdict === 'unmet' ? [GOAL_UNMET(unit.goal)] : []),
    ...section(QUALITY, has('quality') ? findings.qualityProblems.map((item) => `- ${QUALITY_PROBLEM_SENTENCES[item]}`) : []),
    ...section(GATES, gateLines),
    ...section(CLAIMS, claimLines),
  ];
  const met = metCriteria(unit.criteria, findings.verdicts).map((criterion) => line(criterion));
  return [HEADER(findings.checkNumber, unit.title), '', ...body, ...(met.length > 0 ? ['', ...section(ALREADY_MET, met)] : [])].join('\n');
}

const VERDICT_WORDS: Readonly<Record<CriterionVerdict, string>> = { met: 'met', unmet: 'not met', unshown: 'not shown' };

/**
 * The "Previous checks" section a fresh agent for a unit receives after its
 * brief (transport retry, silence retry, fresh agent, resume, respawn after a
 * restart): each judged criterion's latest verdict, with its severity when
 * known and the check it was read at. Empty when the unit was never checked.
 */
export function buildPreviousChecks(unit: Pick<ContractUnit, 'criteria' | 'checks'>): string {
  if (unit.checks.length === 0) return '';
  const lines = unit.criteria
    .filter((criterion) => criterion.disposition === 'judged')
    .map((criterion) => {
      const latest = criterion.readings.at(-1);
      if (latest === undefined) return `- [${criterion.id}] ${criterion.text}: not yet read`;
      const severity = latest.verdict === 'unmet' ? latestSeverity(criterion) : undefined;
      return `- [${criterion.id}] ${criterion.text}: ${VERDICT_WORDS[latest.verdict]}${severity === undefined ? '' : ` (${severity})`} at check ${checkNumberOf(latest.checkId)}`;
    });
  return ['Previous checks (the latest verdict on each criterion; keep what is met, fix the rest):', ...lines].join('\n');
}

/** A nudge record for the unit's history. Its id is `<unitId>.n<count>`. */
export function createNudge(input: {
  readonly unit: Pick<ContractUnit, 'id' | 'nudges'>;
  readonly checkId: string;
  readonly kinds: readonly NudgeKind[];
  readonly criterionIds: readonly string[];
  readonly text: string;
  readonly delivery: NudgeDelivery;
  readonly agentId: string;
  readonly at: number;
}): Nudge {
  return {
    id: `${input.unit.id}.n${input.unit.nudges.length + 1}`,
    checkId: input.checkId,
    at: input.at,
    kinds: input.kinds,
    criterionIds: input.criterionIds,
    text: input.text,
    delivery: input.delivery,
    agentId: input.agentId,
  };
}

/** Where the unit's agent is when a nudge is ready (4.7 delivery table). */
export type NudgeTargetState = 'held' | 'running' | 'failed' | 'completed' | 'gone';

/** How a nudge reaches an agent in each state; an agent whose record is gone gets a new agent instead. */
export function nudgeDeliveryFor(state: NudgeTargetState): NudgeDelivery | 'respawn' {
  if (state === 'held') return 'hold';
  if (state === 'running') return 'bus';
  if (state === 'gone') return 'respawn';
  return 'wake';
}

/** The runner's view of the message bus and agent manager for delivering nudges. */
export interface NudgeTransport {
  readonly messageBus: Pick<AgentMessageBus, 'send'>;
  readonly agentManager: {
    wakeWithSteer(agentId: string, steer: string, options?: { readonly allowCompleted?: boolean }): { readonly woke: boolean; readonly reason: string };
  };
  /** `contract.nudgeTtlMs`: how long a mid-run nudge waits on the bus for the agent's next turn. */
  readonly nudgeTtlMs: number;
}

export type NudgeDispatch =
  /** The held completion returns this, and the loop adds `message` as the next user turn. */
  | { readonly kind: 'continue'; readonly message: string; readonly nudgeId: string }
  | { readonly kind: 'sent' }
  | { readonly kind: 'woke' }
  /** The agent could not be reached; the runner spawns a fresh agent for the unit. */
  | { readonly kind: 'undelivered'; readonly reason: string };

/**
 * Delivers a nudge by its recorded path. A held agent gets it as its hold's
 * continuation; a running agent through the bus as a steer, injected verbatim
 * before its next model call; a stopped agent by waking it with the text as a
 * fresh user turn (a completed one only with `allowCompleted`).
 */
export function dispatchNudge(nudge: Nudge, state: Exclude<NudgeTargetState, 'gone'>, transport: NudgeTransport): NudgeDispatch {
  if (state === 'held') return { kind: 'continue', message: nudge.text, nudgeId: nudge.id };
  if (state === 'running') {
    const sent = transport.messageBus.send(CONTRACT_RUNNER_AGENT_ID, nudge.agentId, nudge.text, { kind: 'steer', ttlMs: transport.nudgeTtlMs, id: nudge.id });
    return sent ? { kind: 'sent' } : { kind: 'undelivered', reason: 'the message bus refused the nudge' };
  }
  const wake = transport.agentManager.wakeWithSteer(nudge.agentId, nudge.text, state === 'completed' ? { allowCompleted: true } : undefined);
  return wake.woke ? { kind: 'woke' } : { kind: 'undelivered', reason: wake.reason };
}
