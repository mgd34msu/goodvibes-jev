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
  test('structural and unconfigured results retain composition ownership without needing a reading', async () => {
    install();
    const absent = reader();
    const known = await absent(new KnowledgeRepairBudgetError());
    const unknown = await absent(new Error('unknown cause'));
    expect(known.cause).toBe('run_budget'); expect(known.isOwnerCurrent()).toBe(true);
    expect(unknown.basis).toBe('unconfigured'); expect(unknown.isOwnerCurrent()).toBe(true);
    const fake = fixture('other');
    expect(known.isOwnerCurrent()).toBe(false); expect(unknown.isOwnerCurrent()).toBe(false);
    const structured = await reader()(new KnowledgeRepairBudgetError());
    expect(structured.isOwnerCurrent()).toBe(true); expect(fake.requests).toHaveLength(0);
    fixture('other'); expect(structured.isOwnerCurrent()).toBe(false);
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

describe('failure disposition commit boundaries', () => {
  const snapshot = (value: unknown): string => JSON.stringify(value ?? null);
  test.each(['unchanged-none', 'unchanged-port', 'install', 'replace', 'model'])('structural write composition control: %s', async (change) => {
    const fake = fakePort((_name, question) => choiceAnswer(question, 'other', 0.99));
    let model = 'synthetic-first';
    install(change === 'unchanged-none' || change === 'install' ? undefined : { ...fake.port, get model() { return model; } });
    const { store, service, gap, spaceId } = await serviceFixture(new KnowledgeRepairBudgetError());
    const originalInit = store.init.bind(store), originalTask = store.upsertRefinementTask.bind(store);
    let committing = false, paused = false;
    store.init = async () => {
      await originalInit();
      if (committing && !paused) {
        paused = true;
        if (change === 'install' || change === 'replace') install(fake.port);
        if (change === 'model') model = 'synthetic-second';
      }
    };
    store.upsertRefinementTask = async (input) => {
      if (input.state === 'blocked') committing = true;
      try { return await originalTask(input); }
      finally { committing = false; }
    };
    const result = await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    expect(paused).toBe(true); expect(fake.requests).toHaveLength(0);
    const task = store.getRefinementTask(result.taskIds[0]!)!;
    if (change.startsWith('unchanged')) {
      expect(task.state).toBe('blocked'); expect(result.nextRepairAttemptAt).toBeGreaterThan(Date.now());
    } else {
      expect(task.state).toBe('searching'); expect(result.skippedGaps).toBe(1); expect(result.nextRepairAttemptAt).toBeUndefined();
    }
  });

  test.each(['run_budget', 'other'])('a durable save failure after the %s branch first commit remains observable', async (cause) => {
    fixture(cause);
    const { store, service, gap, spaceId } = await serviceFixture(new Error('synthetic repair failure'));
    const sqlite = (store as unknown as { sqlite: { save(): Promise<void> } }).sqlite;
    const save = sqlite.save.bind(sqlite);
    const storageFailure = new Error('synthetic durable save failure');
    sqlite.save = async () => {
      const firstWriteCommitted = cause === 'run_budget'
        ? store.getNode(gap.id)?.metadata.repairStatus === 'deferred'
        : store.listRefinementTasks(10, { spaceId })[0]?.state === 'failed';
      if (firstWriteCommitted) throw storageFailure;
      await save();
    };
    try {
      await expect(service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true })).rejects.toBe(storageFailure);
    } finally { sqlite.save = save; }
  });

  for (const cause of ['run_budget', 'other']) {
    for (const boundary of ['gap-init', 'gap-commit-init', 'task-init', 'after-gap-commit', 'after-task-commit']) {
      for (const action of ['replace-task', 'cancel', 'replace-port', 'delete-gap', 'resolve-issue', 'replace-gap']) {
        test(`${cause}: ${action} at ${boundary} cannot authorize a later stale write`, async () => {
          fixture(cause);
          const { store, service, gap, spaceId } = await serviceFixture(new Error('synthetic failure'));
          const controller = new AbortController();
          const activeRepairs = (service as unknown as { activeGapRepairs: Set<string> }).activeGapRepairs;
          const issue = await store.upsertIssue({ severity: 'warning', code: 'synthetic-review', message: 'Synthetic review', nodeId: gap.id, status: 'open', metadata: { knowledgeSpaceId: spaceId } });
          const originalInit = store.init.bind(store), originalNode = store.upsertNode.bind(store), originalTask = store.upsertRefinementTask.bind(store), originalPrepared = store.upsertPreparedNode.bind(store);
          let active: 'gap' | 'gap-commit' | 'task' | undefined, changed = false;
          let replacement: string | undefined;
          let targetBefore = '';
          let gapAtMutation = '', taskAtMutation = '';
          const taskNow = () => store.listRefinementTasks(10, { spaceId })[0]!;
          const mutate = async () => {
            expect(activeRepairs.size).toBe(1);
            changed = true;
            gapAtMutation = snapshot(store.getNode(gap.id)); taskAtMutation = snapshot(taskNow());
            targetBefore = snapshot(boundary.startsWith('gap') ? store.getNode(gap.id) : taskNow());
            if (action === 'replace-task') {
              const task = taskNow();
              const record = await originalTask({ ...task, state: 'searching', attemptCount: task.attemptCount + 1, metadata: { ...task.metadata, newerAttempt: true } });
              replacement = snapshot(record);
            } else if (action === 'cancel') controller.abort();
            else if (action === 'replace-port') fixture('other');
            else if (action === 'delete-gap') await store.deleteNode(gap.id);
            else if (action === 'resolve-issue') await store.upsertIssue({ ...issue, status: 'resolved' });
            else await seedKnowledgeResearchTask(store, { ...store.getNode(gap.id)!, title: 'New operator research question' });
            targetBefore = snapshot(boundary.startsWith('gap') ? store.getNode(gap.id) : taskNow());
            gapAtMutation = snapshot(store.getNode(gap.id)); taskAtMutation = snapshot(taskNow());

          };
          store.init = async () => {
            await originalInit();
            if (!changed && boundary === `${active}-init`) await mutate();
          };
          store.upsertNode = async (input, mutation) => {
            const disposition = input.id === gap.id && ['deferred', 'failed'].includes(String(input.metadata?.repairStatus));
            if (disposition) active = 'gap';
            try {
              const record = await originalNode(input, mutation);
              if (disposition && !changed && boundary === 'after-gap-commit') await mutate();
              return record;
            } finally { if (disposition) active = undefined; }
          };
          store.upsertPreparedNode = async (prepared, index) => {
            const previous = active;
            if (active === 'gap') active = 'gap-commit';
            try { return await originalPrepared(prepared, index); }
            finally { active = previous; }
          };
          store.upsertRefinementTask = async (input) => {
            const disposition = ['blocked', 'failed'].includes(input.state);
            if (disposition) active = 'task';
            try {
              const record = await originalTask(input);
              if (disposition && !changed && boundary === 'after-task-commit') await mutate();
              return record;
            } finally { if (disposition) active = undefined; }
          };
          const result = await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true, signal: controller.signal });
          expect(changed).toBe(true);
          expect(activeRepairs.size).toBe(0);
          if (action === 'replace-task') expect(snapshot(taskNow())).toBe(replacement ?? 'replacement was not captured');
          if (action === 'delete-gap') expect(store.getNode(gap.id)).toBeNull();
          if (action === 'replace-gap') expect(store.getNode(gap.id)?.title).toBe('New operator research question');
          if (action === 'resolve-issue') expect(store.getIssue(issue.id)?.status).toBe('resolved');
          if (boundary.endsWith('-init') && action !== 'replace-task') {
            expect(snapshot(boundary.startsWith('gap') ? store.getNode(gap.id) : taskNow())).toBe(targetBefore);
          }
          // A post-final-write change may leave the already authorized writes,
          // but must not produce a fresh stale mutation or a current disposition receipt.
          if (boundary === 'after-task-commit' && cause === 'other') expect(snapshot(store.getNode(gap.id))).toBe(gapAtMutation);
          if (boundary === 'after-gap-commit' && cause === 'run_budget') expect(snapshot(taskNow())).toBe(replacement ?? taskAtMutation);
          expect(result.nextRepairAttemptAt).toBeUndefined();
          expect(result.skippedGaps).toBe(1);
        });
      }
    }
  }
});
