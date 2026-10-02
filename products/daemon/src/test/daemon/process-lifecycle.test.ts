import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  runDaemonProcess,
  type DaemonProcessExitCode,
  type DaemonProcessHost,
  type DaemonProcessTimers,
} from '../../daemon/process-lifecycle.js';

function gate<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ProcessFixture extends EventEmitter {
  readonly exits: DaemonProcessExitCode[] = [];
  exit(code: DaemonProcessExitCode): void { this.exits.push(code); }
}

class TimersFixture implements DaemonProcessTimers {
  readonly pending = new Map<unknown, () => void>();
  readonly durations: number[] = [];
  readonly cleared: unknown[] = [];
  setTimeout(callback: () => void, milliseconds: number): unknown {
    const token = {};
    this.durations.push(milliseconds);
    this.pending.set(token, callback);
    return token;
  }
  clearTimeout(token: unknown): void {
    this.cleared.push(token);
    this.pending.delete(token);
  }
  expire(): void { for (const callback of [...this.pending.values()]) callback(); }
}

function fixture(createHost: () => DaemonProcessHost, shutdownTimeoutMs?: number) {
  const process = new ProcessFixture();
  const timers = new TimersFixture();
  const handle = runDaemonProcess(createHost, { process, timers, shutdownTimeoutMs });
  return { process, timers, handle };
}

function expectTerminal(fx: ReturnType<typeof fixture>, code: DaemonProcessExitCode): void {
  expect(fx.process.exits).toEqual([code]);
  expect(fx.process.listenerCount('SIGINT')).toBe(0);
  expect(fx.process.listenerCount('SIGTERM')).toBe(0);
  expect(fx.timers.pending.size).toBe(0);
  expect(fx.timers.cleared).toHaveLength(1);
}

