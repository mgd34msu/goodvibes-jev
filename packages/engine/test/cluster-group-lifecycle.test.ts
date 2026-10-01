import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterGroupRuntime, resolveClusterGroupSettings, type ClusterClock, type ClusterTransport } from '../sdk/src/platform/cluster/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release: () => release() }; }
async function turns() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function fixture(get: () => Promise<string | null>, startHook?: () => Promise<void>) {
  if (process.env.GOODVIBES_SDK_TEST_RUNNER !== '1') throw new Error('Use guarded runner');
  const root = mkdtempSync(join(tmpdir(), 'cluster-lifecycle-fixture-')); roots.push(root);
  const timers = new Set<() => void>(); let running = false; let starts = 0; let stops = 0;
  const clock: ClusterClock = { now: () => 1000, monotonicNow: () => 1000, setTimer(fn) { timers.add(fn); return () => { timers.delete(fn); }; } };
  const transport: ClusterTransport = {
    async start() { starts++; await startHook?.(); running = true; }, async stop() { running = false; stops++; }, async send() {},
    describe: () => ({ mode: 'in-memory', group: 'fixture', port: 0, peers: [] }),
  };
  const runtime = new ClusterGroupRuntime({
    settings: resolveClusterGroupSettings({ enabled: true }), transport, clock,
    secrets: { get, async set() { throw new Error('Unexpected fixture credential write'); }, async delete() { throw new Error('Unexpected fixture credential delete'); } },
    stateDirectory: root, nodeId: 'fixture-node', nodeDisplayName: 'Fixture', version: '1.0.0',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { runtime, timers, get running() { return running; }, get starts() { return starts; }, get stops() { return stops; }, async cleanup() { await runtime.stop(); await transport.stop(); timers.clear(); } };
}

test('concurrent starts both wait for the actual owned startup', async () => {
  const hold = deferred(); const entered = deferred();
  const f = fixture(async () => { entered.release(); await hold.promise; return null; });
  const first = f.runtime.start(); await entered.promise;
  let ready = false; const second = f.runtime.start().then(() => { ready = true; });
  try { await turns(); expect(ready).toBe(false); expect(f.starts).toBe(0); }
  finally { hold.release(); await Promise.allSettled([first, second]); await f.cleanup(); }
});

test('stop owns startup already in flight and leaves no late transport or timer', async () => {
  const hold = deferred(); const entered = deferred();
  const f = fixture(async () => { entered.release(); await hold.promise; return null; });
  const starting = f.runtime.start(); await entered.promise;
  let stopped = false; const stopping = f.runtime.stop().then(() => { stopped = true; });
  try {
    await turns(); expect(stopped).toBe(false);
    hold.release(); await Promise.allSettled([starting, stopping]);
    expect(f.running).toBe(false); expect(f.timers.size).toBe(0);
  } finally { hold.release(); await Promise.allSettled([starting, stopping]); await f.cleanup(); }
});

test('a completed stop cannot be followed by late transport activation or timers', async () => {
  const hold = deferred(); const entered = deferred();
  const f = fixture(async () => { entered.release(); await hold.promise; return null; });
  const starting = f.runtime.start(); await entered.promise;
  const stopping = f.runtime.stop();
  try {
    await turns(); hold.release(); await Promise.allSettled([starting, stopping]);
    expect({ running: f.running, timers: f.timers.size }).toEqual({ running: false, timers: 0 });
  } finally { hold.release(); await Promise.allSettled([starting, stopping]); await f.cleanup(); }
});

test('failed startup is not retained as a successful already-started state', async () => {
  let attempts = 0; const f = fixture(async () => null, async () => { if (++attempts === 1) throw new Error('fixture transport failure'); });
  try {
    await expect(f.runtime.start()).rejects.toThrow('fixture transport failure');
    await f.runtime.start(); expect(attempts).toBe(2); expect(f.running).toBe(true);
  } finally { await f.cleanup(); }
});

test('runtime stop drains its accepted housekeeping before closing the transport', async () => {
  const f = fixture(async () => null);
  const entered = deferred();
  const hold = deferred();
  f.runtime.runHousekeeping = async () => { entered.release(); await hold.promise; };
  await f.runtime.start();
  const housekeepingTick = [...f.timers][1]!;
  f.timers.delete(housekeepingTick);
  housekeepingTick();
  await entered.promise;
  let stopped = false;
  const stopping = f.runtime.stop().then(() => { stopped = true; });
  try {
    await turns();
    expect(stopped).toBe(false);
    expect(f.running).toBe(true);
    expect(f.timers.size).toBe(0);
    housekeepingTick();
    expect(f.timers.size).toBe(0);
    hold.release();
    await stopping;
    expect(f.running).toBe(false);
  } finally { hold.release(); await stopping; await f.cleanup(); }
});

test('runtime cancellation during transport acquisition cannot arm periodic work', async () => {
  const entered = deferred();
  const hold = deferred();
  const f = fixture(async () => null, async () => { entered.release(); await hold.promise; });
  const starting = f.runtime.start();
  await entered.promise;
  const stopping = f.runtime.stop();
  hold.release();
  try {
    await expect(starting).rejects.toThrow('cancelled by stop');
    await stopping;
    expect(f.running).toBe(false);
    expect(f.timers.size).toBe(0);
    await f.runtime.start();
    expect(f.starts).toBe(2);
    expect(f.timers.size).toBe(2);
  } finally { await f.cleanup(); }
});
