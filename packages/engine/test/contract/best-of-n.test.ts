/**
 * Best-of-N by candidate selection (docs/design/contract-runner.md section
 * 6.2), end to end on the contract runner in worktree mode with the fake
 * judgment port and a scripted executor: every attempt runs its own nudge
 * loop; a selection at act picks an attempt and the unit passes with it once
 * it merged; confirm and none go to the owner step; failed attempts are never
 * candidates; and the operator verb `fleet.attempts.judge` returns the
 * selection. Candidate trimming and the reasons wording are code, tested here
 * too.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import {
  EVIDENCE_TOKEN_BUDGET,
  acceptAttempt,
  createSelectAttemptJudge,
  describeSelection,
  selectionCandidates,
  type AttemptSelectionRecord,
} from '../../sdk/src/platform/contract/index.js';
import { estimateTokens } from '@goodvibes-jev/judgment';
import { GatewayMethodCatalog } from '../../sdk/src/platform/control-plane/method-catalog.ts';
import { createFleetAttemptsJudgeHandler, type FleetAttemptsController } from '../../sdk/src/platform/control-plane/routes/fleet.ts';
import { createAttemptsCoordinator, emptyWorkItemUsage, type WorkItem, type WorkItemSpec, type Workstream } from '../../sdk/src/platform/orchestration/index.js';
import type { AnswerContext } from './plan-support.js';
import { eventsOf, makeHarness, oneUnitPlan, startContract, waitFor, type AgentScript, type Harness } from './runner-support.js';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function use(h: Harness): Harness {
  harness = h;
  return h;
}

const terminal = (h: Harness, contractId: string): boolean => {
  const status = h.store.get(contractId)?.status;
  return status === 'passed' || status === 'failed' || status === 'cancelled';
};

/** An attempt that writes src/csv.ts with `text` and finishes. */
const writes = (text: string): AgentScript => () => [{ files: { 'src/csv.ts': text }, text: `parser written: ${text.trim()}` }];

interface SelectionScript {
  readonly pick: string;
  readonly confidence: number;
  readonly fits: Readonly<Record<string, number>>;
}

/** The selection's answers, and every set of candidate ids it was offered. */
function selectionPort(script: SelectionScript, offered: string[][]) {
  return (context: AnswerContext): unknown => {
    const candidates = context.state['candidates'] as { id: string }[] | undefined;
    if (candidates === undefined) return undefined;
    if (context.name === 'pick') {
      offered.push(candidates.map((candidate) => candidate.id));
      return choiceAnswer(context.question, script.pick, script.confidence);
    }
    const fit = /^fits_(\d+)$/.exec(context.name);
    if (fit !== null) return noulAnswer(script.fits[candidates[Number(fit[1])]!.id] ?? 0.05);
    return undefined;
  };
}

function git(cwd: string, ...args: string[]): string {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).stdout;
}

