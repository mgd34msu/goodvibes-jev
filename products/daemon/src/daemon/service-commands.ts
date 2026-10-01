/**
 * Service-lifecycle subcommands, `goodvibes-daemon install-service |
 * uninstall-service | service-status`.
 *
 * The daemon is a SYSTEM SERVICE. These subcommands install it as a durable host
 * service (systemd user unit on Linux, launchd agent on macOS, a Scheduled Task
 * on Windows) so N surfaces share ONE daemon that survives reboots, instead of
 * every surface spawning a session-scoped daemon.
 *
 * Drift note: the SDK's older `systemd-user-service.ts` (a Linux-only,
 * bespoke systemd shim) was dead code and got deleted from the SDK. The SDK's
 * REAL wired service machinery, reached in production by the daemon's own HTTP
 * `/api/service/*` routes via facade-composition.ts, is
 * `PlatformServiceManager` (`@goodvibes-jev/engine/sdk/platform/daemon`): a single
 * systemd/launchd/windows-aware manager with install/uninstall/status/start/
 * stop/restart and a `suggestedCommands` hint list. This module now rewires the
 * three CLI subcommands onto that manager instead of the deleted shim.
 *
 * Two real behavioral differences from the old shim, called out honestly:
 *   - `install()` only WRITES the unit/plist/task; it does not enable/start it.
 *     So `install-service` here calls `install()` then `start()` to preserve the
 *     old "install implies enabled + running" behavior.
 *   - `uninstall()` only REMOVES the unit file; there is no manager-level
 *     `disable` verb (only start/stop/restart exist). So `uninstall-service`
 *     requires a successful stop with no observed running service before
 *     `uninstall()`, and honestly tells the caller that a
 *     stray "enabled" symlink may remain until `systemctl --user daemon-reload`
 *     (offered back as a suggested follow-up) or the next login cleans it up.
 *
 * A fourth subcommand, `migrate-service`, closes the earlier "detect and
 * disclose only" inheritance (W3 Finding 4, below) with a GUIDED, CONSENTED
 * takeover of the legacy `goodvibes-daemon.service` unit. Design constraints,
 * all load-bearing:
 *   - NEVER auto-migrate. Without explicit consent (`confirmMigration`, wired
 *     from the CLI's existing `-y`/`--yes` flag) this prints the exact plan
 *     and touches nothing.
 *   - NEW-UP-THEN-OLD-DOWN. The new `goodvibes.service` unit is installed,
 *     started, and verified healthy (a fresh `status().running` read, which
 *     honestly queries systemd via the injected actionRunner) BEFORE the
 *     legacy unit is stopped, disabled, or removed. A failed or unhealthy new
 *     unit rolls itself back (uninstalled) and never touches the legacy one
 *    , a botched takeover must never cost the user their working daemon.
 *   - ADOPT-OR-WARN, NEVER KILL. If the legacy unit file is simply absent but
 *     something is already listening on the configured host:port (Mike's real
 *     dev-host case: a manual `nohup`'d daemon with no unit at all), this is
 *     an unidentified process, not a managed unit, there is nothing to stop
 *     or disable, and this module will not attempt to kill it. It warns and
 *     leaves the decision to the operator.
 *   - Every action (legacy stop/disable, unit-file removal, daemon-reload)
 *     goes through the SAME injectable `actionRunner`/`legacyUnitFileRemove`
 *     seams tests already use, this module never has a code path that bypasses
 *     them, so the migration is exercised deterministically via fakes and never
 *     touches a real running service in tests.
 */

import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { PlatformServiceManager, type ManagedServiceStatus } from '@goodvibes-jev/engine/sdk/platform/daemon';
import {
  buildManagedDaemonServiceManager,
  detectLegacyUnit,
  legacyUnitNote,
  resolveManagedUnitName,
  runLegacyDaemonMigration,
  LEGACY_SERVICE_UNIT_NAME,
  MANAGED_SERVICE_NAME as SERVICE_NAME,
  MANAGED_SERVICE_DESCRIPTION as SERVICE_DESCRIPTION,
  type LegacyUnitInfo,
  type ManagedServiceActionRunner,
} from '../runtime/legacy-daemon-migration.js';

