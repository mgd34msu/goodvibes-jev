/**
 * DaemonAutoUpdater, the daemon's self-update loop.
 *
 * Owner-directed behavior: the daemon looks for updates shortly after it
 * starts and hourly after that, updates when one is found, and auto-restarts.
 * It shares the platform's ONE update mechanism: runtime/self-update.ts for
 * the download/verify/swap and runtime/update-schedule.ts for the cadence
 * (boot-settle first check, hourly steady state, short retry while busy).
 *
 * Safety boundary: the daemon's activity probe is checked before downloads
 * and synchronously after staging, immediately before the first live rename.
 * A busy daemon retains the release descriptor for a short retry; downloaded
 * bytes are discarded. Cancellation and a bounded deadline cover lookup and
 * downloads. This final snapshot is not a work-admission lease: the host must
 * still fence new work through handover before automatic activation is safe.
 *
 * Restart: the swap is followed by the daemon's OWN orderly stop, the same
 * stop path a SIGTERM takes, so every shutdown hook fires on an update restart
 * instead of being skipped by a bare exit. Only then does the process hand
 * over: when the daemon runs under the service manager, a non-blocking service
 * restart; when it runs unsupervised, the service manager first ADOPTS it,
 * installs the unit and enqueues a service start. Only an acknowledged
 * adoption request lets the old process exit. An incomplete handover leaves
 * the disk update and previous binary intact, reports what happened, and
 * pauses this process's updater so it cannot install the same release twice.
 *
 * Every applied update leaves a receipt ("updated from X to Y at HH:MM") in
 * the daemon log and in the receipt store surfaced on next surface connect.
 *
 * Two things this loop refuses to do quietly, both learned the hard way:
 *
 *   - It never re-installs a release that already crash looped here. A boot
 *     rollback records the version it rejected; the loop reads that record on
 *     every check and holds. Without it the loop and the rollback form a cycle
 *    , install, fail three starts, roll back, reinstall the same release an
 *     interval later, and the installed daemon oscillates instead of moving
 *     forward. It resumes on its own as soon as a NEWER tag ships.
 *   - It never fails silently. Persistent failures are read from the actual
 *     error and the owner is told over a channel that
 *     works (the same owner-alert path a failing channel uses), with a quiet
 *     window so a persistent failure is one message rather than one an hour.
 *     Recovery is stated too. A WARN line in a debug file is not telling
 *     anybody: that is precisely how an installed daemon sat three releases
 *     behind for three days.
 *
 * Time, network, filesystem, activity, service actions, and process exit are
 * all injectable; the whole loop is provable under test.
 */
import { readFailureTransience } from '@goodvibes-jev/engine/errors';
import { daemonReadingPort } from './reading-lifetime.js';
import { captureJudgmentFailure } from '../gate/failure-input.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { flushActivityLogSync, logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  applyVerifiedUpdate,
  compareVersions,
  captureUpdateFileIo,
  realUpdateFileIo,
  DEFAULT_UPDATE_TIMEOUT_MS,
  UpdateTransactionError,
  normalizeVersion,
  resolveArtifactNames,
  resolveLatestReleaseTag,
  resolveSqliteVecAsset,
  type UpdateFetchLike,
  type UpdateFileIo,
  type UpdateTarget,
  type UpdateTransactionReceipt,
} from '../runtime/self-update.js';
import { PeriodicUpdateLoop, type PeriodicCheckOutcome } from '../runtime/update-schedule.js';
import { formatReceiptTime, type DaemonReceiptStore } from './receipts.js';
import { CLIENT_COMPATIBILITY_FLOOR } from '../control-plane/client-compatibility.js';
import type { ServiceHandoverOutcome } from './service-handover.js';

export interface AutoUpdateServiceActions {
  /** Whether the daemon currently runs under the platform service manager. */
  isSupervised(): boolean;
  /** Install + enable the service unit. Legacy void carries no acknowledgement. */
  adoptIntoService(signal?: AbortSignal): void | ServiceHandoverOutcome | Promise<void | ServiceHandoverOutcome>;
  /** Enqueue a non-blocking service restart and observe manager acceptance. */
  restartService(signal?: AbortSignal): void | ServiceHandoverOutcome | Promise<void | ServiceHandoverOutcome>;
}