describe('best-of-N on the contract runner', () => {
  test('a selection at act picks an attempt; the unit passes with its work once it merged, and the other attempt is not selected', async () => {
    const offered: string[][] = [];
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto', defaultAttempts: 2 },
      scripts: { 'u1#a0': writes('export const parse = 0;\n'), 'u1#a1': writes('export const parse = 1;\n') },
      port: selectionPort({ pick: 'u1#a1', confidence: 0.95, fits: { 'u1#a1': 0.96, 'u1#a0': 0.3 } }, offered),
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 20_000);
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    const unit = done.units[0]!;
    expect(unit.status).toBe('passed');
    expect(unit.attemptUnits?.map((attempt) => [attempt.id, attempt.status])).toEqual([['u1#a0', 'passed'], ['u1#a1', 'passed']]);
    // Each attempt ran its own checks with its own agent.
    expect(unit.attemptUnits?.every((attempt) => attempt.checks.length > 0 && attempt.agentIds.length === 1)).toBe(true);
    expect(unit.agentIds.sort()).toEqual(unit.attemptUnits!.flatMap((attempt) => attempt.agentIds).sort());
    expect(unit.attemptSelection).toMatchObject({ candidateIds: ['u1#a0', 'u1#a1'], proposedId: 'u1#a1', outcome: 'act', pickedId: 'u1#a1' });
    expect(unit.criteria.every((criterion) => criterion.status === 'met')).toBe(true);
    expect(unit.answer).toBe('parser written: export const parse = 1;');
    expect(offered).toEqual([['u1#a0', 'u1#a1']]);
    const selected = eventsOf(h, 'CONTRACT_ATTEMPTS_SELECTED');
    expect(selected.map((event) => [event.unitId, event.chosen, event.outcome])).toEqual([['u1', 'u1#a1', 'act']]);
    const decision = done.decisions.find((entry) => entry.action === 'attempts-selected');
    expect(decision?.reason).toContain('u1#a1 taken: selected at act (chosen u1#a1 with confidence 0.95 (act); fits: u1#a0 no 0.30, u1#a1 yes 0.96); not selected: u1#a0');
    expect(git(h.root, 'show', `${done.branch!}:src/csv.ts`)).toBe('export const parse = 1;\n');
  });

  test('a winner at confirm goes to the owner step naming it; the owner taking it passes the unit', async () => {
    const undecided: AttemptSelectionRecord[] = [];
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto', defaultAttempts: 2 },
      scripts: { 'u1#a0': writes('export const parse = 0;\n'), 'u1#a1': writes('export const parse = 1;\n') },
      port: selectionPort({ pick: 'u1#a0', confidence: 0.75, fits: { 'u1#a0': 0.95 } }, []),
      steps: {
        attemptsUndecided: async (run, unitId, record) => {
          undecided.push(record);
          await acceptAttempt(run, unitId, record.proposedId!, 'the owner approved the proposed attempt');
        },
      },
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 20_000);
    expect(undecided).toHaveLength(1);
    expect(undecided[0]).toMatchObject({ candidateIds: ['u1#a0', 'u1#a1'], proposedId: 'u1#a0', outcome: 'confirm' });
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    expect(done.units[0]!.attemptSelection?.pickedId).toBe('u1#a0');
    expect(git(h.root, 'show', `${done.branch!}:src/csv.ts`)).toBe('export const parse = 0;\n');
  });

  test('none goes to the owner step with every candidate and no proposal, and nothing is merged', async () => {
    const undecided: { unitId: string; record: AttemptSelectionRecord }[] = [];
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto', defaultAttempts: 2 },
      scripts: { 'u1#a0': writes('export const parse = 0;\n'), 'u1#a1': writes('export const parse = 1;\n') },
      port: selectionPort({ pick: 'none', confidence: 0.9, fits: {} }, []),
      steps: {
        attemptsUndecided: async (run, unitId, record) => {
          undecided.push({ unitId, record });
          run.control.fail('other', 'test: the owner stopped it');
        },
      },
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 20_000);
    expect(undecided).toHaveLength(1);
    expect(undecided[0]!.unitId).toBe('u1');
    expect(undecided[0]!.record.candidateIds).toEqual(['u1#a0', 'u1#a1']);
    expect(undecided[0]!.record.proposedId).toBeUndefined();
    expect(undecided[0]!.record.reasons).toStartWith('none chosen with confidence 0.90');
    const done = h.store.get(contract.id)!;
    expect(done.units[0]!.attemptSelection?.pickedId).toBeUndefined();
    expect(git(h.root, 'show', `${done.branch!}:src/csv.ts`)).toBe('');
  });

  test('a failed attempt is never a candidate, and does not fail the contract while another attempt passes', async () => {
    const offered: string[][] = [];
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto', defaultAttempts: 2 },
      scripts: {
        'u1#a0': () => [{ text: 'gave up', stop: { kind: 'error', message: 'the tool sandbox refused the write' } }],
        'u1#a1': writes('export const parse = 1;\n'),
      },
      port: selectionPort({ pick: 'u1#a1', confidence: 0.95, fits: { 'u1#a1': 0.96 } }, offered),
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 20_000);
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    expect(offered).toEqual([['u1#a1']]);
    const [failed, passed] = done.units[0]!.attemptUnits!;
    expect(failed!.status).toBe('failed');
    expect(failed!.failureReason).toContain('the tool sandbox refused the write');
    expect(passed!.status).toBe('passed');
    expect(done.units[0]!.attemptSelection?.candidateIds).toEqual(['u1#a1']);
  });

  test('when every attempt fails the unit and the contract fail, naming each attempt', async () => {
    const offered: string[][] = [];
    const refuse: AgentScript = () => [{ text: 'gave up', stop: { kind: 'error', message: 'the tool sandbox refused the write' } }];
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto', defaultAttempts: 2 },
      scripts: { 'u1#a0': refuse, 'u1#a1': refuse },
      port: selectionPort({ pick: 'none', confidence: 0.9, fits: {} }, offered),
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 20_000);
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('failed');
    expect(done.error).toStartWith('every attempt of unit u1 failed (u1#a0: unit u1#a0 failed with a failure that is not transient');
    expect(done.error).toContain('u1#a1: unit u1#a1 failed');
    expect(offered).toEqual([]);
  });

  test('in a shared working tree the unit runs once, and the decision says why', async () => {
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'shared', defaultAttempts: 2 },
      scripts: { u1: writes('export const parse = 1;\n') },
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed');
    expect(done.units[0]!.attemptUnits).toBeUndefined();
    expect(done.decisions.find((entry) => entry.action === 'attempts-reduced')?.reason).toBe('unit u1 asks for 2 attempts, but attempts need worktree isolation to run apart; in the shared working tree it runs once');
  });
});

