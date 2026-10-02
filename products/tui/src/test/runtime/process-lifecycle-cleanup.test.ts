import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { livenessMarkerPathFor, writeLivenessMarker } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { installProcessLifecycle, type ProcessLifecycleDeps } from '../../runtime/process-lifecycle.ts';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import { ALT_SCREEN_EXIT, CLEAR_SCREEN, CURSOR_SHOW, FOCUS_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, PASTE_DISABLE } from '../../renderer/terminal-escapes.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeHarness(options: {
  fail?: string;
  reject?: string;
  held?: { phase: string; promise: Promise<void> };
  shutdownHardTimeoutMs?: number;
  diagnosticsThrow?: boolean;
  onUnsubscribe?: () => void;
} = {}) {
  const events: string[] = [];
  const chunks: string[] = [];
  const phase = (name: string): void | Promise<void> => {
    events.push(name);
    if (options.fail === name) throw new Error(`${name} failed`);
    if (options.reject === name) return Promise.reject(new Error(`${name} rejected`));
    if (options.held?.phase === name) return options.held.promise;
  };
  const home = makeProjectTempDir('gv-exit-cleanup');
  restorers.push(() => rmSync(home, { recursive: true, force: true }));
  const surface = makeTestSurface(home);
  const sessionId = 'cleanup-session';
  const recoveryFile = surface.recoveryFile(sessionId);
  mkdirSync(dirname(recoveryFile), { recursive: true });
  writeFileSync(recoveryFile, 'recovery must survive an unconfirmed save');
  writeLivenessMarker(surface, sessionId, process.pid);
  const markerFile = livenessMarkerPathFor(surface, sessionId);
  const interval = setInterval(() => {}, 60_000);
  restorers.push(() => clearInterval(interval));
  let recoveryInterval: ReturnType<typeof setInterval> | null = interval;
  const clear = globalThis.clearInterval;
  const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation((timer) => {
    if (timer === interval) phase('clear interval');
    return clear(timer);
  });
  restorers.push(() => clearSpy.mockRestore());
  const exitSpy = spyOn(process, 'exit').mockImplementation((code) => { events.push(`exit ${code}`); return undefined as never; });
  restorers.push(() => exitSpy.mockRestore());
  const remove = process.removeListener;
  const removeSpy = spyOn(process, 'removeListener').mockImplementation((name, listener) => {
    if (name === 'SIGINT' || name === 'unhandledRejection') {
      phase(`remove ${name}`);
      return process;
    }
    return remove.call(process, name, listener);
  });
  restorers.push(() => removeSpy.mockRestore());
  const debugSpy = spyOn(logger, 'debug').mockImplementation(() => {
    if (options.diagnosticsThrow) throw new Error('diagnostic failed');
  });
  restorers.push(() => debugSpy.mockRestore());
  const errorSpy = spyOn(logger, 'error').mockImplementation(() => { phase('error log'); });
  restorers.push(() => errorSpy.mockRestore());
  const flushSpy = spyOn(logger, 'flushSync').mockImplementation(() => { phase('flush'); });
  restorers.push(() => flushSpy.mockRestore());
  let surfaceReads = 0;
  const saved: unknown[] = [];
  const snapshot = { messages: [{ id: 'message', role: 'user', content: 'keep this message', timestamp: 1 }], timestamp: 2 };
  const ctx = {
    conversation: {
      toJSON: () => { phase('snapshot'); return snapshot; },
      getTitleSource: () => { phase('title'); return 'user'; },
    },
    runtime: { sessionId },
    services: { get surface() {
      // The first access finalizes recovery; the second retires liveness.
      phase(surfaceReads++ === 0 ? 'recovery surface' : 'liveness surface');
      return surface;
    } },
    shutdown: (data: unknown) => { saved.push(data); return Promise.resolve(phase('shutdown')); },
  } as unknown as BootstrapContext;
  const deps = {
    stdin: {
      setRawMode: () => { phase('raw mode'); },
      removeAllListeners: () => { phase('remove data'); },
    },
    stdout: {
      write: (text: string) => {
        phase(text.includes(ALT_SCREEN_EXIT) ? 'terminal write' : 'receipt');
        chunks.push(text);
        return true;
      },
      removeListener: () => { phase('remove resize'); },
    },
    ctx,
    noAltScreen: false,
    ansi: { ALT_SCREEN_EXIT, CLEAR_SCREEN, CURSOR_SHOW, FOCUS_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, PASTE_DISABLE },
    getInput: () => { throw new Error('unused'); },
    render: () => {},
    getTerminalOutputGuard: () => { phase('get output guard'); return { dispose: () => { phase('dispose output guard'); } }; },
    getPromptContentWidth: () => 80,
    buildSessionContinuityHints: () => { phase('continuity'); return { pendingApprovals: 0, activeTasks: 2 }; },
    unsubs: [() => { options.onUnsubscribe?.(); return phase('unsubscribe first'); }, () => phase('unsubscribe second')],
    getRecoveryInterval: () => { phase('get interval'); return recoveryInterval; },
    setRecoveryInterval: (value: null) => { phase('reset interval'); recoveryInterval = value; },
    getStopSpokenOutputForExit: () => { phase('get speech'); return () => phase('speech'); },
    saveNoticeAfterMs: 10_000,
    shutdownHardTimeoutMs: options.shutdownHardTimeoutMs ?? 1_000,
    recoverySnapshotExists: () => { phase('recovery exists'); return true; },
  } as unknown as ProcessLifecycleDeps;
  const handlers = installProcessLifecycle(deps);
  return { handlers, events, chunks, saved, snapshot, exitSpy, recoveryFile, markerFile };
}