export interface DaemonUpdateInstallLocation {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly io?: UpdateFileIo | undefined;
}

/**
 * One installed file an update replaces (and a rollback restores).
 * `assetName` is null when this platform/arch publishes no release asset for
 * it, such a file can still be rolled back, it just cannot be downloaded.
 */
export interface DaemonInstalledFile {
  readonly label: string;
  readonly path: string;
  readonly executable: boolean;
  readonly assetName: string | null;
}

/**
 * The set of files a daemon update owns: the daemon binary, plus the
 * sqlite-vec addon when it is installed beside it, the addon is compiled
 * against the same build and ships in the same release, so an update refreshes
 * it in the same verified pass and never leaves a mismatched pair installed.
 *
 * THE TERMINAL APP BINARY IS NOT IN THIS SET, deliberately. It used to be:
 * both binaries were built and released from the terminal app's repository, so
 * one release carried both and refreshing the pair together was the only way to
 * keep them matched. The daemon is now its own product with its own repository
 * and its own release line, and a daemon-repository release publishes no
 * `goodvibes-<os>-<arch>` asset at all. A daemon that still claimed the app
 * binary would look for an asset that does not exist, and, worse, if one ever
 * did appear under that name, would overwrite a terminal app that updates
 * itself from a different repository on a different version line. Each product
 * updates its own binary now; `goodvibes` sitting in the same directory is a
 * neighbour, not cargo.
 *
 * One source of truth, shared by the update swap and the crash-loop rollback,
 * so the files a bad update replaced are exactly the files a rollback
 * restores. (A rollback therefore also leaves the app binary alone: it restores
 * only what the update it is undoing actually replaced.)
 */
export function resolveDaemonInstalledFiles(location: DaemonUpdateInstallLocation): DaemonInstalledFile[] {
  const io = location.io;
  const exists = io ? io.exists.bind(io) : existsSync;
  const execDir = dirname(location.execPath);
  const artifacts = resolveArtifactNames(location.platform, location.arch);
  const files: DaemonInstalledFile[] = [
    { label: 'daemon binary', path: location.execPath, assetName: artifacts?.daemon ?? null, executable: true },
  ];
  const addon = resolveSqliteVecAsset(location.platform, location.arch);
  if (addon) {
    const addonPath = join(execDir, 'lib', addon.dirName, addon.fileName);
    if (exists(addonPath)) {
      files.push({ label: 'vector addon', path: addonPath, assetName: addon.assetName, executable: false });
    }
  }
  return files;
}

export interface DaemonAutoUpdaterOptions {
  readonly currentVersion: string;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** GitHub releases/latest URL used for tag resolution. */
  readonly releasesLatestUrl: string;
  /** `${releasesLatestUrl%/latest}/download/<tag>` builder override for tests. */
  readonly downloadBaseUrl?: ((tag: string) => string) | undefined;
  /** Hourly by default. */
  readonly checkIntervalMs?: number | undefined;
  /** Delay before the FIRST check after start. Default 30s (boot settle). */
  readonly firstCheckDelayMs?: number | undefined;
  /** How often to retry a discovered-but-deferred update while the daemon is busy. */
  readonly busyRetryMs?: number | undefined;
  /** Whole lookup/download/staging budget per check. Defaults to two minutes. */
  readonly updateTimeoutMs?: number | undefined;
  /** The daemon's real activity signal: true only when NO work is in flight. */
  readonly isIdle: () => boolean;
  readonly serviceActions: AutoUpdateServiceActions;
  readonly receipts: DaemonReceiptStore;
  readonly fetchImpl?: UpdateFetchLike | undefined;
  readonly io?: UpdateFileIo | undefined;
  /**
   * The daemon's own orderly stop, run BEFORE the process hands over to the
   * restarted instance, so shutdown hooks fire on an update restart instead of
   * being skipped by a bare exit. Absent = nothing to wind down. If this hook
   * reenters the updater, use stop(true)/drainHandover(true): a normal stop
   * cancels the handover, and draining it here would wait on this hook itself.
   */
  readonly stopGracefully?: (() => Promise<void> | void) | undefined;
  /** Exits the current process after an unsupervised daemon is adopted. */
  readonly exitProcess?: ((code: number) => void) | undefined;
  /**
   * The version a crash-loop rollback rejected, or null when none stands.
   * Consulted on every check: a release that already failed to start on this
   * host is not installed a second time just because it is still the latest
   * one. Read fresh each time (it lives in the lifecycle marker on disk), so a
   * rejection recorded by the boot before this one is seen.
   */
  readonly rejectedVersion?: (() => string | null) | undefined;
  /**
   * Put one line in front of the owner over a channel that still works, the
   * daemon's existing owner-alert path. Absent = no channel to alert on (an
   * embedded daemon, a test), in which case the ERROR log line is the record.
   */
  readonly alertOwner?: ((text: string) => void) | undefined;
  /**
   * @deprecated Compatibility only; failure transience, never a count, decides alerts.
   */
  readonly alertAfterFailedChecks?: number | undefined;
  /** Quiet window after an update alert, so a persistent failure is one message, not one per hour. Default 12h. */
  readonly alertWindowMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
}

