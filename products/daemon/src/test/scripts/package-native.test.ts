import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DAEMON_CI_PAYLOADS, recordDaemonCiArtifact, readVerifiedDaemonCiArtifact } from '../../../scripts/ci-artifact.ts';
import { stageDaemonCiArchive } from '../../../scripts/acquire-native.ts';
import { installDaemonNative, readDaemonInstallOwner, type DaemonInstallOwner } from '../../../scripts/install-native.ts';
import { packDaemonNative, parseNativePackageArgs, verifyDaemonNativePackage } from '../../../scripts/package-native.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const owner: DaemonInstallOwner = { target: 'linux-x64', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), version: '1.2.3' };
async function fixture() {
  const root = makeOwnedTempDir('daemon-private-package'); const source = join(root, 'source');
  const data = ['#!/bin/sh\nexec "$(dirname "$0")/goodvibes-daemon-linux-x64.bun" "$@"\n', '#!/bin/sh\nprintf "fixture daemon 1.2.3\\n"\n', 'fixture license', '{}', 'fixture addon'];
  for (const [i, path] of DAEMON_CI_PAYLOADS.entries()) {
    const file = join(source, 'native', path); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data[i]!); chmodSync(file, i < 2 ? 0o755 : 0o644);
  }
  await recordDaemonCiArtifact(source, owner);
  return { root, source };
}

test('private tarball restores an exact cohort and installs runnable companions without source or package dependencies', async () => {
  const f = await fixture(); const archive = await packDaemonNative(f.source, owner);
  const restored = stageDaemonCiArchive(archive, join(f.root, 'restored'));
  expect(await readVerifiedDaemonCiArtifact(restored, owner)).toEqual(await readVerifiedDaemonCiArtifact(f.source, owner));
  const prefix = join(f.root, 'clean consumer'); await installDaemonNative({ artifactRoot: restored, prefix, owner });
  rmSync(f.source, { recursive: true }); rmSync(join(f.root, 'restored'), { recursive: true });
  const result = spawnSync(join(prefix, DAEMON_CI_PAYLOADS[0]), ['--version'], { cwd: f.root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: f.root } });
  expect(result.status).toBe(0); expect(result.stdout).toBe('fixture daemon 1.2.3\n');
  expect(existsSync(join(prefix, 'node_modules'))).toBe(false);
  expect(JSON.parse(readFileSync(join(prefix, 'daemon-installation.json'), 'utf8')).artifact.sourceCommit).toBe(owner.sourceCommit);
});

for (const mutation of ['bytes', 'missing', 'mode', 'symlink', 'manifest-symlink', 'parent-symlink', 'source', 'head', 'tree'] as const) {
  test(`private packing refuses ${mutation} drift`, async () => {
    const f = await fixture(); let source = f.source; const expected = { ...owner };
    const file = join(source, 'native', DAEMON_CI_PAYLOADS[4]);
    if (mutation === 'bytes') writeFileSync(file, 'changed');
    if (mutation === 'missing') rmSync(file);
    if (mutation === 'mode') { chmodSync(file, 0o755); await recordDaemonCiArtifact(source, owner); }
    if (mutation === 'symlink') { rmSync(file); symlinkSync(join(source, 'native', DAEMON_CI_PAYLOADS[2]), file); }
    if (mutation === 'manifest-symlink') { const manifest = join(source, 'native/ci-artifact.json'); const copy = join(f.root, 'manifest.json'); writeFileSync(copy, readFileSync(manifest)); rmSync(manifest); symlinkSync(copy, manifest); }
    if (mutation === 'parent-symlink') { source = join(f.root, 'alias'); symlinkSync(f.source, source); }
    if (mutation === 'source') expected.sourceCommit = 'd'.repeat(40);
    if (mutation === 'head') expected.headCommit = 'd'.repeat(40);
    if (mutation === 'tree') expected.sourceTree = 'd'.repeat(40);
    await expect(packDaemonNative(source, expected)).rejects.toThrow();
  });
}

test('packing excludes extra source/native files instead of accidentally shipping them', async () => {
  const f = await fixture(); writeFileSync(join(f.source, 'native', 'secret.txt'), 'never packed');
  writeFileSync(join(f.source, 'package.json'), '{"private":true}');
  const archive = await packDaemonNative(f.source, owner);
  const restored = stageDaemonCiArchive(archive, join(f.root, 'restored'));
  expect(existsSync(join(restored, 'native', 'secret.txt'))).toBe(false);
  expect(existsSync(join(restored, 'package.json'))).toBe(false);
});

test('consumer rejects truncated archive and wrong expected source before native execution', async () => {
  const f = await fixture(); const archive = await packDaemonNative(f.source, owner);
  await expect(verifyDaemonNativePackage(archive.subarray(0, 30), owner)).rejects.toThrow();
  await expect(verifyDaemonNativePackage(archive, { ...owner, sourceTree: 'f'.repeat(40) })).rejects.toThrow();
});

test('private CLI requires explicit immutable identity and normalized output with no release or publish options', () => {
  const args = ['--artifact-root', '/artifact', '--output', '/tmp/cohort.tgz', '--source-commit', owner.sourceCommit, '--head-commit', owner.headCommit];
  expect(parseNativePackageArgs(args).output).toBe('/tmp/cohort.tgz');
  for (const bad of [[], args.slice(0, -2), [...args, '--publish', 'yes'], [...args, '--output', '/tmp/other'], args.map(value => value === '/tmp/cohort.tgz' ? 'relative.tgz' : value)]) expect(() => parseNativePackageArgs(bad)).toThrow();
});

test('CLI rejection leaves no output tarball and returns a failing exit status', async () => {
  const f = await fixture(); const output = join(f.root, 'must-not-exist.tgz');
  const result = spawnSync(process.execPath, [join(import.meta.dir, '../../../scripts/package-native.ts'), '--artifact-root', f.source, '--output', output, '--source-commit', owner.sourceCommit, '--head-commit', owner.headCommit], { encoding: 'utf8' });
  expect(result.status).toBe(1); expect(existsSync(output)).toBe(false);
  expect(result.stdout).not.toContain('Verified private offline cohort');
});


test('real verifier failure suppresses output and cleans only its owned temporary trees', async () => {
  const f = await fixture(); const output = join(f.root, 'must-not-publish.tgz');
  const repo = resolve(import.meta.dir, '../../../../..');
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  expect(git.status).toBe(0); const commit = git.stdout.trim();
  const actualOwner = readDaemonInstallOwner(repo, commit, commit);
  await recordDaemonCiArtifact(f.source, actualOwner);
  const sentinel = join(f.root, 'daemon-private-consumer-preexisting'); mkdirSync(sentinel);
  const result = spawnSync(process.execPath, [join(import.meta.dir, '../../../scripts/package-native.ts'), '--artifact-root', f.source, '--output', output, '--source-commit', commit, '--head-commit', commit], { encoding: 'utf8', env: { ...process.env, TMPDIR: f.root }, timeout: 30_000 });
  expect(result.status).toBe(1); expect(existsSync(output)).toBe(false);
  expect(result.stdout).not.toContain('Verified private offline cohort');
  expect(readdirSync(f.root).filter(name => name.startsWith('daemon-private-') || name.startsWith('goodvibes-daemon-native-'))).toEqual(['daemon-private-consumer-preexisting']);
});
