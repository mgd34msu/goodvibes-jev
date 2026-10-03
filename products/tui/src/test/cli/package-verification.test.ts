import { afterEach, describe, expect, test } from 'bun:test';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { resolveWorkspaceBinary, workspaceBinaryCandidates } from '../../cli/workspace-binary.ts';
import { parseNpmPackJson, verifyPackageCliInstall } from '../../cli/package-verification.ts';

const productRoot = resolve(import.meta.dir, '../../..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspaceFixture(): string {
  const root = makeProjectTempDir('gv-private-install-contract'); roots.push(root);
  const manifest = JSON.parse(readFileSync(join(productRoot, 'package.json'), 'utf8'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  for (const path of ['README.md', 'CHANGELOG.md', 'scripts/check-bun.sh', 'scripts/postinstall.js', 'bin/goodvibes', 'src/cli/workspace-binary.ts']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(productRoot, path), join(root, path));
  }
  // A source fallback would fail loudly, never start a real application in this fixture.
  writeFileSync(join(root, 'src/main.ts'), 'throw new Error("fixture source entrypoint must not run");');
  chmodSync(join(root, 'bin/goodvibes'), 0o755);
  return root;
}

function executable(path: string, label = 'native', exitCode = 0): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf '${label}:%s\n' "$*"\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
}

function launch(root: string, args: string[] = []) {
  const child = Bun.spawnSync([join(root, 'bin/goodvibes'), ...args], {
    cwd: root, env: { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), HOME: root },
    stdout: 'pipe', stderr: 'pipe',
  });
  return { code: child.exitCode, stdout: new TextDecoder().decode(child.stdout), stderr: new TextDecoder().decode(child.stderr) };
}

describe('private workspace package verification', () => {
  test('validates actual private identity, one launcher, packed source and an executable local build', () => {
    const root = workspaceFixture();
    const [native] = workspaceBinaryCandidates(root);
    executable(native!);
    const report = verifyPackageCliInstall(root);
    expect(report.packageName).toBe('@goodvibes-jev/tui');
    expect(report.distribution).toBe('private-workspace');
    expect(report.issues).toEqual([]);
    expect(report.bins.map(bin => bin.command)).toEqual(['goodvibes']);
    expect(report.bins.every(bin => bin.exists && bin.executable && bin.usesBunShebang)).toBe(true);
    expect(report.workspace?.selectedBinary).toBe(native!);
    expect(report.tarball.requiredPathsPresent).toContain('src/cli/workspace-binary.ts');
    expect(report.tarball.requiredPathsPresent).toContain('scripts/check-bun.sh');
    expect(report.tarball.forbiddenPaths).toEqual([]);
    expect(report.issues.join(' ')).not.toMatch(/vendor|source fallback|GOODVIBES.md/);
  }, 30_000);

  test('reports a missing local build without requiring retired public fallback assets', () => {
    const root = workspaceFixture();
    const report = verifyPackageCliInstall(root);
    expect(report.workspace?.selectedBinary).toBeNull();
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toContain('private workspace has no executable build');
  }, 30_000);

  test('generic builds are valid and non-executable native files cannot shadow them', () => {
    const root = workspaceFixture();
    const [native, generic] = workspaceBinaryCandidates(root);
    executable(native!); chmodSync(native!, 0o644);
    executable(generic!, 'generic');
    expect(resolveWorkspaceBinary(root)).toBe(generic!);
    expect(verifyPackageCliInstall(root).issues).toEqual([]);
  }, 30_000);

  test('a directory named like a binary cannot pass verification', () => {
    const root = workspaceFixture();
    mkdirSync(workspaceBinaryCandidates(root)[0]!, { recursive: true });
    expect(resolveWorkspaceBinary(root)).toBeUndefined();
    expect(verifyPackageCliInstall(root).issues.some(issue => issue.includes('no executable build'))).toBe(true);
  }, 30_000);

  test('launcher and tarball checks remain enforced for a private workspace', () => {
    const root = workspaceFixture(); executable(workspaceBinaryCandidates(root)[0]!);
    writeFileSync(join(root, 'bin/goodvibes'), 'invalid launcher'); chmodSync(join(root, 'bin/goodvibes'), 0o644);
    rmSync(join(root, 'src/cli/workspace-binary.ts'));
    const report = verifyPackageCliInstall(root);
    expect(report.issues).toContain('bin target is not executable: goodvibes -> bin/goodvibes');
    expect(report.issues).toContain('bin target does not use Bun shebang: goodvibes -> bin/goodvibes');
    expect(report.issues).toContain('npm tarball missing required path: src/cli/workspace-binary.ts');
  }, 30_000);

  test('private mode still rejects extra bin entries and forbidden packed content', () => {
    const root = workspaceFixture(); executable(workspaceBinaryCandidates(root)[0]!);
    const path = join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.bin['goodvibes-daemon'] = 'bin/goodvibes';
    manifest.files.push('vendor');
    writeFileSync(path, JSON.stringify(manifest));
    mkdirSync(join(root, 'vendor')); writeFileSync(join(root, 'vendor', 'fixture.txt'), 'synthetic');
    const report = verifyPackageCliInstall(root);
    expect(report.issues).toContain('package.json exposes unsupported bin entry: goodvibes-daemon');
    expect(report.tarball.forbiddenPaths).toContain('vendor/fixture.txt');
    expect(report.issues).toContain('npm tarball includes forbidden path: vendor/fixture.txt');
  }, 30_000);

  test('published-package fallback requirements are not relaxed by the private branch', () => {
    const root = workspaceFixture();
    const path = join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')); manifest.private = false;
    writeFileSync(path, JSON.stringify(manifest));
    const report = verifyPackageCliInstall(root);
    expect(report.distribution).toBe('published-package');
    expect(report.workspace).toBeUndefined();
    expect(report.issues).toContain('bin target lacks vendored binary fallback: goodvibes');
    expect(report.issues).toContain('bin target lacks Bun source fallback: goodvibes');
    expect(report.issues).toContain('npm tarball missing required path: .goodvibes/GOODVIBES.md');
  }, 30_000);
});

