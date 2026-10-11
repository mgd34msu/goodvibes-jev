import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { classifyFailure } from '../sdk/src/platform/runtime/forensics/classifier.ts';
import { ForensicsCollector } from '../sdk/src/platform/runtime/forensics/collector.ts';
import { ForensicsRegistry } from '../sdk/src/platform/runtime/forensics/registry.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { emitTurnSubmitted, emitTurnError, emitTurnCancel } from '../sdk/src/platform/runtime/emitters/turn.ts';
import { emitTaskCreated, emitTaskFailed } from '../sdk/src/platform/runtime/emitters/tasks.ts';
import { CompactionManager } from '../sdk/src/platform/runtime/compaction/manager.ts';
import { compactConversation, type ConversationCompactionHost } from '../sdk/src/platform/core/conversation-compaction.ts';
import { routeConversationCompaction } from '../sdk/src/platform/core/compaction-lifecycle-route.ts';
import type { CompactionContext } from '../sdk/src/platform/core/compaction-types.ts';
import type { ProviderMessage } from '../sdk/src/platform/providers/interface.ts';
import type { ProviderRegistry } from '../sdk/src/platform/providers/registry.ts';
import { logger } from '../sdk/src/platform/utils/logger.ts';
import { failureReadingsPort } from './_helpers/failure-readings.ts';
import { compactionQualityPort } from './_helpers/compaction-quality.ts';

const deferred = () => Promise.withResolvers<void>();
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

/** The transport deliberately ignores abort, and can answer OR fail after its owner is gone. */
function heldPort(base: JudgmentPort, battery: string, rejectLate = false) {
  const entered = deferred(); const release = deferred();
  let blocked = true;
  const signals: AbortSignal[] = [];
  const port: JudgmentPort = { model: base.model, async ask(request) {
    if (blocked && request.context?.battery === battery) {
      if (request.signal) signals.push(request.signal);
      entered.resolve();
      await release.promise;
      if (rejectLate) throw new Error('synthetic late transport failure');
    }
    return base.ask(request);
  } };
  return { port, entered, release, signals, unblockNew: () => { blocked = false; } };
}

const turnCtx = { sessionId: 'owned-session', source: 'fixture', traceId: 'owned-trace-00001' };
function failTurn(bus: RuntimeEventBus, id: string, cancelled = false): void {
  emitTurnSubmitted(bus, turnCtx, { turnId: id, prompt: 'synthetic prompt' });
  if (cancelled) emitTurnCancel(bus, turnCtx, { turnId: id, reason: 'cancelled', stopReason: 'cancelled' });
  else emitTurnError(bus, turnCtx, { turnId: id, error: 'synthetic timed out', stopReason: 'provider_error' });
}

function manager(bus: RuntimeEventBus): CompactionManager {
  return new CompactionManager({ sessionId: 'owned-session', bus, contextWindow: 100_000,
    flags: { isEnabled: () => true } as unknown as ConstructorParameters<typeof CompactionManager>[0]['flags'] });
}
const messages = (): ProviderMessage[] => Array.from({ length: 40 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', content: `synthetic message ${i} ${'context '.repeat(120)}`,
}));
const compactOpts = () => ({ messages: messages(), tokenCount: 70_000, trigger: 'manual' as const });

function conversation(onReplace?: () => void) {
  let current = messages(); let replacements = 0; let lineage = 0;
  const host: ConversationCompactionHost = {
    getMessageCount: () => current.length,
    getMessagesForLLM: () => current,
    replaceMessagesForLLM(value) { current = value; replacements++; onReplace?.(); },
    getSessionMemoryStore: () => null,
    getSessionLineageTracker: () => ({ addCompactionEntry() { lineage++; } }),
  };
  return { host, get replacements() { return replacements; }, get lineage() { return lineage; } };
}
function context(host: ConversationCompactionHost, signal?: AbortSignal): CompactionContext {
  return { messages: host.getMessagesForLLM(), sessionMemories: [], agents: [], contracts: [], activePlan: null,
    lineageEntries: [], compactionCount: 0, contextWindow: 100_000, trigger: 'manual', extractionModelId: 'test/model',
    extractionProvider: 'test', signal };
}
const registry = { getForModel: () => ({ chat: async () => ({ content: 'Synthetic continuation summary preserving the task.' }) }),
  listModels: () => [{ provider: 'test', id: 'model', registryKey: 'test/model' }],
} as unknown as ProviderRegistry;

