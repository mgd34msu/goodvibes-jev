import { linkSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/** Atomically publish a populated writer lock and refuse contention before reading. */
export function withFileWriteLockSync<T>(path: string, write: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${lockPath}.owner-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, token: randomBytes(8).toString('hex'), acquiredAt: Date.now() }), { mode: 0o600, flag: 'wx' });
  const identity = statSync(temporary);
  try {
    linkSync(temporary, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw Object.assign(new Error('File writer lock is already owned.'), { code: 'FILE_WRITER_BUSY' });
  } finally { unlinkSync(temporary); }
  try { return write(); } finally {
    const current = statSync(lockPath);
    if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(lockPath);
  }
}