/** @deprecated Compatibility value only; the canonical failure reading decides alerts. */
export const DEFAULT_UPDATE_ALERT_AFTER_FAILED_CHECKS = 3;

/** Default quiet window between update alerts about the same ongoing failure. */
export const DEFAULT_UPDATE_ALERT_WINDOW_MS = 12 * 60 * 60 * 1000;

interface PendingSwap {
  readonly tag: string;
  readonly targets: readonly UpdateTarget[];
}

/** The live state of one daemon's self-update loop. */
export interface DaemonUpdateLoopSnapshot {
  /** The running artifact's version, as the loop compares it. */
  readonly currentVersion: string;
  /** Where release tags are resolved from. */
  readonly releasesUrl: string;
  /** The steady-state cadence between checks. */
  readonly checkIntervalMs: number;
  /** The delay before the first check after a boot. */
  readonly firstCheckDelayMs: number;
  /** Consecutive checks that threw. Zero once one completes. */
  readonly failedCheckCount: number;
  /** What the most recent failing check said, or null when none is failing. */
  readonly lastCheckFailure: string | null;
  /** A discovered release waiting for an idle moment, or null. */
  readonly pendingVersion: string | null;
  /** The version installed on disk by this process, independently of handover. */
  readonly appliedVersion?: string | null;
  /** An incomplete filesystem transaction has paused updates pending inspection. */
  readonly recoveryRequired?: boolean;
  /** Exact retained-filesystem evidence for the paused transaction, if any. */
  readonly transactionRecovery?: UpdateTransactionReceipt | null;
  /** Service-manager acknowledgement, never proof that the new daemon is healthy. */
  readonly handover?: ServiceHandoverOutcome | null;
}

export class DaemonAutoUpdater {
  private readonly loop: PeriodicUpdateLoop;
  private failureReadAbort = new AbortController();
  /** A discovered release descriptor waiting for an idle moment. */
  private pendingSwap: PendingSwap | null = null;
  /** A completed disk swap is terminal for this process, even if handover fails. */
  private appliedVersion: string | null = null;
  private recoveryRequired = false;
  private transactionRecovery: UpdateTransactionReceipt | null = null;
  private readonly updateTimeoutMs: number;
  private handover: ServiceHandoverOutcome | null = null;
  private handoverCancelled = false;
  private handoverTask: Promise<void> | null = null;
  private handoverAbort: AbortController | null = null;
  /** Settles only after lookup/apply/handover, including checks started by the timer. */
  private activeCheck: Promise<void> | null = null;
  private finishActiveCheck: (() => void) | null = null;
  /** Consecutive checks that threw. Reset by any check that completes. */
  private consecutiveFailures = 0;
  /** When the owner was last told the daemon cannot update itself, or null. */
  private failureAlertedAt: number | null = null;
  /** The last error text told to the owner, so recovery can name what stopped. */
  private lastFailureDetail: string | null = null;
  /** Rejected releases already reported, so the skip is stated once per release, not hourly. */
  private readonly reportedRejections = new Set<string>();

  private readonly options: DaemonAutoUpdaterOptions;
  private readonly writeReceipt: DaemonReceiptStore['record'];

