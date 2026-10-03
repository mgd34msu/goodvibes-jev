/**
 * Boot-time start of an installed-but-stopped daemon, as the Agent wires it.
 *
 * The bootstrap wiring (wireAgentExternalServices) with an injected
 * discovery stub, proving the boot behaviors end to end: started with a
 * receipt, not-installed guidance unchanged, start-failure reason surfaced,
 * and a running daemon left untouched.
 */
import { describe, expect, test } from 'bun:test';
import type { HookDispatcher } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { RuntimeEventBus, DeferredStartupCoordinator, ExternalServicesHandle, HostServiceStatus } from '@/runtime/index.ts';
import type { DaemonServiceControl, DaemonServiceSnapshot } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { wireAgentExternalServices } from '../../runtime/bootstrap-external-services.ts';
import { AgentDaemonReceiptFeed } from '../../runtime/daemon-receipts.ts';
import type { SystemMessageRouter } from '../../core/system-message-router.ts';
import type { RuntimeServices } from '../../runtime/services.ts';
import type { UiRuntimeServices } from '../../runtime/ui-services.ts';

// ── Layer 1: the pure decision engine ──────────────────────────────────────

function snapshotOf(overrides: Partial<DaemonServiceSnapshot> = {}): DaemonServiceSnapshot {
  return {
    serviceName: 'goodvibes-daemon',
    platform: 'systemd',
    unitPath: '/home/user/.config/systemd/user/goodvibes-daemon.service',
    installed: true,
    running: false,
    startSupported: true,
    ...overrides,
  };
}

function spyControl(options: {
  snapshots: readonly DaemonServiceSnapshot[];
  startResult?: { ok: boolean; error?: string };
}): DaemonServiceControl & { readonly startCalls: string[]; readonly snapshotCalls: () => number } {
  const startCalls: string[] = [];
  let snapshotCount = 0;
  return {
    snapshot: () => {
      snapshotCount += 1;
      return options.snapshots;
    },
    start: (serviceName: string) => {
      startCalls.push(serviceName);
      return options.startResult ?? { ok: true };
    },
    startCalls,
    snapshotCalls: () => snapshotCount,
  };
}

/** A probe that yields the scripted sequence, then repeats its last value. */
function scriptedProbe(sequence: readonly ('online' | 'offline')[]): () => Promise<'online' | 'offline'> {
  let index = 0;
  return async () => {
    const value = sequence[Math.min(index, sequence.length - 1)]!;
    index += 1;
    return value;
  };
}

const NO_SLEEP = async (): Promise<void> => {};

// ── Layer 3: the bootstrap wiring ───────────────────────────────────────────

function statusOf(mode: HostServiceStatus['mode'], reason?: string): HostServiceStatus {
  return {
    mode,
    host: '127.0.0.1',
    port: 3421,
    baseUrl: 'http://127.0.0.1:3421',
    ...(reason ? { reason } : {}),
  };
}

function handleOf(daemonStatus: HostServiceStatus): ExternalServicesHandle {
  return {
    daemonServer: null,
    httpListener: null,
    daemonStatus,
    httpListenerStatus: statusOf('disabled'),
    listRecentControlPlaneEvents: () => [],
    stop: async () => {},
  };
}

/** Coordinator that runs each scheduled task immediately (microtask), like boot does eventually. */
function immediateCoordinator(): DeferredStartupCoordinator {
  return {
    schedule: (task) => Promise.resolve()
      .then(() => task.run())
      .catch((error) => { task.onError?.(error); }),
    drain: async () => {},
  };
}

function spyRouter(): SystemMessageRouter & { readonly highs: string[]; readonly lows: string[] } {
  const highs: string[] = [];
  const lows: string[] = [];
  return {
    high: (message: string) => { highs.push(message); },
    low: (message: string) => { lows.push(message); },
    highs,
    lows,
  } as unknown as SystemMessageRouter & { highs: string[]; lows: string[] };
}

function wireFixture(options: {
  discoverySequence: readonly HostServiceStatus[];
  control: DaemonServiceControl;
  probeSequence?: readonly ('online' | 'offline')[];
}) {
  const router = spyRouter();
  const discoveryCalls: number[] = [];
  let call = 0;
  const startServices = (async () => {
    discoveryCalls.push(call);
    const status = options.discoverySequence[Math.min(call, options.discoverySequence.length - 1)]!;
    call += 1;
    return handleOf(status);
  }) as unknown as typeof import('@/runtime/index.ts').startExternalServices;
  const uiServices = { platform: {} } as unknown as UiRuntimeServices;
  const controller = wireAgentExternalServices({
    configManager: { get: () => undefined },
    runtimeBus: {} as RuntimeEventBus,
    hookDispatcher: {} as HookDispatcher,
    // The injected control + probe below keep the wiring off every real
    // services field except the two receipt feeds (both attached
    // unconditionally at wire time) and the daemon-grade view handed to the
    // adopt-or-spawn policy, which, with adoptOnly, reads only
    // localUserAuthManager and configManager and never constructs a server.
    services: {
      daemonReceiptFeed: new AgentDaemonReceiptFeed(),
      memoryConsolidationReceiptFeed: new AgentDaemonReceiptFeed(),
      asDaemonGradeView: () => ({}) as never,
    } as unknown as RuntimeServices,
    uiServices,
    deferredStartup: immediateCoordinator(),
    systemMessageRouter: router,
    requestRender: () => {},
    startServices,
    connectedHostAutostart: {
      control: options.control,
      probeReachability: scriptedProbe(options.probeSequence ?? ['online']),
      waitTimeoutMs: 400,
      pollIntervalMs: 100,
      sleep: NO_SLEEP,
    },
  });
  return { controller, router, discoveryCalls: () => discoveryCalls.length };
}

