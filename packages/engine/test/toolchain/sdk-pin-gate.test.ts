import { describe, expect, test } from 'bun:test';
import { runSdkPinGate, readSdkPin, resolveSdkPinConfig } from '@goodvibes-jev/engine/toolchain';
import { fakeFs } from './_helpers.ts';

// The default engine package (DEFAULT_SDK_PACKAGE); a repo depends on it by
// exact version or through the monorepo workspace.
const SDK = '@goodvibes-jev/engine';

function baseFiles(pin: string, installed = pin): Record<string, string> {
  return {
    'package.json': JSON.stringify({ dependencies: { [SDK]: pin } }),
    'bun.lock': `resolved "${SDK}@${installed}"`,
    [`node_modules/${SDK}/package.json`]: JSON.stringify({ version: installed, exports: { '.': {}, './errors': {} } }),
    'src/index.ts': `import { thing } from '${SDK}';`,
  };
}

describe('sdk-pin-gate', () => {
  test('all gates pass on a clean dependencies pin', () => {
    const results = runSdkPinGate(fakeFs(baseFiles('1.10.1')), { pinSource: 'dependencies' });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.id)).toContain('lockfile-resolves-pin');
  });

  test('flags a non-exact pin', () => {
    const results = runSdkPinGate(fakeFs(baseFiles('^1.10.1')), { pinSource: 'dependencies' });
    const gate = results.find((r) => r.id === 'sdk-pin-exact-semver');
    expect(gate?.ok).toBe(false);
  });

  test('flags a lockfile that lagged the pin bump', () => {
    const files = baseFiles('1.10.1');
    files['bun.lock'] = `resolved "${SDK}@1.10.0"`;
    const results = runSdkPinGate(fakeFs(files), { pinSource: 'dependencies' });
    expect(results.find((r) => r.id === 'lockfile-resolves-pin')?.ok).toBe(false);
  });

  test('flags installed version drift from the pin', () => {
    const files = baseFiles('1.10.1', '1.10.0');
    files['bun.lock'] = `resolved "${SDK}@1.10.1"`;
    const results = runSdkPinGate(fakeFs(files), { pinSource: 'dependencies' });
    expect(results.find((r) => r.id === 'installed-matches-pin')?.ok).toBe(false);
  });

  test('flags a dev-link overlay marker', () => {
    const files = baseFiles('1.10.1');
    files[`node_modules/${SDK}/.local-sdk-overlay.json`] = '{}';
    const results = runSdkPinGate(fakeFs(files), {});
    expect(results.find((r) => r.id === 'local-sdk-overlay-absent')?.ok).toBe(false);
  });

  test('flags a non-npm SDK import', () => {
    const files = baseFiles('1.10.1');
    files['src/index.ts'] = `import { thing } from '../../goodvibes-sdk/src/index.ts';`;
    const results = runSdkPinGate(fakeFs(files), {});
    expect(results.find((r) => r.id === 'npm-specifier-only-imports')?.ok).toBe(false);
  });

  test('flags a relative import into the engine source', () => {
    const files = baseFiles('1.10.1');
    files['src/index.ts'] = `import { thing } from '../../packages/engine/sdk/src/index.ts';`;
    const results = runSdkPinGate(fakeFs(files), {});
    expect(results.find((r) => r.id === 'npm-specifier-only-imports')?.ok).toBe(false);
  });

  test('reads the pin from devDependencies when configured (agent variant)', () => {
    const fs = fakeFs({ 'package.json': JSON.stringify({ devDependencies: { [SDK]: '1.10.1' } }) });
    expect(readSdkPin(fs, resolveSdkPinConfig({ pinSource: 'devDependencies' }))).toBe('1.10.1');
  });

  test('exports-map enforcement flags a deep import (webui variant)', () => {
    const files = baseFiles('1.10.1');
    files['src/index.ts'] = `import x from '${SDK}/dist/internal.js';`;
    const results = runSdkPinGate(fakeFs(files), { enforceExportsMap: true });
    expect(results.find((r) => r.id === 'exports-map-only-imports')?.ok).toBe(false);
  });

  test('exports-map enforcement passes a published subpath', () => {
    const files = baseFiles('1.10.1');
    files['src/index.ts'] = `import x from '${SDK}/errors';`;
    const results = runSdkPinGate(fakeFs(files), { enforceExportsMap: true });
    expect(results.find((r) => r.id === 'exports-map-only-imports')?.ok).toBe(true);
  });
});

describe('sdk-pin-gate: a workspace dependency on the engine', () => {
  function workspaceFiles(): Record<string, string> {
    return {
      'package.json': JSON.stringify({ dependencies: { [SDK]: 'workspace:*' } }),
      'bun.lock': `"${SDK}": ["${SDK}@workspace:packages/engine"]`,
      [`node_modules/${SDK}/package.json`]: JSON.stringify({ version: '0.0.0', exports: { './errors': {} } }),
      'src/index.ts': `import { thing } from '${SDK}/errors';`,
    };
  }

  test('is a valid pin when the workspace link is installed and locked', () => {
    const results = runSdkPinGate(fakeFs(workspaceFiles()), { pinSource: 'dependencies' });
    expect(results.find((r) => r.id === 'sdk-pin-exact-semver')?.ok).toBe(true);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.id)).toContain('lockfile-resolves-pin');
  });

  test('flags a workspace pin with no installed link', () => {
    const files = workspaceFiles();
    delete files[`node_modules/${SDK}/package.json`];
    const results = runSdkPinGate(fakeFs(files), { pinSource: 'dependencies' });
    expect(results.find((r) => r.id === 'installed-matches-pin')?.ok).toBe(false);
  });

  test('flags a lockfile with no workspace entry for the engine', () => {
    const files = workspaceFiles();
    files['bun.lock'] = `resolved "${SDK}@0.0.0"`;
    const results = runSdkPinGate(fakeFs(files), { pinSource: 'dependencies' });
    expect(results.find((r) => r.id === 'lockfile-resolves-pin')?.ok).toBe(false);
  });
});
