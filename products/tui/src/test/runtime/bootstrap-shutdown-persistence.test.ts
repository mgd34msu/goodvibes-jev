import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { createDeferredStartupCoordinator, writeRecoveryFile } from '@/runtime/index.ts';
import { createBootstrapShutdown, type BootstrapShutdownDeps } from '../../runtime/bootstrap-shutdown.ts';
import { installProcessLifecycle, type ProcessLifecycleDeps } from '../../runtime/process-lifecycle.ts';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });
const data = { messages: [{ id: 'kept-message', role: 'user', content: 'Durably preserve this conversation', timestamp: 1 }], timestamp: 2 };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options: { fail?: string; failures?: Map<string, Error>; hold?: { phase: string; promise: Promise<void> } } = {}) {
  const order: string[] = [];
  const failure = new Error(`${options.fail} failed`);
  const step = (name: string) => (): unknown => {
    order.push(name);
    if (name === options.fail) throw failure;
    if (options.failures?.has(name)) throw options.failures.get(name);
    if (name === options.hold?.phase) return options.hold.promise;
  };
  const home = makeProjectTempDir('tui-bootstrap-shutdown');
  restores.push(() => rmSync(home, { recursive: true, force: true }));
  const surface = makeTestSurface(home);
  const manager = new SessionManager(home, { surface });
  const runtime = { sessionId: 'durable-shutdown', model: 'test-model', provider: 'test-provider' };
  const timer = setInterval(() => {}, 60_000);
  restores.push(() => clearInterval(timer));
  const deps: BootstrapShutdownDeps = {
    runtime,
    conversationTitle: () => { step('title')(); return 'Durable test'; },
    bootstrapUnsubs: [step('bootstrap first'), step('bootstrap second')],
    runtimeUnsubs: [step('runtime first'), step('runtime second')],
    forensicsCollector: { dispose: step('forensics') },
    sessionSpine: { close: step('spine close'), dispose: step('spine dispose') },
    sessionInboundInputs: { dispose: step('inbound dispose') },
    sessionUnionCache: { dispose: step('union dispose') },
    leaveHostedSession: step('hosted detach'),
    deferredStartup: { drain: async () => { await step('startup drain')(); } },
    settleExternalServices: step('external settlement'),
    stopExternalServices: step('external stop'),
    agentStatusIntervalRef: { value: timer },
    scheduleManager: { destroy: step('schedule destroy') } as BootstrapShutdownDeps['scheduleManager'],
    hookDispatcher: { fire: async () => { await step('session hook')(); return { ok: true }; } },
    providerRegistry: { stopWatching: step('provider stop') },
    sessionOrchestration: { dispose: step('orchestration dispose') },
    persistenceOptions: { workingDirectory: home, homeDirectory: home, sessionManager: manager },
  };
  const shutdown = createBootstrapShutdown(deps);
  const durableFile = join(surface.sessionsDir, `${runtime.sessionId}.jsonl`);
  const assertSaved = () => {
    expect(existsSync(durableFile)).toBe(true);
    // A fresh reader must recover actual bytes, not a fake save callback.
    const loaded = new SessionManager(home, { surface }).load(runtime.sessionId);
    expect(loaded.messages).toEqual(data.messages);
    expect(loaded.meta).toMatchObject({ model: runtime.model, provider: runtime.provider, timestamp: data.timestamp });
  };
  return { deps, shutdown, home, surface, runtime, durableFile, assertSaved, failure, order };
}

