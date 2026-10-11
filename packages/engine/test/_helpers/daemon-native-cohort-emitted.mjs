import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { applyVerifiedUpdate, assertDaemonNativePayloadBytes, inspectDaemonNativeInstallation, parseDaemonCiArtifact,
  realUpdateFileIo, resolveDaemonNativeTargets, rollbackKeptPrevious, sha256, UpdateTransactionError,
} from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';

const fixturePath = process.env.JEV_NATIVE_EMITTED_FIXTURE;
assert.ok(fixturePath, 'The owning test must provide its inert fixture data');
const input = JSON.parse(readFileSync(fixturePath, 'utf8'));
const emittedUpdateUrl = import.meta.resolve('@goodvibes-jev/engine/sdk/platform/runtime/self-update');
const { performDaemonHandover } = await import(new URL('client/daemon-handover.js', emittedUpdateUrl));
const arch = process.arch;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(install = true) {
  const root = mkdtempSync(join(tmpdir(), 'daemon-node-emitted-')); roots.push(root);
  const execPath = join(root, 'owned installation', `goodvibes-daemon-linux-${arch}`);
  const targets = resolveDaemonNativeTargets(execPath, 'linux', arch);
  assert.ok(targets);
  const old = input.old.bytes.map(value => Buffer.from(value, 'base64'));
  const next = input.next.bytes.map(value => Buffer.from(value, 'base64'));
  if (install) for (const [index, target] of targets.entries()) {
    mkdirSync(dirname(target.path), { recursive: true }); writeFileSync(target.path, old[index]);
    chmodSync(target.path, target.executable ? 0o755 : 0o644);
  }
  const base = 'https://emitted-owner-fixture.invalid/releases/download/v2.0.24';
  const assets = new Map(targets.map((target, index) => [target.assetName,
    index === targets.length - 1 ? Buffer.from(JSON.stringify(input.next.artifact)) : next[index]]));
  const checksums = [...assets].map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n');
  const fetchImpl = async url => {
    const bytes = url === base + '/SHA256SUMS.txt' ? Buffer.from(checksums) : assets.get(url.slice(base.length + 1));
    return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
  };
  const apply = (fetch = fetchImpl, options = {}) => applyVerifiedUpdate({ fetchImpl: fetch, downloadBaseUrl: base, targets,
    platform: 'linux', daemonNative: { execPath, platform: 'linux', arch, version: '2.0.24' }, ...options });
  const state = () => targets.map(target => ({ bytes: readFileSync(target.path).toString('hex'), mode: lstatSync(target.path).mode & 0o777 }));
  return { root, execPath, targets, old, next, assets, base, fetchImpl, apply, state };
}
function assertNoTransient(targets) {
  for (const target of targets) for (const suffix of ['.update-download', '.update-previous', '.update-transaction', '.rollback-exchange']) {
    assert.equal(existsSync(target.path + suffix), false, target.path + suffix);
  }
}

test('ordinary Node selects the emitted SDK and observes the actual stable inode owner', () => {
  assert.equal(typeof globalThis.Bun, 'undefined');
  assert.match(import.meta.resolve('@goodvibes-jev/engine/sdk/platform/runtime/self-update'), /\/sdk\/dist\/platform\/runtime\/self-update\.js$/);
  const f = fixture(); const observed = realUpdateFileIo.observe(f.execPath), stat = lstatSync(f.execPath, { bigint: true });
  assert.ok(observed); assert.equal(observed.ownerIdentity, `${stat.dev}:${stat.ino}`);
  assert.ok(observed.identity.includes(observed.ownerIdentity));
});

