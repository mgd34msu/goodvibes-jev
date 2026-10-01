import { IS_WORKSPACE_DISTRIBUTION } from './workspace-update-policy.ts';
/**
 * Periodic self-update for a long-running agent.
 *
 * Launch-time self-update (cli/launch-auto-update.ts) only ever helps a
 * process that restarts. An agent left running for days sat on whatever build
 * it started with while releases shipped past it, the launch check had
 * already happened and nothing looked again. This is the loop that looks
 * again: the same boot-settle-then-hourly cadence the daemon runs, wired to
 * the agent's own update helpers so there is still exactly one updater in this
 * codebase (checkForUpdate / applyUpdate from input/commands/update-runtime.ts
 * and restartOntoUpdatedBinary from cli/launch-auto-update.ts).
 *
 * The idle gate is the whole safety story. A swap-and-restart is only allowed
 * at a moment when nothing is in flight:
 *   - no active turn (the session broker's real pending-input count),
 *   - no in-flight channel delivery (a message that left the conversation but
 *     has not reached the person yet),
 *   - no pending user confirmation (an approval waiting on a human answer).
 * While any of those is true the verified update simply waits and the loop
 * re-checks on a short cadence, the same "never mid-turn" contract the daemon
 * swap follows.
 *
 * The restart hands over through the caller's ORDERLY exit path, so terminal
 * restore, session persistence, and shutdown hooks all run before the new
 * binary is spawned with the original argv and environment.
 *
 * Cadence, network, install step, and restart are all injectable; the decision
 * logic is provable without a network, a real swap, or real time passing.
 */
import { PeriodicUpdateLoop, type PeriodicCheckOutcome } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { channelDeliveriesInFlight } from '../agent/channel-delivery.ts';
import { applyUpdate, checkForUpdate, type ApplyUpdateOptions, type CheckForUpdateResult } from '../input/commands/update-runtime.ts';
import { restartOntoUpdatedBinary } from '../cli/launch-auto-update.ts';
import { readExplicitUpdateKeys, readUpdateSettings, type UpdateSettings } from '../config/update-settings.ts';
import { detectInstallKind, normalizeVersion, type UpdateFetchLike } from './update-check.ts';
import { recordSelfUpdate } from './self-update-receipt.ts';
import type { ConfigManager } from '../config/index.ts';
import { VERSION } from '../version.ts';

/** Minutes between periodic checks when settings say nothing. */
export const DEFAULT_PERIODIC_INTERVAL_MINUTES = 60;
/** Seconds after start before the first periodic check when settings say nothing. */
export const DEFAULT_PERIODIC_FIRST_CHECK_SECONDS = 30;

/** The three activity signals the idle gate reads, injected so tests drive them. */
export interface AgentUpdateIdleProbes {
  /** Sessions with pending input, an agent mid-turn. */
  readonly countBusySessions: () => number;
  /** Approvals awaiting a human answer count as pending confirmations. */
  readonly listApprovals: () => readonly { readonly status: string }[];
  /** Channel deliveries that have left the conversation but not reached the person. */
  readonly channelDeliveriesInFlight?: (() => number) | undefined;
}

/**
 * Idle for update purposes: no active turn, no in-flight channel delivery, no
 * pending user confirmation. Any one of them makes the agent busy.
 */
export function agentIsIdleForUpdate(probes: AgentUpdateIdleProbes): boolean {
  if (probes.countBusySessions() > 0) return false;
  const inFlight = (probes.channelDeliveriesInFlight ?? channelDeliveriesInFlight)();
  if (inFlight > 0) return false;
  // 'claimed' is still open: someone picked the approval up but has not answered.
  return !probes.listApprovals().some((approval) => approval.status === 'pending' || approval.status === 'claimed');
}

/**
 * Whether the while-running updater may replace this binary.
 *
 * `update.autoUpdateAtLaunch: false` is documented as THE explicit, persisted
 * off switch for self-update, and it used to gate only the launch swap. The
 * periodic loop kept its own default-on switch, so an install with the
 * documented switch set to false still replaced its own binary about thirty
 * seconds after start and left a `.previous` behind. That is a switch that does
 * not switch, and it is worse than no switch: the person believed they had
 * turned self-replacement off, and anything they verified against that binary
 * afterwards was measuring a different build than the one they installed.
 *
 * So an explicit `autoUpdateAtLaunch: false` now means "this install does not
 * replace its own binary on its own", covering both updaters. The two settings
 * stay independent features rather than collapsing into one: an explicit
 * `update.auto` always wins, so "no launch updates, but do update at an idle
 * moment while running" is still expressible, it just has to be SAID
 * (`autoUpdateAtLaunch: false, auto: true`) rather than being what a bare
 * off switch silently did.
 */
