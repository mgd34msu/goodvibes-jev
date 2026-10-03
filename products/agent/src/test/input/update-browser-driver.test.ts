import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  applyUpdate,
  realUpdateDirectoryIo,
  rollbackDirectory,
  swapDirectory,
} from '../../input/commands/update-runtime.ts';
import { BROWSER_DRIVER_ARCHIVE_NAME, BROWSER_DRIVER_DIR_NAME } from '../../runtime/release-artifacts.ts';
import type { UpdateFetchLike } from '../../runtime/update-check.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * The update path's obligation to the browser driver.
 *
 * A binary swapped in place must never end up beside a stale driver or no
 * driver at all: the first pairs a new build with a driver version it was never
 * tested against, and the second silently removes browser control from an
 * install that had it. The driver is a DIRECTORY, so it cannot ride
 * swapFileAtomically and gets its own extract-then-rename swap, these tests
 * pin that it happens, that it is verified first, and that it rolls back with
 * the binary rather than being left behind.
 */

const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = makeProjectTempDir(`${prefix}`);
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tarGz(entries: readonly { path: string; data: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const body = Buffer.from(entry.data, 'utf-8');
    header.write(entry.path.slice(0, 100), 0, 'utf-8');
    header.write('0000644\0', 100, 'utf-8');
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'utf-8');
    header.write('00000000000\0', 136);
    header.write('0', 156, 'utf-8');
    header.write('ustar\0', 257, 'utf-8');
    header.write('00', 263, 'utf-8');
    header.write('        ', 148, 8, 'utf-8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf-8');
    blocks.push(header);
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.from(gzipSync(Buffer.concat(blocks)));
}

function driverArchive(options: { readonly omitCli?: boolean } = {}): Buffer {
  return tarGz([
    { path: `${BROWSER_DRIVER_DIR_NAME}/package.json`, data: JSON.stringify({ name: 'playwright-core', version: '1.62.0' }) },
    { path: `${BROWSER_DRIVER_DIR_NAME}/index.js`, data: 'module.exports = {};\n' },
    ...(options.omitCli === true ? [] : [{ path: `${BROWSER_DRIVER_DIR_NAME}/cli.js`, data: '#!/usr/bin/env node\n' }]),
  ]);
}

const sha = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/** Serves a release: a manifest plus the assets it names. */
function releaseFetch(assets: Record<string, Buffer>, options: { readonly manifestOmits?: readonly string[] } = {}): UpdateFetchLike {
  const manifest = Object.entries(assets)
    .filter(([name]) => !(options.manifestOmits ?? []).includes(name))
    .map(([name, bytes]) => `${sha(bytes)}  ${name}`)
    .join('\n');
  return (async (url: string) => {
    // The tag is resolved from the redirect on /releases/latest, not a body.
    if (url.includes('/releases/latest')) {
      return {
        ok: true,
        status: 302,
        headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://github.com/mgd34msu/goodvibes-agent/releases/tag/v9.9.9' : null) },
      } as never;
    }
    const name = url.slice(url.lastIndexOf('/') + 1);
    if (name === 'SHA256SUMS.txt') {
      // Read as text by applyVerifiedUpdate and as bytes by the driver leg.
      return {
        ok: true,
        status: 200,
        text: async () => manifest,
        arrayBuffer: async () => Buffer.from(manifest, 'utf-8'),
      } as never;
    }
    const asset = assets[name];
    if (!asset) return { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) } as never;
    return { ok: true, status: 200, arrayBuffer: async () => asset } as never;
  }) as unknown as UpdateFetchLike;
}

describe('swapDirectory: the driver is a directory, not a file', () => {
  test('replaces the driver and parks the outgoing one', () => {
    const installDir = scratch('gv-swap');
    const driverPath = join(installDir, BROWSER_DRIVER_DIR_NAME);
    mkdirSync(driverPath, { recursive: true });
    writeFileSync(join(driverPath, 'package.json'), JSON.stringify({ version: '0.0.0-stale' }));

    swapDirectory(driverPath, driverArchive(), realUpdateDirectoryIo);

    expect(JSON.parse(readFileSync(join(driverPath, 'package.json'), 'utf-8')).version).toBe('1.62.0');
    expect(existsSync(join(driverPath, 'cli.js'))).toBe(true);
    expect(JSON.parse(readFileSync(join(`${driverPath}.previous`, 'package.json'), 'utf-8')).version).toBe('0.0.0-stale');
  });

  test('installs a driver where there was none, which is the 1.18.1 upgrade case', () => {
    const installDir = scratch('gv-swap-fresh');
    const driverPath = join(installDir, BROWSER_DRIVER_DIR_NAME);

    swapDirectory(driverPath, driverArchive(), realUpdateDirectoryIo);

    expect(existsSync(join(driverPath, 'cli.js'))).toBe(true);
    expect(existsSync(`${driverPath}.previous`)).toBe(false);
  });

  test('leaves no stale file from the replaced driver behind', () => {
    const installDir = scratch('gv-swap-stale');
    const driverPath = join(installDir, BROWSER_DRIVER_DIR_NAME);
    mkdirSync(driverPath, { recursive: true });
    writeFileSync(join(driverPath, 'removed-in-the-new-version.js'), 'old');

    swapDirectory(driverPath, driverArchive(), realUpdateDirectoryIo);

    expect(existsSync(join(driverPath, 'removed-in-the-new-version.js'))).toBe(false);
  });

  test('rolls back by exchanging with the kept copy, and forward again', () => {
    const installDir = scratch('gv-roll');
    const driverPath = join(installDir, BROWSER_DRIVER_DIR_NAME);
    mkdirSync(driverPath, { recursive: true });
    writeFileSync(join(driverPath, 'package.json'), JSON.stringify({ version: '0.0.0-stale' }));
    swapDirectory(driverPath, driverArchive(), realUpdateDirectoryIo);

    expect(rollbackDirectory(driverPath, realUpdateDirectoryIo)).toBe(true);
    expect(JSON.parse(readFileSync(join(driverPath, 'package.json'), 'utf-8')).version).toBe('0.0.0-stale');

    // An exchange, so a second rollback rolls forward.
    expect(rollbackDirectory(driverPath, realUpdateDirectoryIo)).toBe(true);
    expect(JSON.parse(readFileSync(join(driverPath, 'package.json'), 'utf-8')).version).toBe('1.62.0');
  });

  test('rollback with nothing kept reports so instead of destroying the live driver', () => {
    const installDir = scratch('gv-roll-none');
    const driverPath = join(installDir, BROWSER_DRIVER_DIR_NAME);
    mkdirSync(driverPath, { recursive: true });
    writeFileSync(join(driverPath, 'package.json'), '{"version":"1.62.0"}');

    expect(rollbackDirectory(driverPath, realUpdateDirectoryIo)).toBe(false);
    expect(existsSync(join(driverPath, 'package.json'))).toBe(true);
  });
});