test('emitted native transaction first-installs all six locally verified members without service activation', async () => {
  const f = fixture(false);
  const artifact = parseDaemonCiArtifact(input.old.artifact, `linux-${arch}`);
  assertDaemonNativePayloadBytes(artifact, f.old.slice(0, -1));
  const assets = new Map(f.targets.map((target, index) => [target.assetName, f.old[index]]));
  const checksums = [...assets].map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n');
  const controller = new AbortController();
  await applyVerifiedUpdate({ targets: f.targets, native: true, platform: 'linux', signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(), downloadBaseUrl: f.base, fetchImpl: async url => {
      const bytes = url === f.base + '/SHA256SUMS.txt' ? Buffer.from(checksums) : assets.get(url.slice(f.base.length + 1));
      return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
    }, beforeCommit: () => { assert.equal(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '', realUpdateFileIo), null); },
  });
  assert.equal(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '', realUpdateFileIo).version, '2.0.23');
  assert.deepEqual(f.state().map(member => member.bytes), f.old.map(bytes => bytes.toString('hex')));
  assertNoTransient(f.targets); assert.equal(f.targets.some(target => existsSync(target.path + '.previous')), false);
});

test('emitted native update and complete rollback keep payload hashes, modes and source receipts coherent', async () => {
  const f = fixture(), before = f.state();
  await f.apply();
  assert.equal(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '', realUpdateFileIo).version, '2.0.24');
  assert.equal(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '.previous', realUpdateFileIo).version, '2.0.23');
  const result = rollbackKeptPrevious(f.targets, realUpdateFileIo, () => {
    assert.equal(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '.previous', realUpdateFileIo).version, '2.0.23');
  }, { requireComplete: true, native: true });
  assert.equal(result.restored.length, 6); assert.equal(result.skipped.length, 0); assert.deepEqual(f.state(), before);
  assertNoTransient(f.targets);
});

test('ordinary Node emitted legacy adoption probes its actual old executable and installs the complete native cohort', async () => {
  const f = fixture(false); mkdirSync(dirname(f.execPath), { recursive: true });
  writeFileSync(f.execPath, '#!/bin/sh\nprintf "goodvibes-daemon 1.28.25\\n"\n'); chmodSync(f.execPath, 0o755);
  const home = homedir(); assert.equal(home, process.env.HOME); const beforeHome = readFileSync(join(home, 'sentinel'), 'utf8');
  const requests = [];
  const checksums = [...f.assets].map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n');
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.url === '/native/releases/latest') { response.writeHead(302, { location: '/native/releases/tag/v2.0.24' }); response.end(); return; }
    const prefix = '/native/releases/download/v2.0.24/';
    const asset = request.url?.startsWith(prefix) ? request.url.slice(prefix.length) : '';
    const bytes = asset === 'SHA256SUMS.txt' ? Buffer.from(checksums) : f.assets.get(asset);
    response.writeHead(bytes ? 200 : 404); response.end(bytes);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  let result;
  try {
    result = await performDaemonHandover({ binaryPath: f.execPath, assetName: f.targets[0].assetName, platform: 'linux', arch,
      releasesLatestUrl: origin + '/native/releases/latest', downloadBaseUrl: tag => origin + '/native/releases/download/' + tag,
      fetchImpl: globalThis.fetch,
    });
  } finally { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  assert.deepEqual(result, { tag: 'v2.0.24' });
  assert.equal(requests.length, 8); assert.deepEqual(requests[0], { method: 'HEAD', path: '/native/releases/latest' });
  assert.equal(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '', realUpdateFileIo).version, '2.0.24');
  assert.equal(readFileSync(join(home, 'sentinel'), 'utf8'), beforeHome);
  assert.match(readFileSync(f.execPath + '.previous', 'utf8'), /goodvibes-daemon 1\.28\.25/);
  assertNoTransient(f.targets);
});

for (const index of [0, 1, 2, 3, 4, 5]) test(`emitted native release with missing member ${index} leaves the entire installation unchanged`, async () => {
  const f = fixture(), before = f.state();
  await assert.rejects(f.apply((url, init) => url === `${f.base}/${f.targets[index].assetName}`
    ? Promise.resolve(new Response(null, { status: 404 })) : f.fetchImpl(url, init)));
  assert.deepEqual(f.state(), before); assertNoTransient(f.targets);
  assert.equal(f.targets.some(target => existsSync(target.path + '.previous')), false);
});