describe('owned daemon process runner', () => {
  test('returns synchronously, installs signals before construction, and preserves readiness', async () => {
    let acquired = false;
    const result = { running: true };
    const fx = fixture(() => {
      acquired = true;
      expect(fx.process.listenerCount('SIGINT')).toBe(1);
      expect(fx.process.listenerCount('SIGTERM')).toBe(1);
      return { async start() { return result; }, async close() {} };
    });
    expect(acquired).toBe(false);
    expect(fx.process.listenerCount('SIGINT')).toBe(1);
    expect(fx.process.listenerCount('SIGTERM')).toBe(1);
    expect(await fx.handle.ready).toBe(result);
    expect(fx.process.exits).toEqual([]);
    expect(await fx.handle.shutdown()).toBe(0);
    expect(fx.timers.durations).toEqual([15_000]);
    expectTerminal(fx, 0);
  });

  test('shutdown before construction closes the acquired host without admitting startup', async () => {
    const calls: string[] = [];
    const fx = fixture(() => {
      calls.push('create');
      return { async start() { calls.push('start'); }, async close() { calls.push('close'); } };
    });
    fx.process.emit('SIGTERM');
    expect(await fx.handle.ready).toBeUndefined();
    expect(await fx.handle.finished).toBe(0);
    expect(calls).toEqual(['create', 'close']);
    expectTerminal(fx, 0);
  });

  test('signal during factory acquisition fences startup and drains its returned owner', async () => {
    let started = false;
    let closed = false;
    const fx = fixture(() => {
      fx.process.emit('SIGINT');
      return { async start() { started = true; }, async close() { closed = true; } };
    });
    await fx.handle.ready;
    expect(await fx.handle.finished).toBe(0);
    expect(started).toBe(false);
    expect(closed).toBe(true);
    expectTerminal(fx, 0);
  });

  test('repeated signals and explicit shutdown share one close, deadline, and promise', async () => {
    const drain = gate();
    let closeCalls = 0;
    const fx = fixture(() => ({ async start() {}, close() { closeCalls++; return drain.promise; } }));
    await fx.handle.ready;
    fx.process.emit('SIGTERM');
    expect(closeCalls).toBe(1);
    const first = fx.handle.shutdown();
    fx.process.emit('SIGINT');
    fx.process.emit('SIGTERM');
    expect(fx.handle.shutdown()).toBe(first);
    expect(first).toBe(fx.handle.finished);
    await setImmediate();
    expect(fx.process.exits).toEqual([]);
    expect(closeCalls).toBe(1);
    expect(fx.timers.durations).toEqual([15_000]);
    drain.resolve();
    expect(await first).toBe(0);
    expectTerminal(fx, 0);
    expect(await fx.handle.shutdown()).toBe(0);
    expect(fx.process.exits).toEqual([0]);
  });

  test('shutdown starts close immediately but cannot exit before pending startup settles', async () => {
    const startup = gate();
    const entered = gate();
    let closed = false;
    const fx = fixture(() => ({
      start() { entered.resolve(); return startup.promise; },
      async close() { closed = true; },
    }));
    await entered.promise;
    fx.process.emit('SIGTERM');
    expect(closed).toBe(true);
    await setImmediate();
    expect(fx.process.exits).toEqual([]);
    startup.resolve();
    await fx.handle.ready;
    expect(await fx.handle.finished).toBe(0);
    expectTerminal(fx, 0);
  });

  test('startup failure initiates and awaits drain, returning only a value-free failure', async () => {
    const drain = gate();
    const entered = gate();
    const fx = fixture(() => ({
      async start() { throw new Error('PRIVATE_STARTUP_DETAILS'); },
      close() { entered.resolve(); return drain.promise; },
    }));
    await expect(fx.handle.ready).rejects.toThrow('Daemon startup failed');
    await entered.promise;
    expect(fx.process.exits).toEqual([]);
    drain.resolve();
    expect(await fx.handle.finished).toBe(1);
    expectTerminal(fx, 1);
  });

  test('factory throws are caught after signal installation and finish nonzero', async () => {
    const fx = fixture(() => { throw { toString() { throw new Error('must never stringify raw failures'); } }; });
    await expect(fx.handle.ready).rejects.toThrow('Daemon startup failed');
    expect(await fx.handle.finished).toBe(1);
    expectTerminal(fx, 1);
  });

  test('a factory failure after an early signal still closes deadline and signal ownership', async () => {
    const fx = fixture(() => { throw new Error('PRIVATE_EARLY_FACTORY_DETAILS'); });
    fx.process.emit('SIGTERM');
    await expect(fx.handle.ready).rejects.toThrow('Daemon startup failed');
    expect(await fx.handle.finished).toBe(1);
    expectTerminal(fx, 1);
  });

  test('terminal cleanup preserves unrelated signal listeners', async () => {
    const process = new ProcessFixture();
    const timers = new TimersFixture();
    const unrelated = () => {};
    process.on('SIGINT', unrelated);
    process.on('SIGTERM', unrelated);
    const handle = runDaemonProcess(() => ({ async start() {}, async close() {} }), { process, timers });
    await handle.ready;
    expect(await handle.shutdown()).toBe(0);
    expect(process.listeners('SIGINT')).toEqual([unrelated]);
    expect(process.listeners('SIGTERM')).toEqual([unrelated]);
    expect(timers.pending.size).toBe(0);
    expect(process.exits).toEqual([0]);
  });

  test('a startup rejection after a clean close can never become exit zero', async () => {
    const startup = gate();
    const entered = gate();
    const fx = fixture(() => ({ start() { entered.resolve(); return startup.promise; }, async close() {} }));
    await entered.promise;
    fx.process.emit('SIGTERM');
    await setImmediate();
    expect(fx.process.exits).toEqual([]);
    startup.reject(new Error('PRIVATE_LATE_STARTUP_DETAILS'));
    await expect(fx.handle.ready).rejects.toThrow('Daemon startup failed');
    expect(await fx.handle.finished).toBe(1);
    expectTerminal(fx, 1);
  });

  for (const synchronous of [false, true]) {
    test(`${synchronous ? 'synchronous' : 'asynchronous'} close failure finishes nonzero and cleans signal/timer ownership`, async () => {
      const fx = fixture(() => ({
        async start() {},
        close() {
          if (synchronous) throw new Error('PRIVATE_CLOSE_DETAILS');
          return Promise.reject(new Error('PRIVATE_CLOSE_DETAILS'));
        },
      }));
      await fx.handle.ready;
      expect(await fx.handle.shutdown()).toBe(1);
      expectTerminal(fx, 1);
    });
  }

  test('deadline bounds a held drain and late completion cannot exit again', async () => {
    const drain = gate();
    const fx = fixture(() => ({ async start() {}, close() { return drain.promise; } }), 23);
    await fx.handle.ready;
    const closing = fx.handle.shutdown();
    expect(fx.timers.durations).toEqual([23]);
    fx.timers.expire();
    expect(await closing).toBe(1);
    expectTerminal(fx, 1);
    drain.resolve();
    await setImmediate();
    expect(fx.process.exits).toEqual([1]);
  });

  test('late close rejection after timeout is observed without another exit', async () => {
    const drain = gate();
    const fx = fixture(() => ({ async start() {}, close() { return drain.promise; } }), 1);
    await fx.handle.ready;
    void fx.handle.shutdown();
    fx.timers.expire();
    expect(await fx.handle.finished).toBe(1);
    drain.reject(new Error('PRIVATE_LATE_CLOSE_DETAILS'));
    await setImmediate();
    expectTerminal(fx, 1);
  });

  test('deadline also bounds pending startup after close settled', async () => {
    const startup = gate();
    const entered = gate();
    const fx = fixture(() => ({ start() { entered.resolve(); return startup.promise; }, async close() {} }), 0);
    await entered.promise;
    fx.process.emit('SIGINT');
    await setImmediate();
    expect(fx.process.exits).toEqual([]);
    expect(fx.timers.durations).toEqual([0]);
    fx.timers.expire();
    expect(await fx.handle.finished).toBe(1);
    expectTerminal(fx, 1);
    startup.resolve();
    await fx.handle.ready;
    expect(fx.process.exits).toEqual([1]);
  });

  test('invalid deadlines are rejected before listeners or acquisition are installed', () => {
    for (const shutdownTimeoutMs of [-1, NaN, Infinity, 2_147_483_648]) {
      const process = new ProcessFixture();
      let acquired = false;
      expect(() => runDaemonProcess(() => {
        acquired = true;
        return { async start() {}, async close() {} };
      }, { process, shutdownTimeoutMs })).toThrow(RangeError);
      expect(acquired).toBe(false);
      expect(process.eventNames()).toEqual([]);
    }
  });
});

