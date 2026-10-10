/**
 * Background-process lifetime policy, how long a tracked process runs, and
 * whether its deadline is allowed to end it.
 *
 * Split out of agent-harness-background-processes.ts, which sits at the
 * architecture line ceiling, and cohesive on its own: everything here answers
 * "when does this process stop, and what do we call the way it stopped".
 */
import type { BackgroundProcess } from '@goodvibes-jev/engine/sdk/platform/tools';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { withLongLivedProcessReading, type ProcessClassificationOptions } from './agent-harness-process-classification.ts';
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

/** How a started process is treated when its timeout expires. */
export type BackgroundProcessClass = 'command' | 'long_lived';

/** Explicit declarations stay first; only omitted/invalid classes need a reading. */
export async function withBackgroundProcessClass<T>(
  args: AgentHarnessBackgroundProcessArgs,
  command: string,
  options: ProcessClassificationOptions,
  consume: (processClass: BackgroundProcessClass, assertCurrent: () => void) => T | Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const captured = snapshotJudgmentInput(args) as AgentHarnessBackgroundProcessArgs;
  const explicit = readString(captured.processClass) || readField(captured, 'processClass');
  if (explicit === 'long_lived' || explicit === 'command') {
    const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
    assertCurrent(); return await consume(explicit, assertCurrent);
  }
  return withLongLivedProcessReading(command, options, (longLived, assertCurrent) => consume(longLived ? 'long_lived' : 'command', assertCurrent));
}

/** Classify without a side effect; launching uses the same reading's live lease. */
export async function resolveBackgroundProcessClass(
  args: AgentHarnessBackgroundProcessArgs,
  command: string,
  options: ProcessClassificationOptions = {},
): Promise<BackgroundProcessClass> {
  return withBackgroundProcessClass(args, command, options, (processClass) => processClass);
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
