/**
 * Owner escalations (docs/design/contract-runner.md section 6.3): the question
 * put to the owner, built in code, and the owner's free-text reply, read with
 * `contract.owner-reply` (the reply pattern) against that question.
 *
 * An escalation moves its target (a unit or a group) and the contract to
 * `awaiting-owner` and releases any hold. What a reply does is code:
 *
 * | Reading at act | unsettled | stalled, fix-rounds-exhausted | plan-unresolved | writing-unclear | attempts-undecided |
 * |---|---|---|---|---|---|
 * | approve | unshown readings accepted as met; the unit passes | refused: approval cannot pass unmet criteria | the plan as shown is accepted | files may change; planning starts | the proposed attempt is taken |
 * | amend | the planner rewrites the target's criteria as instructed; the target is checked again | same | the planner re-plans with the instruction | whether files may change is read from the reply; planning starts | the attempt the reply names is taken |
 * | reject | the contract is cancelled, "stopped by the owner", failure kind owner-rejected | same | same | same | same |
 *
 * Any other reading, or one below act, asks the same question again with one
 * fixed line. Nothing the owner says can pass a criterion that reads unmet.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { Outcome } from '@goodvibes-jev/judgment';
import type { OwnerReplyReading } from '../../events/contract.js';
import { ownerReply } from './batteries/owner-reply.js';
import { readRequestShape, REQUEST_SHAPE_SITE, saysNoAtAct, saysYesAtAct } from './batteries/request-shape.js';
import { acceptAttempt } from './best-of-n.js';
import { emptyJudgmentUsage, meteredPort, type DecidedCheck } from './check.js';
import { amendTarget } from './amendment.js';
import { latestSeverity } from './nudge.js';
import { lastFencedBlock } from './plan-schema.js';
import { acceptEscalatedPlan, planContract, withOwnerWritingDecision } from './planner.js';
import { failureFromError, isAbortError, type ContractRun } from './run-context.js';
import type { StepContext } from './steps.js';
import {
  type AttemptSelectionRecord,
  type Contract,
  type ContractStatus,
  type Criterion,
  type Escalation,
  type EscalationReason,
  type EscalationScope,
} from './types.js';
import { addJudgmentUsage } from './usage.js';

/** The decision site owner replies are logged under. */
export const OWNER_REPLY_SITE = 'contract.owner-reply';

// ── The question (built in code, reviewable here) ─────────────────────────────

/** One fixed sentence per reason. */
export const REASON_SENTENCES: Readonly<Record<EscalationReason, string>> = {
  'plan-unresolved': 'The planner could not resolve these problems within its repair limit.',
  'writing-unclear': 'Your request does not make clear whether the work may change files.',
  stalled: 'The work stopped making progress and the remaining problems need you.',
  unsettled: 'The checks could not confirm some criteria from the evidence, and the agent could not show more.',
  'fix-rounds-exhausted': 'The fix rounds allowed for this work are used up.',
  'attempts-undecided': 'The attempts could not be chosen between with confidence.',
  'owner-decision-needed': 'This needs a decision only you can make.',
};

/** What approval does, per reason, as the question's last line states it. */
const APPROVAL_CLAUSES: Readonly<Record<EscalationReason, string>> = {
  'plan-unresolved': 'accepting the plan as it stands',
  'writing-unclear': 'changing files',
  unsettled: 'accepting the criteria not shown as met',
  stalled: '(approval cannot pass unmet criteria: say what to change instead)',
  'fix-rounds-exhausted': '(approval cannot pass unmet criteria: say what to change instead)',
  'owner-decision-needed': '(approval cannot pass unmet criteria: say what to change instead)',
  'attempts-undecided': 'taking the proposed attempt',
};

