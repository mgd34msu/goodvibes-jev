/**
 * Groups, the deliverable, and finishing (docs/design/contract-runner.md
 * sections 6.4 and 6.5).
 *
 * - Group check: when every unit of a group passed (and merged), Jev judges the
 *   group (`contract.group-judge`) against its criteria: its goal, its units'
 *   answers, the group's diff since it started, gates run in the contract's
 *   tree, and each unit's verdicts. A group with no criteria, or a fix group,
 *   passes without one. Pass at act passes the group; anything else goes to
 *   correction.
 * - Deliverable check: when every group passed, Jev judges the deliverable
 *   (`contract.deliverable-judge`) against the judged contract criteria: the
 *   deliverable unit's whole final output and the answers of any units that
 *   fixed the deliverable, the contract's diff, gates, and the unit verdicts
 *   behind each criterion. Pass at act commits; anything else goes to
 *   correction. A plan whose every criterion is excluded or met by structure
 *   has none of the user's words left to judge (the judge pattern needs at
 *   least one criterion), so it commits without a deliverable check.
 * - Commit: worktree mode merges the contract branch into the project's branch
 *   (no fast-forward) or applies it as uncommitted changes; shared mode commits
 *   exactly the touched paths (or everything, or nothing, by
 *   `contract.commitScope`). A commit that fails is a warning on a passing
 *   contract, never a failure. Outside git the commit is skipped with a note.
 * - The answer goes to the owner record; the status line to the operator
 *   audience only.
 *
 * Verdicts, gates and the commit are code; only the two judges are Jev.
 */
import { assertContractInputOwner, assertContractInputObjects, assertContractExecutionView } from './input-snapshot.js';
import { applyCapturedInputDelta } from './input-apply.js';

import { spawnSync } from 'node:child_process';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { hashState, type JsonValue } from '@goodvibes-jev/judgment';
import { AgentWorktree, IsolatedWorktree } from '../agents/worktree.js';
import { excludeUntouchedLaunchResidue } from '../orchestration/dirty-guard.js';
import { GitService } from '../git/service.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { deliverableOutput, describeCommitOutcome, describeContractOutcome, renderContractAnswer, CONTRACT_PASSED_WITHOUT_OUTPUT } from './answer.js';
import { DELIVERABLE_JUDGES } from './batteries/deliverable-judge.js';
import { GROUP_JUDGES } from './batteries/group-judge.js';
import { criterionVerdict, emptyJudgmentUsage, meteredPort } from './check.js';
import { readContractConfig } from './config.js';
import { guarded, type Correction } from './correction.js';
import { nativeContractPort } from './native-decisions.js';
import { assertNativeContractSource } from './native-source.js';
import { collectChanges, judgeEvidence, trimEvidence, type ContractTurnRecord } from './evidence.js';
import { failedGates, runContractGates } from './gates.js';
import type { ContractRun } from './run-context.js';
import type { StepContext } from './steps.js';
import type { CheckTrigger, Contract, Criterion, CriterionReading, CriterionVerdict, NudgeKind, TreeBaseline, UnitCheck } from './types.js';
import { addJudgmentUsage } from './usage.js';

/** Decision sites, as the decision log records them. */
export const COMPLETION_SITES = {
  group: 'contract.check.group-judge',
  deliverable: 'contract.check.deliverable-judge',
} as const;

export interface Completion {
  groupUnitsPassed(run: ContractRun, groupId: string): Promise<void>;
  groupsPassed(run: ContractRun): Promise<void>;
  /** Judges a group now (after its units passed, a fix, or an amendment). */
  judgeGroup(run: ContractRun, groupId: string, trigger: CheckTrigger): Promise<void>;
  /** Judges the deliverable now. */
  judgeDeliverable(run: ContractRun, trigger: CheckTrigger): Promise<void>;
  /** Commits the passed deliverable and passes the contract: the step a contract was on when a restart stopped it in `committing` (design 7.2). */
  commitDeliverable(run: ContractRun): Promise<void>;
}