function exitComposition(h: ReturnType<typeof fixture>, hardTimeout = 1_000) {
  const output: string[] = [];
  const diagnostics: string[] = [];
  const logSpy = spyOn(logger, 'debug').mockImplementation((_message, fields) => {
    if (fields && typeof fields === 'object' && 'error' in fields) diagnostics.push(String(fields.error));
  });
  restores.push(() => logSpy.mockRestore());
  const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  restores.push(() => exitSpy.mockRestore());
  const removeSpy = spyOn(process, 'removeListener').mockImplementation(() => process);
  restores.push(() => removeSpy.mockRestore());
  const recoveryFile = h.surface.recoveryFile(h.runtime.sessionId);
  writeRecoveryFile(data, h.runtime.sessionId, 'Recoverable test', { surface: h.surface });
  expect(existsSync(recoveryFile)).toBe(true);
  const recoveryBefore = readFileSync(recoveryFile, 'utf8');
  const ctx = {
    runtime: h.runtime,
    services: { surface: h.surface },
    conversation: { toJSON: () => data, getTitleSource: () => 'user' },
    shutdown: h.shutdown,
  } as unknown as BootstrapContext;
  const handlers = installProcessLifecycle({
    ctx,
    stdin: { setRawMode: () => h.order.push('terminal raw reset'), removeAllListeners: () => {} },
    stdout: { write: (text: string) => { output.push(text); return true; }, removeListener: () => {} },
    noAltScreen: false,
    ansi: { CLEAR_SCREEN: '', ALT_SCREEN_EXIT: 'restore-terminal', PASTE_DISABLE: '', KEYBOARD_EXT_DISABLE: '', MOUSE_DISABLE: '', CURSOR_SHOW: '', FOCUS_DISABLE: '' },
    getInput: () => { throw new Error('unused'); },
    render: () => {},
    getTerminalOutputGuard: () => ({ dispose: () => {} }),
    getPromptContentWidth: () => 80,
    buildSessionContinuityHints: () => ({ pendingApprovals: 0 }),
    unsubs: [],
    getRecoveryInterval: () => null,
    setRecoveryInterval: () => {},
    getStopSpokenOutputForExit: () => null,
    saveNoticeAfterMs: 10_000,
    shutdownHardTimeoutMs: hardTimeout,
  } as unknown as ProcessLifecycleDeps);
  const assertRecoveryKept = () => expect(readFileSync(recoveryFile, 'utf8')).toBe(recoveryBefore);
  return { handlers, exitSpy, diagnostics, output, recoveryFile, assertRecoveryKept };
}

const ownedPhases = ['bootstrap first', 'bootstrap second', 'runtime first', 'runtime second', 'forensics', 'spine close', 'spine dispose', 'inbound dispose', 'union dispose', 'hosted detach', 'startup drain', 'external settlement', 'external stop', 'title'];

describe('bootstrap shutdown preserves durable persistence after owner failures', () => {
  for (const fail of ownedPhases) {
    test(`${fail} failure remains visible after the real session file is saved`, async () => {
      const h = fixture({ fail });
      await expect(h.shutdown(data)).rejects.toBe(h.failure);
      h.assertSaved();
      expect(h.order).toContain('bootstrap second');
      expect(h.order).toContain('runtime second');
      expect(h.order).toContain('external stop');
      expect(h.order).toContain('orchestration dispose');
      expect(h.deps.bootstrapUnsubs).toHaveLength(0);
      expect(h.deps.runtimeUnsubs).toHaveLength(0);
      expect(h.deps.agentStatusIntervalRef.value).toBe(null);
    });
  }

  test('a timer teardown failure cannot strand the timer slot or the real save', async () => {
    const h = fixture();
    const timer = h.deps.agentStatusIntervalRef.value;
    const failure = new Error('agent status timer failed');
    const clear = globalThis.clearInterval;
    const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation((value) => {
      if (value === timer) throw failure;
      Reflect.apply(clear, globalThis, [value]);
    });
    restores.push(() => clearSpy.mockRestore());
    await expect(h.shutdown(data)).rejects.toBe(failure);
    h.assertSaved();
    expect(h.deps.agentStatusIntervalRef.value).toBe(null);
  });

  test('all owner failures reach the actual shell exit diagnostics with durable bytes and recovery intact', async () => {
    const failures = new Map(ownedPhases.map((phase) => [phase, new Error(`${phase} failed`)]));
    const h = fixture({ failures });
    const exit = exitComposition(h);
    await exit.handlers.exitApp();
    h.assertSaved();
    exit.assertRecoveryKept();
    expect(exit.exitSpy).toHaveBeenCalledTimes(1);
    for (const failure of failures.values()) expect(exit.diagnostics).toContain(failure.message);
  });

  test('filesystem persistence failure remains visible, retains real recovery, and still releases SDK owners', async () => {
    const h = fixture();
    // Obstruct the real sessions directory, making the real save fail on disk.
    mkdirSync(join(h.surface.sessionsDir, '..'), { recursive: true });
    writeFileSync(h.surface.sessionsDir, 'a file cannot hold session files');
    const exit = exitComposition(h);
    await exit.handlers.exitApp();
    expect(existsSync(h.durableFile)).toBe(false);
    exit.assertRecoveryKept();
    expect(h.order).toContain('provider stop');
    expect(h.order).toContain('orchestration dispose');
    expect(exit.diagnostics.some((line) => line.includes('failed to persist session'))).toBe(true);
    expect(exit.exitSpy).toHaveBeenCalledTimes(1);
  });

  test('a clean actual exit saves through the SDK and removes the recovery snapshot', async () => {
    const h = fixture();
    const exit = exitComposition(h);
    await exit.handlers.exitApp();
    h.assertSaved();
    expect(existsSync(exit.recoveryFile)).toBe(false);
    expect(exit.exitSpy).toHaveBeenCalledTimes(1);
  });
});

