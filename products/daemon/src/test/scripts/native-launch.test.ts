import { expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { DAEMON_CI_PAYLOADS, recordDaemonCiArtifact } from '../../../scripts/ci-artifact.ts';
import { installDaemonNative, readDaemonInstallOwner } from '../../../scripts/install-native.ts';
import { verifiedDaemonNativePath } from '../../cli/native-launch.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';
const nativeTest = process.platform === 'linux' && process.arch === 'x64' ? test : test.skip;

async function fixture(runtime = 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 17;') {
  const root = makeOwnedTempDir('daemon-owned-native-launch'); const product = join(root, 'products/daemon'); const prefix = join(root, 'owned prefix');
  for (const dir of ['scripts', 'src/cli', 'bin', 'dist/cli']) mkdirSync(join(product, dir), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nartifacts/\nowned prefix/\nfake-bin/\nfixture.json\ntrace\nstopped\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'goodvibes-jev', private: true, workspaces: ['products/*'] }));
  writeFileSync(join(product, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', private: true, version: '1.2.3', type: 'module', scripts: { 'native:run': 'sh scripts/install-native.sh run' } }));
  writeFileSync(join(product, 'tsconfig.json'), '{}');
  writeFileSync(join(product, 'dist/cli/entrypoint.js'), 'console.log("emitted-default");');
  copyFileSync(resolve(import.meta.dir, '../../../bin/goodvibes-daemon'), join(product, 'bin/goodvibes-daemon'));
  for (const file of ['install-native.ts', 'acquire-native.ts', 'run-native.ts', 'ci-artifact.ts', 'install-native.sh', 'check-bun.sh']) copyFileSync(resolve(import.meta.dir, '../../../scripts', file), join(product, 'scripts', file));
  for (const file of ['native-artifact.ts', 'native-installation.ts', 'native-launch.ts']) copyFileSync(resolve(import.meta.dir, '../../cli', file), join(product, 'src/cli', file));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) }).trim();
  git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD'); const owner = readDaemonInstallOwner(root, sha, sha);
  const engine = dirname(createRequire(import.meta.url).resolve('@goodvibes-jev/engine/package.json'));
  mkdirSync(join(root, 'node_modules/@goodvibes-jev'), { recursive: true }); symlinkSync(engine, join(root, 'node_modules/@goodvibes-jev/engine'), 'dir');
  const source = join(root, 'artifacts/products/daemon');
  for (const [index, file] of DAEMON_CI_PAYLOADS.entries()) {
    const bytes = index === 0 ? '#!/bin/sh\nexec "$0.bun" "$@"\n' : index === 1 ? `#!${process.execPath}\n${runtime}\n` : `fixture-${index}`;
    const path = join(source, 'native', file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); chmodSync(path, index < 2 ? 0o755 : 0o644);
  }
  await recordDaemonCiArtifact(source, owner);
  const launcher = join(product, 'bin/goodvibes-daemon');
  const env = { ...process.env, HOME: root, GOODVIBES_HOME: join(root, 'uncreated-home'), GOODVIBES_DAEMON_NATIVE_PREFIX: prefix };
  const invoke = (args: string[] = []) => spawnSync(process.execPath, [launcher, ...args], { cwd: root, encoding: 'utf8', env, timeout: 5000 });
  const install = () => installDaemonNative({ artifactRoot: source, prefix, owner });
  return { root, product, prefix, source, owner, launcher, env, invoke, install };
}

nativeTest('explicit owned native prefix wins over emitted/source runtimes and preserves argv and exit status', async () => {
  const f = await fixture(); await f.install(); const args = ['--help', 'one value', '--literal=$HOME'];
  const result = f.invoke(args); expect(result.status, result.stderr).toBe(17); expect(JSON.parse(result.stdout)).toEqual(args); expect(result.stderr).toBe('');
  const env = { ...f.env }; delete (env as Record<string, string | undefined>).GOODVIBES_DAEMON_NATIVE_PREFIX;
  const ordinary = spawnSync(process.execPath, [f.launcher], { env, encoding: 'utf8', timeout: 5000 });
  expect(ordinary.status).toBe(0); expect(ordinary.stdout).toBe('emitted-default\n');
  expect(existsSync(join(f.root, 'uncreated-home'))).toBe(false);
});

