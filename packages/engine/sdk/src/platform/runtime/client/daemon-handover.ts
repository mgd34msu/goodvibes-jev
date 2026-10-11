/**
 * Move an identified legacy daemon onto the monorepo native release cohort.
 * The surface probes the existing product banner, downloads and verifies every
 * fixed payload plus its source manifest, then publishes through self-update.ts.
 * Binary, ordinary Bun runtime, notices, provenance, sqlite-vec and installation
 * receipt move together. Existing homes and settings remain with their owners.
 *
 * Package-managed and unidentified executables are held. A release must reach
 * the selected version floor. Retained physical source identity and cancellation
 * are checked before publication, and service acknowledgement remains separate
 * from the truthful disk receipt. Rollback requires a complete verified prior
 * native cohort; a legacy binary alone is never described as that cohort.
 */
import { spawnSync } from 'node:child_process';
import {
  applyVerifiedUpdate,
  captureUpdateFileIo,
  UpdateTransactionError,
  compareVersions,
  normalizeVersion,
  realUpdateFileIo,
  resolveArtifactNames,
  resolveLatestReleaseTag,
  resolveDaemonNativeTargets,
  retainDaemonNativeFiles,
  type UpdateFetchLike,
  type UpdateFileIo,
} from '../self-update.js';
import { detectInstallKind } from '../install-kind.js';
import { MANAGED_DAEMON_SERVICE_NAME } from './daemon-autostart.js';
import { DAEMON_RELEASES_LATEST_URL } from '../../config/schema-domain-update.js';

/** The selected monorepo release feed for native daemon payloads. */
export const DAEMON_REPO_RELEASES_LATEST_URL = DAEMON_RELEASES_LATEST_URL;

/** Download root for an exact selected monorepo release tag. */
export function daemonReleaseDownloadBaseUrl(tag: string): string {
  return `https://github.com/mgd34msu/goodvibes-jev/releases/download/${tag}`;
}

/** First selected monorepo native cohort version for legacy adoption. */
export const DAEMON_SPLIT_FLOOR_VERSION = '2.0.23';

/** How long the `--version` probe is allowed to take before it counts as unreadable. */
export const DAEMON_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Injectable so tests never spawn a real binary. */
export type RunCommandLike = (
  command: string,
  args: readonly string[],
) => { readonly status: number | null; readonly stdout: string };

const defaultRunCommand: RunCommandLike = (command, args) => {
  try {
    const result = spawnSync(command, [...args], {
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: DAEMON_VERSION_PROBE_TIMEOUT_MS,
    });
    return { status: result.status, stdout: result.stdout ?? '' };
  } catch {
    return { status: null, stdout: '' };
  }
};

/**
 * Pulls the version out of `goodvibes-daemon --version` output, which the daemon
 * prints as `goodvibes-daemon 1.27.1`. Deliberately strict: only a dotted
 * numeric version is accepted, so a binary that printed a usage error, a stack
 * trace, or nothing at all reads as unidentifiable rather than being coerced
 * into a number that would justify replacing it.
 */
export function parseDaemonVersionOutput(output: string): string | null {
  const match = output.trim().match(/^goodvibes-daemon\s+v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)$/);
  return match?.[1] ?? null;
}

/** Runs `<binaryPath> --version` and returns the parsed version, or null. */
export function readInstalledDaemonVersion(
  binaryPath: string,
  runCommand: RunCommandLike = defaultRunCommand,
): string | null {
  const result = runCommand(binaryPath, ['--version']);
  if (result.status !== 0) return null;
  return parseDaemonVersionOutput(result.stdout);
}

/** True when the installed version predates the selected native adoption floor. */
export function isPreSplitDaemonVersion(
  version: string,
  floorVersion: string = DAEMON_SPLIT_FLOOR_VERSION,
): boolean {
  return compareVersions(version, floorVersion) < 0;
}

export type DaemonHandoverSkipReason =
  /** The operator turned launch-time binary swapping off. */
  | 'disabled'
  /** No `goodvibes-daemon` binary was found beside this install. */
  | 'no-daemon-binary'
  /** The daemon is package-manager managed; swapping it in place would fight the package manager. */
  | 'not-swappable-install'
  /** The binary did not answer `--version` with something identifiable. */
  | 'version-unreadable'
  /** The installed daemon already comes from its own repository. */
  | 'already-split'
  /** No daemon assets are published for this platform/arch. */
  | 'unsupported-platform';

export type DaemonHandoverDecision =
  | { readonly action: 'skip'; readonly reason: DaemonHandoverSkipReason }
  | {
      readonly action: 'handover';
      readonly binaryPath: string;
      readonly fromVersion: string;
      readonly assetName: string;
    };

