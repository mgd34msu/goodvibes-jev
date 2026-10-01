/**
 * pack-bundle, the release asset the suite installer downloads.
 *
 * The three properties that matter are the ones the installer depends on and
 * cannot check for itself until it is too late:
 *
 *   1. The archive's single top-level directory is `goodvibes-webui/` and it
 *      holds `index.html`. The installer refuses an archive without that file,
 *      so producing one would ship a release that cannot install.
 *   2. Two runs over the same build produce byte-identical archives. Otherwise
 *      the digest in SHA256SUMS.txt stops meaning "the bytes this release
 *      built".
 *   3. A `dist/` with no index.html is refused here rather than published as a
 *      bundle nobody can serve.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLE_ROOT_DIR, bundleAssetName, packBundle } from './pack-bundle';
import { installTestCleanup, makeProjectTempDir } from './helpers/project-temp';

installTestCleanup(afterAll);

function scratch(prefix: string): string {
  return makeProjectTempDir(`pack-bundle-${prefix}-`);
}

/** A minimal but realistic built bundle. */
function buildDist(root: string, options: { readonly omitIndex?: boolean } = {}): string {
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  if (options.omitIndex !== true) {
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>GoodVibes</title>\n');
  }
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log("app");\n');
  writeFileSync(join(dist, 'assets', 'index-abc123.css'), 'body{margin:0}\n');
  return dist;
}

function listArchive(archivePath: string): string[] {
  const result = Bun.spawnSync(['tar', '-tzf', archivePath]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().split('\n').filter(Boolean).map((entry) => entry.replace(/\/$/, ''));
}

describe('pack-bundle', () => {
  test('names the asset the way the installer looks it up', () => {
    expect(bundleAssetName('1.12.1')).toBe('goodvibes-webui-bundle-1.12.1.tar.gz');
  });

  test('packs a single goodvibes-webui/ directory holding index.html and the assets', () => {
    const root = scratch('pack-layout');
    const dist = buildDist(root);
    const out = join(root, 'release');
    const packed = packBundle({ distDir: dist, outDir: out, version: '1.12.1' });

    const entries = listArchive(packed.archivePath);
    expect(entries).toContain(BUNDLE_ROOT_DIR);
    expect(entries).toContain(`${BUNDLE_ROOT_DIR}/index.html`);
    expect(entries).toContain(`${BUNDLE_ROOT_DIR}/assets/index-abc123.js`);
    // Nothing outside the one contract directory.
    expect(entries.every((entry) => entry === BUNDLE_ROOT_DIR || entry.startsWith(`${BUNDLE_ROOT_DIR}/`))).toBe(true);
  });

  test('writes a SHA256SUMS.txt entry the installer can look the asset up by', () => {
    const root = scratch('pack-manifest');
    const dist = buildDist(root);
    const out = join(root, 'release');
    const packed = packBundle({ distDir: dist, outDir: out, version: '2.0.0' });

    const manifest = readFileSync(packed.checksumPath, 'utf8');
    expect(manifest).toBe(`${packed.sha256}  goodvibes-webui-bundle-2.0.0.tar.gz\n`);
    // The name in the manifest is the name of the file that was actually written.
    expect(packed.assetName).toBe('goodvibes-webui-bundle-2.0.0.tar.gz');
  });

  test('two runs over the same build produce byte-identical archives', () => {
    const root = scratch('pack-deterministic');
    const dist = buildDist(root);
    const first = packBundle({ distDir: dist, outDir: join(root, 'a'), version: '1.12.1' });
    const second = packBundle({ distDir: dist, outDir: join(root, 'b'), version: '1.12.1' });
    expect(second.sha256).toBe(first.sha256);
    expect(readFileSync(second.archivePath).equals(readFileSync(first.archivePath))).toBe(true);
  });

  test('a build with no index.html is refused rather than published', () => {
    const root = scratch('pack-no-index');
    const dist = buildDist(root, { omitIndex: true });
    expect(() => packBundle({ distDir: dist, outDir: join(root, 'release'), version: '1.12.1' }))
      .toThrow();
  });

  test('leaves no staging directory behind', () => {
    const root = scratch('pack-staging');
    const dist = buildDist(root);
    const out = join(root, 'release');
    packBundle({ distDir: dist, outDir: out, version: '1.12.1' });
    expect(() => readFileSync(join(out, '.pack-staging', BUNDLE_ROOT_DIR, 'index.html'))).toThrow();
  });
});