/** Said when a reply did not read as approve, change or stop at act. */
export const ASK_AGAIN_LINE = 'I could not tell whether that approves, changes or stops the work.';
/** Said when approval was given for work whose criteria are not met. */
export const APPROVAL_REFUSED_LINE = 'Approval cannot pass work whose criteria are not met: say what to change about what is required, or stop the contract.';
/** Said when an attempt was approved or named but none could be taken from the reply. */
export const NAME_AN_ATTEMPT_LINE = (candidateIds: readonly string[]): string => `Name the attempt to take by its id: ${candidateIds.join(', ')}.`;
/** Said when an approved plan cannot run at all. */
export const PLAN_UNRUNNABLE_LINE = (problems: string): string => `The plan cannot run as it stands (${problems}); change what is required, or stop the contract.`;
/** Said when the owner's change could not be made into criteria. */
export const AMENDMENT_FAILED_LINE = (problems: string): string => `That change could not be applied (${problems}); say it another way, or stop the contract.`;

/** Lines the runner adds under a question it asks again; they are dropped before another is added. */
const ADDED_LINE_PREFIXES = [ASK_AGAIN_LINE, APPROVAL_REFUSED_LINE, 'Name the attempt to take', 'The plan cannot run as it stands', 'That change could not be applied'];

export type OwnerReplyAction = 'approved' | 'amended' | 'stopped' | 'asked-again' | 'refused';

export interface OwnerReplyOutcome {
  readonly escalationId: string;
  readonly reading: OwnerReplyReading;
  readonly outcome: Outcome;
  readonly action: OwnerReplyAction;
  /** The escalation now open when the question was put again. */
  readonly nextEscalationId?: string | undefined;
}

export interface EscalationInput {
  readonly scope: EscalationScope;
  readonly targetId: string;
  readonly reason: EscalationReason;
  readonly unmetCriterionIds: readonly string[];
  readonly unshownCriterionIds?: readonly string[] | undefined;
  readonly decisionIds: readonly string[];
  /** A fixed extra line under the reason sentence (the conflicting files, why a planned fix is not possible). */
  readonly note?: string | undefined;
  /** The whole question, when it was built elsewhere (asking again). */
  readonly question?: string | undefined;
}

function titleOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

/** The criteria a target is judged on. */
export function targetCriteria(contract: Contract, scope: EscalationScope, targetId: string): Criterion[] {
  if (scope === 'unit') return contract.units.flatMap((unit) => [unit, ...(unit.attemptUnits ?? [])]).find((unit) => unit.id === targetId)?.criteria ?? [];
  if (scope === 'group') return contract.groups.find((group) => group.id === targetId)?.criteria ?? [];
  if (scope === 'deliverable') return contract.criteria;
  return [];
}

function subjectOf(contract: Contract, scope: EscalationScope, targetId: string): string {
  if (scope === 'unit') return `unit "${titleOf(contract.units.find((unit) => unit.id === targetId)?.title ?? targetId)}"`;
  if (scope === 'group') return `group "${titleOf(contract.groups.find((group) => group.id === targetId)?.title ?? targetId)}"`;
  if (scope === 'deliverable') return `the deliverable "${titleOf(contract.goal)}"`;
  if (scope === 'plan') return `plan "${titleOf(contract.goal)}"`;
  return `the request "${titleOf(contract.ask)}"`;
}

function criterionLine(criterion: Criterion, withSeverity: boolean): string {
  const severity = withSeverity ? latestSeverity(criterion) : undefined;
  return `- [${criterion.id}] ${criterion.text}${severity === undefined ? '' : ` (${severity})`}`;
}

/** The escalation question (section 6.3's form). */
export function buildEscalationQuestion(contract: Contract, input: EscalationInput): string {
  const criteria = targetCriteria(contract, input.scope, input.targetId);
  const pick = (ids: readonly string[]): Criterion[] => criteria.filter((criterion) => ids.includes(criterion.id));
  const unmet = pick(input.unmetCriterionIds);
  const unshown = pick(input.unshownCriterionIds ?? []);
  return [
    `Contract ${contract.id} needs your decision on ${subjectOf(contract, input.scope, input.targetId)}.`,
    REASON_SENTENCES[input.reason],
    ...(input.note === undefined ? [] : [input.note]),
    ...(unmet.length > 0 ? ['Still not met:', ...unmet.map((criterion) => criterionLine(criterion, true))] : []),
    ...(unshown.length > 0 ? ['Not shown:', ...unshown.map((criterion) => criterionLine(criterion, false))] : []),
    `Reply to approve ${APPROVAL_CLAUSES[input.reason]}, to change what is required (say how), or to stop the contract.`,
  ].join('\n');
}

