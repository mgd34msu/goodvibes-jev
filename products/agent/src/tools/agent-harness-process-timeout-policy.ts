/**
 * Background-process lifetime policy, how long a tracked process runs, and
 * whether its deadline is allowed to end it.
 *
 * Split out of agent-harness-background-processes.ts, which sits at the
 * architecture line ceiling, and cohesive on its own: everything here answers
 * "when does this process stop, and what do we call the way it stopped".
 */
import type { BackgroundProcess } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { AgentHarnessBackgroundProcessArgs } from './agent-harness-background-processes-types.ts';

export const DEFAULT_BACKGROUND_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_BACKGROUND_TIMEOUT_MS = 8 * 60 * 60 * 1000;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function fieldMap(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

function readField(args: AgentHarnessBackgroundProcessArgs, id: string): string {
  return fieldMap(args.fields)[id] ?? '';
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

export function clampTimeout(value: unknown, fallback: number): number {
  return Math.max(1_000, Math.min(MAX_BACKGROUND_TIMEOUT_MS, readNumber(value, fallback)));
}

/**
 * Commands that launch something the user interacts with, or a server meant to
 * outlive the call that started it. Matched on the leading program name, so an
 * argument that merely mentions a browser does not reclassify the command.
 */
const LONG_LIVED_PROGRAMS = new Set([
  'brave', 'brave-browser', 'chrome', 'chromium', 'chromium-browser', 'firefox',
  'google-chrome', 'microsoft-edge', 'msedge', 'opera', 'safari', 'vivaldi',
  'code', 'codium', 'emacs', 'gedit', 'gimp', 'gvim', 'kate', 'nautilus',
  'thunar', 'xdg-open', 'open', 'gnome-open', 'kde-open',
]);

/** How a started process is treated when its timeout expires. */
export type BackgroundProcessClass = 'command' | 'long_lived';

/**
 * Classifies a command for timeout purposes.
 *
 * `terminal` is documented as "start visible tracked background shell
 * commands", and its `timeoutMs` used to SIGKILL whatever it had started. A
 * routine 120s value therefore destroyed a running browser, a user-facing
 * application torn down as the ordinary outcome of a normal parameter. A
 * long-lived process now keeps running past its deadline unless the caller
 * explicitly opts in to being killed.
 */
export function resolveBackgroundProcessClass(
  args: AgentHarnessBackgroundProcessArgs,
  command: string,
): BackgroundProcessClass {
  const explicit = readString(args.processClass) || readField(args, 'processClass');
  if (explicit === 'long_lived' || explicit === 'command') return explicit;

  const program = command
    .trim()
    .split(/\s+/)[0]
    ?.split('/')
    .pop()
    ?.toLowerCase() ?? '';
  return LONG_LIVED_PROGRAMS.has(program) ? 'long_lived' : 'command';
}

/**
 * Whether the timeout watchdog may terminate this process. Explicit
 * `killOnTimeout` always wins; otherwise only ordinary commands are killable.
 */
export function resolveKillOnTimeout(
  args: AgentHarnessBackgroundProcessArgs,
  processClass: BackgroundProcessClass,
): boolean {
  const explicit = args.killOnTimeout ?? readField(args, 'killOnTimeout');
  if (typeof explicit === 'boolean') return explicit;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return processClass === 'command';
}

export function processStatus(entry: BackgroundProcess): 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' {
  if (!entry.done) return 'running';
  if (entry.exitCode === 0) return 'succeeded';
  // A signal-terminated process reports exitCode null, which used to read as an
  // ordinary cancellation whether the caller stopped it or the timeout watchdog
  // did. `timedOut` is the difference, and it was never surfaced.
  if (entry.timedOut === true) return 'timed_out';
  if (entry.exitCode === null) return 'cancelled';
  return 'failed';
}

export function processAgeMs(entry: BackgroundProcess, now = Date.now()): number {
  return Math.max(0, (entry.completedAt ?? now) - entry.startTime);
}