describe('forensics report ownership', () => {
  test('an explicitly signal-owned classifier cancels without requiring a borrowed port', async () => {
    const held = heldPort(failureReadingsPort([['timed out', { category: 'timeout' }]]).port, 'engine.failure-reading');
    installJudgmentPort(held.port); const abort = new AbortController();
    const pending = classifyFailure({ errorMessage: 'timed out' }, { signal: abort.signal }).catch((error: unknown) => error);
    try {
      await held.entered.promise; abort.abort(); expect(await pending).toBeInstanceOf(Error);
      held.release.resolve(); await flush(); expect(held.signals.every((signal) => signal.aborted)).toBe(true);
    } finally { held.release.resolve(); }
  });

  test.each([false, true])('retiring an ignored-abort classifier consumes late rejection=%s without reporting or logging', async (rejectLate) => {
    using log = new SqliteDecisionLog(':memory:');
    const held = heldPort(failureReadingsPort([['timed out', { category: 'timeout' }]]).port, 'engine.failure-reading', rejectLate);
    installJudgmentPort(withDecisionLog(held.port, log));
    const bus = new RuntimeEventBus(); const reports = new ForensicsRegistry();
    const collector = new ForensicsCollector(bus, reports); const events: string[] = [];
    bus.onDomain('forensics', (env) => { events.push(env.payload.type); });
    const errors = spyOn(logger, 'error');
    try {
      failTurn(bus, 'retired'); await held.entered.promise;
      collector.dispose(); await flush();
      expect(held.signals.every((signal) => signal.aborted)).toBe(true);
      expect((collector as unknown as { _pending: Set<Promise<void>> })._pending.size).toBe(0);
      expect(reports.count()).toBe(0); expect(events).toEqual([]); expect(log.query()).toEqual([]);
      held.unblockNew();
      const successor = new ForensicsCollector(bus, reports);
      const ready = deferred(); const off = reports.subscribe(ready.resolve);
      failTurn(bus, 'successor'); await ready.promise; await flush();
      expect(reports.latest()?.turnId).toBe('successor');
      const stored = log.query().length; expect(stored).toBeGreaterThan(0);
      held.release.resolve(); await flush();
      expect(log.query()).toHaveLength(stored); expect(reports.count()).toBe(1);
      expect(events).toEqual(['FORENSICS_REPORT_CREATED']); expect(errors).not.toHaveBeenCalled();
      off(); successor.dispose();
    } finally { held.release.resolve(); collector.dispose(); errors.mockRestore(); }
  });

  test('retiring during slow-phase reading produces no late attachment, action, report, or diagnostic', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const held = heldPort(failureReadingsPort([]).port, 'engine.runtime.forensics-slow-phase');
    installJudgmentPort(withDecisionLog(held.port, log));
    const bus = new RuntimeEventBus(); const reports = new ForensicsRegistry();
    const collector = new ForensicsCollector(bus, reports); const errors = spyOn(logger, 'error');
    try {
      failTurn(bus, 'cancelled', true); await held.entered.promise;
      collector.dispose(); await flush(); held.release.resolve(); await flush();
      expect(log.query()).toEqual([]); expect(reports.count()).toBe(0); expect(errors).not.toHaveBeenCalled();
    } finally { held.release.resolve(); collector.dispose(); errors.mockRestore(); }
  });

  test('registry subscriber disposal preserves the already-stored report but stops the subsequent event', async () => {
    installJudgmentPort(failureReadingsPort([]).port);
    const bus = new RuntimeEventBus(); const reports = new ForensicsRegistry();
    const collector = new ForensicsCollector(bus, reports); const ready = deferred(); const events: string[] = [];
    bus.onDomain('forensics', (env) => { events.push(env.payload.type); });
    const off = reports.subscribe(() => { collector.dispose(); ready.resolve(); });
    try {
      failTurn(bus, 'stored', true); await ready.promise; await flush();
      expect(reports.count()).toBe(1); expect(events).toEqual([]);
    } finally { off(); collector.dispose(); }
  });
});

