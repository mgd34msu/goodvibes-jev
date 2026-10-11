import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { DaemonServer } from '../sdk/src/platform/daemon/facade.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { WorkProposalStore } from '../sdk/src/platform/agents/work-proposal-store.ts';

const roots: string[] = [];
const stores: WorkProposalStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const input = { surfaceKind: 'synthetic', task: 'fixture', summary: 'fixture', ttlMs: 60_000 };
function track() {
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  const live = new Set<ReturnType<typeof setInterval>>();
  const callbacks = new Map<ReturnType<typeof setInterval>, () => void>();
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { const handle = realSet(...args); if ((new Error().stack ?? '').includes('/agents/work-proposal-store.ts')) { live.add(handle); callbacks.set(handle, () => args[0]()); } return handle; }) as typeof setInterval;
  globalThis.clearInterval = ((handle: ReturnType<typeof setInterval> | undefined) => { if (handle) { live.delete(handle); callbacks.delete(handle); } realClear(handle); }) as typeof clearInterval;
  return { live, tick() { for (const callback of [...callbacks.values()]) callback(); }, restore() { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; for (const handle of live) realClear(handle); } };
}

test('dispose while persisted proposals load cannot resurrect their sweep', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proposal-lifetime-')); roots.push(root);
  const path = join(root, 'proposals.json');
  await writeFile(path, JSON.stringify({ version: 1, proposals: [{ ...input, id: 'wp_fixture', createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: 'pending', delivered: true }] }));
  const store = new WorkProposalStore({ storePath: path }); stores.push(store);
  const timers = track();
  try {
    const loading = store.init(); store.dispose(); await loading;
    expect(timers.live.size).toBe(0);
  } finally { timers.restore(); }
});

test('idle expiry cleanup retains resolved records until their expiry, then releases its timer', () => {
  let now = 1_000;
  const store = new WorkProposalStore({ now: () => now }); stores.push(store);
  const timers = track();
  try {
    const proposal = store.create(input); store.resolve(proposal.id, 'accepted');
    timers.tick();
    expect(store.disclose().tracked).toBe(1); expect(timers.live.size).toBe(1);
    now += input.ttlMs + 1; timers.tick();
    // disclose is observational: no read-triggered reap masks the defect.
    expect(store.disclose().tracked).toBe(0); expect(timers.live.size).toBe(0);
    store.create(input); expect(timers.live.size).toBe(1);
  } finally { timers.restore(); }
});


for (const ending of ['stop', 'failed-start'] as const) test(`${ending} releases a populated canonical proposal store`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'proposal-daemon-')); roots.push(root);
  seedBenchmarkCache(root, 'goodvibes');
  const configManager = new ConfigManager({ surfaceRoot: 'daemon', configDir: join(root, 'cfg'), workingDir: root, homeDir: root });
  const dir = configManager.getControlPlaneConfigDir(); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'work-proposals.json'), JSON.stringify({ version: 1, proposals: [{ ...input, id: 'wp_fixture', createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: 'pending', delivered: true }] }));
  const timers = track(); let daemon: DaemonServer | undefined;
  try {
    daemon = new DaemonServer({ configManager, workingDir: root, homeDirectory: root, daemonHomeDir: join(root, 'daemon'), port: 0, host: '127.0.0.1', serveFactory: () => { throw new Error('synthetic bind failure'); } });
    daemon.enable({ daemon: true }, 'synthetic-token');
    const deadline = Date.now() + 5_000;
    while (timers.live.size === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(timers.live.size).toBe(1);
    if (ending === 'failed-start') await expect(daemon.start()).rejects.toThrow('synthetic bind failure');
    else await daemon.stop();
    expect(timers.live.size).toBe(0);
  } finally { await daemon?.stop(); timers.restore(); }
}, 60_000);


test('a stopped sweep only resumes explicitly and remains single-owned', async () => {
  const store = new WorkProposalStore(); stores.push(store);
  const timers = track();
  try {
    store.create(input); expect(timers.live.size).toBe(1);
    store.dispose(); store.dispose(); expect(timers.live.size).toBe(0);
    expect(() => store.create(input)).toThrow('Work proposal store is stopped');
    await store.init(); expect(timers.live.size).toBe(0);
    store.startSweep(); store.startSweep(); expect(timers.live.size).toBe(1);
    store.dispose(); expect(timers.live.size).toBe(0);
  } finally { timers.restore(); }
});