/** The attempts-undecided question: the proposal, if any, and every candidate with the head of its answer. */
export function buildAttemptsQuestion(contract: Contract, unitId: string, selection: AttemptSelectionRecord): string {
  const unit = contract.units.find((candidate) => candidate.id === unitId);
  const answerOf = (id: string): string => titleOf(unit?.attemptUnits?.find((attempt) => attempt.id === id)?.answer ?? '(no answer recorded)');
  return [
    `Contract ${contract.id} needs your decision on unit "${titleOf(unit?.title ?? unitId)}".`,
    REASON_SENTENCES['attempts-undecided'],
    `Selection: ${selection.reasons}`,
    'Candidates:',
    ...selection.candidateIds.map((id) => `- ${id}${id === selection.proposedId ? ' (proposed)' : ''}: ${answerOf(id)}`),
    selection.proposedId === undefined
      ? 'Reply naming the attempt to take, or to stop the contract.'
      : `Reply to approve taking ${selection.proposedId}, to name another attempt, or to stop the contract.`,
  ].join('\n');
}

/** The question without the lines the runner added when it asked before. */
function baseQuestion(question: string): string {
  const lines = question.split('\n');
  while (lines.length > 0 && ADDED_LINE_PREFIXES.some((prefix) => lines.at(-1)!.startsWith(prefix))) lines.pop();
  return lines.join('\n');
}

// ── Raising and replying ──────────────────────────────────────────────────────

export interface Rejudge {
  /** Checks a group again after its criteria were amended. */
  rejudgeGroup(run: ContractRun, groupId: string): Promise<void>;
  /** Checks the deliverable again after the contract's criteria were amended. */
  rejudgeDeliverable(run: ContractRun): Promise<void>;
}

export interface Escalations {
  /** Opens an escalation: target and contract to awaiting-owner, the question, the event. */
  raise(run: ContractRun, input: EscalationInput): Escalation;
  /** Unsettled readings reached `contract.evidenceNudgeLimit` (4.6): ask the owner to confirm. */
  unitAwaitsOwner(run: ContractRun, unitId: string, check: DecidedCheck): Promise<void>;
  /** The best-of-N selection did not act (6.2): ask the owner which attempt to take. */
  attemptsUndecided(run: ContractRun, unitId: string, selection: AttemptSelectionRecord): Promise<void>;
  reply(run: ContractRun, escalationId: string, text: string): Promise<OwnerReplyOutcome>;
}

/** The contract status each run returns to once its last open escalation is answered. */
const statusBeforeOwner = new WeakMap<ContractRun, ContractStatus>();