const synchronousCleanup = [
  'get speech', 'speech', 'unsubscribe first', 'unsubscribe second',
  'get interval', 'clear interval', 'reset interval', 'remove data', 'remove resize',
  'remove SIGINT', 'remove unhandledRejection', 'terminal write', 'get output guard',
  'dispose output guard', 'raw mode',
];

describe('exitApp composes independent cleanup phases', () => {
  for (const fail of synchronousCleanup) {
    test(`${fail} throwing still restores, saves, retires liveness, and exits once`, async () => {
      const h = makeHarness({ fail });
      const first = h.handlers.exitApp();
      expect(h.handlers.isTerminalRestored()).toBe(true);
      const repeated = h.handlers.exitApp();
      await Promise.all([first, repeated]);
      await h.handlers.exitApp();
      expect(h.events).toContain('unsubscribe second');
      expect(h.events).toContain('raw mode');
      expect(h.events).toContain('shutdown');
      expect(h.events.indexOf('terminal write')).toBeLessThan(h.events.indexOf('shutdown'));
      expect(h.events.slice(-2)).toEqual(['flush', 'exit 0']);
      expect(h.exitSpy).toHaveBeenCalledTimes(1);
      expect(h.saved).toHaveLength(1);
      expect(existsSync(h.recoveryFile)).toBe(false);
      expect(existsSync(h.markerFile)).toBe(false);
    });
  }

  for (const fail of ['title', 'continuity']) {
    test(`${fail} throwing preserves the original snapshot for shutdown`, async () => {
      const h = makeHarness({ fail });
      await h.handlers.exitApp();
      expect(h.saved[0]).toMatchObject(h.snapshot);
      expect(h.exitSpy).toHaveBeenCalledWith(0);
      expect(existsSync(h.recoveryFile)).toBe(false);
    });
  }

  test('the awaited continuity context reaches the durable save', async () => {
    const h = makeHarness();
    await h.handlers.exitApp();
    expect(h.saved[0]).toMatchObject({ ...h.snapshot, titleSource: 'user', returnContext: { activeTasks: 2 } });
  });

  for (const fail of ['snapshot', 'shutdown']) {
    test(`${fail} throwing preserves recovery and still finalizes exit`, async () => {
      const h = makeHarness({ fail, diagnosticsThrow: true });
      await expect(h.handlers.exitApp()).resolves.toBeUndefined();
      expect(h.events).toContain('raw mode');
      expect(h.events.slice(-2)).toEqual(['flush', 'exit 0']);
      expect(existsSync(h.recoveryFile)).toBe(true);
      expect(existsSync(h.markerFile)).toBe(false);
    });
  }

  for (const fail of ['recovery surface', 'liveness surface', 'flush']) {
    test(`${fail} throwing cannot skip subsequent finalization or exit`, async () => {
      const h = makeHarness({ fail });
      await expect(h.handlers.exitApp()).resolves.toBeUndefined();
      expect(h.events).toContain('liveness surface');
      expect(h.events).toContain('flush');
      expect(h.events.at(-1)).toBe('exit 0');
    });
  }

  for (const fail of ['recovery exists', 'receipt']) {
    test(`${fail} throwing after save failure still removes the marker and exits`, async () => {
      const h = makeHarness({ fail, reject: 'shutdown' });
      await expect(h.handlers.exitApp()).resolves.toBeUndefined();
      expect(existsSync(h.recoveryFile)).toBe(true);
      expect(existsSync(h.markerFile)).toBe(false);
      expect(h.exitSpy).toHaveBeenCalledTimes(1);
    });
  }
});

