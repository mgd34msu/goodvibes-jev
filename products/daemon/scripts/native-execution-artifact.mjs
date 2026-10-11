import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_EXECUTION_TARGETS = Object.freeze(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']);
const MANIFEST = 'native-execution-artifact.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));

/** CI execution ownership is separate from the Linux install/update receipt. */
export function nativeExecutionMembers(product, target) {
  assert(NATIVE_EXECUTION_TARGETS.includes(target), 'Unsupported native execution target');
  const config = json(join(product, 'toolchain.config.json'));
  assert.deepEqual(config.build.targets.map(row => row.key), NATIVE_EXECUTION_TARGETS, 'Every configured native target requires execution');
  assert.equal(config.build.outDir, 'native'); assert.equal(config.build.addonOutDir, 'native/lib');
  const row = config.build.targets.find(row => row.key === target);
  const [platform, arch] = target.split('-');
  const artifact = `goodvibes-daemon-${platform === 'darwin' ? 'macos' : platform}-${arch}`;
  assert.equal(row.appArtifact, artifact); assert.equal(row.bunTarget, `bun-${target}`);
  assert.equal(row.nativeAddonPackage, `sqlite-vec-${target}`);
  assert.equal(row.nativeAddonFile, platform === 'darwin' ? 'vec0.dylib' : 'vec0.so');
  const members = [{ path: artifact, mode: 0o755 }];
  if (platform === 'linux') {
    assert.equal(row.capturedBunRuntime, '1.3.14');
    members.push({ path: artifact + '.bun', mode: 0o755 }, { path: artifact + '.bun.LICENSE.md', mode: 0o644 }, { path: artifact + '.bun.json', mode: 0o644 });
  } else {
    assert.equal(row.capturedBunRuntime, undefined, 'Darwin compiled artifacts do not declare Linux runtime sidecars');
  }
  members.push({ path: `lib/${row.nativeAddonPackage}/${row.nativeAddonFile}`, mode: 0o644 });
  if (platform === 'darwin') {
    const runtime = row.sqliteRuntime;
    const library = `lib/sqlite-${target}/libsqlite3.dylib`;
    assert(runtime, 'Darwin native vector execution requires declared extension-enabled SQLite');
    assert.equal(runtime.libraryPath, library); assert.equal(runtime.provenancePath, library + '.json');
    assert.equal(runtime.sqliteVersion, '3.54.0');
    assert.equal(runtime.sourceUrl, 'https://www.sqlite.org/2026/sqlite-autoconf-3540000.tar.gz');
    assert.equal(runtime.sourceSha3, 'f5e3e724e9c9b3b5d512c76b02082091a59eeea9becd169a9fbf4d376403acce');
    members.push({ path: library, mode: 0o644 }, { path: library + '.json', mode: 0o644 });
  }
  return Object.freeze(members.map(member => Object.freeze(member)));
}

function observe(path, root, directoryRevisions = true) {
  const parents = [];
  for (let current = dirname(path);;) {
    const stat = lstatSync(current, { bigint: true });
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Native execution parent must be a regular directory');
    const selected = current === root || current.startsWith(root + '/');
    parents.push(`${realpathSync(current)}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}${directoryRevisions && selected ? `:${stat.ctimeNs}:${stat.mtimeNs}` : ''}`);
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const stat = lstatSync(path, { bigint: true });
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Native execution payload must be a regular file');
  return { identity: `${parents.join('|')}:${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}:${stat.uid}:${stat.gid}:${stat.mode}`, mode: Number(stat.mode & 0o7777n), size: Number(stat.size) };
}

export function retainNativeExecutionFiles(root, members, { directoryRevisions = true } = {}) {
  const retained = members.map(member => {
    const full = join(root, member.path), before = observe(full, root, directoryRevisions);
    assert.equal(before.mode, member.mode, 'Native execution payload mode differs');
    const bytes = readFileSync(full);
    assert.equal(observe(full, root, directoryRevisions).identity, before.identity, 'Native execution payload changed while read');
    assert.equal(bytes.length, before.size);
    return Object.freeze({ ...member, sha256: digest(bytes), size: bytes.length, identity: before.identity, bytes });
  });
  const assertCurrent = () => {
    for (const file of retained) {
      const full = join(root, file.path);
      assert.equal(observe(full, root, directoryRevisions).identity, file.identity, 'Retained native execution owner changed');
      assert.equal(digest(readFileSync(full)), file.sha256, 'Retained native execution bytes changed');
      assert.equal(observe(full, root, directoryRevisions).identity, file.identity, 'Retained native execution owner changed during verification');
    }
  };
  assertCurrent();
  return Object.freeze({ files: Object.freeze(retained), assertCurrent });
}

function owner(product, source) {
  for (const value of [source.sourceCommit, source.sourceTree, source.headCommit]) assert.match(value, /^[0-9a-f]{40}$/, 'Exact native source SHA required');
  assert(NATIVE_EXECUTION_TARGETS.includes(source.target), 'Unsupported native execution target');
  for (const value of [source.runId, source.runAttempt]) assert.match(value, /^[1-9][0-9]*$/, 'Exact native CI run/attempt required');
  const pkg = json(join(product, 'package.json'));
  assert.equal(pkg.name, '@goodvibes-jev/daemon'); assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  return Object.freeze({ schema: 1, kind: 'daemon-native-execution', sourceCommit: source.sourceCommit, sourceTree: source.sourceTree,
    headCommit: source.headCommit, target: source.target, runId: source.runId, runAttempt: source.runAttempt, packageName: pkg.name, version: pkg.version });
}

function inspectSqliteCompanion(product, target, retained, artifactOwner) {
  if (!target.startsWith('darwin-')) return;
  const row = json(join(product, 'toolchain.config.json')).build.targets.find(row => row.key === target);
  const library = retained.files.find(file => file.path === row.sqliteRuntime.libraryPath);
  const provenance = retained.files.find(file => file.path === row.sqliteRuntime.provenancePath);
  const cpu = target === 'darwin-x64' ? 0x01000007 : 0x0100000c;
  assert(library.bytes.length >= 32 && library.bytes.readUInt32LE(0) === 0xfeedfacf && library.bytes.readUInt32LE(4) === cpu && library.bytes.readUInt32LE(12) === 6, 'Native SQLite Mach-O architecture differs');
  assert.deepEqual(JSON.parse(provenance.bytes.toString('utf8')), { schema: 1, packageName: artifactOwner.packageName,
    daemonVersion: artifactOwner.version, target, sqliteVersion: row.sqliteRuntime.sqliteVersion,
    sourceUrl: row.sqliteRuntime.sourceUrl, sourceSha3: row.sqliteRuntime.sourceSha3, sha256: library.sha256, size: library.size }, 'Native SQLite supplier/byte provenance differs');
}

export function recordNativeExecutionArtifact(product, source) {
  const expectedOwner = owner(product, source);
  const members = nativeExecutionMembers(product, source.target), root = join(product, 'native');
  // Recording creates one new root entry; keep physical ancestry and file
  // revisions here, then retain directory revisions for the immutable consumer.
  const retained = retainNativeExecutionFiles(root, members, { directoryRevisions: false });
  inspectSqliteCompanion(product, source.target, retained, expectedOwner);
  const artifact = { ...expectedOwner, files: retained.files.map(({ path, mode, sha256, size }) => ({ path, sha256, mode, size })) };
  retained.assertCurrent();
  writeFileSync(join(root, MANIFEST), JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  retained.assertCurrent();
  return Object.freeze(artifact);
}

export function verifyNativeExecutionArtifact(product, source) {
  const expectedOwner = owner(product, source), members = nativeExecutionMembers(product, source.target), root = join(product, 'native');
  const retained = retainNativeExecutionFiles(root, [...members, { path: MANIFEST, mode: 0o644 }]);
  const stored = JSON.parse(retained.files.at(-1).bytes.toString('utf8'));
  const actual = { ...expectedOwner, files: retained.files.slice(0, -1).map(({ path, sha256, mode, size }) => ({ path, sha256, mode, size })) };
  assert.deepEqual(stored, actual, 'Restored native execution artifact differs from source, run/attempt, target or bytes');
  inspectSqliteCompanion(product, source.target, retained, expectedOwner); retained.assertCurrent();
  return Object.freeze({ artifact: Object.freeze(actual), members, retained });
}

export function nativeExecutionSource(product, sourceCommit, headCommit, env = process.env) {
  assert.equal(env.GITHUB_SHA, sourceCommit, 'Native CI checkout source differs');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Native artifact ownership requires the actual CI producer/consumer');
  const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: product, encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), sourceCommit, 'Native artifact checkout SHA differs'); git('diff', '--exit-code', 'HEAD');
  const target = `${process.platform}-${process.arch}`;
  assert(NATIVE_EXECUTION_TARGETS.includes(target), 'No native execution target for this host');
  return Object.freeze({ sourceCommit, sourceTree: git('rev-parse', 'HEAD^{tree}'), headCommit, target, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const product = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [action, sourceCommit, headCommit, archive, ...extra] = process.argv.slice(2);
  assert(!extra.length && ['record', 'verify', 'archive'].includes(action) && sourceCommit && headCommit && (action === 'archive' ? archive : archive === undefined),
    'Usage: native-execution-artifact.mjs <record|verify|archive> <checkout SHA> <head SHA> [archive output]');
  const source = nativeExecutionSource(product, sourceCommit, headCommit);
  if (action === 'record') recordNativeExecutionArtifact(product, source);
  else {
    const verified = verifyNativeExecutionArtifact(product, source);
    if (action === 'archive') {
      // Names are fixed by the actual source target, never supplied by JSON.
      execFileSync('tar', ['--format=ustar', '-czf', resolve(archive), ...[...verified.members.map(file => file.path), MANIFEST].map(path => `products/daemon/native/${path}`)], { cwd: resolve(product, '../..'), timeout: 30_000 });
      chmodSync(resolve(archive), 0o644); verified.retained.assertCurrent();
    }
  }
}
