/**
 * The auto-update loop never assumes the SDK package is the shipped artifact.
 *
 * - Embedded default (no artifact identity): even with update.auto=true and a
 *   releases URL configured, NO auto-update loop starts, the host manages
 *   updates, and the SDK package version is never compared against the host's
 *   release tags.
 * - With a host-provided artifact identity, the loop compares the HOST's
 *   version (and swaps the host-named executable), not the SDK's VERSION.
 */
import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonServer } from '../sdk/src/platform/daemon/facade.ts';
import { DaemonLifecycleRuntime, type DaemonLifecycleRuntimeOptions } from '../sdk/src/platform/daemon/facade-lifecycle.ts';
import { logger } from '../sdk/src/platform/utils/logger.ts';
import type { ServiceCommandRunner } from '../sdk/src/platform/daemon/service-handover.ts';
import { updateConfigDefaults } from '../sdk/src/platform/config/schema-domain-update.js';
import { VERSION } from '../sdk/src/platform/version.ts';

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

interface LifecycleHarness {
  readonly runtime: DaemonLifecycleRuntime;
  readonly installs: number[];
  readonly exits: number[];
}

function lifecycleWith(
  updateArtifact?: DaemonLifecycleRuntimeOptions['updateArtifact'],
  overrides: {
    readonly install?: (() => object) | undefined;
    readonly runner?: ServiceCommandRunner | undefined;
    readonly platform?: NodeJS.Platform | undefined;
    readonly timeoutMs?: number | undefined;
    readonly configOverrides?: Record<string, unknown>;
    readonly status?: (() => { installed: boolean; running: boolean }) | undefined;
    readonly isIdle?: (() => boolean) | undefined;
    readonly promotionRetryMs?: number | undefined;
    readonly isCompiledBinary?: (() => boolean) | undefined;
  } = {},
): LifecycleHarness {
  const scratch = mkdtempSync(join(tmpdir(), 'update-artifact-'));
  scratchDirs.push(scratch);
  const config = new Map<string, unknown>([
    ['update.auto', true],
    ['update.releasesUrl', 'https://releases.invalid/latest'],
    ['update.intervalMinutes', 60],
    ['service.serviceName', 'goodvibes-test'],
    ...Object.entries(overrides.configOverrides ?? {}),
  ]);
  const configManager = {
    get: (key: string) => config.get(key),
    getControlPlaneConfigDir: () => scratch,
  } as unknown as DaemonLifecycleRuntimeOptions['configManager'];
  const installs: number[] = [];
  const exits: number[] = [];
  const platformServiceManager = {
    status: overrides.status ?? (() => ({ installed: false, running: false })),
    install: () => { installs.push(Date.now()); return overrides.install?.() ?? {}; },
  } as unknown as DaemonLifecycleRuntimeOptions['platformServiceManager'];
  const runtime = new DaemonLifecycleRuntime({
    configManager,
    platformServiceManager,
    servicePlatform: overrides.platform ?? 'linux',
    serviceCommandRunner: overrides.runner ?? (async () => ({ status: 'accepted' })),
    serviceCommandTimeoutMs: overrides.timeoutMs ?? 100,
    stderr: { write: () => {} },
    isIdle: overrides.isIdle ?? (() => true),
    // Boot promotion hands over by exiting, tests OBSERVE the exit.
    exitProcess: (code: number) => { exits.push(code); },
    // These tests simulate a COMPILED daemon promoting; the bun-test process is
    // itself a source run, so default the seam to compiled and let a dev-gate
    // test flip it to false.
    isCompiledBinary: overrides.isCompiledBinary ?? (() => true),
    ...(overrides.promotionRetryMs !== undefined ? { promotionRetryMs: overrides.promotionRetryMs } : {}),
    ...(updateArtifact !== undefined ? { updateArtifact } : {}),
  });
  return { runtime, installs, exits };
}

function updaterOf(runtime: DaemonLifecycleRuntime): { readonly options: { currentVersion: string; execPath: string } } | null {
  return (runtime as unknown as { autoUpdater: { readonly options: { currentVersion: string; execPath: string } } | null }).autoUpdater;
}