export function periodicUpdateEnabled(
  settings: UpdateSettings,
  options: { readonly autoWasStated?: boolean } = {},
): boolean {
  // A stated `auto` is a decision and always wins. An unstated one is only a
  // default, and a default must not override an explicit off switch.
  if (options.autoWasStated === true) return settings.auto ?? true;
  if (settings.auto === false) return false;
  return settings.autoUpdateAtLaunch ?? true;
}

export interface AgentPeriodicUpdaterOptions {
  readonly currentVersion: string;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly settings: UpdateSettings;
  readonly isIdle: () => boolean;
  /** Surfaces update lines where the person can actually read them. */
  readonly notify: (line: string) => void;
  /**
   * Hands the process over to the just-swapped binary through the caller's
   * orderly exit path (terminal restore, session persistence, shutdown hooks).
   * Never returns.
   */
  readonly restartNow: (fromVersion: string) => void;
  readonly fetchImpl?: UpdateFetchLike | undefined;
  readonly check?: ((fetchImpl: UpdateFetchLike, currentVersion: string) => Promise<CheckForUpdateResult>) | undefined;
  readonly apply?: ((options: ApplyUpdateOptions) => Promise<void>) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
  /** Injectable so tests observe the durable receipt without writing beside a real executable. */
  readonly recordReceipt?: ((entry: {
    readonly execPath: string;
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly trigger: 'periodic';
  }) => void) | undefined;
}

export class AgentPeriodicUpdater {
  private readonly loop: PeriodicUpdateLoop;
  /** The tag already announced, so a deferred update is not re-announced every retry. */
  private announcedTag: string | null = null;

