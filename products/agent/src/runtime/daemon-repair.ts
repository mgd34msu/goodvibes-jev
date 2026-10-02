/**
 * daemon-repair.ts, the one-touch repair for a machine whose daemon is off in
 * both places at once.
 *
 * ── The state this exists for ──────────────────────────────────────────────
 *
 * A laptop sat unusable for weeks. Two things were true on it at the same time:
 * its daemon service was stopped, and its Agent settings carried
 * `daemon.enabled: false`. Neither alone is a fault, a stopped service is
 * started by the boot-time autostart in bootstrap-external-services.ts, and a
 * deliberate `false` is a choice the platform honors. Together they are a dead
 * end, because the flag short-circuits discovery before the autostart is ever
 * consulted: `startHostServices` returns `mode: 'disabled'` without probing,
 * and `autostartInstalledDaemon` classifies that as `daemon-disabled` and
 * declines to act. The Agent booted, found no host, and had no path to one.
 * A person had to be handed shell commands to type.
 *
 * ── What this does instead ─────────────────────────────────────────────────
 *
 * States the situation in ONE line and offers to fix it. On the user's single
 * confirmation the platform does every step itself: writes the setting, has the
 * daemon's own CLI install or start its service, waits for the daemon to answer
 * on its configured address, and leaves a receipt in the activity log naming
 * each thing it did. One action from the user; the mechanics are the platform's
 * problem.
 *
 * ── The boundaries ─────────────────────────────────────────────────────────
 *
 * - The offer is only ever made when BOTH halves are true. A `false` flag on a
 *   machine whose daemon is up and answering is a working configuration and is
 *   left alone.
 * - Declining changes nothing at all, not the setting, not the service, and
 *   is remembered for the rest of the session, so the answer is asked for once
 *   and never again turn after turn.
 * - Every step of a repair reports what it actually did, including a partial
 *   one. A repair that sets the flag and then cannot start the service says
 *   exactly that; it never claims a daemon that is not answering.
 * - Nothing here reads or writes the terminal. It returns text, and the two
 *   surfaces (the interactive prompt and headless run's stderr) render it.
 */
import net from 'node:net';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  connectedHostPort,
  dialHostForConfiguredHost,
} from '../config/connected-host-dial.ts';
import {
  createDaemonCliRunner,
  installDaemonService,
  readDaemonServiceReport,
  startDaemonService,
  type DaemonCliRunner,
  type DaemonServiceReport,
} from './daemon-cli-service.ts';

/** The setting this repair turns back on, named once so every string agrees. */
export const DAEMON_ENABLED_KEY = 'daemon.enabled';

/**
 * The config surface this module needs: read the adopt flag, write it back, and
 * resolve the address the daemon is expected to answer on. Narrow on purpose,
 * so a test supplies an object literal rather than a whole ConfigManager.
 */
export interface DaemonRepairConfig {
  get(key: 'daemon.enabled' | 'controlPlane.host' | 'controlPlane.port'): boolean | string | number | undefined;
  set(key: 'daemon.enabled', value: boolean): void;
}

/**
 * A decline, remembered for the life of this process.
 *
 * Deliberately NOT persisted to disk, unlike the workspace-registration
 * decline it otherwise resembles. That one answers "should this directory ever
 * get checkpoints", which is a standing preference. This one answers "fix this
 * machine now", asked about a state that is still broken, a durable "no" would
 * turn one dismissal into permanent silence about a laptop that still cannot
 * reach its daemon. The next session asks again; this one does not.
 */
export interface DaemonRepairSessionMemory {
  readonly declined: () => boolean;
  readonly decline: () => void;
}

export function createDaemonRepairSessionMemory(): DaemonRepairSessionMemory {
  let declined = false;
  return {
    declined: () => declined,
    decline: () => { declined = true; },
  };
}

/** The wedged state, once both halves have been confirmed. */
export interface DaemonRepairOffer {
  /** Whether a unit exists already, decides install-service vs start-service. */
  readonly serviceInstalled: boolean;
  /** The unit name the daemon CLI reported, when it named one. */
  readonly serviceName: string | null;
  /** One plain line stating what is wrong. */
  readonly diagnosis: string;
  /** The offer itself, in the wording each surface presents verbatim. */
  readonly offer: string;
}

