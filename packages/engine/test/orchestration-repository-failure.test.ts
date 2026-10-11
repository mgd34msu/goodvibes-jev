import { ContractRun } from '../sdk/src/platform/contract/run-context.js';
import { createGroupRunner } from '../sdk/src/platform/contract/group-runner.js';
import { makeContract, makeGroup, makeUnit } from './contract/fixtures.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { classifyBookkeepingFailure, repositoryFailureReading } from '../sdk/src/platform/orchestration/bookkeeping.js';
import { registry } from '../sdk/src/platform/orchestration/judgment-registry.js';
import { createOrchestrationEngine } from '../sdk/src/platform/orchestration/engine.js';
import { runPhase } from '../sdk/src/platform/orchestration/phase-runner.js';
import { createCancellationRegistry } from '../sdk/src/platform/orchestration/cancellation.js';
import type { PhaseSpec } from '../sdk/src/platform/orchestration/types.js';
import { createOrchestrationHarness, makeFakeConfigManager, engineerReportOutput, flushMicrotasks } from './_helpers/orchestration-harness.js';

const roots: string[] = [];
const engines: ReturnType<typeof createOrchestrationEngine>[] = [];
const oldPort = installJudgmentPort(undefined);
afterEach(() => { installJudgmentPort(oldPort); for (const engine of engines.splice(0)) engine.dispose(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const phase: PhaseSpec = { id: 'phase', kind: 'engineer', role: 'engineer', capacity: 1, gate: { gates: [], scope: 'scoped' } };
function setup(error: unknown, mode: 'commit' | 'merge' = 'commit') {
  const root = mkdtempSync(join(tmpdir(), 'repository-reading-')); roots.push(root);
  const h = createOrchestrationHarness();
  if (mode === 'commit') h.worktree.commitWorkingTree = async () => { throw error; };
  else h.worktree.merge = async () => { throw error; };
  const config = makeFakeConfigManager();
  const engine = createOrchestrationEngine({ agentManager: h.agentManager, runtimeBus: h.bus, configManager: config,
    projectRoot: root, createWorktree: () => h.worktree, skipClaimVerification: true });
  engines.push(engine);
  const ws = engine.createWorkstream({ title: 'fixture', phases: [phase], items: [{ id: 'item', title: 'item', task: 'work' }] });
  return { h, engine, ws, config, root, item: ws.items[0]! };
}
function answer(value: number | 'malformed' | 'unavailable') {
  const fake = fakePort(() => value === 'malformed' ? {} : noulAnswer(typeof value === 'number' ? value : .01));
  if (value === 'unavailable') fake.port.ask = async () => { throw new Error('provider unavailable'); };
  installJudgmentPort(fake.port);
  return fake;
}
async function finish(f: ReturnType<typeof setup>) {
  f.engine.start(f.ws.id); await flushMicrotasks(80);
  f.h.completeAgent(f.item.agentId!, engineerReportOutput({ filesCreated: ['file.ts'] }));
  await flushMicrotasks(150);
}

test('registered complete-message reading, with no automatic EACCES corruption', async () => {
  expect(registry.list()).toContain(repositoryFailureReading);
  const fake = answer(.01);
  const message = 'EACCES hook failed; index is not locked. ' + 'context '.repeat(2000) + 'Objects are healthy.';
  const result = await classifyBookkeepingFailure(Object.assign(new Error(message), { code: 'EACCES', errno: -13 }));
  expect(result.classification).toBe('non-negating');
  expect(fake.requests[0]!.state).toEqual({ message });
});

describe('actual isolated and shared phase consumers', () => {
  for (const isolation of ['isolated', 'shared-commit', 'shared-merge'] as const) {
    for (const [value, classification] of [[.99, 'negating'], [.01, 'non-negating'], [.5, 'held'], ['malformed', 'held'], ['unavailable', 'held']] as const) {
      test(`${isolation}: ${value} -> ${classification}`, async () => {
        answer(value);
        const f = setup(new Error('Original complete action failure'), isolation === 'shared-merge' ? 'merge' : 'commit');
        f.item.currentPhaseId = 'phase'; f.item.state = 'in-phase';
        const pending = runPhase(f.ws, f.item, f.ws.phases[0]!, [], {
          agentManager: f.h.agentManager, runtimeBus: f.h.bus, configManager: f.config, projectRoot: f.root, sessionId: 'test',
          cancellation: createCancellationRegistry(), createWorktree: () => f.h.worktree, skipClaimVerification: true,
          ...(isolation === 'isolated' ? { itemWorktree: { path: f.root, commit: async () => { throw new Error('Original complete action failure'); } } } : {}),
        });
        await flushMicrotasks(80);
        f.h.completeAgent(f.item.agentId!, engineerReportOutput({}));
        const outcome = await pending;
        expect(outcome.result.gate.passed).toBe(true);
        expect(outcome.result.commit).toMatchObject({ status: 'failed', reason: 'Original complete action failure', classification });
        expect(outcome.result.commit?.negating).toBe(classification === 'held' ? undefined : classification === 'negating');
      });
    }
  }
});

for (const [value, state] of [[.99, 'failed'], [.01, 'passed'], [.5, 'blocked-bookkeeping'], ['malformed', 'blocked-bookkeeping'], ['unavailable', 'blocked-bookkeeping']] as const) {
  test(`final engine routes ${value} to ${state}`, async () => {
    answer(value); const f = setup(new Error('Original action failure'));
    await finish(f);
    expect(f.item.state).toBe(state);
    expect(f.engine.getPhaseResults(f.ws.id)[0]!.commit?.reason).toBe('Original action failure');
    if (state === 'blocked-bookkeeping') {
      expect(f.item.completedAt).toBeUndefined(); expect(f.item.warnings).toBeUndefined();
      f.engine.start(f.ws.id); await flushMicrotasks(80); expect(f.h.spawnedRecords).toHaveLength(1);
    }
  });
}

test('absent port and raw-error privacy are held without source disclosure or coercion', async () => {
  const fake = answer(.99); let invoked = 0;
  for (const error of [new Error('password=synthetic-secret'), { get message() { invoked++; return 'bad object'; } },
    { toJSON() { invoked++; return 'bad object'; } }, new Proxy({}, { getOwnPropertyDescriptor() { invoked++; throw new Error(); } })]) {
    const result = await classifyBookkeepingFailure(error);
    expect(result.classification).toBe('held'); expect(result.reason).not.toContain('synthetic-secret');
  }
  expect(invoked).toBe(0); expect(fake.requests).toHaveLength(0);
  installJudgmentPort(undefined);
  expect((await classifyBookkeepingFailure(new Error('unchanged original failure'))).classification).toBe('held');
});

function deferredPort() {
  const fake = fakePort(() => noulAnswer(.01));
  const ask = fake.port.ask;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const port: JudgmentPort = { ...fake.port, async ask(request) { entered = true; await wait; return ask(request); } };
  installJudgmentPort(port);
  return { release, entered: () => entered };
}
for (const action of ['kill', 'replace', 'source'] as const) {
  test(`deferred reading ${action} cannot publish a stale non-negating result`, async () => {
    const deferred = deferredPort(); const error = new Error('original action failure'); const f = setup(error);
    f.engine.start(f.ws.id); await flushMicrotasks(80);
    f.h.completeAgent(f.item.agentId!, engineerReportOutput({})); await flushMicrotasks(80);
    expect(deferred.entered()).toBe(true);
    if (action === 'kill') f.engine.kill(f.item.id);
    else if (action === 'replace') answer(.99);
    else error.message = 'replacement action failure';
    deferred.release(); await flushMicrotasks(180);
    expect(f.item.state).toBe(action === 'kill' ? 'failed' : 'blocked-bookkeeping');
    if (action === 'kill') expect(f.engine.getPhaseResults(f.ws.id)).toHaveLength(0);
    else expect(f.engine.getPhaseResults(f.ws.id)[0]!.commit?.classification).toBe('held');
    expect(f.item.warnings).toBeUndefined();
  });
}

test('privacy refusal stays safe through the final consumer and stored result', async () => {
  const fake = answer(.99); const f = setup(new Error('password=synthetic-secret'));
  await finish(f);
  expect(f.item.state).toBe('blocked-bookkeeping');
  expect(JSON.stringify(f.engine.getPhaseResults(f.ws.id))).not.toContain('synthetic-secret');
  expect(JSON.stringify(f.item)).not.toContain('synthetic-secret');
  expect(fake.requests).toHaveLength(0);
});

test('port replacement during awaited cleanup withdraws the phase verdict before engine routing', async () => {
  answer(.01); const f = setup(new Error('Original failure'));
  f.h.worktree.cleanup = async () => { answer(.99); };
  await finish(f);
  expect(f.item.state).toBe('blocked-bookkeeping');
  expect(f.engine.getPhaseResults(f.ws.id)[0]!.commit?.classification).toBe('held');
  expect(f.item.warnings).toBeUndefined();
});

test('config incarnation replacement holds a pending phase reading, even when restored', async () => {
  const deferred = deferredPort(); const f = setup(new Error('Original failure'));
  let incarnation = 0;
  const listeners = new Set<() => void>();
  const config = { ...f.config, getConfigurationIncarnation: () => incarnation,
    onDidChangeIncarnation(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  f.item.currentPhaseId = 'phase'; f.item.state = 'in-phase';
  const pending = runPhase(f.ws, f.item, f.ws.phases[0]!, [], {
    agentManager: f.h.agentManager, runtimeBus: f.h.bus, configManager: config, projectRoot: f.root, sessionId: 'test',
    cancellation: createCancellationRegistry(), createWorktree: () => f.h.worktree, skipClaimVerification: true,
  });
  await flushMicrotasks(80); f.h.completeAgent(f.item.agentId!, engineerReportOutput({})); await flushMicrotasks(80);
  expect(deferred.entered()).toBe(true);
  incarnation++; for (const listener of listeners) listener(); incarnation++;
  const outcome = await pending;
  expect(outcome.result.commit?.classification).toBe('held');
  expect(() => outcome.bookkeeping?.assertCurrent()).toThrow();
  expect(listeners.size).toBe(0);
  deferred.release(); await flushMicrotasks(80);
  expect(outcome.result.commit?.classification).toBe('held');
});

test('isolated phase cancellation settles without waiting for an uncooperative reader', async () => {
  const deferred = deferredPort(); const f = setup(new Error('Original failure'));
  const cancellation = createCancellationRegistry();
  f.item.currentPhaseId = 'phase'; f.item.state = 'in-phase';
  const pending = runPhase(f.ws, f.item, f.ws.phases[0]!, [], {
    agentManager: f.h.agentManager, runtimeBus: f.h.bus, configManager: f.config, projectRoot: f.root, sessionId: 'test',
    cancellation, createWorktree: () => f.h.worktree, skipClaimVerification: true,
    itemWorktree: { path: f.root, commit: async () => { throw new Error('Original isolated failure'); } },
  });
  await flushMicrotasks(80); f.h.completeAgent(f.item.agentId!, engineerReportOutput({})); await flushMicrotasks(80);
  expect(deferred.entered()).toBe(true); cancellation.abort(f.item.id);
  const outcome = await pending;
  expect(outcome.agentStatus).toBe('cancelled');
  expect(outcome.result.commit).toMatchObject({ status: 'failed', classification: 'held', reason: 'Original isolated failure' });
  expect(f.h.worktree.merges).toHaveLength(0);
  expect(f.h.worktree.cleanups).toHaveLength(0);
  deferred.release(); await flushMicrotasks(80);
  expect(outcome.result.commit?.negating).toBeUndefined();
});

test('held snapshot remains held on import; explicit existing requeue can reconsider it', async () => {
  answer(.5); const f = setup(new Error('Original failure')); await finish(f);
  const snapshot = f.engine.serializeWorkstream(f.ws.id)!;
  expect(f.engine.importWorkstream(snapshot, true)).toBe(true);
  const restored = f.engine.getWorkstream(f.ws.id)!.items[0]!;
  f.engine.start(f.ws.id); await flushMicrotasks(80);
  expect(restored.state).toBe('blocked-bookkeeping');
  expect(f.engine.retryItem(restored.id)).toBe(false);
  expect(f.h.spawnedRecords).toHaveLength(1);
  answer(.01);
  expect(f.engine.requeueItem(restored.id, 'operator explicitly requested reconsideration')).toBe(true);
  await flushMicrotasks(80);
  f.h.completeAgent(restored.agentId!, engineerReportOutput({})); await flushMicrotasks(150);
  expect(restored.state).toBe('passed');
  expect(f.h.spawnedRecords).toHaveLength(2);
});

test('disposing the engine during a reading suppresses later outcome publication', async () => {
  const deferred = deferredPort(); const f = setup(new Error('Original failure'));
  f.engine.start(f.ws.id); await flushMicrotasks(80);
  f.h.completeAgent(f.item.agentId!, engineerReportOutput({})); await flushMicrotasks(80);
  expect(deferred.entered()).toBe(true); f.engine.dispose(); deferred.release(); await flushMicrotasks(150);
  expect(f.engine.getPhaseResults(f.ws.id)).toHaveLength(0);
  expect(f.item.state).not.toBe('passed');
});


test('actual contract group consumer cannot finish gate-passed units while engine bookkeeping remains held', async () => {
  answer(.5); const f = setup(new Error('Original commit failure')); await finish(f);
  const unit = makeUnit({ id: f.item.id, groupId: 'g1', status: 'passed' });
  const contract = makeContract({ units: [unit], groups: [makeGroup({ id: 'g1', unitIds: [unit.id], status: 'running' })] });
  const forbidden = (): never => { throw new Error('Unexpected contract effect'); };
  const run = new ContractRun(contract, { now: forbidden, config: forbidden, emit: forbidden, touchAgent: forbidden },
    { passGroup: forbidden, finishPassed: forbidden, fail: forbidden, cancel: forbidden });
  run.engine = f.engine;
  const judgedGroups: string[] = [];
  let sharedReleases = 0;
  run.sharedTreeReleases.set('g1', () => { sharedReleases++; });
  const groups = createGroupRunner({
    createEngine: forbidden, fleetCapacity: forbidden, routeSelector: forbidden, getStatus: forbidden,
    watchdog: { touch: forbidden, forget: forbidden, tick: forbidden, restart: forbidden, dispose: forbidden },
    settlement: { beforeSpawn: forbidden, settle: forbidden },
    steps: { groupUnitsPassed: async (_run, groupId) => { judgedGroups.push(groupId); },
      groupsPassed: forbidden, unitMergeConflict: forbidden, fixGroupPassed: forbidden, attemptsUndecided: forbidden },
    pricing: { priceUsage: forbidden, priceProvenance: forbidden }, failContract: forbidden, failUnit: forbidden,
  });
  groups.unitPassed(run, unit);
  await flushMicrotasks(80);
  expect(unit.status).toBe('passed');
  expect(f.item.state).toBe('blocked-bookkeeping');
  expect(contract.groups[0]!.status).toBe('running');
  expect(run.settledGroups.size).toBe(0); expect(judgedGroups).toHaveLength(0); expect(sharedReleases).toBe(0);
  // Only the pre-existing explicit requeue action reconsiders the phase.
  answer(.01); expect(f.engine.requeueItem(f.item.id, 'operator requested reconsideration')).toBe(true);
  await flushMicrotasks(80); f.h.completeAgent(f.item.agentId!, engineerReportOutput({})); await flushMicrotasks(150);
  expect(f.item.state).toBe('passed');
  groups.unitPassed(run, unit); await flushMicrotasks(80);
  expect(judgedGroups).toEqual(['g1']); expect(sharedReleases).toBe(1); expect(run.settledGroups.has('g1')).toBe(true);
});
