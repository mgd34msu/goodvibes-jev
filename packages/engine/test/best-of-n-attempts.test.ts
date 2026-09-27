/**
 * Best-of-N sibling attempts (platform/orchestration/attempts.ts).
 *
 * Covers expansion into N siblings (worktree only), the held-merge park instead
 * of auto-merge, group readiness, the winner pick (winner merges, losers are
 * cleaned), the judge proposal + auto-accept, the contract.best-of-n selector
 * as the judge (createSelectAttemptJudge), and the per-item budget ceiling.
 * Drives the coordinator directly with fakes, no git, no agents.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createSelectAttemptJudge } from '../sdk/src/platform/contract/best-of-n.js';
import {
  createAttemptsCoordinator,
  AttemptError,
  emptyWorkItemUsage,
  type OrchestrationEvent,
  type WorkItem,
  type WorkItemSpec,
  type Workstream,
} from '../sdk/src/platform/orchestration/index.js';
import { checkBudget } from '../sdk/src/platform/orchestration/budget.js';

function makeItem(spec: WorkItemSpec): WorkItem {
  return {
    id: spec.id ?? `item-${Math.random().toString(36).slice(2, 8)}`,
    title: spec.title,
    task: spec.task,
    dependsOn: [],
    currentPhaseId: 'phase-1',
    state: 'pending',
    allAgentIds: [],
    visits: new Map(),
    touchedPaths: [],
    usage: emptyWorkItemUsage(),
    transportRetryCount: 0,
    createdAt: 0,
  };
}

function makeWorkstream(items: WorkItem[], isolation: 'worktree' | 'shared' = 'worktree'): Workstream {
  return { id: 'ws-1', title: 'ws', schemaVersion: 1, phases: [], items, isolation, createdAt: 0 };
}

interface Harness {
  events: OrchestrationEvent[];
  enqueued: string[];
  cleaned: string[];
  coordinator: ReturnType<typeof createAttemptsCoordinator>;
}

function harness(judge?: Parameters<typeof createAttemptsCoordinator>[0]['judge'], ws?: () => Workstream | null): Harness {
  const events: OrchestrationEvent[] = [];
  const enqueued: string[] = [];
  const cleaned: string[] = [];
  const coordinator = createAttemptsCoordinator({
    emit: (e) => events.push(e),
    getWorkstream: ws ?? (() => null),
    enqueueIntegration: (_w, item) => { enqueued.push(item.id); },
    cleanupWorktree: async (_w, item) => { cleaned.push(item.id); },
    diffItem: async (item) => ({ files: [`${item.id}.ts`], unifiedDiff: `diff for ${item.id}`, stat: '1 file' }),
    ...(judge ? { judge } : {}),
  });
  return { events, enqueued, cleaned, coordinator };
}

describe('expandItems', () => {
  test('expands attempts:3 into 3 grouped siblings under worktree isolation', () => {
    const h = harness();
    const items = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'do it', attempts: 3 }], makeItem);
    expect(items).toHaveLength(3);
    const groupIds = new Set(items.map((i) => i.attemptGroupId));
    expect(groupIds.size).toBe(1);
    expect(items.map((i) => i.attemptIndex)).toEqual([0, 1, 2]);
    expect(items.every((i) => i.attemptTotal === 3)).toBe(true);
    const spawned = h.events.find((e) => e.type === 'item-attempts-spawned');
    expect(spawned?.type).toBe('item-attempts-spawned');
  });

  test('ignores attempts under shared isolation (single item)', () => {
    const h = harness();
    const items = h.coordinator.expandItems('ws-1', 'shared', [{ title: 'T', task: 'x', attempts: 3 }], makeItem);
    expect(items).toHaveLength(1);
    expect(items[0]!.attemptGroupId).toBeUndefined();
  });

  test('clamps attempts above the cap and passes single items through', () => {
    const h = harness();
    const many = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 99 }], makeItem);
    expect(many.length).toBeLessThanOrEqual(5);
    const single = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'S', task: 'x' }], makeItem);
    expect(single).toHaveLength(1);
    expect(single[0]!.attemptGroupId).toBeUndefined();
  });
});

describe('hold-vs-merge and readiness', () => {
  test('a non-attempt passed item enqueues integration; an attempt is held', () => {
    let ws!: Workstream;
    const h = harness(undefined, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 2 }], makeItem);
    const plain = makeItem({ title: 'P', task: 'y' });
    ws = makeWorkstream([...siblings, plain]);

    h.coordinator.onItemPassedTerminal(ws, plain);
    expect(h.enqueued).toEqual([plain.id]);

    h.coordinator.onItemPassedTerminal(ws, siblings[0]!);
    expect(siblings[0]!.state).toBe('held-merge');
    expect(h.events.some((e) => e.type === 'item-attempt-held')).toBe(true);
    // Not ready yet, sibling 1 is still pending.
    expect(h.events.some((e) => e.type === 'attempts-ready')).toBe(false);

    h.coordinator.onItemPassedTerminal(ws, siblings[1]!);
    const ready = h.events.find((e) => e.type === 'attempts-ready');
    expect(ready?.type).toBe('attempts-ready');
  });

  test('a failed sibling still counts toward readiness', () => {
    let ws!: Workstream;
    const h = harness(undefined, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 2 }], makeItem);
    ws = makeWorkstream(siblings);
    h.coordinator.onItemPassedTerminal(ws, siblings[0]!);
    siblings[1]!.state = 'failed';
    h.coordinator.onItemFailedTerminal(ws, siblings[1]!);
    expect(h.events.some((e) => e.type === 'attempts-ready')).toBe(true);
  });
});

describe('pickWinner', () => {
  async function readyGroup(): Promise<{ h: Harness; ws: Workstream; groupId: string; siblings: WorkItem[] }> {
    let ws!: Workstream;
    const h = harness(undefined, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 3 }], makeItem);
    for (const s of siblings) { s.worktreePath = `/wt/${s.id}`; s.worktreeBranch = `ws/1/${s.id}`; }
    ws = makeWorkstream(siblings);
    for (const s of siblings) h.coordinator.onItemPassedTerminal(ws, s);
    const groupId = siblings[0]!.attemptGroupId!;
    return { h, ws, groupId, siblings };
  }

  test('merges the winner and cleans the losers, removing the group', async () => {
    const { h, groupId, siblings } = await readyGroup();
    const winner = siblings[1]!;
    const result = await h.coordinator.pickWinner(groupId, winner.id);
    expect(result.winnerItemId).toBe(winner.id);
    expect(result.auto).toBe(false);
    expect(h.enqueued).toEqual([winner.id]);
    expect(h.cleaned.sort()).toEqual([siblings[0]!.id, siblings[2]!.id].sort());
    expect(winner.state).toBe('passed');
    expect(h.events.some((e) => e.type === 'attempt-winner-picked')).toBe(true);
    // Group is resolved, a second pick is an honest error.
    await expect(h.coordinator.pickWinner(groupId, winner.id)).rejects.toBeInstanceOf(AttemptError);
  });

  test('rejects an invalid winner and a not-ready group', async () => {
    const { h, groupId } = await readyGroup();
    await expect(h.coordinator.pickWinner(groupId, 'nonexistent')).rejects.toBeInstanceOf(AttemptError);
    await expect(h.coordinator.pickWinner('bogus-group', 'x')).rejects.toBeInstanceOf(AttemptError);
  });

  test('listGroups exposes candidates with their diffs', async () => {
    const { h } = await readyGroup();
    const groups = await h.coordinator.listGroups('ws-1');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ready).toBe(true);
    expect(groups[0]!.candidates).toHaveLength(3);
    expect(groups[0]!.candidates[0]!.diff?.unifiedDiff).toContain('diff for');
  });
});

describe('judge', () => {
  test('proposeWinner stamps a model judgment and emits a proposal', async () => {
    let ws!: Workstream;
    const judge = async () => ({ winnerItemId: ws.items[0]!.id, reasons: ['clearest diff'], model: 'test-model' });
    const h = harness(judge, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 2 }], makeItem);
    ws = makeWorkstream(siblings);
    for (const s of siblings) h.coordinator.onItemPassedTerminal(ws, s);
    const judgment = await h.coordinator.proposeWinner(siblings[0]!.attemptGroupId!);
    expect(judgment.scoredBy).toBe('model');
    expect(judgment.proposedWinnerItemId).toBe(siblings[0]!.id);
    expect(judgment.reasons).toContain('clearest diff');
    expect(h.events.some((e) => e.type === 'attempt-judge-proposed')).toBe(true);
  });

  test('proposeWinner without a judge is an honest error', async () => {
    let ws!: Workstream;
    const h = harness(undefined, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 2 }], makeItem);
    ws = makeWorkstream(siblings);
    for (const s of siblings) h.coordinator.onItemPassedTerminal(ws, s);
    await expect(h.coordinator.proposeWinner(siblings[0]!.attemptGroupId!)).rejects.toBeInstanceOf(AttemptError);
  });

  test('auto-accept picks the judge-proposed winner once the group is ready', async () => {
    let ws!: Workstream;
    const judge = async () => ({ winnerItemId: ws.items[1]!.id, reasons: ['best'] });
    const h = harness(judge, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 2, autoAcceptWinner: true }], makeItem);
    ws = makeWorkstream(siblings);
    for (const s of siblings) h.coordinator.onItemPassedTerminal(ws, s);
    // Auto judge-and-pick runs async off the readiness event; let microtasks flush.
    await new Promise((r) => setTimeout(r, 0));
    const picked = h.events.find((e) => e.type === 'attempt-winner-picked');
    expect(picked?.type).toBe('attempt-winner-picked');
    if (picked?.type === 'attempt-winner-picked') expect(picked.auto).toBe(true);
    expect(h.enqueued).toEqual([siblings[1]!.id]);
  });
});

describe('per-item budget', () => {
  test('refuses a claim once the item reaches its own token ceiling', () => {
    const item = makeItem({ title: 'T', task: 'x' });
    item.itemBudget = { maxTokens: 100 };
    item.usage = { ...emptyWorkItemUsage(), inputTokens: 80, outputTokens: 40 };
    const ws = makeWorkstream([item]);
    const check = checkBudget(ws, item);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('item token usage');
  });

  test('allows a claim under the item ceiling', () => {
    const item = makeItem({ title: 'T', task: 'x' });
    item.itemBudget = { maxTokens: 1000 };
    item.usage = { ...emptyWorkItemUsage(), inputTokens: 10, outputTokens: 10 };
    expect(checkBudget(makeWorkstream([item]), item).allowed).toBe(true);
  });
});

describe('the contract.best-of-n selector as the judge', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  /** A port that picks `pick` with `confidence` and reads each candidate's fit from `fits`; it records the ids offered. */
  function selectPort(pick: string, confidence: number, fits: Readonly<Record<string, number>>) {
    const offered: string[][] = [];
    const fake = fakePort((name: string, question: Question, state: unknown) => {
      const candidates = (state as { candidates: { id: string }[] }).candidates;
      if (name === 'pick') {
        offered.push(candidates.map((candidate) => candidate.id));
        return choiceAnswer(question, pick, confidence);
      }
      const fit = /^fits_(\d+)$/.exec(name);
      if (fit !== null) return noulAnswer(fits[candidates[Number(fit[1])]!.id] ?? 0.05);
      throw new Error(`unexpected question ${name}`);
    });
    const previous = installJudgmentPort(fake.port);
    restore = () => installJudgmentPort(previous);
    return offered;
  }

  async function readyGroup(judge: ReturnType<typeof createSelectAttemptJudge>, failFirst = false, autoAcceptWinner = false) {
    let ws!: Workstream;
    const h = harness(judge, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ id: 'feat', title: 'T', task: 'Add formatBytes', attempts: 3, ...(autoAcceptWinner ? { autoAcceptWinner } : {}) }], makeItem);
    ws = makeWorkstream(siblings);
    siblings.forEach((sibling, index) => {
      if (failFirst && index === 0) {
        sibling.state = 'failed';
        h.coordinator.onItemFailedTerminal(ws, sibling);
      } else {
        h.coordinator.onItemPassedTerminal(ws, sibling);
      }
    });
    return { h, siblings, groupId: siblings[0]!.attemptGroupId! };
  }

  test('a winner at act is proposed, with reasons built from the readings', async () => {
    selectPort('feat#a1', 0.95, { 'feat#a1': 0.96, 'feat#a0': 0.2 });
    const { h, groupId } = await readyGroup(createSelectAttemptJudge());
    const judgment = await h.coordinator.proposeWinner(groupId);
    expect(judgment.proposedWinnerItemId).toBe('feat#a1');
    expect(judgment.scoredBy).toBe('model');
    expect(judgment.reasons[0]).toBe('chosen feat#a1 with confidence 0.95 (act); fits: feat#a0 no 0.20, feat#a1 yes 0.96, feat#a2 no 0.05');
  });

  test('a winner short of act proposes none and says what was read', async () => {
    selectPort('feat#a2', 0.75, { 'feat#a2': 0.95 });
    const { h, groupId } = await readyGroup(createSelectAttemptJudge());
    const judgment = await h.coordinator.proposeWinner(groupId);
    expect(judgment.proposedWinnerItemId).toBeNull();
    expect(judgment.reasons[0]).toStartWith('chosen feat#a2 with confidence 0.75 (confirm)');
  });

  test('a failed sibling is never offered as a candidate', async () => {
    const offered = selectPort('feat#a1', 0.95, { 'feat#a1': 0.96 });
    const { h, groupId } = await readyGroup(createSelectAttemptJudge(), true);
    const judgment = await h.coordinator.proposeWinner(groupId);
    expect(offered).toEqual([['feat#a1', 'feat#a2']]);
    expect(judgment.proposedWinnerItemId).toBe('feat#a1');
  });

  test('auto-accept picks the selected winner once the group is ready', async () => {
    selectPort('feat#a2', 0.95, { 'feat#a2': 0.96 });
    const { h } = await readyGroup(createSelectAttemptJudge(), false, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const picked = h.events.find((event) => event.type === 'attempt-winner-picked');
    expect(picked?.type === 'attempt-winner-picked' && picked.auto && picked.winnerItemId).toBe('feat#a2');
    expect(h.enqueued).toEqual(['feat#a2']);
  });

  test('with no passing sibling there is nothing to select and Jev is not asked', async () => {
    const offered = selectPort('feat#a0', 0.95, {});
    const judge = createSelectAttemptJudge();
    const verdict = await judge({ task: 't', candidates: [{ itemId: 'a', attemptIndex: 0, state: 'failed', diff: null, usage: emptyWorkItemUsage() }] });
    expect(verdict).toEqual({ winnerItemId: null, reasons: ['no attempt passed; there is nothing to select'] });
    expect(offered).toEqual([]);
  });
});
