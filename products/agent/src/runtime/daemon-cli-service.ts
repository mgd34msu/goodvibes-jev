/**
 * daemon-cli-service.ts, asking the daemon's own CLI about its service entry,
 * and asking it to install or start one.
 *
 * ── Why the CLI and not the in-process service manager ─────────────────────
 *
 * The Agent already reads a service entry in-process, through the SDK's
 * `createDaemonServiceControl` over `PlatformServiceManager`, and that stays
 * exactly where it is: it is the right seam for the boot-time start of an
 * installed-but-stopped host, because that path only ever needs to know
 * "installed?" and "start it".
 *
 * Repairing a machine needs one thing that seam cannot honestly do: INSTALL a
 * unit. A unit written by this process would carry a command line this process
 * resolved, and the Agent does not own the daemon's binary, its arguments, or
 * its environment. `goodvibes-daemon install-service` does, it is the daemon
 * naming itself. So the repair path talks to the daemon's CLI, which is
 * installed alongside the Agent (the Agent depends on @goodvibes-jev/daemon
 * and its launcher lands on PATH), and which publishes a machine-readable
 * contract precisely so a caller never parses prose:
 *
 *   service-status --json  exit 0 running / 3 installed-not-running /
 *                          4 not installed / 1 the platform refused the query
 *   install-service        installs the unit AND starts it
 *   start-service          starts an installed unit (exit 4 if not installed)
 *
 * ── The boundaries ─────────────────────────────────────────────────────────
 *
 * - The Agent process is not sandboxed, so it may spawn this directly. It is
 *   still the ONLY thing spawned here, always by bare name so an operator's
 *   PATH decides which one answers, and never with a shell.
 * - A CLI that is absent, unreadable, or too old to know these subcommands is a
 *   normal answer ('unavailable'), never an exception. A machine without the
 *   daemon installed must not be a machine where the Agent fails to boot.
 * - Nothing here decides anything. It reports what the CLI said; the policy in
 *   daemon-repair.ts decides what that means.
 */
import { spawnSync } from 'node:child_process';

/** The launcher name the daemon package installs; resolved through PATH. */
export const DAEMON_CLI_BINARY = 'goodvibes-daemon';

/** Exit codes `service-status` publishes, so this module never parses prose. */
export const SERVICE_STATUS_EXIT_RUNNING = 0;
export const SERVICE_STATUS_EXIT_QUERY_REFUSED = 1;
export const SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING = 3;
export const SERVICE_STATUS_EXIT_NOT_INSTALLED = 4;

/** One completed run of the daemon CLI, or the honest reason there wasn't one. */
export interface DaemonCliRun {
  /** False when the binary could not be run at all (absent, not executable). */
  readonly ran: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Present only when `ran` is false, why the spawn itself did not happen. */
  readonly spawnError?: string;
}

/** The narrow seam every effect in this module goes through, so tests never spawn. */
export type DaemonCliRunner = (args: readonly string[]) => DaemonCliRun;

/**
 * What the daemon says about its own service entry on this machine.
 *
 * `state` is derived from the published exit code, NOT from the JSON body:
 * the code is the contract, and a build whose `--json` shape drifts still
 * answers the question correctly. The JSON is read only for the details
 * (which unit, which service manager), and its absence costs those details
 * and nothing else.
 */
export interface DaemonServiceReport {
  readonly state: 'running' | 'installed-not-running' | 'not-installed' | 'unknown';
  /** The resolved unit name, when the CLI reported one. */
  readonly serviceName: string | null;
  /** 'systemd' | 'launchd' | 'windows' | 'manual', when the CLI reported one. */
  readonly platform: string | null;
  /** True when the daemon CLI answered at all. False means it is absent/unusable. */
  readonly cliAvailable: boolean;
  /** Why the answer is 'unknown', absent CLI, refused query, unreadable output. */
  readonly reason?: string;
}

/** One attempted service change, as the CLI reported it. */
export interface DaemonServiceActionReport {
  readonly ok: boolean;
  /** Honest, already-trimmed text from the CLI, its own wording, never invented here. */
  readonly detail: string;
}