// `resolveInstalledDaemonBinary` lives in the runtime module, re-exported
// here so this module stays the CLI's stable public surface (and so existing
// test imports keep working).
export {
  resolveInstalledDaemonBinary,
  type ResolveDaemonBinaryOptions,
} from '../runtime/legacy-daemon-migration.js';
export type { ManagedServiceActionRunner } from '../runtime/legacy-daemon-migration.js';

// ---------------------------------------------------------------------------
// Legacy-unit detection, plus guided migration.
//
// The prior command installed the daemon's systemd unit under the
// literal name `goodvibes-daemon.service`. This module (rewired onto
// PlatformServiceManager, see the file banner above) manages a DIFFERENT
// unit name (`goodvibes`, SERVICE_NAME). A host that still has the legacy
// unit installed, this dev machine included, would otherwise see
// service-status honestly report installed:false/running:false for the
// tracked name while the legacy unit keeps running untouched underneath it,
// uninstall-service would silently leave the legacy unit orphaned with no
// mention, and install-service could start a SECOND daemon competing for the
// same port.
//
// The detection (`detectLegacyUnit`/`legacyUnitNote`) and the guided
// migration engine (`runLegacyDaemonMigration`) both live in
// `../runtime/legacy-daemon-migration.ts` rather than here, because this
// daemon's own boot-time reconcile (`../runtime/legacy-daemon-reconcile.ts`)
// needs them too, the entrypoint-agnostic `runtime` layer is what both of
// this repository's consumers can import, so this CLI module is just one of
// them. The terminal app's own onboarding guided UX solves the same problem
// independently, under its own architecture constraints.
//
// This detection is entirely independent of PlatformServiceManager's own
// status(), it does not rely on (or get invalidated by) the parallel SDK
// fix that makes status().running itself query systemd honestly for the
// TRACKED unit name.
// ---------------------------------------------------------------------------

export const DAEMON_SERVICE_SUBCOMMANDS = [
  'install-service',
  'uninstall-service',
  'service-status',
  'migrate-service',
  'start-service',
  'stop-service',
  'restart-service',
] as const;

export type DaemonServiceSubcommand = (typeof DAEMON_SERVICE_SUBCOMMANDS)[number];