/** The tree the contract's work sits in: the contract worktree, or the project root. */
export function contractTree(contract: Pick<Contract, 'worktreePath' | 'projectRoot'>): string {
  return contract.worktreePath ?? contract.projectRoot;
}

function judged(criteria: readonly Criterion[]): Criterion[] {
  return criteria.filter((criterion) => criterion.disposition === 'judged');
}

/** What one group or deliverable check read, folded in code. */
interface TargetReading {
  readonly check: UnitCheck;
  readonly verdicts: ReadonlyMap<string, CriterionVerdict>;
  readonly passed: boolean;
  readonly output: string;
}

function git(cwd: string, args: readonly string[]): { readonly ok: boolean; readonly out: string; readonly err: string } {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() || (result.error?.message ?? '') };
}

/** The commit message: the goal, the criteria met, gates passed, the units, and what was excluded. */
export function buildContractCommitMessage(contract: Contract): string {
  const firstLine = contract.goal.replace(/\s+/g, ' ').trim();
  const subject = firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69)}...`;
  const judgedCriteria = judged(contract.criteria);
  const gates = (contract.checks.at(-1)?.gates ?? []).filter((gate) => gate.passed && gate.skipped !== true).map((gate) => gate.gate);
  const excluded = contract.criteria.filter((criterion) => criterion.disposition !== 'judged');
  return [
    subject,
    '',
    `Contract ${contract.id}`,
    'Criteria met:',
    ...judgedCriteria.map((criterion) => `- [${criterion.id}] ${criterion.text}`),
    ...(gates.length > 0 ? [`Gates passed: ${gates.join(', ')}`] : []),
    'Units:',
    ...contract.units.map((unit) => `- ${unit.id} ${unit.title}`),
    ...(excluded.length > 0 ? ['Not judged:', ...excluded.map((criterion) => `- [${criterion.id}] ${criterion.text} (${criterion.dispositionReason ?? criterion.disposition})`)] : []),
  ].join('\n');
}

export function createCompletion(context: StepContext, correction: Pick<Correction, 'groupFailed' | 'deliverableFailed'>): Completion {
  const config = () => readContractConfig(context.configManager);

  /** Every turn the given units' agents reported: evidence outside git. */
  function turnsOf(run: ContractRun, unitIds: ReadonlySet<string>): ContractTurnRecord[] {
    return [...unitIds].flatMap((id) => run.unitRuntimes.get(id)?.turns ?? []);
  }

  /**
   * Reads one group or deliverable check: the diff of `paths` since
   * `baseline`, gates in the contract's tree, and the judge. The criteria get
   * their readings and the check is recorded on `checks`.
   */
  async function readTarget(run: ContractRun, input: {
    readonly scope: 'group' | 'deliverable';
    readonly targetId: string;
    readonly goal: string;
    readonly criteria: Criterion[];
    readonly checks: UnitCheck[];
    readonly baseline: TreeBaseline | undefined;
    readonly unitIds: ReadonlySet<string>;
    readonly output: string;
    readonly summaries: JsonValue;
    readonly trigger: CheckTrigger;
  }): Promise<TargetReading | null> {
    const { contract } = run;
    const tree = contractTree(contract);
    const paths = new Set(contract.units.filter((unit) => input.unitIds.has(unit.id)).flatMap((unit) => unit.touchedPaths));
    const changes = (await collectChanges({ baseline: input.baseline }, { cwd: tree, turns: turnsOf(run, input.unitIds) })).filter((change) => paths.has(change.path));
    const gates = await runContractGates({ configManager: context.configManager, cwd: tree, runtimeBus: context.runtimeBus, sessionId: contract.sessionId, contractId: contract.id, targetId: input.targetId });
    if (run.terminal) return null;
    const evidence = trimEvidence({ output: input.output, changes, gates, commands: [] }, { goal: input.goal, brief: '', files: [] });
    const digest = hashState({ goal: input.goal, output: evidence.output, evidence: judgeEvidence(evidence), ...(contract.nativeSource === undefined ? {} : { nativeSource: { ...contract.nativeSource, criteria: [...contract.nativeSource.criteria] } }) });
    const prior = input.checks.at(-1);
    if (contract.nativeSource !== undefined && prior !== undefined && prior.result !== 'pass' && prior.evidenceDigest === digest) {
      return { check: prior, verdicts: new Map(input.criteria.filter(criterion => criterion.disposition === 'judged').map(criterion => [criterion.id, criterion.status === 'unread' ? 'unshown' : criterion.status])), passed: false, output: evidence.output };
    }
    const judgedCriteria = judged(input.criteria);
    const usage = emptyJudgmentUsage();
    const site = input.scope === 'group' ? COMPLETION_SITES.group : COMPLETION_SITES.deliverable;
    const judges = input.scope === 'group' ? GROUP_JUDGES : DELIVERABLE_JUDGES;
    let judgment: Awaited<ReturnType<(typeof judges)['high']['judge']>>;
    try {
      judgment = await judges[config().acceptanceStakes].judge(
        meteredPort(nativeContractPort(contract, context.native, judgmentPort(site), run.abort.signal), usage),
        { goal: input.goal, criteria: judgedCriteria.map((criterion) => criterion.text), output: evidence.output, evidence: { ...(judgeEvidence(evidence) as Record<string, JsonValue>), ...(contract.nativeSource === undefined ? {} : { nativeSource: { ...contract.nativeSource, criteria: [...contract.nativeSource.criteria] } }), [input.scope === 'group' ? 'units' : 'criteria']: input.summaries } },
        { site, signal: run.abort.signal },
      );
    } finally {
      addJudgmentUsage(contract.judgmentUsage, usage);
    }
    if (run.terminal) {
      judgment.recordAction('discarded: the contract already ended');
      return null;
    }
    const checkId = `${input.targetId}.k${input.checks.length + 1}`;
    const now = run.env.now();
    const verdicts = new Map(judgedCriteria.map((criterion, index) => [criterion.id, criterionVerdict(judgment.criteria[index]!)]));
    const goalVerdict = criterionVerdict(judgment.goal);
    const failing = failedGates(evidence.gates);
    judgedCriteria.forEach((criterion, index) => {
      const reading = judgment.criteria[index]!;
      const recorded: CriterionReading = { checkId, at: now, probabilityUnmet: reading.probability, verdict: verdicts.get(criterion.id)!, outcome: reading.outcome, decisionId: judgment.decisionId };
      criterion.readings.push(recorded);
      criterion.status = recorded.verdict;
    });
    const verdictList = [...verdicts.values()];
    const problems: NudgeKind[] = [
      ...(verdictList.includes('unmet') || goalVerdict === 'unmet' ? ['unmet' as const] : []),
      ...(verdictList.includes('unshown') || goalVerdict === 'unshown' ? ['unshown' as const] : []),
      ...(failing.length > 0 ? ['gate' as const] : []),
    ];
    const passed = problems.length === 0;
    const check: UnitCheck = {
      id: checkId,
      at: now,
      trigger: input.trigger,
      ...(evidence.gates === undefined ? {} : { gates: evidence.gates }),
      goal: { probabilityUnmet: judgment.goal.probability, verdict: goalVerdict, outcome: judgment.goal.outcome },
      quality: {},
      // A check that does not pass is handed to correction: a planned fix or the owner.
      result: passed ? 'pass' : 'stall',
      problems,
      qualityProblems: [],
      decisionIds: judgment.decisionId === undefined ? [] : [judgment.decisionId],
      evidenceDigest: digest,
    };
    input.checks.push(check);
    judgment.recordAction(`${input.scope} check ${checkId}: ${passed ? 'pass' : 'to correction'}`);
    run.decide('checked', input.targetId, `check ${checkId} (${input.trigger}): ${passed ? 'pass' : problems.join(', ')}`, check.decisionIds);
    run.emit({
      type: 'CONTRACT_CHECKED',
      contractId: contract.id,
      scope: input.scope,
      targetId: input.targetId,
      checkId,
      trigger: input.trigger,
      result: check.result,
      criteria: judgedCriteria.map((criterion, index) => ({ criterionId: criterion.id, verdict: verdicts.get(criterion.id)!, probabilityUnmet: judgment.criteria[index]!.probability, outcome: judgment.criteria[index]!.outcome })),
      goal: { verdict: goalVerdict, outcome: judgment.goal.outcome },
      quality: [],
      gates: (evidence.gates ?? []).map((gate) => ({ gate: gate.gate, passed: gate.passed, skipped: gate.skipped === true })),
      decisionIds: check.decisionIds,
    });
    return { check, verdicts, passed, output: evidence.output };
  }

  function finding(reading: TargetReading): Parameters<Correction['groupFailed']>[2] {
    return {
      unmet: [...reading.verdicts].filter(([, verdict]) => verdict === 'unmet').map(([id]) => id),
      unshown: [...reading.verdicts].filter(([, verdict]) => verdict === 'unshown').map(([id]) => id),
      gates: reading.check.gates,
      output: reading.output,
      decisionIds: reading.check.decisionIds,
    };
  }

  // ── Groups ────────────────────────────────────────────────────────────────────

  async function judgeGroup(run: ContractRun, groupId: string, trigger: CheckTrigger): Promise<void> {
    const group = run.group(groupId);
    if (group === undefined || run.terminal) return;
    run.moveGroup(group, 'judging');
    const own = run.contract.units.filter((unit) => unit.groupId === group.id);
    // The group's files are its units' and those of every fix for the group or for one of its units.
    const repaired = new Set([group.id, ...own.map((unit) => unit.id)]);
    const fixes = run.contract.units.filter((unit) => repaired.has(run.group(unit.groupId)?.repairs?.targetId ?? ''));
    const unitIds = new Set([...own, ...fixes].map((unit) => unit.id));
    const reading = await readTarget(run, {
      scope: 'group',
      targetId: group.id,
      goal: group.goal,
      criteria: group.criteria,
      checks: group.checks,
      baseline: group.baseline,
      unitIds,
      output: own.map((unit) => `${unit.id} "${unit.title}": ${unit.answer?.trim() || '(no answer recorded)'}`).join('\n'),
      summaries: own.map((unit) => ({
        id: unit.id,
        title: unit.title,
        criteria: judged(unit.criteria).map((criterion) => ({ id: criterion.id, text: criterion.text, verdict: criterion.status })),
      })),
      trigger,
    });
    if (reading === null) return;
    if (reading.passed) {
      run.control.passGroup(group.id);
      return;
    }
    await correction.groupFailed(run, group.id, finding(reading));
  }

  async function groupUnitsPassed(run: ContractRun, groupId: string): Promise<void> {
    const group = run.group(groupId);
    if (group === undefined || run.terminal) return;
    // A fix group's own check is its target's re-check; a group with no criteria has nothing to judge.
    if (group.kind === 'fix' || judged(group.criteria).length === 0) {
      run.control.passGroup(group.id);
      return;
    }
    await judgeGroup(run, group.id, 'completion');
  }

  // ── The deliverable ───────────────────────────────────────────────────────────

  async function judgeDeliverable(run: ContractRun, trigger: CheckTrigger): Promise<void> {
    const { contract } = run;
    if (run.terminal) return;
    assertNativeContractSource(contract);
    if (contract.status !== 'judging') run.moveContract('judging');
    context.ownerProgress(run);
    const judgedCriteria = judged(contract.criteria);
    if (judgedCriteria.length > 0) {
      const reading = await readTarget(run, {
        scope: 'deliverable',
        targetId: contract.id,
        goal: contract.goal,
        criteria: contract.criteria,
        checks: contract.checks,
        baseline: contract.baseline,
        unitIds: new Set(contract.units.map((unit) => unit.id)),
        output: deliverableOutput(contract),
        summaries: judgedCriteria.map((criterion) => ({
          criterion: criterion.id,
          servedBy: contract.units.flatMap((unit) => unit.criteria).filter((served) => served.serves.includes(criterion.id)).map((served) => ({ id: served.id, text: served.text, verdict: served.status })),
        })),
        trigger,
      });
      if (reading === null) return;
      if (!reading.passed) {
        await correction.deliverableFailed(run, finding(reading));
        return;
      }
    }
    await commitDeliverable(run);
  }

  async function commitDeliverable(run: ContractRun): Promise<void> {
    const { contract } = run;
    if (run.terminal) return;
    const answer = renderContractAnswer(contract);
    run.moveContract('committing');
    context.ownerProgress(run);
    const commit = await commitContract(run);
    if (run.terminal) return;
    contract.commit = commit;
    run.decide('committed', contract.id, commit.note);
    run.emit({ type: 'CONTRACT_COMMITTED', contractId: contract.id, status: commit.status, ...(commit.hash === undefined ? {} : { hash: commit.hash }), note: commit.note });
    run.control.finishPassed({ answer: answer.length > 0 ? answer : CONTRACT_PASSED_WITHOUT_OUTPUT, statusLine: describeContractOutcome(contract) });
  }

  async function groupsPassed(run: ContractRun): Promise<void> {
    if (run.terminal) return;
    await judgeDeliverable(run, run.contract.fixRounds > 0 ? 'fix-passed' : 'completion');
  }

  // ── The commit (6.5) ──────────────────────────────────────────────────────────

  async function commitWorktree(run: ContractRun, commitOn: boolean): Promise<NonNullable<Contract['commit']>> {
    const { contract } = run;
    const root = contract.projectRoot;
    const branch = contract.branch!;
    if (contract.inputSnapshot === undefined) return { status: 'failed', note: `not applied: legacy contract has no recorded input receipt; the work stays on branch ${branch}` };
    try {
      assertContractInputObjects(contract.inputSnapshot, contract.projectRoot);
      assertContractExecutionView(contract.inputSnapshot, contract.worktreePath!, branch);
      await assertContractInputOwner(contract.inputSnapshot, run.abort.signal);
    }
    catch (error) { return { status: 'failed', note: `not applied: ${summarizeError(error)}; the work stays on branch ${branch}` }; }
    if (contract.inputSnapshot.dirty) {
      try {
        const files = await applyCapturedInputDelta(contract, context.plannerDeps(run).readAccessFilter, run.abort.signal);
        if (files === 0) return { status: 'skipped', note: 'commit skipped: the contract changed no files; owner changes preserved' };
        return { status: 'applied', note: `applied ${files} file${files === 1 ? '' : 's'} as uncommitted changes; pre-existing owner edits and staging preserved${commitOn ? '; automatic commit deferred for the dirty input baseline' : ''}` };
      } catch (error) {
        return { status: 'failed', note: `not applied: ${summarizeError(error)}; the work stays on branch ${branch}` };
      }
    }
    const changed = git(root, ['diff', '--name-only', `HEAD...${branch}`]);
    const files = changed.ok ? changed.out.split('\n').filter(Boolean) : [];
    if (changed.ok && files.length === 0) return { status: 'skipped', note: describeCommitOutcome(null, [], true) };
    if (commitOn) {
      const merged = git(root, ['merge', '--no-ff', '-m', buildContractCommitMessage(contract), branch]);
      if (!merged.ok) {
        return { status: 'failed', note: `commit failed: ${merged.err || 'git merge did not complete'}; inspect owner Git state before retrying; the work stays on branch ${branch}` };
      }
      const head = git(root, ['rev-parse', 'HEAD']).out;
      return { status: 'committed', hash: head, note: describeCommitOutcome(head, [], false) };
    }
    const squashed = git(root, ['merge', '--squash', branch]);
    if (!squashed.ok) {
      return { status: 'failed', note: `apply failed: ${squashed.err || 'git merge --squash did not complete'}; inspect owner Git state before retrying; the work stays on branch ${branch}` };
    }
    // Unstage exactly what the squash staged: the work is left as uncommitted changes.
    git(root, ['reset', '-q', '--', ...files]);
    return { status: 'applied', note: `applied ${files.length} file${files.length === 1 ? '' : 's'} as uncommitted changes` };
  }

  async function commitShared(contract: Contract, scope: 'scoped' | 'all'): Promise<NonNullable<Contract['commit']>> {
    const root = contract.projectRoot;
    const worktree = new AgentWorktree(root);
    const message = buildContractCommitMessage(contract);
    if (scope === 'all') {
      const result = await worktree.commitWorkingTree(message);
      return result.hash === null
        ? { status: 'skipped', note: describeCommitOutcome(null, result.skippedIgnored, false) }
        : { status: 'committed', hash: result.hash, note: describeCommitOutcome(result.hash, result.skippedIgnored, false) };
    }
    const touched = [...new Set(contract.units.flatMap((unit) => unit.touchedPaths))];
    const launch = new Map(Object.entries(contract.baseline?.dirty ?? {}));
    const { included } = excludeUntouchedLaunchResidue(root, touched, launch);
    if (included.length === 0) return { status: 'skipped', note: describeCommitOutcome(null, [], true) };
    const result = await worktree.commitWorkingTree(message, [...included]);
    return result.hash === null
      ? { status: 'skipped', note: describeCommitOutcome(null, result.skippedIgnored, false) }
      : { status: 'committed', hash: result.hash, note: describeCommitOutcome(result.hash, result.skippedIgnored, false) };
  }

  /** Commits or applies the contract's work. Any failure is recorded as a warning; the contract still passes. */
  async function commitContract(run: ContractRun): Promise<NonNullable<Contract['commit']>> {
    const { contract } = run;
    if (!GitService.isGitRepo(contract.projectRoot)) return { status: 'skipped', note: 'commit skipped: not a git repository' };
    const settings = config();
    const commitOn = settings.autoCommit && settings.commitScope !== 'off';
    try {
      if (contract.isolation === 'worktree' && contract.branch !== undefined && contract.worktreePath !== undefined) {
        const outcome = await commitWorktree(run, commitOn);
        if (outcome.status === 'committed' || outcome.status === 'applied' || outcome.status === 'skipped') {
          // The branch's work reached the project's tree: the contract worktree goes; the branch stays as the record of the work.
          await new IsolatedWorktree(contract.projectRoot, contract.worktreePath, contract.branch, contract.baseBranch ?? 'main').evict()
            .catch((error: unknown) => logger.warn('contract runner: the contract worktree was not removed', { contractId: contract.id, error: summarizeError(error) }));
        }
        return outcome;
      }
      if (!commitOn) return { status: 'skipped', note: 'commit off: the changes are left in the working tree' };
      return await commitShared(contract, settings.commitScope === 'all' ? 'all' : 'scoped');
    } catch (error) {
      const where = contract.branch === undefined ? 'the changes are left in the working tree' : `the work stays on branch ${contract.branch}`;
      return { status: 'failed', note: `commit failed: ${summarizeError(error)}; ${where}` };
    }
  }

  return {
    groupUnitsPassed: (run, groupId) => guarded(run, `group ${groupId} could not be judged`, () => groupUnitsPassed(run, groupId)),
    groupsPassed: (run) => guarded(run, 'the deliverable could not be judged', () => groupsPassed(run)),
    judgeGroup: (run, groupId, trigger) => guarded(run, `group ${groupId} could not be judged`, () => judgeGroup(run, groupId, trigger)),
    judgeDeliverable: (run, trigger) => guarded(run, 'the deliverable could not be judged', () => judgeDeliverable(run, trigger)),
    commitDeliverable: (run) => guarded(run, 'the deliverable could not be committed', () => commitDeliverable(run)),
  };
}

