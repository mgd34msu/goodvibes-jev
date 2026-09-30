import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { FakeClusterClock, type ClusterTransport } from '@goodvibes-jev/engine/sdk/platform/cluster';
import type { ShellPathService } from '../../runtime/index.js';
import { createClusterGroupComposition } from '../../runtime/cluster-group-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function turns() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function fixture(get: () => Promise<string | null>, startHook?: () => Promise<void>) {
  const root = makeOwnedTempDir('daemon-cluster-lifecycle');
  const clock = new FakeClusterClock();
  let running = false;
  let starts = 0;
  const transport: ClusterTransport = {
    async start() { starts++; await startHook?.(); running = true; },
    async stop() { running = false; }, async send() {},
    describe: () => ({ mode: 'in-memory', group: 'fixture', port: 0, peers: [] }),
  };
  const composition = createClusterGroupComposition({
    configManager: { get: () => undefined, set() {}, getCategory: () => ({ enabled: true }) } as unknown as ConfigManager,
    shellPaths: { resolveProjectPath: (...parts: string[]) => join(root, ...parts) } as unknown as ShellPathService,
    secretsManager: { get, async set() { throw new Error('Unexpected credential write'); }, async delete() { throw new Error('Unexpected credential deletion'); } },
    transport, clock,
  });
  return { composition, clock, get running() { return running; }, get starts() { return starts; } };
}

test('composition shares real group startup readiness', async () => {
  const hold = deferred(); const entered = deferred();
  const f = fixture(async () => { entered.resolve(); await hold.promise; return null; });
  const first = f.composition.start(); await entered.promise;
  let ready = false; const second = f.composition.start().then(() => { ready = true; });
  try { await turns(); expect(ready).toBe(false); }
  finally { hold.resolve(); await Promise.allSettled([first, second]); await f.composition.stop(); }
});

test('composition retries failed startup instead of remembering success', async () => {
  let attempt = 0;
  const f = fixture(async () => null, async () => { if (++attempt === 1) throw new Error('fixture transport failure'); });
  try {
    await expect(f.composition.start()).rejects.toThrow('fixture transport failure');
    await f.composition.start();
    expect(f.starts).toBe(2);
    expect(f.running).toBe(true);
  } finally { await f.composition.stop(); }
});

test('composition stop drains accepted startup, prevents late timers and permits a clean restart', async () => {
  const hold = deferred(); const entered = deferred();
  const f = fixture(async () => { entered.resolve(); await hold.promise; return null; });
  const starting = f.composition.start(); await entered.promise;
  const stop = f.composition.stop();
  hold.resolve();
  await Promise.allSettled([starting, stop]);
  expect(f.running).toBe(false);
  expect(f.clock.pendingTimers).toBe(0);
  try { await f.composition.start(); expect(f.running).toBe(true); }
  finally { await f.composition.stop(); }
});

test('stopping a returning member abandons admission and clears all owned timers', async () => {
  const root = makeOwnedTempDir('daemon-cluster-return');
  const values = new Map<string, string>();
  const clock = new FakeClusterClock();
  const announced = deferred();
  const composition = createClusterGroupComposition({
    configManager: { get: () => undefined, set() {}, getCategory: () => ({ enabled: true }) } as unknown as ConfigManager,
    shellPaths: { resolveProjectPath: (...parts: string[]) => join(root, ...parts) } as unknown as ShellPathService,
    secretsManager: { async get(key) { return values.get(key) ?? null; }, async set(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } },
    clock,
    transport: {
      async start() {}, async stop() {},
      async send(raw) { if (JSON.parse(raw).type === 'REJOIN') announced.resolve(); },
      describe: () => ({ mode: 'in-memory', group: 'fixture', port: 0, peers: [] }),
    },
  });
  // Dummy cryptographic material lives only in this in-memory store and owned state root.
  expect((await composition.verbs.create({ name: 'fixture', passphrase: 'dummy fixture passphrase' })).ok).toBe(true);
  const starting = composition.start();
  await announced.promise;
  const stopping = composition.stop();
  await expect(starting).rejects.toThrow('cancelled by stop');
  await stopping;
  expect(clock.pendingTimers).toBe(0);
});