describe('actual private launcher contract', () => {
  test('every configured build artifact agrees with the launcher resolver', () => {
    const config = JSON.parse(readFileSync(join(productRoot, 'toolchain.config.json'), 'utf8')) as { build: { targets: Array<{ key: string; appArtifact: string }> } };
    for (const target of config.build.targets) {
      const [platform, arch] = target.key.split('-');
      const hostPlatform = platform === 'windows' ? 'win32' : platform;
      expect(basename(workspaceBinaryCandidates('/fixture', hostPlatform as NodeJS.Platform, arch!)[0]!)).toBe(target.appArtifact);
    }
  });

  test.skipIf(process.platform === 'win32')('prefers native, falls back to generic, and forwards arguments and child exit status', () => {
    const root = workspaceFixture();
    const [native, generic] = workspaceBinaryCandidates(root);
    executable(native!, 'native', 17); executable(generic!, 'generic', 23);
    expect(launch(root, ['--fixture', 'two words'])).toEqual({ code: 17, stdout: 'native:--fixture two words\n', stderr: '' });
    rmSync(native!);
    expect(launch(root, ['--fixture'])).toEqual({ code: 23, stdout: 'generic:--fixture\n', stderr: '' });
  });

  test.skipIf(process.platform === 'win32')('missing builds refuse without running a vendor or source fallback', () => {
    const root = workspaceFixture();
    executable(join(root, 'vendor', 'goodvibes'), 'vendor-must-not-run');
    const result = launch(root, ['--version']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('private Jev workspace has no built TUI binary');
    expect(result.stderr).toContain('bun run --filter @goodvibes-jev/tui build');
    expect(result.stderr).not.toContain('fixture source entrypoint must not run');
  });

  test('artifact naming matches each supported platform convention', () => {
    expect(workspaceBinaryCandidates('/fixture', 'linux', 'x64')).toEqual([join('/fixture', 'dist', 'goodvibes-linux-x64'), join('/fixture', 'dist', 'goodvibes')]);
    expect(workspaceBinaryCandidates('/fixture', 'darwin', 'arm64')).toEqual([join('/fixture', 'dist', 'goodvibes-macos-arm64'), join('/fixture', 'dist', 'goodvibes')]);
    expect(workspaceBinaryCandidates('/fixture', 'win32', 'x64')).toEqual([join('/fixture', 'dist', 'goodvibes-windows-x64.exe'), join('/fixture', 'dist', 'goodvibes.exe')]);
  });
});

describe('npm pack --json output parsing', () => {
  const arrayShape = JSON.stringify([
    { id: 'pkg@1.0.0', name: 'pkg', unpackedSize: 42, entryCount: 2, files: [{ path: 'README.md' }, { path: 'package.json' }] },
  ]);
  const objectShape = JSON.stringify({
    pkg: { id: 'pkg@1.0.0', name: 'pkg', unpackedSize: 42, entryCount: 2, files: [{ path: 'README.md' }, { path: 'package.json' }] },
  });

  test('reads the array shape emitted by npm 10 and npm 11', () => {
    expect(parseNpmPackJson(arrayShape)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('reads the package-name-keyed object shape emitted by npm 12', () => {
    expect(parseNpmPackJson(objectShape)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('reads a bare pack-result object', () => {
    expect(parseNpmPackJson(JSON.stringify({ entryCount: 1, unpackedSize: 7, files: [{ path: 'a.txt' }] }))).toEqual({
      files: ['a.txt'],
      entryCount: 1,
      unpackedSize: 7,
    });
  });

  test('ignores npm notice lines printed around the JSON document', () => {
    const noisy = `npm notice run \`npm audit\` for details\n${objectShape}\nnpm notice done\n`;
    expect(parseNpmPackJson(noisy)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('keeps braces inside file paths from truncating the document', () => {
    const braced = JSON.stringify({ pkg: { entryCount: 1, unpackedSize: 3, files: [{ path: 'src/{weird}/file.ts' }] } });
    expect(parseNpmPackJson(`npm notice packing\n${braced}`)).toEqual({
      files: ['src/{weird}/file.ts'],
      entryCount: 1,
      unpackedSize: 3,
    });
  });

  test('reports what npm actually emitted when there is no JSON document', () => {
    expect(() => parseNpmPackJson('npm error code ENOENT\nnpm error enoent\n')).toThrow(/printed no JSON document.*npm error code ENOENT/s);
  });

  test('reports what npm actually emitted when the output is empty', () => {
    expect(() => parseNpmPackJson('   \n')).toThrow(/printed no JSON document.*no output at all/s);
  });

  test('reports what npm actually emitted when the JSON is malformed', () => {
    expect(() => parseNpmPackJson('{"pkg": {files: [1, 2]}}')).toThrow(/could not be parsed/);
  });

  test('reports an unrecognized JSON shape rather than crashing', () => {
    expect(() => parseNpmPackJson(JSON.stringify({ error: { code: 'E404', summary: 'not found' } }))).toThrow(
      /unrecognized JSON shape.*E404/s,
    );
  });
});
