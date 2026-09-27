/**
 * Best-of-N by candidate selection (docs/design/contract-runner.md section
 * 6.2). Replaces the provider-backed attempt judge that parsed a model's
 * prose verdict.
 *
 * - A unit with `attempts > 1` in worktree mode gets one attempt unit per
 *   sibling the engine's attempts coordinator expands it into (same ids). Each
 *   attempt runs the full nudge loop on its own agent and worktree, and parks
 *   in `held-merge` only after passing. A failed attempt is never a candidate.
 * - When the engine reports the siblings ready, Jev reads `contract.best-of-n`
 *   over the passing attempts. A chosen attempt at act is picked through the
 *   engine (it merges into the contract branch and the unit passes with its
 *   work); a chosen attempt at confirm, none, or escalate goes to the owner as
 *   an `attempts-undecided` escalation (the R.6 step), whose approval or named
 *   pick comes back through `acceptAttempt`.
 * - `createSelectAttemptJudge` wraps the same selector as the engine's
 *   `judgeAttempts`, for the operator verb `fleet.attempts.judge`.
 *
 * Trimming candidates to the request budget and wording the reasons are code;
 * only the selection is judged.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { estimateTokens, NONE, type Candidate, type JsonValue, type Selection, type Selector } from '@goodvibes-jev/judgment';
import { attemptItemId } from '../orchestration/attempts.js';
import { emptyWorkItemUsage, type AttemptCandidateDiff, type AttemptJudge, type AttemptJudgeInput, type AttemptJudgeVerdict } from '../orchestration/types.js';
import { bestOfN } from './batteries/best-of-n.js';
import { emptyJudgmentUsage, meteredPort } from './check.js';
import { DIFF_FILE_CAP_CHARS, EVIDENCE_TOKEN_BUDGET, headAndTail, splitUnifiedDiff } from './evidence.js';
import { failureFromError, isAbortError, type ContractRun } from './run-context.js';
import type { AttemptSelectionRecord, ContractFailureKind, ContractUnit, JudgmentUsage } from './types.js';
import { addJudgmentUsage } from './usage.js';

/** The decision site the selection is logged under. */
export const BEST_OF_N_SITE = 'contract.best-of-n';

/** Characters of each candidate's answer, head and tail, before the budget is shared out. */
export const ATTEMPT_ANSWER_CAP_CHARS = 4_000;

// ── Attempt units ─────────────────────────────────────────────────────────────

/** An attempt's criterion id: the plan unit's id prefix swapped for the attempt's. */
function attemptCriterionId(criterionId: string, unitId: string, attemptId: string): string {
  return criterionId.startsWith(`${unitId}.`) ? `${attemptId}${criterionId.slice(unitId.length)}` : `${attemptId}.${criterionId}`;
}

/**
 * One attempt unit per attempt of `unit`, with the ids the engine gives its
 * siblings: the plan unit's goal, brief, files and route, and its criteria
 * unread. Call once the unit has its route.
 */
export function attemptUnitsFor(unit: ContractUnit): ContractUnit[] {
  return Array.from({ length: unit.attempts }, (_, index): ContractUnit => {
    const id = attemptItemId(unit.id, index);
    return {
      id,
      groupId: unit.groupId,
      title: `${unit.title} (attempt ${index + 1}/${unit.attempts})`,
      goal: unit.goal,
      brief: unit.brief,
      role: unit.role,
      dependsOn: [...unit.dependsOn],
      files: [...unit.files],
      attempts: 1,
      criteria: unit.criteria.map((criterion) => ({
        ...structuredClone(criterion),
        id: attemptCriterionId(criterion.id, unit.id, id),
        status: criterion.disposition === 'judged' ? 'unread' : criterion.status,
        readings: [],
      })),
      status: 'pending',
      agentIds: [],
      ...(unit.route === undefined ? {} : { route: unit.route }),
      checks: [],
      nudges: [],
      fixRounds: 0,
      freshAgents: 0,
      transportRetries: 0,
      touchedPaths: [],
      usage: emptyWorkItemUsage(),
      attemptOf: unit.id,
      attemptIndex: index,
    };
  });
}

