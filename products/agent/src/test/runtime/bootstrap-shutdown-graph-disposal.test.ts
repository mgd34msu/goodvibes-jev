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
