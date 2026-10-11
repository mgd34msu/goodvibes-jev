import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { realUpdateFileIo, UpdateTransactionError } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { DAEMON_CI_PAYLOADS, recordDaemonCiArtifact } from '../../../scripts/ci-artifact.ts';
import { assertNativeInstallHost, installDaemonNative, parseNativeInstallArgs, readDaemonInstallOwner, rollbackDaemonNative, type DaemonInstallOwner } from '../../../scripts/install-native.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const nativeTest = process.platform === 'linux' && process.arch === 'x64' ? test : test.skip;
const shellTest = process.platform === 'win32' ? test.skip : test;

const first: DaemonInstallOwner = { target: 'linux-x64', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), version: '1.2.3' };
const second: DaemonInstallOwner = { target: 'linux-x64', sourceCommit: 'd'.repeat(40), sourceTree: 'e'.repeat(40), headCommit: 'f'.repeat(40), version: '1.2.4' };
async function artifact(root: string, owner = first): Promise<void> {
  const payloads = [
    '#!/bin/sh\nexec "$(dirname "$0")/goodvibes-daemon-linux-x64.bun" "$@"\n',
    `#!/bin/sh\necho goodvibes-daemon ${owner.version}\n`,
    'synthetic runtime license ' + owner.version,
    JSON.stringify({ syntheticRuntime: owner.version }),
    'synthetic vector addon ' + owner.version,
  ];
  for (const [index, path] of DAEMON_CI_PAYLOADS.entries()) {
    const file = join(root, 'native', path); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, payloads[index]!); chmodSync(file, index < 2 ? 0o755 : 0o644);
  }
  await recordDaemonCiArtifact(root, owner);
}
async function fixture() {
  const root = makeOwnedTempDir('daemon-native-install');
  const source = join(root, 'source'); const prefix = join(root, 'temporary prefix');
  await artifact(source);
  return { root, source, prefix, install: (owner = first) => installDaemonNative({ artifactRoot: source, prefix, owner }) };
}
function state(prefix: string): string[] {
  return [...DAEMON_CI_PAYLOADS, 'daemon-installation.json'].map(file => readFileSync(join(prefix, file), 'utf8'));
}
function transientFiles(prefix: string): string[] {
  return readdirSync(prefix, { recursive: true }).filter((path): path is string => typeof path === 'string')
    .filter(path => /\.(?:update-download|update-previous|update-transaction|rollback-exchange)$/.test(path));
}

nativeTest('offline first installation preserves the exact cohort and executable companions in a foreign temporary prefix', async () => {
  const f = await fixture(); await f.install();
  for (const [index, file] of DAEMON_CI_PAYLOADS.entries()) {
    expect(readFileSync(join(f.prefix, file))).toEqual(readFileSync(join(f.source, 'native', file)));
    expect(statSync(join(f.prefix, file)).mode & 0o777).toBe(index < 2 ? 0o755 : 0o644);
  }
  const result = spawnSync(join(f.prefix, DAEMON_CI_PAYLOADS[0]), ['--version'], { cwd: f.root, encoding: 'utf8' });
  expect(result.status).toBe(0); expect(result.stdout).toBe('goodvibes-daemon 1.2.3\n');
  expect(JSON.parse(readFileSync(join(f.prefix, 'daemon-installation.json'), 'utf8'))).toMatchObject({ packageName: '@goodvibes-jev/daemon', version: first.version, artifact: { sourceCommit: first.sourceCommit } });
  expect(transientFiles(f.prefix)).toEqual([]);
});

nativeTest('upgrade, idempotent retry and full kept-previous rollback retain one coherent receipt/artifact cohort', async () => {
  const f = await fixture(); await f.install(); const old = state(f.prefix);
  await artifact(f.source, second); await f.install(second); const newer = state(f.prefix);
  expect(newer).not.toEqual(old);
  const previous = readFileSync(join(f.prefix, 'daemon-installation.json.previous'), 'utf8');
  await f.install(second);
  expect(readFileSync(join(f.prefix, 'daemon-installation.json.previous'), 'utf8')).toBe(previous);
  expect(state(f.prefix)).toEqual(newer);
  rollbackDaemonNative(f.prefix); expect(state(f.prefix)).toEqual(old);
  rollbackDaemonNative(f.prefix); expect(state(f.prefix)).toEqual(newer);
  expect(transientFiles(f.prefix)).toEqual([]);
});