/** The plan unit takes the chosen attempt's work: its criteria readings, answer and changed paths. */
function adoptAttempt(unit: ContractUnit, attempt: ContractUnit): void {
  unit.criteria.forEach((criterion, index) => {
    const read = attempt.criteria[index];
    if (read === undefined) return;
    criterion.status = read.status;
    criterion.readings = structuredClone(read.readings);
  });
  if (attempt.answer !== undefined) unit.answer = attempt.answer;
  unit.touchedPaths = [...attempt.touchedPaths];
}

// ── Candidates ────────────────────────────────────────────────────────────────

/** What one candidate brings: its id, its diff against its base, and its answer. */
export interface AttemptCandidateSource {
  readonly id: string;
  readonly diff: AttemptCandidateDiff | null;
  readonly answer?: string | undefined;
}

/** The selection context for a unit: its goal and the criteria it is judged on. */
export function unitSelectionContext(unit: Pick<ContractUnit, 'goal' | 'criteria'>): JsonValue {
  return {
    goal: unit.goal,
    criteria: unit.criteria.filter((criterion) => criterion.disposition === 'judged').map((criterion) => ({ id: criterion.id, text: criterion.text })),
  };
}

/** Changes in fill order: the unit's files in their listed order, then the rest smallest first (as unit evidence fills). */
function fillOrder(unifiedDiff: string, files: readonly string[]) {
  const rank = (path: string): number => {
    const index = files.indexOf(path);
    return index === -1 ? files.length : index;
  };
  return splitUnifiedDiff(unifiedDiff).sort((a, b) => rank(a.path) - rank(b.path) || a.diff.length - b.diff.length);
}

type CandidateContent = { [key: string]: JsonValue };

function contentOf(stat: string, diff: string, omitted: readonly string[], answer: string): CandidateContent {
  return { stat, diff, ...(omitted.length === 0 ? {} : { omitted: [...omitted] }), answer };
}

/**
 * The selector's candidates, trimmed so that together with `context` they stay
 * under `budget` estimated tokens and every candidate gets the same share:
 * answers head and tail, then each diff filled file by file into its share,
 * the files that did not fit listed in `omitted`.
 */
export function selectionCandidates(
  context: JsonValue,
  sources: readonly AttemptCandidateSource[],
  files: readonly string[] = [],
  budget = EVIDENCE_TOKEN_BUDGET,
): Candidate[] {
  let answerCap = ATTEMPT_ANSWER_CAP_CHARS;
  const answers = (): string[] => sources.map((source) => headAndTail(source.answer ?? '', answerCap));
  const bare = (): Candidate[] => sources.map((source, index) => ({
    id: source.id,
    content: contentOf(source.diff?.stat ?? '', '', [], answers()[index]!),
  }));
  while (estimateTokens({ context, candidates: bare() }) > budget && answerCap > 200) answerCap = Math.floor(answerCap / 2);
  const share = Math.max(0, Math.floor((budget - estimateTokens({ context, candidates: bare() })) / Math.max(1, sources.length)));
  const trimmedAnswers = answers();
  return sources.map((source, index) => {
    const answer = trimmedAnswers[index]!;
    if (source.diff === null) return { id: source.id, content: contentOf('', '(the diff of this attempt could not be read)', [], answer) };
    const stat = source.diff.stat;
    const included: string[] = [];
    const omitted: string[] = [];
    for (const change of fillOrder(source.diff.unifiedDiff, files)) {
      const section = change.diff.length <= DIFF_FILE_CAP_CHARS
        ? change.diff
        : `${change.diff.slice(0, DIFF_FILE_CAP_CHARS)}\n[... ${change.diff.length - DIFF_FILE_CAP_CHARS} characters of ${change.path} omitted ...]`;
      const withSection = contentOf(stat, [...included, section].join('\n\n'), omitted, answer);
      const bareTokens = estimateTokens(contentOf(stat, '', [], answer));
      if (estimateTokens(withSection) - bareTokens <= share) included.push(section);
      else omitted.push(change.path);
    }
    return { id: source.id, content: contentOf(stat, included.join('\n\n'), omitted, answer) };
  });
}

