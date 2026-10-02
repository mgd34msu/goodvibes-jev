/**
 * The 1.18.1 browser failure, pinned so it cannot ship again, the half of it
 * that is still the agent's.
 *
 * Three independent defects had to line up to produce it, and each is covered
 * separately because fixing any one alone leaves the capability broken:
 *
 *   1. the driver never reached the release asset, so a downloaded binary had
 *      none beside it;
 *   2. the capability probe resolved the driver as a MODULE, which can never
 *      succeed inside a compiled binary, so browser control reported
 *      needs-setup even with a driver correctly in place, and the model relayed
 *      that instead of calling the tool;
 *   3. the remediation told a binary user to install the npm package.
 *
 * The browser engine, the resolver and the provisioning policy are
 * `@goodvibes-jev/engine/sdk/platform/browser` now, and the SDK's own
 * browser-driver-* suites cover them. What stays here is what only this repo
 * can answer, and every one of these is a place the agent and the platform
 * have to AGREE rather than merely resemble each other:
 *
 *   - the release asset this repo publishes, extracted by this repo's own
 *     tar reader (the one `/update` uses), landing where the SDK resolver looks;
 *   - the agent's capability probe reaching the same verdict as the SDK
 *     resolver, including the completeness rule;
 *   - the agent's install-kind profile producing the right remediation;
 *   - the agent's storage root binding, so the driver, profiles and screenshots
 *     land under this surface and not another's.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractTarGzTree, readTarGzEntries } from '../../runtime/tar-archive.ts';
import { DRIVER_REQUIRED_FILES, findDriverDirectory } from '@goodvibes-jev/engine/sdk/platform/browser';
import { runCapabilityProbe, emptyProbeContext } from '../../capabilities/capability-probe-runner.ts';
import { browserControlDeclaration } from '../../capabilities/builtin-capabilities.ts';
import {
  BROWSER_DRIVER_DIR_NAME,
  BROWSER_DRIVER_REQUIRED_ENTRIES,
} from '../../runtime/release-artifacts.ts';
import { driverRemediation, shippedDriverPath } from '../../runtime/browser-driver-profile.ts';
import {
  agentBrowserProfileRoot,
  agentBrowserScreenshotRoot,
  agentDriverSearchDirectories,
  agentManagedDriverRoot,
} from '../../runtime/agent-browser.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = makeProjectTempDir(`${prefix}`);
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** Builds a ustar tar.gz in memory, so no test shells out to `tar`. */
function buildTarGz(entries: readonly { path: string; data?: string; mode?: number; directory?: boolean }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const body = Buffer.from(entry.data ?? '', 'utf-8');
    header.write(entry.path.slice(0, 100), 0, 'utf-8');
    header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 'utf-8');
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write((entry.directory === true ? 0 : body.length).toString(8).padStart(11, '0') + '\0', 124, 'utf-8');
    header.write('00000000000\0', 136);
    header.write(entry.directory === true ? '5' : '0', 156, 'utf-8');
    header.write('ustar\0', 257, 'utf-8');
    header.write('00', 263, 'utf-8');
    // Checksum: sum of all header bytes with the checksum field read as spaces.
    header.write('        ', 148, 8, 'utf-8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf-8');
    blocks.push(header);
    if (entry.directory !== true && body.length > 0) {
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
      body.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.from(gzipSync(Buffer.concat(blocks)));
}

function driverArchive(): Buffer {
  return buildTarGz([
    { path: `${BROWSER_DRIVER_DIR_NAME}/`, directory: true },
    { path: `${BROWSER_DRIVER_DIR_NAME}/package.json`, data: JSON.stringify({ name: 'playwright-core', version: '1.62.0' }) },
    { path: `${BROWSER_DRIVER_DIR_NAME}/index.js`, data: 'module.exports = {};\n' },
    { path: `${BROWSER_DRIVER_DIR_NAME}/cli.js`, data: '#!/usr/bin/env node\n', mode: 0o755 },
    { path: `${BROWSER_DRIVER_DIR_NAME}/lib/xdg-open`, data: '#!/bin/sh\n', mode: 0o755 },
  ]);
}

