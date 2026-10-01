// ---------------------------------------------------------------------------
// sdk-dev-tool.test.ts
//
// Unit + fixture-level coverage for scripts/sdk-dev.ts, the canonical local-
// SDK overlay tool. In goodvibes-jev the old packages are subpaths of one
// engine package, released together with the judgment package it depends
// on, so the tool overlays those two. Covers:
//   - package enumeration (the release tooling's own package list, engine
//     first; private/non-public/missing packages excluded; a package added to
//     the release is picked up with zero code changes here).
//   - the pin reader (devDependencies before dependencies, the generalized
//     agent behavior, safe for TUI/webui too).
//   - the three status states + the restore version-agreement check.
//   - overlayPackage's fs-copy contract (every published `files` entry and a
//     published package.json replaced, never written through in place, and
//     the workspace source condition never reaching the consumer) against
//     fixture dirs.
//   - CLI black-box behavior via subprocess (link fails fast when the SDK
//     checkout is missing; status/restore/usage dispatch).
//
// The FULL link -> build -> overlay -> status -> restore cycle against a real
// SDK build and a real consumer checkout is env-gated below: it costs a full
// `tsc -b` build, too slow for the unit-test loop.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageDirs } from '../scripts/release-shared.ts';
import {
  enumerateWorkspacePackages,
  markerPath,
  overlayPackage,
  overlayStatus,
  readSdkPin,
  restoreVersionIssue,
  SDK_ROOT,
} from '../scripts/sdk-dev.ts';

const SCRIPT_PATH = resolve(import.meta.dir, '..', 'scripts/sdk-dev.ts');

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    const d = created.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function writePkgJson(dir: string, contents: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(contents, null, 2));
}

describe('enumerateWorkspacePackages', () => {
  test('enumerates the released packages, the engine first, then the judgment package', () => {
    const packages = enumerateWorkspacePackages(SDK_ROOT);
    expect(packages).toEqual([
      { nm: 'engine', dir: '.' },
      { nm: 'judgment', dir: '../judgment' },
    ]);
  });

  test('excludes private packages and packages without publishConfig.access:"public"', () => {
    const root = mkTemp('gv-sdk-enum-');
    writePkgJson(join(root, 'engine'), {
      name: '@goodvibes-jev/engine',
      publishConfig: { access: 'public' },
    });
    writePkgJson(join(root, 'judgment'), {
      name: '@goodvibes-jev/judgment',
      private: true,
      publishConfig: { access: 'public' },
    });
    expect(enumerateWorkspacePackages(join(root, 'engine')).map((p) => p.nm)).toEqual(['engine']);

    writePkgJson(join(root, 'judgment'), { name: '@goodvibes-jev/judgment' });
    expect(enumerateWorkspacePackages(join(root, 'engine')).map((p) => p.nm)).toEqual(['engine']);
  });

  test('follows the release package list, so a released package needs no change here (the drift class closed)', () => {
    const root = mkTemp('gv-sdk-enum-');
    const engineRoot = join(root, 'engine');
    for (const dir of packageDirs) {
      writePkgJson(join(engineRoot, dir), {
        name: `@goodvibes-jev/fixture-${dir === '.' ? 'engine' : dir.split('/').at(-1)}`,
        publishConfig: { access: 'public' },
      });
    }
    expect(enumerateWorkspacePackages(engineRoot).map((p) => p.dir)).toEqual([...packageDirs]);
  });

  test('returns an empty list when no released package exists at the root', () => {
    const root = mkTemp('gv-sdk-enum-empty-');
    expect(enumerateWorkspacePackages(root)).toEqual([]);
  });
});

describe('readSdkPin', () => {
  test('reads the pin from devDependencies first (the agent bundles the SDK there)', () => {
    const root = mkTemp('gv-sdk-pin-');
    writePkgJson(root, { devDependencies: { '@goodvibes-jev/engine': '1.0.0' }, dependencies: { '@goodvibes-jev/engine': '0.38.0' } });
    expect(readSdkPin(root)).toBe('1.0.0');
  });

  test('falls back to dependencies when absent from devDependencies (TUI/webui)', () => {
    const root = mkTemp('gv-sdk-pin-');
    writePkgJson(root, { dependencies: { '@goodvibes-jev/engine': '0.38.0' } });
    expect(readSdkPin(root)).toBe('0.38.0');
  });

  test('is undefined when neither field has the pin', () => {
    const root = mkTemp('gv-sdk-pin-');
    writePkgJson(root, {});
    expect(readSdkPin(root)).toBeUndefined();
  });
});

