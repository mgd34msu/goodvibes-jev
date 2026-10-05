import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bunCompileCompatibilityFiles, captureLogger, loadToolchainConfig, runBuildBinaries } from '@goodvibes-jev/engine/toolchain';

const root = resolve(import.meta.dir, '../../..');
const entrypoint = 'src/test/fixtures/compiled-html-extraction.ts';

function extraction(stdout: string) {
  const { result, requests } = JSON.parse(stdout);
  expect(result.extractorId).toBe('html-readability');
  expect(result.metadata.extractionPath).toBe('readability');
  expect(result.metadata.warnings).toBeUndefined();
  expect(result.metadata.byline).toBe('Synthetic Writer');
  expect(result.title).toBe('Compiled DOM proof');
  expect(result.structure.searchText).toContain('Parsed content & 電圧 100 V.');
  expect(result.links).toEqual(['/guide']);
  expect(requests).toEqual(['engine.knowledge.html-main-content', 'engine.knowledge.html-document-title']);
  return { result, requests };
}

test('the TUI configuration delegates every supported target to the shared compile adapter', () => {
  const config = loadToolchainConfig(root).build!;
  expect(config.compileDriver).toBe('scripts/compile.ts');
  expect(config.targets.map(target => target.bunTarget)).toEqual([
    'bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64', 'bun-windows-x64',
  ]);
  const calls: { executable: string; args: readonly string[] }[] = [];
  const runtimes: { key: string; artifacts: readonly string[] }[] = [];
  const outcomes = runBuildBinaries({
    cwd: root, config, selection: { targets: config.targets, daemonOnly: false }, nativeKey: 'linux-x64',
    provideAddon: () => true,
    provideBunRuntime: (target, artifacts) => { runtimes.push({ key: target.key, artifacts }); },
    exec: (executable, args) => { calls.push({ executable, args }); return { status: 0, stdout: '', stderr: '' }; },
    logger: captureLogger(),
  });
  expect(outcomes.every(outcome => outcome.ok)).toBe(true);
  expect(calls.slice(config.prebuild.length)).toEqual(config.targets.map(target => ({
    executable: process.execPath, args: [
      'scripts/compile.ts', config.appEntrypoint, '--compile', `--target=${target.bunTarget}`,
      '--outfile', `${config.outDir}/${target.appArtifact}`, '--external', target.nativeAddonPackage!,
    ],
  })));
  expect(runtimes).toEqual(config.targets.filter(target => target.capturedBunRuntime).map(target => ({ key: target.key, artifacts: [target.appArtifact] })));
});

test('the TUI production compile driver preserves installed-owner HTML extraction without dependency mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-compiled-html-'));
  const binary = join(dir, process.platform === 'win32' ? 'html-extraction.exe' : 'html-extraction');
  const files = bunCompileCompatibilityFiles(root);
  const before = new Map(Object.keys(files).map(file => [file, readFileSync(file)]));
  try {
    // Source and binary run the same real lazy dependency loader and extractor.
    const source = spawnSync(process.execPath, [entrypoint], {
      cwd: root, env: { PATH: '/usr/bin:/bin', HOME: dir }, encoding: 'utf8', timeout: 30_000,
    });
    expect({ status: source.status, stderr: source.stderr }).toEqual({ status: 0, stderr: '' });
    const expected = extraction(source.stdout);
    const driver = loadToolchainConfig(root).build!.compileDriver!;
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const built = spawnSync(process.execPath, [driver, entrypoint, '--compile', `--target=bun-${platform}-${process.arch}`, '--outfile', binary], {
      cwd: root, env: { PATH: '/usr/bin:/bin', HOME: dir }, encoding: 'utf8', timeout: 300_000,
    });
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' });
    // The runtime has no adjacent node_modules, user config, secrets or network.
    const run = spawnSync(binary, [], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: dir }, encoding: 'utf8', timeout: 30_000 });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    expect(extraction(run.stdout)).toEqual(expected);
  } finally {
    try {
      for (const [file, bytes] of before) expect(readFileSync(file).equals(bytes)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}, 360_000);
