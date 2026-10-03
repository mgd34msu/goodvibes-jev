import { describe, expect, test } from 'bun:test';
import {
  AgentPeriodicUpdater,
  DEFAULT_PERIODIC_FIRST_CHECK_SECONDS,
  DEFAULT_PERIODIC_INTERVAL_MINUTES,
  agentIsIdleForUpdate,
  startPeriodicSelfUpdate,
  type AgentPeriodicUpdaterOptions,
} from '../../runtime/periodic-update.ts';
import { channelDeliveriesInFlight, deliverAgentChannelMessage } from '../../agent/channel-delivery.ts';
import type { UpdateFetchLike } from '../../runtime/update-check.ts';

// A long-running agent's periodic self-update, with every seam stubbed: the
// version check (never the real network), the install (never a real swap), the
// restart (never a real process), and the timers (no real time passes).
// Versions are pinned fixtures, never the live build VERSION.

const CURRENT = '1.0.0';
const NEWER = 'v1.1.0';

interface Harness {
  readonly updater: AgentPeriodicUpdater;
  readonly timers: Array<{ fn: () => void; ms: number }>;
  readonly notices: string[];
  readonly applied: number[];
  readonly restarts: string[];
}

function harness(overrides: {
  latestTag?: string;
  isIdle?: () => boolean;
  settings?: AgentPeriodicUpdaterOptions['settings'];
  applyThrows?: boolean;
} = {}): Harness {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const notices: string[] = [];
  const applied: number[] = [];
  const restarts: string[] = [];
  const latestTag = overrides.latestTag ?? NEWER;
  const updater = new AgentPeriodicUpdater({
    currentVersion: CURRENT,
    execPath: '/opt/goodvibes/goodvibes-agent',
    platform: 'linux',
    arch: 'x64',
    settings: overrides.settings ?? {},
    isIdle: overrides.isIdle ?? (() => true),
    notify: (line) => notices.push(line),
    restartNow: (fromVersion) => restarts.push(fromVersion),
    fetchImpl: (() => { throw new Error('the periodic loop must not reach the network in tests'); }) as unknown as UpdateFetchLike,
    check: async () => ({ latestTag, isCurrent: latestTag === `v${CURRENT}` }),
    apply: async () => {
      if (overrides.applyThrows) throw new Error('swap failed');
      applied.push(Date.now());
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  return { updater, timers, notices, applied, restarts };
}

describe('agent idle gate for self-update', () => {
  const idle = { countBusySessions: () => 0, listApprovals: () => [], channelDeliveriesInFlight: () => 0 };

  test('idle only when no turn, no in-flight delivery, and no pending confirmation', () => {
    expect(agentIsIdleForUpdate(idle)).toBe(true);
    expect(agentIsIdleForUpdate({ ...idle, countBusySessions: () => 1 })).toBe(false);
    expect(agentIsIdleForUpdate({ ...idle, channelDeliveriesInFlight: () => 1 })).toBe(false);
    expect(agentIsIdleForUpdate({ ...idle, listApprovals: () => [{ status: 'pending' }] })).toBe(false);
    // 'claimed' is still waiting on a human answer.
    expect(agentIsIdleForUpdate({ ...idle, listApprovals: () => [{ status: 'claimed' }] })).toBe(false);
    // A settled approval is not a reason to hold an update.
    expect(agentIsIdleForUpdate({ ...idle, listApprovals: () => [{ status: 'approved' }] })).toBe(true);
  });

  test('the in-flight channel-delivery count rises during a send and falls after it, including on failure', async () => {
    expect(channelDeliveriesInFlight()).toBe(0);
    let observedDuringSend = -1;
    const router = {
      deliver: async () => {
        observedDuringSend = channelDeliveriesInFlight();
        return 'response-1';
      },
      listStrategies: () => [],
    };
    await deliverAgentChannelMessage(router, { message: 'hello', channel: 'ntfy:topic' });
    expect(observedDuringSend).toBe(1);
    expect(channelDeliveriesInFlight()).toBe(0);

    const failing = {
      deliver: async () => { throw new Error('delivery refused'); },
      listStrategies: () => [],
    };
    await expect(deliverAgentChannelMessage(failing, { message: 'hello', channel: 'ntfy:topic' })).rejects.toThrow('delivery refused');
    // A leaked counter would pin the agent "busy" and block every later update.
    expect(channelDeliveriesInFlight()).toBe(0);
  });
});

describe('agent periodic self-update loop', () => {
  test('the first check is a boot-settle delay, then the hourly cadence', () => {
    const h = harness();
    h.updater.start();
    expect(h.timers[0]!.ms).toBe(DEFAULT_PERIODIC_FIRST_CHECK_SECONDS * 1000);
    expect(h.updater.checkIntervalMs).toBe(DEFAULT_PERIODIC_INTERVAL_MINUTES * 60 * 1000);
  });

  test('settings drive the cadence', () => {
    const h = harness({ settings: { intervalMinutes: 15, firstCheckSeconds: 5 } });
    h.updater.start();
    expect(h.timers[0]!.ms).toBe(5_000);
    expect(h.updater.checkIntervalMs).toBe(15 * 60 * 1000);
  });

  test('an up-to-date agent installs nothing and says nothing', async () => {
    const h = harness({ latestTag: `v${CURRENT}` });
    await h.updater.tick();
    expect(h.applied).toHaveLength(0);
    expect(h.restarts).toHaveLength(0);
    expect(h.notices).toEqual([]);
  });

  test('an idle agent installs the update and restarts through the orderly exit', async () => {
    const h = harness();
    await h.updater.tick();
    expect(h.applied).toHaveLength(1);
    expect(h.restarts).toEqual([CURRENT]);
    expect(h.notices[0]).toContain('v1.1.0 is available');
    expect(h.notices[1]).toContain('updated to v1.1.0, restarting');
  });

  test('a busy agent NEVER swaps: the update waits and re-checks on the short cadence', async () => {
    let busy = true;
    const h = harness({ isIdle: () => !busy });
    await h.updater.tick();
    expect(h.applied).toHaveLength(0);
    expect(h.restarts).toHaveLength(0);
    // Back on the busy-retry cadence, not an hour away.
    expect(h.timers[h.timers.length - 1]!.ms).toBe(60_000);

    await h.updater.tick();
    expect(h.applied).toHaveLength(0);
    // The availability line is announced once, not on every retry.
    expect(h.notices.filter((line) => line.includes('is available'))).toHaveLength(1);

    busy = false;
    await h.updater.tick();
    expect(h.applied).toHaveLength(1);
    expect(h.restarts).toEqual([CURRENT]);
  });

  test('a failed install leaves the agent running and retries on the next interval', async () => {
    const h = harness({ applyThrows: true });
    await h.updater.tick();
    expect(h.restarts).toHaveLength(0);
    expect(h.timers[h.timers.length - 1]!.ms).toBe(DEFAULT_PERIODIC_INTERVAL_MINUTES * 60 * 1000);
  });

  test('stop() halts the loop', async () => {
    const h = harness();
    h.updater.start();
    h.updater.stop();
    await h.updater.tick();
    expect(h.applied).toHaveLength(0);
  });
});

describe('periodic self-update wiring', () => {
  const services = {
    // This process's OWN hosted sessions. A busy session on another surface
    // is not a reason to keep this binary from swapping itself out.
    hostedSessions: { countBusySessions: () => 0 },
    approvalsView: { snapshot: () => ({ approvals: [] }) },
  };

  function configWith(update: Record<string, unknown>): { getRaw(): Record<string, unknown> } {
    return { getRaw: () => ({ update }) };
  }

  test('update.auto=false is an explicit opt-out, and the teardown is safe to call', () => {
    const stop = startPeriodicSelfUpdate({
      configManager: configWith({ auto: false }) as never,
      services,
      notify: () => {},
      exit: () => {},
      execPath: '/opt/goodvibes/goodvibes-agent',
      currentVersion: CURRENT,
    });
    expect(() => stop()).not.toThrow();
  });

  test('a non-binary install never arms the loop: there is no file to swap', () => {
    const stop = startPeriodicSelfUpdate({
      configManager: configWith({}) as never,
      services,
      notify: () => {},
      exit: () => {},
      // A dev checkout runs through the bun interpreter, not a release binary.
      execPath: '/usr/bin/bun',
      currentVersion: CURRENT,
    });
    expect(() => stop()).not.toThrow();
  });
});