nativeTest('changed/missing/symlink source bytes and mismatched expected source identity refuse before prefix writes', async () => {
  for (const mutation of ['changed', 'missing', 'symlink', 'wrong-source'] as const) {
    const f = await fixture(); const file = join(f.source, 'native', DAEMON_CI_PAYLOADS[4]);
    if (mutation === 'changed') writeFileSync(file, 'tampered');
    if (mutation === 'missing') rmSync(file);
    if (mutation === 'symlink') { rmSync(file); symlinkSync(join(f.source, 'native', DAEMON_CI_PAYLOADS[2]), file); }
    await expect(f.install(mutation === 'wrong-source' ? second : first)).rejects.toThrow();
    expect(existsSync(f.prefix)).toBe(false);
  }
});

nativeTest('unsafe prefixes, noncanonical modes, unsupported hosts, aborted requests and implicit arguments refuse', async () => {
  const f = await fixture();
  for (const prefix of ['relative', f.source, join(f.source, 'nested'), f.root]) {
    await expect(installDaemonNative({ artifactRoot: f.source, prefix, owner: first })).rejects.toThrow();
  }
  const alias = join(f.root, 'alias'); symlinkSync(f.source, alias, 'dir');
  await expect(installDaemonNative({ artifactRoot: f.source, prefix: alias, owner: first })).rejects.toThrow('symlink');
  chmodSync(join(f.source, 'native', DAEMON_CI_PAYLOADS[4]), 0o600); await recordDaemonCiArtifact(f.source, first);
  await expect(f.install()).rejects.toThrow('modes');
  await artifact(f.source);
  await expect(installDaemonNative({ artifactRoot: f.source, prefix: f.prefix, owner: first, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(existsSync(f.prefix)).toBe(false);
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'ia32']]) expect(() => assertNativeInstallHost(platform, arch)).toThrow('linux-x64');
  for (const args of [[], ['install'], ['rollback', '--prefix', f.prefix, '--head-commit', first.headCommit], ['rollback', '--prefix', f.prefix, '--prefix', f.prefix]]) expect(() => parseNativeInstallArgs(args)).toThrow('Usage');
});

nativeTest('unowned target files are not adopted and failed cohort commit compensates to the previous installation', async () => {
  const f = await fixture(); mkdirSync(f.prefix);
  writeFileSync(join(f.prefix, DAEMON_CI_PAYLOADS[0]), 'unowned file');
  await expect(f.install()).rejects.toThrow(); expect(readFileSync(join(f.prefix, DAEMON_CI_PAYLOADS[0]), 'utf8')).toBe('unowned file');
  rmSync(f.prefix, { recursive: true }); await f.install(); const before = state(f.prefix);
  await artifact(f.source, second); let failed = false;
  await expect(installDaemonNative({ artifactRoot: f.source, prefix: f.prefix, owner: second, io: {
    ...realUpdateFileIo,
    rename(from, to) {
      if (!failed && from.endsWith('daemon-installation.json.update-download')) { failed = true; throw new Error('synthetic commit failure'); }
      realUpdateFileIo.rename(from, to);
    },
  } })).rejects.toThrow('synthetic commit failure');
  expect(failed).toBe(true); expect(state(f.prefix)).toEqual(before); expect(transientFiles(f.prefix)).toEqual([]);
  await f.install(second); expect(state(f.prefix)).not.toEqual(before);
});

nativeTest('rollback checks complete previous bytes while all canonical transaction claims are held', async () => {
  const f = await fixture(); await f.install(); await artifact(f.source, second); await f.install(second);
  const before = state(f.prefix); let claims = 0;
  const victim = join(f.prefix, DAEMON_CI_PAYLOADS[4] + '.previous');
  expect(() => rollbackDaemonNative(f.prefix, {
    ...realUpdateFileIo,
    writeExclusive(path, bytes) {
      realUpdateFileIo.writeExclusive!(path, bytes);
      if (++claims === DAEMON_CI_PAYLOADS.length + 1) writeFileSync(victim, 'changed after last claim');
    },
  })).toThrow('checksum mismatch');
  expect(claims).toBe(DAEMON_CI_PAYLOADS.length + 1); expect(state(f.prefix)).toEqual(before);
  expect(transientFiles(f.prefix)).toEqual([]);
});