describe('overlayStatus', () => {
  test('reports OVERLAY ACTIVE with exit code 2 when the marker exists', () => {
    const marker = JSON.stringify({ sdkGit: 'main@abc1234 (dirty)', overlaidAt: '2026-07-06T00:00:00.000Z', sourcePath: '/x/goodvibes-sdk' });
    const s = overlayStatus(marker, '0.38.0');
    expect(s.active).toBe(true);
    expect(s.exitCode).toBe(2);
    expect(s.line).toContain('OVERLAY ACTIVE');
    expect(s.line).toContain('main@abc1234');
  });

  test('reports clean npm state with exit code 0 when no marker exists', () => {
    const s = overlayStatus(null, '0.38.0');
    expect(s.active).toBe(false);
    expect(s.exitCode).toBe(0);
    expect(s.line).toContain('clean');
    expect(s.line).toContain('0.38.0');
  });
});

describe('restoreVersionIssue', () => {
  test('returns null when the restored version equals the pin', () => {
    expect(restoreVersionIssue('1.0.0', '1.0.0')).toBeNull();
  });

  test('returns an issue string when the restored version differs from the pin', () => {
    const issue = restoreVersionIssue('0.37.2', '0.38.0');
    expect(issue).not.toBeNull();
    expect(issue).toContain('0.37.2');
    expect(issue).toContain('0.38.0');
  });
});