export function isDaemonServiceSubcommand(value: string | undefined): value is DaemonServiceSubcommand {
  return typeof value === 'string' && (DAEMON_SERVICE_SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * Exit codes `service-status` reports, so a script never parses prose.
 *
 * 0/3/4 are the three answers the question actually has; 1 stays what it has
 * always been, the platform refused the query and the error is printed.
 */
export const SERVICE_STATUS_EXIT_RUNNING = 0;
export const SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING = 3;
export const SERVICE_STATUS_EXIT_NOT_INSTALLED = 4;

export interface DaemonServiceCliInput {
  readonly subcommand: DaemonServiceSubcommand;
  readonly binaryPath: string;
  /** The GoodVibes tree home (GOODVIBES_HOME-overridable), config/state root only, never unit-path resolution. See `unitHomeDir`. */
  readonly homeDir: string;
  /**
   * The LOGIN user's home, where the systemd/launchd/Windows unit actually
   * lives, regardless of any GOODVIBES_HOME/GOODVIBES_DAEMON_HOME override.
   * Required (no default to `homeDir`) so a unit-management subcommand can
   * never silently search for its unit under a relocated tree home instead of
   * where the service manager actually looks.
   */
  readonly unitHomeDir: string;
  readonly host: string;
  readonly port: number;
  /**
   * Whether the invoking CLI line carried an explicit `--hostname`/`--port`
   * flag (not merely whether `host`/`port` above are set, those are always
   * set, resolved from config either way). `install-service`/`migrate-service`
   * refuse when either is true, see `validateServiceEndpointFlags`. Defaults
   * to false (no flag), matching every subcommand these two don't apply to.
   */
  readonly hostnameFlagProvided?: boolean | undefined;
  readonly portFlagProvided?: boolean | undefined;
  /** Defaults to `homeDir`, overridable so tests can scope both to one tempdir. */
  readonly workingDirectory?: string | undefined;
  /** Injected in tests; a real `ConfigManager` rooted at `homeDir` otherwise. */
  readonly configManager?: ConfigManager | undefined;
  /** Injectable systemctl/launchctl/schtasks runner so tests never touch the host. */
  readonly actionRunner?: ManagedServiceActionRunner | undefined;
  /** Injectable existsSync for the legacy-unit file check (W3 Finding 4) so tests never touch the host filesystem. */
  readonly legacyUnitFileExists?: ((path: string) => boolean) | undefined;
  /**
   * `migrate-service` only: explicit consent to actually execute the
   * migration (wired from the CLI's `-y`/`--yes` flag). Without it, the
   * subcommand prints the exact plan and changes nothing, never auto-migrate.
   */
  readonly confirmMigration?: boolean | undefined;
  /**
   * `migrate-service` only: injectable port-liveness check for the
   * legacy-absent branch (never a raw network call in tests). Defaults to a
   * real, read-only TCP connect attempt.
   */
  readonly portProbe?: ((host: string, port: number) => boolean | Promise<boolean>) | undefined;
  /**
   * `migrate-service` only: injectable removal of the legacy unit file, so
   * tests never call a raw fs op against a real path. Defaults to a real
   * `rmSync`.
   */
  readonly legacyUnitFileRemove?: ((path: string) => void) | undefined;
  /**
   * `service-status` only: report one JSON document instead of prose. The exit
   * code is the same either way, the codes are the machine-readable answer,
   * and JSON is for when a script wants the fields as well.
   */
  readonly json?: boolean | undefined;
}

export interface DaemonServiceCliResult {
  readonly ok: boolean;
  readonly exitCode: number;
  /** Honest, human-readable stdout lines describing exactly what happened. */
  readonly lines: readonly string[];
  /** Last confirmed observation; an incomplete receipt identifies when this predates the failed action. */
  readonly status: ManagedServiceStatus;
}

/**
 * The manager's definition (`ExecStart` command/args, name, description) is
 * built once, in `../runtime/legacy-daemon-migration.ts`, and shared with the
 * onboarding guided UX, see that module's doc comment for why.
 */
function buildManager(input: DaemonServiceCliInput): PlatformServiceManager {
  return buildManagedDaemonServiceManager({
    binaryPath: input.binaryPath,
    homeDir: input.homeDir,
    unitHomeDir: input.unitHomeDir,
    host: input.host,
    port: input.port,
    workingDirectory: input.workingDirectory,
    configManager: input.configManager,
    actionRunner: input.actionRunner,
  });
}

function statusLines(status: ManagedServiceStatus): string[] {
  const lines = [
    `platform: ${status.platform}`,
    `installed: ${status.installed}`,
    `running: ${status.running}`,
    `unit path: ${status.path}`,
  ];
  if (status.pid !== undefined) lines.push(`pid: ${status.pid}`);
  if (status.platform !== 'manual' && status.installed && !status.running) {
    // W3 Finding 4: this used to assert "'running' here only reflects
    // processes this tool started directly", true for the pid-file-only
    // check the (currently linked) SDK still uses, but the parallel SDK
    // batch is making status().running query systemd honestly via
    // `is-active`, which would make that specific claim stale. Drop the
    // claim about HOW running was computed and just offer the escape
    // hatch, true and useful under either SDK version.
    lines.push(
      `note: if this looks wrong, verify directly: ${status.suggestedCommands[status.suggestedCommands.length - 1] ?? 'the platform service-status command'}`,
    );
  }
  return lines;
}

/**
 * Build the install-branch's result lines. Exported for direct unit
 * coverage: the "suggested follow-ups" block is gated on the actual
 * not-started case (W3 Finding 4 friction fix) rather than printed
 * unconditionally, and driving that through the full
 * PlatformServiceManager/systemd integration can't reliably produce
 * `running: true` under the (currently linked) SDK build, whose systemd
 * status check is still pid-file-only (see the honesty note above).
 */
export function buildInstallResultLines(status: ManagedServiceStatus): string[] {
  const lines = [`installed the ${status.platform} service at ${status.path}`];
  if (status.running) {
    lines.push('service is enabled and running');
  } else {
    lines.push('suggested follow-ups if it did not start automatically:');
    for (const cmd of status.suggestedCommands) lines.push(`  ${cmd}`);
  }
  return lines;
}

/**
 * The receipt for `start-service` / `stop-service` / `restart-service`.
 *
 * Every line names the RESOLVED unit (`status.serviceName`, `status.path`) and
 * says what the platform reported afterwards, rather than asserting the verb
 * worked because it was dispatched without throwing. A verb aimed at a service
 * that is not installed says exactly that, installing it silently would be a
 * different command than the one that was run.
 */
export function buildLifecycleResultLines(
  action: 'start' | 'stop' | 'restart',
  status: ManagedServiceStatus,
): string[] {
  if (!status.installed) {
    return [
      `no ${status.platform} service is installed at ${status.path}, so there is nothing to ${action}.`,
      `install it first:  goodvibes-daemon install-service`,
    ];
  }
  const past = action === 'stop' ? 'stopped' : `${action}ed`;
  const lines = [`${past} the ${status.platform} service ${status.serviceName} (${status.path})`];
  lines.push(status.running ? 'it is running' : 'it is not running');
  if (action !== 'stop' && !status.running) {
    lines.push('suggested follow-ups:');
    for (const cmd of status.suggestedCommands) lines.push(`  ${cmd}`);
  }
  return lines;
}

/**
 * Run one of start / stop / restart against the managed service.
 *
 * The installed check happens BEFORE the platform verb is dispatched, not
 * after: `systemctl --user enable --now goodvibes.service` against a unit that
 * does not exist fails with systemd's own wording, which reads like a broken
 * service rather than an absent one. Exit 4 is the same "not installed" answer
 * `service-status` gives, so a script reading one reads the other.
 */
function runLifecycleVerb(
  action: 'start' | 'stop' | 'restart',
  manager: PlatformServiceManager,
): DaemonServiceCliResult {
  const before = manager.status();
  if (!before.installed) {
    return {
      ok: false,
      exitCode: SERVICE_STATUS_EXIT_NOT_INSTALLED,
      lines: buildLifecycleResultLines(action, before),
      status: before,
    };
  }
  const status = action === 'start'
    ? manager.start()
    : action === 'stop'
      ? manager.stop()
      : manager.restart();
  if (status.actionError) {
    return {
      ok: false,
      exitCode: 1,
      lines: [`service ${action} failed: ${status.actionError}`],
      status,
    };
  }
  return { ok: true, exitCode: 0, lines: buildLifecycleResultLines(action, status), status };
}

/** The honest 0/3/4 answer to "is the service installed, and is it running?". */
export function serviceStatusExitCode(status: ManagedServiceStatus): number {
  if (!status.installed) return SERVICE_STATUS_EXIT_NOT_INSTALLED;
  return status.running ? SERVICE_STATUS_EXIT_RUNNING : SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING;
}

/** The `--json` document for `service-status`: the status fields plus the code. */
export function serviceStatusJson(status: ManagedServiceStatus, legacy: LegacyUnitInfo): string {
  return JSON.stringify(
    {
      ok: true,
      data: {
        platform: status.platform,
        serviceName: status.serviceName,
        path: status.path,
        installed: status.installed,
        running: status.running,
        autostart: status.autostart,
        ...(status.pid === undefined ? {} : { pid: status.pid }),
        ...(status.logPath === undefined ? {} : { logPath: status.logPath }),
        ...(status.lingerNote === undefined ? {} : { lingerNote: status.lingerNote }),
        suggestedCommands: status.suggestedCommands,
        legacyUnitPresent: legacy.present,
        exitCode: serviceStatusExitCode(status),
      },
    },
    null,
    2,
  );
}

function ok(action: 'install' | 'uninstall' | 'status', status: ManagedServiceStatus, extra: string[] = []): DaemonServiceCliResult {
  const lines: string[] = [];
  if (action === 'install') {
    lines.push(...buildInstallResultLines(status));
  } else if (action === 'uninstall') {
    lines.push(`removed the ${status.platform} service at ${status.path}`);
    if (status.platform === 'systemd') {
      lines.push(
        "note: this removes the unit file but does not run `disable`; run " +
          "`systemctl --user daemon-reload` to clear any stale enablement symlink.",
      );
    }
  } else {
    lines.push(...statusLines(status));
  }
  lines.push(...extra);
  return { ok: true, exitCode: 0, lines, status };
}

function failed(action: 'install' | 'uninstall' | 'status', status: ManagedServiceStatus): DaemonServiceCliResult {
  return {
    ok: false,
    exitCode: 1,
    lines: [`service ${action} failed: ${status.actionError ?? 'unknown error'}`],
    status,
  };
}

/**
 * `install-service` and `migrate-service` refuse an explicit
 * `--hostname`/`--port` flag rather than silently accepting it. Both flags are
 * RUNTIME-ONLY overrides applied to this one invocation's in-memory config
 * (`applyRuntimeEndpointFlagOverrides` in `src/daemon/cli.ts`), but the unit
 * this subcommand writes carries no endpoint flags at all (see
 * `buildManagedDaemonServiceManager`'s ExecStart doc): the daemon always
 * re-resolves `controlPlane.host`/`port`/`hostMode` from PERSISTED settings at
 * boot. A flag accepted here would print/probe a binding the installed unit
 * will never actually have, an honest gap, not a cosmetic one, since the
 * printed value is exactly what an operator would expect the running service
 * to bind to. Refusing with a pointer to the persistent config path is
 * strictly better than silently doing nothing with the flag.
 */
export function validateServiceEndpointFlags(
  subcommand: DaemonServiceSubcommand,
  flags: { readonly hostnameProvided: boolean; readonly portProvided: boolean },
): readonly string[] {
  if (subcommand !== 'install-service' && subcommand !== 'migrate-service') return [];
  if (!flags.hostnameProvided && !flags.portProvided) return [];
  const flagNames = [flags.hostnameProvided ? '--hostname' : null, flags.portProvided ? '--port' : null]
    .filter((name): name is string => name !== null)
    .join('/');
  return [
    `${subcommand} refused: ${flagNames} only override this process's runtime config; the installed unit carries ` +
      'no endpoint flags and re-resolves controlPlane.host/port/hostMode from persisted settings at boot, so the ' +
      'override would never take effect there.',
    `Set the persistent binding instead: goodvibes-daemon config set controlPlane.host / controlPlane.port (or ` +
      `controlPlane.hostMode), then re-run ${subcommand} without ${flagNames}.`,
  ];
}

/**
 * `migrate-service`: the guided, consented takeover of the legacy
 * `goodvibes-daemon.service` unit. Thin wrapper over
 * `runLegacyDaemonMigration` (`../runtime/legacy-daemon-migration.ts`), see
 * that module for the design constraints (never auto-migrate,
 * new-up-then-old-down, adopt-or-warn/never kill an unrecognized process,
 * every action through an injectable seam) and the onboarding UX consumer.
 */
function runMigrateService(
  input: DaemonServiceCliInput,
  manager: PlatformServiceManager,
  legacy: LegacyUnitInfo,
): Promise<DaemonServiceCliResult> {
  return runLegacyDaemonMigration(
    {
      host: input.host,
      port: input.port,
      trackedServiceName: SERVICE_NAME,
      confirmMigration: input.confirmMigration,
      portProbe: input.portProbe,
      legacyUnitFileRemove: input.legacyUnitFileRemove,
      actionRunner: input.actionRunner,
    },
    manager,
    legacy,
  );
}

/** Dispatch a daemon service subcommand to the SDK's `PlatformServiceManager`. */
export async function runDaemonServiceCli(input: DaemonServiceCliInput): Promise<DaemonServiceCliResult> {
  const manager = buildManager(input);
  const flagErrors = validateServiceEndpointFlags(input.subcommand, {
    hostnameProvided: input.hostnameFlagProvided ?? false,
    portProvided: input.portFlagProvided ?? false,
  });
  if (flagErrors.length > 0) {
    return { ok: false, exitCode: 1, lines: [...flagErrors], status: manager.status() };
  }
  const legacy = detectLegacyUnit(input);
  switch (input.subcommand) {
    case 'migrate-service':
      return runMigrateService(input, manager, legacy);
    case 'install-service': {
      // W3 Finding 4: refuse rather than risk starting a second daemon
      // alongside an already-installed legacy unit. Refuses whenever the
      // legacy unit is present at all (not just when currently active),
      // an installed-but-inactive legacy unit can still be enabled and
      // start competing for the same port later, and "never silently
      // start a second daemon" is the bar here, not "never right now."
      if (legacy.present) {
        const status = manager.status();
        const resolvedName = resolveManagedUnitName(status);
        return {
          ok: false,
          exitCode: 1,
          lines: [
            `service install refused: a service is already installed as ${LEGACY_SERVICE_UNIT_NAME}.service (the unit name an older install script/release used).`,
            legacyUnitNote(legacy, resolvedName),
            `Installing this tool's ${resolvedName}.service alongside it risks two daemons competing for the same port.`,
          ],
          status,
        };
      }
      const installed = manager.install();
      if (installed.actionError) return failed('install', installed);
      const started = manager.start();
      // start()'s actionError (e.g. a platform this manager can't dispatch
      // actions for) doesn't undo the write, report install as ok, but surface
      // the follow-up problem honestly instead of claiming it is running.
      return started.actionError
        ? ok('install', { ...started, running: false }, [`could not start it automatically: ${started.actionError}`])
        : ok('install', started);
    }
    case 'uninstall-service': {
      const before = manager.status();
      let stopped: ManagedServiceStatus;
      try {
        stopped = manager.stop();
      } catch {
        return failed('uninstall', {
          ...before,
          actionError: 'stopping could not be confirmed; the service definition was not removed',
        });
      }
      if (stopped.actionError !== undefined || stopped.running) {
        return failed('uninstall', {
          ...stopped,
          actionError: 'stopping could not be confirmed; the service definition was not removed' +
            (stopped.actionError ? `: ${stopped.actionError}` : ''),
        });
      }
      let uninstalled: ManagedServiceStatus;
      try {
        uninstalled = manager.uninstall();
      } catch {
        return {
          ...failed('uninstall', stopped),
          lines: [
            'service uninstall incomplete: removal or final status could not be confirmed; removal may already have happened. Verify before retrying.',
            'last confirmed state before removal:',
            ...statusLines(stopped),
          ],
        };
      }
      if (uninstalled.actionError !== undefined || uninstalled.installed || uninstalled.running) {
        return failed('uninstall', {
          ...uninstalled,
          actionError: uninstalled.actionError || 'removal is incomplete: the platform still reports an installed or running service',
        });
      }
      const extra: string[] = [];
      // This command only ever touches the TRACKED unit (whatever name/path
      // actually resolved, not necessarily the SERVICE_NAME constant) above,
      // say so explicitly when an install-script unit also exists, so its
      // continued presence is never a silent surprise.
      if (legacy.present) extra.push(legacyUnitNote(legacy, resolveManagedUnitName(uninstalled)));
      return ok('uninstall', uninstalled, extra);
    }
    case 'start-service':
      return runLifecycleVerb('start', manager);
    case 'stop-service':
      return runLifecycleVerb('stop', manager);
    case 'restart-service':
      return runLifecycleVerb('restart', manager);
    case 'service-status': {
      const status = manager.status();
      if (status.actionError) return failed('status', status);
      if (input.json) {
        return {
          ok: true,
          exitCode: serviceStatusExitCode(status),
          lines: [serviceStatusJson(status, legacy)],
          status,
        };
      }
      const result = ok('status', status, legacy.present ? [legacyUnitNote(legacy, resolveManagedUnitName(status))] : []);
      // The status verb reports; it does not fail. `ok` is still true, the
      // question was answered, while the exit code carries the answer itself
      // (0 running / 3 installed-not-running / 4 not installed), so a script
      // never has to read the prose above.
      return { ...result, exitCode: serviceStatusExitCode(status) };
    }
  }
}