describe('applyUpdate refreshes the driver in lockstep with the binary', () => {
  function install(): { readonly dir: string; readonly binaryPath: string } {
    const dir = scratch('gv-update');
    const binaryPath = join(dir, 'goodvibes-agent');
    writeFileSync(binaryPath, 'old binary');
    return { dir, binaryPath };
  }

  const binaryAsset = 'goodvibes-agent-linux-x64';

  test('a release that ships the driver leaves it beside the new binary', async () => {
    const { dir, binaryPath } = install();
    const lines: string[] = [];
    await applyUpdate({
      fetchImpl: releaseFetch({ [binaryAsset]: Buffer.from('new binary'), [BROWSER_DRIVER_ARCHIVE_NAME]: driverArchive() }),
      execPath: binaryPath,
      platform: 'linux',
      arch: 'x64',
      currentVersion: '1.0.0',
      print: (line) => lines.push(line),
    });

    expect(readFileSync(binaryPath, 'utf-8')).toBe('new binary');
    expect(existsSync(join(dir, BROWSER_DRIVER_DIR_NAME, 'cli.js'))).toBe(true);
    expect(lines.join('\n')).toContain('browser driver:');
  });

  test('a release without the driver asset leaves the existing driver untouched and says so', async () => {
    const { dir, binaryPath } = install();
    const driverPath = join(dir, BROWSER_DRIVER_DIR_NAME);
    mkdirSync(driverPath, { recursive: true });
    writeFileSync(join(driverPath, 'package.json'), JSON.stringify({ version: '1.62.0' }));

    const lines: string[] = [];
    await applyUpdate({
      fetchImpl: releaseFetch({ [binaryAsset]: Buffer.from('new binary') }),
      execPath: binaryPath,
      platform: 'linux',
      arch: 'x64',
      currentVersion: '1.0.0',
      print: (line) => lines.push(line),
    });

    expect(JSON.parse(readFileSync(join(driverPath, 'package.json'), 'utf-8')).version).toBe('1.62.0');
    expect(lines.join('\n')).toContain(`ships no ${BROWSER_DRIVER_ARCHIVE_NAME}`);
  });

  test('a driver archive that verifies but holds no cli.js aborts BEFORE the binary is swapped', async () => {
    const { dir, binaryPath } = install();

    await expect(applyUpdate({
      fetchImpl: releaseFetch({ [binaryAsset]: Buffer.from('new binary'), [BROWSER_DRIVER_ARCHIVE_NAME]: driverArchive({ omitCli: true }) }),
      execPath: binaryPath,
      platform: 'linux',
      arch: 'x64',
      currentVersion: '1.0.0',
      print: () => undefined,
    })).rejects.toThrow(/cli\.js/);

    // The whole point of verifying first: nothing was replaced.
    expect(readFileSync(binaryPath, 'utf-8')).toBe('old binary');
    expect(existsSync(join(dir, BROWSER_DRIVER_DIR_NAME))).toBe(false);
  });

  test('a corrupted driver download aborts before the binary is swapped', async () => {
    const { dir, binaryPath } = install();
    const good = driverArchive();
    // Manifest records the good archive; the server serves different bytes.
    const fetchImpl = releaseFetch({ [binaryAsset]: Buffer.from('new binary'), [BROWSER_DRIVER_ARCHIVE_NAME]: good });
    const tampered = ((url: string) => url.endsWith(BROWSER_DRIVER_ARCHIVE_NAME)
      ? Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('corrupted') } as never)
      : (fetchImpl as unknown as (u: string) => Promise<unknown>)(url)) as unknown as UpdateFetchLike;

    await expect(applyUpdate({
      fetchImpl: tampered,
      execPath: binaryPath,
      platform: 'linux',
      arch: 'x64',
      currentVersion: '1.0.0',
      print: () => undefined,
    })).rejects.toThrow();

    expect(readFileSync(binaryPath, 'utf-8')).toBe('old binary');
    expect(existsSync(join(dir, BROWSER_DRIVER_DIR_NAME))).toBe(false);
  });
});
