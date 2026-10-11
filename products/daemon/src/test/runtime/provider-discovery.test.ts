import { expect, test } from 'bun:test';
import { createDaemonProviderDiscovery } from '../../runtime/provider-discovery.js';
import type { DiscoveredServer } from '@goodvibes-jev/engine/sdk/platform/discovery';

const roots = { homeDirectory: '/synthetic-unused', surfaceRoot: 'tui' };
const server: DiscoveredServer = { name: 'fixture', host: '127.0.0.1', port: 9,
  baseURL: 'http://127.0.0.1:9/v1', models: ['fixture'], serverType: 'vllm' };
const result = { servers: [server], scannedHosts: 1, scannedPorts: 1, durationMs: 0 };

test('discovery starts once and close before admission prevents scanning', async () => {
  let scans = 0; let writes = 0; let registrations = 0;
  const owner = createDaemonProviderDiscovery(roots, () => { registrations++; }, {
    async scan() { scans++; return result; }, persist() { writes++; },
  });
  owner.start(); owner.start();
  await owner.close(); await owner.close(); owner.start();
  expect(scans).toBe(0); expect(writes).toBe(0); expect(registrations).toBe(0);
  const another = createDaemonProviderDiscovery(roots, () => { registrations++; }, {
    async scan() { scans++; return result; }, persist() { writes++; },
  });
  another.start(); another.start(); await new Promise<void>((resolve) => setImmediate(resolve));
  await another.close(); another.start();
  expect(scans).toBe(1); expect(writes).toBe(1); expect(registrations).toBe(1);
});

test('synchronous close reentry from registration prevents persistence', async () => {
  let writes = 0; let registrations = 0;
  const owner = createDaemonProviderDiscovery(roots, () => { registrations++; void owner.close(); }, {
    async scan() { return result; }, persist() { writes++; },
  });
  owner.start(); await new Promise<void>((resolve) => setImmediate(resolve)); await owner.close();
  expect(registrations).toBe(1); expect(writes).toBe(0);
});

test.each(['registration', 'persistence'] as const)('%s failure does not inspect rejected values or reject drainage', async (phase) => {
  let touched = false; let writes = 0;
  const raw = { get message() { touched = true; throw new Error('private'); }, toString() { touched = true; throw new Error('private'); } };
  const owner = createDaemonProviderDiscovery(roots, () => { if (phase === 'registration') throw raw; }, {
    async scan() { return result; }, persist() { writes++; throw raw; },
  });
  owner.start(); await new Promise<void>((resolve) => setImmediate(resolve)); await owner.close();
  expect(touched).toBe(false); expect(writes).toBe(phase === 'persistence' ? 1 : 0);
});

test('close aborts the admitted scan immediately and awaits its actual cleanup before returning', async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const cancelled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let registrations = 0, writes = 0, settled = false;
  const owner = createDaemonProviderDiscovery(roots, () => { registrations++; }, {
    async scan(signal) {
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      entered.resolve(signal);
      await cancelled.promise;
      await release.promise;
      return result;
    },
    persist() { writes++; },
  });
  owner.start();
  const signal = await entered.promise;
  const closing = owner.close();
  void closing.then(() => { settled = true; });
  try {
    expect(signal.aborted).toBe(true);
    expect(owner.close()).toBe(closing);
    await cancelled.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(registrations).toBe(0); expect(writes).toBe(0);
  } finally { release.resolve(); await closing; }
  expect(settled).toBe(true);
  expect(registrations).toBe(0); expect(writes).toBe(0);
});

test('close retains already admitted persistence until its original promise settles', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let registrations = 0, writes = 0, settled = false;
  const owner = createDaemonProviderDiscovery(roots, () => { registrations++; }, {
    async scan() { return result; },
    async persist() { writes++; entered.resolve(); await release.promise; },
  });
  owner.start(); await entered.promise;
  const closing = owner.close(); void closing.then(() => { settled = true; });
  try {
    expect(owner.close()).toBe(closing);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(registrations).toBe(1); expect(writes).toBe(1);
  } finally { release.resolve(); await closing; }
  expect(settled).toBe(true); expect(writes).toBe(1);
});
