/**
 * atomic-json-store, the two file mechanics every on-disk JSON store in this
 * platform shares, in one place.
 *
 * This module lives under `utils/` deliberately: `utils/` is the documented
 * leaf of the platform dependency graph (no intra-platform imports beyond
 * `./logger.js`, which is itself a leaf), so `config/`, `core/`, `daemon/`,
 * `mcp/`, `pairing/`, `plugins/`, `profiles/`, `providers/`, `runtime/`, and
 * `watchers/` can all import it without creating a layering edge between two
 * domains that must stay independent.
 *
 * The two mechanics:
 *
 *   1. {@link writeFileAtomic} / {@link writeJsonFileAtomic}, write to a
 *      sibling temp file in the same directory as the target (so the later
 *      rename stays on one filesystem), fsync the descriptor before closing
 *      it, chmod it to the exact requested mode (so the result does not depend
 *      on the process umask), then `renameSync` it over the target.
 *      `rename(2)` is atomic on POSIX: a concurrent reader, and a process
 *      that dies mid-write, can only ever observe the previous complete file
 *      or the new complete one, never a torn write. `durable: true` additionally
 *      confirms the published file and complete canonical/alias ancestry before
 *      returning success; the historical default retains rename-only behavior.
 *
 *      The temp name is unique per WRITE, not per process
 *      ({@link createAtomicTempPath}: `<name>.tmp-<pid>-<seq>-<random>`), and
 *      the pre-write sweep of leftovers only reaps temp files older than
 *      {@link STALE_TEMP_FILE_MIN_AGE_MS}. Both halves fix one crash: this
 *      module used to name the temp file `<name>.tmp-<pid>` and sweep every
 *      `<name>.tmp-*` it found, on the reasoning that a temp file for this
 *      store could only be a dead process's leftover. It could also be a
 *      SECOND LIVE WRITER's file, another process writing the same shared
 *      store, or the same process writing the same store from a worker
 *      thread. Writer B's sweep (or, with a shared name, writer B's rename)
 *      then deleted writer A's temp file out from under it, and writer A's
 *      next `chmodSync` died with
 *      `ENOENT: no such file or directory, chmod '…/watchers.json.tmp-905081'`
 *     , a real crash that killed a running agent. With a per-write name,
 *      writer A and writer B never share a path; with an age-gated sweep, a
 *      temp file young enough to belong to a write still in progress is left
 *      alone and only genuine crash leftovers are reclaimed.
 *
 *      There is deliberately NO in-process write lock. Every step above is a
 *      synchronous `node:fs` call with no await between them, so two writes of
 *      one store cannot interleave on one thread, and a JavaScript lock
 *      cannot span worker threads or separate processes, which is where the
 *      real concurrency lives. Ordering is settled by `rename(2)` instead:
 *      whichever writer renames last wins, whole.
 *
 *      A write that fails still throws, because most stores must not report a
 *      save that did not happen. Callers whose failure policy is genuinely
 *      log-and-continue, periodic snapshots that rebuild themselves, use
 *      {@link writeJsonFileAtomicSafe}, which logs the path and errno loudly
 *      and returns an {@link AtomicWriteOutcome} instead of throwing.
 *
 *   2. {@link readJsonFileOrQuarantine}, a file this reader cannot trust
 *      (unparseable JSON, a torn or zero-tailed write, the wrong shape) is
 *      moved aside to `<name>.corrupt-<ISO>-<8char>` with a sibling `.why`
 *      receipt, logged loudly at error level, and reported to the caller as
 *      the ordinary "absent" answer (`null`) so the caller rebuilds instead of
 *      crashing. The original file is never deleted and never overwritten,
 *      only renamed, so the evidence survives for inspection. Quarantine
 *      files are bounded at {@link CORRUPT_QUARANTINE_MAX_FILES} per store,
 *      oldest reaped first, and the reap is disclosed in the newest receipt.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path';
import type { Stats } from 'node:fs';
import { logger } from './logger.js';

/**
 * Hard ceiling on `.corrupt-*` files kept per store directory, oldest reaped
 * first. A flapping writer that corrupts its file on every boot must not be
 * allowed to fill the disk with forensic copies, "a handful" is enough to
 * look at what went wrong without becoming a leak.
 */