nativeTest('a missing previous member and leftover recovery fence never produce a partial rollback or blind retry', async () => {
  const f = await fixture(); await f.install();
  expect(() => rollbackDaemonNative(f.prefix)).toThrow('previous');
  await artifact(f.source, second); await f.install(second); const before = state(f.prefix);
  rmSync(join(f.prefix, DAEMON_CI_PAYLOADS[3] + '.previous'));
  expect(() => rollbackDaemonNative(f.prefix)).toThrow(); expect(state(f.prefix)).toEqual(before);
  const fence = join(f.prefix, DAEMON_CI_PAYLOADS[0] + '.update-transaction'); writeFileSync(fence, 'retained recovery evidence');
  try { await f.install(second); throw new Error('expected fenced refusal'); }
  catch (error) { expect(error).toBeInstanceOf(UpdateTransactionError); expect((error as UpdateTransactionError).receipt.recoveryRequired).toBe(true); }
  expect(readFileSync(fence, 'utf8')).toBe('retained recovery evidence'); expect(state(f.prefix)).toEqual(before);
});

nativeTest('selected Git source manifest supplies product/version ownership, independent of root version', () => {
  const root = makeOwnedTempDir('daemon-install-owner'); mkdirSync(join(root, 'products/daemon'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'goodvibes-jev', version: '9.0.0' }));
  writeFileSync(join(root, 'products/daemon/package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', private: true, version: '1.2.3' }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) }).trim();
  git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD'); const owner = readDaemonInstallOwner(root, sha, sha);
  expect(owner).toEqual({ target: 'linux-x64', sourceCommit: sha, headCommit: sha, sourceTree: git('rev-parse', 'HEAD^{tree}'), version: '1.2.3' });
  writeFileSync(join(root, 'products/daemon/package.json'), '{"version":"changed working tree"}');
  expect(readDaemonInstallOwner(root, sha, sha)).toEqual(owner);
  writeFileSync(join(root, 'products/daemon/package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', private: true, version: '2.0.0' }));
  git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'replacement fixture');
  git('replace', sha, git('rev-parse', 'HEAD'));
  expect(readDaemonInstallOwner(root, sha, sha)).toEqual(owner);
  expect(() => readDaemonInstallOwner(root, 'HEAD', sha)).toThrow('exact');
});


nativeTest('the actual product install CLI consumes a selected source revision into a temporary prefix without registry or service setup', async () => {
  const root = makeOwnedTempDir('daemon-install-cli'); const product = join(root, 'products/daemon');
  mkdirSync(join(product, 'scripts'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nartifacts/\nprefix/\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'goodvibes-jev', private: true, version: '9.0.0', workspaces: ['products/*'] }));
  writeFileSync(join(product, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', private: true, version: '1.2.3', type: 'module', scripts: { 'native:install': 'sh scripts/install-native.sh install' } }));
  for (const file of ['install-native.ts', 'ci-artifact.ts', 'install-native.sh', 'check-bun.sh']) writeFileSync(join(product, 'scripts', file), readFileSync(resolve(import.meta.dir, '../../../scripts', file)));
  mkdirSync(join(product, 'src/cli'), { recursive: true });
  for (const name of ['native-artifact.ts', 'native-installation.ts']) writeFileSync(join(product, 'src/cli', name), readFileSync(resolve(import.meta.dir, '../../cli', name)));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) }).trim();
  git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD'); const owner = readDaemonInstallOwner(root, sha, sha);
  const engine = dirname(createRequire(import.meta.url).resolve('@goodvibes-jev/engine/package.json'));
  mkdirSync(join(root, 'node_modules/@goodvibes-jev'), { recursive: true }); symlinkSync(engine, join(root, 'node_modules/@goodvibes-jev/engine'), 'dir');
  const source = join(root, 'artifacts'); const prefix = join(root, 'prefix'); await artifact(source, owner);
  const result = spawnSync(process.execPath, ['run', 'native:install', '--artifact-root', source, '--prefix', prefix, '--source-commit', sha, '--head-commit', sha], { cwd: product, encoding: 'utf8', timeout: 5000 });
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('No service or automatic updater was configured');
  expect(JSON.parse(readFileSync(join(prefix, 'daemon-installation.json'), 'utf8')).version).toBe('1.2.3');
  expect(git('status', '--porcelain')).toBe('');
  const fence = join(prefix, DAEMON_CI_PAYLOADS[0] + '.update-transaction'); writeFileSync(fence, 'interrupted evidence');
  const refused = spawnSync(process.execPath, ['run', 'native:install', '--artifact-root', source, '--prefix', prefix, '--source-commit', sha, '--head-commit', sha], { cwd: product, encoding: 'utf8', timeout: 5000 });
  expect(refused.status).toBe(1); expect(refused.stderr).toContain('"recoveryRequired":true'); expect(refused.stderr).toContain('"recoveryPaths"');
  expect(readFileSync(fence, 'utf8')).toBe('interrupted evidence');
});