describe('compaction manager ownership', () => {
  test.each([false, true])('disposal during ignored-abort quality settles promptly and consumes late rejection=%s', async (rejectLate) => {
    using log = new SqliteDecisionLog(':memory:');
    const held = heldPort(compactionQualityPort().port, 'engine.compaction.retention', rejectLate);
    installJudgmentPort(withDecisionLog(held.port, log));
    const bus = new RuntimeEventBus(); const owner = manager(bus); const events: string[] = [];
    bus.onDomain('compaction', (env) => { events.push(env.payload.type); });
    const pending = owner.compact(compactOpts());
    try {
      await held.entered.promise; owner.dispose();
      expect(await pending).toBeNull(); expect(owner.lastCommit).toBeNull(); expect(owner.state).toBe('idle');
      const before = events.slice(); const stored = log.query().length;
      expect(before).not.toContain('COMPACTION_QUALITY_SCORE');
      expect(before).not.toContain('COMPACTION_BOUNDARY_COMMIT'); expect(before).not.toContain('COMPACTION_DONE');
      held.release.resolve(); await flush();
      expect(events).toEqual(before); expect(log.query()).toHaveLength(stored);
      expect(await owner.compact(compactOpts())).toBeNull();
      held.unblockNew(); const successor = manager(bus);
      expect(await successor.compact(compactOpts())).not.toBeNull(); expect(successor.lastCommit).not.toBeNull(); successor.dispose();
    } finally { held.release.resolve(); owner.dispose(); }
  });

  test.each(['COMPACTION_CHECK', 'COMPACTION_QUALITY_SCORE', 'COMPACTION_BOUNDARY_COMMIT'])('reentrant disposal in %s prevents later publication', async (event) => {
    installJudgmentPort(compactionQualityPort().port);
    const events: string[] = [];
    // An emitter is a borrowed callback; this fixture really disposes synchronously.
    const bus = { emit(_domain: string, env: { payload: { type: string } }) {
      events.push(env.payload.type); if (env.payload.type === event) owner.dispose();
    } } as unknown as RuntimeEventBus;
    const owner = manager(bus);
    expect(await owner.compact(compactOpts())).toBeNull();
    expect(events.at(-1)).toBe(event); expect(owner.lastCommit).toBeNull(); expect(owner.state).toBe('idle');
  });

  test('a queued lifecycle never calls execute after disposal; an applied predecessor retains its truthful result', async () => {
    const bus = new RuntimeEventBus(); const owner = manager(bus); const entered = deferred(); const release = deferred();
    let queuedCalls = 0; let outcomes = 0; const events: string[] = [];
    bus.onDomain('compaction', (env) => { events.push(env.payload.type); });
    const shape = { trigger: 'manual' as const, strategy: 'microcompact' as const, messages: messages(), tokenCount: 1000 };
    const first = owner.runLifecycle({ ...shape, execute: async () => { entered.resolve(); await release.promise; return 'already-applied'; },
      outcome: () => { outcomes++; return null; } });
    await entered.promise;
    const second = owner.runLifecycle({ ...shape, execute: async () => { queuedCalls++; return 'bad'; }, outcome: () => null }).catch((error: unknown) => error);
    owner.dispose(); release.resolve();
    expect(await first).toBe('already-applied'); expect(await second).toBeInstanceOf(Error);
    expect(queuedCalls).toBe(0); expect(outcomes).toBe(0); expect(events).toEqual(['COMPACTION_CHECK']); expect(owner.lastCommit).toBeNull();
  });

  test('reentrant lifecycle boundary disposal preserves the applied result without recreating lastCommit', async () => {
    const events: string[] = [];
    const bus = { emit(_domain: string, env: { payload: { type: string } }) {
      events.push(env.payload.type); if (env.payload.type === 'COMPACTION_BOUNDARY_COMMIT') owner.dispose();
    } } as unknown as RuntimeEventBus;
    const owner = manager(bus);
    const applied = { messages: [{ role: 'user' as const, content: 'compacted' }], tokensAfter: 30, summary: 'done' };
    const result = await owner.runLifecycle({ trigger: 'manual', strategy: 'microcompact', messages: messages(), tokenCount: 1000,
      execute: async () => applied, outcome: (result) => result });
    expect(result).toBe(applied); expect(owner.lastCommit).toBeNull(); expect(events.at(-1)).toBe('COMPACTION_BOUNDARY_COMMIT');
  });
});