describe('the operator verb fleet.attempts.judge', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  function makeItem(spec: WorkItemSpec): WorkItem {
    return {
      id: spec.id ?? 'item', title: spec.title, task: spec.task, dependsOn: [], currentPhaseId: 'phase-1',
      state: 'pending', allAgentIds: [], visits: new Map(), touchedPaths: [], usage: emptyWorkItemUsage(), transportRetryCount: 0, createdAt: 0,
    };
  }

  test('returns the selection as a proposal with its reasons', async () => {
    const fake = fakePort((name, question, state) => {
      const candidates = (state as { candidates: { id: string }[] }).candidates;
      if (name === 'pick') return choiceAnswer(question, 'feat#a0', 0.93);
      const fit = /^fits_(\d+)$/.exec(name);
      return noulAnswer(fit !== null && candidates[Number(fit[1])]!.id === 'feat#a0' ? 0.94 : 0.2);
    });
    const previous = installJudgmentPort(fake.port);
    restore = () => installJudgmentPort(previous);
    let ws: Workstream = { id: 'ws-1', title: 'ws', schemaVersion: 1, phases: [], items: [], isolation: 'worktree', createdAt: 0 };
    const coordinator = createAttemptsCoordinator({
      emit: () => {},
      getWorkstream: () => ws,
      enqueueIntegration: () => {},
      cleanupWorktree: async () => {},
      diffItem: async (item) => ({ files: [`${item.id}.ts`], unifiedDiff: `diff --git a/src/${item.id}.ts b/src/${item.id}.ts\n+export const x = 1;`, stat: '1 file' }),
      judge: createSelectAttemptJudge(),
    });
    const items = coordinator.expandItems('ws-1', 'worktree', [{ id: 'feat', title: 'Feature', task: 'build the feature', attempts: 2 }], makeItem);
    ws = { ...ws, items };
    for (const item of items) coordinator.onItemPassedTerminal(ws, item);
    const controller: FleetAttemptsController = {
      listHeldMergeGroups: (id) => coordinator.listGroups(id),
      pickAttemptWinner: (group, winner) => coordinator.pickWinner(group, winner),
      proposeAttemptWinner: (group) => coordinator.proposeWinner(group),
    };
    const catalog = new GatewayMethodCatalog();
    const descriptor = catalog.get('fleet.attempts.judge');
    if (descriptor === null) throw new Error('fleet.attempts.judge is not in the method catalog');
    catalog.register(descriptor, createFleetAttemptsJudgeHandler(controller), { replace: true });
    const judgment = await catalog.invoke('fleet.attempts.judge', { context: { principalId: 'op', admin: true }, body: { groupId: items[0]!.attemptGroupId! } }) as {
      proposedWinnerItemId: string | null; reasons: string[]; scoredBy: string;
    };
    expect(judgment.proposedWinnerItemId).toBe('feat#a0');
    expect(judgment.scoredBy).toBe('model');
    expect(judgment.reasons).toEqual(['chosen feat#a0 with confidence 0.93 (act); fits: feat#a0 yes 0.94, feat#a1 no 0.20']);
    // The candidates Jev read carried each attempt's diff.
    const state = fake.requests[0]!.state as { context: unknown; candidates: { id: string; content: { diff: string } }[] };
    expect(state.context).toEqual({ goal: 'build the feature', criteria: [] });
    expect(state.candidates.map((candidate) => candidate.content.diff)).toEqual([
      'diff --git a/src/feat#a0.ts b/src/feat#a0.ts\n+export const x = 1;',
      'diff --git a/src/feat#a1.ts b/src/feat#a1.ts\n+export const x = 1;',
    ]);
  });
});

