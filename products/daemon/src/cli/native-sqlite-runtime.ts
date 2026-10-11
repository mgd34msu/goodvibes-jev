import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { VERSION } from '../version.js';

export interface DaemonSqliteRuntime {
  readonly target: 'darwin-x64' | 'darwin-arm64';
  readonly libraryPath: string;
  readonly provenancePath: string;
  readonly sqliteVersion: string;
  readonly sourceUrl: string;
  readonly sourceSha3: string;
}

export function daemonSqliteRuntime(platform: string, arch: string): DaemonSqliteRuntime | null {
  if (platform !== 'darwin') return null;
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('Unsupported Darwin native SQLite architecture');
  const target = `darwin-${arch}` as const;
  const libraryPath = `lib/sqlite-${target}/libsqlite3.dylib`;
  return Object.freeze({ target, libraryPath, provenancePath: libraryPath + '.json', sqliteVersion: '3.54.0',
    sourceUrl: 'https://www.sqlite.org/2026/sqlite-autoconf-3540000.tar.gz',
    sourceSha3: 'f5e3e724e9c9b3b5d512c76b02082091a59eeea9becd169a9fbf4d376403acce' });
}

export function assertDaemonSqliteArchitecture(bytes: Buffer, target: DaemonSqliteRuntime['target']): void {
  const cpu = target === 'darwin-x64' ? 0x01000007 : 0x0100000c;
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu
    || bytes.readUInt32LE(12) !== 6) throw new Error('Native SQLite library is not the declared Mach-O architecture');
}

export interface DaemonSqliteOwner {
  readonly schema: 1;
  readonly packageName: '@goodvibes-jev/daemon';
  readonly daemonVersion: string;
  readonly target: DaemonSqliteRuntime['target'];
  readonly sqliteVersion: string;
  readonly sourceUrl: string;
  readonly sourceSha3: string;
  readonly sha256: string;
  readonly size: number;
}

// The producer supplies this literal through Bun.define after verifying its
// actual native output. Adjacent provenance never grants byte authority.
declare const __DAEMON_NATIVE_SQLITE_OWNER__: DaemonSqliteOwner | null;

function retainedFile(path: string, cohortRoot: string): string {
  const parents: string[] = [];
  for (let current = dirname(path);;) {
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native SQLite parent is not a regular directory');
    const within = relative(cohortRoot, current);
    const selectedParent = within === '' || (!within.startsWith(`..${sep}`) && within !== '..' && !within.startsWith(sep));
    const revision = selectedParent ? `:${stat.ctimeNs}:${stat.mtimeNs}` : '';
    parents.push(`${realpathSync(current)}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}${revision}`);
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.mode & 0o7777n) !== 0o644) throw new Error('Native SQLite companion must be a regular file with mode 0644');
  return `${parents.join('|')}:${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}:${stat.uid}:${stat.gid}`;
}

function readRetainedBytes(path: string, limit: number, exact = false): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || (exact && stat.size !== limit)) throw new Error('Native SQLite companion exceeds its compiled size bound');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('Native SQLite companion changed during bounded read');
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, offset) !== 0 || fstatSync(fd).size !== stat.size) throw new Error('Native SQLite companion changed during bounded read');
    return bytes;
  } finally { closeSync(fd); }
}

export interface DaemonSqliteOptions {
  readonly platform?: string;
  readonly arch?: string;
  readonly execPath?: string;
  readonly bundled?: boolean;
  readonly version?: string;
  readonly capturedOwner?: DaemonSqliteOwner | null;
  readonly signal?: AbortSignal;
  readonly assertCurrent?: () => void;
  readonly setCustomSQLite?: (path: string) => boolean;
}

/** Run before importing any service module that can construct a database. */
export function initializeDaemonNativeSqlite(options: DaemonSqliteOptions = {}): void {
  const { platform = process.platform, arch = process.arch, execPath = process.execPath,
    bundled = import.meta.url.includes('$bunfs'), version = VERSION,
    capturedOwner = typeof __DAEMON_NATIVE_SQLITE_OWNER__ === 'undefined' ? null : __DAEMON_NATIVE_SQLITE_OWNER__, signal, assertCurrent,
    setCustomSQLite = (path: string) => (createRequire(import.meta.url)('bun:sqlite') as typeof import('bun:sqlite')).Database.setCustomSQLite(path),
  } = options;
  if (!bundled || platform !== 'darwin') return;
  const runtime = daemonSqliteRuntime(platform, arch);
  if (!runtime) throw new Error('Native SQLite runtime is undeclared');
  const expected = capturedOwner && Object.freeze({ ...capturedOwner });
  if (!expected || expected.schema !== 1 || expected.packageName !== '@goodvibes-jev/daemon'
    || expected.daemonVersion !== version || expected.target !== runtime.target
    || expected.sqliteVersion !== runtime.sqliteVersion || expected.sourceUrl !== runtime.sourceUrl || expected.sourceSha3 !== runtime.sourceSha3
    || !/^[0-9a-f]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size < 32
    || Object.keys(expected).length !== 9) throw new Error('Native SQLite compiled producer owner is absent or invalid');
  const cohortRoot = dirname(execPath);
  const libraryPath = join(cohortRoot, runtime.libraryPath);
  const provenancePath = join(cohortRoot, runtime.provenancePath);
  const libraryOwner = retainedFile(libraryPath, cohortRoot), provenanceOwner = retainedFile(provenancePath, cohortRoot);
  const bytes = readRetainedBytes(libraryPath, expected.size, true);
  const provenance: unknown = JSON.parse(readRetainedBytes(provenancePath, 16_384).toString('utf8'));
  if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error('Native SQLite library differs from the compiled producer bytes');
  }
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)
    || Object.keys(provenance).length !== Object.keys(expected).length
    || !Object.entries(expected).every(([key, value]) => Reflect.get(provenance, key) === value)) {
    throw new Error('Native SQLite companion owner or bytes differ from the declared runtime');
  }
  assertDaemonSqliteArchitecture(bytes, runtime.target);
  const current = () => {
    signal?.throwIfAborted();
    const result = assertCurrent?.();
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new Error('Native SQLite lifetime must be synchronous'); }
    if (retainedFile(libraryPath, cohortRoot) !== libraryOwner || retainedFile(provenancePath, cohortRoot) !== provenanceOwner) throw new Error('Native SQLite companion changed before database construction');
  };
  current();
  if (!setCustomSQLite(libraryPath)) throw new Error('Bun refused the retained native SQLite runtime before database construction');
  current();
}
