import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyVerifiedUpdate, inspectDaemonNativeInstallation, realUpdateFileIo, resolveDaemonNativeTargets, rollbackKeptPrevious,
  UpdateTransactionError, type UpdateFetchLike } from '../sdk/src/platform/runtime/self-update.ts';
import { performDaemonHandover, DAEMON_REPO_RELEASES_LATEST_URL, daemonReleaseDownloadBaseUrl } from '../sdk/src/platform/runtime/client/daemon-handover.ts';
import { applyDaemonReleaseFeedMigrationPass } from '../sdk/src/platform/config/manager-migration-passes.ts';
import { DAEMON_RELEASES_LATEST_URL, migrateLegacyDaemonReleaseFeed } from '../sdk/src/platform/config/schema-domain-update.ts';
import { nativeCohortFixture } from './_helpers/daemon-native-cohort.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const nativeTest = process.platform === 'linux' ? test : test.skip;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'daemon-real-native-cohort-')); roots.push(root);
  const execPath = join(root, 'owned installation', `goodvibes-daemon-linux-${arch}`);
  const old = nativeCohortFixture({ version: '2.0.23', daemonBytes: 'original daemon', arch });
  const next = nativeCohortFixture({ version: '2.0.24', daemonBytes: 'replacement daemon', arch });
  for (const [path, bytes] of Object.entries(old.installation(execPath))) {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
    chmodSync(path, path === execPath || path.endsWith('.bun') ? 0o755 : 0o644);
  }
  const targets = resolveDaemonNativeTargets(execPath, 'linux', arch);
  if (!targets) throw new Error('Test native target unsupported');
  const base = 'https://local-fixture.invalid/releases/download/v2.0.24';
  const fetchImpl: UpdateFetchLike = async url => {
    const bytes = url === base + '/SHA256SUMS.txt' ? Buffer.from(next.checksumManifest) : next.assets[url.slice(base.length + 1)];
    return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
  };
  const apply = (fetch = fetchImpl, options: { signal?: AbortSignal; beforeCommit?: () => void; io?: typeof realUpdateFileIo } = {}) => applyVerifiedUpdate({
    fetchImpl: fetch, downloadBaseUrl: base, targets, platform: 'linux', daemonNative: { execPath, platform: 'linux', arch, version: '2.0.24' }, ...options,
  });
  const state = () => targets.map(target => readFileSync(target.path).toString('hex'));
  return { root, execPath, old, next, targets, base, fetchImpl, apply, state };
}

nativeTest('real native replacement and full rollback preserve six coherent files and their source receipt', async () => {
  const f = fixture(), original = f.state();
  await f.apply();
  expect(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '', realUpdateFileIo)?.version).toBe('2.0.24');
  expect(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '.previous', realUpdateFileIo)?.version).toBe('2.0.23');
  const result = rollbackKeptPrevious(f.targets, realUpdateFileIo, () => {
    expect(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '.previous', realUpdateFileIo)?.version).toBe('2.0.23');
  }, { requireComplete: true, native: true });
  expect(result.restored).toHaveLength(6); expect(result.skipped).toHaveLength(0); expect(f.state()).toEqual(original);
  expect(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '', realUpdateFileIo)?.artifact).toEqual(f.old.artifact);
});

for (const index of [0, 1, 2, 3, 4, 5]) nativeTest(`real release with missing member ${index} leaves all installed and backup bytes unchanged`, async () => {
  const f = fixture(), original = f.state(), asset = f.targets[index];
  if (!asset) throw new Error('Test member missing');
  await expect(f.apply(async (url, init) => url === `${f.base}/${asset.assetName}` ? new Response(null, { status: 404 }) : f.fetchImpl(url, init))).rejects.toThrow();
  expect(f.state()).toEqual(original); expect(f.targets.some(target => existsSync(target.path + '.previous'))).toBe(false);
  expect(f.targets.some(target => existsSync(target.path + '.update-transaction'))).toBe(false);
});

nativeTest('real equal-byte inode replacement during native download is rejected before publication', async () => {
  const f = fixture(), original = f.state(); let replaced = false;
  await expect(f.apply(async (url, init) => {
    if (!replaced) {
      replaced = true; const victim = f.execPath + '.bun';
      writeFileSync(victim + '.foreign', readFileSync(victim)); chmodSync(victim + '.foreign', 0o755); renameSync(victim + '.foreign', victim);
    }
    return f.fetchImpl(url, init);
  })).rejects.toThrow('changed');
  expect(replaced).toBe(true); expect(f.state()).toEqual(original);
  expect(f.targets.some(target => existsSync(target.path + '.previous'))).toBe(false);
});

nativeTest('real staged equal-byte replacement by an admission callback cannot become a native publication', async () => {
  const f = fixture(), original = f.state();
  await expect(f.apply(f.fetchImpl, { beforeCommit: () => {
    const victim = f.execPath + '.bun.update-download';
    writeFileSync(victim + '.foreign', readFileSync(victim)); chmodSync(victim + '.foreign', 0o755); renameSync(victim + '.foreign', victim);
  } })).rejects.toThrow('retained');
  expect(f.state()).toEqual(original); expect(f.targets.some(target => existsSync(target.path + '.previous'))).toBe(false);
});

