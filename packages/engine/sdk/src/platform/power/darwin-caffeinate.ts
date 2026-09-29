/**
 * power/darwin-caffeinate.ts, the macOS implementation of the power seam.
 *
 * Inhibitors are held by spawning /usr/bin/caffeinate (shipped with every
 * macOS; it creates IOPMAssertions for the life of its child, no root). The
 * seam's classes map onto caffeinate's flags:
 *   - 'idle'  -> `-i` (PreventUserIdleSystemSleep): no idle system sleep.
 *   - 'sleep' -> `-s` (PreventSystemSleep): macOS honours this assertion only
 *     while the Mac draws AC power, so the class is reported granted only when
 *     `pmset -g ps` says AC power at hold time and honestly denied otherwise
 *     (the flag is still passed, so it takes effect once the Mac is plugged in).
 *   - 'handle-lid-switch' -> always denied: no unprivileged macOS mechanism
 *     keeps a closed-lid Mac awake (`pmset disablesleep` needs root).
 * Every hold also passes `-w <owner pid>`: caffeinate releases its assertions
 * and exits by itself when the owner exits, so a crashed owner can never leave
 * an inhibitor blocking sleep.
 *
 * The sleep edge is read from the unified log with a long-lived, read-only
 * `log stream --style ndjson` filtered to the kernel's IOPMrootDomain
 * transition messages ("System Sleep" / "System Wake", optionally "PMRD: "
 * prefixed, with the "SafeSleep" hibernate variants). One JSON object arrives
 * per log entry, so each edge is one line. macOS gives an unprivileged
 * non-IOKit process no pre-suspend delay: the sleep line can reach the watcher
 * only as the system resumes, immediately before the wake line, so the
 * checkpoint hook runs late there rather than never.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { PowerInhibitClass, PowerInhibitHandle, PowerPlatformSeam } from './types.js';
import {
  defaultSleepWatchSpawner,
  onStdoutLines,
  pidIsAlive,
  trackSleepWatcher,
  type OrphanReaperDeps,
  type SleepWatchSpawner,
} from './child-hygiene.js';

export const CAFFEINATE_PATH = '/usr/bin/caffeinate';
export const LOG_PATH = '/usr/bin/log';
export const PMSET_PATH = '/usr/bin/pmset';
const PS_PATH = '/bin/ps';

/** Grace period for a caffeinate child to prove it started. */
const START_PROBE_MS = 300;

/** Where the Mac draws power from, as `pmset -g ps` reports it. */
export type DarwinPowerSource = 'ac' | 'battery' | 'other' | 'unknown';

/**
 * Parse the first line of `pmset -g ps` ("Now drawing from 'AC Power'",
 * "'Battery Power'", "'UPS Power'").
 */
export function parsePmsetPowerSource(output: string): DarwinPowerSource {
  const match = /Now drawing from '([^']+)'/.exec(output);
  if (!match) return 'unknown';
  if (match[1] === 'AC Power') return 'ac';
  if (match[1] === 'Battery Power') return 'battery';
  return 'other';
}

function defaultReadPowerSource(): Promise<DarwinPowerSource> {
  return new Promise((resolve) => {
    execFile(PMSET_PATH, ['-g', 'ps'], { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? 'unknown' : parsePmsetPowerSource(String(stdout)));
    });
  });
}

/** The caffeinate flag for each class macOS can hold; lid-switch has none. */
const CAFFEINATE_FLAG: Partial<Record<PowerInhibitClass, string>> = {
  idle: '-i',
  sleep: '-s',
};

/** The exact caffeinate argv for one hold: the class flags, then `-w <owner pid>`. */
export function caffeinateArgs(classes: readonly PowerInhibitClass[], ownerPid: number): string[] {
  const flags: string[] = [];
  for (const cls of classes) {
    const flag = CAFFEINATE_FLAG[cls];
    if (flag && !flags.includes(flag)) flags.push(flag);
  }
  return [...flags, '-w', String(ownerPid)];
}

