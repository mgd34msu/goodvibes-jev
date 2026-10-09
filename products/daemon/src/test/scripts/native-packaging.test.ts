import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspaceToolchain, validateToolchainArguments } from '../../../scripts/run-toolchain.ts';
import { checkBinaryVersion } from '../../../scripts/check-version.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

test('native wrapper resolves both installed engine CLIs without generated bin shims', () => {
  const root = makeOwnedTempDir('daemon-native-toolchain');
  const engine = join(root, 'node_modules/@goodvibes-jev/engine');
  mkdirSync(join(engine, 'toolchain/dist/bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  const bin = { 'goodvibes-build-binaries': './toolchain/dist/bin/build-binaries.js', 'goodvibes-post-build-smoke': './toolchain/dist/bin/post-build-smoke.js' };
  writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', exports: { './package.json': './package.json' }, bin }));
  for (const [command, name] of [['build', 'goodvibes-build-binaries'], ['smoke', 'goodvibes-post-build-smoke']] as const) {
    expect(() => resolveWorkspaceToolchain(root, command)).toThrow('Build the workspace engine');
    const cli = join(engine, bin[name]);
    writeFileSync(cli, '// declaration resolution fixture; never executed');
    expect(resolveWorkspaceToolchain(root, command)).toBe(cli);
  }
});

test('missing or undeclared engine CLI fails instead of resolving a global executable', () => {
  const root = makeOwnedTempDir('daemon-native-no-cli');
  const engine = join(root, 'node_modules/@goodvibes-jev/engine');
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', exports: { './package.json': './package.json' } }));
  expect(() => resolveWorkspaceToolchain(root, 'build')).toThrow('does not declare goodvibes-build-binaries');
  expect(() => resolveWorkspaceToolchain(root, 'smoke')).toThrow('does not declare goodvibes-post-build-smoke');
});

test('sole-artifact wrapper admits shared ordinary targets and rejects skipped or ambiguous builds', () => {
  for (const args of [[], ['--all'], ['--target', 'linux-x64'], ['--target', 'darwin-arm64']]) {
    expect(() => validateToolchainArguments('build', args)).not.toThrow();
  }
  for (const args of [['--daemon-only'], ['--all', '--daemon-only'], ['--target', 'daemon-linux-x64'], ['--target=daemon-macos-arm64']]) {
    expect(() => validateToolchainArguments('build', args)).toThrow('sole build artifact');
  }
  for (const args of [['--target'], ['--target', '--all'], ['--all', '--target', 'linux-x64'], ['--target=linux-x64'], ['--typo']]) {
    expect(() => validateToolchainArguments('build', args)).toThrow('Usage:');
  }
  expect(() => validateToolchainArguments('smoke', ['--binary', '/owned/artifact'])).not.toThrow();
  expect(() => validateToolchainArguments('smoke', ['--binary'])).toThrow('Usage:');
  expect(() => validateToolchainArguments('publish', [])).toThrow('Usage:');
});

test('native prebuild validates the private manifest fallback without modifying either file', () => {
  const root = makeOwnedTempDir('daemon-native-version');
  mkdirSync(join(root, 'src'));
  const manifestPath = join(root, 'package.json');
  const sourcePath = join(root, 'src/version.ts');
  const manifest = JSON.stringify({ name: '@goodvibes-jev/daemon', version: '1.28.25' });
  const source = "let _version = '1.28.25';\n";
  writeFileSync(manifestPath, manifest); writeFileSync(sourcePath, source);
  expect(() => checkBinaryVersion(root)).not.toThrow();
  expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
  expect(readFileSync(sourcePath, 'utf8')).toBe(source);
  for (const value of ["let _version = '0.0.0';\n", '', source + source]) {
    writeFileSync(sourcePath, value);
    expect(() => checkBinaryVersion(root)).toThrow('fallback must match package.json');
    expect(readFileSync(sourcePath, 'utf8')).toBe(value);
  }
  writeFileSync(manifestPath, JSON.stringify({ name: '@fixture/foreign', version: '1.28.25' }));
  expect(() => checkBinaryVersion(root)).toThrow('@goodvibes-jev/daemon manifest');
});

test('ordinary Node hosted-proof protocol parser and synthetic wire responses fail closed', () => {
  const result = spawnSync('node', ['--test', join(import.meta.dir, '../../../scripts/hosted-session-protocol.test.mjs')], {
    encoding: 'utf8', timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