export function createEscalations(context: StepContext, rejudge: Rejudge): Escalations {
  function open(run: ContractRun): Escalation[] {
    return run.contract.escalations.filter((escalation) => escalation.resolvedAt === undefined);
  }

  function raise(run: ContractRun, input: EscalationInput): Escalation {
    const { contract } = run;
    const question = input.question ?? buildEscalationQuestion(contract, input);
    const escalation: Escalation = {
      id: `${contract.id}.e${contract.escalations.length + 1}`,
      at: run.env.now(),
      scope: input.scope,
      targetId: input.targetId,
      reason: input.reason,
      question,
      unmetCriterionIds: [...input.unmetCriterionIds],
    };
    if (input.scope === 'unit') {
      const unit = run.unit(input.targetId);
      if (unit !== undefined) {
        run.releaseHold(unit);
        run.moveUnit(unit, 'awaiting-owner');
      }
    } else if (input.scope === 'group') {
      const group = run.group(input.targetId);
      if (group !== undefined) run.moveGroup(group, 'awaiting-owner');
    }
    if (contract.status !== 'awaiting-owner') {
      statusBeforeOwner.set(run, contract.status);
      run.moveContract('awaiting-owner');
    }
    contract.escalations.push(escalation);
    run.decide('escalated', input.targetId, `${input.reason}: asked the owner`, input.decisionIds);
    run.emit({
      type: 'CONTRACT_ESCALATED',
      contractId: contract.id,
      escalationId: escalation.id,
      scope: escalation.scope,
      targetId: escalation.targetId,
      reason: escalation.reason,
      question,
      unmetCriterionIds: escalation.unmetCriterionIds,
    });
    context.ownerProgress(run);
    return escalation;
  }

  /** Back to the status the contract left for the owner, once nothing else waits on them. */
  function resume(run: ContractRun, to?: ContractStatus): void {
    if (open(run).length > 0 || run.contract.status !== 'awaiting-owner') return;
    run.moveContract(to ?? statusBeforeOwner.get(run) ?? 'running');
    statusBeforeOwner.delete(run);
    context.ownerProgress(run);
  }

  async function unitAwaitsOwner(run: ContractRun, unitId: string, check: DecidedCheck): Promise<void> {
    const unit = run.unit(unitId);
    if (unit === undefined || run.terminal) return;
    const unshown = [...check.verdicts].filter(([, verdict]) => verdict === 'unshown').map(([id]) => id);
    check.recordAction('escalated to the owner: unsettled');
    raise(run, { scope: 'unit', targetId: unit.id, reason: 'unsettled', unmetCriterionIds: [], unshownCriterionIds: unshown, decisionIds: check.check.decisionIds });
  }

  async function attemptsUndecided(run: ContractRun, unitId: string, selection: AttemptSelectionRecord): Promise<void> {
    if (run.terminal || run.unit(unitId) === undefined) return;
    raise(run, {
      scope: 'unit',
      targetId: unitId,
      reason: 'attempts-undecided',
      unmetCriterionIds: [],
      decisionIds: selection.decisionId === undefined ? [] : [selection.decisionId],
      question: buildAttemptsQuestion(run.contract, unitId, selection),
    });
  }

  /** Puts the escalation's question again with `line` under it, as a new open escalation. */
  function askAgain(run: ContractRun, escalation: Escalation, line: string): Escalation {
    return raise(run, {
      scope: escalation.scope,
      targetId: escalation.targetId,
      reason: escalation.reason,
      unmetCriterionIds: escalation.unmetCriterionIds,
      decisionIds: [],
      question: `${baseQuestion(escalation.question)}\n${line}`,
    });
  }

  // ── What each reading does ────────────────────────────────────────────────────

  type Handled = { readonly action: OwnerReplyAction; readonly next?: Escalation | undefined };

  async function approveUnsettled(run: ContractRun, escalation: Escalation, decisionId: string | undefined): Promise<Handled> {
    const unit = run.unit(escalation.targetId);
    if (unit === undefined) return { action: 'refused' };
    const judged = unit.criteria.filter((criterion) => criterion.disposition === 'judged');
    // Approval settles readings that did not settle; it never passes one that reads unmet.
    if (judged.some((criterion) => criterion.status === 'unmet')) return { action: 'refused', next: askAgain(run, escalation, APPROVAL_REFUSED_LINE) };
    for (const criterion of judged) {
      if (criterion.status === 'met') continue;
      const last = criterion.readings.at(-1);
      criterion.readings.push({ checkId: escalation.id, at: run.env.now(), probabilityUnmet: last?.probabilityUnmet ?? 0.5, verdict: 'met', outcome: 'confirm', decisionId });
      criterion.status = 'met';
    }
    resume(run);
    context.checks().passUnit(run, unit, unit.answer ?? '', 'passed: the owner confirmed the criteria that were not shown');
    return { action: 'approved' };
  }

  async function approvePlan(run: ContractRun, escalation: Escalation): Promise<Handled> {
    const accepted = await acceptEscalatedPlan(run.contract, escalation, context.plannerDeps(run), { signal: run.abort.signal });
    if (accepted.kind === 'unrunnable') {
      return { action: 'refused', next: askAgain(run, escalation, PLAN_UNRUNNABLE_LINE(accepted.problems.map((problem) => problem.message).join(' '))) };
    }
    await context.continuePlanning(run, accepted.kind === 'failed' || accepted.kind === 'cancelled' ? accepted : { kind: 'accepted', plan: accepted.plan, decisionIds: accepted.decisionIds });
    return { action: 'approved' };
  }

  async function plan(run: ContractRun, input: { readonly ownerInstruction?: string | undefined; readonly previousPlan?: string | undefined } = {}): Promise<void> {
    const outcome = await planContract(run.contract, context.plannerDeps(run), { proposedUnits: run.proposedUnits, signal: run.abort.signal, ...input });
    await context.continuePlanning(run, outcome);
  }

  async function writingDecided(run: ContractRun, forbidsWriting: boolean, how: string, ownerInstruction?: string): Promise<void> {
    const shape = run.contract.shape;
    if (shape === undefined) throw new Error(`contract ${run.id} has no request shape`);
    run.contract.shape = withOwnerWritingDecision(shape, forbidsWriting);
    run.decide('shaped', run.id, `the owner settled writing: files ${forbidsWriting ? 'may not' : 'may'} change (${how})`);
    await plan(run, ownerInstruction === undefined ? {} : { ownerInstruction });
  }

  async function amendWriting(run: ContractRun, escalation: Escalation, text: string): Promise<Handled> {
    const usage = emptyJudgmentUsage();
    const read = await readRequestShape(meteredPort(judgmentPort(REQUEST_SHAPE_SITE), usage), text, { signal: run.abort.signal });
    addJudgmentUsage(run.contract.judgmentUsage, usage);
    const reading = read.shape.forbids_writing;
    if (!saysYesAtAct(reading) && !saysNoAtAct(reading)) return { action: 'asked-again', next: askAgain(run, escalation, ASK_AGAIN_LINE) };
    await writingDecided(run, saysYesAtAct(reading), 'read from the reply', text);
    return { action: 'amended' };
  }

  async function amendWork(run: ContractRun, escalation: Escalation, text: string): Promise<Handled> {
    const amended = await amendTarget(run, escalation, text, context);
    if (amended.kind === 'problems') return { action: 'refused', next: askAgain(run, escalation, AMENDMENT_FAILED_LINE(amended.problems.join(' '))) };
    if (escalation.scope === 'unit') {
      const unit = run.unit(escalation.targetId);
      if (unit === undefined) return { action: 'refused' };
      resume(run);
      await context.checks().runCheck(run, unit, 'owner-amend');
    } else if (escalation.scope === 'group') {
      resume(run);
      await rejudge.rejudgeGroup(run, escalation.targetId);
    } else {
      resume(run, 'judging');
      await rejudge.rejudgeDeliverable(run);
    }
    return { action: 'amended' };
  }

  async function takeAttempt(run: ContractRun, escalation: Escalation, attemptId: string | undefined, how: string, decisionId: string | undefined, action: 'approved' | 'amended'): Promise<Handled> {
    const selection = run.unit(escalation.targetId)?.attemptSelection;
    if (selection === undefined) return { action: 'refused' };
    if (attemptId === undefined) return { action: 'refused', next: askAgain(run, escalation, NAME_AN_ATTEMPT_LINE(selection.candidateIds)) };
    resume(run);
    await acceptAttempt(run, escalation.targetId, attemptId, how, decisionId === undefined ? [] : [decisionId]);
    return { action };
  }

  /** The one candidate a reply names by id; none when it names none or several. */
  function namedAttempt(run: ContractRun, escalation: Escalation, text: string): string | undefined {
    const named = (run.unit(escalation.targetId)?.attemptSelection?.candidateIds ?? []).filter((id) => text.includes(id));
    return named.length === 1 ? named[0] : undefined;
  }

  async function approve(run: ContractRun, escalation: Escalation, decisionId: string | undefined): Promise<Handled> {
    switch (escalation.reason) {
      case 'unsettled':
        return approveUnsettled(run, escalation, decisionId);
      case 'plan-unresolved':
        return approvePlan(run, escalation);
      case 'writing-unclear':
        await writingDecided(run, false, 'approved by the owner');
        return { action: 'approved' };
      case 'attempts-undecided': {
        const proposed = run.unit(escalation.targetId)?.attemptSelection?.proposedId;
        return takeAttempt(run, escalation, proposed, 'the owner approved the proposed attempt', decisionId, 'approved');
      }
      case 'stalled':
      case 'fix-rounds-exhausted':
      case 'owner-decision-needed':
        return { action: 'refused', next: askAgain(run, escalation, APPROVAL_REFUSED_LINE) };
    }
  }

  async function amend(run: ContractRun, escalation: Escalation, text: string, decisionId: string | undefined): Promise<Handled> {
    switch (escalation.reason) {
      case 'plan-unresolved':
        await plan(run, { ownerInstruction: text, previousPlan: lastFencedBlock(escalation.question) });
        return { action: 'amended' };
      case 'writing-unclear':
        return amendWriting(run, escalation, text);
      case 'attempts-undecided':
        return takeAttempt(run, escalation, namedAttempt(run, escalation, text), 'the owner named this attempt', decisionId, 'amended');
      case 'unsettled':
      case 'stalled':
      case 'fix-rounds-exhausted':
      case 'owner-decision-needed':
        return amendWork(run, escalation, text);
    }
  }

  async function reply(run: ContractRun, escalationId: string, text: string): Promise<OwnerReplyOutcome> {
    const escalation = run.contract.escalations.find((candidate) => candidate.id === escalationId);
    if (escalation === undefined || escalation.resolvedAt !== undefined) throw new Error(`contract ${run.id} has no open escalation ${escalationId}`);
    const usage = emptyJudgmentUsage();
    let read: Awaited<ReturnType<typeof ownerReply.read>>;
    try {
      read = await ownerReply.read(
        meteredPort(judgmentPort(OWNER_REPLY_SITE), usage),
        { reason: escalation.reason, question: escalation.question },
        text,
        { site: OWNER_REPLY_SITE, signal: run.abort.signal },
      );
    } catch (error) {
      if (!run.terminal && !isAbortError(error, run.abort.signal)) {
        const failure = failureFromError(error);
        run.control.fail(failure.kind, `the owner's reply to ${escalation.id} could not be read: ${failure.reason}`);
      }
      throw error;
    } finally {
      addJudgmentUsage(run.contract.judgmentUsage, usage);
    }
    const { choice, outcome } = read.reading;
    const reading = choice as OwnerReplyReading;
    escalation.reply = { text, reading, outcome, decisionId: read.decisionId };
    escalation.resolvedAt = run.env.now();
    const decisionIds = read.decisionId === undefined ? [] : [read.decisionId];

    const replied = (action: OwnerReplyAction): void => {
      read.recordAction(action);
      run.decide('owner-replied', escalation.targetId, `${escalation.id}: ${reading} (${outcome}), ${action}`, decisionIds);
      run.emit({ type: 'CONTRACT_OWNER_REPLIED', contractId: run.id, escalationId: escalation.id, reading, outcome, action });
    };

    let handled: Handled;
    if (outcome !== 'act' || reading === 'unclear') {
      handled = { action: 'asked-again', next: askAgain(run, escalation, ASK_AGAIN_LINE) };
      replied(handled.action);
    } else if (reading === 'reject') {
      handled = { action: 'stopped' };
      replied(handled.action);
      run.contract.failureKind = 'owner-rejected';
      run.control.cancel('stopped by the owner');
    } else {
      handled = reading === 'approve' ? await approve(run, escalation, read.decisionId) : await amend(run, escalation, text, read.decisionId);
      replied(handled.action);
    }
    return {
      escalationId: escalation.id,
      reading,
      outcome,
      action: handled.action,
      ...(handled.next === undefined ? {} : { nextEscalationId: handled.next.id }),
    };
  }

  return { raise, unitAwaitsOwner, attemptsUndecided, reply };
}

/** Criteria of a target that read unmet, and those that read unshown, by id. */
export function standingCriteria(criteria: readonly Criterion[]): { readonly unmet: string[]; readonly unshown: string[] } {
  const judged = criteria.filter((criterion) => criterion.disposition === 'judged');
  return {
    unmet: judged.filter((criterion) => criterion.status === 'unmet').map((criterion) => criterion.id),
    unshown: judged.filter((criterion) => criterion.status === 'unshown' || criterion.status === 'unread').map((criterion) => criterion.id),
  };
}