describe('conversation commit ownership', () => {
  test('session disposal reaches the actual quality reader and prevents messages and lineage', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const held = heldPort(compactionQualityPort().port, 'engine.compaction.retention');
    installJudgmentPort(withDecisionLog(held.port, log));
    const bus = new RuntimeEventBus(); const owner = manager(bus); const c = conversation(); const events: string[] = [];
    bus.onDomain('compaction', (env) => { events.push(env.payload.type); });
    const pending = routeConversationCompaction(owner, { trigger: 'manual', strategy: 'autocompact', messages: c.host.getMessagesForLLM(),
      tokenCount: 70_000, contextWindow: 100_000, threshold: 75_000 }, c.host,
    (lifetime) => compactConversation(c.host, registry, 'test/model', 'manual', 'test', { ...context(c.host), ...lifetime })).catch((error: unknown) => error);
    try {
      await held.entered.promise; owner.dispose(); expect(await pending).toBeInstanceOf(Error);
      const stored = log.query().length; held.release.resolve(); await flush();
      expect(c.replacements).toBe(0); expect(c.lineage).toBe(0); expect(owner.lastCommit).toBeNull();
      expect(events).toEqual(['COMPACTION_CHECK']); expect(log.query()).toHaveLength(stored);
    } finally { held.release.resolve(); owner.dispose(); }
  });

  test('successor compaction supersedes the older host attempt and remains unaffected by its late settlement', async () => {
    const held = heldPort(compactionQualityPort().port, 'engine.compaction.retention'); installJudgmentPort(held.port);
    const c = conversation();
    const first = compactConversation(c.host, registry, 'test/model', 'manual', 'test', context(c.host)).catch((error: unknown) => error);
    try {
      await held.entered.promise; held.unblockNew();
      const second = await compactConversation(c.host, registry, 'test/model', 'manual', 'test', context(c.host));
      expect(second?.outcome).toBe('applied'); expect(await first).toBeInstanceOf(Error);
      held.release.resolve(); await flush(); expect(c.replacements).toBe(1); expect(c.lineage).toBe(1);
    } finally { held.release.resolve(); }
  });

  test('reentrant disposal during replacement returns applied truth but prevents lineage and success logging', async () => {
    installJudgmentPort(compactionQualityPort().port); const abort = new AbortController();
    const c = conversation(() => abort.abort()); const info = spyOn(logger, 'info'); const errors = spyOn(logger, 'error');
    try {
      const receipt = await compactConversation(c.host, registry, 'test/model', 'manual', 'test', context(c.host, abort.signal));
      expect(receipt?.outcome).toBe('applied'); expect(c.replacements).toBe(1); expect(c.lineage).toBe(0);
      expect(info.mock.calls.some(([message]) => message === 'Conversation compacted')).toBe(false); expect(errors).not.toHaveBeenCalled();
    } finally { info.mockRestore(); errors.mockRestore(); }
  });

  test('ignored-abort canonical selection settles before transport release and emits no late completion diagnostics', async () => {
    const held = heldPort(compactionQualityPort().port, 'engine.compaction.conversation-substance');
    installJudgmentPort(held.port); const abort = new AbortController();
    const c = conversation();
    const errors = spyOn(logger, 'error'); const info = spyOn(logger, 'info'); const warnings = spyOn(logger, 'warn');
    const pending = compactConversation(c.host, registry, 'test/model', 'manual', 'test', context(c.host, abort.signal)).catch((error: unknown) => error);
    try {
      await held.entered.promise; abort.abort(); expect(await pending).toBeInstanceOf(Error);
      const counts = [info.mock.calls.length, warnings.mock.calls.length, errors.mock.calls.length];
      held.release.resolve(); await flush();
      expect([info.mock.calls.length, warnings.mock.calls.length, errors.mock.calls.length]).toEqual(counts);
      expect(held.signals.every((signal) => signal.aborted)).toBe(true); expect(c.replacements).toBe(0); expect(c.lineage).toBe(0);
    } finally { held.release.resolve(); errors.mockRestore(); info.mockRestore(); warnings.mockRestore(); }
  });
});