describe('the driver archive this release ships', () => {
  test('carries every entry the update path refuses to install without', () => {
    const archive = driverArchive();
    const names = [...readTarGzEntries(archive)].map((entry) => entry.path);
    for (const required of BROWSER_DRIVER_REQUIRED_ENTRIES) {
      expect(names, `${required} must be in the published archive`).toContain(required);
    }
  });

  test('the required entries are exactly the files the platform resolver demands', () => {
    // The release names them with the directory prefix; the resolver checks
    // them inside a candidate directory. Same three files, stated twice, so
    // this pins that they cannot drift apart.
    expect(BROWSER_DRIVER_REQUIRED_ENTRIES.map((entry) => entry.slice(BROWSER_DRIVER_DIR_NAME.length + 1)).sort())
      .toEqual([...DRIVER_REQUIRED_FILES].sort());
  });

  test('extracts to the exact directory the runtime searches, with the executable bit preserved', () => {
    const destination = join(scratch('gv-driver'), BROWSER_DRIVER_DIR_NAME);
    extractTarGzTree(driverArchive(), destination, { stripComponents: 1 });

    expect(existsSync(join(destination, 'cli.js'))).toBe(true);
    // cli.js is executed by the browser install step; a lost mode bit makes the
    // extracted driver unusable in exactly the case this asset exists for.
    expect(statSync(join(destination, 'cli.js')).mode & 0o111).toBeGreaterThan(0);
    expect(findDriverDirectory(undefined, [destination])).toBe(destination);
  });

  test('an archive entry that would escape the destination is refused, not sanitised', () => {
    const destination = scratch('gv-escape');
    const hostile = buildTarGz([{ path: '../escaped.js', data: 'nope' }]);
    expect(() => extractTarGzTree(hostile, destination, { stripComponents: 0 })).toThrow();
  });
});

describe('the capability probe that made this unrecoverable', () => {
  const label = 'The browser driver';

  test('a driver beside the executable satisfies the probe even though it is not a resolvable module', () => {
    const installDir = scratch('gv-probe');
    const driverDir = join(installDir, BROWSER_DRIVER_DIR_NAME);
    extractTarGzTree(driverArchive(), driverDir, { stripComponents: 1 });

    const result = runCapabilityProbe(
      // A specifier that is deliberately not installed anywhere, so the only
      // way this can pass is the on-disk search, the case a compiled binary is
      // always in.
      { kind: 'module-resolvable', specifier: 'playwright-core-not-a-real-package', label, searchDirectories: [driverDir] },
      emptyProbeContext(),
    );

    expect(result.satisfied).toBe(true);
    expect(result.detail).toContain(driverDir);
  });

  test('with no driver anywhere the probe names the places it looked', () => {
    const missing = join(scratch('gv-probe-miss'), BROWSER_DRIVER_DIR_NAME);
    const result = runCapabilityProbe(
      { kind: 'module-resolvable', specifier: 'playwright-core-not-a-real-package', label, searchDirectories: [missing] },
      emptyProbeContext(),
    );

    expect(result.satisfied).toBe(false);
    expect(result.detail).toContain(missing);
  });

  test('the probe and the runtime resolver agree about a driver missing its CLI', () => {
    // The resolver skips a directory without cli.js, because cli.js is what the
    // browser install step executes. The probe used a weaker rule, so it
    // reported "the browser driver is present at X" for a directory the tool
    // then refused, the index disagreeing with the tool a moment later is
    // precisely what this probe exists to prevent.
    const noCli = join(scratch('gv-probe-nocli'), BROWSER_DRIVER_DIR_NAME);
    mkdirSync(noCli, { recursive: true });
    writeFileSync(join(noCli, 'package.json'), '{"name":"playwright-core","version":"1.62.0"}');
    writeFileSync(join(noCli, 'index.js'), 'module.exports = {};');

    expect(findDriverDirectory(undefined, [noCli]), 'the resolver rejects it').toBeNull();

    const result = runCapabilityProbe(
      {
        kind: 'module-resolvable',
        specifier: 'playwright-core-not-a-real-package',
        label,
        searchDirectories: [noCli],
        requiredFiles: DRIVER_REQUIRED_FILES,
      },
      emptyProbeContext(),
    );
    expect(result.satisfied, 'the probe must reject it too').toBe(false);
  });

  test('the browser capability declares the resolver rule, not a weaker one', () => {
    // Declaring the directories without the completeness rule is what let the
    // two drift apart, so the declaration itself is pinned, including that it
    // searches the AGENT's directories rather than some other surface's.
    const declaration = browserControlDeclaration({ homeDirectory: '/home/someone', workingDirectory: '/tmp' });
    const prerequisite = declaration.prerequisites?.find((entry) => entry.id === 'playwright-driver');
    expect(prerequisite).toBeDefined();
    const probe = prerequisite?.probe;
    expect(probe?.kind).toBe('module-resolvable');
    expect(probe?.kind === 'module-resolvable' ? probe.requiredFiles : undefined).toEqual(DRIVER_REQUIRED_FILES);
    expect(probe?.kind === 'module-resolvable' ? probe.searchDirectories : undefined)
      .toEqual(agentDriverSearchDirectories('/home/someone'));
  });
});

