import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import {
  DRIVER_VERSION,
  driverSearchDirectories,
  managedDriverRoot,
} from '../sdk/src/platform/browser/browser-provision-io.js';
import { browserHostScriptPath } from '../sdk/src/platform/browser/browser-host-client.js';
import {
  browserProfileRoot,
  browserScreenshotRoot,
} from '../sdk/src/platform/browser/browser-sessions.js';

// The old sdk package's manifest is the engine manifest, packages/engine/package.json.
const sdkPackageDir = join(import.meta.dir, '..');

describe('driver resolution for a compiled binary', () => {
  /**
   * A compiled binary has no node_modules and no package.json, so it cannot
   * look up which driver it needs. The version is a constant in the source, and
   * this keeps it honest against the dependency the package actually declares.
   *
   * The agent asserted this against its own package.json. The SDK is where the
   * dependency now lives, so the SDK's manifest is what it must agree with,
   * and it is declared optional, alongside every other heavy runtime the SDK
   * loads only when a capability is used.
   */
  test('the pinned driver version matches the declared dependency', () => {
    const manifest = JSON.parse(readFileSync(join(sdkPackageDir, 'package.json'), 'utf8')) as {
      readonly optionalDependencies?: Record<string, string>;
    };
    expect(manifest.optionalDependencies?.['playwright-core']).toBe(DRIVER_VERSION);
  });

  test('the search looks beside the executable before anywhere else', () => {
    const directories = driverSearchDirectories({ surfaceRoot: 'test-surface', homeDirectory: '/home/someone' });
    const executableDirectory = dirname(process.execPath);
    expect(directories[0]).toBe(join(executableDirectory, 'playwright-core'));
    expect(directories).toContain(join(executableDirectory, 'vendor', 'playwright-core'));
  });

  test('the search includes the surface-owned driver directory', () => {
    const directories = driverSearchDirectories({ surfaceRoot: 'test-surface', homeDirectory: '/home/someone' });
    expect(directories).toContain(join(managedDriverRoot('/home/someone', 'test-surface'), 'node_modules', 'playwright-core'));
  });

  test('an explicit override is searched first', () => {
    const previous = process.env.GOODVIBES_PLAYWRIGHT_CORE;
    process.env.GOODVIBES_PLAYWRIGHT_CORE = '/opt/driver';
    try {
      expect(driverSearchDirectories({ surfaceRoot: 'test-surface', homeDirectory: '/home/someone' })[0]).toBe('/opt/driver');
    } finally {
      if (previous === undefined) delete process.env.GOODVIBES_PLAYWRIGHT_CORE;
      else process.env.GOODVIBES_PLAYWRIGHT_CORE = previous;
    }
  });

  test('the managed driver directory sits under the surface storage root', () => {
    expect(managedDriverRoot('/home/someone', 'agent')).toBe('/home/someone/.goodvibes/agent/browser/driver');
    // And a different surface on the same machine gets its own, rather than
    // reaching into another product's storage.
    expect(managedDriverRoot('/home/someone', 'daemon')).toBe('/home/someone/.goodvibes/daemon/browser/driver');
  });
});

describe('surface-owned browser storage', () => {
  test('profiles and screenshots live under the surface-scoped storage root', () => {
    expect(browserProfileRoot('/home/someone', 'agent')).toBe('/home/someone/.goodvibes/agent/browser/profiles');
    expect(browserScreenshotRoot('/home/someone', 'agent')).toBe('/home/someone/.goodvibes/agent/browser/screenshots');
  });

  test('neither writes into the user\'s project directory', () => {
    for (const path of [browserProfileRoot('/home/someone', 'agent'), browserScreenshotRoot('/home/someone', 'agent')]) {
      expect(path.startsWith('/home/someone/.goodvibes/')).toBe(true);
    }
  });

  test('two surfaces never share a browser profile directory', () => {
    expect(browserProfileRoot('/home/someone', 'agent')).not.toBe(browserProfileRoot('/home/someone', 'daemon'));
  });
});

describe('the node-hosted browser host', () => {
  test('its script ships with the source and is found on disk', () => {
    const path = browserHostScriptPath();
    expect(path.endsWith('browser-host.mjs')).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('connectOverCDP');
  });

  test('the host never closes a browser it attached to', () => {
    const source = readFileSync(browserHostScriptPath(), 'utf8');
    // The release handler drops the connection; nothing calls browser.close().
    expect(source).toContain('state.browser = null');
    expect(source).not.toContain('browser.close()');
  });

  /**
   * The agent asserted the script sat beside `dist/goodvibes-agent`. The SDK
   * equivalent was that the published package carried it. The engine is not
   * published: it runs from source, and tsc emits only what it compiles, so
   * the hand-written .mjs never reaches dist. What must hold is that the
   * compiled client still finds the script, or every attach from compiled
   * output would fail.
   */
  test('the compiled client finds the host script', async () => {
    const compiled = await import('../sdk/dist/platform/browser/browser-host-client.js') as {
      readonly browserHostScriptPath: () => string;
    };
    const path = compiled.browserHostScriptPath();
    expect(path.endsWith('browser-host.mjs')).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('connectOverCDP');
  });
});