/** Spawn the daemon CLI by bare name, capturing both streams. Never throws. */
export function createDaemonCliRunner(options: {
  readonly timeoutMs?: number;
  readonly binary?: string;
} = {}): DaemonCliRunner {
  const binary = options.binary ?? DAEMON_CLI_BINARY;
  const timeout = options.timeoutMs ?? 30_000;
  return (args) => {
    try {
      const result = spawnSync(binary, [...args], {
        encoding: 'utf-8',
        timeout,
        // No shell: the argument vector is passed through verbatim, so nothing
        // in a unit name or a path is ever re-interpreted by a shell.
        shell: false,
        // Passed EXPLICITLY, and not left to default to "whatever the runtime
        // captured at startup". Without it, `spawnSync` resolves a bare command
        // name against a PATH snapshot taken when the process began, so a PATH
        // set after startup is ignored and a different binary answers than the
        // one the current environment names. That is wrong for an operator who
        // adjusts PATH, and it is how a test aiming at a scripted stand-in
        // silently reached the real daemon instead.
        env: process.env,
      });
      if (result.error) {
        return { ran: false, exitCode: -1, stdout: '', stderr: '', spawnError: result.error.message };
      }
      // A signalled process (the timeout above kills it) has a null status; that
      // is "the CLI did not answer", not "the CLI answered zero".
      if (result.status === null) {
        return {
          ran: false,
          exitCode: -1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          spawnError: result.signal ? `ended on signal ${result.signal}` : 'ended without an exit code',
        };
      }
      return {
        ran: true,
        exitCode: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    } catch (error) {
      return {
        ran: false,
        exitCode: -1,
        stdout: '',
        stderr: '',
        spawnError: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/** The two detail fields this module reads out of `service-status --json`. */
interface ServiceStatusJsonDetails {
  readonly serviceName: string | null;
  readonly platform: string | null;
}

/**
 * Pull the unit name and platform out of the CLI's `--json` document.
 *
 * Deliberately total: any shape that is not the expected one yields nulls
 * rather than an error, because the exit code has already answered the actual
 * question and these are decoration.
 */
function readServiceStatusDetails(stdout: string): ServiceStatusJsonDetails {
  const empty: ServiceStatusJsonDetails = { serviceName: null, platform: null };
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const data = (parsed as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return empty;
  const record = data as { serviceName?: unknown; platform?: unknown };
  return {
    serviceName: typeof record.serviceName === 'string' && record.serviceName.length > 0 ? record.serviceName : null,
    platform: typeof record.platform === 'string' && record.platform.length > 0 ? record.platform : null,
  };
}

/** First non-empty line of the CLI's output, for a one-line honest detail. */
function firstMeaningfulLine(run: DaemonCliRun): string {
  const candidates = [...run.stderr.split('\n'), ...run.stdout.split('\n')];
  for (const line of candidates) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/**
 * Ask the daemon CLI whether its service is installed and running.
 *
 * This is the same question `goodvibes-daemon service-status` answers, asked
 * the way that command publishes for scripts: the exit code carries the answer.
 */
export function readDaemonServiceReport(run: DaemonCliRunner): DaemonServiceReport {
  const result = run(['service-status', '--json']);
  if (!result.ran) {
    return {
      state: 'unknown',
      serviceName: null,
      platform: null,
      cliAvailable: false,
      reason: `the ${DAEMON_CLI_BINARY} command could not be run (${result.spawnError ?? 'no reason given'})`,
    };
  }
  const details = readServiceStatusDetails(result.stdout);
  switch (result.exitCode) {
    case SERVICE_STATUS_EXIT_RUNNING:
      return { state: 'running', ...details, cliAvailable: true };
    case SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING:
      return { state: 'installed-not-running', ...details, cliAvailable: true };
    case SERVICE_STATUS_EXIT_NOT_INSTALLED:
      return { state: 'not-installed', ...details, cliAvailable: true };
    case SERVICE_STATUS_EXIT_QUERY_REFUSED:
      return {
        state: 'unknown',
        ...details,
        cliAvailable: true,
        reason: firstMeaningfulLine(result) || 'the service manager refused the query',
      };
    default:
      // An exit code this build does not know about is not an answer. Older and
      // newer CLIs both land here rather than being read as a state they did
      // not mean.
      return {
        state: 'unknown',
        ...details,
        cliAvailable: true,
        reason: `${DAEMON_CLI_BINARY} service-status answered with an unrecognised exit code (${result.exitCode})`,
      };
  }
}

/** Install the daemon's service entry (which also starts it) via its own CLI. */
export function installDaemonService(run: DaemonCliRunner): DaemonServiceActionReport {
  return describeAction(run(['install-service']), 'install-service');
}

/** Start an already-installed daemon service entry via its own CLI. */
export function startDaemonService(run: DaemonCliRunner): DaemonServiceActionReport {
  return describeAction(run(['start-service']), 'start-service');
}

function describeAction(result: DaemonCliRun, subcommand: string): DaemonServiceActionReport {
  if (!result.ran) {
    return {
      ok: false,
      detail: `the ${DAEMON_CLI_BINARY} command could not be run (${result.spawnError ?? 'no reason given'})`,
    };
  }
  if (result.exitCode === 0) {
    return { ok: true, detail: firstMeaningfulLine(result) || `${subcommand} completed` };
  }
  return {
    ok: false,
    detail: firstMeaningfulLine(result)
      || `${DAEMON_CLI_BINARY} ${subcommand} exited ${result.exitCode}`,
  };
}
