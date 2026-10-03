/**
 * This repo's release asset naming and the addon-archive extraction the
 * self-update path depends on. The archive fixture is built with the real
 * system `tar` (the same tool the Release workflow uses) so extractTarGzEntry
 * is proven against genuine tar bytes, not a hand-rolled imitation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import {
  extractTarGzEntry,
  resolveAgentBinaryAssetName,
  resolveSqliteVecArchive,
} from '../../runtime/release-artifacts.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = makeProjectTempDir('gv-agent-release-artifacts');
  roots.push(dir);
  return dir;
}

describe('resolveAgentBinaryAssetName', () => {
  test('names the published binaries exactly as the Release workflow uploads them', () => {
    expect(resolveAgentBinaryAssetName('linux', 'x64')).toBe('goodvibes-agent-linux-x64');
    expect(resolveAgentBinaryAssetName('linux', 'arm64')).toBe('goodvibes-agent-linux-arm64');
    expect(resolveAgentBinaryAssetName('darwin', 'x64')).toBe('goodvibes-agent-macos-x64');
    expect(resolveAgentBinaryAssetName('darwin', 'arm64')).toBe('goodvibes-agent-macos-arm64');
  });

  test('platforms with no published binary resolve null, never a guessed name', () => {
    expect(resolveAgentBinaryAssetName('win32', 'x64')).toBeNull();
    expect(resolveAgentBinaryAssetName('linux', 'ia32')).toBeNull();
    expect(resolveAgentBinaryAssetName('freebsd', 'x64')).toBeNull();
  });
});

describe('resolveSqliteVecArchive', () => {
  test('names the addon archives with the Node-style platform tag and the loader-resolved inner path', () => {
    expect(resolveSqliteVecArchive('linux', 'x64')).toEqual({
      assetName: 'sqlite-vec-linux-x64.tar.gz',
      dirName: 'sqlite-vec-linux-x64',
      fileName: 'vec0.so',
      entryPath: 'lib/sqlite-vec-linux-x64/vec0.so',
    });
    expect(resolveSqliteVecArchive('darwin', 'arm64')).toEqual({
      assetName: 'sqlite-vec-darwin-arm64.tar.gz',
      dirName: 'sqlite-vec-darwin-arm64',
      fileName: 'vec0.dylib',
      entryPath: 'lib/sqlite-vec-darwin-arm64/vec0.dylib',
    });
  });

  test('unsupported platforms resolve null', () => {
    expect(resolveSqliteVecArchive('win32', 'x64')).toBeNull();
    expect(resolveSqliteVecArchive('linux', 'ia32')).toBeNull();
  });
});

describe('extractTarGzEntry', () => {
  function buildArchive(entryPath: string, contents: Buffer, extraFile?: { path: string; contents: string }): Buffer {
    const dir = scratch();
    const filePath = join(dir, entryPath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, contents);
    const members = [entryPath];
    if (extraFile) {
      writeFileSync(join(dir, extraFile.path), extraFile.contents);
      members.unshift(extraFile.path);
    }
    const tgz = join(dir, 'archive.tar.gz');
    execFileSync('tar', ['-czf', tgz, '-C', dir, ...members], { stdio: 'ignore' });
    return readFileSync(tgz);
  }

  test('extracts the addon file byte-exact from a real tar.gz with the release layout', () => {
    const addonBytes = Buffer.from('native-addon-payload-bytes\0\x01\x02');
    const archive = buildArchive('lib/sqlite-vec-linux-x64/vec0.so', addonBytes, {
      path: 'README-not-the-addon.txt',
      contents: 'decoy',
    });
    const extracted = extractTarGzEntry(archive, 'lib/sqlite-vec-linux-x64/vec0.so');
    expect(extracted).not.toBeNull();
    expect(extracted!.equals(addonBytes)).toBe(true);
  });

  test('an archive without the requested entry yields null (honest absence, never a wrong file)', () => {
    const archive = buildArchive('lib/sqlite-vec-linux-x64/vec0.so', Buffer.from('bytes'));
    expect(extractTarGzEntry(archive, 'lib/sqlite-vec-linux-arm64/vec0.so')).toBeNull();
  });

  test('a corrupted gzip stream fails loudly rather than reading as entry-absent', () => {
    expect(() => extractTarGzEntry(Buffer.from('definitely not gzip bytes'), 'lib/x/vec0.so')).toThrow();
  });

  test('a valid gzip of non-tar bytes yields null without crashing', () => {
    expect(extractTarGzEntry(gzipSync(Buffer.from('short')), 'lib/x/vec0.so')).toBeNull();
  });
});
