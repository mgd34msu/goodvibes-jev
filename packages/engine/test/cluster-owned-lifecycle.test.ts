import { expect, test } from 'bun:test';
import { ClusterOwnedLifecycle, ClusterPeriodicTasks } from '../sdk/src/platform/cluster/owned-lifecycle.js';
import type { ClusterClock, ClusterLogger } from '../sdk/src/platform/cluster/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function turns() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test('shared readiness and stop promises allow an explicit clean restart', async () => {
  const hold = deferred();
  let acquisitions = 0;
  let releases = 0;
  const lifecycle = new ClusterOwnedLifecycle(async () => { acquisitions++; }, async () => { releases++; await hold.promise; });
  const first = lifecycle.start();
  expect(lifecycle.start()).toBe(first);
  await first;
  const stopping = lifecycle.stop();
  expect(lifecycle.stop()).toBe(stopping);
  await expect(lifecycle.start()).rejects.toThrow('stopping');
  hold.resolve();
  await stopping;
  await lifecycle.start();
  await lifecycle.stop();
  expect({ acquisitions, releases }).toEqual({ acquisitions: 2, releases: 2 });
});

test('start and cleanup failures remain visible and prevent dirty restart', async () => {
  const acquisition = new Error('fixture acquire');
  const cleanup = new Error('fixture cleanup');
  let releases = 0;
  let acquisitions = 0;
  const lifecycle = new ClusterOwnedLifecycle(
    async () => { if (++acquisitions === 1) throw acquisition; },
    async () => { if (++releases === 1) throw cleanup; },
  );
  const failure = await lifecycle.start().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([acquisition, cleanup]);
  await expect(lifecycle.start()).rejects.toThrow('cleanup must be retried');
  expect(acquisitions).toBe(1);
  await lifecycle.stop();
  await lifecycle.start();
  await lifecycle.stop();
  expect({ acquisitions, releases }).toEqual({ acquisitions: 2, releases: 3 });
});

test('startup cancelled before acquisition never opens a resource', async () => {
  let acquisitions = 0;
  const lifecycle = new ClusterOwnedLifecycle(async () => { acquisitions++; }, async () => {});
  const start = lifecycle.start();
  const stopped = lifecycle.stop();
  await expect(start).rejects.toThrow('cancelled by stop');
  await stopped;
  expect(acquisitions).toBe(0);
});

test('stop waits for accepted startup and observes cleanup after acquisition failure', async () => {
  const entered = deferred();
  const hold = deferred();
  const release = deferred();
  let closed = false;
  const lifecycle = new ClusterOwnedLifecycle(
    async () => { entered.resolve(); await hold.promise; throw new Error('fixture acquisition failed'); },
    async () => { await release.promise; closed = true; },
  );
  const start = lifecycle.start();
  await entered.promise;
  let stopped = false;
  const stop = lifecycle.stop().then(() => { stopped = true; });
  hold.resolve();
  await turns();
  expect(stopped).toBe(false);
  release.resolve();
  await expect(start).rejects.toThrow('fixture acquisition failed');
  await stop;
  expect(closed).toBe(true);
});

function periodicFixture() {
  const callbacks = new Set<() => void>();
  const warnings: string[] = [];
  const clock: ClusterClock = {
    now: () => 0, monotonicNow: () => 0,
    setTimer(callback) { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
  };
  const logger: ClusterLogger = { debug() {}, info() {}, error() {}, warn(message) { warnings.push(message); } };
  return { periodic: new ClusterPeriodicTasks(clock, logger), callbacks, warnings };
}

test('periodic stop drains accepted work and stale callbacks cannot re-arm timers', async () => {
  const f = periodicFixture();
  const hold = deferred();
  let tasks = 0;
  f.periodic.schedule(10, async () => { tasks++; await hold.promise; });
  const callback = [...f.callbacks][0]!;
  f.callbacks.delete(callback);
  callback();
  let stopped = false;
  const stop = f.periodic.stop().then(() => { stopped = true; });
  await turns();
  expect(stopped).toBe(false);
  expect(f.callbacks.size).toBe(0);
  callback();
  expect(f.callbacks.size).toBe(0);
  hold.resolve();
  await stop;
  expect(tasks).toBe(1);
  f.periodic.schedule(10, async () => { tasks++; });
  expect(f.callbacks.size).toBe(1);
  await f.periodic.stop();
  expect(f.callbacks.size).toBe(0);
});

test('automatic task failure is observed without an unhandled rejection or payload logging', async () => {
  const f = periodicFixture();
  f.periodic.schedule(10, async () => { throw new Error('fixture private payload'); });
  const callback = [...f.callbacks][0]!;
  f.callbacks.delete(callback);
  callback();
  await f.periodic.stop();
  expect(f.warnings).toEqual(['cluster: a periodic group task failed']);
});