/**
 * The inert owner-pid stamp in every sleep-edge watcher's predicate: a clause
 * no log entry ever satisfies negated, so it never filters anything out, but it
 * carries the spawning pid in the watcher's argv for the orphan reaper.
 */
function sleepWatchOwnerStamp(ownerPid: number): string {
  return `GoodvibesSleepWatchOwner${ownerPid}`;
}

const SLEEP_WATCH_OWNER_PID = /GoodvibesSleepWatchOwner(\d+)/;

/** The exact `log stream` argv for the sleep-edge watcher owned by `ownerPid`. */
export function sleepWatchArgs(ownerPid: number): string[] {
  const predicate = 'process == "kernel"'
    + ' AND (eventMessage BEGINSWITH "System " OR eventMessage BEGINSWITH "PMRD: System ")'
    + ` AND NOT (eventMessage == "${sleepWatchOwnerStamp(ownerPid)}")`;
  return ['stream', '--style', 'ndjson', '--predicate', predicate];
}

/**
 * The sleep edge one kernel transition message names: true for going down
 * ("System Sleep", "System SafeSleep"), false for coming back ("System Wake",
 * "System SafeSleep Wake"), null for anything else. Wake is read first because
 * the hibernate wake message also contains "SafeSleep".
 */
export function darwinSleepEdgeFromMessage(message: string): boolean | null {
  const text = message.trim().replace(/^PMRD: /, '');
  if (/^System (?:SafeSleep )?Wake\b/.test(text)) return false;
  if (/^System (?:Safe)?Sleep\b/.test(text)) return true;
  return null;
}

/** The sleep edge on one ndjson line of the watcher's output, or null. */
export function darwinSleepEdgeFromLogLine(line: string): boolean | null {
  const trimmed = line.trim();
  // `log stream` prints a plain "Filtering the log data using ..." banner first.
  if (!trimmed.startsWith('{')) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const message = (entry as { eventMessage?: unknown } | null)?.eventMessage;
  return typeof message === 'string' ? darwinSleepEdgeFromMessage(message) : null;
}

function defaultListProcesses(): ReadonlyArray<{ pid: number; args: string }> {
  let output: string;
  try {
    output = execFileSync(PS_PATH, ['-axww', '-o', 'pid=,args='], { encoding: 'utf-8', timeout: 5_000 });
  } catch {
    return [];
  }
  const rows: Array<{ pid: number; args: string }> = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), args: match[2]! });
  }
  return rows;
}

/**
 * Kill sleep-edge `log stream` watchers whose stamped owner pid is dead. The
 * caffeinate inhibitors need no reaping: `-w <owner pid>` ends them with their
 * owner. Matches only this module's own stamp. Returns the number reaped.
 */
export async function reapOrphanedDarwinSleepWatchers(deps: OrphanReaperDeps = {}): Promise<number> {
  const list = deps.listProcesses ?? defaultListProcesses;
  const isAlive = deps.isAlive ?? pidIsAlive;
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
  const selfPid = deps.selfPid ?? process.pid;
  let reaped = 0;
  for (const row of list()) {
    if (!row.args.includes(`${LOG_PATH} stream`)) continue;
    const stamp = SLEEP_WATCH_OWNER_PID.exec(row.args);
    if (!stamp) continue;
    const ownerPid = Number(stamp[1]);
    if (ownerPid === selfPid || isAlive(ownerPid)) continue;
    try {
      kill(row.pid);
      reaped += 1;
      logger.info('[power] reaped an orphaned sleep-edge watcher from a dead process', { childPid: row.pid, deadOwnerPid: ownerPid });
    } catch (error) {
      logger.warn('[power] orphaned sleep-edge watcher reap failed', { childPid: row.pid, error: summarizeError(error) });
    }
  }
  return reaped;
}

function defaultInhibitorSpawner(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], { stdio: 'ignore', detached: false });
}

