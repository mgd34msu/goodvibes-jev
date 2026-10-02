import { expect, test } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import { createDaemonBootController, type DaemonBootAttachment, type DaemonBootOperations } from '../../runtime/boot-tasks.js';

function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<DaemonBootOperations> = {}) {
  const events: string[] = [];
  const owner = (name: string): DaemonBootAttachment => ({
    attach() { events.push(`attach:${name}`); },
    close() { events.push(`close:${name}`); },
  });
  const operations: DaemonBootOperations = {
    async foldMemory() {},
    startProviderWatch() { events.push('watch'); },
    stopProviderWatch() { events.push('close:provider'); },
    createWebhooks() { return owner('webhooks'); },
    createNotifier() { return owner('notifier'); },
    async synchronizeServices() {},
    async initializePlugins() {},
    async closePlugins() { events.push('close:plugins'); },
    reportFailure(step) { events.push(`failure:${step}`); },
    ...overrides,
  };
  return { controller: createDaemonBootController(operations), events };
}

test('shutdown invokes every acquired admission fence before awaiting held plugin cleanup', async () => {
  const pluginEntered = gate();
  const pluginCleanup = gate();
  const fx = fixture({
    async closePlugins() {
      fx.events.push('close:plugins');
      pluginEntered.resolve();
      await pluginCleanup.promise;
      fx.events.push('drained:plugins');
    },
  });
  await fx.controller.start();
  let closed = false;
  const closing = fx.controller.close().then(() => { closed = true; });
  try {
    await pluginEntered.promise;
    // These are invocation assertions, not eventual drain assertions. A held
    // plugin may still use its dependencies, but those owners must stop admitting
    // fresh notifications and reloads as soon as graph shutdown starts.
    expect(fx.events.filter((event) => event.startsWith('close:'))).toEqual([
      'close:plugins', 'close:notifier', 'close:webhooks', 'close:provider',
    ]);
    expect(closed).toBe(false);
    expect(fx.controller.snapshot().state).toBe('closing');
  } finally {
    pluginCleanup.resolve();
    await closing;
  }
  expect(fx.controller.snapshot().state).toBe('closed');
}, 1_000);

function reentrantProviderFixture() {
  const lateCleanup = gate();
  const cleanupEntered = gate();
  let watchAdmitted = false;
  let lateDrainFinished = false;
  let closing: Promise<void> | undefined;
  const fx = fixture({
    startProviderWatch() {
      // The operation may synchronously reenter shutdown before finishing its
      // own acquisition. The finally branch must own the cleanup after return.
      closing = fx.controller.close();
      watchAdmitted = true;
    },
    stopProviderWatch() {
      if (!watchAdmitted) return Promise.resolve();
      watchAdmitted = false;
      cleanupEntered.resolve();
      const cleanup = lateCleanup.promise.then(() => { lateDrainFinished = true; });
      // Observe the fixture's rejection so the failure test can check the
      // controller's own result instead of crashing on an unhandled rejection.
      void cleanup.catch(() => {});
      return cleanup;
    },
  });
  const starting = fx.controller.start();
  return {
    ...fx,
    starting,
    lateCleanup,
    cleanupEntered,
    closing: () => {
      if (!closing) throw new Error('Provider fixture has not entered shutdown');
      return closing;
    },
    lateDrainFinished: () => lateDrainFinished,
  };
}

test('shutdown owns async provider cleanup admitted during reentrant watcher startup', async () => {
  const fx = reentrantProviderFixture();
  await fx.cleanupEntered.promise;
  let closed = false;
  const closing = fx.closing().then(() => { closed = true; });
  try {
    // One event-loop turn lets every runnable continuation settle. The test
    // does not wait for a wall-clock delay or release the only held drain.
    await setImmediate();
    expect(fx.lateDrainFinished()).toBe(false);
    expect(closed).toBe(false);
    expect(fx.controller.snapshot().state).toBe('closing');
  } finally {
    fx.lateCleanup.resolve();
    await fx.starting;
    await closing;
  }
  expect(fx.lateDrainFinished()).toBe(true);
  expect(fx.controller.snapshot().state).toBe('closed');
}, 1_000);

test('reentrant provider cleanup rejection is returned by controller close', async () => {
  const fx = reentrantProviderFixture();
  const failure = new Error('owned provider cleanup rejected');
  await fx.cleanupEntered.promise;
  const closing = fx.closing();
  // Install the rejection observation before releasing the cleanup gate.
  const outcome = closing.then(
    () => ({ state: 'resolved' as const }),
    (error: unknown) => ({ state: 'rejected' as const, error }),
  );
  fx.lateCleanup.reject(failure);
  try {
    const result = await outcome;
    expect(result.state).toBe('rejected');
    if (result.state === 'rejected') {
      expect(JSON.stringify(result.error)).not.toContain(failure.message);
      expect(result.error).toMatchObject({ failures: [{ label: 'provider watch', error: new Error('provider watch cleanup failed') }] });
    }
    expect(fx.controller.snapshot().state).toBe('failed');
  } finally {
    await fx.starting;
    await outcome;
  }
}, 1_000);
