import { nativeContractTaskSource } from './native-source.js';
import { createContractInputAuthority, bindContractInputAuthority, assertContractInputAdmission, pinContractInputAdmission, authorizeContractInputPath, assertContractInputReadAccess, withContractInputAuthority, type ContractInputAuthority } from './input-authority.js';
import { bindContractActionSource } from '../tools/agent/contract-binding.js';
import { nativeContractActionSource } from './native-decisions.js';
/**
 * Planning (docs/design/contract-runner.md section 3): read the request's
 * shape, run the planning model as a read-only sub-agent, check its plan in
 * code and with Jev, send every problem back for repair up to
 * `contract.planRepairLimit`, and either accept the plan into the contract tree
 * or ask the owner.
 *
 * The planner runs through the `DecompositionRunner` seam directly; it never
 * goes through `decomposeGoal`, so there is no heuristic path. A planner that
 * cannot produce a plan fails the contract with `failureKind: 'planning'`;
 * there is no single-item fallback.
 */
import { assertContractInputView, contractInputPath } from './input-snapshot.js';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';

import { JudgmentPortMissingError, judgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import type { ContractEvent } from '../../events/contract.js';
import type { DecompositionBounds, DecompositionRunner, DecompositionRunResult } from '../core/plan-decomposition.js';
import { emptyWorkItemUsage, MAX_ATTEMPTS } from '../orchestration/types.js';
import { createRepoMapTool } from '../tools/repo-map/index.js';
import { summarizeError } from '../utils/error-display.js';
import { delegationForbidden, readRequestShape, REQUEST_SHAPE_SITE, saysYesAtAct, writingUnclear } from './batteries/request-shape.js';
import { readContractConfig, type ContractConfig, type ContractConfigReader } from './config.js';
import { nativeContractRoute, decideNativeContract, nativeContractPort, nativeDecisionState, nativeSpent, spendNative, type NativeContractServices } from './native-decisions.js';
import { assertNativeContractSource, nativeSourcePlan } from './native-source.js';
import { checkDraftFidelity, draftSection } from './draft-plan.js';
import { readCriterionDispositions, runPlanChecks, type CriterionDispositionRuling, type PlanCheckUsage, type PlanVerdict } from './plan-checks.js';
import {
  effectiveAttempts,
  isUnitRole,
  parseContractPlan,
  renderContractPlan,
  UNRUNNABLE_PLAN_PROBLEMS,
  validateContractPlan,
  type ContractPlan,
  type PlannedDerivedCriterion,
  type PlanProblem,
} from './plan-schema.js';
import {
  transitionContract,
  type Contract,
  type ContractDecisionAction,
  type ContractFailureKind,
  type ContractGroup,
  type ContractRouteSelector,
  type ContractStatus,
  type ContractUnit,
  type Criterion,
  type CriterionOrigin,
  type DraftedPlan,
  type Escalation,
  type EscalationReason,
  type RequestShape,
  type StartContractInput,
  type UnitRoute,
} from './types.js';

// ── Dependencies and outcomes ─────────────────────────────────────────────────

export interface ContractPlannerDeps {
  readonly native?: NativeContractServices | undefined;
  /** Runs the read-only planner sub-agent (agents/planner-decomposition-runner.ts in production). */
  readonly decompositionRunner: DecompositionRunner;
  /** Picks the planner's model; required, there is no default model. */
  readonly routeSelector: ContractRouteSelector;
  /** `contract.*` settings and the `planner.*` bounds. */
  readonly configManager: ContractConfigReader;
  /** Emits a contract event (the runner wraps `emitContractEvent`). */
  readonly emit: (event: ContractEvent) => void;
  /** The repository summary the planner is shown; defaults to the repo_map tool over the project root. */
  readonly repositoryMap?: ((projectRoot: string) => Promise<string>) | undefined;
  readonly readAccessFilter?: ReadAccessFilter | undefined;
  readonly now?: (() => number) | undefined;
}

export interface PlanContractInput {
  /** Units an agent-tool batch or AgentInput.proposedUnits proposed; the planner weighs them. */
  readonly proposedUnits?: StartContractInput['proposedUnits'];
  /** An owner's amend reply: an instruction for the planner, with authority over the user's requirements. */
  readonly ownerInstruction?: string | undefined;
  /** The plan the owner's instruction amends, as JSON. */
  readonly previousPlan?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type ShapeOutcome =
  | { readonly kind: 'shaped'; readonly shape: RequestShape }
  | { readonly kind: 'awaiting-owner'; readonly shape: RequestShape; readonly escalation: Escalation }
  | { readonly kind: 'failed'; readonly failureKind: ContractFailureKind; readonly reason: string }
  | { readonly kind: 'cancelled' };

export type PlanningOutcome =
  | { readonly kind: 'accepted'; readonly plan: ContractPlan; readonly decisionIds: readonly string[] }
  | { readonly kind: 'awaiting-owner'; readonly plan: ContractPlan; readonly problems: readonly PlanProblem[]; readonly escalation: Escalation }
  | { readonly kind: 'failed'; readonly failureKind: ContractFailureKind; readonly reason: string }
  | { readonly kind: 'cancelled' };

export type EscalatedPlanOutcome =
  | { readonly kind: 'accepted'; readonly plan: ContractPlan; readonly decisionIds: readonly string[] }
  /** The approved plan cannot run at all (a cycle, a duplicate id...); the owner must amend or stop instead. */
  | { readonly kind: 'unrunnable'; readonly problems: readonly PlanProblem[] }
  | { readonly kind: 'failed'; readonly failureKind: ContractFailureKind; readonly reason: string }
  | { readonly kind: 'cancelled' };

// ── Prompts ───────────────────────────────────────────────────────────────────

/** The planner's system prompt: the plan's JSON shape and every rule the checks enforce. */
export function buildContractPlannerPrompt(): string {
  return [
    'You plan a contract: work a person asked for, which sub-agents will carry out and which is checked against acceptance criteria while it is done.',
    'Read the repository as much as you need with your read-only tools, then answer with exactly one fenced ```json block of this shape and nothing after it:',
    '',
    '```json',
    '{',
    '  "goal": "one sentence: what the whole task delivers",',
    '  "criteria": [ { "id": "c1", "text": "checkable requirement", "quote": "the user\'s exact words it comes from" } ],',
    '  "groups": [',
    '    {',
    '      "id": "g1", "kind": "work", "title": "...", "goal": "...", "dependsOn": [],',
    '      "criteria": [ { "id": "g1.c1", "text": "...", "serves": ["c1"] } ],',
    '      "units": [',
    '        {',
    '          "id": "u1", "title": "...", "goal": "...", "role": "implement",',
    '          "brief": "what to do, where, and how it fits the whole",',
    '          "dependsOn": [], "files": ["src/a.ts"], "attempts": 1,',
    '          "criteria": [ { "id": "u1.c1", "text": "...", "serves": ["c1"] } ]',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Rules:',
    '- If an immutable native source is supplied, copy its complete goal and ordered root criteria exactly from the required projection, including ids, text and quote. Do not infer replacements from the display request or correction instructions. All rules about generating contract roots below apply only when there is no native source.',
    '- Contract criteria ("c1", "c2"...) are what the user requires: every requirement, limit and preference their request states, each as its own criterion, and nothing they did not ask for. Each has a "quote": the user\'s exact words it comes from, copied character for character from the request.',
    '- Every criterion must be checkable from the finished work: its files, its output, or a command run against it.',
    '- Groups are "g1", "g2"...; units are "u1", "u2"... and unique across the plan. A group criterion is "<groupId>.c<n>" and a unit criterion "<unitId>.c<n>". Every group and unit criterion lists in "serves" the contract criteria it serves.',
    '- Every unit has at least one criterion, and every contract criterion is served by at least one unit criterion.',
    '- A group "dependsOn" names other groups; a unit "dependsOn" names units in the same group. No dependency cycles.',
    '- Unit roles: "implement" (changes files or produces the deliverable), "research" (reads and reports, changes nothing), "design" (answers with a plan or design, changes nothing), "integration" (joins the other units\' work into the deliverable).',
    '- There are no review, test or verification units: every unit\'s work is checked against its criteria as it goes. When something must be verified, make it a criterion of the unit that does the work, for example "the tests for X pass".',
    '- No unit may do less than the criteria it serves require unless another unit covers the rest.',
    '- A plan with one unit has one group of kind "work" and no integration group. A plan with more than one unit ends with exactly one group of kind "integration" that depends on every other group and holds one unit with role "integration".',
    '- Units that do not depend on each other go in the same group so they can run at the same time.',
  ].join('\n');
}

export interface PlannerRequestInput {
  readonly ask: string;
  readonly nativeSource?: StartContractInput['nativeSource'];
  readonly shape: RequestShape;
  readonly config: Pick<ContractConfig, 'defaultAttempts' | 'maxUnits'>;
  readonly proposedUnits?: StartContractInput['proposedUnits'];
  /** A plan drafted before the contract started: the planner keeps its units. */
  readonly draftPlan?: DraftedPlan | undefined;
  readonly repositoryMap: string;
  readonly ownerInstruction?: string | undefined;
  readonly repair?: { readonly problems: readonly PlanProblem[]; readonly previousPlan: string } | undefined;
  readonly previousPlan?: string | undefined;
}

/** What the request shape tells the planner, one line per reading code acts on. */
function shapeLines(shape: RequestShape, config: PlannerRequestInput['config']): string[] {
  const lines: string[] = [];
  lines.push(delegationForbidden(shape)
    ? '- The user does not allow handing the work to other agents: plan exactly one unit, in one group, with no integration group.'
    : '- Units run as separate agents.');
  if (saysYesAtAct(shape.requests_parallel_agents)) {
    lines.push('- The user asked for separate agents working in parallel: put the independent units in one group with no dependency between them.');
  }
  if (saysYesAtAct(shape.forbids_writing)) {
    lines.push('- The user does not allow changing files: every unit is read-only, so plan research or design units whose answers are the deliverable.');
  }
  if (saysYesAtAct(shape.asks_for_attempts)) {
    lines.push(`- The user asked for several attempts to pick from: set "attempts" (at most ${MAX_ATTEMPTS}) on each unit that should be tried more than once.`);
  } else if (config.defaultAttempts > 1) {
    lines.push(`- Each unit runs ${config.defaultAttempts} attempts unless it sets "attempts".`);
  } else {
    lines.push('- Every unit has "attempts": 1.');
  }
  lines.push(`- The plan has at most ${config.maxUnits} units.`);
  return lines;
}

function problemLine(problem: PlanProblem): string {
  return `- [${problem.code}${problem.targetId === undefined ? '' : ` ${problem.targetId}`}] ${problem.message}`;
}

/** The planner's user prompt: the ask verbatim, the shape, proposed units, the repository, and on a repair every problem with the previous plan. */
export function buildContractPlannerRequest(input: PlannerRequestInput): string {
  const sections: string[] = [
    (input.nativeSource === undefined
      ? "## The user's request\nEvery contract criterion quotes these words exactly.\n\n<request>\n"
      : '## Display request\nThe separate immutable native source is authoritative for the full goal and ordered criteria.\n\n<request>\n') + input.ask + '\n</request>',
    '## How the user wants the work done\n' + shapeLines(input.shape, input.config).join('\n'),
  ];
  if (input.nativeSource !== undefined) {
    sections.push('## Immutable native source\nThis is the complete original goal and ordered criteria, with host revisions. Do not summarize, rewrite, drop, add or reorder these roots. Only derive groups and units. The root goal and criteria in every response must exactly equal the following projection.\n'
      + JSON.stringify(nativeContractTaskSource(input.nativeSource)) + '\nRequired plan roots:\n' + JSON.stringify(nativeSourcePlan(input.nativeSource)));
  }
  if (input.draftPlan !== undefined) sections.push(draftSection(input.draftPlan));
  const proposed = input.proposedUnits ?? [];
  if (proposed.length > 0) {
    sections.push('## Units already proposed\nUse them where they fit; the rules above still apply.\n' + proposed
      .map((unit) => `- ${unit.task}${unit.template === undefined ? '' : ` (template: ${unit.template})`}`)
      .join('\n'));
  }
  if (input.ownerInstruction !== undefined) {
    sections.push((input.nativeSource === undefined
      ? "## The owner's instruction\nThe owner has authority over the requirements: follow this instruction, rewording or dropping criteria as it says.\n\n"
      : "## Correction instruction\nApply only to derived work. The immutable native goal and ordered criteria cannot change.\n\n") + input.ownerInstruction);
    if (input.previousPlan !== undefined) sections.push('## The plan the instruction changes\n```json\n' + input.previousPlan + '\n```');
  }
  sections.push('## Repository\n' + input.repositoryMap);
  if (input.repair !== undefined) {
    sections.push(
      '## Problems with your previous plan\nFix every one and return the whole corrected plan.\n'
        + input.repair.problems.map(problemLine).join('\n')
        + '\n\nPrevious plan:\n```json\n' + input.repair.previousPlan + '\n```',
    );
  }
  return sections.join('\n\n');
}

// ── Escalation questions (section 6.3's form) ─────────────────────────────────

const REASON_SENTENCES: Readonly<Partial<Record<EscalationReason, string>>> = {
  'plan-unresolved': 'The planner could not resolve these problems within its repair limit.',
  'writing-unclear': 'Your request does not make clear whether the work may change files.',
};

/** Keeps a quoted title to one readable line. */
function titleOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

/**
 * The plan-unresolved question. It carries the plan as the last fenced JSON
 * block, so an approval accepts exactly the plan the owner was shown
 * (`acceptEscalatedPlan` parses it back).
 */
export function buildPlanEscalationQuestion(contractId: string, goal: string, problems: readonly PlanProblem[], planJson: string): string {
  return [
    `Contract ${contractId} needs your decision on plan "${titleOf(goal)}".`,
    REASON_SENTENCES['plan-unresolved'],
    'Problems:',
    ...problems.map(problemLine),
    'Current plan:',
    '```json',
    planJson,
    '```',
    'Reply to approve accepting the plan as it stands, to change what is required (say how), or to stop the contract.',
  ].join('\n');
}

export function buildWritingEscalationQuestion(contractId: string, ask: string): string {
  return [
    `Contract ${contractId} needs your decision on the request "${titleOf(ask)}".`,
    REASON_SENTENCES['writing-unclear'],
    'Reply to approve changing files, to change what is required (say how, for example that nothing may be changed), or to stop the contract.',
  ].join('\n');
}

/** The shape after the owner settled whether files may change: a reading at act, since the owner said it. */
export function withOwnerWritingDecision(shape: RequestShape, forbidsWriting: boolean): RequestShape {
  return { ...shape, forbids_writing: { verdict: forbidsWriting ? 'yes' : 'no', probability: forbidsWriting ? 1 : 0, outcome: 'act' } };
}

// ── Contract bookkeeping ──────────────────────────────────────────────────────

class PlanningContext {
  readonly now: () => number;
  readonly config: ContractConfig;

  constructor(readonly contract: Contract, readonly deps: ContractPlannerDeps) {
    this.now = deps.now ?? Date.now;
    this.config = readContractConfig(deps.configManager);
  }

  move(to: ContractStatus): void {
    if (this.contract.status === to) return;
    const change = transitionContract(this.contract, to);
    this.deps.emit({ type: 'CONTRACT_STATUS_CHANGED', contractId: this.contract.id, from: change.from, to: change.to });
  }

  decide(action: ContractDecisionAction, reason: string, decisionIds: readonly string[] = [], route?: UnitRoute): void {
    const { contract } = this;
    contract.decisions.push({
      id: `${contract.id}.d${contract.decisions.length + 1}`,
      at: this.now(),
      action,
      targetId: contract.id,
      reason,
      decisionIds,
      ...(route === undefined ? {} : { route }),
    });
  }

  addJudgmentUsage(usage: PlanCheckUsage): void {
    const total = this.contract.judgmentUsage;
    total.calls += usage.calls;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
  }

  /** Ends the contract failed. The runner settles the owner record from the outcome. */
  fail(failureKind: ContractFailureKind, reason: string): { readonly kind: 'failed'; readonly failureKind: ContractFailureKind; readonly reason: string } {
    const { contract } = this;
    this.move('failed');
    contract.failureKind = failureKind;
    contract.error = reason;
    contract.completedAt = this.now();
    this.decide('failed', reason);
    this.deps.emit({ type: 'CONTRACT_FAILED', contractId: contract.id, reason, failureKind, membersSettled: false });
    return { kind: 'failed', failureKind, reason };
  }

  escalate(scope: Escalation['scope'], reason: EscalationReason, question: string, decisionIds: readonly string[]): Escalation {
    const { contract } = this;
    const escalation: Escalation = {
      id: `${contract.id}.e${contract.escalations.length + 1}`,
      at: this.now(),
      scope,
      targetId: contract.id,
      reason,
      question,
      unmetCriterionIds: [],
      ...(decisionIds.length === 0 ? {} : { decisionIds: [...decisionIds] }),
    };
    contract.escalations.push(escalation);
    this.move('awaiting-owner');
    this.decide('escalated', `${reason}: asked the owner`, decisionIds);
    this.deps.emit({
      type: 'CONTRACT_ESCALATED',
      contractId: contract.id,
      escalationId: escalation.id,
      scope,
      targetId: escalation.targetId,
      reason,
      question,
      unmetCriterionIds: [],
    });
    return escalation;
  }
}

/** A Jev read that could not happen: no port, or an endpoint that could not answer after the failover chain. */
function judgmentFailureReason(error: unknown): string | undefined {
  if (error instanceof JudgmentPortMissingError) return error.message;
  if (error instanceof JudgmentError && error.kind !== 'aborted') return `Jev could not answer: ${error.message}`;
  return undefined;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof JudgmentError && error.kind === 'aborted');
}

// ── Shaping ───────────────────────────────────────────────────────────────────

/**
 * Reads the request shape (section 3.1) for a queued or shaping contract,
 * stores it, and asks the owner first when it cannot tell whether files may
 * change.
 */
export async function shapeContract(contract: Contract, deps: ContractPlannerDeps, options: { readonly signal?: AbortSignal | undefined } = {}): Promise<ShapeOutcome> {
  const context = new PlanningContext(contract, deps);
  context.move('shaping');
  let read: Awaited<ReturnType<typeof readRequestShape>>;
  const reusedShape = contract.nativeSource !== undefined && contract.shape !== undefined;
  try {
    read = contract.nativeSource !== undefined && contract.shape !== undefined
      ? { shape: contract.shape, usage: { inputTokens: 0, outputTokens: 0 } }
      : await readRequestShape(nativeContractPort(contract, deps.native, judgmentPort(REQUEST_SHAPE_SITE), options.signal), contract.ask, { ...options, nativeSource: contract.nativeSource });
  } catch (error) {
    if (isAbort(error, options.signal)) return { kind: 'cancelled' };
    const reason = judgmentFailureReason(error);
    if (reason === undefined) throw error;
    return context.fail('judgment-unavailable', reason);
  }
  const { shape, usage } = read;
  contract.shape = shape;
  context.addJudgmentUsage({ calls: reusedShape ? 0 : 1, ...usage });
  context.decide('shaped', describeShape(shape), shape.decisionIds);
  deps.emit({
    type: 'CONTRACT_SHAPED',
    contractId: contract.id,
    forbidsDelegation: shape.forbids_delegation,
    requestsParallelAgents: shape.requests_parallel_agents,
    forbidsWriting: shape.forbids_writing,
    asksForAttempts: shape.asks_for_attempts,
    decisionIds: shape.decisionIds,
  });
  if (writingUnclear(shape) && contract.nativeSource !== undefined) {
    const decision = await decideNativeContract(contract, deps.native, { stage: 'shape', targetId: contract.id,
      action: 'Proceed to planning with the observed request shape. Any writing must satisfy the complete original requirements and live capability boundaries. No reading is changed by this decision.',
      allowAct: true, state: () => ({ forbidsWriting: { ...shape.forbids_writing }, forbidsDelegation: { ...shape.forbids_delegation } }),
      continuations: [], decisionIds: shape.decisionIds, signal: options.signal ?? new AbortController().signal });
    if (decision.decision.outcome !== 'act') return context.fail('planning', 'Jev refused proceeding from the unresolved request shape');
    decision.recordClaim();
    return { kind: 'shaped', shape };
  }
  if (writingUnclear(shape)) {
    const escalation = context.escalate('shape', 'writing-unclear', buildWritingEscalationQuestion(contract.id, contract.ask), shape.decisionIds);
    return { kind: 'awaiting-owner', shape, escalation };
  }
  return { kind: 'shaped', shape };
}

function describeShape(shape: RequestShape): string {
  const said = (name: string, reading: RequestShape['forbids_writing']): string => `${name} ${reading.verdict} (${reading.outcome})`;
  return [
    said('forbids delegation', shape.forbids_delegation),
    said('parallel agents', shape.requests_parallel_agents),
    said('forbids writing', shape.forbids_writing),
    said('attempts', shape.asks_for_attempts),
  ].join('; ');
}

// ── Planning ──────────────────────────────────────────────────────────────────

/** The `planner.*` bounds, with the finite-positive guard the decomposition service uses. */
export function readPlannerBounds(configManager: ContractConfigReader): DecompositionBounds {
  const read = (key: 'planner.maxTurns' | 'planner.tokenCeiling' | 'planner.wallTimeoutMs', fallback: number): number => {
    const value: unknown = configManager.get(key);
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    maxTurns: read('planner.maxTurns', 6),
    tokenCeiling: read('planner.tokenCeiling', 120_000),
    wallTimeoutMs: read('planner.wallTimeoutMs', 120_000),
  };
}

/** The repository summary the planner starts from: the repo_map tool's ranked map. */
export async function defaultRepositoryMap(projectRoot: string, readAccessFilter?: ReadAccessFilter, capturedReadAccess?: ReadAccessFilter): Promise<string> {
  const result = await createRepoMapTool({ projectRoot, ...(capturedReadAccess === undefined ? {} : { capturedReadAccess }), ...(readAccessFilter === undefined ? {} : { readAccessFilter }) }).execute({ budgetTokens: 2_000 });
  return result.success ? (result.output ?? '') : `No repository map: ${result.error ?? 'the map could not be built'}. Use your read tools.`;
}

function runFailureReason(run: DecompositionRunResult): string {
  const detail = run.detail === undefined ? '' : `: ${run.detail}`;
  return run.status === 'cancelled' ? `the planner agent was stopped${detail}` : `the planner agent failed${detail}`;
}

/** One plan read and checked. */
interface CheckedPlan {
  readonly plan: ContractPlan | undefined;
  /** The plan as shown back to the planner or the owner. */
  readonly text: string;
  readonly problems: readonly PlanProblem[];
  readonly verdict: PlanVerdict | undefined;
}

async function checkPlanText(context: PlanningContext, output: string, repair: number, signal: AbortSignal | undefined): Promise<CheckedPlan> {
  const { contract, deps, config } = context;
  const shape = contract.shape!;
  const parsed = parseContractPlan(output);
  if (!parsed.ok) {
    deps.emit({ type: 'CONTRACT_PLAN_CHECKED', contractId: contract.id, check: 'structure', passed: false, problems: parsed.problems, decisionIds: [] });
    return { plan: undefined, text: output, problems: parsed.problems, verdict: undefined };
  }
  const { plan } = parsed;
  const text = renderContractPlan(plan);
  context.move('checking-plan');
  context.decide('planned', repair === 0 ? 'the planner wrote a plan' : `the planner wrote repair ${repair}`);
  const codeProblems = [
    ...validateContractPlan(plan, contract.ask, shape, config, contract.nativeSource),
    ...(contract.draftPlan === undefined ? [] : checkDraftFidelity(plan, contract.draftPlan)),
  ];
  deps.emit({ type: 'CONTRACT_PLAN_CHECKED', contractId: contract.id, check: 'structure', passed: codeProblems.length === 0, problems: codeProblems, decisionIds: [] });
  if (codeProblems.length > 0) return { plan, text, problems: codeProblems, verdict: undefined };
  const verdict = await runPlanChecks(plan, contract.ask, shape, { signal, nativeSource: contract.nativeSource, native: { contract, services: deps.native } });
  context.addJudgmentUsage(verdict.usage);
  for (const entry of verdict.reports) {
    deps.emit({ type: 'CONTRACT_PLAN_CHECKED', contractId: contract.id, check: entry.check, passed: entry.passed, problems: entry.problems, decisionIds: entry.decisionIds });
  }
  deps.emit(plannedEvent(contract.id, plan, verdict.dispositions, config.defaultAttempts, repair));
  return { plan, text, problems: verdict.problems, verdict };
}

/**
 * Plans a shaped contract (section 3.5): plan, code checks, Jev checks, and a
 * repair request listing every problem, up to `contract.planRepairLimit`
 * repairs. Accepts the plan into the contract tree, or asks the owner when
 * problems remain, or fails the contract with `planning` when the planner
 * cannot produce a readable plan.
 */
export async function planContract(contract: Contract, deps: ContractPlannerDeps, input: PlanContractInput = {}): Promise<PlanningOutcome> {
  assertNativeContractSource(contract);
  if (contract.shape === undefined) throw new Error(`contract ${contract.id} has no request shape; shape it before planning`);
  const context = new PlanningContext(contract, deps);
  const { signal } = input;
  if (signal?.aborted) return { kind: 'cancelled' };
  // Keep the admitted receipt owned by this invocation across every await.
  // A replacement receipt must not silently re-ground a partially produced plan.
  const admitted = contract.inputSnapshot;
  if (admitted !== undefined) pinContractInputAdmission(contract, signal);
  const snapshot = admitted === undefined ? undefined : structuredClone(admitted);
  const receipt = JSON.stringify(admitted);
  const assertCurrent = async (): Promise<void> => {
    signal?.throwIfAborted();
    if (admitted !== undefined) assertContractInputAdmission(contract);
    if (contract.inputSnapshot !== admitted || JSON.stringify(contract.inputSnapshot) !== receipt) throw new Error('contract input receipt changed during planning');
    if (snapshot !== undefined) await assertContractInputView(snapshot, signal);
    signal?.throwIfAborted();
    if (contract.inputSnapshot !== admitted || JSON.stringify(contract.inputSnapshot) !== receipt) throw new Error('contract input receipt changed during planning');
  };
  await assertCurrent();
  if (snapshot !== undefined && deps.readAccessFilter === undefined) throw new Error('captured planning requires original-owner read authorization');
  const workingDirectory = snapshot === undefined ? contract.projectRoot : contractInputPath(snapshot);
  const authority = snapshot === undefined ? undefined : await createContractInputAuthority(contract, workingDirectory, { signal, snapshot });
  context.move('planning');

  let route: UnitRoute;
  try {
    route = await nativeContractRoute(deps.routeSelector, contract, deps.native, { purpose: 'planner', contract }, signal);
  } catch (error) {
    if (isAbort(error, signal)) return { kind: 'cancelled' };
    // The route planner reads the work through Jev: an outage is the judgment's, not the planning's.
    const unavailable = judgmentFailureReason(error);
    if (unavailable !== undefined) return context.fail('judgment-unavailable', `no route for the planner: ${unavailable}`);
    return context.fail('planning', `no route for the planner: ${summarizeError(error)}`);
  }
  context.decide('spawned', `planner route: ${route.reason}`, [], route);
  // Both the original path and the unique generation must pass the existing read boundary.
  // Snapshot membership is only provenance; a source-path denial is not erased by copying.
  await assertCurrent();
  const filter = deps.readAccessFilter;
  const readAccessFilter: ReadAccessFilter | undefined = authority === undefined ? filter : async (path) => {
    try { await authorizeContractInputPath(authority, path, filter, signal); return true; }
    catch { return false; }
  };
  const map = () => deps.repositoryMap === undefined ? defaultRepositoryMap(workingDirectory, readAccessFilter, authority ? readAccessFilter : undefined) : deps.repositoryMap(workingDirectory);
  const repositoryMap = await (authority ? withContractInputAuthority(authority, map) : map());
  if (authority) await assertContractInputReadAccess(authority, filter, signal);
  const bounds = readPlannerBounds(deps.configManager);
  const systemPrompt = buildContractPlannerPrompt();
  if (contract.nativeSource !== undefined) return planNativeContract(context, input, route, repositoryMap, bounds, systemPrompt, { workingDirectory, authority, assertCurrent });

  let repair = 0;
  let previous: { readonly problems: readonly PlanProblem[]; readonly previousPlan: string } | undefined;
  try {
    for (;;) {
      if (signal?.aborted) return { kind: 'cancelled' };
      await assertCurrent();
      const userPrompt = buildContractPlannerRequest({
        ask: contract.ask,
        nativeSource: contract.nativeSource,
        shape: contract.shape,
        config: context.config,
        proposedUnits: input.proposedUnits,
        draftPlan: contract.draftPlan,
        repositoryMap,
        ownerInstruction: input.ownerInstruction,
        previousPlan: input.previousPlan,
        repair: previous,
      });
      const run = await deps.decompositionRunner.run(bindContractInputAuthority({
        goal: contract.ask,
        workingDir: workingDirectory,
        systemPrompt,
        userPrompt,
        bounds,
        attempt: repair === 0 ? 'initial' : 'repair',
        route,
        ...(signal === undefined ? {} : { signal }),
      }, authority));
      if (run.agentId !== undefined) contract.plannerAgentIds.push(run.agentId);
      if (signal?.aborted) return { kind: 'cancelled' };
      await assertCurrent();
      if (run.status !== 'completed') return context.fail('planning', runFailureReason(run));

      const checked = await checkPlanText(context, run.output, repair, signal);
      await assertCurrent();
      if (checked.problems.length === 0 && checked.plan !== undefined) {
        const decisionIds = [...contract.shape.decisionIds, ...(checked.verdict?.decisionIds ?? [])];
        acceptPlan(contract, checked.plan, checked.verdict?.dispositions ?? new Map(), context, decisionIds);
        return { kind: 'accepted', plan: checked.plan, decisionIds };
      }
      if (repair >= context.config.planRepairLimit) {
        if (checked.plan === undefined) {
          return context.fail('planning', `the planner's answer was not a readable plan after ${repair} repairs: ${checked.problems.map((entry) => entry.message).join(' ')}`);
        }
        const escalation = context.escalate(
          'plan',
          'plan-unresolved',
          buildPlanEscalationQuestion(contract.id, checked.plan.goal, checked.problems, checked.text),
          checked.verdict?.decisionIds ?? [],
        );
        return { kind: 'awaiting-owner', plan: checked.plan, problems: checked.problems, escalation };
      }
      repair += 1;
      previous = { problems: checked.problems, previousPlan: checked.text };
      context.decide('plan-repaired', `repair ${repair}: ${checked.problems.map((entry) => entry.code).join(', ')}`, checked.verdict?.decisionIds ?? []);
      context.move('planning');
    }
  } catch (error) {
    if (isAbort(error, signal)) return { kind: 'cancelled' };
    const reason = judgmentFailureReason(error);
    if (reason === undefined) throw error;
    return context.fail('judgment-unavailable', reason);
  }
}

/** Native planning consumes durable attempt counters and semantic receipts, never an owner approval. */
async function planNativeContract(context: PlanningContext, input: PlanContractInput, route: UnitRoute, repositoryMap: string, bounds: DecompositionBounds, systemPrompt: string,
  admitted: { readonly workingDirectory: string; readonly authority: ContractInputAuthority | undefined; assertCurrent(): Promise<void> }): Promise<PlanningOutcome> {
  const { contract, deps } = context;
  const signal = input.signal ?? new AbortController().signal;
  const sourceOf = nativeContractActionSource(contract, deps.native, signal);
  const state = nativeDecisionState(contract);
  const budgetKey = 'plan';
  let output = state.plannerOutputs[budgetKey];
  let needsPlan = output === undefined;
  let previous: { readonly problems: readonly PlanProblem[]; readonly previousPlan: string } | undefined;
  try {
    for (;;) {
      signal.throwIfAborted();
      await admitted.assertCurrent();
      if (needsPlan) {
        if (nativeSpent(contract, budgetKey) >= context.config.planRepairLimit + 1) {
          await decideNativeContract(contract, deps.native, { stage: 'plan', targetId: contract.id, action: 'Start another planning attempt', allowAct: false,
            state: () => ({ attempts: nativeSpent(contract, budgetKey), limit: context.config.planRepairLimit + 1, reason: 'Planning budget exhausted' }), continuations: [], signal });
          return context.fail('planning', 'Native planning budget exhausted; no eligible planning continuation');
        }
        const attempt = spendNative(contract, deps.native, budgetKey);
        const request = buildContractPlannerRequest({ ask: contract.ask, nativeSource: contract.nativeSource, shape: contract.shape!, config: context.config,
          proposedUnits: input.proposedUnits, draftPlan: contract.draftPlan, repositoryMap, repair: previous });
        const run = await deps.decompositionRunner.run(bindContractActionSource(bindContractInputAuthority({ goal: contract.nativeSource!.goal, workingDir: admitted.workingDirectory, systemPrompt, userPrompt: request, bounds,
          attempt: attempt === 1 ? 'initial' : 'repair', route, signal }, admitted.authority), sourceOf, port => nativeContractPort(contract, deps.native, port, signal)));
        if (run.agentId !== undefined) contract.plannerAgentIds.push(run.agentId);
        signal.throwIfAborted();
        await admitted.assertCurrent();
        if (run.status !== 'completed') return context.fail('planning', runFailureReason(run));
        output = run.output; state.plannerOutputs[budgetKey] = output; deps.native?.changed(contract);
      }
      const checked = await checkPlanText(context, output!, nativeSpent(contract, budgetKey) - 1, signal);
      await admitted.assertCurrent();
      const valid = checked.problems.length === 0 && checked.plan !== undefined;
      const canRepair = nativeSpent(contract, budgetKey) < context.config.planRepairLimit + 1;
      const decisionIds = [...contract.shape!.decisionIds, ...(checked.verdict?.decisionIds ?? [])];
      const decision = await decideNativeContract(contract, deps.native, { stage: 'plan', targetId: contract.id,
        action: 'Accept this exact checked plan and schedule its derived units against the immutable original roots', allowAct: valid,
        state: () => ({ plan: checked.plan ?? null, problems: checked.problems, attempts: nativeSpent(contract, budgetKey), limit: context.config.planRepairLimit + 1 }) as unknown as import('@goodvibes-jev/judgment').EntryType,
        continuations: canRepair ? [{ id: 'repair-plan', kind: 'revise-action', description: 'Use one remaining planner attempt to revise the derived plan while preserving all original roots.' }] : [], decisionIds, signal });
      await admitted.assertCurrent();
      decision.assertCurrent();
      if (decision.decision.outcome === 'act' && checked.plan !== undefined) {
        decision.recordClaim();
        acceptPlan(contract, checked.plan, checked.verdict?.dispositions ?? new Map(), context, decision.decision.judgmentDecisionIds, 'native Jev act on the exact checked plan');
        return { kind: 'accepted', plan: checked.plan, decisionIds: decision.decision.judgmentDecisionIds };
      }
      if (decision.decision.outcome === 'reject') return context.fail('planning', 'Jev refused the native plan');
      if (decision.continuationId !== 'repair-plan' || !canRepair) throw new Error('Native planner continuation is no longer eligible');
      decision.assertCurrent();
      previous = { problems: checked.problems, previousPlan: checked.text }; needsPlan = true;
      context.decide('plan-repaired', 'Jev selected registered native plan repair', decision.decision.judgmentDecisionIds);
      context.move('planning');
    }
  } catch (error) {
    if (isAbort(error, signal)) return { kind: 'cancelled' };
    const reason = judgmentFailureReason(error);
    if (reason === undefined) throw error;
    return context.fail('judgment-unavailable', reason);
  }
}

/**
 * The owner approved an unresolved plan (section 3.5): accept exactly the plan
 * the escalation showed. The owner settles its problems, but a plan the engine
 * cannot run at all is refused, and topology-only criteria are still read so
 * they are never judged.
 */
export async function acceptEscalatedPlan(
  contract: Contract,
  escalation: Escalation,
  deps: ContractPlannerDeps,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<EscalatedPlanOutcome> {
  if (contract.nativeSource !== undefined) return { kind: 'unrunnable', problems: [{ code: 'native-source-changed', message: 'Native plans require a fresh semantic decision; owner approval is unavailable.' }] };
  if (escalation.reason !== 'plan-unresolved') throw new Error(`escalation ${escalation.id} is not about the plan`);
  if (contract.shape === undefined) throw new Error(`contract ${contract.id} has no request shape`);
  const context = new PlanningContext(contract, deps);
  const parsed = parseContractPlan(escalation.question);
  if (!parsed.ok) return { kind: 'unrunnable', problems: parsed.problems };
  const blocking = validateContractPlan(parsed.plan, contract.ask, contract.shape, context.config, contract.nativeSource).filter((entry) => UNRUNNABLE_PLAN_PROBLEMS.has(entry.code));
  if (blocking.length > 0) return { kind: 'unrunnable', problems: blocking };
  try {
    const read = await readCriterionDispositions(parsed.plan, contract.ask, contract.shape, { ...options, nativeSource: contract.nativeSource });
    context.addJudgmentUsage(read.usage);
    // The plan checks the owner settled, the owner's reply, and the dispositions read now.
    const decisionIds = [
      ...contract.shape.decisionIds,
      ...(escalation.decisionIds ?? []),
      ...(escalation.reply?.decisionId === undefined ? [] : [escalation.reply.decisionId]),
      ...read.decisionIds,
    ];
    acceptPlan(contract, parsed.plan, read.dispositions, context, decisionIds, 'approved by the owner as it stands');
    return { kind: 'accepted', plan: parsed.plan, decisionIds };
  } catch (error) {
    if (isAbort(error, options.signal)) return { kind: 'cancelled' };
    const reason = judgmentFailureReason(error);
    if (reason === undefined) throw error;
    return context.fail('judgment-unavailable', reason);
  }
}

// ── The contract tree ─────────────────────────────────────────────────────────

function plannedEvent(
  contractId: string,
  plan: ContractPlan,
  dispositions: ReadonlyMap<string, CriterionDispositionRuling>,
  defaultAttempts: number,
  repair: number,
): ContractEvent {
  const tree = buildPlanTree(plan, dispositions, defaultAttempts);
  return {
    type: 'CONTRACT_PLANNED',
    contractId,
    goal: plan.goal,
    criteria: tree.criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      origin: criterion.origin,
      quote: criterion.quote,
      serves: criterion.serves,
      disposition: criterion.disposition,
      dispositionReason: criterion.dispositionReason,
    })),
    groups: tree.groups.map((group) => ({ id: group.id, title: group.title, kind: group.kind, dependsOn: group.dependsOn, unitIds: group.unitIds })),
    units: tree.units.map((unit) => ({ id: unit.id, groupId: unit.groupId, title: unit.title, role: unit.role, dependsOn: unit.dependsOn, attempts: unit.attempts })),
    repair,
  };
}

