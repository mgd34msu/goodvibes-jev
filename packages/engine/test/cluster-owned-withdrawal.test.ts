import { describe, expect, test } from 'bun:test';
import { ClusterCoordinator } from '../sdk/src/platform/cluster/coordinator.js';
import { ClusterSurfaceRegistry } from '../sdk/src/platform/cluster/surface-registry.js';
import { FakeClusterClock } from '../sdk/src/platform/cluster/clock.js';
import { MemoryClusterBus } from '../sdk/src/platform/cluster/memory-transport.js';
import { decodeMessage } from '../sdk/src/platform/cluster/protocol.js';
import { providerSurface } from '../sdk/src/platform/cluster/surface-id.js';
import type { ClusterConsumerGate } from '../sdk/src/platform/cluster/types.js';
import { settings, SILENT } from './cluster-harness.js';

const surface = providerSurface('custom', 'owned-withdrawal');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function rig(enabled = true, shared?: { clock: FakeClusterClock; bus: MemoryClusterBus; nodeId: string; version: string }) {
  const clock = shared?.clock ?? new FakeClusterClock();
  const bus = shared?.bus ?? new MemoryClusterBus();
  const nodeId = shared?.nodeId ?? 'owned-node';
  const inner = bus.createTransport(nodeId);
  const events: string[] = [];
  const errors: string[] = [];
  const diagnostics: string[] = [];
  const coordinator = new ClusterCoordinator({
    settings: settings({ enabled }), version: shared?.version ?? '1.0.0', stateDirectory: '/unused',
    nodeId, logger: { ...SILENT, error(message, fields) { errors.push(message); diagnostics.push(JSON.stringify({ message, fields })); } }, clock, random: () => 0,
    transport: {
      start: (receive) => inner.start(receive), stop: () => inner.stop(), describe: () => inner.describe(),
      send: async (raw) => { events.push(`send:${decodeMessage(raw, '').message?.type}`); await inner.send(raw); },
    },
  });
  async function advance(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) { clock.advance(Math.min(50, ms - elapsed)); await flush(); }
  }
  return { coordinator, clock, bus, events, errors, diagnostics, advance };
}
function gate(id: string, events: string[], overrides: Partial<ClusterConsumerGate> = {}): ClusterConsumerGate {
  return { id, surface, start: async () => { events.push(`${id}:start`); },
    stop: async () => { events.push(`${id}:stop`); }, ...overrides };
}

