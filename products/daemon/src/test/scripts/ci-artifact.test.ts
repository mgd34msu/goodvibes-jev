import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { recordDaemonCiArtifact, verifyDaemonCiArtifact, type DaemonArtifactSource } from '../../../scripts/ci-artifact.ts';
import { nativeRuntimeProvenance } from '../helpers/native-runtime-provenance.ts';

const source: DaemonArtifactSource = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40) };
async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'daemon-ci-artifact-'));
  mkdirSync(join(root, 'native/lib/sqlite-vec-linux-x64'), { recursive: true });
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64'), 'synthetic executable\n', { mode: 0o755 });
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64.bun'), 'synthetic ordinary runtime', { mode: 0o755 });
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64.bun.LICENSE.md'), 'synthetic runtime notices', { mode: 0o644 });
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64.bun.json'), nativeRuntimeProvenance('synthetic ordinary runtime'), { mode: 0o644 });
  writeFileSync(join(root, 'native/lib/sqlite-vec-linux-x64/vec0.so'), 'synthetic native library\n', { mode: 0o644 });
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a tar round trip preserves the exact source, binary, library and executable modes', () => fixture(async root => {
  await recordDaemonCiArtifact(root, source);
  const manifest = JSON.parse(readFileSync(join(root, 'native/ci-artifact.json'), 'utf8'));
  expect(manifest).toMatchObject({ schema: 1, ...source, target: 'linux-x64' });
  expect(manifest.files.map((file: { path: string; mode: number }) => [file.path, file.mode])).toEqual([
    ['goodvibes-daemon-linux-x64', 0o755], ['goodvibes-daemon-linux-x64.bun', 0o755], ['goodvibes-daemon-linux-x64.bun.LICENSE.md', 0o644], ['goodvibes-daemon-linux-x64.bun.json', 0o644], ['lib/sqlite-vec-linux-x64/vec0.so', 0o644],
  ]);
  const archive = join(root, 'output.tgz');
  execFileSync('tar', ['-czf', archive, '-C', root, 'native']);
  const restored = join(root, 'restored');
  mkdirSync(restored);
  execFileSync('tar', ['-xzf', archive, '-C', restored]);
  await expect(verifyDaemonCiArtifact(restored, source)).resolves.toBeUndefined();
}));

for (const path of ['goodvibes-daemon-linux-x64', 'goodvibes-daemon-linux-x64.bun', 'goodvibes-daemon-linux-x64.bun.LICENSE.md', 'goodvibes-daemon-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so']) {
  test(`rejects changed payload bytes: ${path}`, () => fixture(async root => {
    await recordDaemonCiArtifact(root, source);
    writeFileSync(join(root, 'native', path), 'changed');
    await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('differs');
  }));
  test(`rejects symlink payload: ${path}`, () => fixture(async root => {
    const full = join(root, 'native', path);
    rmSync(full);
    symlinkSync(join(root, 'elsewhere'), full);
    await expect(recordDaemonCiArtifact(root, source)).rejects.toThrow('regular file');
  }));
}

for (const key of ['sourceCommit', 'sourceTree', 'headCommit'] as const) {
  test(`rejects a different ${key}`, () => fixture(async root => {
    await recordDaemonCiArtifact(root, source);
    await expect(verifyDaemonCiArtifact(root, { ...source, [key]: 'd'.repeat(40) })).rejects.toThrow('differs');
  }));
}

test('rejects lost execute mode, library mode changes, missing payloads and malformed source identity', () => fixture(async root => {
  await recordDaemonCiArtifact(root, source);
  chmodSync(join(root, 'native/goodvibes-daemon-linux-x64'), 0o644);
  await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('executable');
  chmodSync(join(root, 'native/goodvibes-daemon-linux-x64'), 0o755);
  chmodSync(join(root, 'native/lib/sqlite-vec-linux-x64/vec0.so'), 0o600);
  await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('differs');
  rmSync(join(root, 'native/lib/sqlite-vec-linux-x64/vec0.so'));
  await expect(recordDaemonCiArtifact(root, source)).rejects.toThrow();
  await expect(recordDaemonCiArtifact(root, { ...source, sourceTree: 'HEAD' })).rejects.toThrow('exact Git');
}));

test('the CLI refuses another checkout or modified tracked source before recording provenance', () => fixture(async root => {
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src/cli'), { recursive: true });
  writeFileSync(join(root, 'src/cli/native-artifact.ts'), readFileSync(resolve(import.meta.dir, '../../cli/native-artifact.ts')));
  writeFileSync(join(root, 'scripts/ci-artifact.ts'), readFileSync(resolve(import.meta.dir, '../../../scripts/ci-artifact.ts')));
  writeFileSync(join(root, '.gitignore'), 'native/\nnode_modules/\n');
  const engine = dirname(createRequire(import.meta.url).resolve('@goodvibes-jev/engine/package.json'));
  mkdirSync(join(root, 'node_modules/@goodvibes-jev'), { recursive: true });
  symlinkSync(engine, join(root, 'node_modules/@goodvibes-jev/engine'), 'dir');
  writeFileSync(join(root, 'source.txt'), 'committed source\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'synthetic fixture');
  const revision = git('rev-parse', 'HEAD');
  const run = (expected: string) => execFileSync(process.execPath, ['scripts/ci-artifact.ts', 'record', expected, revision], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  expect(() => run('d'.repeat(40))).toThrow();
  expect(() => run(revision)).not.toThrow();
  const recorded = readFileSync(join(root, 'native/ci-artifact.json'), 'utf8');
  expect(JSON.parse(recorded)).toMatchObject({ sourceCommit: revision, sourceTree: git('rev-parse', 'HEAD^{tree}'), headCommit: revision });
  writeFileSync(join(root, 'source.txt'), 'uncommitted replacement\n');
  expect(() => run(revision)).toThrow();
  expect(readFileSync(join(root, 'native/ci-artifact.json'), 'utf8')).toBe(recorded);
}));


for (const path of ['goodvibes-daemon-linux-x64', 'goodvibes-daemon-linux-x64.bun', 'goodvibes-daemon-linux-x64.bun.LICENSE.md', 'goodvibes-daemon-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so', 'ci-artifact.json']) {
  test(`restoration rejects a missing required file: ${path}`, () => fixture(async root => {
    await recordDaemonCiArtifact(root, source);
    rmSync(join(root, 'native', path));
    await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow();
  }));
}

test('restoration rejects runtime execute-bit loss and a tampered size manifest', () => fixture(async root => {
  await recordDaemonCiArtifact(root, source);
  chmodSync(join(root, 'native/goodvibes-daemon-linux-x64.bun'), 0o644);
  await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('executable');
  chmodSync(join(root, 'native/goodvibes-daemon-linux-x64.bun'), 0o755);
  const path = join(root, 'native/ci-artifact.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.files[0].size += 1;
  writeFileSync(path, JSON.stringify(manifest));
  await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('differs');
}));