shellTest('shell prerequisite reports missing/broken Bun and the actual installer shim preserves argv and status', () => {
  const root = makeOwnedTempDir('daemon-install-bun'); const bin = join(root, 'bin'); mkdirSync(bin);
  const shim = resolve(import.meta.dir, '../../../scripts/install-native.sh');
  const env = { ...process.env, PATH: bin, FIXTURE_ARGV: join(root, 'argv') };
  const run = () => spawnSync('/bin/sh', [shim, 'rollback', '--prefix', join(root, 'prefix with spaces')], { env, encoding: 'utf8', timeout: 5000 });
  const missing = run(); expect(missing.status).toBe(1); expect(missing.stderr).toContain('requires Bun on PATH'); expect(existsSync(env.FIXTURE_ARGV)).toBe(false);
  const bun = join(bin, 'bun'); writeFileSync(bun, '#!/bin/sh\nexit 17\n', { mode: 0o755 });
  const broken = run(); expect(broken.status).toBe(1); expect(broken.stderr).toContain('working Bun executable');
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nprintf "%s\\n" "$@" > "$FIXTURE_ARGV"\nexit 23\n');
  const working = run(); expect(working.status).toBe(23); expect(working.stderr).toBe('');
  expect(readFileSync(env.FIXTURE_ARGV, 'utf8').split('\n').filter(Boolean)).toEqual([resolve(import.meta.dir, '../../../scripts/install-native.ts'), 'rollback', '--prefix', join(root, 'prefix with spaces')]);
});


test('native host admission is explicit and does not claim unqualified platform support', () => {
  expect(() => assertNativeInstallHost('linux', 'x64')).not.toThrow();
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'ia32']]) {
    expect(() => assertNativeInstallHost(platform, arch)).toThrow('linux-x64');
  }
});


nativeTest('install admission preserves and refuses unowned, corrupt, partial or orphaned previous cohorts', async () => {
  for (const mutation of ['unowned', 'corrupt', 'partial', 'no-op', 'orphan'] as const) {
    const f = await fixture(); await f.install();
    await artifact(f.source, second); await f.install(second);
    const previousPayload = join(f.prefix, DAEMON_CI_PAYLOADS[0] + '.previous');
    if (mutation === 'unowned') writeFileSync(join(f.prefix, 'daemon-installation.json.previous'), '{}');
    if (mutation === 'corrupt' || mutation === 'no-op') writeFileSync(previousPayload, 'unowned previous bytes');
    if (mutation === 'partial') rmSync(previousPayload);
    if (mutation === 'orphan') for (const file of [...DAEMON_CI_PAYLOADS, 'daemon-installation.json']) rmSync(join(f.prefix, file));
    const snapshot = () => readdirSync(f.prefix, { recursive: true }).filter((path): path is string => typeof path === 'string')
      .filter(path => statSync(join(f.prefix, path)).isFile()).sort()
      .map(path => [path, readFileSync(join(f.prefix, path)).toString('hex'), statSync(join(f.prefix, path)).mode & 0o777]);
    const before = snapshot();
    if (mutation !== 'no-op') await artifact(f.source, first);
    await expect(f.install(mutation === 'no-op' ? second : first)).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expect(transientFiles(f.prefix)).toEqual([]);
  }
});