test('emitted native tampered download is refused before staging or publication', async () => {
  const f = fixture(), before = f.state();
  await assert.rejects(f.apply((url, init) => url === `${f.base}/${f.targets[1].assetName}`
    ? Promise.resolve(new Response('tampered emitted runtime')) : f.fetchImpl(url, init)), /checksum mismatch/);
  assert.deepEqual(f.state(), before); assertNoTransient(f.targets);
});

test('emitted native current mode ownership is checked before any release request', async () => {
  const f = fixture(); chmodSync(f.execPath + '.bun', 0o644); const before = f.state(); let requests = 0;
  await assert.rejects(f.apply((...args) => { requests++; return f.fetchImpl(...args); }), /wrong mode/);
  assert.equal(requests, 0); assert.deepEqual(f.state(), before); assertNoTransient(f.targets);
});

test('emitted native retained installation refuses equal-byte inode replacement during download', async () => {
  const f = fixture(), before = f.state(); let replaced = false;
  await assert.rejects(f.apply((url, init) => {
    if (!replaced) {
      replaced = true; const path = f.execPath + '.bun';
      writeFileSync(path + '.foreign', readFileSync(path)); chmodSync(path + '.foreign', 0o755); renameSync(path + '.foreign', path);
    }
    return f.fetchImpl(url, init);
  }), /changed/);
  assert.equal(replaced, true); assert.deepEqual(f.state(), before); assertNoTransient(f.targets);
});

test('emitted native cancellation after a real forward rename compensates the complete original cohort', async () => {
  const f = fixture(), before = f.state(), controller = new AbortController(); let stopped = false;
  await assert.rejects(f.apply(f.fetchImpl, { signal: controller.signal, io: { ...realUpdateFileIo, rename(from, to) {
    realUpdateFileIo.rename(from, to);
    if (!stopped && to.endsWith('.previous')) { stopped = true; controller.abort(new Error('emitted effect lifetime ended')); }
  } } }));
  assert.equal(stopped, true); assert.deepEqual(f.state(), before); assertNoTransient(f.targets);
});

test('emitted native physical owner mismatch after rename retains honest recovery fences instead of adopting equal bytes', async () => {
  const f = fixture(); let replaced = false, failure;
  try {
    await f.apply(f.fetchImpl, { io: { ...realUpdateFileIo, rename(from, to) {
      realUpdateFileIo.rename(from, to);
      if (!replaced && from === f.execPath + '.update-download') {
        replaced = true; writeFileSync(to + '.foreign', readFileSync(to)); chmodSync(to + '.foreign', 0o755); renameSync(to + '.foreign', to);
      }
    } } });
  } catch (error) { failure = error; }
  assert.equal(replaced, true); assert.ok(failure instanceof UpdateTransactionError);
  assert.equal(failure.receipt.committed, false); assert.equal(failure.receipt.recoveryRequired, true);
  assert.match(failure.message, /rename result is unknown/);
  assert.deepEqual(readFileSync(f.execPath), f.next[0]); assert.deepEqual(readFileSync(f.execPath + '.previous'), f.old[0]);
  assert.equal(existsSync(f.execPath + '.update-transaction'), true);
});

test('emitted native rollback refuses a missing previous runtime without partially changing current members', async () => {
  const f = fixture(); await f.apply(); const before = f.state(); rmSync(f.execPath + '.bun.previous');
  assert.throws(() => rollbackKeptPrevious(f.targets, realUpdateFileIo, undefined, { requireComplete: true, native: true }), /incomplete/);
  assert.deepEqual(f.state(), before); assertNoTransient(f.targets);
});

test('emitted native asynchronous effect restriction grants no rollback writes', async () => {
  const f = fixture(); await f.apply(); const before = f.state();
  assert.throws(() => rollbackKeptPrevious(f.targets, realUpdateFileIo, undefined, { requireComplete: true, native: true,
    assertCurrent: async () => { throw new Error('emitted restriction rejected'); },
  }), /synchronously/);
  await Promise.resolve(); assert.deepEqual(f.state(), before); assertNoTransient(f.targets);
});