export interface DaemonHandoverDecisionInput {
  /** The resolved `goodvibes-daemon` path, or null when none was found. */
  readonly binaryPath: string | null;
  /** The version that binary reported, or null when it could not be read. */
  readonly installedVersion: string | null;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Defaults to {@link DAEMON_SPLIT_FLOOR_VERSION}. */
  readonly floorVersion?: string;
}

/**
 * The whole decision, as a pure function of what was observed. Every skip
 * carries the reason it skipped so the caller can say which one happened
 * instead of reporting a single undifferentiated "nothing to do".
 */
export function decideDaemonHandover(input: DaemonHandoverDecisionInput): DaemonHandoverDecision {
  const binaryPath = input.binaryPath?.trim();
  if (!binaryPath) return { action: 'skip', reason: 'no-daemon-binary' };
  if (detectInstallKind(binaryPath) !== 'binary') {
    return { action: 'skip', reason: 'not-swappable-install' };
  }
  if (!input.installedVersion) return { action: 'skip', reason: 'version-unreadable' };
  if (!isPreSplitDaemonVersion(input.installedVersion, input.floorVersion)) {
    return { action: 'skip', reason: 'already-split' };
  }
  const artifacts = resolveArtifactNames(input.platform, input.arch);
  if (!artifacts || !resolveDaemonNativeTargets(binaryPath, input.platform, input.arch)) return { action: 'skip', reason: 'unsupported-platform' };
  return {
    action: 'handover',
    binaryPath,
    fromVersion: input.installedVersion,
    assetName: artifacts.daemon,
  };
}

/**
 * Compatibility progress flag: true only after the disk cohort committed.
 * Staging or a compensated failed commit must not claim a replacement.
 */
export interface DaemonHandoverProgress {
  begun: boolean;
  tag: string | null;
}

export function createDaemonHandoverProgress(): DaemonHandoverProgress {
  return { begun: false, tag: null };
}

/** The failure an aborted handover ends with, raised only while nothing has been written. */
export const HANDOVER_ABORTED_MESSAGE = 'daemon handover cancelled before any file was replaced';

type AbortableFetchInit = NonNullable<Parameters<UpdateFetchLike>[1]> & { signal?: AbortSignal };

function abortableFetch(fetchImpl: UpdateFetchLike, signal: AbortSignal | undefined): UpdateFetchLike {
  if (!signal) return fetchImpl;
  const withSignal = fetchImpl as (url: string, init?: AbortableFetchInit) => ReturnType<UpdateFetchLike>;
  return async (url, init) => {
    if (signal.aborted) throw new Error(HANDOVER_ABORTED_MESSAGE);
    return await withSignal(url, { ...init, signal: init?.signal ?? signal });
  };
}

export interface PerformDaemonHandoverOptions {
  readonly fetchImpl: UpdateFetchLike;
  /** The daemon binary to replace. */
  readonly binaryPath: string;
  /** The release asset that replaces it. */
  readonly assetName: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly runCommand?: RunCommandLike;
  readonly signal?: AbortSignal;
  readonly progress?: DaemonHandoverProgress;
  /** Injectable so tests never touch a real file. */
  readonly io?: UpdateFileIo;
  readonly releasesLatestUrl?: string;
  readonly downloadBaseUrl?: (tag: string) => string;
  /** Defaults to {@link DAEMON_SPLIT_FLOOR_VERSION}. */
  readonly floorVersion?: string;
}

/**
 * Resolves the daemon repository's current release, verifies the daemon asset
 * against that release's SHA256SUMS.txt, and swaps it into place with the
 * outgoing binary kept at `<path>.previous`.
 *
 * The floor is re-checked against the RESOLVED tag, not only against the
 * installed version: a handover exists to move a daemon onto its own release
 * line, and a release below the split floor is not on that line. Without this
 * check an unexpected tag would be installed simply because it was newer than
 * what was there.
 */
