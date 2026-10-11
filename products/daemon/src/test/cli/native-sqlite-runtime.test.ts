import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { daemonSqliteRuntime, initializeDaemonNativeSqlite, type DaemonSqliteOwner } from '../../cli/native-sqlite-runtime.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(arch: 'x64' | 'arm64' = 'arm64') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-sqlite-owner-')); roots.push(root);
  const cohort = join(root, 'cohort'); mkdirSync(cohort);
  const execPath = join(cohort, 'goodvibes-daemon'); writeFileSync(execPath, 'inert test executable', { mode: 0o755 });
  const runtime = daemonSqliteRuntime('darwin', arch); if (!runtime) throw new Error('Missing fixture declaration');
  const library = join(cohort, runtime.libraryPath), provenance = join(cohort, runtime.provenancePath);
  mkdirSync(dirname(library), { recursive: true });
  const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4); bytes.writeUInt32LE(6, 12);
  const owner: DaemonSqliteOwner = Object.freeze({ schema: 1, packageName: '@goodvibes-jev/daemon', daemonVersion: '2.0.23', target: runtime.target,
    sqliteVersion: runtime.sqliteVersion, sourceUrl: runtime.sourceUrl, sourceSha3: runtime.sourceSha3,
    sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  writeFileSync(library, bytes, { mode: 0o644 }); writeFileSync(provenance, JSON.stringify(owner), { mode: 0o644 });
  const options = { platform: 'darwin', arch, bundled: true, version: owner.daemonVersion, execPath, capturedOwner: owner };
  return { root, cohort, library, provenance, bytes, owner, options };
}

test('selects each declared architecture after captured owner, bytes and metadata match', () => {
  for (const arch of ['x64', 'arm64'] as const) {
    const f = fixture(arch); const events: string[] = [];
    initializeDaemonNativeSqlite({ ...f.options, assertCurrent: () => { events.push('current'); }, setCustomSQLite: path => { expect(path).toBe(f.library); events.push('select'); return true; } });
    expect(events).toEqual(['current', 'select', 'current']);
  }
});

test('unbundled source and Linux do not select custom SQLite', () => {
  const f = fixture(); let calls = 0; const setCustomSQLite = () => { calls++; return true; };
  initializeDaemonNativeSqlite({ ...f.options, bundled: false, setCustomSQLite });
  initializeDaemonNativeSqlite({ ...f.options, platform: 'linux', setCustomSQLite });
  expect(calls).toBe(0);
});

test('retired target or absent compiled owner refuses before selection', () => {
  const f = fixture(); let calls = 0; const setCustomSQLite = () => { calls++; return true; };
  expect(() => initializeDaemonNativeSqlite({ ...f.options, arch: 'riscv64', setCustomSQLite })).toThrow('Unsupported');
  expect(() => initializeDaemonNativeSqlite({ ...f.options, capturedOwner: null, setCustomSQLite })).toThrow('compiled producer');
  expect(calls).toBe(0);
});

test('coherently replaced library and mutable sidecar cannot replace compiled byte authority', () => {
  const f = fixture(); const foreign = Buffer.from(f.bytes); foreign[40] = 1;
  writeFileSync(f.library, foreign); writeFileSync(f.provenance, JSON.stringify({ ...f.owner, sha256: createHash('sha256').update(foreign).digest('hex') }));
  let calls = 0;
  expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => { calls++; return true; } })).toThrow('compiled producer bytes');
  expect(calls).toBe(0);
});

test('supplier, daemon owner and architecture mismatches refuse before selection', () => {
  const f = fixture(); let calls = 0; const setCustomSQLite = () => { calls++; return true; };
  expect(() => initializeDaemonNativeSqlite({ ...f.options, capturedOwner: { ...f.owner, sourceSha3: '0'.repeat(64) }, setCustomSQLite })).toThrow('compiled producer');
  expect(() => initializeDaemonNativeSqlite({ ...f.options, version: '2.0.24', setCustomSQLite })).toThrow('compiled producer');
  const wrong = Buffer.from(f.bytes); wrong.writeUInt32LE(0x01000007, 4);
  const wrongOwner: DaemonSqliteOwner = { ...f.owner, sha256: createHash('sha256').update(wrong).digest('hex') };
  writeFileSync(f.library, wrong); writeFileSync(f.provenance, JSON.stringify(wrongOwner));
  expect(() => initializeDaemonNativeSqlite({ ...f.options, capturedOwner: wrongOwner, setCustomSQLite })).toThrow('Mach-O architecture');
  expect(calls).toBe(0);
});

test('missing member, mode, symlink and sidecar owner changes refuse before selection', () => {
  for (const kind of ['missing', 'mode', 'symlink', 'owner'] as const) {
    const f = fixture(); let calls = 0;
    if (kind === 'missing') rmSync(f.library);
    if (kind === 'mode') chmodSync(f.library, 0o600);
    if (kind === 'symlink') { const foreign = join(f.root, 'foreign'); writeFileSync(foreign, f.bytes); rmSync(f.library); symlinkSync(foreign, f.library); }
    if (kind === 'owner') writeFileSync(f.provenance, JSON.stringify({ ...f.owner, daemonVersion: '2.0.24' }));
    expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => { calls++; return true; } })).toThrow();
    expect(calls).toBe(0);
  }
});

test('oversized library and provenance refuse before reading or selecting', () => {
  for (const member of ['library', 'provenance'] as const) {
    const f = fixture(); let calls = 0;
    writeFileSync(f[member], Buffer.alloc(member === 'library' ? f.owner.size + 1 : 16_385));
    expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => { calls++; return true; } })).toThrow('size bound');
    expect(calls).toBe(0);
  }
});

test('selected parent rename and restore during selection is detected', () => {
  const f = fixture();
  expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => {
    const retired = f.cohort + '.retired'; renameSync(f.cohort, retired); renameSync(retired, f.cohort); return true;
  } })).toThrow('changed before database construction');
});

test('equal-byte foreign inode substitution during selection refuses', () => {
  const f = fixture();
  expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => {
    const replacement = f.library + '.foreign'; writeFileSync(replacement, f.bytes, { mode: 0o644 }); renameSync(replacement, f.library); return true;
  } })).toThrow('changed before database construction');
});

test('prior-constructor selection refusal and cancellation never admit startup', () => {
  const f = fixture();
  expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => false })).toThrow('Bun refused');
  const controller = new AbortController(); controller.abort(); let calls = 0;
  expect(() => initializeDaemonNativeSqlite({ ...f.options, signal: controller.signal, setCustomSQLite: () => { calls++; return true; } })).toThrow();
  expect(calls).toBe(0);
});

test('asynchronous current restriction refuses and consumes rejection before selection', async () => {
  const f = fixture(); let calls = 0;
  expect(() => initializeDaemonNativeSqlite({ ...f.options, assertCurrent: () => Promise.reject(new Error('restriction failure')), setCustomSQLite: () => { calls++; return true; } })).toThrow('must be synchronous');
  await Promise.resolve(); expect(calls).toBe(0);
});

test('entry initializes before dynamically importing every service entry', () => {
  const entry = readFileSync(new URL('../../cli/entrypoint.ts', import.meta.url), 'utf8');
  const init = entry.indexOf('initializeDaemonNativeSqlite();'); expect(init).toBeGreaterThan(0);
  expect(entry.indexOf("await import('./run.js')")).toBeGreaterThan(init);
  expect(entry.indexOf("await import('./production-runtime.js')")).toBeGreaterThan(init);
  expect(entry).not.toContain("from './run.js'"); expect(entry).not.toContain("from './production-runtime.js'");
});