export const CORRUPT_QUARANTINE_MAX_FILES = 5;

/**
 * How old a `<name>.tmp-*` file must be before the pre-write sweep will delete
 * it.
 *
 * The sweep cannot tell a crash leftover from another writer's work in
 * progress by name alone, so it uses age: a temp file written within the last
 * minute may still belong to a live write (another process, or this one on a
 * worker thread) and is left strictly alone. One minute is far longer than any
 * store here takes to serialize, open, write, fsync, chmod and rename, a few
 * hundred kilobytes of JSON at most, so a leftover from a process that really
 * did die becomes eligible on the next write a minute later, while a live
 * writer is never robbed of its temp file.
 */
export const STALE_TEMP_FILE_MIN_AGE_MS = 60_000;

/** Default mode for a store file: owner read/write only. */
const DEFAULT_STORE_FILE_MODE = 0o600;

/**
 * Per-process counter that makes each temp name unique within this process
 * even when two writes land in the same millisecond.
 */
let atomicTempSequence = 0;

/**
 * Build the temp path for one atomic write of `filePath`.
 *
 * Unique per call, never per process: `<name>.tmp-<pid>-<seq>-<random>`. The
 * pid and sequence are there so a leftover file names the process and the
 * write that produced it when someone goes looking; the random suffix is what
 * guarantees two writers never collide even across pid reuse.
 *
 * Exported so a test can hold a second writer's temp file the way a real
 * concurrent writer does, and assert the sweep leaves it alone.
 */
export function createAtomicTempPath(filePath: string): string {
  atomicTempSequence += 1;
  return `${filePath}.tmp-${process.pid}-${atomicTempSequence.toString(36)}-${randomUUID().slice(0, 8)}`;
}

export interface AtomicWriteOptions {
  /**
   * Exact mode of the resulting file. Applied with an explicit `chmod` before
   * the rename, so the result does not vary with the process umask.
   * Defaults to `0o600`.
   */
  readonly mode?: number;
  /** Opt in to file + complete pathname-ancestry durability before success. */
  readonly durable?: boolean;
  /** Omit opportunistic deletion of other writes' stale temp files for a bounded effect. */
  readonly cleanupStaleTemps?: boolean;
}

export interface AtomicJsonWriteOptions extends AtomicWriteOptions {
  /** `JSON.stringify` indent. `null` writes compact JSON. Defaults to `2`. */
  readonly indent?: number | null;
  /** Append a trailing newline to the serialized JSON. Defaults to `true`. */
  readonly trailingNewline?: boolean;
}

export type AtomicWriteDurabilityPhase = 'before-publication' | 'published-indeterminate';

/** A failed post-rename confirmation is uncertainty, never proof of rollback. */
export class AtomicWriteDurabilityError extends Error {
  readonly code = 'ATOMIC_WRITE_DURABILITY_FAILED';
  constructor(readonly filePath: string, readonly phase: AtomicWriteDurabilityPhase, cause: unknown) {
    super(`Atomic file durability failed (${phase}): ${filePath}`, { cause });
    this.name = 'AtomicWriteDurabilityError';
  }
}