export async function performDaemonHandover(
  options: PerformDaemonHandoverOptions,
): Promise<{ readonly tag: string }> {
  options = { ...options, io: captureUpdateFileIo(options.io ?? realUpdateFileIo) };
  const progress = options.progress ?? createDaemonHandoverProgress();
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const targets = resolveDaemonNativeTargets(options.binaryPath, platform, arch);
  if (!targets || targets[0]?.assetName !== options.assetName) throw new Error('Daemon handover native target identity is invalid');
  const io = options.io ?? realUpdateFileIo;
  const assertInstallationCurrent = retainDaemonNativeFiles(targets, io);
  const fetchImpl = abortableFetch(options.fetchImpl, options.signal);
  const releasesLatestUrl = options.releasesLatestUrl ?? DAEMON_REPO_RELEASES_LATEST_URL;
  const floorVersion = options.floorVersion ?? DAEMON_SPLIT_FLOOR_VERSION;
  const installedVersion = readInstalledDaemonVersion(options.binaryPath, options.runCommand ?? defaultRunCommand);
  if (!installedVersion || compareVersions(installedVersion, floorVersion) >= 0) throw new Error('Daemon handover requires an identified older daemon at its retained native path');
  assertInstallationCurrent();
  const tag = await resolveLatestReleaseTag(fetchImpl, releasesLatestUrl, options.signal ? { signal: options.signal } : {});
  assertInstallationCurrent();
  if (compareVersions(tag, floorVersion) < 0) {
    throw new Error(
      `the daemon repository's current release is ${tag}, below the ${floorVersion} split floor, refusing to hand over to it`,
    );
  }
  progress.tag = tag;
  if (options.signal?.aborted) throw new Error(HANDOVER_ABORTED_MESSAGE);
  const baseIo = options.io ?? realUpdateFileIo;
  try {
    await applyVerifiedUpdate({
      fetchImpl,
      downloadBaseUrl: (options.downloadBaseUrl ?? daemonReleaseDownloadBaseUrl)(tag),
      targets,
      platform,
      daemonNative: { execPath: options.binaryPath, platform, arch, version: tag, allowLegacyBinary: true },
      beforeCommit: assertInstallationCurrent,
      io: baseIo,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    progress.begun = true;
  } catch (error) {
    if (error instanceof UpdateTransactionError) progress.begun = error.receipt.committed;
    throw error;
  }
  return { tag };
}

export interface DaemonRestartOutcome {
  /** True when a restart was actually issued and the service manager accepted it. */
  readonly restarted: boolean;
  readonly unitName: string;
  /** What happened, in the words the receipt uses. */
  readonly detail: string;
}

/**
 * The daemon's service name as this host has it: the configured override when
 * one is set, the installer's managed name otherwise.
 */
export function resolveHandoverServiceName(configManager: { get(key: string): unknown }): string {
  const raw = configManager.get('service.serviceName');
  const configured = raw === undefined || raw === null ? '' : String(raw).trim();
  return configured || MANAGED_DAEMON_SERVICE_NAME;
}

/**
 * Restarts the handed-over daemon so the RUNNING process is the new binary.
 * A swap replaces the file; the process that opened the old inode keeps running
 * it until it is restarted, so without this the handover would be true on disk
 * and false in memory.
 *
 * Only systemd user units are restarted here, and only when the unit is
 * genuinely active. On every other platform and posture this reports honestly
 * that the new binary takes effect on the daemon's next start rather than
 * printing a command that would not work.
 */
export function restartHandedOverDaemon(
  platform: NodeJS.Platform,
  configManager: { get(key: string): unknown },
  runCommand: RunCommandLike = defaultRunCommand,
): DaemonRestartOutcome {
  const unitName = resolveHandoverServiceName(configManager);
  if (platform !== 'linux') {
    return {
      restarted: false,
      unitName,
      detail: 'the new daemon takes effect the next time the daemon starts',
    };
  }
  const active = runCommand('systemctl', ['--user', 'is-active', `${unitName}.service`]);
  if (active.status !== 0 || active.stdout.trim() !== 'active') {
    return {
      restarted: false,
      unitName,
      detail: 'the new daemon takes effect the next time the daemon starts',
    };
  }
  const restart = runCommand('systemctl', ['--user', 'restart', `${unitName}.service`]);
  if (restart.status !== 0) {
    return {
      restarted: false,
      unitName,
      detail: `the swap is on disk but restarting ${unitName}.service failed, run: systemctl --user restart ${unitName}.service`,
    };
  }
  return {
    restarted: true,
    unitName,
    detail: `restarted ${unitName}.service onto it`,
  };
}

export type DaemonHandoverOutcome =
  | { readonly action: 'skipped'; readonly reason: DaemonHandoverSkipReason }
  | {
      readonly action: 'handed-over';
      readonly fromVersion: string;
      readonly toTag: string;
      readonly restarted: boolean;
      readonly unitName: string;
    }
  /** The budget ran out before anything was written; the download was cancelled. */
  | { readonly action: 'deferred' }
  /** The budget ran out after the swap began; the binary WAS replaced. */
  | { readonly action: 'swapped-needs-restart'; readonly toTag: string }
  | { readonly action: 'failed'; readonly detail: string };

export interface RunDaemonHandoverOptions {
  readonly fetchImpl: UpdateFetchLike;
  /** The resolved `goodvibes-daemon` path, or null when none was found. */
  readonly binaryPath: string | null;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly configManager: { get(key: string): unknown };
  readonly print: (line: string) => void;
  /** Defaults to {@link DAEMON_SPLIT_FLOOR_VERSION}. */
  readonly floorVersion?: string;
  /** Injectable so tests observe the probe instead of spawning a binary. */
  readonly runCommand?: RunCommandLike;
  /** Injectable so tests observe the swap instead of replacing a real file. */
  readonly performHandover?: (options: PerformDaemonHandoverOptions) => Promise<{ readonly tag: string }>;
  readonly restartDaemon?: typeof restartHandedOverDaemon;
  readonly io?: UpdateFileIo;
  readonly timeoutMs?: number;
}

/** Default budget for the whole handover, generous (a daemon binary is large) but bounded. */
export const DAEMON_HANDOVER_TIMEOUT_MS = 90_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The complete handover: probe, decide, swap, restart, report. Never throws, a
 * surface's launch is never held hostage by the state of the daemon beside it.
 */
export async function runDaemonHandover(options: RunDaemonHandoverOptions): Promise<DaemonHandoverOutcome> {
  options = { ...options, io: captureUpdateFileIo(options.io ?? realUpdateFileIo),
    configManager: { get: options.configManager.get.bind(options.configManager) } };
  const runCommand = options.runCommand ?? defaultRunCommand;
  const installedVersion = options.binaryPath
    ? readInstalledDaemonVersion(options.binaryPath, runCommand)
    : null;
  const decision = decideDaemonHandover({
    binaryPath: options.binaryPath,
    installedVersion,
    platform: options.platform,
    arch: options.arch,
    ...(options.floorVersion ? { floorVersion: options.floorVersion } : {}),
  });
  if (decision.action === 'skip') {
    return { action: 'skipped', reason: decision.reason };
  }

  const from = normalizeVersion(decision.fromVersion);
  options.print(
    `daemon handover: the installed daemon is v${from}, from before the daemon became its own product, fetching the current one…`,
  );

  const controller = new AbortController();
  const progress = createDaemonHandoverProgress();
  try {
    const perform = options.performHandover ?? performDaemonHandover;
    const work = perform({
      fetchImpl: options.fetchImpl,
      binaryPath: decision.binaryPath,
      assetName: decision.assetName,
      platform: options.platform,
      arch: options.arch,
      runCommand,
      signal: controller.signal,
      progress,
      ...(options.io ? { io: options.io } : {}),
      ...(options.floorVersion ? { floorVersion: options.floorVersion } : {}),
    });
    // Losing the race abandons this promise and a cancelled download rejects
    // shortly after; that rejection is the expected end of the work, not an
    // unhandled failure. The race below still sees every rejection that
    // arrives before the budget runs out.
    work.catch(() => {});
    const result = await withTimeout(work, options.timeoutMs ?? DAEMON_HANDOVER_TIMEOUT_MS);
    if (result === 'timeout') {
      if (!progress.begun) {
        controller.abort();
        options.print('daemon handover deferred, will retry next launch');
        return { action: 'deferred' };
      }
      const tag = normalizeVersion(progress.tag ?? '');
      options.print(
        `daemon handover: the daemon binary was replaced with v${tag}; restart it to run the new one`,
      );
      return { action: 'swapped-needs-restart', toTag: progress.tag ?? '' };
    }

    const restart = (options.restartDaemon ?? restartHandedOverDaemon)(
      options.platform,
      options.configManager,
      runCommand,
    );
    options.print(
      `daemon handover: replaced the daemon v${from} with v${normalizeVersion(result.tag)} from its own repository, ${restart.detail}.`
        + ` Replaced files are retained; rollback requires a complete verified previous cohort.`,
    );
    return {
      action: 'handed-over',
      fromVersion: decision.fromVersion,
      toTag: result.tag,
      restarted: restart.restarted,
      unitName: restart.unitName,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const state = error instanceof UpdateTransactionError && error.receipt.recoveryRequired
      ? error.receipt.committed
        ? 'the new daemon is installed on disk, but cleanup needs inspection; automatic retry is fenced'
        : 'the installed files need recovery inspection; automatic retry is fenced'
      : progress.begun
        ? 'the new daemon is installed on disk; its restart has not been confirmed'
        : `the installed daemon v${from} is unchanged and will be retried next launch`;
    options.print(`daemon handover failed: ${detail}; ${state}`);
    return { action: 'failed', detail };
  }
}