function childFixture(mode: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../helpers/process-lifecycle-child.ts', import.meta.url)), mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  const updates = new EventEmitter();
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); updates.emit('change'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { exited = true; updates.emit('change'); resolve({ code, signal }); });
  });
  const waitFor = async (line: string): Promise<void> => {
    const check = () => stdout.split('\n').includes(line);
    if (check()) return;
    await new Promise<void>((resolve, reject) => {
      const checkUpdate = () => {
        if (check()) { cleanup(); resolve(); }
        else if (exited) { cleanup(); reject(new Error(`Child exited before ${line}: ${stdout}\n${stderr}`)); }
      };
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`Child did not reach ${line}: ${stdout}\n${stderr}`)); }, 5_000);
      const cleanup = () => { clearTimeout(timeout); updates.off('change', checkUpdate); };
      updates.on('change', checkUpdate);
      checkUpdate();
    });
  };
  return {
    child, done, waitFor,
    output: () => ({ stdout, stderr, exited }),
    release: (what: 'start' | 'close') => { child.stdin.write(`release-${what}\n`); },
    async cleanup() { if (!exited) child.kill('SIGKILL'); await done; },
  };
}

describe('real Bun process signal ownership', () => {
  test('SIGTERM and duplicate signals wait for delayed close before exit zero', async () => {
    const fx = childFixture('delayed-close');
    try {
      await fx.waitFor('READY');
      expect(fx.child.kill('SIGTERM')).toBe(true);
      await fx.waitFor('CLOSING');
      expect(fx.child.kill('SIGINT')).toBe(true);
      expect(fx.child.kill('SIGTERM')).toBe(true);
      await setImmediate();
      expect(fx.output().exited).toBe(false);
      expect(fx.output().stdout).not.toContain('CLOSED');
      fx.release('close');
      expect(await fx.done).toEqual({ code: 0, signal: null });
      expect(fx.output().stdout.match(/^CLOSING$/gm)).toHaveLength(1);
      expect(fx.output().stdout).toContain('CLOSED\nEXIT:0:0:0');
      expect(fx.output().stderr).toBe('');
    } finally { await fx.cleanup(); }
  }, 10_000);

  test('SIGTERM during asynchronous startup awaits startup and its delayed drain', async () => {
    const fx = childFixture('held-start');
    try {
      await fx.waitFor('STARTING');
      fx.child.kill('SIGTERM');
      await fx.waitFor('CLOSING');
      expect(fx.output().stdout).not.toContain('READY');
      expect(fx.output().exited).toBe(false);
      fx.release('start');
      await fx.waitFor('READY');
      expect(fx.output().exited).toBe(false);
      fx.release('close');
      expect(await fx.done).toEqual({ code: 0, signal: null });
      expect(fx.output().stdout).toContain('CLOSED\nEXIT:0:0:0');
    } finally { await fx.cleanup(); }
  }, 10_000);

  test('startup failure still drains before a value-free nonzero exit', async () => {
    const fx = childFixture('startup-failure');
    try {
      await fx.waitFor('CLOSING');
      expect(fx.output().exited).toBe(false);
      fx.release('close');
      expect(await fx.done).toEqual({ code: 1, signal: null });
      expect(fx.output().stdout).toContain('CLOSED\nEXIT:1:0:0');
      expect(fx.output().stderr).toContain('Daemon startup failed');
      expect(fx.output().stderr).not.toContain('PRIVATE_PROCESS_FAILURE_SENTINEL');
      expect(fx.output().stderr).not.toContain('process-lifecycle-child');
    } finally { await fx.cleanup(); }
  }, 10_000);

  for (const mode of ['factory-failure', 'close-failure', 'timeout']) {
    test(`${mode} exits nonzero with cleaned signal ownership and no private error`, async () => {
      const fx = childFixture(mode);
      try {
        if (mode !== 'factory-failure') { await fx.waitFor('READY'); fx.child.kill('SIGTERM'); }
        expect(await fx.done).toEqual({ code: 1, signal: null });
        expect(fx.output().stdout).toContain('EXIT:1:0:0');
        expect(fx.output().stderr).toContain(mode === 'timeout' ? 'Daemon shutdown deadline exceeded' : `Daemon ${mode === 'factory-failure' ? 'startup' : 'shutdown'} failed`);
        expect(fx.output().stderr).not.toContain('PRIVATE_PROCESS_FAILURE_SENTINEL');
        expect(fx.output().stderr).not.toContain('process-lifecycle-child');
      } finally { await fx.cleanup(); }
    }, 10_000);
  }
});
