/**
 * The daemon's hourly self-update loop: check cadence, the no-active-work
 * swap gate (a mid-turn daemon never swaps), service-manager restart,
 * adoption of an unsupervised daemon, and the update receipt. Time,
 * network, filesystem, activity, service actions, and exit all mocked.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DaemonAutoUpdater,
  defaultDownloadBaseUrl,
  type AutoUpdateServiceActions,
} from '../sdk/src/platform/daemon/auto-updater.js';
import { DaemonLifecycleRuntime, type DaemonLifecycleRuntimeOptions } from '../sdk/src/platform/daemon/facade-lifecycle.js';
import { DaemonReceiptStore } from '../sdk/src/platform/daemon/receipts.js';
import type { ServiceHandoverOutcome } from '../sdk/src/platform/daemon/service-handover.js';
import {
  BOOT_SETTLE_CHECK_DELAY_MS,
  PREVIOUS_FILE_SUFFIX,
  PeriodicUpdateLoop,
  sha256,
  type UpdateFetchLike,
  type UpdateFileIo,
} from '../sdk/src/platform/runtime/self-update.js';

import { createSystemOnePort, PINNED_MODEL, SqliteDecisionLog, withDecisionLog, type Questions } from '@goodvibes-jev/judgment';
import { installJudgmentPort, forgetFailureReadings } from '@goodvibes-jev/engine/errors';
import { failureReadingsPort } from './_helpers/failure-readings.ts';
let previousFailurePort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetFailureReadings();
  previousFailurePort = installJudgmentPort(failureReadingsPort([['getaddrinfo ENOTFOUND github.com', { transientNetwork: true }], ['repository access revoked', { category: 'authorization' }]]).port);
});
afterEach(() => { installJudgmentPort(previousFailurePort); forgetFailureReadings(); });

const LATEST_URL = 'https://example.test/releases/latest';
const NEW_TAG = 'v2.0.0';
const DAEMON_ASSET = 'goodvibes-daemon-linux-x64';
const NEW_DAEMON = Buffer.from('daemon-v2');

function memoryIo(initial: Record<string, Buffer>) {
  const files = new Map<string, Buffer>(Object.entries(initial));
  const mutations: string[] = [];
  const io: UpdateFileIo = {
    writeExclusive: (path, data) => {
      mutations.push(`claim:${path}`);
      if (files.has(path)) throw new Error(`file already exists: ${path}`);
      files.set(path, data);
    },
    remove: (path) => { mutations.push(`remove:${path}`); files.delete(path); },
    writeFile: (path, data) => { mutations.push(`write:${path}`); files.set(path, data); },
    rename: (from, to) => {
      mutations.push(`rename:${from}:${to}`);
      const data = files.get(from);
      if (data === undefined) throw new Error(`rename source missing: ${from}`);
      files.delete(from);
      files.set(to, data);
    },
    chmod: (path) => { mutations.push(`chmod:${path}`); },
    exists: (path) => files.has(path),
    mkdir: (path) => { mutations.push(`mkdir:${path}`); },
  };
  return { files, io, mutations };
}

function releaseFetch(overrides: { latestTag?: string; assetName?: string } = {}): { fetchImpl: UpdateFetchLike; requests: string[] } {
  const tag = overrides.latestTag ?? NEW_TAG;
  const assetName = overrides.assetName ?? DAEMON_ASSET;
  const base = defaultDownloadBaseUrl(LATEST_URL, tag);
  const manifest = `${sha256(NEW_DAEMON)}  ${assetName}\n`;
  const requests: string[] = [];
  const fetchImpl: UpdateFetchLike = async (url) => {
    requests.push(url);
    if (url === LATEST_URL) {
      return {
        ok: false, status: 302, url,
        headers: { get: (name: string) => (name.toLowerCase() === 'location' ? `https://example.test/releases/tag/${tag}` : null) },
        text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const body = url === `${base}/SHA256SUMS.txt`
      ? Buffer.from(manifest)
      : url === `${base}/${assetName}`
        ? NEW_DAEMON
        : null;
    if (!body) {
      return { ok: false, status: 404, url, headers: { get: () => null }, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      ok: true, status: 200, url, headers: { get: () => null },
      text: async () => body.toString('utf-8'),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return { fetchImpl, requests };
}

interface Harness {
  updater: DaemonAutoUpdater;
  files: Map<string, Buffer>;
  io: UpdateFileIo;
  mutations: string[];
  receipts: DaemonReceiptStore;
  actions: { supervised: boolean; adopted: number; restarted: number };
  exits: number[];
  timers: Array<{ fn: () => void; ms: number }>;
  requests: string[];
  /** Handover steps in the order they happened, so "stop first" is provable. */
  sequence: string[];
  scratch: string;
  /** Every line the updater put in front of the owner, in order. */
  alerts: string[];
}

