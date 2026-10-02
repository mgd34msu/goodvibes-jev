import { expect, test } from 'bun:test';
import { createDaemonBootController, type DaemonBootAttachment, type DaemonBootOperations } from '../../runtime/boot-tasks.js';

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<DaemonBootOperations> = {}) {
  const events: string[] = [];
  const owner = (name: string): DaemonBootAttachment => ({
    attach() { events.push(`attach:${name}`); },
    close() { events.push(`close:${name}`); },
  });
  const operations: DaemonBootOperations = {
    async foldMemory() { events.push('fold'); },
    startProviderWatch() { events.push('watch'); },
    stopProviderWatch() { events.push('stop-watch'); },
    createWebhooks() { events.push('create:webhooks'); return owner('webhooks'); },
    createNotifier() { events.push('create:notifier'); return owner('notifier'); },
    async synchronizeServices() { events.push('services'); },
    async initializePlugins() { events.push('plugins'); },
    async closePlugins() { events.push('close:plugins'); },
    reportFailure(step) { events.push(`failure:${step}`); },
    ...overrides,
  };
  return { events, operations, owner, controller: createDaemonBootController(operations) };
}

test('boot starts once and closes acquired owners before later use is refused', async () => {
  const fx = fixture();
  const starting = fx.controller.start();
  expect(fx.controller.start()).toBe(starting);
  expect((await starting).state).toBe('ready');
  expect(fx.events).toEqual(['fold', 'watch', 'create:webhooks', 'attach:webhooks', 'create:notifier', 'attach:notifier', 'services', 'plugins']);
  const closing = fx.controller.close();
  expect(fx.controller.close()).toBe(closing);
  await closing;
  expect(fx.events.slice(-4)).toEqual(['close:plugins', 'close:notifier', 'close:webhooks', 'stop-watch']);
  expect(fx.controller.snapshot().state).toBe('closed');
  await expect(fx.controller.start()).rejects.toThrow('closed');
});

test('close before start acquires nothing', async () => {
  const fx = fixture();
  await fx.controller.close();
  await expect(fx.controller.start()).rejects.toThrow('closed');
  expect(fx.events).toEqual([]);
  expect(fx.controller.snapshot().steps.every((step) => step.state === 'skipped')).toBe(true);
});

test('held acquisition is closed after arrival without late attachment or later boot steps', async () => {
  const entered = gate(); const acquired = gate<DaemonBootAttachment>(); const cleanup = gate(); const cleanupEntered = gate();
  const watchStopped = gate();
  const fx = fixture({
    createNotifier() { entered.resolve(); return acquired.promise; },
    stopProviderWatch() { fx.events.push('stop-watch'); watchStopped.resolve(); },
  });
  const starting = fx.controller.start();
  await entered.promise;
  let closed = false;
  const closing = fx.controller.close().then(() => { closed = true; });
  await watchStopped.promise;
  expect(fx.events).toContain('close:webhooks');
  expect(fx.events).toContain('stop-watch');
  expect(closed).toBe(false);
  acquired.resolve({ attach() { fx.events.push('late-attachment'); }, close() { cleanupEntered.resolve(); return cleanup.promise; } });
  await cleanupEntered.promise;
  expect(closed).toBe(false);
  expect(fx.events).not.toContain('late-attachment');
  cleanup.resolve();
  await starting; await closing;
  expect(fx.events).not.toContain('services');
  expect(fx.events).not.toContain('plugins');
  expect(fx.controller.snapshot().steps.find((step) => step.name === 'notifier')?.state).toBe('skipped');
});

test('a failed attachment is retired before subsequent boot steps run', async () => {
  let listening = false;
  const fx = fixture({
    createWebhooks() { return { attach() { listening = true; throw new Error('fixture attach failed'); }, close() { listening = false; } }; },
    async synchronizeServices() { expect(listening).toBe(false); },
  });
  try {
    const result = await fx.controller.start();
    expect(result.state).toBe('degraded');
    expect(listening).toBe(false);
    expect(fx.events).toContain('failure:webhooks');
    expect(fx.events).toContain('plugins');
  } finally { await fx.controller.close(); }
});

test('a factory failure is visible and does not skip independent plugin initialization', async () => {
  const fx = fixture({ createNotifier() { throw new Error('fixture credential read failed'); } });
  try {
    const result = await fx.controller.start();
    expect(result.state).toBe('degraded');
    expect(result.steps.find((step) => step.name === 'notifier')?.state).toBe('failed');
    expect(fx.events).toContain('plugins');
  } finally { await fx.controller.close(); }
});

test('shutdown fences later tasks while an uncancellable memory fold remains visibly pending', async () => {
  const entered = gate(); const fold = gate();
  const fx = fixture({ foldMemory() { entered.resolve(); return fold.promise; } });
  const starting = fx.controller.start(); await entered.promise;
  let done = false;
  const closing = fx.controller.close().then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(fx.controller.snapshot().state).toBe('closing');
  expect(fx.controller.snapshot().steps.find((step) => step.name === 'memory-fold')?.state).toBe('running');
  fold.resolve(); await starting; await closing;
  expect(fx.events).toEqual([]);
  expect(fx.controller.snapshot().state).toBe('closed');
});

