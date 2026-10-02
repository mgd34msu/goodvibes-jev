/**
 * bootstrap-shutdown-graph-disposal.test.ts
 *
 * runtime-shutdown-timer-teardown.test.ts proves `RuntimeServices.dispose()`
 * actually stops the graph's pollers. It calls dispose() directly, so it says
 * nothing about whether the session shutdown path ever calls it, and a
 * disposal seam nobody invokes leaks exactly as much as no seam at all.
 *
 * This file pins the call site: the session teardown must dispose the graph,
 * must do it after the runtime shutdown that still needs those schedulers, and
 * must do it even when that shutdown fails.
 */

import { afterAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';

import { createRuntimeShutdown, type RuntimeShutdownDependencies } from '@/runtime/bootstrap-shutdown.ts';
import { makeLongLivedProjectTempDir } from '../helpers/project-temp.ts';

type Deps = RuntimeShutdownDependencies;

/**
 * Session persistence writes for real; give it somewhere disposable to
 * write. Long-lived (shared across every test in this file, not per-test):
 * this file's own explicit afterAll below already cleans it up correctly at
 * file-end, so it must not also go through makeProjectTempDir's per-test
 * sweep, which would delete it after the first test instead.
 */
const workingDirectory = makeLongLivedProjectTempDir('agent-shutdown-wiring');
afterAll(() => { rmSync(workingDirectory, { recursive: true, force: true }); });

/**
 * Minimal stand-ins for the collaborators teardown touches. Everything is a
 * no-op except the ordering log, so the assertions below are about sequence and
 * reachability rather than any collaborator's behavior.
 */
function makeDeps(order: string[], overrides: Partial<Deps> = {}): Deps {
  const noop = (): void => {};
  return {
    sessionId: 'session-under-test',
    model: 'test-model',
    provider: 'test-provider',
    conversationTitle: () => 'title',
    sessionSpineClient: { close: noop, dispose: noop },
    takeMemorySpineTimer: () => null,
    bootstrapUnsubs: [],
    runtimeUnsubs: [],
    forensicsCollector: { dispose: noop },
    executionLedger: { dispose: noop },
    disposeSessionWriteLedger: () => { order.push('write-ledger'); },
    deferredStartup: { drain: async () => undefined },
    agentExternalServices: { stop: async () => undefined },
    agentStatusIntervalRef: { value: null },
    scheduleManager: { destroy: () => { order.push('schedule-manager'); } } as Deps['scheduleManager'],
    hookDispatcher: null as Deps['hookDispatcher'],
    providerRegistry: { stopWatching: () => { order.push('provider-registry'); } } as Deps['providerRegistry'],
    sessionOrchestration: { dispose: noop } as Deps['sessionOrchestration'],
    shutdownOptions: { workingDirectory } as unknown as Deps['shutdownOptions'],
    disposeRuntimeGraph: () => { order.push('graph-dispose'); },
    ...overrides,
  };
}

/** shutdownRuntime persists the conversation; an empty snapshot is enough. */
const SESSION_DATA = { messages: [] } as unknown as Parameters<ReturnType<typeof createRuntimeShutdown>>[0];

test('session teardown disposes the runtime graph', async () => {
  const order: string[] = [];
  await createRuntimeShutdown(makeDeps(order))(SESSION_DATA);
  expect(order).toContain('graph-dispose');
});

test('the graph is disposed last: after the shutdown that still needs its schedulers', async () => {
  const order: string[] = [];
  await createRuntimeShutdown(makeDeps(order))(SESSION_DATA);
  // Whatever else ran, the graph teardown is the final act: the steps before it
  // legitimately use the scheduler, orchestration registry and provider
  // registry that dispose() stops.
  expect(order.at(-1)).toBe('graph-dispose');
  expect(order.indexOf('write-ledger')).toBeLessThan(order.indexOf('graph-dispose'));
});

test('the graph is disposed even when an earlier teardown step throws', async () => {
  const order: string[] = [];
  // A step that fails must not strand the ones after it, and a process whose
  // external services will not stop is precisely the one that must still let go
  // of its timers. The failure is raised well before the graph teardown, which
  // is exactly why it is worth pinning.
  const shutdown = createRuntimeShutdown(makeDeps(order, {
    agentExternalServices: { stop: async () => { throw new Error('external services refused to stop'); } },
  }));
  await expect(shutdown(SESSION_DATA)).rejects.toThrow('external services refused to stop');
  expect(order).toContain('graph-dispose');
});

test('the graph is disposed when the session could not be persisted', async () => {
  const order: string[] = [];
  // shutdownRuntime rethrows when saveSession fails. Same property at the LAST
  // step rather than a middle one: losing the conversation must not also cost
  // the process its timer teardown. Persistence fails here because no working
  // directory is in scope to write into.
  const shutdown = createRuntimeShutdown(makeDeps(order, {
    shutdownOptions: {} as unknown as Deps['shutdownOptions'],
  }));
  await expect(shutdown(SESSION_DATA)).rejects.toThrow(/failed to persist session/);
  expect(order).toContain('graph-dispose');
});

// An owner failure must not prevent later owners from releasing their resources.
test('early close failure still reaches every later owned teardown', async () => {
  const order: string[] = [];
  const failure = new Error('spine close failed');
  const deps = makeDeps(order, {
    sessionSpineClient: { close: () => { order.push('close'); throw failure; }, dispose: () => { order.push('spine-dispose'); } },
    bootstrapUnsubs: [() => { order.push('bootstrap-unsub'); }],
    runtimeUnsubs: [() => { order.push('runtime-unsub'); }],
    forensicsCollector: { dispose: () => { order.push('forensics'); } },
    executionLedger: { dispose: () => { order.push('execution'); } },
    deferredStartup: { drain: async () => { order.push('drain'); } },
    agentExternalServices: { stop: async () => { order.push('external-stop'); } },
  });
  await expect(createRuntimeShutdown(deps)(SESSION_DATA)).rejects.toBe(failure);
  expect(order).toEqual(['close', 'spine-dispose', 'bootstrap-unsub', 'runtime-unsub', 'forensics', 'execution', 'write-ledger', 'drain', 'external-stop', 'schedule-manager', 'provider-registry', 'graph-dispose']);
  expect(deps.bootstrapUnsubs).toHaveLength(0);
  expect(deps.runtimeUnsubs).toHaveLength(0);
});

test('an unsubscribe failure does not strand other subscriptions or async owners', async () => {
  const order: string[] = [];
  const failure = new Error('unsubscribe failed');
  const deps = makeDeps(order, {
    bootstrapUnsubs: [() => { order.push('broken'); throw failure; }, () => { order.push('remaining'); }],
    agentExternalServices: { stop: async () => { await Promise.resolve(); order.push('external-stopped'); } },
  });
  await expect(createRuntimeShutdown(deps)(SESSION_DATA)).rejects.toBe(failure);
  expect(order).toContain('remaining');
  expect(order).toContain('external-stopped');
  expect(order.at(-1)).toBe('graph-dispose');
  expect(deps.bootstrapUnsubs).toHaveLength(0);
});

test('multiple early, middle and final failures remain visible in original order', async () => {
  const order: string[] = [];
  const early = new Error('early rejection');
  const middle = new Error('middle rejection');
  const late = new Error('graph rejection');
  const shutdown = createRuntimeShutdown(makeDeps(order, {
    sessionSpineClient: { close: async () => { throw early; }, dispose: () => { order.push('spine-dispose'); } },
    agentExternalServices: { stop: async () => { order.push('external-stop'); throw middle; } },
    disposeRuntimeGraph: async () => { order.push('graph-dispose'); throw late; },
  }));
  const failure = await shutdown(SESSION_DATA).then(() => null, error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([early, middle, late]);
  expect(order).toContain('schedule-manager');
  expect(order.at(-1)).toBe('graph-dispose');
});

test('awaits each asynchronous owner before disposing the next one', async () => {
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const shutdown = createRuntimeShutdown(makeDeps(order, {
    forensicsCollector: { dispose: async () => { order.push('forensics-start'); await held; order.push('forensics-end'); } },
    executionLedger: { dispose: () => { order.push('execution'); } },
  }));
  const pending = shutdown(SESSION_DATA);
  for (let i = 0; i < 30 && !order.includes('forensics-start'); i++) await Promise.resolve();
  expect(order).toContain('forensics-start');
  expect(order).not.toContain('execution');
  expect(order).not.toContain('graph-dispose');
  release();
  await pending;
  expect(order.indexOf('forensics-end')).toBeLessThan(order.indexOf('execution'));
});

test('concurrent, reentrant and later close calls share one owned teardown', async () => {
  const order: string[] = [];
  let reentrant: Promise<void> | undefined;
  let shutdown!: ReturnType<typeof createRuntimeShutdown>;
  shutdown = createRuntimeShutdown(makeDeps(order, {
    sessionSpineClient: { close: () => { order.push('close'); reentrant = shutdown(SESSION_DATA); }, dispose: () => { order.push('spine-dispose'); } },
  }));
  const first = shutdown(SESSION_DATA);
  expect(shutdown(SESSION_DATA)).toBe(first);
  await first;
  expect(reentrant).toBe(first);
  expect(shutdown(SESSION_DATA)).toBe(first);
  expect(order.filter(entry => entry === 'close')).toHaveLength(1);
  expect(order.filter(entry => entry === 'graph-dispose')).toHaveLength(1);
});

test('failed close is also stable on repeat and does not repeat effects', async () => {
  const order: string[] = [];
  const failure = new Error('owned graph rejected');
  const shutdown = createRuntimeShutdown(makeDeps(order, { disposeRuntimeGraph: async () => { order.push('graph-dispose'); throw failure; } }));
  const first = shutdown(SESSION_DATA);
  await expect(first).rejects.toBe(failure);
  expect(shutdown(SESSION_DATA)).toBe(first);
  await expect(shutdown(SESSION_DATA)).rejects.toBe(failure);
  expect(order.filter(entry => entry === 'graph-dispose')).toHaveLength(1);
});

test('unavailable title does not prevent SDK shutdown and graph disposal', async () => {
  const order: string[] = [];
  const failure = new Error('title getter failed');
  await expect(createRuntimeShutdown(makeDeps(order, { conversationTitle: () => { throw failure; } }))(SESSION_DATA)).rejects.toBe(failure);
  expect(order).toContain('schedule-manager');
  expect(order).toContain('provider-registry');
  expect(order.at(-1)).toBe('graph-dispose');
});

test('a callback returning its own close promise reports a cycle and releases later owners', async () => {
  const order: string[] = [];
  let shutdown!: ReturnType<typeof createRuntimeShutdown>;
  shutdown = createRuntimeShutdown(makeDeps(order, {
    sessionSpineClient: { close: () => shutdown(SESSION_DATA), dispose: () => { order.push('spine-dispose'); } },
  }));
  await expect(shutdown(SESSION_DATA)).rejects.toThrow('cannot await its own shutdown');
  expect(order).toContain('spine-dispose');
  expect(order.at(-1)).toBe('graph-dispose');
});
