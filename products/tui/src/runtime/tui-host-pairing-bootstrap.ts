import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Explicit pairing bootstrap only. Never called by native credential resolution.
 * Do not create, chmod, repair or adopt another token/home on read failure.
 */
export function readTuiLegacyPairingBootstrap(home: string): string | null {
  let fd: number | undefined;
  try {
    if (!isAbsolute(home) || typeof process.geteuid !== 'function') return null;
    const uid = process.geteuid();
    for (let path = resolve(home); ; path = dirname(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0)
        || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) return null;
      if (dirname(path) === path) break;
    }
    for (const path of [resolve(home), join(home, '.goodvibes'), join(home, '.goodvibes', 'daemon')]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) return null;
    }
    const path = join(home, '.goodvibes', 'daemon', 'operator-tokens.json');
    const safe = (stat: Stats) => stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1
      && (stat.mode & 0o7777) === 0o600 && stat.size <= 16_384;
    const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs;
    const before = lstatSync(path); if (!safe(before)) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd); if (!safe(opened) || !same(before, opened)) return null;
    const bytes = new Uint8Array(16_385); let count = 0;
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
    if (count > 16_384 || !same(opened, fstatSync(fd)) || !same(opened, lstatSync(path))) return null;
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('token' in value) || typeof value.token !== 'string'
      || value.token.length < 1 || value.token.length > 4096 || /\s|[\u0000-\u001f\u007f]/u.test(value.token)) return null;
    return value.token;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