// ── Reading and wording ───────────────────────────────────────────────────────

/** Reads `contract.best-of-n`, counting the call into `usage`. */
export function readBestOfN(
  context: JsonValue,
  candidates: readonly Candidate[],
  options: { readonly usage: JudgmentUsage; readonly signal?: AbortSignal | undefined; readonly selector?: Selector | undefined },
): Promise<Selection> {
  const selector = options.selector ?? bestOfN;
  const port = meteredPort(judgmentPort(BEST_OF_N_SITE), options.usage);
  return selector.select(port, context, candidates, { site: BEST_OF_N_SITE, ...(options.signal === undefined ? {} : { signal: options.signal }) });
}

const two = (value: number): string => value.toFixed(2);

/** The reasons, in code, from the readings: "chosen u1#a1 with confidence 0.91 (act); fits: u1#a0 no 0.40, u1#a1 yes 0.93". */
export function describeSelection(selection: Pick<Selection, 'chosen' | 'outcome' | 'pick' | 'fits'>): string {
  const fits = Object.entries(selection.fits).map(([id, reading]) => `${id} ${reading.verdict} ${two(reading.probability)}`).join(', ');
  const head = selection.chosen !== undefined
    ? `chosen ${selection.chosen} with confidence ${two(selection.pick.confidence)} (${selection.outcome})`
    : selection.pick.choice === NONE
      ? `none chosen with confidence ${two(selection.pick.confidence)} (${selection.outcome})`
      : `${selection.pick.choice} ranked first with confidence ${two(selection.pick.confidence)} but does not fit (${selection.outcome})`;
  return `${head}; fits: ${fits}`;
}

// ── The engine's judge (fleet.attempts.judge) ─────────────────────────────────

/** What the judge reads beside the candidates' diffs. */
export interface AttemptJudgeContext {
  readonly context: JsonValue;
  /** An attempt's answer, when the caller knows it. */
  readonly answerOf?: ((itemId: string) => string | undefined) | undefined;
  /** Files to fill first in each diff. */
  readonly files?: readonly string[] | undefined;
  /** Where the judge's Jev usage is counted. */
  readonly usage?: JudgmentUsage | undefined;
}

/** A workstream item's context: its task as the goal, with no separate criteria. */
export function taskContext(input: AttemptJudgeInput): AttemptJudgeContext {
  return { context: { goal: input.task, criteria: [] } };
}

/**
 * The engine's `judgeAttempts`: the selector over the group's passing
 * candidates. It proposes a winner only when the selection acts; anything
 * less proposes none, with the reasons naming what was read. Failed
 * candidates are never offered.
 */
export function createSelectAttemptJudge(
  selector: Selector = bestOfN,
  contextOf: (input: AttemptJudgeInput) => AttemptJudgeContext = taskContext,
): AttemptJudge {
  return async (input: AttemptJudgeInput): Promise<AttemptJudgeVerdict> => {
    const held = input.candidates.filter((candidate) => candidate.state === 'held-merge');
    if (held.length === 0) return { winnerItemId: null, reasons: ['no attempt passed; there is nothing to select'] };
    const about = contextOf(input);
    const usage = emptyJudgmentUsage();
    const candidates = selectionCandidates(about.context, held.map((candidate) => ({ id: candidate.itemId, diff: candidate.diff, answer: about.answerOf?.(candidate.itemId) })), about.files);
    let selection: Selection;
    try {
      selection = await readBestOfN(about.context, candidates, { usage, selector });
    } finally {
      if (about.usage !== undefined) addJudgmentUsage(about.usage, usage);
    }
    const winner = selection.outcome === 'act' && selection.chosen !== undefined ? selection.chosen : null;
    selection.recordAction(winner === null ? 'proposed no winner to the operator' : `proposed ${winner} to the operator`);
    return { winnerItemId: winner, reasons: [describeSelection(selection)] };
  };
}

