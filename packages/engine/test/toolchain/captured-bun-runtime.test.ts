import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseToolchainConfig, type BinaryTarget, type BuildConfig } from '../../toolchain/src/config.ts';
import { assertCapturedBunRuntimeElf, provideCapturedBunRuntime } from '../../toolchain/src/lib/captured-bun-runtime.ts';
import { runBuildBinaries } from '../../toolchain/src/lib/build-binaries.ts';
import type { Exec } from '../../toolchain/src/lib/effects.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const supportedHost = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch) && process.versions.bun === '1.3.14';
const native: BinaryTarget = { key: `linux-${process.arch}`, bunTarget: `bun-linux-${process.arch}`, appArtifact: 'app', daemonArtifact: 'daemon', capturedBunRuntime: '1.3.14' };
const cross: BinaryTarget = { key: 'linux-arm64', bunTarget: 'bun-linux-arm64', appArtifact: 'app', capturedBunRuntime: '1.3.14' };
const quiet = { info() {}, warn() {}, error() {} };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bun-sidecar-test-')); roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sidecar-fixture' }));
  mkdirSync(join(root, 'dist'));
  for (const name of ['app', 'daemon']) writeFileSync(join(root, 'dist', name), 'compiled-artifact placeholder', { mode: 0o755 });
  return root;
}
function elf(machine: number): Buffer {
  const bytes = Buffer.alloc(64); bytes.write('\x7fELF'); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(machine, 18); return bytes;
}

test.skipIf(!supportedHost)('stages and launches real ordinary Bun beside each artifact with exact notice and provenance', () => {
  const root = fixture();
  provideCapturedBunRuntime({ root, outDir: 'dist', target: native, artifacts: ['app', 'daemon'] });
  for (const name of ['app', 'daemon']) {
    const runtime = join(root, 'dist', `${name}.bun`);
    expect(statSync(runtime).mode & 0o777).toBe(0o755);
    const result = spawnSync(runtime, ['--no-env-file', '--no-autoload-bunfig', '--print', '6 * 7'], { cwd: root, env: { HOME: root }, encoding: 'utf8' });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: '42\n', stderr: '' });
    const sha256 = createHash('sha256').update(readFileSync(runtime)).digest('hex');
    const provenance = JSON.parse(readFileSync(`${runtime}.json`, 'utf8'));
    expect(provenance).toMatchObject({ version: '1.3.14', target: native.key, source: 'build-interpreter', sha256 });
    expect(provenance.package).toBeUndefined(); // A native compiler may be a non-baseline Bun build.
    const notice = readFileSync(`${runtime}.LICENSE.md`, 'utf8');
    expect(notice).toContain('Bun statically links JavaScriptCore');
    expect(notice).toContain('LGPL');
    expect(notice).toContain('git submodule update --init --recursive');
    expect(notice).toContain('https://github.com/oven-sh/bun/tree/bun-v1.3.14');
  }
  expect(readdirSync(join(root, 'dist')).filter(name => name.startsWith('.bun-runtime-'))).toEqual([]);
});

test.skipIf(!supportedHost)('staging replaces sidecar and notice links without modifying their targets', () => {
  const root = fixture(); const outside = join(root, 'unrelated'); writeFileSync(outside, 'preserve');
  for (const suffix of ['.bun', '.bun.LICENSE.md', '.bun.json']) symlinkSync(outside, join(root, 'dist', `app${suffix}`));
  provideCapturedBunRuntime({ root, outDir: 'dist', target: native, artifacts: ['app'] });
  expect(readFileSync(outside, 'utf8')).toBe('preserve');
  expect(statSync(join(root, 'dist/app.bun')).size).toBeGreaterThan(64);
});

test.skipIf(!supportedHost)('actual build orchestration stages the mandatory runtime without an injected provider', () => {
  const root = fixture();
  const config: BuildConfig = { appEntrypoint: 'app.ts', daemonEntrypoint: 'daemon.ts', outDir: 'dist', addonOutDir: 'dist/lib', prebuild: [], targets: [native] };
  const outcomes = runBuildBinaries({ cwd: root, config, selection: { targets: [native], daemonOnly: true }, nativeKey: native.key,
    exec: () => ({ status: 0, stdout: '', stderr: '' }), logger: quiet });
  expect(outcomes).toEqual([{ key: native.key, ok: true, detail: 'built' }]);
  expect(existsSync(join(root, 'dist/daemon.bun'))).toBe(true);
  expect(existsSync(join(root, 'dist/app.bun'))).toBe(false);
});

test.each(['darwin-arm64', 'windows-x64', 'linux-riscv64'])('explicit unsupported runtime target fails before effects: %s', key => {
  const root = fixture();
  expect(() => provideCapturedBunRuntime({ root, outDir: 'missing', target: { ...cross, key, bunTarget: `bun-${key}` }, artifacts: ['app'] })).toThrow('unsupported');
  expect(existsSync(join(root, 'missing'))).toBe(false);
});

test('an undeclared runtime does not stage or fetch, and compile-target mismatches fail closed', () => {
  const root = fixture();
  provideCapturedBunRuntime({ root, outDir: 'missing', target: { key: 'darwin-x64', bunTarget: 'bun-darwin-x64', appArtifact: 'app' }, artifacts: ['app'], exec() { throw new Error('must not execute'); } });
  expect(existsSync(join(root, 'missing'))).toBe(false);
  expect(() => provideCapturedBunRuntime({ root, outDir: 'dist', target: { ...cross, bunTarget: 'bun-linux-x64' }, artifacts: ['app'] })).toThrow('unsupported');
});