describe('source and conversation currentness', () => {
  test('a task report owns its pending classification just like a turn report', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const held = heldPort(failureReadingsPort([['timed out', { category: 'timeout' }]]).port, 'engine.failure-reading');
    installJudgmentPort(withDecisionLog(held.port, log));
    const bus = new RuntimeEventBus(); const reports = new ForensicsRegistry(); const collector = new ForensicsCollector(bus, reports);
    try {
      emitTaskCreated(bus, turnCtx, { taskId: 'task', description: 'synthetic', priority: 1 });
      emitTaskFailed(bus, turnCtx, { taskId: 'task', error: 'timed out', durationMs: 5 });
      await held.entered.promise; collector.dispose(); await flush(); held.release.resolve(); await flush();
      expect(reports.count()).toBe(0); expect(log.query()).toEqual([]);
      expect((collector as unknown as { _pending: Set<Promise<void>> })._pending.size).toBe(0);
    } finally { held.release.resolve(); collector.dispose(); }
  });

  test('source replacement cancels old quality and leaves the same manager usable by its successor', async () => {
    const held = heldPort(compactionQualityPort().port, 'engine.compaction.retention');
    installJudgmentPort(held.port); const bus = new RuntimeEventBus(); const owner = manager(bus);
    const pending = owner.compact(compactOpts());
    try {
      await held.entered.promise; installJudgmentPort(compactionQualityPort().port);
      expect(await pending).toBeNull(); expect(owner.state).toBe('idle'); expect(owner.lastCommit).toBeNull();
      const successor = await owner.compact(compactOpts()); expect(successor).not.toBeNull();
      const commit = owner.lastCommit; held.release.resolve(); await flush(); expect(owner.lastCommit).toBe(commit);
    } finally { held.release.resolve(); owner.dispose(); }
  });

  test('a collector cannot publish an old-source report after the source is replaced', async () => {
    const held = heldPort(failureReadingsPort([['timed out', { category: 'timeout' }]]).port, 'engine.failure-reading');
    installJudgmentPort(held.port); const bus = new RuntimeEventBus(); const reports = new ForensicsRegistry();
    const collector = new ForensicsCollector(bus, reports); const errors = spyOn(logger, 'error');
    try {
      failTurn(bus, 'old-source'); await held.entered.promise;
      installJudgmentPort(failureReadingsPort([['timed out', { category: 'service' }]]).port);
      await flush(); expect(reports.count()).toBe(0);
      const ready = deferred(); const off = reports.subscribe(ready.resolve);
      failTurn(bus, 'new-source'); await ready.promise; held.release.resolve(); await flush();
      expect(reports.count()).toBe(1); expect(reports.latest()?.turnId).toBe('new-source');
      expect(reports.latest()?.classification).toBe('llm_error'); expect(errors).not.toHaveBeenCalled(); off();
    } finally { held.release.resolve(); collector.dispose(); errors.mockRestore(); }
  });

  test('a conversation changed during quality reading is retained with no stale replacement or lineage', async () => {
    const held = heldPort(compactionQualityPort().port, 'engine.compaction.retention'); installJudgmentPort(held.port);
    const c = conversation(); const pending = compactConversation(c.host, registry, 'test/model', 'manual', 'test', context(c.host)).catch((error: unknown) => error);
    try {
      await held.entered.promise; c.host.getMessagesForLLM().push({ role: 'user', content: 'new task after snapshot' });
      held.release.resolve(); expect(await pending).toBeInstanceOf(Error);
      expect(c.replacements).toBe(0); expect(c.lineage).toBe(0); expect(c.host.getMessagesForLLM().at(-1)?.content).toBe('new task after snapshot');
    } finally { held.release.resolve(); }
  });

  test('a stale supplied context is rejected before extraction or quality reads', async () => {
    const fake = compactionQualityPort(); installJudgmentPort(fake.port); const c = conversation(); const stale = context(c.host);
    stale.messages = stale.messages.slice(0, -1);
    await expect(compactConversation(c.host, registry, 'test/model', 'manual', 'test', stale)).rejects.toThrow('changed before compaction');
    expect(fake.requests).toEqual([]); expect(c.replacements).toBe(0); expect(c.lineage).toBe(0);
  });

  test('a queued route refuses its obsolete input before calling the mutation callback', async () => {
    const bus = new RuntimeEventBus(); const owner = manager(bus); const c = conversation(); const entered = deferred(); const release = deferred(); let calls = 0;
    const first = owner.runLifecycle({ trigger: 'manual', strategy: 'microcompact', messages: c.host.getMessagesForLLM(), tokenCount: 1000,
      execute: async () => { entered.resolve(); await release.promise; return undefined; }, outcome: () => null });
    await entered.promise;
    const pending = routeConversationCompaction(owner, { trigger: 'manual', strategy: 'microcompact', messages: c.host.getMessagesForLLM(), tokenCount: 1000,
      contextWindow: 100_000, threshold: 1000 }, c.host, async () => { calls++; return undefined; }).catch((error: unknown) => error);
    c.host.getMessagesForLLM().push({ role: 'user', content: 'new queued input' }); release.resolve(); await first;
    expect(await pending).toBeInstanceOf(Error); expect(calls).toBe(0); expect(c.replacements).toBe(0); owner.dispose();
  });
});
