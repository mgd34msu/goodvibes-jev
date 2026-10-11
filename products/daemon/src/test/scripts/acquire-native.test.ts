import { gunzipSync, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DAEMON_CI_PAYLOADS, recordDaemonCiArtifact } from '../../../scripts/ci-artifact.ts';
import { acquireDaemonNative, DAEMON_CI_REPOSITORY, stageDaemonCiArchive, type RunGitHub } from '../../../scripts/acquire-native.ts';
import { readDaemonInstallOwner, type DaemonInstallOwner } from '../../../scripts/install-native.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const nativeTest = process.platform === 'linux' && process.arch === 'x64' ? test : test.skip;
const owner: DaemonInstallOwner = { target: 'linux-x64', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), version: '1.2.3' };
async function fixture() {
  const root = makeOwnedTempDir('daemon-ci-acquisition'); const source = join(root, 'products/daemon');
  for (const [index, path] of DAEMON_CI_PAYLOADS.entries()) {
    const full = join(source, 'native', path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, `synthetic-${index}`); chmodSync(full, index < 2 ? 0o755 : 0o644);
  }
  await recordDaemonCiArtifact(source, owner);
  const archive = join(root, 'native.tgz');
  const pack = () => execFileSync('tar', ['-czf', archive, ...[...DAEMON_CI_PAYLOADS, 'ci-artifact.json'].map(path => `products/daemon/native/${path}`)], { cwd: root });
  pack();
  const run = { id: 123, run_attempt: 1, head_sha: owner.headCommit, path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', repository: { full_name: DAEMON_CI_REPOSITORY } };
  const jobs = ['Product tests (daemon)', 'Daemon native artifact (isolated Linux)'].map(name => ({ name, run_attempt: 1, status: 'completed', conclusion: 'success' }));
  const artifact = { id: 456, name: 'daemon-native-linux-x64', expired: false, workflow_run: { head_sha: owner.headCommit } };
  const calls: string[][] = []; let downloadDir: string | undefined;
  const gh: RunGitHub = args => {
    calls.push([...args]); const endpoint = args[args.length - 1]!;
    if (args[0] === 'run') { downloadDir = endpoint; copyFileSync(archive, join(downloadDir, 'daemon-native-linux-x64.tgz')); return ''; }
    if (endpoint.includes('/jobs?')) return JSON.stringify([{ jobs }]);
    if (endpoint.includes('/artifacts?')) return JSON.stringify([{ artifacts: [artifact] }]);
    return JSON.stringify(run);
  };
  return { root, source, archive, pack, run, jobs, artifact, calls, gh, downloaded: () => downloadDir, prefix: join(root, 'installed prefix') };
}

nativeTest('exact successful CI acquisition stages only the owned cohort then uses the verified installer', async () => {
  const f = await fixture(); await acquireDaemonNative({ runId: '123', prefix: f.prefix, owner, gh: f.gh });
  for (const path of DAEMON_CI_PAYLOADS) expect(readFileSync(join(f.prefix, path))).toEqual(readFileSync(join(f.source, 'native', path)));
  expect(JSON.parse(readFileSync(join(f.prefix, 'daemon-installation.json'), 'utf8')).version).toBe(owner.version);
  expect(f.calls.find(args => args[0] === 'run')).toEqual(['run', 'download', '123', '--repo', `https://github.com/${DAEMON_CI_REPOSITORY}`, '--name', 'daemon-native-linux-x64', '--dir', f.downloaded()!]);
  expect(existsSync(f.downloaded()!)).toBe(false);
});

nativeTest('wrong workflow/repository/head/run, skipped qualification and expired artifact refuse before acquisition', async () => {
  for (const mutation of ['run', 'workflow', 'repo', 'head', 'pending', 'failed', 'job-skipped', 'job-missing', 'job-attempt', 'expired', 'artifact-head'] as const) {
    const f = await fixture();
    if (mutation === 'run') f.run.id++;
    if (mutation === 'workflow') f.run.path = '.github/workflows/other.yml';
    if (mutation === 'repo') f.run.repository.full_name = 'other/repo';
    if (mutation === 'head') f.run.head_sha = owner.sourceCommit;
    if (mutation === 'pending') f.run.status = 'in_progress';
    if (mutation === 'failed') f.run.conclusion = 'failure';
    if (mutation === 'job-skipped') f.jobs[1]!.conclusion = 'skipped';
    if (mutation === 'job-missing') f.jobs.pop();
    if (mutation === 'job-attempt') f.jobs[1]!.run_attempt = 2;
    if (mutation === 'expired') f.artifact.expired = true;
    if (mutation === 'artifact-head') f.artifact.workflow_run.head_sha = owner.sourceCommit;
    await expect(acquireDaemonNative({ runId: '123', prefix: f.prefix, owner, gh: f.gh })).rejects.toThrow();
    expect(existsSync(f.prefix)).toBe(false); expect(f.calls.some(args => args[0] === 'run')).toBe(false);
  }
});

nativeTest('changed attempts/artifact identity, payload corruption and cancellation cannot touch an installation', async () => {
  for (const mutation of ['attempt', 'artifact-id', 'payload', 'abort'] as const) {
    const f = await fixture(); const abort = new AbortController();
    if (mutation === 'payload') { writeFileSync(join(f.source, 'native', DAEMON_CI_PAYLOADS[4]), 'bad'); f.pack(); }
    const gh: RunGitHub = args => { const result = f.gh(args); if (args[0] === 'run') {
      if (mutation === 'attempt') f.run.run_attempt++;
      if (mutation === 'artifact-id') f.artifact.id++;
      if (mutation === 'abort') abort.abort();
    } return result; };
    await expect(acquireDaemonNative({ runId: '123', prefix: f.prefix, owner, gh, signal: abort.signal })).rejects.toThrow();
    expect(existsSync(f.prefix)).toBe(false); expect(existsSync(f.downloaded()!)).toBe(false);
  }
});

nativeTest('archive admission refuses missing, duplicate, extra, symlink and executable receipt entries before extraction', async () => {
  for (const mutation of ['missing', 'duplicate', 'extra', 'symlink', 'mode'] as const) {
    const f = await fixture(); const names = [...DAEMON_CI_PAYLOADS, 'ci-artifact.json'].map(path => `products/daemon/native/${path}`);
    if (mutation === 'missing') names.pop();
    if (mutation === 'duplicate') names.push(names[0]!);
    if (mutation === 'extra') { writeFileSync(join(f.root, 'extra'), 'outside'); names.push('extra'); }
    if (mutation === 'symlink') { rmSync(join(f.root, names[0]!)); symlinkSync('/etc/passwd', join(f.root, names[0]!)); }
    if (mutation === 'mode') chmodSync(join(f.source, 'native/ci-artifact.json'), 0o755);
    execFileSync('tar', ['-czf', f.archive, ...names], { cwd: f.root });
    const staged = join(f.root, 'stage'); expect(() => stageDaemonCiArchive(readFileSync(f.archive), staged)).toThrow(); expect(existsSync(staged)).toBe(false);
  }
});

nativeTest('download failures, invalid selectors and duplicate artifacts never silently select latest or a fallback source', async () => {
  for (const value of ['latest', '0', '-1', '1/../../other', '9007199254740992']) {
    const f = await fixture(); await expect(acquireDaemonNative({ runId: value, prefix: f.prefix, owner, gh: f.gh })).rejects.toThrow('run ID'); expect(f.calls).toEqual([]);
  }
  const f = await fixture();
  const gh: RunGitHub = args => args.at(-1)?.includes('/artifacts?') ? JSON.stringify([{ artifacts: [f.artifact, f.artifact] }]) : f.gh(args);
  await expect(acquireDaemonNative({ runId: '123', prefix: f.prefix, owner, gh })).rejects.toThrow('one unexpired');
  expect(existsSync(f.prefix)).toBe(false);
});


nativeTest('download failure and unexpected restored layout clean temporary state without changing the destination', async () => {
  for (const mutation of ['throw', 'extra', 'symlink'] as const) {
    const f = await fixture();
    const gh: RunGitHub = args => { const result = f.gh(args); if (args[0] === 'run') {
      if (mutation === 'throw') throw new Error('synthetic download failure');
      if (mutation === 'extra') writeFileSync(join(f.downloaded()!, 'extra'), 'unexpected');
      if (mutation === 'symlink') { const archive = join(f.downloaded()!, 'daemon-native-linux-x64.tgz'); rmSync(archive); symlinkSync(f.archive, archive); }
    } return result; };
    await expect(acquireDaemonNative({ runId: '123', prefix: f.prefix, owner, gh })).rejects.toThrow();
    expect(existsSync(f.prefix)).toBe(false); expect(existsSync(f.downloaded()!)).toBe(false);
  }
  const f = await fixture();
  await expect(acquireDaemonNative({ runId: '123', prefix: 'relative', owner, gh: f.gh })).rejects.toThrow('absolute');
  await expect(acquireDaemonNative({ runId: '123', prefix: f.prefix, owner, gh: f.gh, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

nativeTest('actual native:acquire CLI uses the fixed CI owner and immutable product source version with a fixture gh executable', async () => {
  const f = await fixture(); mkdirSync(join(f.source, 'scripts'));
  writeFileSync(join(f.root, '.gitignore'), 'node_modules/\nproducts/daemon/native/\nnative.tgz\ninstalled prefix/\nfake-bin/\nfixture.json\n');
  writeFileSync(join(f.source, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', private: true, version: '1.2.3', type: 'module', scripts: { 'native:acquire': 'sh scripts/install-native.sh acquire' } }));
  for (const name of ['acquire-native.ts', 'install-native.ts', 'ci-artifact.ts', 'install-native.sh', 'check-bun.sh']) copyFileSync(resolve(import.meta.dir, '../../../scripts', name), join(f.source, 'scripts', name));
  mkdirSync(join(f.source, 'src/cli'), { recursive: true });
  for (const name of ['native-artifact.ts', 'native-installation.ts']) writeFileSync(join(f.source, 'src/cli', name), readFileSync(resolve(import.meta.dir, '../../cli', name)));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: f.root, encoding: 'utf8', stdio: 'pipe', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) }).trim();
  git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD'); const selected = readDaemonInstallOwner(f.root, sha, sha);
  await recordDaemonCiArtifact(f.source, selected); f.pack(); f.run.head_sha = sha; f.artifact.workflow_run.head_sha = sha;
  const engine = dirname(createRequire(import.meta.url).resolve('@goodvibes-jev/engine/package.json'));
  mkdirSync(join(f.root, 'node_modules/@goodvibes-jev'), { recursive: true }); symlinkSync(engine, join(f.root, 'node_modules/@goodvibes-jev/engine'), 'dir');
  const bin = join(f.root, 'fake-bin'); mkdirSync(bin);
  const metadata = join(f.root, 'fixture.json'); writeFileSync(metadata, JSON.stringify({ run: f.run, jobs: f.jobs, artifact: f.artifact, archive: f.archive }));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
import { readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const fixture = JSON.parse(readFileSync(process.env.FIXTURE_CI, 'utf8'));
const args = process.argv.slice(2); const endpoint = args.at(-1);
if (args[0] === 'run') {
  if (args[args.indexOf('--repo') + 1] !== 'https://github.com/mgd34msu/goodvibes-jev') process.exit(19);
  copyFileSync(fixture.archive, join(endpoint, 'daemon-native-linux-x64.tgz'));
} else if (args[0] === 'api' && args[1] === '--hostname' && args[2] === 'github.com') {
  console.log(JSON.stringify(endpoint.includes('/jobs?') ? [{ jobs: fixture.jobs }] : endpoint.includes('/artifacts?') ? [{ artifacts: [fixture.artifact] }] : fixture.run));
} else process.exit(20);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ['run', 'native:acquire', '--run-id', '123', '--prefix', f.prefix, '--source-commit', sha, '--head-commit', sha], {
    cwd: f.source, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: bin + ':' + process.env.PATH, FIXTURE_CI: metadata },
  });
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('Qualified CI cohort installed');
  expect(JSON.parse(readFileSync(join(f.prefix, 'daemon-installation.json'), 'utf8')).artifact.sourceCommit).toBe(sha);
  expect(git('status', '--porcelain')).toBe('');
});


nativeTest('corrupt tar headers and trailing garbage refuse before any extraction', async () => {
  const f = await fixture(); const tar = gunzipSync(readFileSync(f.archive));
  const header = Buffer.from(tar); header[148] = 0x37;
  for (const bytes of [header, Buffer.concat([tar, Buffer.from('trailing garbage')])]) {
    const staged = join(f.root, 'stage');
    expect(() => stageDaemonCiArchive(gzipSync(bytes), staged)).toThrow(); expect(existsSync(staged)).toBe(false);
  }
});