test.each(['../app', '', '.', '..', '/app'])('artifact names cannot escape the output boundary: %s', artifact => {
  const root = fixture();
  expect(() => provideCapturedBunRuntime({ root, outDir: 'dist', target: cross, artifacts: [artifact] })).toThrow('filenames');
});

test('all compiled artifacts must exist and be regular before any runtime can be staged', () => {
  const root = fixture(); rmSync(join(root, 'dist/daemon'));
  expect(() => provideCapturedBunRuntime({ root, outDir: 'dist', target: cross, artifacts: ['app', 'daemon'] })).toThrow('Compiled artifact missing');
  expect(existsSync(join(root, 'dist/app.bun'))).toBe(false);
  symlinkSync(join(root, 'dist/app'), join(root, 'dist/daemon'));
  expect(() => provideCapturedBunRuntime({ root, outDir: 'dist', target: cross, artifacts: ['daemon'] })).toThrow('not a regular file');
});

test('ELF inspection rejects text, wrong architecture, and malformed executable classes', () => {
  const root = fixture(); const payload = join(root, 'candidate');
  writeFileSync(payload, elf(183)); expect(() => assertCapturedBunRuntimeElf(payload, 183)).not.toThrow();
  expect(() => assertCapturedBunRuntimeElf(payload, 62)).toThrow('architecture');
  const bytes = elf(183); bytes[4] = 1; writeFileSync(payload, bytes);
  expect(() => assertCapturedBunRuntimeElf(payload, 183)).toThrow('architecture');
  writeFileSync(payload, '#!/bin/sh\necho 1.3.14\n');
  expect(() => assertCapturedBunRuntimeElf(payload, 183)).toThrow('ELF');
});

test.skipIf(process.arch === 'arm64')('cross-target fetch pins the official registry and version, disables scripts, and rejects altered archives before extraction', () => {
  const root = fixture(); const calls: string[][] = [];
  const exec: Exec = (command, args) => {
    calls.push([command, ...args]);
    const scratch = args[args.indexOf('--pack-destination') + 1]!;
    writeFileSync(join(scratch, 'fixture.tgz'), 'not the official archive');
    return { status: 0, stdout: 'fixture.tgz\n', stderr: '' };
  };
  expect(() => provideCapturedBunRuntime({ root, outDir: 'dist', target: cross, artifacts: ['app'], exec })).toThrow('pinned integrity');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(0, 5)).toEqual(['npm', 'pack', '@oven/bun-linux-aarch64@1.3.14', '--ignore-scripts', '--registry=https://registry.npmjs.org']);
  expect(existsSync(calls[0]!.at(-1)!)).toBe(false);
  expect(existsSync(join(root, 'dist/app.bun'))).toBe(false);
});

test.skipIf(process.arch === 'arm64').each(['version', 'manifest-link', 'payload-link', 'payload-bytes'])('installed cross-target %s cannot masquerade as the pinned runtime', kind => {
  const root = fixture(); const directory = join(root, 'node_modules/@oven/bun-linux-aarch64'); mkdirSync(join(directory, 'bin'), { recursive: true });
  const manifest = JSON.stringify({ name: '@oven/bun-linux-aarch64', version: kind === 'version' ? '1.3.13' : '1.3.14', os: ['linux'], cpu: ['arm64'] });
  writeFileSync(join(directory, 'package.json'), manifest); writeFileSync(join(directory, 'bin/bun'), elf(183));
  if (kind === 'manifest-link') { writeFileSync(join(root, 'manifest.json'), manifest); rmSync(join(directory, 'package.json')); symlinkSync(join(root, 'manifest.json'), join(directory, 'package.json')); }
  if (kind === 'payload-link') { writeFileSync(join(root, 'outside-bun'), elf(183)); rmSync(join(directory, 'bin/bun')); symlinkSync(join(root, 'outside-bun'), join(directory, 'bin/bun')); }
  expect(() => provideCapturedBunRuntime({ root, outDir: 'dist', target: cross, artifacts: ['app'], exec() { throw new Error('must not fetch or execute'); } })).toThrow();
  expect(existsSync(join(root, 'dist/app.bun'))).toBe(false);
});

test('sidecar failure fails the whole build target instead of returning a falsely complete product', () => {
  const root = fixture();
  const config: BuildConfig = { appEntrypoint: 'app.ts', outDir: 'dist', addonOutDir: 'dist/lib', prebuild: [], targets: [cross] };
  const outcomes = runBuildBinaries({ cwd: root, config, selection: { targets: [cross], daemonOnly: false }, nativeKey: native.key, logger: quiet,
    exec: () => ({ status: 0, stdout: '', stderr: '' }), provideBunRuntime() { throw new Error('fixture unavailable'); } });
  expect(outcomes[0]).toMatchObject({ ok: false, detail: 'Bun runtime sidecar unavailable: fixture unavailable' });
});

test('config accepts only the reviewed runtime version', () => {
  const config = (version: string) => JSON.stringify({ packageName: 'fixture', build: { appEntrypoint: 'app.ts', outDir: 'dist', addonOutDir: 'dist/lib', prebuild: [], targets: [{ ...cross, capturedBunRuntime: version }] } });
  expect(parseToolchainConfig(config('1.3.14')).build?.targets[0]?.capturedBunRuntime).toBe('1.3.14');
  expect(() => parseToolchainConfig(config('latest'))).toThrow('capturedBunRuntime');
});