function startInhibitor(spawnInhibitor: SleepWatchSpawner, args: readonly string[], probeMs: number): Promise<ChildProcess | null> {
  return new Promise((resolve) => {
    const child = spawnInhibitor(CAFFEINATE_PATH, args);
    let settled = false;
    const settle = (value: ChildProcess | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('error', () => settle(null));
    child.once('exit', () => settle(null));
    setTimeout(() => {
      if (child.exitCode === null && child.pid) settle(child);
      else settle(null);
    }, probeMs).unref?.();
  });
}

export interface DarwinCaffeinateSeamOptions {
  /** Spawner for the caffeinate inhibitor child. Default: the real caffeinate. */
  readonly spawnInhibitor?: SleepWatchSpawner | undefined;
  /** Spawner for the `log stream` sleep-edge watcher. Default: the real log tool. */
  readonly spawnMonitor?: SleepWatchSpawner | undefined;
  /** Current power source. Default: `pmset -g ps`. */
  readonly readPowerSource?: (() => Promise<DarwinPowerSource>) | undefined;
  /** Whether a tool path exists. Default: fs.existsSync. */
  readonly fileExists?: ((path: string) => boolean) | undefined;
  /** Process-table seams for the orphan reaper. */
  readonly reaper?: OrphanReaperDeps | undefined;
  /** Start probe for a caffeinate child. Default 300 ms. */
  readonly startProbeMs?: number | undefined;
}

export function createDarwinCaffeinateSeam(options: DarwinCaffeinateSeamOptions = {}): PowerPlatformSeam {
  const spawnInhibitor = options.spawnInhibitor ?? defaultInhibitorSpawner;
  const spawnMonitor = options.spawnMonitor ?? defaultSleepWatchSpawner;
  const readPowerSource = options.readPowerSource ?? defaultReadPowerSource;
  const fileExists = options.fileExists ?? existsSync;
  const probeMs = options.startProbeMs ?? START_PROBE_MS;
  return {
    platform: 'darwin-caffeinate',
    async isAvailable(): Promise<boolean> {
      return fileExists(CAFFEINATE_PATH);
    },
    async reapOrphans(): Promise<number> {
      return reapOrphanedDarwinSleepWatchers(options.reaper);
    },
    async inhibit(input): Promise<PowerInhibitHandle | null> {
      const granted: PowerInhibitClass[] = [];
      const denied: PowerInhibitClass[] = [];
      const held: PowerInhibitClass[] = [];
      for (const cls of input.classes) {
        if (!CAFFEINATE_FLAG[cls]) {
          denied.push(cls);
          continue;
        }
        held.push(cls);
        if (cls === 'sleep' && (await readPowerSource()) !== 'ac') denied.push(cls);
        else granted.push(cls);
      }
      if (granted.length === 0) return null;
      const child = await startInhibitor(spawnInhibitor, caffeinateArgs(held, process.pid), probeMs);
      if (!child) return null;
      let released = false;
      return {
        grantedClasses: granted,
        deniedClasses: denied,
        release: async () => {
          if (released) return;
          released = true;
          try {
            child.kill('SIGTERM');
          } catch (error) {
            logger.warn('[power] caffeinate release failed', { error: summarizeError(error) });
          }
        },
      };
    },
    onPrepareForSleep(callback): () => void {
      const monitor = spawnMonitor(LOG_PATH, sleepWatchArgs(process.pid));
      const stop = trackSleepWatcher(monitor, (error) => {
        logger.warn('[power] log stream unavailable; sleep-edge signal disabled', { error: summarizeError(error) });
      });
      onStdoutLines(monitor, (line) => {
        const sleeping = darwinSleepEdgeFromLogLine(line);
        if (sleeping === null) return;
        try {
          callback(sleeping);
        } catch (error) {
          logger.warn('[power] sleep-edge callback failed', { error: summarizeError(error) });
        }
      });
      return stop;
    },
  };
}
