/**
 * A durable, on-disk record of every time this binary replaced itself.
 *
 * Self-replacement was effectively invisible. Both updaters print a line, but
 * the launch line is written to a stdout the agent's alternate screen wipes a
 * moment later, and the periodic line goes to a running session's notifications
 *, so a swap that happened thirty seconds into a run left no trace a person
 * would find afterwards except a `.previous` file whose meaning is not obvious.
 *
 * That is not only a UX gap. It silently invalidates verification: a check run
 * against a compiled binary means nothing if the binary swapped itself for a
 * published build partway through, and the way that was discovered was after
 * the fact, from the leftover file. A verifier needs to be able to ask the
 * install "were you replaced?" and get a straight answer.
 *
 * The log lives beside the executable as `<execPath>.self-update.log`, exactly
 * mirroring the `<execPath>.previous` the swap already writes. That location is
 * deliberate: it needs no home directory, no profile resolution, and no config,
 * so it works on the `--version` path that runs before any of those exist, and
 * it sits in the same directory as the evidence a person already stumbles over.
 *
 * Recording is best-effort by construction. An install directory that is not
 * writable must never turn a successful update into a failed one, the update
 * is the operation that matters, and the receipt is an observation of it.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { normalizeVersion } from './update-check.ts';

/** What caused the binary to be replaced. */
export type SelfUpdateTrigger = 'launch' | 'periodic';

export interface SelfUpdateReceipt {
  /** ISO-8601 instant the swap completed. */
  readonly at: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly trigger: SelfUpdateTrigger;
}

/**
 * Filesystem seam. Injected rather than imported so tests observe the receipt
 * without writing next to a real executable.
 */
export interface SelfUpdateReceiptIo {
  append(path: string, line: string): void;
  read(path: string): string | null;
}

export const realSelfUpdateReceiptIo: SelfUpdateReceiptIo = {
  append: (path, line) => {
    appendFileSync(path, line, 'utf-8');
  },
  read: (path) => {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  },
};

/** Where the receipt log sits for a given executable. */
export function selfUpdateLogPath(execPath: string): string {
  return `${execPath}.self-update.log`;
}

/**
 * Appends one receipt. Never throws: a swap that succeeded is still a swap that
 * succeeded, even when the directory turns out to be read-only.
 */
export function recordSelfUpdate(
  entry: {
    readonly execPath: string;
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly trigger: SelfUpdateTrigger;
    readonly now?: () => Date;
  },
  io: SelfUpdateReceiptIo = realSelfUpdateReceiptIo,
): void {
  const receipt: SelfUpdateReceipt = {
    at: (entry.now?.() ?? new Date()).toISOString(),
    fromVersion: normalizeVersion(entry.fromVersion),
    toVersion: normalizeVersion(entry.toVersion),
    trigger: entry.trigger,
  };
  try {
    io.append(selfUpdateLogPath(entry.execPath), `${JSON.stringify(receipt)}\n`);
  } catch {
    // Observation must never break the thing it observes.
  }
}

function parseReceipt(line: string): SelfUpdateReceipt | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const { at, fromVersion, toVersion, trigger } = record;
    if (typeof at !== 'string' || typeof fromVersion !== 'string' || typeof toVersion !== 'string') return null;
    if (trigger !== 'launch' && trigger !== 'periodic') return null;
    return { at, fromVersion, toVersion, trigger };
  } catch {
    return null;
  }
}

/** Every recorded replacement, oldest first. Malformed lines are skipped, not fatal. */
export function readSelfUpdateReceipts(
  execPath: string,
  io: SelfUpdateReceiptIo = realSelfUpdateReceiptIo,
): readonly SelfUpdateReceipt[] {
  const contents = io.read(selfUpdateLogPath(execPath));
  if (contents === null) return [];
  const receipts: SelfUpdateReceipt[] = [];
  for (const line of contents.split('\n')) {
    if (line.trim().length === 0) continue;
    const receipt = parseReceipt(line);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}

/** The most recent replacement, or null when this binary has never replaced itself. */
export function readLastSelfUpdate(
  execPath: string,
  io: SelfUpdateReceiptIo = realSelfUpdateReceiptIo,
): SelfUpdateReceipt | null {
  const receipts = readSelfUpdateReceipts(execPath, io);
  return receipts.length === 0 ? null : receipts[receipts.length - 1] ?? null;
}

/**
 * One plain sentence naming the replacement, for `version` output.
 *
 * It says the binary on disk is not the one that was put there, because that is
 * the fact a person checking a build needs, and names the kept previous file so
 * getting back is one command rather than a search.
 */
export function describeSelfUpdate(receipt: SelfUpdateReceipt, execPath: string): string {
  const how = receipt.trigger === 'launch' ? 'at launch' : 'while running';
  return [
    `This binary replaced itself ${how} on ${receipt.at}: v${receipt.fromVersion} -> v${receipt.toVersion}.`,
    `The build it replaced is kept at ${execPath}.previous.`,
    'Set update.autoUpdateAtLaunch to false in settings.json to stop this install from updating itself.',
  ].join('\n');
}