describe('bootstrap shutdown owns ordered asynchronous cleanup', () => {
  for (const phase of ['bootstrap first', 'forensics', 'external settlement', 'external stop']) {
    test(`awaits held ${phase} before saving and exiting`, async () => {
      const hold = deferred();
      const h = fixture({ hold: { phase, promise: hold.promise } });
      const exit = exitComposition(h);
      const first = exit.handlers.exitApp();
      const second = exit.handlers.exitApp();
      expect(exit.handlers.isTerminalRestored()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.order).toContain(phase);
      expect(existsSync(h.durableFile)).toBe(false);
      expect(exit.exitSpy).not.toHaveBeenCalled();
      hold.resolve();
      await Promise.all([first, second]);
      h.assertSaved();
      expect(exit.exitSpy).toHaveBeenCalledTimes(1);
    });
  }

  test('hosted rejection does not abandon an in-flight deferred-startup drain', async () => {
    const hold = deferred();
    const h = fixture({ fail: 'hosted detach', hold: { phase: 'startup drain', promise: hold.promise } });
    const result = h.shutdown(data).then(() => undefined, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.order).toContain('startup drain');
    expect(h.order).not.toContain('external settlement');
    expect(existsSync(h.durableFile)).toBe(false);
    hold.resolve();
    expect(await result).toBe(h.failure);
    h.assertSaved();
  });

  test('multiple asynchronous failures preserve invocation order, not resolution order', async () => {
    const h = fixture();
    const held = deferred();
    const first = new Error('first: hosted');
    const second = new Error('second: startup');
    const deps = { ...h.deps, leaveHostedSession: () => held.promise, deferredStartup: { drain: async () => { throw second; } } };
    const shutdown = createBootstrapShutdown(deps);
    const result = shutdown(data).then(() => undefined, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    held.reject(first);
    const failure = await result as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([first, second]);
    h.assertSaved();
  });

  test('reentrant, concurrent, and repeated calls share one result and do not repeat owners', async () => {
    const h = fixture({ fail: 'forensics' });
    let reentrant: Promise<void> | undefined;
    h.deps.bootstrapUnsubs.unshift(() => { reentrant = h.shutdown(data); });
    const first = h.shutdown(data);
    expect(h.shutdown(data)).toBe(first);
    await expect(first).rejects.toBe(h.failure);
    expect(reentrant).toBe(first);
    expect(h.shutdown(data)).toBe(first);
    h.assertSaved();
    expect(h.order.filter((phase) => phase === 'external stop')).toHaveLength(1);
  });

  test('a direct self-returning callback is reported and does not strand the durable save', async () => {
    const h = fixture();
    h.deps.bootstrapUnsubs.unshift(() => h.shutdown(data));
    await expect(h.shutdown(data)).rejects.toThrow('cannot await its own shutdown');
    h.assertSaved();
  });

  test('the shell deadline keeps recovery when an owner has not released authority', async () => {
    const h = fixture({ hold: { phase: 'external settlement', promise: new Promise(() => {}) } });
    const exit = exitComposition(h, 20);
    await exit.handlers.exitApp();
    expect(existsSync(h.durableFile)).toBe(false);
    exit.assertRecoveryKept();
    expect(h.order).not.toContain('external stop');
    expect(exit.output.join('')).toContain('a recovery snapshot was kept');
    expect(exit.exitSpy).toHaveBeenCalledTimes(1);
  });

  test('an admitted external startup settles and its exact handle stops before the real save', async () => {
    const h = fixture();
    const admitted = deferred();
    const scheduled: Array<() => void> = [];
    const deferredStartup = createDeferredStartupCoordinator((run) => { scheduled.push(run); });
    let current = { stop: async () => { h.order.push('placeholder stop'); } };
    let startup: Promise<typeof current> | null = null;
    const started = deferredStartup.schedule({ label: 'external test', run: async () => {
      startup = admitted.promise.then(() => ({ stop: async () => { h.order.push('admitted handle stop'); } }));
      current = await startup;
    } });
    scheduled[0]!();
    await Promise.resolve();
    const shutdown = createBootstrapShutdown({ ...h.deps, deferredStartup,
      settleExternalServices: async () => { if (startup) current = await startup; },
      stopExternalServices: () => current.stop(),
    });
    const pending = shutdown(data);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(existsSync(h.durableFile)).toBe(false);
    expect(h.order).not.toContain('placeholder stop');
    admitted.resolve();
    await Promise.all([started, pending]);
    h.assertSaved();
    expect(h.order.indexOf('admitted handle stop')).toBeLessThan(h.order.indexOf('schedule destroy'));
    expect(h.order).not.toContain('placeholder stop');
  });
});
