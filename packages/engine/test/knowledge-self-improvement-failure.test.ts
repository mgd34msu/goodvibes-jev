import { afterEach, describe, expect, test } from 'bun:test';
import { GoodVibesSdkError, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { AppError } from '../sdk/src/platform/types/errors.js';
import { KnowledgeRepairProfileHeldError } from '../sdk/src/platform/knowledge/semantic/repair-profile/types.js';
import { captureRepairFailureReader } from '../sdk/src/platform/knowledge/semantic/self-improvement-failure.js';
import { KnowledgeRepairBudgetError, runWithRepairBudget } from '../sdk/src/platform/knowledge/semantic/self-improvement-budget.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';
import { seedKnowledgeResearchTask } from './_helpers/knowledge-semantic-activation-fixtures.js';

let previous: JudgmentPort | undefined;
let installed = false;
function install(port?: JudgmentPort) { if (!installed) { previous = installJudgmentPort(port); installed = true; } else installJudgmentPort(port); }
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function reader(options: { deadlineAt?: number; signal?: AbortSignal; shouldStop?: () => boolean } = {}) {
  return captureRepairFailureReader({ deadlineAt: Date.now() + 1_000, shouldStop: () => false, ...options });
}
function fixture(cause: string, confidence = 0.99) {
  const fake = fakePort((_name, question) => choiceAnswer(question, cause, confidence));
  install(fake.port); return fake;
}

describe('knowledge repair failure cause', () => {
  test.each([
    [new KnowledgeRepairBudgetError(), 'run_budget', 'owned-timer'],
    [new AppError('No timeout occurred; invalid input', 'PROVIDER_ERROR', true, { category: 'timeout' }), 'request_timeout', 'typed-category'],
    [new AppError('budget deadline exceeded', 'PROVIDER_ERROR', false, { category: 'billing' }), 'other', 'typed-category'],
    [Object.assign(new Error('budget exceeded'), { status: 429 }), 'other', 'http-status'],
    [Object.assign(new Error('all fine'), { status: 504 }), 'request_timeout', 'http-status'],
    [Object.assign(new Error('ordinary text'), { code: 'ETIMEDOUT' }), 'request_timeout', 'error-code'],
    [Object.assign(new Error('budget exceeded'), { code: 'ECONNREFUSED' }), 'other', 'error-code'],
    [new KnowledgeRepairProfileHeldError('budget'), 'other', 'typed-judgment-hold'],
    [new JudgmentError('unavailable', 'budget exhausted', { status: 504 }), 'other', 'typed-judgment-hold'],
    [Object.assign(new Error('no time words'), { code: 'TIMEOUT' }), 'request_timeout', 'sdk-timeout-code'],
    [Object.assign(new Error('no time words'), { code: 'AGENT_TIMEOUT' }), 'request_timeout', 'sdk-timeout-code'],
    [new DOMException('budget exceeded', 'AbortError'), 'other', 'dom-exception'],
  ] as const)('structure defeats contrary wording %#', async (error, cause, basis) => {
    const fake = fixture('run_budget');
    const result = await reader()(error);
    expect(result.cause).toBe(cause); expect(result.basis).toBe(basis); expect(fake.requests).toHaveLength(0);
  });
  test.each(['request_timeout', 'run_budget', 'other', 'unknown'])('typed semantic %s, no word-list authority', async (cause) => {
    const fake = fixture(cause);
    const result = await reader()(new Error('timeout deadline budget exceeded'));
    expect(result.cause).toBe(cause); expect(result.basis).toBe('reading'); expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.signal).toBeDefined(); expect(fake.requests[0]?.beforeAttempt).toBeDefined();
  });
  test('the canonical UNKNOWN code does not hide free-text evidence', async () => {
    const fake = fixture('request_timeout');
    expect((await reader()(new GoodVibesSdkError('Remote operation ran out of time'))).cause).toBe('request_timeout');
    expect(fake.requests).toHaveLength(1);
  });
  test('uncertain does not authorize deferral', async () => {
    fixture('run_budget', 0.55);
    expect((await reader()(new Error('budget'))).cause).toBe('unknown');
  });
  test('untrusted status getters are never executed', async () => {
    let calls = 0; fixture('other');
    const error = Object.defineProperty(new Error('budget'), 'status', { get() { calls++; throw new Error('getter'); } });
    expect((await reader()(error)).cause).toBe('other'); expect(calls).toBe(0);
  });
  test('a forged error name is read, not trusted as timeout', async () => {
    const fake = fixture('other');
    expect((await reader()(Object.assign(new Error('nothing'), { name: 'TimeoutError' }))).cause).toBe('other');
    expect(fake.requests).toHaveLength(1);
  });
  test('missing and unavailable readers never invent budget', async () => {
    install(); expect((await reader()(new Error('budget exceeded'))).basis).toBe('unconfigured');
    install({ model: 'synthetic', ask: async () => { throw new Error('down'); } });
    const result = await reader()(new Error('budget exceeded'));
    expect(result.cause).toBe('unknown'); expect(result.basis).toBe('unavailable'); expect(result.isCurrent()).toBe(true);
  });
  test('pre-aborted signal never starts a reading', async () => {
    const fake = fixture('run_budget'); const controller = new AbortController(); controller.abort();
    const result = await reader({ signal: controller.signal })(new Error('budget'));
    expect(result.isCurrent()).toBe(false); expect(fake.requests).toHaveLength(0);
  });
  test('malformed probabilities cannot authorize a budget disposition', async () => {
    const fake = fakePort((_name, question) => ({ ...choiceAnswer(question, 'run_budget', 0.99), confidence: Number.NaN }));
    install(fake.port); const result = await reader()(new Error('budget'));
    expect(result.cause).toBe('unknown'); expect(result.basis).toBe('unavailable');
  });
  test('shared retry progress remains one reading with recorded retry provenance', async () => {
    const fake = fakePort((_name, question) => choiceAnswer(question, 'run_budget', 0.99));
    let calls = 0;
    install({ ...fake.port, async ask(request) {
      calls++; request.beforeAttempt?.();
      request.onRetry?.({ logicalRequestId: 'synthetic', elapsedMs: 1, nextDelayMs: 0,
        attempt: { attempt: 1, endpointIndex: 0, endpointKind: 'hosted', requestedModel: 'synthetic', latencyMs: 1, outcome: 'unavailable' } });
      request.beforeAttempt?.(); return fake.port.ask(request);
    } });
    const result = await reader()(new Error('budget'));
    expect(calls).toBe(1); expect(result.retries).toBe(1); expect(result.cause).toBe('run_budget');
  });
  test('no reading when the remaining run budget is exhausted', async () => {
    const fake = fixture('run_budget');
    expect((await reader({ deadlineAt: Date.now() - 1 })(new Error('budget'))).basis).toBe('reading-budget-unavailable');
    expect(fake.requests).toHaveLength(0);
  });
  test('uncooperative reader is bounded by exact remaining time, without a minimum extension', async () => {
    install({ model: 'synthetic', ask: () => new Promise(() => {}) });
    const at = Date.now();
    const result = await reader({ deadlineAt: at + 20 })(new Error('budget'));
    expect(result.cause).toBe('unknown'); expect(result.basis).toBe('reading-budget-unavailable'); expect(Date.now() - at).toBeLessThan(500);
  });
  test('external cancellation interrupts an uncooperative reading', async () => {
    install({ model: 'synthetic', ask: () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = reader({ signal: controller.signal })(new Error('budget'));
    controller.abort(); const result = await pending;
    expect(result.cause).toBe('unknown'); expect(result.basis).toBe('cancelled');
  });
  test('lifecycle stop is checked on shared retries and after response', async () => {
    let stopped = false, calls = 0;
    const fake = fakePort((_name, question) => choiceAnswer(question, 'run_budget', 0.99));
    install({ ...fake.port, async ask(request) {
      calls++; stopped = true; expect(() => request.beforeAttempt?.()).toThrow();
      return fake.port.ask(request);
    } });
    const result = await reader({ shouldStop: () => stopped })(new Error('budget'));
    expect(result.isCurrent()).toBe(false); expect(result.cause).toBe('unknown'); expect(calls).toBe(1);
  });
  test('composition replacement invalidates a settled answer', async () => {
    const fake = fixture('run_budget');
    install({ ...fake.port, async ask(request) { install(fake.port); return fake.port.ask(request); } });
    const result = await reader()(new Error('budget')); expect(result.isCurrent()).toBe(false);
  });
  test('owned timer has one typed cause even for cooperative abort rejection', async () => {
    for (const cooperative of [false, true]) {
      const promise = runWithRepairBudget((signal) => new Promise((_resolve, reject) => {
        if (cooperative) signal.addEventListener('abort', () => reject(new Error('contrary generic error')), { once: true });
      }), 5);
      await expect(promise).rejects.toBeInstanceOf(KnowledgeRepairBudgetError);
    }
  });
  test('parent cancellation is not an owned budget error', async () => {
    const controller = new AbortController();
    const reason = new Error('operator stopped');
    const promise = runWithRepairBudget(() => new Promise(() => {}), 1_000, controller.signal);
    controller.abort(reason); await expect(promise).rejects.toBe(reason);
  });
});

async function serviceFixture(error: unknown) {
  const { store } = createStores();
  const spaceId = 'knowledge:failure-fixture';
  const source = await store.upsertSource({ connectorId: 'fixture', sourceType: 'url', title: 'Synthetic device manual', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  const gap = await seedKnowledgeResearchTask(store, { kind: 'knowledge_gap', slug: 'synthetic-repair-gap', title: 'Synthetic device features', aliases: [], confidence: 50, sourceId: source.id,
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap', gapKind: 'answer', sourceIds: [source.id] } });
  const service = new KnowledgeSemanticService(store, { gapRepairer: async () => { throw error; } });
  return { store, service, gap, spaceId };
}

describe('actual semantic service failure path', () => {
  test('actual owned timeout preserves the five-second minimum run floor', async () => {
    const fake = fixture('other');
    const { store, service, gap, spaceId } = await serviceFixture(new Error('unused'));
    service.setGapRepairer(() => new Promise(() => {}));
    const started = Date.now();
    const result = await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true, maxRunMs: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_950);
    expect(Date.now() - started).toBeLessThan(7_000);
    const task = store.getRefinementTask(result.taskIds[0]!)!;
    expect(task.state).toBe('blocked'); expect(task.trace.at(-1)?.data?.failureCause).toMatchObject({ cause: 'run_budget', basis: 'owned-timer' });
    expect(fake.requests).toHaveLength(0);
  }, 10_000);

  test('request timeout retains truthful provenance and decision receipt', async () => {
    const fake = fakePort((_name, question) => choiceAnswer(question, 'request_timeout', 0.99));
    install({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), decisionId: 'synthetic-decision-1' }; } });
    const { store, service, gap, spaceId } = await serviceFixture(new Error('The remote call never completed in time'));
    const result = await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    const task = store.getRefinementTask(result.taskIds[0]!)!;
    expect(task.state).toBe('blocked'); expect(task.blockedReason).toBe('Repair was deferred after a request timed out.');
    expect(task.trace.at(-1)?.data?.failureCause).toMatchObject({ cause: 'request_timeout', decisionId: 'synthetic-decision-1', outcome: 'act' });
  });
  test('unconfigured classification records execution failure, never budget deferral', async () => {
    install();
    const { store, service, gap, spaceId } = await serviceFixture(new Error('budget exceeded'));
    const result = await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    const task = store.getRefinementTask(result.taskIds[0]!)!;
    expect(task.state).toBe('failed'); expect(task.trace.at(-1)?.data?.failureCause).toMatchObject({ cause: 'unknown', basis: 'unconfigured' });
    expect(result.nextRepairAttemptAt).toBeUndefined();
  });
  test.each(['cancel', 'delete', 'close', 'model-change', 'task-replaced'])('late positive reading cannot overwrite %s', async (action) => {
    const { store, service, gap, spaceId } = await serviceFixture(new Error('budget exceeded'));
    const controller = new AbortController();
    const fake = fakePort((_name, question) => choiceAnswer(question, 'run_budget', 0.99));
    let model = 'synthetic-first';
    install({ ...fake.port, get model() { return model; }, async ask(request) {
      if (action === 'cancel') controller.abort();
      if (action === 'delete') await store.deleteNode(gap.id);
      if (action === 'close') {
        const task = store.listRefinementTasks(10, { spaceId })[0]!;
        await store.upsertRefinementTask({ ...task, state: 'closed' });
      }
      if (action === 'model-change') model = 'synthetic-second';
      if (action === 'task-replaced') {
        const task = store.listRefinementTasks(10, { spaceId })[0]!;
        await store.upsertRefinementTask({ ...task, state: 'searching', attemptCount: task.attemptCount + 1 });
      }
      return fake.port.ask(request);
    } });
    const result = await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true, signal: controller.signal });
    expect(result.blockedGaps).toBe(0); expect(result.nextRepairAttemptAt).toBeUndefined();
    expect(store.getNode(gap.id)?.metadata.repairStatus).not.toBe('deferred');
    if (action === 'task-replaced') {
      expect(store.getRefinementTask(result.taskIds[0]!)?.state).toBe('searching');
      expect(store.getRefinementTask(result.taskIds[0]!)?.attemptCount).toBe(2);
    }
    if (action === 'delete') expect(store.getNode(gap.id)).toBeNull();
    if (action === 'close') expect(store.getRefinementTask(result.taskIds[0]!)?.state).toBe('closed');
  });

  test.each([false, true])('scoped and whole-store callers retain distinct cause and existing cooldown: whole=%s', async (whole) => {
    fixture('run_budget');
    const { store, service, gap, spaceId } = await serviceFixture(new Error('Current work allocation consumed'));
    const result = await service.selfImprove(whole ? { force: true } : { knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    const task = store.getRefinementTask(result.taskIds[0]!)!;
    expect(result.blockedGaps).toBe(1); expect(task.state).toBe('blocked');
    expect(store.getNode(gap.id)?.metadata.repairStatus).toBe('deferred');
    expect(task.trace.at(-1)?.data?.failureCause).toMatchObject({ cause: 'run_budget', basis: 'reading' });
    expect(result.nextRepairAttemptAt! - Date.now()).toBeGreaterThan(6 * 60 * 60 * 1_000 - 5_000);
  });
  test.each(['other', 'unknown'])('negative/unknown execution remains failed but retains existing generic cooldown: %s', async (cause) => {
    fixture(cause);
    const { store, service, gap, spaceId } = await serviceFixture(new Error('timeout budget deadline exceeded'));
    const result = await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    const task = store.getRefinementTask(result.taskIds[0]!)!;
    expect(task.state).toBe('failed'); expect(result.nextRepairAttemptAt).toBeUndefined();
    expect(store.getNode(gap.id)?.metadata.repairStatus).toBe('failed');
    expect(store.getNode(gap.id)?.metadata.nextRepairAttemptAt).toBeGreaterThan(Date.now());
  });
});
