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

/** Internal whole-image coordination; never merges or replays stale SQL. */
export class SQLiteStorePersistence {
  readonly path: string;
  private baseline: string | null = null;

  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.path = canonicalDatabasePath(absolute);
  }

  read(): Buffer | null {
    try {
      const info = statSync(this.path);
      // A hardlinked database has several independently replaceable names.
      // Refuse it instead of claiming one pathname lock coordinates them all.
      if (!info.isFile() || info.nlink > 1) throw new Error('SQLiteStore: unsupported coordinated file identity');
      return readFileSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
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

  /** Caller owns the lock and has constructed this image from the current file. */
  write(data: Uint8Array): void {
    const temporary = `${this.path}.pending-${process.pid}-${randomUUID()}`;
    let fd: number | undefined;
    try {
      let mode = 0o600;
      try { mode = statSync(this.path).mode & 0o777; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      fd = openSync(temporary, 'wx', mode);
      writeFileSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      this.acceptBaseline(data);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

export function imageDigest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