export interface DaemonRepairDiagnosisOptions {
  readonly config: DaemonRepairConfig;
  readonly session: DaemonRepairSessionMemory;
  /** Injectable so a test never spawns the real daemon CLI. */
  readonly runDaemonCli?: DaemonCliRunner;
}

/**
 * Decide whether this machine is in the wedged state, and say so.
 *
 * Returns null, silently, having spawned nothing, in every ordinary case.
 * The daemon CLI is only consulted when the flag is already off, so a machine
 * with `daemon.enabled: true` (which is every healthy machine, since true is
 * the default) pays nothing for this check at boot.
 */
export function diagnoseDaemonRepair(options: DaemonRepairDiagnosisOptions): DaemonRepairOffer | null {
  if (options.session.declined()) return null;
  // The flag is the cheap half and the one that short-circuits discovery, so it
  // is asked first. `resolveDaemonEnabled` is the same reader the discovery
  // path uses, so this can never disagree with the thing it is diagnosing.
  if (resolveDaemonEnabled(options.config)) return null;

  const run = options.runDaemonCli ?? createDaemonCliRunner();
  let report: DaemonServiceReport;
  try {
    report = readDaemonServiceReport(run);
  } catch (error) {
    // A diagnosis that cannot complete is not an offer. Boot is never the place
    // to raise from a check that exists to be helpful.
    logger.debug('[daemon-repair] reading the daemon service entry failed', { error: summarizeError(error) });
    return null;
  }

  // Only the two states that mean "there is no daemon running here" are
  // offered on. 'running' is a working machine whose flag merely declines to
  // adopt a daemon of its own, a real configuration, left exactly alone.
  // 'unknown' means the question was not answered (no daemon CLI on this
  // machine, or a service manager that refused), and guessing on top of an
  // unanswered question is how a helpful offer becomes a wrong one.
  if (report.state !== 'installed-not-running' && report.state !== 'not-installed') return null;

  const serviceInstalled = report.state === 'installed-not-running';
  const named = report.serviceName ? ` "${report.serviceName}"` : '';
  const diagnosis = serviceInstalled
    ? `This machine cannot reach a GoodVibes daemon: its service${named} is installed but stopped, and this Agent's ${DAEMON_ENABLED_KEY} setting is false, which stops it from even looking.`
    : `This machine cannot reach a GoodVibes daemon: no daemon service is installed here, and this Agent's ${DAEMON_ENABLED_KEY} setting is false, which stops it from even looking.`;
  const offer = serviceInstalled
    ? `Repair it? Press "y" and the Agent will set ${DAEMON_ENABLED_KEY} to true, start the daemon service, and confirm it answers. Any other key leaves everything untouched.`
    : `Repair it? Press "y" and the Agent will set ${DAEMON_ENABLED_KEY} to true, install and start the daemon service, and confirm it answers. Any other key leaves everything untouched.`;

  return { serviceInstalled, serviceName: report.serviceName, diagnosis, offer };
}

/** What a repair actually did, step by step, in the order it did it. */
export interface DaemonRepairResult {
  /** True only when the daemon answered on its configured address afterwards. */
  readonly repaired: boolean;
  /** One line per step performed, the receipt, in the order things happened. */
  readonly steps: readonly string[];
  /** The single line a surface shows the user. */
  readonly summary: string;
}