  constructor(options: DaemonAutoUpdaterOptions) {
    // Own the install identity and callbacks before the first await. Captured
    // probes still observe their live closure state; callers cannot redirect
    // an admitted update by replacing members on the retained options object.
    const actions = options.serviceActions;
    this.options = {
      ...options,
      fetchImpl: options.fetchImpl ?? (fetch as unknown as UpdateFetchLike),
      serviceActions: {
        isSupervised: actions.isSupervised.bind(actions),
        adoptIntoService: actions.adoptIntoService.bind(actions),
        restartService: actions.restartService.bind(actions),
      },
    };
    this.writeReceipt = options.receipts.record.bind(options.receipts);
    this.updateTimeoutMs = this.options.updateTimeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
    if (!Number.isFinite(this.updateTimeoutMs) || this.updateTimeoutMs <= 0) {
      throw new Error('updateTimeoutMs must be positive and finite');
    }
    this.loop = new PeriodicUpdateLoop({
      checkIntervalMs: options.checkIntervalMs,
      firstCheckDelayMs: options.firstCheckDelayMs,
      busyRetryMs: options.busyRetryMs,
      runCheck: async (): Promise<PeriodicCheckOutcome> => {
        const signal = this.failureReadAbort.signal;
        // A separate completion promise never rejects and includes any owned
        // failure reading, so shutdown can drain it without a second retry owner.
        this.activeCheck = new Promise((resolve) => {
          this.finishActiveCheck = () => {
            this.activeCheck = null;
            this.finishActiveCheck = null;
            resolve();
          };
        });
        try {
          await this.checkAndApply(signal);
          // A failed handover must not be followed by a misleading recovery line.
          if (!signal.aborted && !this.handoverCancelled && !this.recoveryRequired && (this.handover === null || this.handover.status === 'accepted')) this.recordCheckSucceeded();
        } catch (error) {
          this.pendingSwap = null;
          if (!signal.aborted && !this.handoverCancelled) await this.recordCheckFailed(error, signal);
        } finally {
          this.finishActiveCheck?.();
        }
        return this.pendingSwap ? 'deferred' : 'settled';
      },
      onError: (error) => {
        // A reading failure is operational: never turn it into an owner alert
        // or a guessed transience. The cadence remains owned by the loop.
        logger.error('DaemonAutoUpdater: update failure reading could not complete', { error: summarizeError(error) });
      },
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Put a line in front of the owner, and state it at ERROR either way. An
   * update path that has stopped working is exactly the class of failure that
   * spent three days as WARN lines in a debug log while three releases shipped
   * and the installed daemon stayed where it was.
   */
  private alertOwner(text: string): void {
    logger.error(`DaemonAutoUpdater: ${text}`);
    try {
      this.options.alertOwner?.(text);
    } catch (error) {
      logger.error('DaemonAutoUpdater: the owner alert about self-update could not be sent', {
        error: summarizeError(error),
      });
    }
  }

  /** Counts remain diagnostics. Only the canonical failure reading decides an alert. */
  private async recordCheckFailed(error: unknown, signal: AbortSignal): Promise<void> {
    const assertCurrent = () => signal.throwIfAborted();
    assertCurrent();
    this.consecutiveFailures += 1;
    const captured = captureJudgmentFailure(error);
    const detail = summarizeError(captured);
    this.lastFailureDetail = detail;
    const transience = await readFailureTransience(captured, 'daemon.auto-updater.failure', {
      reading: { get port() { return daemonReadingPort('daemon.auto-updater.failure', assertCurrent, signal); }, signal, beforeAttempt: assertCurrent },
    });
    assertCurrent();
    if (transience.failureClass === 'retryable') {
      logger.warn('DaemonAutoUpdater: transient update check failure; will retry on the next interval', {
        error: detail, consecutiveFailures: this.consecutiveFailures,
      });
      return;
    }
    const windowMs = Math.max(0, this.options.alertWindowMs ?? DEFAULT_UPDATE_ALERT_WINDOW_MS);
    const now = this.now();
    if (this.failureAlertedAt !== null && now - this.failureAlertedAt < windowMs) {
      logger.warn('DaemonAutoUpdater: update check still failing; the owner has already been told', {
        error: detail,
        consecutiveFailures: this.consecutiveFailures,
      });
      return;
    }
    this.failureAlertedAt = now;
    this.alertOwner(
      `the daemon has not been able to check for updates ${this.consecutiveFailures} times in a row`
      + `, it is still running v${normalizeVersion(this.options.currentVersion)} and will keep retrying.`
      + ` Last error: ${detail}`,
    );
  }

  /** A check that completed. Says so if the owner had been told it was failing. */
  private recordCheckSucceeded(): void {
    const wasAlerted = this.failureAlertedAt !== null;
    const failures = this.consecutiveFailures;
    this.consecutiveFailures = 0;
    this.failureAlertedAt = null;
    this.lastFailureDetail = null;
    if (!wasAlerted) return;
    this.alertOwner(
      `update checks are working again after ${failures} consecutive failures`
      + (this.appliedVersion
        ? `, v${this.appliedVersion} is installed on disk and the service manager accepted the handover request`
        : `, the daemon is on v${normalizeVersion(this.options.currentVersion)} and checking on schedule`),
    );
  }

  /** The most recent failure detail, exposed for the /status surface and tests. */
  get lastCheckFailure(): string | null {
    return this.lastFailureDetail;
  }

  /**
   * What the loop knows right now, as one readable record.
   *
   * Everything here was already tracked and already decided the loop's
   * behaviour; none of it was answerable from outside the process. "Is this
   * daemon updating itself, and if not why not" was a question only the log
   * could answer, and only to someone with shell access to the host, which is
   * how three releases shipped past a daemon whose checks had been failing for
   * days with nobody able to see it from any surface.
   */
  snapshot(): DaemonUpdateLoopSnapshot {
    return {
      currentVersion: normalizeVersion(this.options.currentVersion),
      releasesUrl: this.options.releasesLatestUrl,
      checkIntervalMs: this.loop.checkIntervalMs,
      firstCheckDelayMs: this.loop.firstCheckDelayMs,
      failedCheckCount: this.consecutiveFailures,
      lastCheckFailure: this.lastFailureDetail,
      pendingVersion: this.pendingSwap ? normalizeVersion(this.pendingSwap.tag) : null,
      appliedVersion: this.appliedVersion,
      recoveryRequired: this.recoveryRequired,
      transactionRecovery: this.transactionRecovery ? {
        ...this.transactionRecovery,
        targets: [...this.transactionRecovery.targets],
        recoveryPaths: [...this.transactionRecovery.recoveryPaths],
        recoveryErrors: [...this.transactionRecovery.recoveryErrors],
      } : null,
      handover: this.handover ? { ...this.handover } : null,
    };
  }

  /** Consecutive failed checks, exposed for the /status surface and tests. */
  get failedCheckCount(): number {
    return this.consecutiveFailures;
  }

  /** The delay before the first check, so callers can log the schedule they got. */
  get firstCheckDelayMs(): number {
    return this.loop.firstCheckDelayMs;
  }

  /** The steady-state cadence, so callers can log the schedule they got. */
  get checkIntervalMs(): number {
    return this.loop.checkIntervalMs;
  }

  /** Begin the loop. The first check runs after a short boot-settle delay. */
  start(): void {
    if (this.appliedVersion !== null || this.recoveryRequired) return;
    this.handoverCancelled = false;
    if (this.failureReadAbort.signal.aborted) this.failureReadAbort = new AbortController();
    this.loop.start();
  }

  /** Cancel future checks; only the updater-owned graceful stop preserves its handover. */
  stop(forHandover = false): void {
    this.loop.stop();
    // An external shutdown can arrive during graceful stop or during the
    // service action. Timing alone cannot distinguish it from our own stop.
    if (!forHandover) {
      this.handoverCancelled = true;
      this.failureReadAbort.abort();
      this.handoverAbort?.abort();
    }
  }

  /** Drain lookup/apply/handover; its own graceful stop must explicitly avoid waiting on itself. */
  drainHandover(forHandover = false): Promise<void> {
    return (forHandover ? null : this.activeCheck ?? this.handoverTask) ?? Promise.resolve();
  }

  /** One loop iteration; exposed for tests driving mocked time. */
  async tick(): Promise<void> {
    await this.loop.tick();
  }

  private async checkAndApply(signal: AbortSignal): Promise<void> {
    if (this.appliedVersion !== null || this.recoveryRequired || this.handoverCancelled) return;
    // Capture member methods per check, so pre-tick injected adapters remain
    // supported while asynchronous lookup cannot redirect resolve or commit I/O.
    const io = captureUpdateFileIo(this.options.io ?? realUpdateFileIo);
    const deadline = performance.now() + this.updateTimeoutMs;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (signal !== this.failureReadAbort.signal || this.handoverCancelled || this.appliedVersion !== null || this.recoveryRequired) {
        throw new Error('update check no longer belongs to the current updater lifecycle');
      }
      if (performance.now() >= deadline) throw new Error('update check deadline exceeded');
    };
    const remainingBudget = () => {
      assertCurrent();
      return Math.max(Number.EPSILON, deadline - performance.now());
    };
    const fetchImpl = this.options.fetchImpl ?? (fetch as unknown as UpdateFetchLike);

    if (!this.pendingSwap) {
      const latestTag = await resolveLatestReleaseTag(fetchImpl, this.options.releasesLatestUrl, {
        signal, timeoutMs: remainingBudget(),
      });
      assertCurrent();
      if (compareVersions(this.options.currentVersion, latestTag) >= 0) {
        return; // already current
      }
      // A release that already crash looped on this host does not get installed
      // again just because it is still the newest one. Without this the loop is
      // a cycle: swap, fail to start three times, roll back, and one check
      // interval later download the identical release and do it again, which
      // is what kept an installed daemon pinned to an old build for days while
      // three releases came and went.
      const rejected = this.rejectedVersion();
      if (rejected !== null && normalizeVersion(latestTag) === rejected) {
        this.reportRejectedRelease(rejected);
        return;
      }
      const targets = this.resolveTargets(io);
      if (!targets) {
        logger.info('DaemonAutoUpdater: no prebuilt binaries for this platform; not self-updating', {
          platform: this.options.platform,
          arch: this.options.arch,
        });
        return;
      }
      this.pendingSwap = { tag: latestTag, targets };
      logger.info('DaemonAutoUpdater: update found', {
        from: normalizeVersion(this.options.currentVersion),
        to: this.pendingSwap.tag,
      });
    }

    // Avoid downloading while already busy. The authoritative snapshot is
    // repeated below after every asynchronous download and synchronous stage.
    assertCurrent();
    if (!this.options.isIdle()) {
      logger.info('DaemonAutoUpdater: update ready but the daemon has active work; deferring the swap', {
        tag: this.pendingSwap.tag,
      });
      return;
    }

    assertCurrent();
    const { tag, targets } = this.pendingSwap;
    const downloadBase = this.options.downloadBaseUrl
      ? this.options.downloadBaseUrl(tag)
      : defaultDownloadBaseUrl(this.options.releasesLatestUrl, tag);

    const busyBeforeCommit = new Error('daemon became busy before update commit');
    try {
      await applyVerifiedUpdate({
        fetchImpl,
        downloadBaseUrl: downloadBase,
        targets,
        io,
        platform: this.options.platform,
        signal,
        timeoutMs: remainingBudget(),
        beforeCommit: () => {
          assertCurrent();
          const idle = this.options.isIdle();
          // Even an injected activity probe can synchronously stop/restart us.
          assertCurrent();
          if (!idle) throw busyBeforeCommit;
        },
      });
    } catch (error) {
      if (error instanceof UpdateTransactionError) {
        if (error.receipt.recoveryRequired) {
          this.pauseForTransactionRecovery(tag, error);
          return;
        }
        if (error.receipt.phase === 'admission' && !error.receipt.committed && error.cause === busyBeforeCommit) {
          assertCurrent();
          logger.info('DaemonAutoUpdater: daemon became busy before commit; deferring the update', { tag });
          return;
        }
      }
      throw error;
    }
    this.pendingSwap = null;
    // Set the latch before any receipt, shutdown hook, or service action can
    // fail. The old running version must never re-swap the installed release
    // and overwrite its previous binary while waiting for a new process.
    this.appliedVersion = normalizeVersion(tag);
    this.handover = { status: 'unknown', detail: 'service handover is pending' };
    this.loop.stop();

    const now = this.options.now ?? Date.now;
    const from = normalizeVersion(this.options.currentVersion);
    const to = normalizeVersion(tag);
    // One update, one receipt. The second sentence is here because a swap
    // replaces the DAEMON binary and nothing else: every terminal UI and agent
    // process already attached keeps running the build it started with, so the
    // owner would otherwise have to infer the restart from behavior that did
    // not change. Clients below CLIENT_COMPATIBILITY_FLOOR additionally stop
    // taking shared-session work (control-plane/client-compatibility.ts)
    // rather than only being asked to restart.
    this.recordReceipt(
      `updated from ${from} to ${to} at ${formatReceiptTime(now())}`
      + ` on disk; service handover is pending, already-running goodvibes clients keep their old build until restarted;`
      + ` anything older than ${CLIENT_COMPATIBILITY_FLOOR} has stopped taking shared-session work`,
    );

    if (this.handoverCancelled) {
      this.reportIncompleteHandover({ status: 'unknown', detail: 'updater stopped while applying the disk update; process handover was cancelled' });
      return;
    }
    await this.restartIntoNewBinary();
  }

  /** Filesystem recovery is an observed outcome, never an automatic retry decision. */
  private pauseForTransactionRecovery(tag: string, error: UpdateTransactionError): void {
    this.recoveryRequired = true;
    this.transactionRecovery = {
      ...error.receipt,
      targets: [...error.receipt.targets],
      recoveryPaths: [...error.receipt.recoveryPaths],
      recoveryErrors: [...error.receipt.recoveryErrors],
    };
    this.pendingSwap = null;
    this.loop.stop();
    this.consecutiveFailures += 1;
    if (error.receipt.committed) {
      this.appliedVersion = normalizeVersion(tag);
      this.handover = { status: 'unknown', detail: 'update committed but transaction cleanup requires recovery; no service handover was requested' };
    }
    const detail = `update to v${normalizeVersion(tag)} requires filesystem recovery after ${error.receipt.phase}`
      + (error.receipt.committed ? '; the complete update is installed on disk.' : '; the complete update was not installed.')
      + ' Automatic updates are paused in this process. Inspect the retained transaction files before retrying; no service handover was requested.';
    this.lastFailureDetail = detail;
    this.recordReceipt(detail);
    this.alertOwner(detail);
    flushActivityLogSync();
  }

  /** The version a crash-loop rollback rejected, normalized, or null. Never throws into the loop. */
  private rejectedVersion(): string | null {
    try {
      const raw = this.options.rejectedVersion?.() ?? null;
      return raw === null || raw.trim().length === 0 ? null : normalizeVersion(raw);
    } catch (error) {
      // An unreadable marker must not stop the daemon from updating, the
      // failure mode of guessing "nothing is rejected" is one retry of a bad
      // release, and the failure mode of throwing is never updating again.
      logger.warn('DaemonAutoUpdater: could not read the rejected-version record; proceeding as if none stands', {
        error: summarizeError(error),
      });
      return null;
    }
  }

  /**
   * Say, once per rejected release, to the owner, that the newest release is
   * being held back because it would not start here. Once per release, not once
   * per check: this repeats hourly until a fixed release ships, and an alert
   * that fires hourly is an alert nobody reads. The daemon resumes updating on
   * its own the moment a NEWER tag appears; no owner action is required.
   */
  private reportRejectedRelease(rejected: string): void {
    if (this.reportedRejections.has(rejected)) {
      logger.info('DaemonAutoUpdater: the newest release is the one that failed to start here; still holding', {
        rejected,
        running: normalizeVersion(this.options.currentVersion),
      });
      return;
    }
    this.reportedRejections.add(rejected);
    this.alertOwner(
      `not installing v${rejected}: it was installed here, failed to start, and was rolled back automatically.`
      + ` The daemon is staying on v${normalizeVersion(this.options.currentVersion)} and will update itself`
      + ` as soon as a newer release ships. Run /update apply to force v${rejected} anyway`,
    );
  }

  /** The update targets, or null when this platform/arch publishes no assets. */
  private resolveTargets(io: UpdateFileIo): UpdateTarget[] | null {
    const files = resolveDaemonInstalledFiles({
      execPath: this.options.execPath,
      platform: this.options.platform,
      arch: this.options.arch,
      io,
    });
    const targets = files.flatMap((file) =>
      file.assetName === null
        ? []
        : [{ label: file.label, path: file.path, assetName: file.assetName, executable: file.executable }],
    );
    // The daemon binary itself must be downloadable; without it there is no
    // update to apply on this platform.
    return targets.some((target) => target.path === this.options.execPath) ? targets : null;
  }

  private async restartIntoNewBinary(): Promise<void> {
    // Install ownership before graceful stop begins. An external close must
    // cancel and drain this entire sequence, even while a stop hook is pending.
    // The explicitly updater-owned stop uses stop(true)/drainHandover(true).
    const abort = new AbortController();
    this.handoverAbort = abort;
    const task = Promise.resolve().then(async () => {
      if (this.handoverCancelled) {
        this.reportIncompleteHandover({ status: 'unknown', detail: 'process handover was cancelled before graceful stop started' });
        return;
      }
      await this.stopGracefully();
      await this.requestServiceHandover(abort.signal);
    });
    this.handoverTask = task;
    try {
      await task;
    } finally {
      this.handoverTask = null;
      this.handoverAbort = null;
    }
  }

  private async requestServiceHandover(signal: AbortSignal): Promise<void> {
    if (this.handoverCancelled) {
      this.reportIncompleteHandover({ status: 'unknown', detail: 'process handover was cancelled before the service action started' });
      return;
    }
    const actions = this.options.serviceActions;
    let supervised: boolean;
    let outcome: void | ServiceHandoverOutcome;
    try {
      supervised = actions.isSupervised();
      logger.info(supervised
        ? 'DaemonAutoUpdater: requesting restart via the service manager'
        : 'DaemonAutoUpdater: unsupervised daemon; requesting adoption into the service manager');
      outcome = await (supervised ? actions.restartService(signal) : actions.adoptIntoService(signal));
    } catch (error) {
      // Includes rejected promises and even `throw undefined`: an exception
      // cannot be confused with a legacy action that returned no evidence.
      this.reportIncompleteHandover({ status: 'failed', detail: summarizeError(error) });
      return;
    }

    // Legacy void actions remain source-compatible, but silence is not an
    // acknowledgement. Only positive acceptance authorizes an adoption exit.
    this.handover = outcome ?? { status: 'unknown', detail: 'service action returned no handover acknowledgement' };
    if (this.handover.status !== 'accepted') {
      this.reportIncompleteHandover(this.handover);
      return;
    }
    if (this.handoverCancelled) {
      this.reportIncompleteHandover({
        status: 'unknown',
        detail: 'updater stopped while service handover was pending; the manager later accepted the request, but process handover was cancelled',
      });
      return;
    }
    logger.info('DaemonAutoUpdater: service manager accepted the handover request', {
      versionOnDisk: this.appliedVersion,
      supervised,
    });
    if (supervised) return;
    // The handover record has to be on disk before this process stops being
    // one. Without it an update that goes wrong reads, in the log, as a daemon
    // that simply vanished mid-sentence.
    flushActivityLogSync();
    (this.options.exitProcess ?? ((code: number) => process.exit(code)))(0);
  }

  private reportIncompleteHandover(outcome: ServiceHandoverOutcome): void {
    this.handover = { ...outcome };
    const detail = `v${this.appliedVersion} is installed on disk, but service handover is incomplete`
      + ` (${outcome.status}${outcome.detail ? `: ${outcome.detail}` : ''}).`
      + ' No successful handover exit was requested; the previous binary is preserved.'
      + ' Automatic updates are paused in this process; inspect the service manager and restart the daemon.';
    this.recordReceipt(detail);
    this.alertOwner(detail);
    flushActivityLogSync();
  }

  /** Receipt persistence must not undo a completed swap or detach its handover. */
  private recordReceipt(text: string): void {
    try {
      this.writeReceipt(text);
    } catch (error) {
      logger.error(`DaemonAutoUpdater: ${text}`, {
        receiptError: summarizeError(error),
      });
    }
  }

  /**
   * The daemon's own orderly stop before handing over. A hook that throws must
   * never strand the process on the old binary, so a failure is logged and the
   * handover continues.
   */
  private async stopGracefully(): Promise<void> {
    const stop = this.options.stopGracefully;
    if (!stop) return;
    try {
      await stop();
    } catch (error) {
      logger.warn('DaemonAutoUpdater: orderly stop before the update restart failed; handing over anyway', {
        error: summarizeError(error),
      });
    }
  }
}

/** `https://github.com/o/r/releases/latest` -> `https://github.com/o/r/releases/download/<tag>`. */
export function defaultDownloadBaseUrl(releasesLatestUrl: string, tag: string): string {
  const base = releasesLatestUrl.replace(/\/latest\/?$/, '');
  return `${base}/download/${tag}`;
}
