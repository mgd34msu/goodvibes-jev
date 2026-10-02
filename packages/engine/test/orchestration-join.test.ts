/** Actual settlement barriers: terminal statuses/events never stand in for executor cleanup. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolatedWorktree } from '../sdk/src/platform/agents/worktree.js';
import { createOrchestrationEngine, type OrchestrationEngineDeps } from '../sdk/src/platform/orchestration/engine.js';
import { createAttemptsCoordinator } from '../sdk/src/platform/orchestration/attempts.js';
import { createWorktreeIsolationManager } from '../sdk/src/platform/orchestration/worktree-isolation.js';
import type { WorkItem, WorkItemSpec } from '../sdk/src/platform/orchestration/types.js';
import { emptyWorkItemUsage } from '../sdk/src/platform/orchestration/types.js';
import { createOrchestrationHarness, engineerReportOutput, flushMicrotasks, makeFakeConfigManager } from './_helpers/orchestration-harness.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(overrides: Partial<OrchestrationEngineDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orch-join-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const h = createOrchestrationHarness();
  const engine = createOrchestrationEngine({
    projectRoot: root, agentManager: h.agentManager, runtimeBus: h.bus,
    configManager: makeFakeConfigManager(), createWorktree: () => h.worktree,
    skipClaimVerification: true, persist: false, ...overrides,
  });
  cleanups.push(() => engine.dispose());
  const makeStream = (items: WorkItemSpec[] = [{ id: 'item', title: 'Item', task: 'Do work' }], isolation?: 'worktree') => engine.createWorkstream({
    title: 'Work', phases: [{ id: 'phase', kind: 'engineer', role: 'engineer', capacity: 1, gate: { scope: 'off', gates: [] } }],
    items, ...(isolation ? { isolation } : {}),
  });
  return { root, h, engine, makeStream };
}

function observe(promise: Promise<void>): () => boolean {
  let settled = false;
  void promise.then(() => { settled = true; });
  return () => settled;
}

function fakeIsolatedWorktrees(): void {
  const create = spyOn(IsolatedWorktree.prototype, 'create').mockResolvedValue(undefined);
  const clean = spyOn(IsolatedWorktree.prototype, 'isClean').mockResolvedValue(true);
  const remove = spyOn(IsolatedWorktree.prototype, 'remove').mockResolvedValue(undefined);
  cleanups.push(() => { create.mockRestore(); clean.mockRestore(); remove.mockRestore(); });
}

describe('OrchestrationEngine.join', () => {
  test('waits through a terminal event, executor finally, and phase cleanup after passive disposal', async () => {
    const { engine, h, makeStream } = fixture();
    const execution = deferred();
    const cleanup = deferred();
    const cleanupEntered = deferred();
    h.agentManager.join = () => execution.promise;
    h.worktree.cleanup = async () => { cleanupEntered.resolve(); await cleanup.promise; };
    const ws = makeStream();
    engine.start(ws.id);
    h.completeAgent(ws.items[0]!.agentId!, engineerReportOutput({}));
    engine.dispose();
    const joined = engine.join();
    const finished = observe(joined);
    await flushMicrotasks();
    expect(finished()).toBe(false);
    expect(h.worktree.commits).toHaveLength(0);
    execution.resolve();
    await cleanupEntered.promise;
    expect(finished()).toBe(false);
    cleanup.resolve();
    await joined;
    expect(ws.items[0]!.state).toBe('passed');
  });

  test('reserves admission before spawn reentrantly kills, disposes, and joins', async () => {
    const { engine, h, makeStream } = fixture();
    const execution = deferred();
    h.agentManager.join = () => execution.promise;
    const originalSpawn = h.agentManager.spawn;
    let joined!: Promise<void>;
    h.agentManager.spawn = (input, binding) => {
      const record = originalSpawn(input, binding);
      expect(engine.kill('item')).toBe(true);
      engine.dispose();
      joined = engine.join();
      return record;
    };
    const ws = makeStream();
    engine.start(ws.id);
    const finished = observe(joined);
    await flushMicrotasks();
    expect(finished()).toBe(false);
    expect(h.cancelCalls.some((call) => call.agentId === 'agent-1')).toBe(true);
    expect(h.worktree.cleanups).toHaveLength(0);
    execution.resolve();
    await joined;
    expect(h.worktree.cleanups).toEqual(['agent-1']);
    expect(ws.items[0]!.state).toBe('failed');
  });

  test('cancellation from item-agent-spawned cannot miss a synchronous terminal event', async () => {
    const { engine, h, makeStream } = fixture();
    engine.on((event) => { if (event.type === 'item-agent-spawned') engine.kill(event.itemId); });
    const ws = makeStream();
    engine.start(ws.id);
    engine.dispose();
    await engine.join();
    expect(ws.items[0]!.state).toBe('failed');
    expect(h.worktree.cleanups).toEqual(['agent-1']);
  });

  test('a completion emitted inside spawn is observed before spawn returns', async () => {
    const { engine, h, makeStream } = fixture();
    const originalSpawn = h.agentManager.spawn;
    h.agentManager.spawn = (input, binding) => {
      const record = originalSpawn(input, binding);
      h.completeAgent(record.id, engineerReportOutput({}));
      return record;
    };
    const ws = makeStream();
    engine.start(ws.id);
    await engine.join();
    expect(ws.items[0]!.state).toBe('passed');
  });

  test('requeue waits for the old executor to exit before admitting its replacement', async () => {
    const { engine, h, makeStream } = fixture();
    const firstExecution = deferred();
    h.agentManager.join = (id) => id === 'agent-1' ? firstExecution.promise : Promise.resolve();
    const ws = makeStream();
    engine.start(ws.id);
    expect(engine.requeueItem('item', 'fresh run')).toBe(true);
    await flushMicrotasks();
    expect(h.spawnedRecords).toHaveLength(1);
    const joined = engine.join();
    const finished = observe(joined);
    firstExecution.resolve();
    await flushMicrotasks(30);
    expect(h.spawnedRecords).toHaveLength(2);
    expect(finished()).toBe(false);
    h.completeAgent('agent-2', engineerReportOutput({}));
    await joined;
    expect(ws.items[0]!.state).toBe('passed');
  });

  test('retry after kill cannot be overwritten by the cancelled phase settling later', async () => {
    const { engine, h, makeStream } = fixture();
    const firstExecution = deferred();
    h.agentManager.join = (id) => id === 'agent-1' ? firstExecution.promise : Promise.resolve();
    const ws = makeStream();
    engine.start(ws.id);
    engine.kill('item');
    expect(engine.retryItem('item')).toBe(true);
    const joined = engine.join();
    await flushMicrotasks();
    expect(h.spawnedRecords).toHaveLength(1);
    firstExecution.resolve();
    await flushMicrotasks(30);
    expect(h.spawnedRecords).toHaveLength(2);
    h.completeAgent('agent-2', engineerReportOutput({}));
    await joined;
    expect(ws.items[0]!.state).toBe('passed');
  });

  test('joins the next phase admitted from the preceding phase finalizer', async () => {
    const { engine, h } = fixture();
    const ws = engine.createWorkstream({
      title: 'Pipeline', items: [{ id: 'item', title: 'Work', task: 'Work' }],
      phases: [1, 2].map((n) => ({ id: `phase-${n}`, kind: 'engineer', role: 'engineer', capacity: 1, gate: { scope: 'off', gates: [] } })),
    });
    engine.start(ws.id);
    const joined = engine.join();
    const finished = observe(joined);
    h.completeAgent('agent-1', engineerReportOutput({}));
    await flushMicrotasks(30);
    expect(h.spawnedRecords).toHaveLength(2);
    expect(finished()).toBe(false);
    h.completeAgent('agent-2', engineerReportOutput({}));
    await joined;
    expect(engine.getPhaseResults(ws.id)).toHaveLength(2);
  });

  test('abort during contract pre-spawn waits for it but never starts its late spawn decision', async () => {
    const decision = deferred<{ kind: 'spawn' }>();
    const { engine, h, makeStream } = fixture({ contractUnitSettlement: {
      beforeSpawn: () => decision.promise,
      settle: async () => 'completed',
    } });
    const ws = makeStream([{ id: 'item', title: 'Unit', task: 'Do work', contractId: 'contract', contractUnitId: 'unit' }]);
    engine.start(ws.id);
    engine.kill('item');
    engine.dispose();
    const joined = engine.join();
    const finished = observe(joined);
    await flushMicrotasks();
    expect(finished()).toBe(false);
    decision.resolve({ kind: 'spawn' });
    await joined;
    expect(h.spawnedRecords).toHaveLength(0);
  });

  test('contract semantic settlement also waits for its agent executor finally', async () => {
    const execution = deferred();
    const { engine, h, makeStream } = fixture({ contractUnitSettlement: {
      beforeSpawn: async () => ({ kind: 'spawn' }),
      settle: async () => 'completed',
    } });
    h.agentManager.join = () => execution.promise;
    const ws = makeStream([{ id: 'item', title: 'Unit', task: 'Do work', contractId: 'contract', contractUnitId: 'unit' }]);
    engine.start(ws.id);
    const joined = engine.join();
    const finished = observe(joined);
    await flushMicrotasks();
    expect(finished()).toBe(false);
    expect(h.worktree.cleanups).toHaveLength(0);
    execution.resolve();
    await joined;
    expect(ws.items[0]!.state).toBe('passed');
  });

  test('kill during isolated setup waits for setup and cleanup without spawning an agent', async () => {
    fakeIsolatedWorktrees();
    const setup = deferred();
    const entered = deferred();
    const { engine, h, makeStream } = fixture({ runWorktreeSetup: async () => { entered.resolve(); await setup.promise; } });
    const ws = makeStream(undefined, 'worktree');
    engine.start(ws.id);
    await entered.promise;
    engine.kill('item');
    engine.dispose();
    const joined = engine.join();
    const finished = observe(joined);
    await flushMicrotasks();
    expect(finished()).toBe(false);
    expect(ws.items[0]!.worktreePath).toBeDefined();
    setup.resolve();
    await joined;
    expect(h.spawnedRecords).toHaveLength(0);
    expect(ws.items[0]!.worktreePath).toBeUndefined();
  });

  test('best-of-N loser cleanup cannot delete a cancelled sibling before its executor exits', async () => {
    fakeIsolatedWorktrees();
    const execution = deferred();
    const removed: string[] = [];
    const integrate = spyOn(IsolatedWorktree.prototype, 'integrate').mockResolvedValue({ status: 'empty' });
    const remove = spyOn(IsolatedWorktree.prototype, 'remove').mockImplementation(async function (this: IsolatedWorktree) {
      removed.push(this.path);
    });
    cleanups.push(() => { integrate.mockRestore(); remove.mockRestore(); });
    const { engine, h } = fixture({ runWorktreeSetup: async () => undefined });
    h.agentManager.join = (id) => id === 'agent-2' ? execution.promise : Promise.resolve();
    const ws = engine.createWorkstream({
      title: 'Attempts', isolation: 'worktree',
      items: [{ id: 'item', title: 'Try', task: 'Work', attempts: 2 }],
      phases: [{ kind: 'engineer', role: 'engineer', capacity: 2, gate: { scope: 'off', gates: [] } }],
    });
    engine.start(ws.id);
    await flushMicrotasks(30);
    const winner = ws.items[0]!;
    const loser = ws.items[1]!;
    const loserPath = loser.worktreePath!;
    h.completeAgent(winner.agentId!, engineerReportOutput({}));
    await flushMicrotasks(30);
    engine.kill(loser.id);
    await engine.pickAttemptWinner(winner.attemptGroupId!, winner.id);
    await flushMicrotasks(30);
    expect(removed).not.toContain(loserPath);
    engine.dispose();
    const joined = engine.join();
    const finished = observe(joined);
    await flushMicrotasks();
    expect(finished()).toBe(false);
    execution.resolve();
    await joined;
    expect(removed).toContain(loserPath);
  });

  test('joins integration started by imported terminal items and its delayed removal', async () => {
    fakeIsolatedWorktrees();
    const integration = deferred<{ status: 'empty' }>();
    const removal = deferred();
    const removalEntered = deferred();
    const integrate = spyOn(IsolatedWorktree.prototype, 'integrate').mockImplementation(() => integration.promise);
    const remove = spyOn(IsolatedWorktree.prototype, 'remove').mockImplementation(async () => { removalEntered.resolve(); await removal.promise; });
    cleanups.push(() => { integrate.mockRestore(); remove.mockRestore(); });
    const { engine, makeStream } = fixture();
    const ws = makeStream(undefined, 'worktree');
    ws.items[0]!.state = 'passed';
    ws.items[0]!.currentPhaseId = null;
    expect(engine.importWorkstream(engine.serializeWorkstream(ws.id)!)).toBe(true);
    engine.dispose();
    const joined = engine.join();
    const finished = observe(joined);
    await flushMicrotasks();
    expect(finished()).toBe(false);
    integration.resolve({ status: 'empty' });
    await removalEntered.promise;
    expect(finished()).toBe(false);
    removal.resolve();
    await joined;
  });
});

function item(spec: WorkItemSpec): WorkItem {
  return { id: spec.id!, task: spec.task, title: spec.title, dependsOn: [], state: 'pending', currentPhaseId: null,
    allAgentIds: [], visits: new Map(), touchedPaths: [], usage: emptyWorkItemUsage(), transportRetryCount: 0, createdAt: 0 };
}

describe('orchestration nested work', () => {
  test('auto-judge and fire-and-forget loser cleanup remain owned after attempts-ready', async () => {
    const judgment = deferred<{ winnerItemId: string; reasons: string[] }>();
    const loserCleanup = deferred();
    let joined!: Promise<void>;
    const ws = { id: 'ws', title: 'Attempts', schemaVersion: 1, phases: [], items: [] as WorkItem[], isolation: 'worktree' as const, createdAt: 0 };
    const coordinator = createAttemptsCoordinator({
      emit: (event) => { if (event.type === 'attempts-ready') joined = coordinator.join(); },
      getWorkstream: () => ws, enqueueIntegration: () => undefined,
      cleanupWorktree: () => loserCleanup.promise, diffItem: async () => null,
      judge: () => judgment.promise,
    });
    ws.items = coordinator.expandItems(ws.id, 'worktree', [{ id: 'item', title: 'Try', task: 'Do work', attempts: 2, autoAcceptWinner: true }], item);
    for (const sibling of ws.items) coordinator.onItemPassedTerminal(ws, sibling);
    const finished = observe(joined);
    await flushMicrotasks();
    expect(finished()).toBe(false);
    judgment.resolve({ winnerItemId: ws.items[0]!.id, reasons: ['best'] });
    await flushMicrotasks(30);
    expect(finished()).toBe(false);
    loserCleanup.resolve();
    await joined;
    expect(ws.items[0]!.attemptWinner).toBe(true);
  });

  test('kept-worktree eviction is joined after the triggering cleanup has returned', async () => {
    fakeIsolatedWorktrees();
    const eviction = deferred<{ preservedCommit: string | null }>();
    const dirty = spyOn(IsolatedWorktree.prototype, 'isClean').mockResolvedValue(false);
    const evict = spyOn(IsolatedWorktree.prototype, 'evict').mockImplementation(() => eviction.promise);
    cleanups.push(() => { dirty.mockRestore(); evict.mockRestore(); });
    const { root } = fixture();
    const isolation = createWorktreeIsolationManager({ projectRoot: root, emit: () => undefined, keptWorktreeCap: 0 });
    const workItem = item({ id: 'item', task: 'Work', title: 'Work' });
    const ws = { id: 'ws', title: 'Work', schemaVersion: 1, phases: [], items: [workItem], isolation: 'worktree' as const, createdAt: 0 };
    await isolation.ensureWorktree(ws, workItem);
    await isolation.cleanupTerminated(ws, workItem);
    const joined = isolation.join();
    const finished = observe(joined);
    await flushMicrotasks();
    expect(finished()).toBe(false);
    eviction.resolve({ preservedCommit: 'saved' });
    await joined;
    expect(workItem.worktreePath).toBeUndefined();
  });
});