function derivedCriterion(criterion: PlannedDerivedCriterion, origin: CriterionOrigin): Criterion {
  return { id: criterion.id, text: criterion.text, origin, serves: [...criterion.serves], disposition: 'judged', status: 'unread', readings: [] };
}

/**
 * The contract tree for a checked plan: stated criteria with their
 * dispositions (a met-by-structure criterion reads met from the start, an
 * excluded one stays unread and is never judged), groups pending or blocked
 * on their dependencies, and units pending.
 */
export function buildPlanTree(
  plan: ContractPlan,
  dispositions: ReadonlyMap<string, CriterionDispositionRuling>,
  defaultAttempts: number,
): { readonly goal: string; readonly criteria: Criterion[]; readonly groups: ContractGroup[]; readonly units: ContractUnit[] } {
  const criteria: Criterion[] = plan.criteria.map((criterion) => {
    const ruling = dispositions.get(criterion.id);
    return {
      id: criterion.id,
      text: criterion.text,
      origin: 'stated',
      quote: criterion.quote,
      serves: [],
      disposition: ruling?.disposition ?? 'judged',
      ...(ruling === undefined ? {} : { dispositionReason: ruling.reason }),
      status: ruling?.disposition === 'met-by-structure' ? 'met' : 'unread',
      readings: [],
    };
  });
  const groups: ContractGroup[] = plan.groups.map((group) => ({
    id: group.id,
    title: group.title,
    goal: group.goal,
    kind: group.kind,
    dependsOn: [...group.dependsOn],
    criteria: group.criteria.map((criterion) => derivedCriterion(criterion, 'derived')),
    unitIds: group.units.map((unit) => unit.id),
    status: group.dependsOn.length === 0 ? 'pending' : 'blocked',
    checks: [],
    fixRounds: 0,
    usage: emptyWorkItemUsage(),
  }));
  const units: ContractUnit[] = plan.groups.flatMap((group) => group.units.map((unit): ContractUnit => {
    if (!isUnitRole(unit.role)) throw new Error(`unit ${unit.id} has role "${unit.role}", which the code checks refuse`);
    return {
      id: unit.id,
      groupId: group.id,
      title: unit.title,
      goal: unit.goal,
      brief: unit.brief,
      role: unit.role,
      dependsOn: [...unit.dependsOn],
      files: [...unit.files],
      attempts: effectiveAttempts(unit, defaultAttempts),
      criteria: unit.criteria.map((criterion) => derivedCriterion(criterion, unit.role === 'integration' ? 'integration' : 'derived')),
      status: 'pending',
      agentIds: [],
      checks: [],
      nudges: [],
      fixRounds: 0,
      freshAgents: 0,
      transportRetries: 0,
      touchedPaths: [],
      usage: emptyWorkItemUsage(),
    };
  }));
  return { goal: plan.goal, criteria, groups, units };
}