test('plugin shutdown begins while its admitted initialization is held', async () => {
  const entered = gate(); const initialization = gate(); const shutdownEntered = gate();
  const fx = fixture({ initializePlugins() { entered.resolve(); return initialization.promise; }, async closePlugins() { shutdownEntered.resolve(); await initialization.promise; } });
  const starting = fx.controller.start(); await entered.promise;
  let done = false;
  const closing = fx.controller.close().then(() => { done = true; });
  await shutdownEntered.promise;
  expect(done).toBe(false);
  initialization.resolve(); await starting; await closing;
  expect(fx.controller.snapshot().state).toBe('closed');
});

test('cleanup failure is bounded while all remaining owners retire', async () => {
  const failure = new Error('fixture cleanup failed');
  const fx = fixture({ async closePlugins() { throw failure; } });
  await fx.controller.start();
  await expect(fx.controller.close()).rejects.toMatchObject({ failures: [{ label: 'plugins', error: new Error('plugins cleanup failed') }] });
  expect(fx.events.slice(-3)).toEqual(['close:notifier', 'close:webhooks', 'stop-watch']);
  expect(fx.controller.snapshot().state).toBe('failed');
});

test('a failed boot instance can close before a fresh instance retries', async () => {
  const first = fixture({ createNotifier() { throw new Error('fixture first acquisition failed'); } });
  expect((await first.controller.start()).state).toBe('degraded');
  await first.controller.close();
  const second = fixture();
  try { expect((await second.controller.start()).state).toBe('ready'); }
  finally { await second.controller.close(); }
});

test('an arbitrary rejected value is not inspected or passed into boot reporting', async () => {
  let inspected = 0;
  const failure = new Proxy({}, { getPrototypeOf() { inspected++; throw new Error('fixture private prototype'); }, get() { inspected++; throw new Error('fixture private property'); } });
  const reports: unknown[][] = [];
  const fx = fixture({
    async foldMemory() { throw failure; },
    reportFailure(...args) { reports.push(args); },
  });
  try {
    expect((await fx.controller.start()).state).toBe('degraded');
    expect(inspected).toBe(0);
    expect(reports).toEqual([['memory-fold']]);
    expect(fx.events).toContain('watch');
    expect(fx.events).toContain('plugins');
  } finally { await fx.controller.close(); }
});

test.each([false, true])('a rejected reporter cannot escape or skip later boot steps (async=%s)', async (asynchronous) => {
  const failure = new Proxy({}, { getPrototypeOf() { throw new Error('fixture private prototype'); } });
  const fx = fixture({
    async foldMemory() { throw undefined; },
    reportFailure() { if (asynchronous) return Promise.reject(failure); throw failure; },
  });
  try {
    expect((await fx.controller.start()).state).toBe('degraded');
    expect(fx.events).toContain('watch');
    expect(fx.events).toContain('plugins');
  } finally { await fx.controller.close(); }
});

test('close owns a held reporting promise and fences subsequent boot steps', async () => {
  const entered = gate(); const reported = gate();
  const fx = fixture({
    async foldMemory() { throw new Error('fixture private failure'); },
    reportFailure() { entered.resolve(); return reported.promise; },
  });
  const starting = fx.controller.start();
  await entered.promise;
  let closed = false;
  const closing = fx.controller.close().then(() => { closed = true; });
  expect(closed).toBe(false);
  expect(fx.controller.snapshot().state).toBe('closing');
  expect(fx.controller.snapshot().steps.find((step) => step.name === 'memory-fold')?.state).toBe('failed');
  reported.reject(new Error('fixture reporting rejected'));
  await starting; await closing;
  expect(fx.events).toEqual([]);
  expect(fx.controller.snapshot().state).toBe('closed');
});

test('hostile cleanup rejections are neither inspected nor retained', async () => {
  let reads = 0;
  const failure = new Proxy({}, { get() { reads++; throw new Error('private property'); }, getPrototypeOf() { reads++; throw new Error('private prototype'); } });
  const fx = fixture({ closePlugins() { return Promise.reject(failure); } });
  await fx.controller.start();
  const closing = fx.controller.close();
  expect(fx.controller.close()).toBe(closing);
  await expect(closing).rejects.toMatchObject({ failures: [{ label: 'plugins', error: new Error('plugins cleanup failed') }] });
  expect(reads).toBe(0);
});

test('a cleanup directly returning the reentrant controller close rejects without a self-drain deadlock', async () => {
  const fx = fixture({ closePlugins() { return fx.controller.close(); } });
  await fx.controller.start();
  await expect(fx.controller.close()).rejects.toMatchObject({ failures: [{ label: 'plugins', error: new Error('plugins cleanup failed') }] });
  expect(fx.events.slice(-3)).toEqual(['close:notifier', 'close:webhooks', 'stop-watch']);
}, 1000);