nativeTest('native selection refuses missing, changed, wrong-version, symlink and fenced cohorts without source fallback', async () => {
  for (const mutation of ['missing', 'changed', 'version', 'symlink', 'fence'] as const) {
    const f = await fixture(); if (mutation !== 'missing') await f.install();
    if (mutation === 'changed') writeFileSync(join(f.prefix, DAEMON_CI_PAYLOADS[4]), 'changed');
    if (mutation === 'version') writeFileSync(join(f.product, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', private: true, version: '2.0.0' }));
    if (mutation === 'symlink') { const alias = join(f.root, 'alias'); symlinkSync(f.prefix, alias); f.env.GOODVIBES_DAEMON_NATIVE_PREFIX = alias; }
    if (mutation === 'fence') writeFileSync(join(f.prefix, DAEMON_CI_PAYLOADS[1] + '.update-transaction'), 'recovery');
    const result = f.invoke(); expect(result.status, mutation).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).not.toBe('');
  }
});

nativeTest('exact requested source identity is checked independently of the product version', async () => {
  const f = await fixture(); await f.install();
  expect(verifiedDaemonNativePath(f.prefix, f.owner)).toBe(join(f.prefix, DAEMON_CI_PAYLOADS[0]));
  expect(() => verifiedDaemonNativePath(f.prefix, { ...f.owner, headCommit: 'f'.repeat(40) })).toThrow('source identity');
});

nativeTest('SIGTERM delivered to the launcher reaches its native child and leaves no detached running child', async () => {
  const f = await fixture("import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => { writeFileSync(process.env.FIXTURE_STOPPED, 'stopped'); process.exit(0); }); console.log(process.pid); setInterval(() => {}, 1000);");
  await f.install(); const stopped = join(f.root, 'stopped');
  const child = spawn(process.execPath, [f.launcher], { env: { ...f.env, FIXTURE_STOPPED: stopped }, stdio: ['ignore', 'pipe', 'pipe'] });
  let nativePid: number | undefined;
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
    const [data] = await once(child.stdout!, 'data'); nativePid = Number(String(data).trim()); expect(nativePid).toBeGreaterThan(0);
    const exited = once(child, 'exit'); child.kill('SIGTERM'); const [code] = await exited;
    expect(code).toBe(0); expect(readFileSync(stopped, 'utf8')).toBe('stopped');
    expect(() => process.kill(nativePid!, 0)).toThrow();
  } finally { clearTimeout(timer); child.kill('SIGKILL'); if (nativePid) { try { process.kill(nativePid, 'SIGKILL'); } catch {} } }
});

nativeTest('native:run explicitly repairs a missing prefix from the selected CI cohort, then reuses it without acquisition', async () => {
  const f = await fixture(); const archive = join(f.root, 'artifacts/cohort.tgz');
  execFileSync('tar', ['-czf', archive, ...[...DAEMON_CI_PAYLOADS, 'ci-artifact.json'].map(file => 'products/daemon/native/' + file)], { cwd: join(f.root, 'artifacts') });
  const bin = join(f.root, 'fake-bin'); mkdirSync(bin); const trace = join(f.root, 'trace');
  const metadata = join(f.root, 'fixture.json'); writeFileSync(metadata, JSON.stringify({ archive, sha: f.owner.headCommit, trace }));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
import { readFileSync, copyFileSync, appendFileSync } from 'node:fs'; import { join } from 'node:path';
const f = JSON.parse(readFileSync(process.env.FIXTURE_CI, 'utf8')); const args = process.argv.slice(2); const endpoint = args.at(-1); appendFileSync(f.trace, JSON.stringify(args)+'\\n');
if (args[0] === 'run') copyFileSync(f.archive, join(endpoint, 'daemon-native-linux-x64.tgz'));
else console.log(JSON.stringify(endpoint.includes('/jobs?') ? [{ jobs: ['Product tests (daemon)', 'Daemon native artifact (isolated Linux)'].map(name => ({ name, run_attempt: 1, status: 'completed', conclusion: 'success' })) }] : endpoint.includes('/artifacts?') ? [{ artifacts: [{ id: 456, name: 'daemon-native-linux-x64', expired: false, workflow_run: { head_sha: f.sha } }] }] : { id: 123, run_attempt: 1, head_sha: f.sha, path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', repository: { full_name: 'mgd34msu/goodvibes-jev' } }));
`, { mode: 0o755 });
  const args = ['run', 'native:run', '--run-id', '123', '--prefix', f.prefix, '--source-commit', f.owner.sourceCommit, '--head-commit', f.owner.headCommit, '--', 'value with spaces'];
  const invoke = () => spawnSync(process.execPath, args, { cwd: f.product, encoding: 'utf8', timeout: 5000, env: { ...f.env, PATH: bin + ':' + process.env.PATH, FIXTURE_CI: metadata } });
  const repaired = invoke(); expect(repaired.status, repaired.stderr).toBe(17); expect(JSON.parse(repaired.stdout)).toEqual(['value with spaces']);
  const calls = readFileSync(trace, 'utf8'); const reused = invoke(); expect(reused.status).toBe(17); expect(readFileSync(trace, 'utf8')).toBe(calls);
  rmSync(join(f.prefix, DAEMON_CI_PAYLOADS[4])); const refused = invoke(); expect(refused.status).toBe(1); expect(refused.stdout).toBe(''); expect(readFileSync(trace, 'utf8')).toBe(calls);
});


nativeTest('installed-like package uses emitted native support without a source checkout or installer scripts', async () => {
  const f = await fixture(); await f.install();
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  for (const file of ['native-artifact', 'native-installation', 'native-launch']) {
    const source = readFileSync(join(f.product, 'src/cli', file + '.ts'), 'utf8');
    const emitted = transpiler.transformSync(source).replace(/(native-(?:artifact|installation|launch))\.ts/g, '$1.js');
    writeFileSync(join(f.product, 'dist/cli', file + '.js'), emitted);
  }
  rmSync(join(f.product, 'src'), { recursive: true }); rmSync(join(f.product, 'scripts'), { recursive: true }); rmSync(join(f.root, 'package.json')); rmSync(join(f.product, 'tsconfig.json'));
  const result = f.invoke(['installed argument']); expect(result.status, result.stderr).toBe(17); expect(JSON.parse(result.stdout)).toEqual(['installed argument']);
});