for (const exit of ['stop', 'failed-start'] as const) test(`${exit} drains admitted proposal writes before releasing its filesystem root`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'proposal-write-drain-')); roots.push(root);
  seedBenchmarkCache(root, 'goodvibes');
  const configManager = new ConfigManager({ surfaceRoot: 'daemon', configDir: join(root, 'cfg'), workingDir: root, homeDir: root });
  const directory = configManager.getControlPlaneConfigDir();
  let bindAttempts = 0;
  const daemon = new DaemonServer({ configManager, workingDir: root, homeDirectory: root, daemonHomeDir: join(root, 'daemon'), port: 0, host: '127.0.0.1', serveFactory: () => { bindAttempts++; throw new Error('synthetic restart bind'); } });
  daemon.enable({ daemon: true }, 'synthetic-restart-token');
  const store = (daemon as unknown as { workProposals: WorkProposalStore }).workProposals;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const realMkdir = fs.mkdir;
  let captured = false;
  const mkdirSpy = spyOn(fs, 'mkdir').mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]) === directory && !captured) { captured = true; entered.resolve(); await release.promise; }
    return realMkdir(...args);
  }) as typeof fs.mkdir);
  let stopping: Promise<void> | undefined;
  let restarting: Promise<void> | undefined;
  try {
    const proposal = store.create(input); store.markDelivered(proposal.id); store.resolve(proposal.id, 'accepted');
    await entered.promise;
    let stopped = false;
    stopping = (exit === 'stop' ? daemon.stop() : daemon.start().catch((error: unknown) => { expect(String(error)).toContain('synthetic restart bind'); })).then(() => { stopped = true; });
    if (exit === 'failed-start') while (bindAttempts === 0) await Bun.sleep(1);
    let repeatedStopped = false;
    let resumed = false;
    restarting = daemon.start().then(() => { resumed = true; }, (error: unknown) => { expect(String(error)).toContain('synthetic restart bind'); resumed = true; });
    expect(() => store.create(input)).toThrow('Work proposal store is stopped');
    expect(store.markDelivered(proposal.id)).toBeNull();
    expect(store.resolve(proposal.id, 'declined')).toBeNull();
    store.markUndeliverable(proposal.id, 'late delivery callback');
    await Bun.sleep(150);
    const repeated = daemon.stop().then(() => { repeatedStopped = true; });
    await Bun.sleep(1);
    expect(bindAttempts).toBe(exit === 'stop' ? 0 : 1);
    const stoppedBeforeDrain = stopped || repeatedStopped || resumed;
    if (stoppedBeforeDrain) await rm(directory, { recursive: true, force: true });
    release.resolve(); await stopping; await repeated; await restarting; await store.flush();
    const recreatedAfterStop = stoppedBeforeDrain && existsSync(directory);
    expect({ stoppedBeforeDrain, recreatedAfterStop }).toEqual({ stoppedBeforeDrain: false, recreatedAfterStop: false });
  } finally { release.resolve(); await stopping; await restarting; await daemon.stop(); await store.flush(); mkdirSpy.mockRestore(); }
}, 60_000);


test('late init across stop and explicit restart has one sweep and preserves concurrent records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proposal-init-restart-')); roots.push(root);
  const path = join(root, 'proposals.json');
  await writeFile(path, JSON.stringify({ version: 1, proposals: [{ ...input, id: 'wp_loaded', createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: 'pending', delivered: true }] }));
  const store = new WorkProposalStore({ storePath: path }); stores.push(store);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const realRead = fs.readFile;
  const readSpy = spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const result = await realRead(...args);
    if (String(args[0]) === path) { entered.resolve(); await release.promise; }
    return result;
  }) as typeof fs.readFile);
  const timers = track();
  try {
    const loading = store.init(); await entered.promise;
    const concurrent = store.create(input); store.resolve(concurrent.id, 'accepted');
    store.dispose(); const drain = store.flush(); expect(timers.live.size).toBe(0);
    release.resolve(); await loading; await drain; expect(timers.live.size).toBe(0);
    store.startSweep(); store.startSweep();
    expect(timers.live.size).toBe(1);
    expect(store.get('wp_loaded')?.status).toBe('pending');
    expect(store.get(concurrent.id)?.status).toBe('accepted');
    const saved = JSON.parse(await realRead(path, 'utf-8')) as { proposals: Array<{ id: string }> };
    expect(saved.proposals.map((entry) => entry.id).sort()).toEqual(['wp_loaded', concurrent.id].sort());
    store.dispose(); await store.flush(); expect(timers.live.size).toBe(0);
  } finally { release.resolve(); readSpy.mockRestore(); timers.restore(); }
});
