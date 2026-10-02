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

  constructor(path: string, private readonly io: SQLitePublicationIO = nativePublicationIO) {
    const absolute = resolve(path);
    ensureDurableDirectory(dirname(absolute));
    this.path = canonicalDatabasePath(absolute);
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
    this.syncParent();
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
      this.syncParent();
      this.acceptBaseline(data);
    } catch (cause) {
      throw new SQLitePublicationError(renamed ? 'indeterminate' : 'before-publication', cause);
    } finally {
      if (fd !== undefined) this.safeClose(fd);
      try { this.io.unlinkSync(temporary); } catch { /* Postpublication cleanup is not rollback. */ }
    }
  }

  private safeClose(fd: number): void { try { this.io.closeSync(fd); } catch { /* Post-sync cleanup. */ } }
  private syncParent(): void {
    const fd = this.io.openSync(dirname(this.path), 'r');
    try { this.io.fsyncSync(fd); } finally { this.safeClose(fd); }
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

function safeClose(fd: number): void { try { closeSync(fd); } catch { /* Descriptor cleanup cannot undo fsync. */ } }
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { safeClose(fd); }
}
function ensureDurableDirectory(path: string): void {
  try { if (statSync(path).isDirectory()) return; throw new Error('SQLiteStore: parent is not a directory'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = dirname(path);
  ensureDurableDirectory(parent);
  try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  syncDirectory(path);
  syncDirectory(parent);
}