interface DurablePathEntry { readonly path: string; readonly identity: Stats; }
interface DurablePathLink extends DurablePathEntry { readonly target: string; }
function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a: Stats, b: Stats): boolean {
  return sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/**
 * Trace actual lookup, including symlink chains and their parent directories.
 * realpath + lexical ancestors alone misses an intermediate symlink's parent.
 * Keep `..` until after symlinks resolve, exactly as filesystem lookup does.
 */
function traceDurablePath(filePath: string): {
  readonly canonical: string; readonly file: Stats;
  readonly directories: readonly DurablePathEntry[]; readonly links: readonly DurablePathLink[];
} {
  const canonical = realpathSync(filePath);
  const absolute = isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`;
  let cursor = parse(absolute).root;
  let pending = absolute.slice(cursor.length).split(sep);
  const directories = new Map<string, DurablePathEntry>();
  const links: DurablePathLink[] = [];
  const rememberDirectory = (path: string) => {
    const identity = lstatSync(path);
    if (!identity.isDirectory()) throw new Error('Durable path ancestor is not a directory');
    directories.set(path, { path, identity });
  };
  rememberDirectory(cursor);
  while (pending.length > 0) {
    const component = pending.shift()!;
    if (!component || component === '.') continue;
    if (component === '..') { cursor = dirname(cursor); rememberDirectory(cursor); continue; }
    const path = join(cursor, component);
    const identity = lstatSync(path);
    if (identity.isSymbolicLink()) {
      if (links.length >= 40) throw new Error('Durable path has too many symbolic links');
      const target = readlinkSync(path);
      links.push({ path, identity, target });
      if (isAbsolute(target)) { cursor = parse(target).root; rememberDirectory(cursor); }
      pending = [...target.slice(isAbsolute(target) ? parse(target).root.length : 0).split(sep), ...pending];
      continue;
    }
    cursor = path;
    if (identity.isDirectory()) rememberDirectory(cursor);
  }
  if (cursor !== canonical) throw new Error('Durable path changed during resolution');
  const file = lstatSync(canonical);
  if (!file.isFile()) throw new Error('Durable publication is not a regular file');
  return { canonical, file, directories: [...directories.values()], links };
}

/**
 * Establish durability of already-visible bytes, including newly created
 * ancestors and every symlink/alias ancestry. Call under the store's owner
 * lock; this helper supplies durability, not cross-writer serialization.
 * A read/restart can use this to recover an indeterminate publication. Failures
 * never remove, restore, quarantine or rewrite the published file.
 */
export function confirmFileDurable(filePath: string): void {
  try {
    const path = traceDurablePath(filePath);
    const fd = openSync(path.canonical, 'r');
    try {
      if (!sameFile(fstatSync(fd), path.file)) throw new Error('Durable file changed before confirmation');
      fsyncSync(fd);
      // Reverse lookup order preserves descendant-before-ancestor ordering,
      // including branches traversed by a chain of symlinks.
      for (const directory of [...path.directories].reverse()) {
        const dirFd = openSync(directory.path, 'r');
        try {
          if (!sameInode(fstatSync(dirFd), directory.identity)) throw new Error('Durable ancestor changed');
          fsyncSync(dirFd);
        } finally { closeSync(dirFd); }
      }
      if (realpathSync(filePath) !== path.canonical || !sameFile(fstatSync(fd), path.file)
        || !sameFile(statSync(filePath), path.file)) throw new Error('Durable file changed during confirmation');
      for (const directory of path.directories) {
        if (!sameInode(lstatSync(directory.path), directory.identity)) throw new Error('Durable ancestor changed');
      }
      for (const link of path.links) {
        if (!sameInode(lstatSync(link.path), link.identity) || readlinkSync(link.path) !== link.target) {
          throw new Error('Durable alias changed during confirmation');
        }
      }
    } finally { closeSync(fd); }
  } catch (error) {
    throw new AtomicWriteDurabilityError(filePath, 'published-indeterminate', error);
  }
}

/**
 * Write `contents` to `filePath` atomically, creating parent directories as
 * needed. See the module docstring for the mechanics and why they matter.
 */
export function writeFileAtomic(filePath: string, contents: string, options: AtomicWriteOptions = {}): void {
  const mode = options.mode ?? DEFAULT_STORE_FILE_MODE;
  const dir = dirname(filePath);
  let tmpPath: string | undefined;
  let published = false;
  try {
    mkdirSync(dir, { recursive: true });
    if (options.cleanupStaleTemps !== false) cleanupStaleTempFiles(dir, filePath);
    tmpPath = createAtomicTempPath(filePath);
    const fd = openSync(tmpPath, 'w', mode);
    try {
      const written = writeSync(fd, contents, null, 'utf-8');
      if (written !== Buffer.byteLength(contents, 'utf-8')) {
        throw new Error('Incomplete atomic file write');
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, filePath);
    published = true;
    if (options.durable === true) confirmFileDurable(filePath);
  } catch (error) {
    if (tmpPath !== undefined && !published) {
      try { unlinkSync(tmpPath); }
      catch { /* Best-effort temp cleanup; never restore the previous image. */ }
    }
    if (options.durable === true) {
      if (error instanceof AtomicWriteDurabilityError) throw error;
      throw new AtomicWriteDurabilityError(filePath, published ? 'published-indeterminate' : 'before-publication', error);
    }
    throw error;
  }
}

/** Serialize `value` as JSON and write it atomically via {@link writeFileAtomic}. */
export function writeJsonFileAtomic(filePath: string, value: unknown, options: AtomicJsonWriteOptions = {}): void {
  try {
    const indent = options.indent === undefined ? 2 : options.indent;
    const trailingNewline = options.trailingNewline ?? true;
    const serialized = indent === null ? JSON.stringify(value) : JSON.stringify(value, null, indent);
    writeFileAtomic(filePath, trailingNewline ? `${serialized}\n` : serialized, options);
  } catch (error) {
    if (options.durable === true && !(error instanceof AtomicWriteDurabilityError)) {
      throw new AtomicWriteDurabilityError(filePath, 'before-publication', error);
    }
    throw error;
  }
}

export interface AtomicJsonSafeWriteOptions extends AtomicJsonWriteOptions {
  /**
   * Short store name for the failure log, e.g. `'watchers/store'`. Rendered as
   * `[<label>]`. Defaults to `'atomic-json-store'`.
   */
  readonly label?: string;
}

/** What {@link writeJsonFileAtomicSafe} reports back instead of throwing. */
export interface AtomicWriteOutcome {
  /** True when the bytes are on disk under `filePath`. */
  readonly ok: boolean;
  /** The store file the write targeted. */
  readonly filePath: string;
  /** The failure, when `ok` is false. */
  readonly error?: Error;
  /** The errno string when the failure carried one, e.g. `'ENOENT'`, `'ENOSPC'`. */
  readonly code?: string;
  /** The failing syscall when the failure named one, e.g. `'chmod'`, `'rename'`. */
  readonly syscall?: string;
}

/** Pull the errno fields off a thrown filesystem error without asserting a shape it may not have. */
function describeWriteFailure(error: unknown): { code?: string; syscall?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const fields = error as { code?: unknown; syscall?: unknown };
  return {
    ...(typeof fields.code === 'string' ? { code: fields.code } : {}),
    ...(typeof fields.syscall === 'string' ? { syscall: fields.syscall } : {}),
  };
}

/**
 * {@link writeJsonFileAtomic} for callers whose failure policy is
 * log-and-continue: the failure is logged at error level with the store path,
 * the errno and the failing syscall, and returned as an
 * {@link AtomicWriteOutcome} rather than thrown.
 *
 * This exists because a periodic snapshot must never be able to kill its host.
 * A watcher-store write that failed inside a fleet tick propagated out of a
 * timer callback with nothing above it to catch it, and the whole agent
 * process died, from a store whose entire recovery story is "it rebuilds from
 * live registrations on the next load". Stores where a silent failure would be
 * a lie (settings, secrets, pairing tokens, anything a user just asked to
 * save) keep using {@link writeJsonFileAtomic} and keep throwing.
 */
export function writeJsonFileAtomicSafe(
  filePath: string,
  value: unknown,
  options: AtomicJsonSafeWriteOptions = {},
): AtomicWriteOutcome {
  const { label = 'atomic-json-store', ...writeOptions } = options;
  try {
    writeJsonFileAtomic(filePath, value, writeOptions);
    return { ok: true, filePath };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const { code, syscall } = describeWriteFailure(error);
    logger.error(`[${label}] could not persist the store file; the in-memory state stands and the next write retries`, {
      filePath,
      ...(code !== undefined ? { code } : {}),
      ...(syscall !== undefined ? { syscall } : {}),
      error: failure.message,
    });
    return {
      ok: false,
      filePath,
      error: failure,
      ...(code !== undefined ? { code } : {}),
      ...(syscall !== undefined ? { syscall } : {}),
    };
  }
}

export interface QuarantineLoadOptions<T> {
  /**
   * Short store name used in the log line and the `.why` receipt, e.g.
   * `'config/secrets'`. Rendered as `[<label>]` in logs.
   */
  readonly label: string;
  /**
   * Narrow the parsed JSON to the store's shape. Throw with a human-readable
   * reason when the content cannot be trusted, that reason is what lands in
   * the `.why` receipt and the error log.
   */
  readonly validate: (parsed: unknown) => T;
  /**
   * One sentence for the `.why` receipt describing what happens now that the
   * file is gone, i.e. how this store rebuilds. Written for a human reading
   * the receipt months later with no other context.
   */
  readonly recovery: string;
}

/**
 * Read and parse a JSON store file, never throwing on corrupt content.
 *
 * Returns `null` both when the file does not exist and when it existed but
 * could not be trusted, in the latter case the file is quarantined first (see
 * the module docstring). Callers treat `null` as "no store yet" and rebuild.
 *
 * A read failure (permissions, the file vanishing between the exists check and
 * the read) is deliberately NOT caught: there is no content to move aside, so
 * quarantine has nothing to do and the error propagates to the caller.
 */
export function readJsonFileOrQuarantine<T>(filePath: string, options: QuarantineLoadOptions<T>): T | null {
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');

  try {
    return options.validate(JSON.parse(raw) as unknown);
  } catch (error) {
    quarantineCorruptFile(filePath, {
      label: options.label,
      reason: error instanceof Error ? error.message : String(error),
      recovery: options.recovery,
    });
    return null;
  }
}

export interface QuarantineOptions {
  /** Short store name, e.g. `'config/secrets'`. */
  readonly label: string;
  /** Why the file could not be trusted. */
  readonly reason: string;
  /** What happens now that the file is gone, for the `.why` receipt. */
  readonly recovery: string;
}

/**
 * Move a corrupt store file aside, write a `.why` receipt beside it, log the
 * event loudly, and reap old quarantine files past the bound.
 *
 * Exported for stores that parse in stages and decide for themselves which
 * stage counts as container corruption (`config/secrets.ts` quarantines an
 * unreadable JSON envelope but must never quarantine a decrypt failure, which
 * means the file is intact and the key is wrong).
 */
export function quarantineCorruptFile(filePath: string, options: QuarantineOptions): void {
  const { label, reason, recovery } = options;
  const dir = dirname(filePath);
  const base = basename(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantinePath = join(dir, `${base}.corrupt-${timestamp}-${randomUUID().slice(0, 8)}`);
  const whyPath = `${quarantinePath}.why`;

  let moved = false;
  try {
    renameSync(filePath, quarantinePath);
    moved = true;
  } catch (renameError) {
    logger.error(`[${label}] could not move a corrupt store file aside; leaving it in place`, {
      filePath,
      reason,
      renameError: renameError instanceof Error ? renameError.message : String(renameError),
    });
  }

  // The just-quarantined file is excluded from reaping by name: its .why is
  // written only after the reap, so on a filesystem with coarse mtimes an
  // all-tie sort could otherwise pick it as the "oldest" victim and leave the
  // receipt written below orphaned, the exact failure a matrix runner caught.
  const reapResult = moved
    ? reapCorruptQuarantineFiles(dir, base, basename(quarantinePath))
    : { scanned: 0, reaped: 0 };

  if (moved) {
    const whyLines = [
      `The ${label} store file at ${filePath} failed to load: ${reason}.`,
      `The corrupt file was moved to ${basename(quarantinePath)} for inspection and is never parsed again.`,
      recovery,
      reapResult.reaped > 0
        ? `${reapResult.reaped} older quarantined file(s) beyond the ${CORRUPT_QUARANTINE_MAX_FILES}-file bound were deleted (oldest first) to keep this quarantine from growing without limit.`
        : null,
    ].filter((line): line is string => line !== null);
    try {
      writeFileSync(whyPath, `${whyLines.join('\n')}\n`, 'utf-8');
    } catch (whyError) {
      logger.error(`[${label}] could not write the .why receipt beside a quarantined store file`, {
        whyPath,
        whyError: whyError instanceof Error ? whyError.message : String(whyError),
      });
    }
  }

  logger.error(`[${label}] store file was corrupt and has been quarantined; ${recovery}, ${reason}`, {
    filePath,
    quarantinePath: moved ? quarantinePath : undefined,
    reaped: reapResult.reaped,
  });
}

/**
 * Remove `<basename>.tmp-*` files beside `filePath` that are old enough to be
 * crash leftovers, and only those.
 *
 * Age is the only signal available: the name says which process and which
 * write produced a temp file, but not whether that write is still running. A
 * temp file modified within {@link STALE_TEMP_FILE_MIN_AGE_MS} may belong to a
 * write in progress in another process, or in this one, on a worker thread,
 * and deleting it makes that writer's own `chmod` or `rename` fail with
 * ENOENT. That is exactly how a live agent process died, so the young ones are
 * left strictly alone here; the next write a minute later reclaims anything
 * that really was abandoned.
 *
 * A temp file whose age cannot be read at all (it vanished between the
 * directory listing and the stat, or its metadata is unreadable) is skipped
 * for the same reason: an unknown age is not evidence of abandonment.
 */
function cleanupStaleTempFiles(dir: string, filePath: string): void {
  const prefix = `${basename(filePath)}.tmp-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const staleBefore = Date.now() - STALE_TEMP_FILE_MIN_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const stalePath = join(dir, name);
    let modifiedAtMs: number;
    try {
      modifiedAtMs = statSync(stalePath).mtimeMs;
    } catch {
      continue;
    }
    if (modifiedAtMs > staleBefore) continue;
    try {
      unlinkSync(stalePath);
      logger.warn('[atomic-json-store] removed a stale temp file left by a previous crash', {
        filePath,
        stalePath,
        ageMs: Math.max(0, Date.now() - modifiedAtMs),
      });
    } catch {
      // Best-effort, a concurrent writer or a permissions issue must not
      // block this save.
    }
  }
}

