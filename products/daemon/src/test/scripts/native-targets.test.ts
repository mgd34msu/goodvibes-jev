import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DAEMON_NATIVE_TARGETS, daemonCiPayloads, daemonNativeHost, type DaemonNativeTarget } from '../../cli/native-artifact.ts';
import { assertNativeInstallHost, expectedModes, inspectInstallation, targetPaths, type DaemonInstallOwner } from '../../cli/native-installation.ts';
import { recordDaemonCiArtifact, readVerifiedDaemonCiArtifact } from '../../../scripts/ci-artifact.ts';
import { packDaemonNative, verifyDaemonNativePackage } from '../../../scripts/package-native.ts';
import { acquireDaemonNative, assertQualifiedDaemonAcquisitionTarget, stageDaemonCiArchive } from '../../../scripts/acquire-native.ts';
import { installDaemonNative, rollbackDaemonNative } from '../../../scripts/install-native.ts';
import { verifiedDaemonNativePath } from '../../cli/native-launch.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

// These are inert fixture bytes. Nothing here claims execution of an ARM64 binary.
async function fixture(target: DaemonNativeTarget) {
  const root = makeOwnedTempDir('daemon-target-fixture'); const source = join(root, 'source');
  const owner: DaemonInstallOwner = { target, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), version: '1.2.3' };
  for (const [index, path] of daemonCiPayloads(target).entries()) {
    const file = join(source, 'native', path); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${target} fixture ${index}`); chmodSync(file, index < 2 ? 0o755 : 0o644);
  }
  await recordDaemonCiArtifact(source, owner);
  const artifact = await readVerifiedDaemonCiArtifact(source, owner);
  const prefix = join(root, 'prefix'); mkdirSync(prefix);
  const writeReceipt = (suffix: '' | '.previous' = '') => {
    for (const file of artifact.files) {
      const destination = join(prefix, file.path + suffix); mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(source, 'native', file.path), destination); chmodSync(destination, file.mode);
    }
    const receipt = join(prefix, 'daemon-installation.json' + suffix);
    writeFileSync(receipt, JSON.stringify({ schema: 1, packageName: '@goodvibes-jev/daemon', version: owner.version, artifact })); chmodSync(receipt, 0o644);
  };
  return { root, source, prefix, owner, artifact, writeReceipt };
}

test('native host mapping admits only Linux x64/ARM64 and requires an exact target match', () => {
  for (const target of DAEMON_NATIVE_TARGETS) {
    const arch = target.slice('linux-'.length);
    expect(daemonNativeHost('linux', arch)).toBe(target);
    expect(() => assertNativeInstallHost('linux', arch, target)).not.toThrow();
    expect(() => assertNativeInstallHost('linux', arch, target === 'linux-x64' ? 'linux-arm64' : 'linux-x64')).toThrow('does not match');
  }
  for (const [os, arch] of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'ia32']]) expect(() => daemonNativeHost(os, arch)).toThrow();
  for (const target of ['../../escape', '__proto__', 'darwin-arm64', 'linux-riscv64']) expect(() => daemonCiPayloads(target as DaemonNativeTarget)).toThrow('supported Linux');
});

for (const target of DAEMON_NATIVE_TARGETS) {
  const other = target === 'linux-x64' ? 'linux-arm64' : 'linux-x64';
  test(`${target} fixed payload contract records, packs and restores target-bound synthetic bytes`, async () => {
    const f = await fixture(target); const archive = await packDaemonNative(f.source, f.owner);
    const restored = stageDaemonCiArchive(archive, join(f.root, 'restored'), target);
    expect(await readVerifiedDaemonCiArtifact(restored, f.owner)).toEqual(f.artifact);
    expect(f.artifact.target).toBe(target); expect(() => expectedModes(f.artifact)).not.toThrow();
    expect(targetPaths(f.prefix, target).map(file => file.label)).toEqual([...daemonCiPayloads(target), 'daemon-installation.json']);
    expect(() => stageDaemonCiArchive(archive, join(f.root, 'wrong-target'), other)).toThrow('path');
    expect(existsSync(join(f.root, 'wrong-target'))).toBe(false);
    await expect(packDaemonNative(f.source, { ...f.owner, target: other })).rejects.toThrow();
    await expect(readVerifiedDaemonCiArtifact(restored, { ...f.owner, target: other })).rejects.toThrow();
  });
  test(`${target} current and previous receipts reject cross-target identity and foreign payloads`, async () => {
    const f = await fixture(target); f.writeReceipt(); f.writeReceipt('.previous');
    for (const suffix of ['', '.previous'] as const) {
      expect(inspectInstallation(f.prefix, suffix, target)?.artifact.target).toBe(target);
      expect(() => inspectInstallation(f.prefix, suffix, other)).toThrow('different native target');
    }
    // A receipt cannot relabel the fixed paths as another architecture.
    const path = join(f.prefix, 'daemon-installation.json'); const receipt = JSON.parse(readFileSync(path, 'utf8'));
    receipt.artifact.target = other; writeFileSync(path, JSON.stringify(receipt));
    expect(() => inspectInstallation(f.prefix, '', target)).toThrow();
    f.writeReceipt();
    const foreign = join(f.prefix, daemonCiPayloads(other)[0]!); writeFileSync(foreign, 'foreign');
    expect(() => inspectInstallation(f.prefix, '', target)).toThrow('different native target');
    rmSync(foreign); writeFileSync(foreign + '.update-transaction', 'foreign recovery evidence');
    expect(() => inspectInstallation(f.prefix, '', target)).toThrow('different native target');
  });
  for (const mutation of ['bytes', 'mode', 'missing', 'manifest-target', 'mixed-path', 'source', 'head', 'tree', 'payload-symlink', 'manifest-symlink', 'parent-symlink'] as const) {
    test(`${target} refuses ${mutation} before packing`, async () => {
      const f = await fixture(target); const file = join(f.source, 'native', daemonCiPayloads(target)[4]!);
      if (mutation === 'bytes') writeFileSync(file, 'tampered');
      if (mutation === 'mode') chmodSync(file, 0o755);
      if (mutation === 'missing') rmSync(file);
      if (mutation === 'manifest-target' || mutation === 'mixed-path') {
        const artifact = structuredClone(f.artifact);
        if (mutation === 'manifest-target') artifact.target = other;
        else artifact.files[4]!.path = daemonCiPayloads(other)[4]!;
        writeFileSync(join(f.source, 'native/ci-artifact.json'), JSON.stringify(artifact));
      }
      let source = f.source;
      if (mutation === 'payload-symlink') { rmSync(file); symlinkSync(join(f.source, 'native', daemonCiPayloads(target)[2]!), file); }
      if (mutation === 'manifest-symlink') { const path = join(f.source, 'native/ci-artifact.json'); const copied = join(f.root, 'manifest.json'); copyFileSync(path, copied); rmSync(path); symlinkSync(copied, path); }
      if (mutation === 'parent-symlink') { source = join(f.root, 'alias'); symlinkSync(f.source, source); }
      const owner = { ...f.owner };
      if (mutation === 'source') owner.sourceCommit = 'd'.repeat(40);
      if (mutation === 'head') owner.headCommit = 'd'.repeat(40);
      if (mutation === 'tree') owner.sourceTree = 'd'.repeat(40);
      await expect(packDaemonNative(source, owner)).rejects.toThrow();
    });
  }
  test(`${target} installation and verification reject a foreign host without destination writes`, async () => {
    if (process.platform !== 'linux' || daemonNativeHost() === target) return;
    const f = await fixture(target); const prefix = join(f.root, 'untouched');
    await expect(installDaemonNative({ artifactRoot: f.source, prefix, owner: f.owner })).rejects.toThrow('does not match');
    expect(existsSync(prefix)).toBe(false);
    await expect(verifyDaemonNativePackage(await packDaemonNative(f.source, f.owner), f.owner)).rejects.toThrow('does not match');
    f.writeReceipt(); expect(() => verifiedDaemonNativePath(f.prefix, f.owner)).toThrow('different native target');
  });
}

test('ARM64 acquisition is disabled before any GitHub request or installation', async () => {
  expect(() => assertQualifiedDaemonAcquisitionTarget('linux-x64')).not.toThrow();
  expect(() => assertQualifiedDaemonAcquisitionTarget('linux-arm64')).toThrow('same-artifact ARM64 qualification');
  const f = await fixture('linux-arm64'); let calls = 0; const prefix = join(f.root, 'never-installed');
  await expect(acquireDaemonNative({ runId: '123', prefix, owner: f.owner, gh: () => { calls++; throw new Error('must not contact GitHub'); } })).rejects.toThrow('same-artifact ARM64 qualification');
  expect(calls).toBe(0); expect(existsSync(prefix)).toBe(false);
});

(process.platform === 'linux' ? test : test.skip)('a foreign previous cohort refuses install and rollback under claims without altering either cohort', async () => {
  const target = daemonNativeHost(); const other = target === 'linux-x64' ? 'linux-arm64' : 'linux-x64';
  const current = await fixture(target); const previous = await fixture(other);
  await installDaemonNative({ artifactRoot: current.source, prefix: current.prefix, owner: current.owner });
  for (const file of previous.artifact.files) {
    const path = join(current.prefix, file.path + '.previous'); mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(previous.source, 'native', file.path), path); chmodSync(path, file.mode);
  }
  const receiptPath = join(current.prefix, 'daemon-installation.json.previous');
  writeFileSync(receiptPath, JSON.stringify({ schema: 1, packageName: '@goodvibes-jev/daemon', version: previous.owner.version, artifact: previous.artifact })); chmodSync(receiptPath, 0o644);
  const snapshot = () => readdirSync(current.prefix, { recursive: true }).filter((path): path is string => typeof path === 'string')
    .filter(path => statSync(join(current.prefix, path)).isFile()).sort()
    .map(path => [path, readFileSync(join(current.prefix, path)).toString('hex'), statSync(join(current.prefix, path)).mode & 0o777]);
  const before = snapshot();
  await expect(installDaemonNative({ artifactRoot: current.source, prefix: current.prefix, owner: current.owner })).rejects.toThrow();
  expect(snapshot()).toEqual(before);
  expect(() => rollbackDaemonNative(current.prefix)).toThrow();
  expect(snapshot()).toEqual(before);
});

(process.platform === 'linux' ? test : test.skip)('rollback restores verified previous bytes despite corrupt current bytes, but refuses a foreign current target', async () => {
  const target = daemonNativeHost(); const other = target === 'linux-x64' ? 'linux-arm64' : 'linux-x64';
  const f = await fixture(target); f.writeReceipt(); f.writeReceipt('.previous');
  const path = join(f.prefix, daemonCiPayloads(target)[0]!); writeFileSync(path, 'corrupt current payload');
  expect(() => rollbackDaemonNative(f.prefix)).not.toThrow();
  expect(readFileSync(path)).toEqual(readFileSync(join(f.source, 'native', daemonCiPayloads(target)[0]!)));
  f.writeReceipt('.previous');
  const receiptPath = join(f.prefix, 'daemon-installation.json'); const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.artifact.target = other; writeFileSync(receiptPath, JSON.stringify(receipt));
  const before = readFileSync(receiptPath);
  expect(() => rollbackDaemonNative(f.prefix)).toThrow();
  expect(readFileSync(receiptPath)).toEqual(before);
  expect(readFileSync(path)).toEqual(readFileSync(join(f.source, 'native', daemonCiPayloads(target)[0]!)));
});