describe('candidates and reasons (code)', () => {
  const context = { goal: 'Parse CSV', criteria: [{ id: 'u1.c1', text: 'quoted commas stay in the field' }] };

  function bigDiff(prefix: string, files: number, size: number): string {
    return Array.from({ length: files }, (_, index) => `diff --git a/src/${prefix}${index}.ts b/src/${prefix}${index}.ts\n+${'x'.repeat(size)}`).join('\n');
  }

  test('candidates share the evidence budget equally; files that do not fit are listed as omitted', () => {
    const sources = ['a', 'b', 'c'].map((id) => ({ id, diff: { files: [], stat: '40 files', unifiedDiff: bigDiff(id, 40, 3_000) }, answer: 'y'.repeat(20_000) }));
    const candidates = selectionCandidates(context, sources);
    expect(estimateTokens({ context, candidates })).toBeLessThanOrEqual(EVIDENCE_TOKEN_BUDGET);
    for (const candidate of candidates) {
      const content = candidate.content as { diff: string; omitted: string[]; answer: string };
      expect(content.omitted.length).toBeGreaterThan(0);
      expect(content.answer.length).toBeLessThan(20_000);
      expect(content.answer).toContain('characters omitted');
    }
    const sizes = candidates.map((candidate) => estimateTokens(candidate.content));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(1_100);
  });

  test('a small diff is kept whole, with the unit\'s own files first', () => {
    const diff = ['diff --git a/src/other.ts b/src/other.ts\n+other', 'diff --git a/src/csv.ts b/src/csv.ts\n+parse'].join('\n');
    const [candidate] = selectionCandidates(context, [{ id: 'a', diff: { files: [], stat: '2 files', unifiedDiff: diff }, answer: 'done' }], ['src/csv.ts']);
    expect(candidate!.content).toEqual({ stat: '2 files', diff: 'diff --git a/src/csv.ts b/src/csv.ts\n+parse\n\ndiff --git a/src/other.ts b/src/other.ts\n+other', answer: 'done' });
  });

  test('the reasons name the winner or its absence and every fit reading', () => {
    const fits = { a: { kind: 'yes-no', probability: 0.91, verdict: 'yes', outcome: 'act' }, b: { kind: 'yes-no', probability: 0.2, verdict: 'no', outcome: 'act' } } as const;
    expect(describeSelection({ chosen: undefined, outcome: 'escalate', pick: { kind: 'choice', choice: 'b', confidence: 0.8, probabilities: {}, outcome: 'confirm' }, fits }))
      .toBe('b ranked first with confidence 0.80 but does not fit (escalate); fits: a yes 0.91, b no 0.20');
  });
});