export interface DaemonRepairRunOptions {
  readonly config: DaemonRepairConfig;
  readonly offer: DaemonRepairOffer;
  /** Injectable so a test never spawns the real daemon CLI. */
  readonly runDaemonCli?: DaemonCliRunner;
  /** Injectable so a test never opens a socket. Defaults to a TCP connect. */
  readonly verifyReachable?: () => Promise<boolean>;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Injectable so a test drives the wait loop without real time. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable receipt sink; defaults to the activity log. */
  readonly recordReceipt?: (text: string) => void;
}

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** A read-only TCP connect to the address the daemon is configured to bind. */
function defaultVerifyReachable(config: DaemonRepairConfig): () => Promise<boolean> {
  const host = dialHostForConfiguredHost(config.get('controlPlane.host'));
  const port = connectedHostPort(config.get('controlPlane.port'));
  return () => new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Perform the repair the user just confirmed, and report every step.
 *
 * Never throws: a surface calls this from a keypress handler and from a
 * headless boot path, and neither is a place where an exception is a useful
 * answer. Everything that goes wrong comes back as a step that says so.
 */
export async function runDaemonRepair(options: DaemonRepairRunOptions): Promise<DaemonRepairResult> {
  const { config, offer } = options;
  const steps: string[] = [];
  const run = options.runDaemonCli ?? createDaemonCliRunner();
  const recordReceipt = options.recordReceipt
    ?? ((text: string) => { logger.info(text); });

  // Step 1, the setting. Done first and on its own, because it is the half
  // that silenced discovery, and because it is the half that survives even if
  // the service work below fails: the next boot's ordinary autostart path can
  // then finish the job without anyone being asked anything.
  try {
    config.set(DAEMON_ENABLED_KEY, true);
    steps.push(`set ${DAEMON_ENABLED_KEY} to true (it was false, which stopped this Agent from looking for a daemon at all)`);
  } catch (error) {
    const reason = summarizeError(error);
    steps.push(`could not set ${DAEMON_ENABLED_KEY} to true: ${reason}`);
    const summary = `[Daemon] Repair could not start: the ${DAEMON_ENABLED_KEY} setting could not be written (${reason}). Nothing was changed.`;
    recordReceipt(`${summary} Steps: ${steps.join('; ')}`);
    return { repaired: false, steps, summary };
  }

  // Step 2, the service. `install-service` installs AND starts, so an absent
  // unit takes one command, not two.
  const action = offer.serviceInstalled ? startDaemonService(run) : installDaemonService(run);
  const verb = offer.serviceInstalled ? 'started the daemon service' : 'installed and started the daemon service';
  if (action.ok) {
    steps.push(`${verb} through goodvibes-daemon (${action.detail})`);
  } else {
    steps.push(`could not ${offer.serviceInstalled ? 'start' : 'install'} the daemon service: ${action.detail}`);
  }

  // Step 3, proof. The service manager accepting a command is not the daemon
  // answering, and only the second one means the machine is repaired.
  const verifyReachable = options.verifyReachable ?? defaultVerifyReachable(config);
  const reachable = action.ok ? await waitForDaemon(verifyReachable, options) : false;
  if (action.ok) {
    steps.push(reachable
      ? 'confirmed the daemon answers on its configured address'
      : 'the daemon did not answer on its configured address within the wait');
  }

  const summary = reachable
    ? `[Daemon] Repaired: ${DAEMON_ENABLED_KEY} is true, the daemon service is running, and it answers. ${steps.length} steps recorded in the activity log.`
    : action.ok
      ? `[Daemon] Partly repaired: ${DAEMON_ENABLED_KEY} is now true and the service command was accepted, but the daemon is not answering yet. Its own logs will say why; the Agent will try to start it again at the next launch.`
      : `[Daemon] Not repaired: ${DAEMON_ENABLED_KEY} is now true, but the daemon service could not be ${offer.serviceInstalled ? 'started' : 'installed'}, ${action.detail}.`;

  recordReceipt(`${summary} Steps: ${steps.join('; ')}`);
  return { repaired: reachable, steps, summary };
}

/** Poll for an answering daemon, attempt-counted so an injected sleep terminates. */
async function waitForDaemon(
  isReachable: () => Promise<boolean>,
  options: DaemonRepairRunOptions,
): Promise<boolean> {
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const attempts = Math.max(1, Math.ceil(waitTimeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(pollIntervalMs);
    try {
      if (await isReachable()) return true;
    } catch (error) {
      logger.debug('[daemon-repair] re-probing the daemon failed', { error: summarizeError(error) });
    }
  }
  return false;
}

/**
 * The two lines headless `run` writes to stderr.
 *
 * Run mode never prompts, stdout is a machine-readable contract and stdin is
 * not a person, but staying silent about a wedged machine is how the incident
 * this repairs lasted weeks. It states the diagnosis and quotes the offer the
 * interactive surface would have made, so the reader knows the fix exists and
 * what taking it involves, then the run proceeds exactly as before.
 */
export function describeDaemonRepairForHeadless(offer: DaemonRepairOffer): readonly string[] {
  return [
    `[Daemon] ${offer.diagnosis}`,
    `[Daemon] ${offer.offer.replace('Press "y" and the Agent will', 'Start goodvibes-agent interactively and press "y" at the offer, and it will')}`,
  ];
}