describe('owned cluster registration withdrawal', () => {
  test('legacy incidental-value listeners type-check while async retirement listeners are awaited', async () => {
    const registry = new ClusterSurfaceRegistry(SILENT);
    const events: string[] = [];
    const seen = new Set<string>();
    // These callbacks intentionally return number and Set, respectively. The
    // original public void signature must keep accepting both without casts.
    const removeNumber = registry.onChange(id => events.push(id));
    const removeSet = registry.onChange(id => seen.add(id));
    const blocked = deferred();
    const removeAsync = registry.onChange(async id => {
      if (!registry.canServe(id)) await blocked.promise;
    });
    const withdraw = registry.registerOwned(gate('listener-test', []));
    const pending = withdraw();
    let finished = false; void pending.then(() => { finished = true; });
    await flush();
    expect(events).toHaveLength(2);
    expect(seen.size).toBe(1);
    expect(finished).toBe(false);
    blocked.resolve(); await pending;
    expect(finished).toBe(true);
    removeNumber(); removeSet(); removeAsync();
  });

  test('blocked stop fences withdrawal and RESIGN; awaited replacement survives old retirement', async () => {
    const { coordinator, events, advance } = rig();
    const blocked = deferred();
    const withdraw = coordinator.registerOwned(gate('old', events, { stop: async () => {
      events.push('old:stopping'); await blocked.promise; events.push('old:stopped');
    } }));
    await coordinator.start(); await advance(1_100);
    expect(events).toContain('old:start');
    events.length = 0;
    const pending = withdraw();
    expect(withdraw()).toBe(pending);
    let finished = false; void pending.then(() => { finished = true; });
    await flush();
    expect(finished).toBe(false);
    expect(events).toContain('old:stopping');
    expect(events).not.toContain('send:RESIGN');
    expect(() => coordinator.registerOwned(gate('too-early', events))).toThrow('still retiring');
    blocked.resolve(); await pending;
    expect(events.indexOf('send:RESIGN')).toBeGreaterThan(events.indexOf('old:stopped'));
    const replacement = coordinator.registerOwned(gate('new', events));
    await advance(1_100);
    expect(events).toContain('new:start');
    expect(events).not.toContain('new:stop');
    expect(coordinator.holdsSurface(surface)).toBe(true);
    await withdraw(); await flush();
    expect(events).not.toContain('new:stop');
    await replacement(); await coordinator.stop();
  });

  test('withdrawing one sibling drains only that gate and leaves surface held', async () => {
    const { coordinator, events, advance } = rig();
    const withdrawA = coordinator.registerOwned(gate('a', events));
    const withdrawB = coordinator.registerOwned(gate('b', events));
    await coordinator.start(); await advance(1_100); events.length = 0;
    await withdrawA();
    expect(events).toEqual(['a:stop']);
    expect(coordinator.holdsSurface(surface)).toBe(true);
    await withdrawB(); await coordinator.stop();
  });

  test('ungated late startup cannot outlive its awaited withdrawal', async () => {
    const { coordinator, events } = rig(false);
    await coordinator.start();
    const blocked = deferred(); let running = false;
    const withdraw = coordinator.registerOwned(gate('late', events, {
      start: async () => { events.push('late:starting'); await blocked.promise; running = true; events.push('late:started'); },
      stop: async () => { running = false; events.push('late:stop'); },
    }));
    await flush();
    const pending = withdraw(); let finished = false; void pending.then(() => { finished = true; });
    await flush(); expect(finished).toBe(false);
    blocked.resolve(); await pending;
    expect(running).toBe(false);
    expect(events.lastIndexOf('late:stop')).toBeGreaterThan(events.indexOf('late:started'));
    await coordinator.stop();
  });

  test('immediate registration withdrawal never starts a retired gate', async () => {
    const { coordinator, events, advance } = rig();
    await coordinator.start();
    const withdraw = coordinator.registerOwned(gate('instant', events));
    await withdraw(); await advance(3_100);
    expect(events).not.toContain('instant:start');
    expect(coordinator.holdsSurface(surface)).toBe(false);
    expect(coordinator.status().surfaces).toHaveLength(0);
    await coordinator.stop();
  });

  test('legacy cleanup returns undefined and removes eligibility synchronously', async () => {
    const { coordinator, events } = rig(false);
    const unregister: () => void = coordinator.register(gate('legacy', events));
    await coordinator.start();
    expect(coordinator.status().surfaces).toHaveLength(1);
    expect(unregister()).toBeUndefined();
    expect(coordinator.status().surfaces).toHaveLength(0);
    await flush(); expect(events).toContain('legacy:stop');
    await coordinator.stop();
  });

  test('owned withdrawal exposes a stop failure and cannot report successful retry', async () => {
    const { coordinator, events } = rig(false);
    const failure = new Error('consumer did not drain');
    const withdraw = coordinator.registerOwned(gate('failed', events, { stop: async () => { throw failure; } }));
    await coordinator.start();
    const pending = withdraw();
    await expect(pending).rejects.toThrow('consumer did not drain');
    expect(withdraw()).toBe(pending);
    expect(coordinator.status().surfaces).toHaveLength(0);
    await coordinator.stop();
  });

  test('failed owned drain sends no RESIGN, but a real peer may take over after heartbeat expiry', async () => {
    const local = rig();
    const peer = rig(true, { clock: local.clock, bus: local.bus, nodeId: 'peer-node', version: '0.9.0' });
    let localStillRunning = false;
    const withdraw = local.coordinator.registerOwned(gate('failed', local.events, {
      start: async () => { localStillRunning = true; local.events.push('failed:start'); },
      stop: async () => { local.events.push('failed:stop-rejected'); throw new Error('SECRET-ACCOUNT-DIAGNOSTIC'); },
    }));
    const peerWithdraw = peer.coordinator.registerOwned(gate('peer', peer.events));
    try {
      await local.coordinator.start(); await local.advance(1_100);
      await peer.coordinator.start(); await local.advance(1_100);
      expect(local.coordinator.holdsSurface(surface)).toBe(true);
      expect(peer.coordinator.holdsSurface(surface)).toBe(false);
      local.events.length = 0; peer.events.length = 0;
      const pending = withdraw();
      expect(() => local.coordinator.registerOwned(gate('too-early', local.events))).toThrow('still retiring');
      await expect(pending).rejects.toThrow('An owned cluster consumer did not drain');
      expect(() => local.coordinator.registerOwned(gate('failed-replacement', local.events))).toThrow('still retiring');
      await flush();
      expect(local.events).toContain('failed:stop-rejected');
      expect(local.diagnostics.join('\n')).not.toContain('SECRET-ACCOUNT-DIAGNOSTIC');
      expect(local.events).not.toContain('send:RESIGN');
      expect(local.coordinator.holdsSurface(surface)).toBe(false);
      expect(withdraw()).toBe(pending);
      await local.advance(1_000);
      expect(peer.events).not.toContain('peer:start');
      await local.advance(5_000);
      expect(peer.coordinator.holdsSurface(surface)).toBe(true);
      expect(peer.events).toContain('peer:start');
      expect(local.events).not.toContain('send:RESIGN');
      expect(local.events).not.toContain('send:CLAIM');
      expect(local.events).not.toContain('failed:start');
      // Fail-closed local withdrawal is not a distributed lease: a failed
      // consumer may still run while the peer recovers after heartbeat expiry.
      expect(localStillRunning).toBe(true);
    } finally {
      await peerWithdraw(); await peer.coordinator.stop(); await local.coordinator.stop();
    }
  });

  test('the final sibling cannot RESIGN while an earlier removed sibling is still draining', async () => {
    const { coordinator, events, advance } = rig();
    const blocked = deferred();
    const withdrawA = coordinator.registerOwned(gate('slow-sibling', events, { stop: async () => {
      events.push('slow:stopping'); await blocked.promise; events.push('slow:stopped');
    } }));
    const withdrawB = coordinator.registerOwned(gate('last-sibling', events));
    await coordinator.start(); await advance(1_100); events.length = 0;
    const pendingA = withdrawA(); const pendingB = withdrawB();
    await flush();
    expect(events).toContain('last-sibling:stop');
    expect(events).not.toContain('send:RESIGN');
    expect(() => coordinator.registerOwned(gate('too-early', events))).toThrow('still retiring');
    blocked.resolve(); await Promise.all([pendingA, pendingB]);
    expect(events.indexOf('send:RESIGN')).toBeGreaterThan(events.indexOf('slow:stopped'));
    await coordinator.stop();
  });

  test('a successful sibling withdrawal cannot clear another sibling failed-drain fence or announce RESIGN', async () => {
    const { coordinator, events, advance } = rig();
    const withdrawA = coordinator.registerOwned(gate('failed-sibling', events, { stop: async () => {
      throw new Error('sibling did not drain');
    } }));
    const withdrawB = coordinator.registerOwned(gate('healthy-sibling', events));
    await coordinator.start(); await advance(1_100);
    await expect(withdrawA()).rejects.toThrow('An owned cluster consumer did not drain');
    // B's own consumer can finish; A's surface-wide retirement fence survives.
    await withdrawB().catch(() => {});
    await flush();
    expect(events).toContain('healthy-sibling:stop');
    expect(events).not.toContain('send:RESIGN');
    expect(() => coordinator.registerOwned(gate('replacement', events))).toThrow('still retiring');
    await coordinator.stop();
  });

  test('legacy failed stop keeps its log-and-RESIGN behavior', async () => {
    const { coordinator, events, errors, advance } = rig();
    const unregister = coordinator.register(gate('legacy-failure', events, { stop: async () => {
      events.push('legacy:stop-rejected'); throw new Error('legacy stop failed');
    } }));
    await coordinator.start(); await advance(1_100); events.length = 0;
    expect(unregister()).toBeUndefined(); await flush();
    expect(events).toContain('legacy:stop-rejected');
    expect(events.indexOf('send:RESIGN')).toBeGreaterThan(events.indexOf('legacy:stop-rejected'));
    expect(errors).toContain('cluster: an inbound consumer did not stop cleanly');
    expect(coordinator.holdsSurface(surface)).toBe(false);
    await coordinator.stop();
  });

  test('successful repeated cleanup releases all owned retirement records', async () => {
    const { coordinator, events } = rig(false);
    await coordinator.start();
    for (let iteration = 0; iteration < 3; iteration++) {
      const id = `round-${iteration}`;
      const withdraw = coordinator.registerOwned(gate(id, events));
      await flush();
      const pending = withdraw();
      expect(withdraw()).toBe(pending);
      await pending;
      expect(withdraw()).toBe(pending);
      expect(events.filter(event => event === `${id}:stop`)).toHaveLength(1);
      // Verify successful retirement releases retained gate references, not just
      // the public registration fence. These are deliberately internal checks.
      const records = coordinator as unknown as {
        ownedGateDrains: Map<unknown, unknown>; ownedWithdrawals: Map<unknown, unknown>;
      };
      expect(records.ownedGateDrains.size).toBe(0);
      expect(records.ownedWithdrawals.size).toBe(0);
    }
    await coordinator.stop();
  });

  test('ignored owned cleanup failure is handled without an unhandled rejection', async () => {
    const { coordinator, events } = rig(false);
    const unhandled: unknown[] = [];
    const observe = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', observe);
    try {
      const withdraw = coordinator.registerOwned(gate('ignored', events, { stop: async () => {
        throw new Error('PRIVATE-IGNORED-STOP-DIAGNOSTIC');
      } }));
      await coordinator.start();
      withdraw();
      await flush(); await new Promise<void>(resolve => { setImmediate(resolve); });
      expect(unhandled).toEqual([]);
      expect(() => coordinator.registerOwned(gate('unsafe-retry', events))).toThrow('still retiring');
      await coordinator.stop();
    } finally { process.off('unhandledRejection', observe); }
  });

  test('a stale startSurface snapshot cannot start a withdrawn sibling', async () => {
    const { coordinator, events } = rig(false);
    const blocked = deferred();
    const withdrawA = coordinator.registerOwned(gate('first', events, { start: async () => {
      events.push('first:start'); await blocked.promise;
    } }));
    const withdrawB = coordinator.registerOwned(gate('retired', events));
    const starting = coordinator.start(); await flush();
    await withdrawB(); blocked.resolve(); await starting;
    expect(events).not.toContain('retired:start');
    await withdrawA(); await coordinator.stop();
  });
});