describe('daemon update artifact identity', () => {
  test('embedded default: update.auto=true but no artifact identity: no loop starts', () => {
    const { runtime } = lifecycleWith(undefined);
    runtime.onStarted();
    try {
      expect(updaterOf(runtime)).toBeNull();
    } finally {
      runtime.onStopping(false);
    }
  });

  test('a host artifact identity drives the comparison: never the SDK package version', () => {
    const { runtime } = lifecycleWith({ version: '999.0.0-host-artifact', execPath: '/opt/host/bin/host-app' });
    runtime.onStarted();
    try {
      const updater = updaterOf(runtime);
      expect(updater).not.toBeNull();
      expect(updater!.options.currentVersion).toBe('999.0.0-host-artifact');
      // The embedder's identity is what gets compared and swapped, the SDK
      // package version must play no part when a host names its artifact.
      expect(updater!.options.currentVersion).not.toBe(VERSION);
      expect(updater!.options.execPath).toBe('/opt/host/bin/host-app');
    } finally {
      runtime.onStopping(false);
    }
  });

  test('an artifact identity without execPath swaps the running executable by default', () => {
    const { runtime } = lifecycleWith({ version: '999.0.0-host-artifact' });
    runtime.onStarted();
    try {
      expect(updaterOf(runtime)!.options.execPath).toBe(process.execPath);
    } finally {
      runtime.onStopping(false);
    }
  });
});

describe('no silent gates: every reason the update loop stays off is logged', () => {
  function infoLinesFor(overrides: Parameters<typeof lifecycleWith>[1], artifact?: DaemonLifecycleRuntimeOptions['updateArtifact']): string[] {
    const spy = spyOn(logger, 'info') as Mock<typeof logger.info>;
    const { runtime } = lifecycleWith(artifact, overrides);
    try {
      runtime.onStarted();
      return spy.mock.calls.map((call) => String(call[0]));
    } finally {
      runtime.onStopping(false);
      spy.mockRestore();
    }
  }

  test('update.auto not true says so, instead of returning in silence', () => {
    const lines = infoLinesFor({ configOverrides: { 'update.auto': false } }, { version: '1.0.0' });
    expect(lines.some((line) => line.includes('auto-update loop off') && line.includes('update.auto'))).toBe(true);
  });

  test('an empty releasesUrl says so, instead of returning in silence', () => {
    const lines = infoLinesFor({ configOverrides: { 'update.releasesUrl': '   ' } }, { version: '1.0.0' });
    expect(lines.some((line) => line.includes('auto-update loop off') && line.includes('update.releasesUrl'))).toBe(true);
  });

  test('no artifact identity says so', () => {
    const lines = infoLinesFor({});
    expect(lines.some((line) => line.includes('auto-update loop off') && line.includes('host-managed'))).toBe(true);
  });

  test('an armed loop announces its schedule, so "nothing updated" is never a guess', () => {
    const lines = infoLinesFor({}, { version: '1.0.0' });
    expect(lines.some((line) => line.includes('auto-update loop armed'))).toBe(true);
  });
});

