import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';

function canonicalDatabasePath(path: string): string {
  try { return realpathSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // realpath alone cannot distinguish an absent file from a dangling symlink.
  // Follow the latter before choosing the stable first-write lock and rename
  // destination; replacing the symlink would fork two independent stores.
  let linkTarget: string | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      linkTarget = readlinkSync(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Do not swallow a failure resolving the target and fall back to replacing
  // the original link. A missing target directory is a failed initialization.
  if (linkTarget !== undefined) return canonicalDatabasePath(resolve(dirname(path), linkTarget));
  return join(realpathSync(dirname(path)), basename(path));
}

/** Internal fault-testing seam; production always uses the native filesystem. */
export type SQLitePublicationIO = Pick<typeof import('node:fs'), 'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'unlinkSync'>;
const nativePublicationIO: SQLitePublicationIO = { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync };

/** Internal whole-image coordination; never merges or replays stale SQL. */
export class SQLiteStorePersistence {
  readonly path: string;
  private baseline: string | null = null;
  private established = false;
  private readonly absentObservation = `absent:${randomUUID()}`;

  constructor(path: string, private readonly io: SQLitePublicationIO = nativePublicationIO) {
    const absolute = resolve(path);
    ensureDurableDirectory(dirname(absolute));
    this.path = canonicalDatabasePath(absolute);
    // A symlink alias can enter another directory tree. Its containing entries
    // need their own proof; fsyncing the alias's ancestors does not cover them.
    if (dirname(this.path) !== dirname(absolute)) syncDirectoryAncestry(dirname(this.path));
  }

  read(): Buffer | null {
    try {
      const info = statSync(this.path);
      // A hardlinked database has several independently replaceable names.
      // Refuse it instead of claiming one pathname lock coordinates them all.
      if (!info.isFile() || info.nlink > 1) throw new Error('SQLiteStore: unsupported coordinated file identity');
      const data = readFileSync(this.path);
      this.established = true;
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.established) return null;
      throw error;
    }
  }

  /**
   * Whole-image publication identity, including identical-byte replacements.
   * A fresh store intentionally has no file until its first save. The supported
   * coordinated protocol never deletes a published canonical database: once
   * observed, absence is an error, not a resurrection of the initial lifetime.
   */
  observationIdentity(): string {
    try {
      const info = statSync(this.path, { bigint: true });
      if (!info.isFile() || info.nlink > 1n) throw new Error('SQLiteStore: unsupported coordinated file identity');
      this.established = true;
      return [info.dev, info.ino, info.size, info.ctimeNs, info.mtimeNs, info.birthtimeNs].join(':');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.established) return this.absentObservation;
      throw error;
    }
  }

  acceptBaseline(data: Uint8Array | null): void {
    this.baseline = data === null ? null : imageDigest(data);
  }

  async lock(): Promise<() => void> {
    return acquireCrossProcessLock(`${this.path}.knowledge-lock`, { strictOwnership: true });
  }

  /** Caller owns the lock. A stale ordinary save leaves both images intact. */
  writeIfCurrent(data: Uint8Array): void {
    const current = this.read();
    if ((current === null ? null : imageDigest(current)) !== this.baseline) {
      throw new Error('SQLiteStore: persisted state changed; pending local changes were not saved');
    }
    this.write(data);
  }

  /** Establish durability even for a no-op receipt retry after an uncertain rename. */
  confirmDurable(): void {
    if (!this.read()) return;
    const fd = this.io.openSync(this.path, 'r');
    try { this.io.fsyncSync(fd); } finally { this.safeClose(fd); }
    this.syncAncestry();
  }

  /** Caller owns the lock and has constructed this image from the current file. */
  write(data: Uint8Array): void {
    const temporary = `${this.path}.pending-${process.pid}-${randomUUID()}`;
    let fd: number | undefined;
    let renamed = false;
    try {
      let mode = 0o600;
      try { mode = statSync(this.path).mode & 0o777; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      fd = this.io.openSync(temporary, 'wx', mode);
      this.io.writeFileSync(fd, data);
      this.io.fsyncSync(fd);
      this.io.closeSync(fd);
      fd = undefined;
      this.io.renameSync(temporary, this.path);
      renamed = true;
      this.established = true;
      // Rename visibility is not durable success. Never restore older bytes if
      // this sync fails: the exact receipt retry must reconcile the new image.
      this.syncAncestry();
      this.acceptBaseline(data);
    } catch (cause) {
      throw new SQLitePublicationError(renamed ? 'indeterminate' : 'before-publication', cause);
    } finally {
      if (fd !== undefined) this.safeClose(fd);
      try { this.io.unlinkSync(temporary); } catch { /* Postpublication cleanup is not rollback. */ }
    }
  }

  private safeClose(fd: number): void { try { this.io.closeSync(fd); } catch { /* Post-sync cleanup. */ } }
  private syncAncestry(): void {
    syncDirectoryAncestry(dirname(this.path), this.io);
  }

}

export function imageDigest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export class SQLitePublicationError extends Error {
  constructor(readonly phase: 'before-publication' | 'indeterminate', cause: unknown) {
    super(`SQLiteStore: ${phase} persistence failure`, { cause });
    this.name = 'SQLitePublicationError';
  }
}

/**
 * Existing directories may be remnants of an interrupted mkdir/fsync attempt.
 * Existence never proves their parent entries durable. Reestablish every edge,
 * leaf first, through the filesystem root on acquisition, commit and replay.
 */
function syncDirectoryAncestry(path: string, io: SQLitePublicationIO = nativePublicationIO): void {
  let current = path;
  for (;;) {
    const fd = io.openSync(current, 'r');
    try { io.fsyncSync(fd); }
    finally { try { io.closeSync(fd); } catch { /* A post-sync close cannot undo durability. */ } }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function ensureDurableDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  // Always traverse existing ancestry too. An earlier attempt may have created
  // these directories and failed before synchronizing an ancestor's new entry.
  syncDirectoryAncestry(path);
}
