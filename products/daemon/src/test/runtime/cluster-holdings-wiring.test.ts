/**
 * What this machine holds reaches `cluster status`.
 *
 * The two cluster layers were built separately and each owns half of this
 * answer. The group layer defines `surfaceHoldings` and renders it, but holds
 * no elections. The per-surface election decides who reads which inbox, but has
 * no group to report to. Unwired, `cluster status` prints "surfaces: not
 * reported by this daemon" on a perfectly healthy machine, which is the worst
 * possible output for the question an operator opens `cluster status` to answer:
 * my inbox is quiet, is THIS the machine that is supposed to be reading it?
 *
 * These tests hold the wiring in place at the composition root, which is the
 * only place both halves exist. They run a REAL election to completion rather
 * than reading the reader back immediately, an assertion taken before the boot
 * probe closes would pass against a list that is empty for timing reasons and
 * would keep passing if the wiring were removed.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FakeClusterClock, MemoryClusterBus, inboxSurface, surfaceIdFor } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { createClusterServices, startClusterServices } from '../../runtime/cluster-group-composition.js';
import type { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ShellPathService } from '../../runtime/index.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

/**
 * Clustering ON with a short boot probe and an injected deterministic clock.
 * The election itself is real; no UDP socket or wall-clock sleep is used.
 */
function configManager(): ConfigManager {
  return {
    get: () => undefined,
    getCategory: (category: string) => (category === 'cluster'
      ? { enabled: true, bootProbeSeconds: 1, heartbeatSeconds: 1, masterTimeoutSeconds: 3 }
      : {}),
    set: () => {},
  } as unknown as ConfigManager;
}

function secretsManager(): SecretsManager {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  } as unknown as SecretsManager;
}

function services() {
  const root = makeOwnedTempDir('goodvibes-cluster-holdings');
  const clock = new FakeClusterClock();
  const bus = new MemoryClusterBus();
  const cluster = createClusterServices({
    configManager: configManager(),
    shellPaths: {
      resolveProjectPath: (...segments: string[]) => join(root, ...segments),
    } as unknown as ShellPathService,
    secretsManager: secretsManager(),
    transport: bus.createTransport('fixture'),
    clock,
  });
  return { ...cluster, clock, bus };
}

async function settleElection(clock: FakeClusterClock, coordinator: ReturnType<typeof services>['clusterCoordinator']): Promise<void> {
  for (let tick = 0; tick < 30; tick++) {
    clock.advance(100);
    await Promise.resolve();
    await coordinator.settled();
  }
}

describe('the group layer reports the elections actually running', () => {
  test('a machine holding nothing yet reports an empty list, not "unavailable"', () => {
    const { clusterGroup } = services();
    // Composing must not have joined a network or held an election, so there is
    // genuinely nothing held, and that is a different statement from "this
    // daemon cannot tell you", which is what an unwired reader would produce.
    expect(clusterGroup.runtime.surfaceHoldings()).toEqual([]);
  });

  test('a surface the election awarded shows up in the group layer', async () => {
    const composed = services();
    const { clusterGroup, clusterCoordinator, clock } = composed;
    clusterCoordinator.register({
      id: 'inbox-poller:work-slack',
      surface: inboxSurface('work-slack'),
      start: async () => {},
      stop: async () => {},
    });
    await startClusterServices(composed);
    try {
      await settleElection(clock, clusterCoordinator);

      const holdings = clusterGroup.runtime.surfaceHoldings();
      expect(holdings).toHaveLength(1);
      // The exact surface that was elected, named by the digest the election
      // itself derived, not a placeholder and not a second tally.
      expect(holdings![0]!.surfaceId).toBe(surfaceIdFor(inboxSurface('work-slack')));
      expect(holdings![0]!.reason).toContain('elected');
      expect(clusterCoordinator.isMaster).toBe(true);
    } finally {
      await clusterCoordinator.stop('test');
      await clusterGroup.stop();
      expect(clock.pendingTimers).toBe(0);
    }
  });

  test('an account name never reaches the reported holding', async () => {
    const composed = services();
    const { clusterGroup, clusterCoordinator, clock } = composed;
    clusterCoordinator.register({
      id: 'inbox-poller:mikes-private-mailbox',
      surface: inboxSurface('mikes-private-mailbox'),
      start: async () => {},
      stop: async () => {},
    });
    await startClusterServices(composed);
    try {
      await settleElection(clock, clusterCoordinator);

      const holdings = clusterGroup.runtime.surfaceHoldings()!;
      expect(holdings).toHaveLength(1);
      // `cluster status` output gets pasted into issues, so the account is
      // named by digest everywhere, in the id and in the human reason alike.
      expect(JSON.stringify(holdings)).not.toContain('mikes-private-mailbox');
      expect(holdings[0]!.surfaceId).toBe(surfaceIdFor(inboxSurface('mikes-private-mailbox')));
      expect(holdings[0]!.surfaceId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await clusterCoordinator.stop('test');
      await clusterGroup.stop();
      expect(clock.pendingTimers).toBe(0);
    }
  });
});