/** The judge a contract's engine is given: the attempts' plan unit as context and the attempts' answers. */
export function createContractAttemptJudge(run: ContractRun, selector: Selector = bestOfN): AttemptJudge {
  return createSelectAttemptJudge(selector, (input) => {
    const first = input.candidates[0] === undefined ? undefined : run.unit(input.candidates[0].itemId);
    const unit = first?.attemptOf === undefined ? undefined : run.unit(first.attemptOf);
    if (unit === undefined) return { ...taskContext(input), usage: run.contract.judgmentUsage };
    return {
      context: unitSelectionContext(unit),
      answerOf: (itemId) => run.unit(itemId)?.answer,
      files: unit.files,
      usage: run.contract.judgmentUsage,
    };
  });
}

// ── The runner's selection ────────────────────────────────────────────────────

/** The R.6 step the runner hands an undecided selection to. */
export interface AttemptSteps {
  /**
   * The selection did not act (a winner at confirm, none, or escalate): open
   * an `attempts-undecided` escalation for the unit naming the proposed
   * winner, if any, and every candidate (6.2, 6.3). The owner's approval or
   * named attempt comes back through `acceptAttempt`.
   */
  attemptsUndecided(run: ContractRun, unitId: string, selection: AttemptSelectionRecord): Promise<void>;
}

export interface AttemptSelectionDeps {
  readonly steps: AttemptSteps;
  readonly failUnit: (run: ContractRun, unit: ContractUnit, kind: ContractFailureKind, reason: string) => void;
  readonly failContract: (run: ContractRun, kind: ContractFailureKind, reason: string) => void;
  readonly selector?: Selector | undefined;
}

/**
 * Takes attempt `attemptId` as unit `unitId`'s work: the engine merges it into
 * the contract branch and cleans the others, and the unit waits in
 * `held-merge` until the merge lands. Throws when `attemptId` is not one of
 * the passing candidates, or an attempt was already taken.
 */
export async function acceptAttempt(run: ContractRun, unitId: string, attemptId: string, reason: string, decisionIds: readonly string[] = []): Promise<void> {
  const unit = run.unit(unitId);
  const selection = unit?.attemptSelection;
  if (unit === undefined || selection === undefined) throw new Error(`unit ${unitId} has no attempt selection to accept`);
  if (selection.pickedId !== undefined) throw new Error(`unit ${unitId} already took attempt ${selection.pickedId}`);
  if (!selection.candidateIds.includes(attemptId)) {
    throw new Error(`${attemptId} is not a passing attempt of unit ${unitId}; the candidates are ${selection.candidateIds.join(', ')}`);
  }
  const attempt = run.unit(attemptId);
  const engine = run.engine;
  if (attempt === undefined || engine === null) throw new Error(`attempt ${attemptId} of unit ${unitId} is not running on this contract's engine`);
  // Everything the merge event reads is in place before the engine starts the merge.
  selection.pickedId = attemptId;
  adoptAttempt(unit, attempt);
  run.moveUnit(unit, 'held-merge');
  const losers = (unit.attemptUnits ?? []).filter((other) => other.id !== attemptId && other.status === 'held-merge');
  for (const loser of losers) run.moveUnit(loser, 'passed');
  const others = losers.length === 0 ? '' : `; not selected: ${losers.map((loser) => loser.id).join(', ')}`;
  run.decide('attempts-selected', unit.id, `${attemptId} taken: ${reason}${others}`, decisionIds);
  await engine.pickAttemptWinner(selection.engineGroupId, attemptId);
}

/**
 * The engine reported every sibling of `engineGroupId` terminal: select among
 * the attempts that passed. No passing attempt fails the unit (and with it the
 * contract), naming why each attempt failed.
 */