/**
 * Makes the plan the contract tree and records the `plan-accepted` decision
 * with every decision id behind it. The status is left for the runner, which
 * moves the contract to `running` once its groups are created.
 */
function acceptPlan(
  contract: Contract,
  plan: ContractPlan,
  dispositions: ReadonlyMap<string, CriterionDispositionRuling>,
  context: PlanningContext,
  decisionIds: readonly string[],
  how = 'every plan check passed',
): void {
  const tree = buildPlanTree(plan, dispositions, context.config.defaultAttempts);
  if (contract.nativeSource === undefined) {
    contract.goal = tree.goal;
    contract.criteria = tree.criteria;
  } else {
    assertNativeContractSource(contract);
  }
  contract.groups = tree.groups;
  contract.units = tree.units;
  const excluded = tree.criteria.filter((criterion) => criterion.disposition === 'excluded').length;
  const structural = tree.criteria.filter((criterion) => criterion.disposition === 'met-by-structure').length;
  const notes = [
    `${tree.units.length} unit${tree.units.length === 1 ? '' : 's'} in ${tree.groups.length} group${tree.groups.length === 1 ? '' : 's'}`,
    ...(excluded > 0 ? [`${excluded} criterion${excluded === 1 ? '' : 'a'} excluded: requires an agent arrangement`] : []),
    ...(structural > 0 ? [`${structural} criterion${structural === 1 ? '' : 'a'} met by the plan's structure`] : []),
  ];
  context.decide('plan-accepted', `${how}; ${notes.join('; ')}`, decisionIds);
}