describe('exitApp owns asynchronous cleanup and repeated requests', () => {
  for (const phase of ['speech', 'unsubscribe first', 'shutdown']) {
    test(`a held ${phase} keeps every exit caller pending until it drains`, async () => {
      const held = deferred();
      const h = makeHarness({ held: { phase, promise: held.promise } });
      const first = h.handlers.exitApp();
      const second = h.handlers.exitApp();
      let completed = 0;
      void first.then(() => { completed++; });
      void second.then(() => { completed++; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.handlers.isTerminalRestored()).toBe(true);
      expect(h.events).toContain('unsubscribe second');
      expect(h.events).toContain('shutdown');
      expect(completed).toBe(0);
      expect(h.exitSpy).not.toHaveBeenCalled();
      held.resolve();
      await Promise.all([first, second]);
      expect(completed).toBe(2);
      expect(h.exitSpy).toHaveBeenCalledTimes(1);
    });
  }

  for (const reject of ['speech', 'unsubscribe first', 'shutdown']) {
    test(`${reject} rejecting does not abandon another pending drain`, async () => {
      const held = deferred();
      const h = makeHarness({ reject, held: { phase: 'unsubscribe second', promise: held.promise } });
      const exit = h.handlers.exitApp();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.exitSpy).not.toHaveBeenCalled();
      held.resolve();
      await exit;
      expect(h.exitSpy).toHaveBeenCalledTimes(1);
      expect(existsSync(h.recoveryFile)).toBe(reject === 'shutdown');
    });
  }

  test('a reentrant request from unsubscribe joins the already-owned exit', async () => {
    let reentrant: Promise<void> | undefined;
    const held = deferred();
    const h = makeHarness({
      held: { phase: 'shutdown', promise: held.promise },
      onUnsubscribe: () => { reentrant = h.handlers.exitApp(); },
    });
    const first = h.handlers.exitApp();
    expect(reentrant).toBe(first);
    held.resolve();
    await first;
    expect(h.exitSpy).toHaveBeenCalledTimes(1);
  });

  test('the hard deadline bounds held cleanup and leaves an unconfirmed save recoverable', async () => {
    const held = deferred();
    const h = makeHarness({ held: { phase: 'shutdown', promise: held.promise }, shutdownHardTimeoutMs: 20 });
    await h.handlers.exitApp();
    expect(existsSync(h.recoveryFile)).toBe(true);
    expect(existsSync(h.markerFile)).toBe(false);
    held.resolve();
    await Promise.resolve();
    await h.handlers.exitApp();
    expect(existsSync(h.recoveryFile)).toBe(true);
    expect(h.exitSpy).toHaveBeenCalledTimes(1);
  });

  test('the hard deadline also bounds a speech drain that never settles', async () => {
    const h = makeHarness({ held: { phase: 'speech', promise: new Promise(() => {}) }, shutdownHardTimeoutMs: 20 });
    const outcome = await Promise.race([
      h.handlers.exitApp().then(() => 'exited'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 100)),
    ]);
    expect(outcome).toBe('exited');
    expect(h.exitSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(h.recoveryFile)).toBe(false);
  });
});


describe('crash and termination exits retain their synchronous exit codes', () => {
  for (const fail of ['terminal write', 'dispose output guard', 'error log', 'flush']) {
    for (const [signal, code] of [['SIGHUP', 129], ['SIGTERM', 143], ['uncaughtException', 1]] as const) {
      test(`${signal} still restores and exits when ${fail} throws`, () => {
        const h = makeHarness({ fail, diagnosticsThrow: true });
        if (signal === 'uncaughtException') h.handlers.uncaughtExceptionHandler(new Error('crash'));
        else h.handlers.terminationSignalHandler(signal);
        h.handlers.exitListener();
        expect(h.events.filter((event) => event === 'terminal write')).toHaveLength(1);
        expect(h.events).toContain('raw mode');
        expect(h.events.slice(-2)).toEqual(['flush', `exit ${code}`]);
        expect(h.exitSpy).toHaveBeenCalledTimes(1);
      });
    }
  }
});