describe('wireAgentExternalServices (boot wiring)', () => {
  test('probe-fail + installed + start succeeds: the session proceeds with one honest receipt', async () => {
    const control = spyControl({ snapshots: [snapshotOf()] });
    const fixture = wireFixture({
      discoverySequence: [statusOf('unavailable'), statusOf('external')],
      control,
      probeSequence: ['online'],
    });
    await fixture.controller.whenDiscovered();
    expect(control.startCalls).toEqual(['goodvibes-daemon']);
    // Discovery ran twice: the initial probe, then the re-probe that adopted.
    expect(fixture.discoveryCalls()).toBe(2);
    expect(fixture.controller.getStatus().daemonStatus.mode).toBe('external');
    expect(fixture.router.lows).toHaveLength(1);
    expect(fixture.router.lows[0]).toContain('Connected host was installed but stopped; started it');
    expect(fixture.router.highs).toEqual([]);
  });

  test('probe-fail + not installed: guidance path unchanged (no start, no re-probe, no receipt)', async () => {
    const control = spyControl({ snapshots: [snapshotOf({ installed: false })] });
    const fixture = wireFixture({
      discoverySequence: [statusOf('unavailable')],
      control,
      probeSequence: ['offline'],
    });
    await fixture.controller.whenDiscovered();
    expect(control.startCalls).toEqual([]);
    expect(fixture.discoveryCalls()).toBe(1);
    expect(fixture.controller.getStatus().daemonStatus.mode).toBe('unavailable');
    expect(fixture.router.lows).toEqual([]);
    expect(fixture.router.highs).toEqual([]);
  });

  test('probe-fail + start fails: the guidance includes the failure reason', async () => {
    const control = spyControl({
      snapshots: [snapshotOf()],
      startResult: { ok: false, error: 'unit goodvibes-daemon.service failed to start' },
    });
    const fixture = wireFixture({
      discoverySequence: [statusOf('unavailable')],
      control,
      probeSequence: ['offline'],
    });
    await fixture.controller.whenDiscovered();
    expect(fixture.discoveryCalls()).toBe(1);
    expect(fixture.router.highs).toHaveLength(1);
    expect(fixture.router.highs[0]).toContain('unit goodvibes-daemon.service failed to start');
    expect(fixture.router.highs[0]).toContain('goodvibes service start');
    expect(fixture.controller.getStatus().daemonStatus.mode).toBe('unavailable');
  });

  test('a running daemon is untouched: adoption skips detection and start entirely', async () => {
    const control = spyControl({ snapshots: [snapshotOf()] });
    const fixture = wireFixture({
      discoverySequence: [statusOf('external')],
      control,
      probeSequence: ['online'],
    });
    await fixture.controller.whenDiscovered();
    expect(control.snapshotCalls()).toBe(0);
    expect(control.startCalls).toEqual([]);
    expect(fixture.discoveryCalls()).toBe(1);
    expect(fixture.router.lows).toEqual([]);
    expect(fixture.router.highs).toEqual([]);
  });

  test('a held port is respected: no start, no messages', async () => {
    const control = spyControl({ snapshots: [snapshotOf()] });
    const fixture = wireFixture({
      discoverySequence: [statusOf('blocked', 'Configured daemon port is occupied by an unverified process')],
      control,
      probeSequence: ['offline'],
    });
    await fixture.controller.whenDiscovered();
    expect(control.startCalls).toEqual([]);
    expect(fixture.discoveryCalls()).toBe(1);
    expect(fixture.controller.getStatus().daemonStatus.mode).toBe('blocked');
  });

  test('an already-starting unit is adopted once it answers, with a receipt and no second start', async () => {
    const control = spyControl({ snapshots: [snapshotOf({ running: true })] });
    const fixture = wireFixture({
      discoverySequence: [statusOf('unavailable'), statusOf('external')],
      control,
      probeSequence: ['offline', 'online'],
    });
    await fixture.controller.whenDiscovered();
    expect(control.startCalls).toEqual([]);
    expect(fixture.discoveryCalls()).toBe(2);
    expect(fixture.router.lows).toHaveLength(1);
    expect(fixture.router.lows[0]).toContain('was already starting; connected once it answered');
  });
});