/**
 * Delete `.corrupt-*` files (and their `.why` receipts) beyond
 * {@link CORRUPT_QUARANTINE_MAX_FILES}, oldest first. Runs after every new
 * quarantine so a repeatedly-corrupting writer cannot accumulate files without
 * bound.
 */
function reapCorruptQuarantineFiles(
  dir: string,
  base: string,
  /** The quarantine file created by the caller in this same pass, never a victim. */
  currentName?: string,
): { scanned: number; reaped: number } {
  const prefix = `${base}.corrupt-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { scanned: 0, reaped: 0 };
  }

  const quarantineNames = new Set(names.filter((name) => name.startsWith(prefix) && !name.endsWith('.why')));

  // Self-heal: a .why with no surviving quarantine file discloses nothing and
  // keeps nothing, delete it, whatever past interruption produced it.
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.why')) continue;
    if (!quarantineNames.has(name.slice(0, -'.why'.length))) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // Best-effort.
      }
    }
  }

  const corruptFiles = [...quarantineNames]
    .filter((name) => name !== currentName)
    .map((name) => {
      const full = join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { full, name, mtimeMs };
    });

  // The cap counts every quarantine file including the current one; only the
  // older ones are eligible victims.
  const cap = currentName !== undefined && quarantineNames.has(currentName)
    ? CORRUPT_QUARANTINE_MAX_FILES - 1
    : CORRUPT_QUARANTINE_MAX_FILES;

  let reaped = 0;
  if (corruptFiles.length > cap) {
    // Oldest first; mtime ties (coarse-mtime filesystems) break by the
    // millisecond timestamp baked into the quarantine name, so the order is
    // total and matches creation order.
    corruptFiles.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.name.localeCompare(b.name));
    const excess = corruptFiles.length - cap;
    for (const victim of corruptFiles.slice(0, excess)) {
      try {
        unlinkSync(victim.full);
        reaped += 1;
      } catch {
        // Best-effort, a file another sweeper already removed counts as reclaimed.
      }
      try {
        unlinkSync(`${victim.full}.why`);
      } catch {
        // The receipt may not exist (an earlier write failure), not an error.
      }
    }
  }

  return { scanned: quarantineNames.size, reaped };
}
