/**
 * store-file.ts, the single writer every on-disk JSON store in this repo goes
 * through.
 *
 * Every store here is a shared write target: the agent process and a one-shot
 * `goodvibes ...` CLI invocation construct the same registry class over the
 * same path, so two OS processes can be mid-write on one file at once. That
 * sharing is not removable (the store IS the canonical record both processes
 * read), so it has to be serialized structurally instead, and the structure is
 * this module: nobody hand-rolls a temp path.
 *
 * Two separate hazards, two separate mechanisms:
 *
 * 1. TORN FILES, handled by {@link writeStoreFile}. A fixed `${path}.tmp` temp
 *    name shared by every writer would let whichever writer renames second
 *    promote a file holding interleaved bytes from two writers, and the next
 *    read would then fail to parse: the store's whole history gone, not just
 *    the record being written. The write step now delegates to the sdk's
 *    `atomicWriteFileSync` (`@goodvibes-jev/engine/sdk/platform/config`), which
 *    picks a temp name no two writes anywhere can share (pid, timestamp, and a
 *    random id) and renames it onto the final path; `rename` is atomic on
 *    POSIX, so a reader sees either the whole previous file or the whole new
 *    one. The sdk primitive also fsyncs the temp file and the parent directory
 *    before returning, which this module's own hand-rolled version did not do:
 *    a strictly stronger durability guarantee than before, kept as-is. One
 *    deliberate behavior change: the sdk primitive defaults new files to mode
 *    0o600 (owner read/write only) where the old hand-rolled write left
 *    whatever the process umask produced (typically 0o644, group/other
 *    readable). Every store here is local per-user state, some of it holding
 *    personal data (notes, calendar, personas), so the tighter default is
 *    accepted rather than overridden: nothing in this repo reads a store file
 *    as a different OS user.
 *
 * 2. LOST UPDATES inside one process, handled by {@link runStoreFileUpdate}.
 *    A read-modify-write cycle written as straight-line synchronous code
 *    (`readStore(); mutate; writeStore()`) cannot be interleaved at all: the
 *    event loop gets no turn between the read and the rename, so the cycle is
 *    already serialized by construction and needs no lock. That is why the
 *    synchronous registries below call {@link writeStoreFile} directly. A
 *    cycle that spans an `await` has no such protection: two overlapping
 *    callers both read the old file and the second rename discards the first
 *    caller's change. Those cycles queue on {@link runStoreFileUpdate}, which
 *    keys the queue on the resolved store path rather than on an owning
 *    object, so two registry instances over one file still take turns.
 *
 * Neither mechanism serializes read-modify-write ACROSS processes; only the
 * torn-file half of that is fixed here. Making the CLI and the agent take
 * turns on a whole cycle needs an out-of-process lock, which nothing in this
 * repo has yet.
 *
 * `scripts/check-architecture.ts`'s `no-hand-rolled-store-temp-writes` rule
 * fails the build on any `${...}.tmp` temp path built outside this file, so
 * the pattern cannot come back by copy-paste. The sdk primitive builds its own
 * temp path internally (inside the sdk package, not here), so this rule still
 * has nothing of that shape left to catch in this file.
 */

import { atomicWriteFileSync } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Atomic single-file writes
// ---------------------------------------------------------------------------

/**
 * Write `contents` to `path` through the sdk's atomic-write primitive
 * (private temp file, fsync, then rename), creating the parent directory if
 * needed. A failed write leaves `path` holding its previous contents; the sdk
 * primitive removes its own temp file on failure.
 */
export function writeStoreFile(path: string, contents: string): void {
  atomicWriteFileSync(path, contents, { mkdirp: true });
}

/** {@link writeStoreFile} for the pretty-printed-JSON-plus-newline shape most stores use. */
export function writeStoreJson(path: string, data: unknown): void {
  writeStoreFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Serializing read-modify-write cycles that span an await
// ---------------------------------------------------------------------------

/**
 * One promise chain per store path, holding the tail of that path's queue.
 *
 * Keyed by resolved path, not by the object that happens to own the store, so
 * two registry instances built over one file serialize against each other.
 * Entries are dropped once a path's queue drains, so a long-lived process that
 * touches many stores does not accumulate them.
 */
const updateQueues = new Map<string, Promise<unknown>>();

/**
 * Run `update` once every previously queued update for `path` has settled.
 *
 * Chains onto the queue regardless of whether earlier updates resolved or
 * rejected, so a failed update never wedges the ones behind it, and returns
 * `update`'s own result or rejection to its caller.
 */
export function runStoreFileUpdate<T>(path: string, update: () => Promise<T> | T): Promise<T> {
  const key = resolve(path);
  const previous = updateQueues.get(key) ?? Promise.resolve();
  const run = previous.then(update, update);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  updateQueues.set(key, tail);
  void tail.then(() => {
    // Only the tail may clear the entry; a later enqueue has already replaced it.
    if (updateQueues.get(key) === tail) updateQueues.delete(key);
  });
  return run;
}