export async function selectAttempts(run: ContractRun, engineGroupId: string, deps: AttemptSelectionDeps): Promise<void> {
  const engine = run.engine;
  if (engine === null || run.terminal) return;
  const workstream = engine.listWorkstreams().find((candidate) => candidate.items.some((item) => item.attemptGroupId === engineGroupId));
  const siblingIds = workstream?.items.filter((item) => item.attemptGroupId === engineGroupId).map((item) => item.id) ?? [];
  const attempts = siblingIds.map((id) => run.unit(id)).filter((attempt): attempt is ContractUnit => attempt !== undefined);
  const unitId = attempts[0]?.attemptOf;
  const unit = unitId === undefined ? undefined : run.unit(unitId);
  if (workstream === undefined || unit === undefined) return;
  const passing = attempts.filter((attempt) => attempt.status === 'held-merge' && workstream.items.find((item) => item.id === attempt.id)?.state === 'held-merge');
  if (passing.length === 0) {
    const why = attempts.map((attempt) => `${attempt.id}: ${attempt.failureReason ?? attempt.status}`).join('; ');
    deps.failUnit(run, unit, 'other', `every attempt of unit ${unit.id} failed (${why})`);
    return;
  }
  run.moveUnit(unit, 'checking');
  const usage = emptyJudgmentUsage();
  let selection: Selection;
  const context = unitSelectionContext(unit);
  try {
    const held = (await engine.listHeldMergeGroups(workstream.id)).find((group) => group.groupId === engineGroupId);
    const diffOf = (id: string): AttemptCandidateDiff | null => held?.candidates.find((candidate) => candidate.itemId === id)?.diff ?? null;
    const candidates = selectionCandidates(context, passing.map((attempt) => ({ id: attempt.id, diff: diffOf(attempt.id), answer: attempt.answer })), unit.files);
    selection = await readBestOfN(context, candidates, { usage, signal: run.abort.signal, selector: deps.selector });
  } catch (error) {
    if (run.terminal || isAbortError(error, run.abort.signal)) return;
    const failure = failureFromError(error);
    deps.failContract(run, failure.kind, `the attempts of unit ${unit.id} could not be selected: ${failure.reason}`);
    return;
  } finally {
    addJudgmentUsage(run.contract.judgmentUsage, usage);
  }
  if (run.terminal) {
    selection.recordAction('discarded: the contract already ended');
    return;
  }
  const record: AttemptSelectionRecord = {
    engineGroupId,
    candidateIds: passing.map((attempt) => attempt.id),
    ...(selection.chosen === undefined ? {} : { proposedId: selection.chosen }),
    outcome: selection.outcome,
    reasons: describeSelection(selection),
    ...(selection.decisionId === undefined ? {} : { decisionId: selection.decisionId }),
  };
  unit.attemptSelection = record;
  run.emit({
    type: 'CONTRACT_ATTEMPTS_SELECTED',
    contractId: run.id,
    unitId: unit.id,
    candidateIds: record.candidateIds,
    chosen: selection.chosen ?? null,
    outcome: selection.outcome,
    ...(selection.decisionId === undefined ? {} : { decisionId: selection.decisionId }),
  });
  const decisionIds = selection.decisionId === undefined ? [] : [selection.decisionId];
  try {
    if (selection.outcome === 'act' && selection.chosen !== undefined) {
      selection.recordAction(`picked ${selection.chosen}`);
      await acceptAttempt(run, unit.id, selection.chosen, `selected at act (${record.reasons})`, decisionIds);
      return;
    }
    selection.recordAction('escalated to the owner: attempts undecided');
    await deps.steps.attemptsUndecided(run, unit.id, record);
  } catch (error) {
    if (run.terminal) return;
    const failure = failureFromError(error);
    deps.failContract(run, failure.kind, `the selected attempt of unit ${unit.id} could not be taken: ${failure.reason}`);
  }
}