describe('overlayPackage', () => {
  /** A checkout package with one old package's dist, a contract artifact and a conditional export. */
  function writeCheckoutPackage(packageRoot: string, version: string): void {
    mkdirSync(join(packageRoot, 'sdk/dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'sdk/dist/index.js'), 'fresh local build');
    mkdirSync(join(packageRoot, 'contracts/artifacts'), { recursive: true });
    writeFileSync(join(packageRoot, 'contracts/artifacts/operator-contract.json'), '{"fresh":true}');
    writePkgJson(packageRoot, {
      name: '@goodvibes-jev/engine',
      version,
      files: ['contracts/artifacts', 'sdk/dist'],
      exports: {
        './sdk': { bun: './sdk/src/index.ts', types: './sdk/dist/index.d.ts', import: './sdk/dist/index.js' },
        './package.json': './package.json',
      },
    });
  }

  test('replaces every published entry and package.json in the installed package (unlink-before-copy)', () => {
    const consumerRoot = mkTemp('gv-sdk-overlay-consumer-');
    const sdkRoot = mkTemp('gv-sdk-overlay-sdk-');
    const installed = join(consumerRoot, 'node_modules/@goodvibes-jev/engine');
    mkdirSync(join(installed, 'sdk/dist'), { recursive: true });
    // The installed file is a hardlink into a package cache, as bun installs
    // it; writing through it in place would corrupt the cache entry.
    const cacheFile = join(consumerRoot, 'cache-index.js');
    writeFileSync(cacheFile, 'stale published build');
    linkSync(cacheFile, join(installed, 'sdk/dist/index.js'));
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', version: '2.0.0' }));
    writeCheckoutPackage(sdkRoot, '2.0.23');

    const ok = overlayPackage(consumerRoot, sdkRoot, { nm: 'engine', dir: '.' });
    expect(ok).toBe(true);
    expect(readFileSync(join(installed, 'sdk/dist/index.js'), 'utf8')).toBe('fresh local build');
    expect(readFileSync(cacheFile, 'utf8')).toBe('stale published build');
    expect(readFileSync(join(installed, 'contracts/artifacts/operator-contract.json'), 'utf8')).toBe('{"fresh":true}');
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    expect(manifest.version).toBe('2.0.23');
    // The published form: the source condition names src files the overlay
    // does not copy, so a Bun consumer must never see it.
    expect(manifest.exports['./sdk']).toEqual({ types: './sdk/dist/index.d.ts', import: './sdk/dist/index.js' });
    expect(manifest.exports['./package.json']).toBe('./package.json');
  });

  test('skips (returns false) when the package is not installed in the consumer', () => {
    const consumerRoot = mkTemp('gv-sdk-overlay-consumer-');
    const sdkRoot = mkTemp('gv-sdk-overlay-sdk-');
    writeCheckoutPackage(sdkRoot, '2.0.23');
    const ok = overlayPackage(consumerRoot, sdkRoot, { nm: 'engine', dir: '.' });
    expect(ok).toBe(false);
  });

  test('skips (returns false) when the SDK has not built a published dist for that package', () => {
    const consumerRoot = mkTemp('gv-sdk-overlay-consumer-');
    const sdkRoot = mkTemp('gv-sdk-overlay-sdk-');
    mkdirSync(join(consumerRoot, 'node_modules/@goodvibes-jev/engine'), { recursive: true });
    writePkgJson(sdkRoot, { name: '@goodvibes-jev/engine', files: ['contracts/artifacts', 'sdk/dist'] });
    const ok = overlayPackage(consumerRoot, sdkRoot, { nm: 'engine', dir: '.' });
    expect(ok).toBe(false);
  });
});

describe('markerPath', () => {
  test('points at node_modules/@goodvibes-jev/engine/sdk/.local-sdk-overlay.json (the path every release gate reads)', () => {
    expect(markerPath('/repo')).toBe('/repo/node_modules/@goodvibes-jev/engine/sdk/.local-sdk-overlay.json');
  });
});

describe('CLI dispatch (black-box, subprocess)', () => {
  function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): { exitCode: number; output: string } {
    const result = Bun.spawnSync(['bun', SCRIPT_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  }

  test('link fails fast and names the missing checkout when GOODVIBES_SDK_PATH does not exist', () => {
    const dir = mkTemp('gv-sdk-cli-');
    const missingPath = join(dir, 'does-not-exist');
    const { exitCode, output } = run(['link'], { cwd: dir, env: { GOODVIBES_SDK_PATH: missingPath } });
    expect(exitCode).toBe(1);
    expect(output).toContain('local SDK checkout not found');
    expect(output).toContain(missingPath);
  });

  test('status reports OVERLAY ACTIVE and exits 2 when a marker fixture is present', () => {
    const dir = mkTemp('gv-sdk-cli-');
    const pkgDir = join(dir, 'node_modules/@goodvibes-jev/engine');
    mkdirSync(join(pkgDir, 'sdk'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', version: '9.9.9' }));
    writeFileSync(markerPath(dir), JSON.stringify({
      sourcePath: '/fixture/goodvibes-sdk',
      sdkGit: 'main@fixture (clean)',
      overlaidAt: new Date().toISOString(),
    }));
    const { exitCode, output } = run(['status'], { cwd: dir });
    expect(exitCode).toBe(2);
    expect(output).toContain('OVERLAY ACTIVE');
  });

  test('status reports clean and exits 0 when no marker is present', () => {
    const dir = mkTemp('gv-sdk-cli-');
    const pkgDir = join(dir, 'node_modules/@goodvibes-jev/engine');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', version: '0.38.0' }));
    const { exitCode, output } = run(['status'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(output).toContain('sdk-dev: clean');
    expect(output).toContain('0.38.0');
  });

  test('restore is a no-op and exits 0 when no overlay is active', () => {
    const dir = mkTemp('gv-sdk-cli-');
    mkdirSync(join(dir, 'node_modules/@goodvibes-jev/engine'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@goodvibes-jev/engine': '0.38.0' } }));
    const { exitCode, output } = run(['restore'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(output).toContain('no overlay active; nothing to restore');
  });

  test('usage message is printed and exit is non-zero for an unknown command', () => {
    const { exitCode, output } = run(['bogus']);
    expect(exitCode).toBe(1);
    expect(output).toContain('usage: bun scripts/sdk-dev.ts');
  });

  test('no command prints usage and exits 0', () => {
    const { exitCode, output } = run([]);
    expect(exitCode).toBe(0);
    expect(output).toContain('usage: bun scripts/sdk-dev.ts');
  });
});

describe('full link/restore round-trip (real build, gated: slow)', () => {
  // This exercises the actual `bun run build` + overlay of every released
  // package + precise restore against a REAL scratch consumer checkout. It is
  // gated behind an env var (not run by default in the fast test loop or CI)
  // because it costs a full `tsc -b` build of the workspace.
  test.skipIf(!process.env.GOODVIBES_SDK_DEV_ROUNDTRIP_TEST)('link overlays the engine and the judgment package; restore removes them and matches the pin', () => {
    const consumerRoot = mkTemp('gv-sdk-roundtrip-consumer-');
    writeFileSync(join(consumerRoot, 'package.json'), JSON.stringify({
      name: 'roundtrip-consumer',
      dependencies: { '@goodvibes-jev/engine': '2.0.23' },
    }));
    // Simulate an install-produced node_modules for every released package
    // (the tool only overlays packages already installed, see overlayPackage's
    // existsSync(installed) guard).
    for (const pkg of enumerateWorkspacePackages(SDK_ROOT)) {
      const dir = join(consumerRoot, 'node_modules/@goodvibes-jev', pkg.nm);
      mkdirSync(join(dir, 'sdk'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@goodvibes-jev/${pkg.nm}`, version: '2.0.23' }));
    }

    const linkResult = run(['link'], { cwd: consumerRoot, env: { GOODVIBES_SDK_PATH: SDK_ROOT } });
    expect(linkResult.exitCode).toBe(0);
    expect(linkResult.output).toContain('engine, judgment');
    expect(existsSync(markerPath(consumerRoot))).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath(consumerRoot), 'utf8'));
    expect(marker.overlaidPackages).toEqual(['engine', 'judgment']);

    const restoreResult = run(['restore'], { cwd: consumerRoot, env: { GOODVIBES_SDK_PATH: SDK_ROOT } });
    expect(restoreResult.exitCode).toBe(0);
    expect(existsSync(markerPath(consumerRoot))).toBe(false);
  });

  function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): { exitCode: number; output: string } {
    const result = Bun.spawnSync(['bun', SCRIPT_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  }
});