describe('remediation matches how the agent was actually installed', () => {
  test('a binary install is told to get the driver that ships with the release, never to install the npm package', () => {
    const advice = driverRemediation({ execPath: '/usr/local/bin/goodvibes-agent', executableDirectory: '/usr/local/bin' });
    expect(advice).toContain('browser-driver.tar.gz');
    expect(advice).toContain('curl -fsSL https://goodvibes.sh/install.sh | sh');
    expect(advice).toContain('/usr/local/bin/playwright-core/cli.js');
    expect(advice).not.toContain('bun add -g');
  });

  test('a package install is told to reinstall the package', () => {
    const advice = driverRemediation({ execPath: '/home/someone/.bun/install/global/node_modules/@pellux/goodvibes-agent/bin/goodvibes-agent.ts' });
    expect(advice).toContain('bun add -g @pellux/goodvibes-agent');
  });

  test('a source checkout is told to install dependencies', () => {
    expect(driverRemediation({ execPath: '/home/someone/.bun/bin/bun' })).toContain('bun install');
  });

  test('the path named in the advice is the path the driver actually goes to', () => {
    expect(shippedDriverPath({ execPath: '/opt/gv/goodvibes-agent', executableDirectory: '/opt/gv' }))
      .toBe(`/opt/gv/${BROWSER_DRIVER_DIR_NAME}`);
  });
});

describe('agent-owned browser storage', () => {
  test('the managed driver, profiles and screenshots all sit under the agent storage root', () => {
    expect(agentManagedDriverRoot('/home/someone')).toBe('/home/someone/.goodvibes/agent/browser/driver');
    expect(agentBrowserProfileRoot('/home/someone')).toBe('/home/someone/.goodvibes/agent/browser/profiles');
    expect(agentBrowserScreenshotRoot('/home/someone')).toBe('/home/someone/.goodvibes/agent/browser/screenshots');
  });

  test('neither writes into the user\'s project directory', () => {
    for (const path of [agentBrowserProfileRoot('/home/someone'), agentBrowserScreenshotRoot('/home/someone')]) {
      expect(path.startsWith('/home/someone/.goodvibes/')).toBe(true);
    }
  });

  test('the search looks beside the executable first, then the agent-owned directory', () => {
    const directories = agentDriverSearchDirectories('/home/someone');
    expect(directories).toContain(join(agentManagedDriverRoot('/home/someone'), 'node_modules', 'playwright-core'));
    expect(directories.indexOf(join(agentManagedDriverRoot('/home/someone'), 'node_modules', 'playwright-core')))
      .toBeGreaterThan(0);
  });
});
