import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { AgentManager, type AgentExecutor, type AgentFleetOwnership } from '../sdk/src/platform/tools/agent/manager.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function config(cap = 1) {
  const root = mkdtempSync(join(tmpdir(), 'shared-fleet-')); roots.push(root);
  const result = new ConfigManager({ configDir: root }); result.set('fleet.maxSize', cap); return result;
}
const input = { mode: 'spawn' as const, task: 'Owned fixture work', outsideContract: true };
function hanging() {
  const held = gate(); let starts = 0;
  const executor: AgentExecutor = { async runAgent(record) {
    starts++; record.status = 'running'; await held.promise;
    if (record.status === 'running') record.status = 'completed';
  } };
  return { executor, release: held.release, get starts() { return starts; } };
}
function manager(configuration: ConfigManager, executor: AgentExecutor, additionalFleetOwnership?: () => readonly AgentFleetOwnership[]) {
  return new AgentManager({ configManager: configuration, executor, additionalFleetOwnership,
    archetypeLoader: { loadArchetype: () => null }, messageBus: { registerAgent() {} } });
}

test('two stale preflight claims still share final synchronous admission and losing claim executes nothing', async () => {
  const configuration = config(); const left = hanging(); const right = hanging();
  let a!: AgentManager; let b!: AgentManager;
  a = manager(configuration, left.executor, () => b.fleetOwnership());
  b = manager(configuration, right.executor, () => a.fleetOwnership());
  const ready = gate();
  // Both orchestration/worktree preparations saw free capacity before awaiting.
  expect(a.fleetOwnership()).toEqual([]); expect(b.fleetOwnership()).toEqual([]);
  const claims = [ready.promise.then(() => a.spawn(input)), ready.promise.then(() => b.spawn(input))]; ready.release();
  const results = await Promise.allSettled(claims);
  try {
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(left.starts + right.starts).toBe(1); expect(a.list().length + b.list().length).toBe(1);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!;
    expect(String(failure.reason)).toContain('fleet.maxSize=1');
  } finally { left.release(); right.release(); await Promise.all([...a.list().map(record => a.join(record.id)), ...b.list().map(record => b.join(record.id))]); }
  // Existing explicit retry succeeds after actual ownership is released.
  const retry = b.spawn(input); await b.join(retry.id); expect(right.starts).toBe(1);
});

test('a registry callback can admit the sibling but the outer final admission rechecks before execution', async () => {
  const configuration = config(); const left = hanging(); const right = hanging(); let b!: AgentManager;
  const a = new AgentManager({ configManager: configuration, executor: left.executor,
    archetypeLoader: { loadArchetype: () => null }, messageBus: { registerAgent() {} },
    additionalFleetOwnership: () => b.fleetOwnership(), providerRegistry: { listModels() { b.spawn(input); return []; } } });
  b = manager(configuration, right.executor, () => a.fleetOwnership());
  try {
    expect(() => a.spawn(input)).toThrow('fleet.maxSize=1');
    expect(a.list()).toHaveLength(0); expect(left.starts).toBe(0); expect(right.starts).toBe(1);
  } finally { left.release(); right.release(); await Promise.all(b.list().map(record => b.join(record.id))); }
});

test('reentry from a final ownership read fails closed without treating a stale snapshot as a reservation', async () => {
  const configuration = config(); const left = hanging(); const right = hanging(); let a!: AgentManager; let b!: AgentManager;
  let reads = 0; let refused = '';
  a = manager(configuration, left.executor, () => {
    const snapshot = b.fleetOwnership();
    if (++reads === 2) { try { b.spawn(input); } catch (error) { refused = String(error); } }
    return snapshot;
  });
  b = manager(configuration, right.executor, () => a.fleetOwnership());
  try {
    a.spawn(input); expect(refused).toContain('Shared fleet admission');
    expect(left.starts).toBe(1); expect(right.starts).toBe(0); expect(b.list()).toHaveLength(0);
  } finally { left.release(); right.release(); await Promise.all(a.list().map(record => a.join(record.id))); }
  const retry = b.spawn(input); await b.join(retry.id); expect(right.starts).toBe(1);
});

test.each(['cancelled', 'failed'] as const)('%s execution retains shared capacity until its actual cleanup settles', async status => {
  const configuration = config(); const left = hanging(); const right = hanging(); let a!: AgentManager; let b!: AgentManager;
  a = manager(configuration, left.executor, () => b.fleetOwnership()); b = manager(configuration, right.executor, () => a.fleetOwnership());
  const record = a.spawn(input);
  try {
    if (status === 'cancelled') a.cancel(record.id); else record.status = 'failed';
    expect(a.fleetOwnership()).toEqual([{ id: record.id, active: true }]);
    expect(() => b.spawn(input)).toThrow('fleet.maxSize=1'); expect(right.starts).toBe(0);
    left.release(); await a.join(record.id); expect(a.fleetOwnership()).toEqual([{ id: record.id, active: false }]);
    const admitted = b.spawn(input); right.release(); await b.join(admitted.id); expect(right.starts).toBe(1);
  } finally { left.release(); right.release(); await Promise.all([...a.list().map(record => a.join(record.id)), ...b.list().map(record => b.join(record.id))]); }
});

test('shared wake refuses at cap, then reserves one same-id queued replacement through both cleanups', async () => {
  const configuration = config(); const first = gate(); const second = gate(); const peer = hanging(); let starts = 0; let a!: AgentManager; let b!: AgentManager;
  a = manager(configuration, { async runAgent(record) { starts++; record.status = 'running'; await (starts === 1 ? first.promise : second.promise); if (record.status === 'running') record.status = 'failed'; } }, () => b.fleetOwnership());
  b = manager(configuration, peer.executor, () => a.fleetOwnership());
  const record = a.spawn(input); record.status = 'failed';
  try {
    // A same-id queued replacement is not a second fleet agent.
    expect(a.wakeWithSteer(record.id, 'continue')).toMatchObject({ woke: true });
    expect(a.getStatus(record.id)?.status).toBe('pending'); expect(starts).toBe(1);
    expect(() => b.spawn(input)).toThrow('fleet.maxSize=1');
    first.release(); await new Promise(resolve => setTimeout(resolve, 0)); expect(starts).toBe(2);
    expect(() => b.spawn(input)).toThrow('fleet.maxSize=1');
    second.release(); await a.join(record.id);
    const other = b.spawn(input);
    expect(a.wakeWithSteer(record.id, 'capacity wait')).toMatchObject({ woke: false }); expect(starts).toBe(2);
    peer.release(); await b.join(other.id);
    expect(a.wakeWithSteer(record.id, 'explicit retry')).toMatchObject({ woke: true }); await a.join(record.id); expect(starts).toBe(3);
  } finally { first.release(); second.release(); peer.release(); await Promise.all([...a.list().map(item => a.join(item.id)), ...b.list().map(item => b.join(item.id))]); }
});

test('standalone graphs retain their preexisting independent admission when shared owner is absent', async () => {
  const configuration = config(); const left = hanging(); const right = hanging();
  const a = manager(configuration, left.executor); const b = manager(configuration, right.executor);
  const first = a.spawn(input); const second = b.spawn(input);
  expect(left.starts + right.starts).toBe(2);
  left.release(); right.release(); await Promise.all([a.join(first.id), b.join(second.id)]);
});