function makeHarness(options: {
  idle: () => boolean;
  supervised?: boolean;
  platform?: NodeJS.Platform;
  latestTag?: string;
  currentVersion?: string;
  /** The version a crash-loop rollback rejected, as the lifecycle marker would report it. */
  rejectedVersion?: () => string | null;
  /** Consecutive failed checks before the owner is told. */
  alertAfterFailedChecks?: number;
  alertWindowMs?: number;
  updateTimeoutMs?: number;
  /** Replaces the release fetch entirely, used to make checks throw. */
  fetchOverride?: UpdateFetchLike;
  /** A movable clock, so the alert quiet window is provable without real time. */
  clock?: () => number;
  /** Synthetic service-manager results; these never invoke a real service. */
  serviceActions?: Partial<AutoUpdateServiceActions>;
  stopGracefully?: () => void | Promise<void>;
} ): Harness {
  const scratch = mkdtempSync(join(tmpdir(), 'auto-updater-'));
  const { files, io, mutations } = memoryIo({ '/opt/gv/goodvibes-daemon': Buffer.from('daemon-v1') });
  const { fetchImpl, requests } = releaseFetch({ assetName: options.platform === 'darwin' ? 'goodvibes-daemon-macos-x64' : DAEMON_ASSET, ...(options.latestTag ? { latestTag: options.latestTag } : {}) });
  const receipts = new DaemonReceiptStore(join(scratch, 'receipts.json'), { now: () => new Date(2026, 6, 12, 14, 30).getTime() });
  const actions = { supervised: options.supervised ?? true, adopted: 0, restarted: 0 };
  const sequence: string[] = [];
  const serviceActions: AutoUpdateServiceActions = {
    isSupervised: options.serviceActions?.isSupervised ?? (() => actions.supervised),
    adoptIntoService: (signal) => {
      actions.adopted += 1;
      sequence.push('adopt');
      return options.serviceActions?.adoptIntoService
        ? options.serviceActions.adoptIntoService(signal)
        : { status: 'accepted' as const };
    },
    restartService: (signal) => {
      actions.restarted += 1;
      sequence.push('restart');
      return options.serviceActions?.restartService
        ? options.serviceActions.restartService(signal)
        : { status: 'accepted' as const };
    },
  };
  const exits: number[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const alerts: string[] = [];
  const updater = new DaemonAutoUpdater({
    currentVersion: options.currentVersion ?? '1.0.0',
    execPath: '/opt/gv/goodvibes-daemon',
    platform: options.platform ?? 'linux',
    arch: 'x64',
    releasesLatestUrl: LATEST_URL,
    checkIntervalMs: 60 * 60 * 1000,
    busyRetryMs: 60 * 1000,
    isIdle: options.idle,
    serviceActions,
    receipts,
    fetchImpl: options.fetchOverride ?? fetchImpl,
    io,
    exitProcess: (code) => { exits.push(code); sequence.push('exit'); },
    stopGracefully: () => { sequence.push('stop'); return options.stopGracefully?.(); },
    now: options.clock ?? (() => new Date(2026, 6, 12, 14, 30).getTime()),
    alertOwner: (text) => void alerts.push(text),
    ...(options.rejectedVersion ? { rejectedVersion: options.rejectedVersion } : {}),
    ...(options.alertAfterFailedChecks !== undefined ? { alertAfterFailedChecks: options.alertAfterFailedChecks } : {}),
    ...(options.alertWindowMs !== undefined ? { alertWindowMs: options.alertWindowMs } : {}),
    ...(options.updateTimeoutMs !== undefined ? { updateTimeoutMs: options.updateTimeoutMs } : {}),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  return { updater, files, io, mutations, receipts, actions, exits, timers, requests, sequence, scratch, alerts };
}

/** A fetch that always throws, a check that cannot complete at all. */
const unreachableFetch: UpdateFetchLike = async () => {
  throw Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' });
};

describe('DaemonAutoUpdater', () => {
  test('boot-settle first check, then the hourly cadence; a current daemon does nothing', async () => {
    const h = makeHarness({ idle: () => true, latestTag: 'v1.0.0' });
    try {
      h.updater.start();
      expect(h.timers).toHaveLength(1);
      // The first check runs shortly after start, a daemon that was down
      // while releases shipped must not stay stale for another whole hour.
      expect(h.timers[0]!.ms).toBe(BOOT_SETTLE_CHECK_DELAY_MS);
      expect(h.updater.firstCheckDelayMs).toBe(BOOT_SETTLE_CHECK_DELAY_MS);
      expect(h.updater.checkIntervalMs).toBe(60 * 60 * 1000);

      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1');
      expect(h.actions.restarted).toBe(0);
      expect(h.receipts.list()).toHaveLength(0);
      // The follow-up is another full interval, not the busy-retry cadence.
      expect(h.timers[h.timers.length - 1]!.ms).toBe(60 * 60 * 1000);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('an idle daemon updates: verified swap with kept previous, restart via the service manager, and a receipt', async () => {
    const h = makeHarness({ idle: () => true });
    try {
      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.files.get(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('daemon-v1');
      expect(h.actions.restarted).toBe(1);
      expect(h.actions.adopted).toBe(0);
      expect(h.exits).toEqual([]);
      const receipts = h.receipts.list();
      expect(receipts).toHaveLength(1);
      // One update, one receipt, and it names the client restart, because a
      // swap replaces the daemon binary only: every client already attached
      // keeps its old build until it is restarted.
      expect(receipts[0]!.text).toStartWith('updated from 1.0.0 to 2.0.0 at 14:30');
      expect(receipts[0]!.text).toContain('keep their old build until restarted');
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('a mid-turn daemon NEVER swaps: the verified update waits for an idle moment on the retry cadence', async () => {
    let busy = true;
    const h = makeHarness({ idle: () => !busy });
    try {
      await h.updater.tick();
      // Busy: nothing swapped, nothing restarted, and the next check is the
      // short busy-retry, not the hourly interval.
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1');
      expect(h.files.has(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)).toBe(false);
      expect(h.actions.restarted).toBe(0);
      expect(h.timers[h.timers.length - 1]!.ms).toBe(60 * 1000);

      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1'); // still busy, still no swap

      busy = false;
      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.actions.restarted).toBe(1);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('an unsupervised daemon is adopted into the service and steps aside', async () => {
    const h = makeHarness({ idle: () => true, supervised: false });
    try {
      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.actions.adopted).toBe(1);
      expect(h.actions.restarted).toBe(0);
      expect(h.exits).toEqual([0]);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('the restart runs the daemon\'s orderly stop FIRST, so shutdown hooks fire on an update', async () => {
    const supervised = makeHarness({ idle: () => true });
    try {
      await supervised.updater.tick();
      expect(supervised.sequence).toEqual(['stop', 'restart']);
    } finally {
      rmSync(supervised.scratch, { recursive: true, force: true });
    }
    const unsupervised = makeHarness({ idle: () => true, supervised: false });
    try {
      await unsupervised.updater.tick();
      expect(unsupervised.sequence).toEqual(['stop', 'adopt', 'exit']);
    } finally {
      rmSync(unsupervised.scratch, { recursive: true, force: true });
    }
  });

  test('stop() halts the loop', async () => {
    const h = makeHarness({ idle: () => true });
    try {
      h.updater.start();
      h.updater.stop();
      const timersBefore = h.timers.length;
      await h.updater.tick(); // stopped: no work, no rescheduling
      expect(h.requests).toEqual([]);
      expect(h.timers.length).toBe(timersBefore);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });
});

/**
 * The lived failure: the daemon updated itself, the new build would not start,
 * the boot rollback restored the old one, and one check interval later the
 * loop downloaded and installed the identical release again. Install, fail,
 * roll back, reinstall, hourly, for days, while three releases shipped and the
 * installed daemon stayed where it was. Nothing on the machine said so.
 */
describe('a release that already crash looped here is not installed again', () => {
  test('the newest release is skipped when a rollback rejected it, and the swap never happens', async () => {
    const h = makeHarness({ idle: () => true, rejectedVersion: () => '2.0.0' });
    try {
      await h.updater.tick();
      // Nothing downloaded, nothing swapped, no restart: the tag lookup is the
      // only request that was made.
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1');
      expect(h.files.has(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)).toBe(false);
      expect(h.actions.restarted).toBe(0);
      expect(h.receipts.list()).toHaveLength(0);
      expect(h.requests).toEqual([LATEST_URL]);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('the tag form of the rejected version matches the bare form: v2.0.0 and 2.0.0 are one release', async () => {
    const h = makeHarness({ idle: () => true, rejectedVersion: () => 'v2.0.0' });
    try {
      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1');
      expect(h.actions.restarted).toBe(0);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('the owner is told once about the held-back release, not once per check', async () => {
    const h = makeHarness({ idle: () => true, rejectedVersion: () => '2.0.0' });
    try {
      for (let i = 0; i < 5; i++) await h.updater.tick();
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0]).toContain('not installing v2.0.0');
      expect(h.alerts[0]).toContain('failed to start');
      // It says what will un-stick it, and that no owner action is needed.
      expect(h.alerts[0]).toContain('as soon as a newer release ships');
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('a NEWER release than the rejected one installs normally: the daemon un-sticks itself', async () => {
    // The rollback rejected 2.0.0; the release that fixed it is 2.0.0 here only
    // because the fixture publishes one tag, so reject the version BELOW it.
    const h = makeHarness({ idle: () => true, rejectedVersion: () => '1.5.0' });
    try {
      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.actions.restarted).toBe(1);
      expect(h.alerts).toEqual([]);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('an unreadable rejection record never stops the daemon updating', async () => {
    const h = makeHarness({
      idle: () => true,
      rejectedVersion: () => { throw new Error('marker file is a directory'); },
    });
    try {
      await h.updater.tick();
      // Failing open costs one retry of a bad release; failing closed would
      // mean never updating again.
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });
});

const persistentFetch: UpdateFetchLike = async () => { throw new Error('repository access revoked'); };

/**
 * The other half of the same incident: an update path that has stopped working
 * must not stay a WARN line in a debug file. If it fails every hour for three
 * days, the owner hears about it.
 */
describe('repeated update-check failures reach the owner', () => {
  test('transient failures stay quiet regardless of their diagnostic count', async () => {
    const h = makeHarness({ idle: () => true, fetchOverride: unreachableFetch, alertAfterFailedChecks: 1 });
    try {
      for (let i = 0; i < 6; i++) await h.updater.tick();
      expect(h.updater.failedCheckCount).toBe(6);
      expect(h.alerts).toEqual([]);
      expect(h.updater.lastCheckFailure).toContain('getaddrinfo ENOTFOUND github.com');
    } finally { rmSync(h.scratch, { recursive: true, force: true }); }
  });

  test('persistent failure alerts on the first check, regardless of the deprecated threshold', async () => {
    const h = makeHarness({ idle: () => true, fetchOverride: persistentFetch, alertAfterFailedChecks: 100 });
    try {
      await h.updater.tick();
      expect(h.updater.failedCheckCount).toBe(1);
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0]).toContain('1 times in a row');
      expect(h.alerts[0]).toContain('repository access revoked');
    } finally { rmSync(h.scratch, { recursive: true, force: true }); }
  });

  test('a persistent failure is ONE message, not one an hour: the quiet window holds', async () => {
    let clock = new Date(2026, 6, 12, 14, 30).getTime();
    const h = makeHarness({
      idle: () => true,
      fetchOverride: persistentFetch,
      alertAfterFailedChecks: 1,
      alertWindowMs: 12 * 60 * 60 * 1000,
      clock: () => clock,
    });
    try {
      await h.updater.tick();
      expect(h.alerts).toHaveLength(1);
      // Seventy-one more hourly checks, all failing, inside the window.
      for (let i = 0; i < 71; i++) {
        clock += 60 * 60 * 1000;
        if (clock - new Date(2026, 6, 12, 14, 30).getTime() >= 12 * 60 * 60 * 1000) break;
        await h.updater.tick();
      }
      expect(h.alerts).toHaveLength(1);

      // Past the window and still broken: say it again rather than going quiet
      // forever on a daemon that has not updated in half a day.
      clock += 12 * 60 * 60 * 1000;
      await h.updater.tick();
      expect(h.alerts).toHaveLength(2);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('recovery is stated too, so the owner is not left believing it is still broken', async () => {
    let reachable = false;
    const working = releaseFetch({ latestTag: 'v1.0.0' }).fetchImpl; // current: no swap, just a completed check
    const h = makeHarness({
      idle: () => true,
      alertAfterFailedChecks: 2,
      fetchOverride: async (url) => (reachable ? working(url) : persistentFetch(url)),
    });
    try {
      await h.updater.tick();
      await h.updater.tick();
      expect(h.alerts).toHaveLength(1);

      reachable = true;
      await h.updater.tick();
      expect(h.updater.failedCheckCount).toBe(0);
      expect(h.updater.lastCheckFailure).toBeNull();
      expect(h.alerts).toHaveLength(2);
      expect(h.alerts[1]).toContain('working again');
      expect(h.alerts[1]).toContain('2 consecutive failures');
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('the schedule survives failure: a check that cannot complete still re-arms the next one', async () => {
    const h = makeHarness({ idle: () => true, fetchOverride: unreachableFetch, alertAfterFailedChecks: 3 });
    try {
      h.updater.start();
      expect(h.timers).toHaveLength(1);
      expect(h.timers[0]!.ms).toBe(BOOT_SETTLE_CHECK_DELAY_MS);
      // Twelve failing hours. Each one schedules the next at the full cadence:
      // a daemon that has stopped being able to update must keep TRYING, or
      // "it will retry" in the alert is not true.
      for (let i = 0; i < 12; i++) {
        await h.updater.tick();
        expect(h.timers[h.timers.length - 1]!.ms).toBe(60 * 60 * 1000);
      }
      expect(h.timers).toHaveLength(13);
      expect(h.updater.failedCheckCount).toBe(12);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('the schedule survives a held-back release too: the loop keeps checking for a newer one', async () => {
    const h = makeHarness({ idle: () => true, rejectedVersion: () => '2.0.0' });
    try {
      h.updater.start();
      for (let i = 0; i < 6; i++) {
        await h.updater.tick();
        // Settled, not deferred: the next check is a full interval away, and
        // there IS a next check, holding a release is not giving up.
        expect(h.timers[h.timers.length - 1]!.ms).toBe(60 * 60 * 1000);
      }
      expect(h.timers).toHaveLength(7);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('transient failures and their recovery never bother the owner', async () => {
    let reachable = false;
    const working = releaseFetch({ latestTag: 'v1.0.0' }).fetchImpl;
    const h = makeHarness({
      idle: () => true,
      alertAfterFailedChecks: 3,
      fetchOverride: async (url) => (reachable ? working(url) : unreachableFetch(url)),
    });
    try {
      await h.updater.tick();
      await h.updater.tick();
      reachable = true;
      await h.updater.tick();
      // Two failures then a success is a flaky network, not an incident.
      expect(h.alerts).toEqual([]);
      // And the count really reset, so the next two failures start from zero.
      reachable = false;
      await h.updater.tick();
      await h.updater.tick();
      expect(h.alerts).toEqual([]);
      expect(h.updater.failedCheckCount).toBe(2);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });
});

describe('update failure reading lifecycle', () => {
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  test('identical wording is reread for each owned failure rather than borrowing another check', async () => {
    const h = makeHarness({ idle: () => true, fetchOverride: persistentFetch });
    const transient = failureReadingsPort([['repository access revoked', { transientNetwork: true }]]);
    const persistent = failureReadingsPort([['repository access revoked', { category: 'authorization' }]]);
    try {
      installJudgmentPort(transient.port); await h.updater.tick(); expect(h.alerts).toEqual([]);
      installJudgmentPort(persistent.port); await h.updater.tick(); expect(h.alerts).toHaveLength(1);
      expect(transient.requests).toHaveLength(1); expect(persistent.requests).toHaveLength(1);
    } finally { rmSync(h.scratch, { recursive: true, force: true }); }
  });
  test('actual structured status is retained and does not require a hosted reading', async () => {
    installJudgmentPort(undefined);
    const h = makeHarness({ idle: () => true, fetchOverride: async () => { throw Object.assign(new Error('synthetic structured failure'), { status: 403 }); } });
    try { await h.updater.tick(); expect(h.alerts).toHaveLength(1); expect(h.updater.failedCheckCount).toBe(1); }
    finally { rmSync(h.scratch, { recursive: true, force: true }); }
  });
  test('semantic errors never fall back to a failure-count alert', async () => {
    let calls = 0;
    const fake = failureReadingsPort([]).port;
    installJudgmentPort({ model: fake.model, ask: async () => { calls++; throw new Error('synthetic terminal reading error'); } });
    const h = makeHarness({ idle: () => true, fetchOverride: persistentFetch, alertAfterFailedChecks: 1 });
    try {
      await h.updater.tick(); expect(calls).toBe(1); expect(h.alerts).toEqual([]); expect(h.updater.failedCheckCount).toBe(1);
      expect(h.timers).toHaveLength(1);
    } finally { rmSync(h.scratch, { recursive: true, force: true }); }
  });
  test('protected error wording and plain-object causes never reach judgment or owner notices', async () => {
    const fake = failureReadingsPort([]); installJudgmentPort(fake.port);
    for (const error of ['x'.repeat(300) + ' Authorization: Bearer synthetic-secret', new Error('Authorization: Bearer synthetic-secret'), new Error('lookup failed', { cause: { message: 'Authorization: Bearer synthetic-secret' } })]) {
      const h = makeHarness({ idle: () => true, fetchOverride: async () => { throw error; } });
      try { await h.updater.tick(); expect(fake.requests).toEqual([]); expect(h.alerts).toEqual([]); expect(h.updater.lastCheckFailure).toBeNull(); }
      finally { rmSync(h.scratch, { recursive: true, force: true }); }
    }
  });
  test('failure capture refuses accessors and proxies without invoking them', async () => {
    const fake = failureReadingsPort([]); installJudgmentPort(fake.port); let accessed = 0;
    const accessor = new Error('placeholder'); Object.defineProperty(accessor, 'message', { get() { accessed++; return 'repository access revoked'; } });
    const proxy = new Proxy(new Error('placeholder'), { get() { accessed++; return 'repository access revoked'; }, getPrototypeOf() { accessed++; return Error.prototype; } });
    for (const error of [accessor, proxy]) {
      const h = makeHarness({ idle: () => true, fetchOverride: async () => { throw error; } });
      try { await h.updater.tick(); expect(accessed).toBe(0); expect(fake.requests).toEqual([]); expect(h.alerts).toEqual([]); }
      finally { rmSync(h.scratch, { recursive: true, force: true }); }
    }
  });
  test('full primitive and serialized plain-object wording is screened before display truncation', async () => {
    const fake = failureReadingsPort([]); installJudgmentPort(fake.port);
    for (const error of [Symbol('x'.repeat(300) + ' Authorization: Bearer synthetic-secret'), { explanation: 'x'.repeat(300) + ' Authorization: Bearer synthetic-secret' }]) {
      const h = makeHarness({ idle: () => true, fetchOverride: async () => { throw error; } });
      try { await h.updater.tick(); expect(fake.requests).toEqual([]); expect(h.alerts).toEqual([]); expect(h.updater.lastCheckFailure).toBeNull(); }
      finally { rmSync(h.scratch, { recursive: true, force: true }); }
    }
  });
  test('classification sees the complete admitted message rather than its bounded display summary', async () => {
    const wording = 'ordinary diagnostic '.repeat(30) + 'repository access revoked';
    const fake = failureReadingsPort([['repository access revoked', { category: 'authorization' }]]); installJudgmentPort(fake.port);
    const h = makeHarness({ idle: () => true, fetchOverride: async () => { throw { message: wording }; } });
    try {
      await h.updater.tick(); expect(fake.requests).toHaveLength(1); expect(String(fake.requests[0]!.state)).toContain(wording);
      expect(h.updater.lastCheckFailure!.length).toBeLessThan(wording.length); expect(h.alerts).toHaveLength(1);
    } finally { rmSync(h.scratch, { recursive: true, force: true }); }
  });
  test('stop drains a noncooperative pending reading and no late result records or alerts', async () => {
    const started = deferred<void>(); const finish = deferred<void>(); const log = new SqliteDecisionLog(':memory:');
    const fake = failureReadingsPort([['repository access revoked', { category: 'authorization' }]]).port;
    installJudgmentPort(withDecisionLog({ model: fake.model, async ask(request) {
      started.resolve(); await finish.promise; return fake.ask(request);
    } }, log));
    const h = makeHarness({ idle: () => true, fetchOverride: persistentFetch });
    try {
      const tick = h.updater.tick(); await started.promise;
      expect(h.alerts).toEqual([]); h.updater.stop();
      await h.updater.drainHandover(); await tick; expect(h.alerts).toEqual([]);
      finish.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
      expect(log.query({})).toHaveLength(0); expect(h.alerts).toEqual([]); expect(h.timers).toHaveLength(0);
    } finally { finish.resolve(); log[Symbol.dispose](); rmSync(h.scratch, { recursive: true, force: true }); }
  });
  test('availability retries remain within one updater check and alert only after recovery', async () => {
    let calls = 0; let reads = 0;
    const fake = failureReadingsPort([['repository access revoked', { category: 'authorization' }]]).port;
    const h = makeHarness({ idle: () => true, fetchOverride: async () => { reads++; return persistentFetch('ignored'); } });
    installJudgmentPort(createSystemOnePort({
      endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-key' }, model: PINNED_MODEL,
      timeoutMs: 100, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 },
      fetch: async (_url, init) => {
        calls++; expect(h.alerts).toEqual([]); expect(h.updater.failedCheckCount).toBe(1);
        if (calls <= 2) return Response.json({}, { status: 503 });
        const body = JSON.parse(String(init?.body)) as { state: string; questions: Questions };
        const result = await fake.ask(body);
        return Response.json({ model: PINNED_MODEL, answers: result.answers, usage: { input_tokens: 1, output_tokens: 1 } });
      },
    }));
    try { await h.updater.tick(); expect(calls).toBe(3); expect(reads).toBe(1); expect(h.alerts).toHaveLength(1); }
    finally { rmSync(h.scratch, { recursive: true, force: true }); }
  });
});

describe('post-swap service handover', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  test('external stop promptly drains a noncooperative scheduled release lookup', async () => {
    const lookupStarted = deferred<void>();
    const lookupFinished = deferred<void>();
    const release = releaseFetch();
    let requestSignal: AbortSignal | undefined;
    const h = makeHarness({
      idle: () => true,
      fetchOverride: async (url, init) => {
        requestSignal = init?.signal;
        lookupStarted.resolve();
        await lookupFinished.promise;
        return release.fetchImpl(url, init);
      },
    });
    h.updater.start();
    h.timers[0]!.fn();
    const tick = h.updater.drainHandover();
    try {
      await lookupStarted.promise;
      h.updater.stop();
      await h.updater.drainHandover();
      await tick;
      expect(requestSignal?.aborted).toBe(true);
      expect(release.requests).toEqual([]);
      expect([...h.files.keys()]).toEqual(['/opt/gv/goodvibes-daemon']);
      expect(h.sequence).toEqual([]);
      expect(h.receipts.list()).toHaveLength(0);
      expect(h.updater.snapshot().appliedVersion).toBeNull();
      expect(h.timers).toHaveLength(1);
      lookupFinished.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(release.requests).toEqual([LATEST_URL]);
      expect([...h.files.keys()]).toEqual(['/opt/gv/goodvibes-daemon']);
    } finally {
      lookupFinished.resolve();
      await tick;
      rmSync(h.scratch, { recursive: true, force: true });
    }
  }, 2_000);

  for (const phase of ['manifest headers', 'manifest body', 'artifact headers', 'artifact body'] as const) {
    for (const lateOutcome of ['resolve', 'reject'] as const) {
      test(`stop drains noncooperative ${phase}; late ${lateOutcome} cannot write or hand over`, async () => {
        const started = deferred<void>();
        const finish = deferred<void>();
        const release = releaseFetch();
        let requestSignal: AbortSignal | undefined;
        const wait = async () => { started.resolve(); await finish.promise; };
        const h = makeHarness({
          idle: () => true,
          fetchOverride: async (url, init) => {
            const matches = phase.startsWith('manifest') ? url.endsWith('/SHA256SUMS.txt') : url.endsWith(`/${DAEMON_ASSET}`);
            if (matches) {
              requestSignal = init?.signal;
              if (phase.endsWith('headers')) await wait();
            }
            const response = await release.fetchImpl(url, init);
            if (!matches || phase.endsWith('headers')) return response;
            return {
              ...response,
              text: async () => { await wait(); return response.text(); },
              arrayBuffer: async () => { await wait(); return response.arrayBuffer(); },
            };
          },
        });
        const tick = h.updater.tick();
        try {
          await started.promise;
          h.updater.stop();
          await h.updater.drainHandover();
          await tick;
          expect(requestSignal?.aborted).toBe(true);
          expect([...h.files.entries()].map(([path, data]) => [path, data.toString()])).toEqual([['/opt/gv/goodvibes-daemon', 'daemon-v1']]);
          expect(h.updater.snapshot().appliedVersion).toBeNull();
          expect(h.updater.snapshot().pendingVersion).toBeNull();
          expect(h.updater.failedCheckCount).toBe(0);
          expect(h.mutations).toEqual([]);
          expect(h.sequence).toEqual([]);
          expect(h.receipts.list()).toHaveLength(0);
          expect(h.alerts).toEqual([]);
          if (lateOutcome === 'reject') finish.reject(new Error('late synthetic download failure'));
          else finish.resolve();
          await new Promise(resolve => setTimeout(resolve, 0));
          expect([...h.files.keys()]).toEqual(['/opt/gv/goodvibes-daemon']);
          expect(h.sequence).toEqual([]);
          expect(h.alerts).toEqual([]);
          expect(h.timers).toHaveLength(0);
          expect(h.mutations).toEqual([]);
        } finally {
          h.updater.stop(); finish.resolve(); await tick;
          rmSync(h.scratch, { recursive: true, force: true });
        }
      }, 2_000);
    }
  }

  test('a stopped check cannot commit after start creates a new lifecycle', async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const release = releaseFetch();
    let hold = true;
    const h = makeHarness({
      idle: () => true,
      fetchOverride: async (url, init) => {
        if (hold && url.endsWith(`/${DAEMON_ASSET}`)) { started.resolve(); await finish.promise; }
        return release.fetchImpl(url, init);
      },
    });
    const tick = h.updater.tick();
    try {
      await started.promise;
      h.updater.stop(); h.updater.start();
      await h.updater.drainHandover(); await tick;
      finish.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
      expect([...h.files.keys()]).toEqual(['/opt/gv/goodvibes-daemon']);
      expect(h.sequence).toEqual([]);
      hold = false;
      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.actions.restarted).toBe(1);
    } finally {
      h.updater.stop(); finish.resolve(); await tick;
      rmSync(h.scratch, { recursive: true, force: true });
    }
  }, 2_000);

  test('becoming busy during download discards staged bytes and retries on the busy cadence', async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const release = releaseFetch();
    let idle = true;
    const h = makeHarness({
      idle: () => idle,
      fetchOverride: async (url, init) => {
        if (url.endsWith(`/${DAEMON_ASSET}`)) { started.resolve(); await finish.promise; }
        return release.fetchImpl(url, init);
      },
    });
    const tick = h.updater.tick();
    try {
      await started.promise; idle = false; finish.resolve(); await tick;
      expect([...h.files.keys()]).toEqual(['/opt/gv/goodvibes-daemon']);
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1');
      expect(h.updater.snapshot().pendingVersion).toBe('2.0.0');
      expect(h.updater.snapshot().appliedVersion).toBeNull();
      expect(h.updater.failedCheckCount).toBe(0);
      expect(h.sequence).toEqual([]);
      expect(h.alerts).toEqual([]);
      expect(h.timers.at(-1)?.ms).toBe(60_000);
      idle = true; await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(release.requests.filter(url => url === LATEST_URL)).toHaveLength(1);
      expect(h.actions.restarted).toBe(1);
    } finally {
      h.updater.stop(); finish.resolve(); await tick;
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('final admission detects a synchronous stop in staging and removes every owned file', async () => {
    const h = makeHarness({ idle: () => true });
    let renames = 0;
    const rename = h.io.rename;
    h.io.rename = (from, to) => { renames++; rename(from, to); };
    h.io.chmod = () => h.updater.stop();
    try {
      await h.updater.tick(); await h.updater.drainHandover();
      expect(renames).toBe(0);
      expect([...h.files.keys()]).toEqual(['/opt/gv/goodvibes-daemon']);
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1');
      expect(h.sequence).toEqual([]);
      expect(h.receipts.list()).toHaveLength(0);
      expect(h.alerts).toEqual([]);
    } finally { h.updater.stop(); rmSync(h.scratch, { recursive: true, force: true }); }
  });

  test('stop after the synchronous commit preserves its disk receipt and suppresses handover', async () => {
    const h = makeHarness({ idle: () => true });
    const rename = h.io.rename;
    h.io.rename = (from, to) => {
      rename(from, to);
      if (from.endsWith('.update-download')) h.updater.stop();
    };
    try {
      await h.updater.tick(); await h.updater.drainHandover();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.files.get('/opt/gv/goodvibes-daemon.previous')?.toString()).toBe('daemon-v1');
      expect(h.updater.snapshot().appliedVersion).toBe('2.0.0');
      expect(h.sequence).toEqual([]);
      expect(h.receipts.list()).toHaveLength(2);
      expect(h.receipts.list()[0]!.text).toContain('on disk');
      expect(h.updater.snapshot().handover?.detail).toContain('updater stopped while applying');
      const requests = h.requests.length;
      h.updater.start(); await h.updater.tick();
      expect(h.requests).toHaveLength(requests);
      expect(h.alerts).toHaveLength(1);
    } finally { h.updater.stop(); rmSync(h.scratch, { recursive: true, force: true }); }
  });

  test('final admission checks lifecycle again after the activity probe', async () => {
    let probes = 0;
    let updater!: DaemonAutoUpdater;
    const h = makeHarness({ idle: () => { if (++probes === 2) { updater.stop(); updater.start(); } return true; } });
    updater = h.updater;
    try {
      await h.updater.tick();
      expect(probes).toBe(2);
      expect([...h.files.keys()]).toEqual(['/opt/gv/goodvibes-daemon']);
      expect(h.sequence).toEqual([]);
      expect(h.alerts).toEqual([]);
    } finally { h.updater.stop(); rmSync(h.scratch, { recursive: true, force: true }); }
  });

  for (const body of [false, true]) {
    test(`deadline bounds noncooperative artifact ${body ? 'body' : 'headers'} and fences late bytes`, async () => {
      const started = deferred<void>(); const finish = deferred<void>();
      const fake = failureReadingsPort([['update timed out', { transientNetwork: true }]]);
      installJudgmentPort(fake.port);
      const release = releaseFetch();
      let requestSignal: AbortSignal | undefined;
      const wait = async () => { started.resolve(); await finish.promise; };
      const h = makeHarness({
        idle: () => true, updateTimeoutMs: 25,
        fetchOverride: async (url, init) => {
          if (!url.endsWith(`/${DAEMON_ASSET}`)) return release.fetchImpl(url, init);
          requestSignal = init?.signal;
          if (!body) await wait();
          const response = await release.fetchImpl(url, init);
          return body ? { ...response, arrayBuffer: async () => { await wait(); return response.arrayBuffer(); } } : response;
        },
      });
      const tick = h.updater.tick();
      try {
        await started.promise; await tick; await h.updater.drainHandover();
        expect(requestSignal?.aborted).toBe(true);
        expect([...h.files.keys()]).toEqual(['/opt/gv/goodvibes-daemon']);
        expect(h.updater.failedCheckCount).toBe(1);
        expect(fake.requests).toHaveLength(1);
        expect(h.alerts).toEqual([]);
        finish.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
        expect([...h.files.keys()]).toEqual(['/opt/gv/goodvibes-daemon']);
        expect(h.sequence).toEqual([]);
        expect(h.timers.at(-1)?.ms).toBe(60 * 60 * 1_000);
      } finally { h.updater.stop(); finish.resolve(); await tick; rmSync(h.scratch, { recursive: true, force: true }); }
    }, 2_000);
  }

  test('a stop during staging cannot hide a failed cleanup or re-arm an unsafe transaction', async () => {
    const h = makeHarness({ idle: () => true });
    const remove = h.io.remove!;
    h.io.chmod = () => h.updater.stop();
    h.io.remove = (path) => {
      if (path.endsWith('.update-download')) throw new Error('synthetic staged cleanup failure');
      remove(path);
    };
    try {
      await h.updater.tick(); await h.updater.drainHandover();
      expect(h.updater.snapshot().recoveryRequired).toBe(true);
      expect(h.updater.snapshot().appliedVersion).toBeNull();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1');
      expect(h.files.has('/opt/gv/goodvibes-daemon.update-transaction')).toBe(true);
      expect(h.files.has('/opt/gv/goodvibes-daemon.update-download')).toBe(true);
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0]).toContain('filesystem recovery');
      expect(h.sequence).toEqual([]);
      const requests = h.requests.length;
      h.updater.start(); await h.updater.tick();
      expect(h.requests).toHaveLength(requests);
    } finally { h.updater.stop(); rmSync(h.scratch, { recursive: true, force: true }); }
  });

  test('the monotonic deadline is checked after synchronous staging before any live rename', async () => {
    installJudgmentPort(failureReadingsPort([['timed out before commit', { transientNetwork: true }], ['deadline exceeded', { transientNetwork: true }]]).port);
    const h = makeHarness({ idle: () => true, updateTimeoutMs: 50 });
    let renames = 0;
    h.io.chmod = () => { const until = performance.now() + 55; while (performance.now() < until) { /* synthetic synchronous staging */ } };
    h.io.rename = () => { renames++; };
    try {
      await h.updater.tick();
      expect(renames).toBe(0);
      expect([...h.files.keys()]).toEqual(['/opt/gv/goodvibes-daemon']);
      expect(h.sequence).toEqual([]);
      expect(h.updater.failedCheckCount).toBe(1);
      expect(h.updater.lastCheckFailure).toMatch(/timed out before commit|deadline exceeded/);
      expect(h.updater.snapshot().recoveryRequired).toBe(false);
    } finally { h.updater.stop(); rmSync(h.scratch, { recursive: true, force: true }); }
  });

  for (const fails of [false, true]) {
    test(`completed ${fails ? 'failed' : 'successful'} request removes deadline timers and lifecycle listeners`, async () => {
      const signals = new Map<AbortSignal, { events: number; reason?: unknown }>();
      const release = releaseFetch();
      const h = makeHarness({
        idle: () => true, updateTimeoutMs: 40,
        fetchOverride: async (url, init) => {
          const signal = init?.signal;
          if (signal && !signals.has(signal)) {
            const observed = { events: 0, reason: undefined as unknown };
            signals.set(signal, observed);
            signal.addEventListener('abort', () => { observed.events++; observed.reason = signal.reason; });
          }
          if (fails) throw Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' });
          return release.fetchImpl(url, init);
        },
      });
      try {
        await h.updater.tick();
        expect(signals.size).toBe(fails ? 1 : 2);
        // Scope disposal aborts once to release any unconsumed response body.
        // A later lifecycle stop or old deadline must not change that outcome.
        for (const [signal, observed] of signals) {
          expect(signal.aborted).toBe(true);
          expect(observed.events).toBe(1);
          expect(observed.reason).toBe(signal.reason);
        }
        h.updater.stop();
        await new Promise(resolve => setTimeout(resolve, 60));
        for (const [signal, observed] of signals) {
          expect(observed.events).toBe(1);
          expect(observed.reason).toBe(signal.reason);
        }
      } finally { h.updater.stop(); rmSync(h.scratch, { recursive: true, force: true }); }
    });
  }

  for (const committed of [false, true]) {
    test(`${committed ? 'committed cleanup' : 'incomplete undo'} recovery permanently fences this updater without handover`, async () => {
      const h = makeHarness({ idle: () => true });
      const remove = h.io.remove!;
      const rename = h.io.rename;
      if (committed) h.io.remove = (path) => { if (path.endsWith('.update-transaction')) throw new Error('synthetic claim cleanup failure'); remove(path); };
      else h.io.rename = (from, to) => {
        if (from.endsWith('.update-download') || from.endsWith('.previous')) throw new Error('synthetic commit and undo failure');
        rename(from, to);
      };
      try {
        await h.updater.tick();
        expect(h.updater.snapshot().recoveryRequired).toBe(true);
        expect(h.updater.snapshot().appliedVersion).toBe(committed ? '2.0.0' : null);
        expect(h.updater.snapshot().transactionRecovery?.committed).toBe(committed);
        expect(h.updater.snapshot().transactionRecovery?.recoveryPaths).toContain('/opt/gv/goodvibes-daemon.update-transaction');
        expect(h.updater.snapshot().transactionRecovery?.phase).toBe(committed ? 'cleanup' : 'commit');
        const evidence = h.updater.snapshot().transactionRecovery!;
        const expected = { ...evidence, targets: [...evidence.targets], recoveryPaths: [...evidence.recoveryPaths], recoveryErrors: [...evidence.recoveryErrors] };
        (evidence.targets as string[]).length = 0;
        (evidence.recoveryPaths as string[]).length = 0;
        (evidence.recoveryErrors as string[]).push('external mutation');
        expect(h.updater.snapshot().transactionRecovery).toEqual(expected);
        expect(h.updater.snapshot().recoveryRequired).toBe(true);
        expect(h.files.has('/opt/gv/goodvibes-daemon.update-transaction')).toBe(true);
        expect(h.sequence).toEqual([]);
        expect(h.alerts).toHaveLength(1);
        expect(h.alerts[0]).toContain('filesystem recovery');
        expect(h.receipts.list()).toHaveLength(1);
        expect(h.updater.failedCheckCount).toBe(1);
        expect(h.updater.lastCheckFailure).toContain('filesystem recovery');
        const requests = h.requests.length;
        h.updater.start(); await h.updater.tick();
        expect(h.requests).toHaveLength(requests);
        expect(h.timers).toHaveLength(0);
      } finally { h.updater.stop(); rmSync(h.scratch, { recursive: true, force: true }); }
    });
  }

  test('draining a stopped check performs no new failure reading or alert', async () => {
    const fetchStarted = deferred<void>();
    const fetchFinished = deferred<void>();
    const h = makeHarness({
      idle: () => true,
      fetchOverride: async () => {
        fetchStarted.resolve();
        await fetchFinished.promise;
        throw new Error('lookup failed while stopping');
      },
    });
    h.updater.start();
    h.timers[0]!.fn();
    const check = h.updater.drainHandover();
    try {
      await fetchStarted.promise;
      h.updater.stop();
      const drain = h.updater.drainHandover();
      fetchFinished.resolve();
      await expect(drain).resolves.toBeUndefined();
      expect(h.updater.failedCheckCount).toBe(0);
      expect(h.updater.lastCheckFailure).toBeNull();
      expect(h.alerts).toEqual([]);
      expect(h.updater.snapshot().appliedVersion).toBeNull();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1');
      expect(h.sequence).toEqual([]);
      expect(h.timers).toHaveLength(1);
    } finally {
      fetchFinished.resolve();
      await check;
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('failed adoption keeps the disk update but never claims a successful exit', async () => {
    const h = makeHarness({
      idle: () => true,
      supervised: false,
      serviceActions: { adoptIntoService: () => ({ status: 'failed', detail: 'launch rejected' }) },
    });
    try {
      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.files.get(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('daemon-v1');
      expect(h.exits).toEqual([]);
      expect(h.alerts.join('\n')).toContain('launch rejected');
      const persisted = readFileSync(join(h.scratch, 'receipts.json'), 'utf-8');
      expect(persisted).toContain('updated from 1.0.0 to 2.0.0');
      expect(persisted).toContain('on disk');
      expect(persisted).toContain('service handover is incomplete');
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('legacy void adoption cannot authorize exit', async () => {
    const h = makeHarness({
      idle: () => true,
      supervised: false,
      serviceActions: { adoptIntoService: () => {} },
    });
    try {
      await h.updater.tick();
      expect(h.exits).toEqual([]);
      expect(h.alerts.join('\n')).toContain('unknown');
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('an incomplete handover never swaps the applied release again or destroys its previous binary', async () => {
    const h = makeHarness({
      idle: () => true,
      serviceActions: { restartService: () => ({ status: 'failed', detail: 'restart rejected' }) },
    });
    try {
      await h.updater.tick();
      const requestsAfterSwap = h.requests.length;
      const timersAfterSwap = h.timers.length;
      // Even an explicit start in this old process cannot re-arm a completed swap.
      h.updater.start();
      await h.updater.tick();
      expect(h.requests).toHaveLength(requestsAfterSwap);
      expect(h.files.get(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('daemon-v1');
      expect(h.actions.restarted).toBe(1);
      expect(h.timers).toHaveLength(timersAfterSwap);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  const incompleteActions: Array<{
    name: string;
    action: AutoUpdateServiceActions['restartService'];
    status: ServiceHandoverOutcome['status'];
    detail: string;
  }> = [
    { name: 'failed', action: () => ({ status: 'failed', detail: 'request rejected' }), status: 'failed', detail: 'request rejected' },
    { name: 'unsupported', action: () => ({ status: 'unsupported', detail: 'no supported manager' }), status: 'unsupported', detail: 'no supported manager' },
    { name: 'unknown', action: () => ({ status: 'unknown', detail: 'no acknowledgement' }), status: 'unknown', detail: 'no acknowledgement' },
    { name: 'legacy void', action: () => {}, status: 'unknown', detail: 'no handover acknowledgement' },
    { name: 'async legacy void', action: async () => {}, status: 'unknown', detail: 'no handover acknowledgement' },
    { name: 'thrown Error', action: () => { throw new Error('service exploded'); }, status: 'failed', detail: 'service exploded' },
    { name: 'thrown undefined', action: () => { throw undefined; }, status: 'failed', detail: 'undefined' },
    { name: 'rejected Error', action: async () => { throw new Error('async service exploded'); }, status: 'failed', detail: 'async service exploded' },
    { name: 'rejected undefined', action: async () => { throw undefined; }, status: 'failed', detail: 'undefined' },
  ];

  for (const supervised of [true, false]) {
    const actionName = supervised ? 'restart' : 'adoption';
    test(`${actionName}: external stop during graceful shutdown prevents all later service actions`, async () => {
      const stopStarted = deferred<void>();
      const stopFinished = deferred<void>();
      const h = makeHarness({
        idle: () => true,
        supervised,
        stopGracefully: () => { stopStarted.resolve(); return stopFinished.promise; },
      });
      const tick = h.updater.tick();
      try {
        await stopStarted.promise;
        h.updater.stop();
        let drained = false;
        const drain = h.updater.drainHandover().then(() => { drained = true; });
        await Promise.resolve();
        expect(drained).toBe(false);
        stopFinished.resolve();
        await drain;
        await tick;
        expect(drained).toBe(true);
        expect(h.actions.adopted + h.actions.restarted).toBe(0);
        expect(h.exits).toEqual([]);
        expect(h.updater.snapshot().handover?.status).toBe('unknown');
        expect(h.updater.snapshot().handover?.detail).toContain('cancelled before the service action started');
        expect(h.receipts.list()).toHaveLength(2);
        expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
        expect(h.files.get(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('daemon-v1');
        expect(h.timers).toHaveLength(0);
      } finally {
        stopFinished.resolve();
        await tick;
        rmSync(h.scratch, { recursive: true, force: true });
      }
    });

    for (const scenario of incompleteActions) {
      test(`${actionName}: ${scenario.name} preserves swap evidence and reports incomplete handover once`, async () => {
        const h = makeHarness({
          idle: () => true,
          supervised,
          serviceActions: supervised
            ? { restartService: scenario.action }
            : { adoptIntoService: scenario.action },
        });
        try {
          await h.updater.tick();
          expect(h.exits).toEqual([]);
          expect(h.updater.snapshot().currentVersion).toBe('1.0.0');
          expect(h.updater.snapshot().appliedVersion).toBe('2.0.0');
          expect(h.updater.snapshot().pendingVersion).toBeNull();
          expect(h.updater.snapshot().handover?.status).toBe(scenario.status);
          expect(h.updater.snapshot().handover?.detail).toContain(scenario.detail);
          expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
          expect(h.files.get(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('daemon-v1');
          expect(h.receipts.list()).toHaveLength(2);
          expect(h.receipts.list()[0]!.text).toContain('updated from 1.0.0 to 2.0.0');
          expect(h.receipts.list()[0]!.text).toContain('on disk');
          expect(h.receipts.list()[1]!.text).toContain('service handover is incomplete');
          expect(h.alerts).toHaveLength(1);
          expect(h.alerts[0]).toContain(scenario.detail);
          expect(h.alerts[0]).toContain('Automatic updates are paused');
          expect(h.alerts[0]).not.toContain('working again');
          const completedRequests = h.requests.length;
          h.updater.start();
          await h.updater.tick();
          await h.updater.tick();
          expect(h.requests).toHaveLength(completedRequests);
          expect(h.actions.adopted + h.actions.restarted).toBe(1);
          expect(h.receipts.list()).toHaveLength(2);
          expect(h.alerts).toHaveLength(1);
          expect(h.timers).toHaveLength(0);
        } finally {
          rmSync(h.scratch, { recursive: true, force: true });
        }
      });
    }

    test(`${actionName} is awaited; only accepted adoption authorizes exit`, async () => {
      const started = deferred<void>();
      const result = deferred<ServiceHandoverOutcome>();
      const action = () => { started.resolve(); return result.promise; };
      const h = makeHarness({
        idle: () => true,
        supervised,
        serviceActions: supervised ? { restartService: action } : { adoptIntoService: action },
      });
      let settled = false;
      const tick = h.updater.tick().then(() => { settled = true; });
      try {
        await started.promise;
        expect(settled).toBe(false);
        expect(h.exits).toEqual([]);
        expect(h.updater.snapshot().appliedVersion).toBe('2.0.0');
        expect(h.updater.snapshot().handover?.status).toBe('unknown');
        expect(h.receipts.list()).toHaveLength(1);
        expect(h.receipts.list()[0]!.text).toContain('on disk');
        result.resolve({ status: 'accepted', detail: 'request enqueued' });
        await tick;
        expect(settled).toBe(true);
        expect(h.updater.snapshot().handover).toEqual({ status: 'accepted', detail: 'request enqueued' });
        expect(h.exits).toEqual(supervised ? [] : [0]);
        expect(h.alerts).toEqual([]);
        expect(h.timers).toHaveLength(0);
      } finally {
        result.resolve({ status: 'failed', detail: 'test cleanup' });
        await tick;
        rmSync(h.scratch, { recursive: true, force: true });
      }
    });

    test(`${actionName} owns a late rejection after stop without rearming the loop`, async () => {
      const started = deferred<void>();
      const result = deferred<ServiceHandoverOutcome>();
      const action = () => { started.resolve(); return result.promise; };
      const h = makeHarness({
        idle: () => true,
        supervised,
        serviceActions: supervised ? { restartService: action } : { adoptIntoService: action },
      });
      const tick = h.updater.tick();
      try {
        await started.promise;
        h.updater.stop();
        let drained = false;
        const drain = h.updater.drainHandover().then(() => { drained = true; });
        await Promise.resolve();
        expect(drained).toBe(false);
        result.reject(new Error('late manager rejection'));
        await drain;
        expect(drained).toBe(true);
        await tick;
        expect(h.updater.snapshot().handover).toEqual({ status: 'failed', detail: 'late manager rejection' });
        expect(h.exits).toEqual([]);
        expect(h.alerts).toHaveLength(1);
        expect(h.timers).toHaveLength(0);
      } finally {
        result.resolve({ status: 'failed', detail: 'test cleanup' });
        await tick;
        rmSync(h.scratch, { recursive: true, force: true });
      }
    });

    test(`${actionName} cannot request a late exit after an external stop`, async () => {
      const started = deferred<void>();
      const result = deferred<ServiceHandoverOutcome>();
      const action = () => { started.resolve(); return result.promise; };
      const h = makeHarness({
        idle: () => true,
        supervised,
        serviceActions: supervised ? { restartService: action } : { adoptIntoService: action },
      });
      const tick = h.updater.tick();
      try {
        await started.promise;
        h.updater.stop();
        let drained = false;
        const drain = h.updater.drainHandover().then(() => { drained = true; });
        await Promise.resolve();
        expect(drained).toBe(false);
        result.resolve({ status: 'accepted' });
        await drain;
        expect(drained).toBe(true);
        await tick;
        expect(h.updater.snapshot().handover?.status).toBe('unknown');
        expect(h.updater.snapshot().handover?.detail).toContain('process handover was cancelled');
        expect(h.exits).toEqual([]);
        expect(h.receipts.list()).toHaveLength(2);
        expect(h.receipts.list()[0]!.text).toContain('on disk');
        expect(h.alerts).toHaveLength(1);
        expect(h.timers).toHaveLength(0);
        await h.updater.tick();
        expect(h.actions.adopted + h.actions.restarted).toBe(1);
      } finally {
        result.resolve({ status: 'failed', detail: 'test cleanup' });
        await tick;
        rmSync(h.scratch, { recursive: true, force: true });
      }
    });

    test(`${actionName} forwards cancellation to the owned action and drains its outcome`, async () => {
      const started = deferred<void>();
      let actionSignal: AbortSignal | undefined;
      const action = (signal?: AbortSignal): Promise<ServiceHandoverOutcome> => {
        actionSignal = signal;
        started.resolve();
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ status: 'unknown', detail: 'manager command cancelled' }), { once: true });
        });
      };
      const h = makeHarness({
        idle: () => true,
        supervised,
        serviceActions: supervised ? { restartService: action } : { adoptIntoService: action },
      });
      const tick = h.updater.tick();
      try {
        await started.promise;
        expect(actionSignal?.aborted).toBe(false);
        h.updater.stop();
        expect(actionSignal?.aborted).toBe(true);
        await h.updater.drainHandover();
        expect(h.updater.snapshot().handover).toEqual({ status: 'unknown', detail: 'manager command cancelled' });
        expect(h.exits).toEqual([]);
        expect(h.alerts).toHaveLength(1);
        expect(h.timers).toHaveLength(0);
        await tick;
      } finally {
        h.updater.stop();
        await tick;
        rmSync(h.scratch, { recursive: true, force: true });
      }
    });
  }

  test('graceful stop can stop its own updater without awaiting or deadlocking its in-flight tick', async () => {
    let updater!: DaemonAutoUpdater;
    const h = makeHarness({
      idle: () => true,
      supervised: false,
      stopGracefully: async () => { updater.stop(true); await updater.drainHandover(true); },
    });
    updater = h.updater;
    try {
      await h.updater.tick();
      expect(h.sequence).toEqual(['stop', 'adopt', 'exit']);
      expect(h.updater.snapshot().handover?.status).toBe('accepted');
      expect(h.timers).toHaveLength(0);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('a throwing supervision probe becomes a reported failure with the disk receipt intact', async () => {
    const h = makeHarness({
      idle: () => true,
      serviceActions: { isSupervised: () => { throw undefined; } },
    });
    try {
      await h.updater.tick();
      expect(h.updater.snapshot().handover?.status).toBe('failed');
      expect(h.actions.adopted + h.actions.restarted).toBe(0);
      expect(h.exits).toEqual([]);
      expect(h.receipts.list()).toHaveLength(2);
      expect(h.alerts).toHaveLength(1);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });
});

describe('PeriodicUpdateLoop cadence', () => {
  function loopHarness(options: {
    outcome: () => 'settled' | 'deferred';
    firstCheckDelayMs?: number;
    checkIntervalMs?: number;
    busyRetryMs?: number;
    throws?: boolean;
  }) {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const errors: unknown[] = [];
    const loop = new PeriodicUpdateLoop({
      ...(options.firstCheckDelayMs !== undefined ? { firstCheckDelayMs: options.firstCheckDelayMs } : {}),
      ...(options.checkIntervalMs !== undefined ? { checkIntervalMs: options.checkIntervalMs } : {}),
      ...(options.busyRetryMs !== undefined ? { busyRetryMs: options.busyRetryMs } : {}),
      runCheck: async () => {
        if (options.throws) throw new Error('check failed');
        return options.outcome();
      },
      onError: (error) => void errors.push(error),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });
    return { loop, timers, errors };
  }

  test('first check is the boot-settle delay; every check after it is the cadence', async () => {
    const h = loopHarness({ outcome: () => 'settled', checkIntervalMs: 60 * 60 * 1000 });
    h.loop.start();
    expect(h.timers[0]!.ms).toBe(BOOT_SETTLE_CHECK_DELAY_MS);
    await h.loop.tick();
    expect(h.timers[h.timers.length - 1]!.ms).toBe(60 * 60 * 1000);
  });

  test('the boot-settle delay never exceeds one cadence', () => {
    const h = loopHarness({ outcome: () => 'settled', checkIntervalMs: 10_000 });
    h.loop.start();
    expect(h.timers[0]!.ms).toBe(10_000);
  });

  test('an explicit first-check delay is honored', () => {
    const h = loopHarness({ outcome: () => 'settled', firstCheckDelayMs: 2_000, checkIntervalMs: 60_000 });
    h.loop.start();
    expect(h.timers[0]!.ms).toBe(2_000);
  });

  test('a deferred check comes back on the short retry cadence', async () => {
    const h = loopHarness({ outcome: () => 'deferred', checkIntervalMs: 60 * 60 * 1000, busyRetryMs: 45_000 });
    await h.loop.tick();
    expect(h.timers[h.timers.length - 1]!.ms).toBe(45_000);
  });

  test('a check that throws is reported and keeps the steady cadence', async () => {
    const h = loopHarness({ outcome: () => 'settled', throws: true, checkIntervalMs: 60 * 60 * 1000 });
    await h.loop.tick();
    expect(h.errors).toHaveLength(1);
    expect(h.timers[h.timers.length - 1]!.ms).toBe(60 * 60 * 1000);
  });

  test('delays are floored so a misconfigured cadence never spins', () => {
    const h = loopHarness({ outcome: () => 'settled', checkIntervalMs: 0, busyRetryMs: -5 });
    expect(h.loop.checkIntervalMs).toBe(1_000);
    expect(h.loop.busyRetryMs).toBe(1_000);
  });
});


for (const restartOnFailure of [false, true]) {
  for (const diskKeepAlive of [false, true]) {
    test(`launchd update desired restart=${restartOnFailure}, disk KeepAlive=${diskKeepAlive} preserves completed disk evidence without exit`, async () => {
      const serviceExits: number[] = [];
      let commands = 0;
      const lifecycle = new DaemonLifecycleRuntime({
        configManager: { get: (key: string) => key === 'service.restartOnFailure' ? restartOnFailure : undefined } as unknown as DaemonLifecycleRuntimeOptions['configManager'],
        platformServiceManager: { status: () => ({ installed: true, running: true, platform: 'launchd',
          contents: `<plist><dict><key>KeepAlive</key><${diskKeepAlive}/></dict></plist>`,
        }) } as unknown as DaemonLifecycleRuntimeOptions['platformServiceManager'],
        isIdle: () => true, servicePlatform: 'darwin',
        serviceCommandRunner: async () => { commands++; return { status: 'accepted' }; },
        exitProcess: (code) => { serviceExits.push(code); },
      });
      // Construct the shared action adapter only: do not arm the lifecycle.
      const actions = (lifecycle as unknown as { buildServiceActions(): AutoUpdateServiceActions }).buildServiceActions();
      const h = makeHarness({ idle: () => true, platform: 'darwin', serviceActions: actions });
      try {
        await h.updater.tick();
        expect(commands).toBe(0);
        expect(serviceExits).toEqual([]);
        expect(h.exits).toEqual([]);
        expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
        expect(h.files.get(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('daemon-v1');
        expect(h.updater.snapshot().appliedVersion).toBe('2.0.0');
        expect(h.updater.snapshot().handover?.status).toBe('unknown');
        expect(h.receipts.list()[0]!.text).toContain('on disk');
        expect(h.receipts.list()[1]!.text).toContain('handover is incomplete');
        await h.updater.tick();
        expect(h.requests).toHaveLength(3);
      } finally { h.updater.stop(); rmSync(h.scratch, { recursive: true, force: true }); }
    });
  }
}

describe('updater-owned effect references', () => {
  test('lookup cannot redirect retained constructor options or replace handover/receipt callbacks', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'update-options-'));
    const authorized = '/fixture/authorized';
    const redirected = '/fixture/redirected';
    const original = memoryIo({ [authorized]: Buffer.from('daemon-v1'), [redirected]: Buffer.from('leave-alone') });
    const replacement = memoryIo({ [redirected]: Buffer.from('replacement-fs') });
    const receipts = new DaemonReceiptStore(join(scratch, 'receipts.json'));
    const release = releaseFetch();
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const paused = new Promise<void>(resolve => { finish = resolve; });
    const sequence: string[] = [];
    const actions = {
      isSupervised: () => true,
      adoptIntoService: () => { sequence.push('adopt'); return { status: 'accepted' as const }; },
      restartService: () => { sequence.push('restart'); return { status: 'accepted' as const }; },
    };
    const options = {
      currentVersion: '1.0.0', execPath: authorized, platform: 'linux' as NodeJS.Platform, arch: 'x64',
      releasesLatestUrl: LATEST_URL, downloadBaseUrl: (tag: string) => defaultDownloadBaseUrl(LATEST_URL, tag),
      isIdle: () => true, io: original.io, receipts, serviceActions: actions,
      fetchImpl: (async (url, init) => {
        if (url === LATEST_URL) { begin(); await paused; }
        return release.fetchImpl(url, init);
      }) as UpdateFetchLike,
      stopGracefully: () => { sequence.push('stop'); },
      exitProcess: (_code: number) => { sequence.push('exit'); },
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {},
    };
    const updater = new DaemonAutoUpdater(options);
    const tick = updater.tick();
    try {
      await started;
      options.execPath = redirected;
      options.currentVersion = '999.0.0';
      options.platform = 'win32'; options.arch = 'arm64';
      options.releasesLatestUrl = 'https://redirected.invalid/releases/latest';
      options.downloadBaseUrl = () => 'https://redirected.invalid/download';
      options.io = replacement.io;
      options.fetchImpl = async () => { throw new Error('replacement fetch must not run'); };
      options.isIdle = () => false;
      options.stopGracefully = () => { sequence.push('replacement-stop'); };
      options.exitProcess = () => { sequence.push('replacement-exit'); };
      actions.isSupervised = () => false;
      actions.restartService = () => { sequence.push('replacement-restart'); return { status: 'accepted' }; };
      actions.adoptIntoService = () => { sequence.push('replacement-adopt'); return { status: 'accepted' }; };
      options.serviceActions = { ...actions };
      receipts.record = () => { sequence.push('replacement-receipt'); return { id: 'replacement', at: 0, text: '' }; };
      finish(); await tick;
      expect(original.files.get(authorized)?.toString()).toBe('daemon-v2');
      expect(original.files.get(`${authorized}.previous`)?.toString()).toBe('daemon-v1');
      expect(original.files.get(redirected)?.toString()).toBe('leave-alone');
      expect(replacement.mutations).toEqual([]);
      expect(sequence).toEqual(['stop', 'restart']);
      expect(receipts.list()).toHaveLength(1);
      expect(updater.snapshot().currentVersion).toBe('1.0.0');
      expect(updater.snapshot().releasesUrl).toBe(LATEST_URL);
      expect(updater.snapshot().appliedVersion).toBe('2.0.0');
      expect(release.requests).toHaveLength(3);
    } finally { finish(); updater.stop(); await tick; rmSync(scratch, { recursive: true, force: true }); }
  });

  test('lookup cannot replace I/O members used by target resolution or commit', async () => {
    const release = releaseFetch();
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const paused = new Promise<void>(resolve => { finish = resolve; });
    let replacedCalls = 0;
    const h = makeHarness({ idle: () => true, fetchOverride: async (url, init) => {
      if (url === LATEST_URL) { begin(); await paused; }
      return release.fetchImpl(url, init);
    } });
    const tick = h.updater.tick();
    try {
      await started;
      const replacement = () => { replacedCalls++; throw new Error('replaced I/O must not run'); };
      h.io.exists = replacement; h.io.mkdir = replacement; h.io.writeFile = replacement;
      h.io.writeExclusive = replacement; h.io.rename = replacement; h.io.chmod = replacement; h.io.remove = replacement;
      finish(); await tick;
      expect(replacedCalls).toBe(0);
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.files.get('/opt/gv/goodvibes-daemon.previous')?.toString()).toBe('daemon-v1');
      expect(h.sequence).toEqual(['stop', 'restart']);
      expect(h.updater.snapshot().appliedVersion).toBe('2.0.0');
    } finally { finish(); h.updater.stop(); await tick; rmSync(h.scratch, { recursive: true, force: true }); }
  });
});