describe('boot-edge service promotion (independent of updates)', () => {
  const artifact = { version: '999.0.0-host-artifact' };

  test('a standalone unsupervised idle daemon installs the unit and hands over at boot', async () => {
    const { runtime, installs, exits } = lifecycleWith(artifact);
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(1);
      await Bun.sleep(10);
      expect(exits).toEqual([0]);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('an embedded daemon (no artifact identity) never self-promotes: exiting would kill the host', () => {
    const { runtime, installs, exits } = lifecycleWith(undefined);
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('an already-supervised daemon is left alone', () => {
    const { runtime, installs, exits } = lifecycleWith(artifact, { status: () => ({ installed: true, running: true }) });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('service.enabled=false keeps the daemon session-only (opt-out honored)', () => {
    const { runtime, installs, exits } = lifecycleWith(artifact, { configOverrides: { 'service.enabled': false } });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('a platform without a service manager is left alone', () => {
    const { runtime, installs, exits } = lifecycleWith(artifact, { status: () => { throw new Error('unsupported'); } });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('a source/dev run never self-promotes (no unit written, no handover)', () => {
    // Everything else says "promote" (artifact identity, idle, not installed),
    // only the compiled-binary gate stops it, because a dev unit would fail on
    // the next boot.
    const { runtime, installs, exits } = lifecycleWith(artifact, { isCompiledBinary: () => false });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('a busy daemon defers promotion to the same idle moment the update swap waits for', async () => {
    let idle = false;
    const { runtime, installs, exits } = lifecycleWith(artifact, { isIdle: () => idle, promotionRetryMs: 1_000 });
    runtime.onStarted();
    try {
      // Busy at boot: no install, no handover.
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
      // Idle arrives; the retry tick promotes.
      idle = true;
      await Bun.sleep(1_200);
      expect(installs).toHaveLength(1);
      await Bun.sleep(10);
      expect(exits).toEqual([0]);
    } finally {
      runtime.onStopping(false);
    }
  });
});


describe('observed service handover', () => {
  const artifact = { version: '999.0.0-host-artifact' };
  for (const thrown of [new Error('install unavailable'), undefined]) {
    test(`install throwing ${String(thrown)} never exits`, async () => {
      const commands: string[][] = [];
      const h = lifecycleWith(artifact, { install: () => { throw thrown; }, runner: async (argv) => { commands.push([...argv]); return { status: 'accepted' }; } });
      h.runtime.onStarted();
      await Bun.sleep(10);
      expect(h.exits).toEqual([]);
      expect(commands).toEqual([]);
      expect(h.runtime.receiptStore().list().some((r) => r.text.includes('handover incomplete (failed)'))).toBe(true);
      await h.runtime.onStopping(false);
    });
  }
  for (const outcome of ['failed', 'unknown', 'unsupported'] as const) {
    test(`reload ${outcome} never enables or exits`, async () => {
      const commands: string[][] = [];
      const h = lifecycleWith(artifact, { runner: async (argv) => { commands.push([...argv]); return { status: outcome }; } });
      h.runtime.onStarted();
      await Bun.sleep(10);
      expect(h.exits).toEqual([]);
      expect(commands).toEqual([['systemctl', '--user', 'daemon-reload']]);
      await h.runtime.onStopping(false);
    });
  }
  test('reload is completed before start enqueue; duplicate starts make one handover', async () => {
    let release!: (outcome: { status: 'accepted' }) => void;
    const commands: string[][] = [];
    const h = lifecycleWith(artifact, { runner: async (argv) => {
      commands.push([...argv]);
      if (commands.length === 1) return new Promise((resolve) => { release = resolve; });
      return { status: 'accepted' };
    } });
    h.runtime.onStarted();
    h.runtime.onStarted();
    await Bun.sleep(1);
    expect(commands).toHaveLength(1);
    expect(h.exits).toEqual([]);
    release({ status: 'accepted' });
    await Bun.sleep(10);
    expect(commands).toEqual([['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', '--no-block', 'enable', '--now', 'goodvibes-test.service']]);
    expect(h.installs).toHaveLength(1);
    expect(h.exits).toEqual([0]);
    h.runtime.onStarted();
    await Bun.sleep(1);
    expect(h.exits).toEqual([0]);
    await h.runtime.onStopping(false);
  });
  for (const stage of ['reload', 'start'] as const) {
    for (const failure of ['failed', 'throw', 'timeout'] as const) {
      test(`${stage} ${failure} stays alive and owns errors`, async () => {
        let calls = 0;
        const h = lifecycleWith(artifact, { timeoutMs: 10, runner: async () => {
          calls++;
          if (stage === 'start' && calls === 1) return { status: 'accepted' };
          if (failure === 'throw') throw new Error('spawn failed');
          if (failure === 'timeout') return new Promise(() => {});
          return { status: 'failed', detail: 'nonzero' };
        } });
        h.runtime.onStarted();
        await Bun.sleep(25);
        expect(h.exits).toEqual([]);
        expect(calls).toBe(stage === 'start' ? 2 : 1);
        expect(h.runtime.receiptStore().list().some((r) => r.text.includes('handover incomplete'))).toBe(true);
        await h.runtime.onStopping(false);
      });
    }
  }
  test('unsupported platform never installs a unit or exits', async () => {
    const h = lifecycleWith(artifact, { platform: 'win32' });
    h.runtime.onStarted();
    await Bun.sleep(10);
    expect(h.installs).toEqual([]);
    expect(h.exits).toEqual([]);
    await h.runtime.onStopping(false);
  });
  test('close cancels and drains pending reload, owns late rejection, never starts or exits', async () => {
    let reject!: (reason: unknown) => void;
    let commands = 0;
    let aborted = false;
    const h = lifecycleWith(artifact, { runner: (_argv, signal) => {
      commands++;
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
    } });
    h.runtime.onStarted();
    await Bun.sleep(1);
    await h.runtime.onStopping(false);
    expect(aborted).toBe(true);
    reject(new Error('late error after cancellation'));
    await Bun.sleep(10);
    expect(commands).toBe(1);
    expect(h.exits).toEqual([]);
  });
});

test('early shutdown fence cancels promotion before slower shutdown hooks drain', async () => {
  let release!: (outcome: { status: 'accepted' }) => void;
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }, { runner: () => new Promise((resolve) => { release = resolve; }) });
  h.runtime.onStarted();
  await Bun.sleep(1);
  h.runtime.beginStopping();
  release({ status: 'accepted' });
  await Bun.sleep(5); // Simulate the facade awaiting other shutdown hooks.
  expect(h.exits).toEqual([]);
  await h.runtime.onStopping(false);
});

test('a stopped applied updater remains reachable for cancellation and cannot re-arm in process', async () => {
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }, { configOverrides: { 'service.enabled': false } });
  let stops = 0;
  let drains = 0;
  const applied = {
    stop: () => { stops++; },
    drainHandover: async () => { drains++; },
    snapshot: () => ({ appliedVersion: '1000.0.0', handover: { status: 'unknown' } }),
  };
  (h.runtime as unknown as { autoUpdater: unknown }).autoUpdater = applied;
  await h.runtime.onStopping(false); // The updater's own graceful stop.
  h.runtime.beginStopping(); // A later external close still reaches it.
  await h.runtime.onStopping(false);
  expect(stops).toBe(3);
  expect(drains).toBe(2);
  h.runtime.onStarted();
  expect(updaterOf(h.runtime)).toBeNull();
  expect(h.runtime.updateStatus().armed).toBe(false);
  expect(h.runtime.updateStatus().offReason).toContain('1000.0.0 is installed on disk');
  await h.runtime.onStopping(false);
});


test('handover repair does not activate the shipped default update configuration without an artifact', async () => {
  const defaults = updateConfigDefaults.update;
  expect(defaults.auto).toBe(true);
  expect(defaults.releasesUrl).toBe('https://github.com/mgd34msu/goodvibes-daemon/releases/latest');
  const h = lifecycleWith(undefined, { configOverrides: { 'update.auto': defaults.auto, 'update.releasesUrl': defaults.releasesUrl } });
  h.runtime.onStarted();
  expect(updaterOf(h.runtime)).toBeNull();
  expect(h.installs).toEqual([]);
  expect(h.exits).toEqual([]);
  await h.runtime.onStopping(false);
});


test('an already-torn-down facade still fences and drains a pending lifecycle handover', async () => {
  let release!: (outcome: { status: 'accepted' }) => void;
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }, { runner: () => new Promise((resolve) => { release = resolve; }) });
  h.runtime.onStarted();
  await Bun.sleep(1);
  // No server construction or listener: exercise only the actual duplicate-stop path.
  const facade = Object.assign(Object.create(DaemonServer.prototype) as object, {
    lifecycle: h.runtime, tornDown: true,
  }) as unknown as DaemonServer;
  await facade.stop();
  release({ status: 'accepted' });
  await Bun.sleep(1);
  expect(h.exits).toEqual([]);
  await h.runtime.onStopping(false);
});


test('close retains a settling update until its completed disk latch is visible', async () => {
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }, { configOverrides: { 'service.enabled': false } });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let appliedVersion: string | null = null;
  const applying = {
    stop: () => {},
    drainHandover: () => pending,
    snapshot: () => ({ appliedVersion, handover: { status: 'unknown' } }),
  };
  (h.runtime as unknown as { autoUpdater: unknown }).autoUpdater = applying;
  const close = h.runtime.onStopping(false);
  h.runtime.onStarted();
  expect((h.runtime as unknown as { autoUpdater: unknown }).autoUpdater).toBe(applying);
  appliedVersion = '1000.0.0';
  release();
  await close;
  h.runtime.onStarted();
  expect(updaterOf(h.runtime)).toBeNull();
  expect(h.runtime.updateStatus().offReason).toContain('1000.0.0 is installed on disk');
  await h.runtime.onStopping(false);
});

for (const committed of [false, true]) {
  test(`filesystem recovery is unarmed and retained across config restart (${committed ? 'committed' : 'uncommitted'})`, async () => {
    const h = lifecycleWith({ version: '999.0.0-host-artifact' });
    let ticks = 0;
    const evidence = {
      operation: 'update' as const, phase: committed ? 'cleanup' as const : 'commit' as const,
      committed, recoveryRequired: true, targets: ['/opt/host/bin/host-app'],
      recoveryPaths: ['/opt/host/bin/host-app.update-transaction'], recoveryErrors: ['synthetic cleanup failure'],
    };
    const updater = {
      stop: () => {}, drainHandover: async () => {}, tick: async () => { ticks++; },
      snapshot: () => ({ currentVersion: '999.0.0-host-artifact', releasesUrl: 'https://releases.invalid/latest',
        checkIntervalMs: 60_000, firstCheckDelayMs: 30_000, failedCheckCount: 1,
        lastCheckFailure: 'filesystem recovery requires inspection', pendingVersion: null,
        appliedVersion: committed ? '1000.0.0' : null, recoveryRequired: true, transactionRecovery: evidence,
      }),
    };
    (h.runtime as unknown as { autoUpdater: unknown }).autoUpdater = updater;
    const before = h.runtime.updateStatus();
    expect(before.armed).toBe(false);
    expect(before.offReason).toContain('filesystem recovery');
    expect(before.transactionRecovery).toEqual(evidence);
    await h.runtime.onStopping(true);
    h.runtime.onStarted();
    expect(updaterOf(h.runtime)).toBeNull();
    expect(h.runtime.updateStatus()).toEqual(before);
    await h.runtime.checkForUpdatesNow();
    expect(ticks).toBe(0);
    expect(h.installs).toEqual([]);
    expect(h.exits).toEqual([]);
    await h.runtime.onStopping(false);
    expect(h.runtime.updateStatus().transactionRecovery).toEqual(evidence);
  });
}

test('recovery discovered while close drains is retained before a new updater can be created', async () => {
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }, { configOverrides: { 'service.enabled': false } });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let recoveryRequired = false;
  const applying = {
    stop: () => {}, drainHandover: () => pending,
    snapshot: () => ({ appliedVersion: null, recoveryRequired, lastCheckFailure: 'filesystem recovery required' }),
  };
  (h.runtime as unknown as { autoUpdater: unknown }).autoUpdater = applying;
  const close = h.runtime.onStopping(true);
  h.runtime.onStarted();
  expect((h.runtime as unknown as { autoUpdater: unknown }).autoUpdater).toBe(applying);
  recoveryRequired = true;
  release(); await close;
  h.runtime.onStarted();
  expect(updaterOf(h.runtime)).toBeNull();
  expect(h.runtime.updateStatus().armed).toBe(false);
  expect(h.runtime.updateStatus().recoveryRequired).toBe(true);
  expect(h.runtime.updateStatus().offReason).toContain('filesystem recovery');
  await h.runtime.onStopping(false);
});

test('recovery discovered during promotion prevents the next service command and any exit', async () => {
  let release!: (outcome: { status: 'accepted' }) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const commands: string[][] = [];
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }, { runner: (argv) => {
    commands.push([...argv]);
    markStarted();
    return new Promise(resolve => { release = resolve; });
  } });
  let recoveryRequired = false;
  const updater = {
    stop: () => {}, drainHandover: async () => {},
    snapshot: () => ({ appliedVersion: null, recoveryRequired, lastCheckFailure: 'filesystem recovery required' }),
  };
  (h.runtime as unknown as { autoUpdater: unknown }).autoUpdater = updater;
  h.runtime.onStarted();
  await started;
  expect(commands).toEqual([['systemctl', '--user', 'daemon-reload']]);
  recoveryRequired = true;
  release({ status: 'accepted' });
  await h.runtime.drainHandovers();
  expect(commands).toHaveLength(1);
  expect(h.installs).toHaveLength(1); // Installation happened before recovery was observed.
  expect(h.exits).toEqual([]);
  expect(h.runtime.updateStatus().armed).toBe(false);
  await h.runtime.onStopping(false);
});