nativeTest('an equal-byte foreign inode substituted inside a real native rename is retained as uncertain ownership', async () => {
  const f = fixture(); let replaced = false;
  let failure: unknown;
  try {
    await f.apply(f.fetchImpl, { io: { ...realUpdateFileIo, rename(from, to) {
      realUpdateFileIo.rename(from, to);
      if (!replaced && from === f.execPath + '.update-download') {
        replaced = true;
        writeFileSync(to + '.foreign', readFileSync(to)); chmodSync(to + '.foreign', 0o755); renameSync(to + '.foreign', to);
      }
    } } });
  } catch (error) { failure = error; }
  expect(replaced).toBe(true); expect(failure).toBeInstanceOf(UpdateTransactionError);
  if (!(failure instanceof UpdateTransactionError)) throw new Error('Expected an authentic uncertain native publication receipt');
  expect(failure.receipt.committed).toBe(false); expect(failure.receipt.recoveryRequired).toBe(true);
  expect(failure.message).toContain('rename result is unknown');
  const nextPrimary = f.next.members[0], oldPrimary = f.old.members[0];
  if (!nextPrimary || !oldPrimary) throw new Error('Native fixture must provide both primary executable payloads');
  expect(readFileSync(f.execPath)).toEqual(nextPrimary.bytes);
  expect(readFileSync(f.execPath + '.previous')).toEqual(oldPrimary.bytes);
  expect(existsSync(f.execPath + '.update-transaction')).toBe(true);
});

nativeTest('cancellation after the first real forward rename stops publication and restores the original complete cohort', async () => {
  const f = fixture(), original = f.state(), controller = new AbortController(); let forwards = 0;
  await expect(f.apply(f.fetchImpl, { signal: controller.signal, io: { ...realUpdateFileIo, rename(from, to) {
    realUpdateFileIo.rename(from, to);
    if (to.endsWith('.previous') && ++forwards === 1) controller.abort(new Error('actual effect lifetime ended'));
  } } })).rejects.toThrow();
  expect(forwards).toBe(1); expect(f.state()).toEqual(original);
  expect(f.targets.some(target => existsSync(target.path + '.update-transaction'))).toBe(false);
});

nativeTest('a missing real previous sidecar refuses the whole rollback while keeping current bytes intact', async () => {
  const f = fixture(); await f.apply(); const current = f.state();
  rmSync(f.execPath + '.bun.previous');
  expect(() => rollbackKeptPrevious(f.targets, realUpdateFileIo, undefined, { requireComplete: true, native: true })).toThrow('incomplete');
  expect(f.state()).toEqual(current);
});

nativeTest('an asynchronous native effect restriction grants no rollback publication', async () => {
  const f = fixture(); await f.apply(); const current = f.state();
  expect(() => rollbackKeptPrevious(f.targets, realUpdateFileIo, undefined, { requireComplete: true, native: true,
    assertCurrent: async () => { throw new Error('asynchronous restriction rejected'); },
  })).toThrow('synchronously');
  await Promise.resolve(); expect(f.state()).toEqual(current);
});

nativeTest('legacy adoption probes its actual local daemon and publishes the complete new cohort without touching original homes', async () => {
  const f = fixture();
  for (const target of f.targets) rmSync(target.path);
  writeFileSync(f.execPath, '#!/bin/sh\nprintf "goodvibes-daemon 1.28.25\\n"\n'); chmodSync(f.execPath, 0o755);
  const originalHome = join(f.root, 'original home'), otherHome = join(f.root, 'other home');
  mkdirSync(originalHome); mkdirSync(otherHome); writeFileSync(join(originalHome, 'sentinel'), 'unchanged'); writeFileSync(join(otherHome, 'sentinel'), 'untouched');
  const base = daemonReleaseDownloadBaseUrl('v2.0.24');
  const fetchImpl: UpdateFetchLike = async (url, init) => {
    if (url === DAEMON_REPO_RELEASES_LATEST_URL) return { ok: false, status: 302, url, headers: { get: name => name.toLowerCase() === 'location' ? 'https://github.com/mgd34msu/goodvibes-jev/releases/tag/v2.0.24' : null }, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    return f.fetchImpl(f.base + url.slice(base.length), init);
  };
  expect(await performDaemonHandover({ fetchImpl, binaryPath: f.execPath, assetName: f.targets[0]!.assetName, platform: 'linux', arch })).toEqual({ tag: 'v2.0.24' });
  expect(inspectDaemonNativeInstallation(f.execPath, 'linux', arch, '', realUpdateFileIo)?.version).toBe('2.0.24');
  expect(readFileSync(join(originalHome, 'sentinel'), 'utf8')).toBe('unchanged'); expect(readFileSync(join(otherHome, 'sentinel'), 'utf8')).toBe('untouched');
});

test('only exact historical release defaults migrate and only owning settings runtimes persist them', () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-feed-migration-')); roots.push(root); const path = join(root, 'settings.json');
  for (const feed of ['https://github.com/mgd34msu/goodvibes-daemon/releases/latest', 'https://github.com/mgd34msu/goodvibes-tui/releases/latest']) {
    const config = { update: { releasesUrl: feed, auto: false }, privateOwner: 'retained' }; const before = JSON.stringify(config);
    writeFileSync(path, before);
    expect(applyDaemonReleaseFeedMigrationPass(config, path, { ownsFile: false })).toEqual({ ...config, update: { ...config.update, releasesUrl: DAEMON_RELEASES_LATEST_URL } });
    expect(readFileSync(path, 'utf8')).toBe(before);
    const migrated = applyDaemonReleaseFeedMigrationPass(config, path, { ownsFile: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(migrated); expect(migrateLegacyDaemonReleaseFeed(migrated)).toBe(migrated);
  }
  for (const feed of ['https://custom.invalid/releases/latest', 'https://github.com/mgd34msu/goodvibes-daemon/releases/latest/', ' https://github.com/mgd34msu/goodvibes-daemon/releases/latest']) {
    const config = { update: { releasesUrl: feed } }; expect(migrateLegacyDaemonReleaseFeed(config)).toBe(config);
  }
});