  constructor(private readonly options: AgentPeriodicUpdaterOptions) {
    const intervalMinutes = options.settings.intervalMinutes ?? DEFAULT_PERIODIC_INTERVAL_MINUTES;
    const firstCheckSeconds = options.settings.firstCheckSeconds ?? DEFAULT_PERIODIC_FIRST_CHECK_SECONDS;
    this.loop = new PeriodicUpdateLoop({
      checkIntervalMs: intervalMinutes * 60 * 1000,
      firstCheckDelayMs: firstCheckSeconds * 1000,
      runCheck: () => this.runCheck(),
      onError: (error) => {
        logger.warn('agent periodic update: check failed; retrying on the next interval', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    });
  }

  get firstCheckDelayMs(): number {
    return this.loop.firstCheckDelayMs;
  }

  get checkIntervalMs(): number {
    return this.loop.checkIntervalMs;
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** One iteration; exposed for tests driving mocked time. */
  async tick(): Promise<void> {
    await this.loop.tick();
  }

  private async runCheck(): Promise<PeriodicCheckOutcome> {
    const fetchImpl = this.options.fetchImpl ?? (fetch as UpdateFetchLike);
    const check = this.options.check ?? checkForUpdate;
    const result = await check(fetchImpl, this.options.currentVersion);
    if (result.isCurrent) {
      this.announcedTag = null;
      return 'settled';
    }
    if (this.announcedTag !== result.latestTag) {
      this.announcedTag = result.latestTag;
      this.options.notify(
        `${result.latestTag} is available (running v${normalizeVersion(this.options.currentVersion)}); it installs at the next idle moment`,
      );
    }
    if (!this.options.isIdle()) {
      logger.info('agent periodic update: update ready but the agent has work in flight; deferring the swap', {
        tag: result.latestTag,
      });
      return 'deferred';
    }

    const apply = this.options.apply ?? applyUpdate;
    await apply({
      fetchImpl,
      execPath: this.options.execPath,
      platform: this.options.platform,
      arch: this.options.arch,
      currentVersion: this.options.currentVersion,
      // applyUpdate's own report goes to the log, not over the person's screen;
      // the loop surfaces the two lines that matter through notify.
      print: (line) => logger.info('agent periodic update', { line }),
    });
    // Durable before the hand-over. A notify line lives in one running
    // session's scrollback; a swap that happened mid-run has to still be
    // answerable from the install afterwards.
    (this.options.recordReceipt ?? recordSelfUpdate)({
      execPath: this.options.execPath,
      fromVersion: this.options.currentVersion,
      toVersion: result.latestTag,
      trigger: 'periodic',
    });
    this.options.notify(`updated to ${result.latestTag}, restarting onto the new version`);
    // Stop before handing over: the loop must not fire again from inside the
    // orderly exit that follows.
    this.stop();
    this.options.restartNow(this.options.currentVersion);
    return 'settled';
  }
}

export interface StartPeriodicSelfUpdateParams {
  readonly configManager: Pick<ConfigManager, 'getRaw'> & Partial<Pick<ConfigManager, 'getConfigPath' | 'getProjectConfigPath'>>;
  readonly services: {
    /**
     * The sessions THIS process is running, and how many are mid-turn. Read
     * from the agent's own hosted-session registry rather than a cross-surface
     * register: "is it safe to swap this binary out from under the user" is a
     * question about this process, and a session busy on another surface is not
     * a reason to keep this one from updating.
     */
    readonly hostedSessions: { countBusySessions(): number };
    /**
     * Every ask waiting for this owner, from the daemon's record unioned with
     * this process's own, NOT the local broker alone. An ask raised on this
     * surface is recorded on the daemon, so the broker by itself reports zero
     * while the owner has a prompt on screen, and the updater would swap the
     * binary out from under it.
     */
    readonly approvalsView: { snapshot(): { readonly approvals: readonly { readonly status: string }[] } };
  };
  readonly notify: (line: string) => void;
  /**
   * The caller's orderly exit. `handOver` runs after teardown (terminal
   * restored, session persisted, hooks run) and its return value becomes the
   * process exit code, which is how the restart onto the new binary happens
   * without a bare exit skipping shutdown.
   */
  readonly exit: (handOver?: () => number) => void;
  /** Injectable so tests never touch the real process identity. */
  readonly execPath?: string | undefined;
  readonly currentVersion?: string | undefined;
  readonly argv?: readonly string[] | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * The complete wiring for a running agent, with real host inputs. Returns the
 * teardown to register alongside the session's other subscriptions.
 *
 * Every reason the loop does not run is logged: a non-updatable install (a dev
 * checkout or a package-managed install cannot be swapped in place) and either
 * opt-out both say so, so an agent that never updates is diagnosable from its
 * log rather than a guess.
 */
export function startPeriodicSelfUpdate(params: StartPeriodicSelfUpdateParams): () => void {
  if (IS_WORKSPACE_DISTRIBUTION) return () => {};
  const settings = readUpdateSettings(params.configManager);
  const autoWasStated = readExplicitUpdateKeys(params.configManager).has('auto');
  const currentVersion = params.currentVersion ?? VERSION;
  const execPath = params.execPath ?? process.execPath;
  if (!periodicUpdateEnabled(settings, { autoWasStated })) {
    logger.info(
      settings.auto === false
        ? 'agent periodic update: off, update.auto is false; this agent will not update itself while running'
        : 'agent periodic update: off, update.autoUpdateAtLaunch is false, so this install does not replace its own binary unattended; set update.auto to true to keep only the while-running updates',
    );
    return () => {};
  }
  const installKind = detectInstallKind(execPath);
  if (installKind !== 'binary') {
    logger.info('agent periodic update: off, only a compiled release binary can be swapped in place', { installKind });
    return () => {};
  }
  const updater = new AgentPeriodicUpdater({
    currentVersion,
    execPath,
    platform: process.platform,
    arch: process.arch,
    settings,
    isIdle: () => agentIsIdleForUpdate({
      countBusySessions: () => params.services.hostedSessions.countBusySessions(),
      listApprovals: () => params.services.approvalsView.snapshot().approvals,
    }),
    notify: params.notify,
    // The restart is the caller's orderly exit with a hand-over step: teardown
    // first, then the swapped binary runs with this process's own argv and
    // environment and this process exits with the new instance's code.
    restartNow: (fromVersion) => params.exit(() => restartOntoUpdatedBinary({
      execPath,
      argv: params.argv ?? process.argv.slice(2),
      env: params.env ?? process.env,
      fromVersion,
    })),
  });
  updater.start();
  logger.info('agent periodic update: armed', {
    currentVersion,
    firstCheckInMs: updater.firstCheckDelayMs,
    thenEveryMs: updater.checkIntervalMs,
  });
  return () => updater.stop();
}
