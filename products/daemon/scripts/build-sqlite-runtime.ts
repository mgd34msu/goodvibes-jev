import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readTarGzEntries } from '@goodvibes-jev/engine/sdk/platform/browser';
import { assertDaemonSqliteArchitecture, daemonSqliteRuntime, type DaemonSqliteOwner } from '../src/cli/native-sqlite-runtime.ts';
import { VERSION } from '../src/version.ts';

/** Native source compilation is part of the producer; consumers never run it. */
export async function buildDaemonSqliteRuntime(root: string, target: string): Promise<DaemonSqliteOwner | null> {
  if (!target.startsWith('bun-darwin-')) return null;
  const arch = target.slice('bun-darwin-'.length);
  const runtime = daemonSqliteRuntime('darwin', arch);
  if (!runtime || process.platform !== 'darwin' || process.arch !== arch) throw new Error('Build the retained Darwin SQLite companion on its exact native producer');
  const record = (value: unknown): object => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native SQLite producer declaration is invalid');
    return value;
  };
  const config: unknown = JSON.parse(readFileSync(join(root, 'toolchain.config.json'), 'utf8'));
  const targets: unknown = Reflect.get(record(Reflect.get(record(config), 'build')), 'targets');
  if (!Array.isArray(targets)) throw new Error('Native SQLite target declaration is missing');
  const selectedTarget: unknown = targets.find((row: unknown) => Reflect.get(record(row), 'key') === runtime.target);
  const declared = record(Reflect.get(record(selectedTarget), 'sqliteRuntime'));
  if (Object.keys(declared).length !== 5 || !Object.entries(runtime).filter(([key]) => key !== 'target').every(([key, value]) => Reflect.get(declared, key) === value)) {
    throw new Error('Native SQLite target supplier declaration differs');
  }
  const response = await fetch(runtime.sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || response.url !== runtime.sourceUrl || !response.body) throw new Error('Pinned SQLite source acquisition failed');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 8 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('Pinned SQLite source exceeds its acquisition limit'); }
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  if (createHash('sha3-256').update(archive).digest('hex') !== runtime.sourceSha3) throw new Error('Pinned SQLite source checksum differs');
  const entries = [...readTarGzEntries(archive, { strict: true, maxOutputLength: 64 * 1024 * 1024 })];
  const selected = ['sqlite3.c', 'sqlite3.h'].map(name => {
    const files = entries.filter(entry => entry.path === `sqlite-autoconf-3540000/${name}`);
    if (files.length !== 1 || files[0]?.kind !== 'file') throw new Error('Pinned SQLite amalgamation is incomplete');
    return { name, bytes: files[0].data };
  });
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-sqlite-source-'));
  try {
    for (const file of selected) writeFileSync(join(scratch, file.name), file.bytes, { flag: 'wx', mode: 0o600 });
    const library = join(scratch, 'libsqlite3.dylib');
    execFileSync('xcrun', ['--sdk', 'macosx', 'clang', '-arch', arch === 'x64' ? 'x86_64' : 'arm64',
      '-dynamiclib', '-O2', '-DSQLITE_THREADSAFE=1', '-DSQLITE_ENABLE_COLUMN_METADATA', '-DSQLITE_ENABLE_FTS5',
      '-DSQLITE_ENABLE_RTREE', '-DSQLITE_ENABLE_DBSTAT_VTAB', '-DSQLITE_ENABLE_LOAD_EXTENSION',
      '-Wl,-install_name,@rpath/libsqlite3.dylib', join(scratch, 'sqlite3.c'), '-o', library],
      { cwd: scratch, stdio: 'inherit', timeout: 120_000 });
    const bytes = readFileSync(library); assertDaemonSqliteArchitecture(bytes, runtime.target); chmodSync(library, 0o644);
    const output = join(root, 'native', runtime.libraryPath), provenance = join(root, 'native', runtime.provenancePath);
    mkdirSync(dirname(output), { recursive: true });
    const metadata: DaemonSqliteOwner = { schema: 1, packageName: '@goodvibes-jev/daemon', daemonVersion: VERSION, target: runtime.target,
      sqliteVersion: runtime.sqliteVersion, sourceUrl: runtime.sourceUrl, sourceSha3: runtime.sourceSha3,
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    writeFileSync(provenance + '.building', JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    writeFileSync(output + '.building', bytes, { flag: 'wx', mode: 0o644 });
    renameSync(output + '.building', output); renameSync(provenance + '.building', provenance);
    return Object.freeze(metadata);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
