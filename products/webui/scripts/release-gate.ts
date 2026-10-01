#!/usr/bin/env bun
/** Validate the real workspace dependency and its declared public subpaths. */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { loadToolchainConfig, realFsReader, runSdkPinGate, type FsReader } from '@goodvibes-jev/engine/toolchain';

const root = resolve(import.meta.dir, '..');
const require = createRequire(import.meta.url);
const engineRoot = dirname(require.resolve('@goodvibes-jev/engine/package.json'));
const local = realFsReader(root);
const engine = realFsReader(engineRoot);
const prefix = 'node_modules/@goodvibes-jev/engine/';
function installedPath(path: string): string | null {
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}
// Bun may hoist workspace links to the monorepo node_modules. Resolve the public
// package once, then present that installation to the shared gate's file reader.
const fs: FsReader = {
  exists: (path) => { const at = installedPath(path); return at === null ? local.exists(path) : engine.exists(at); },
  readText: (path) => { const at = installedPath(path); return at === null ? local.readText(path) : engine.readText(at); },
  readDir: (path) => { const at = installedPath(path); return at === null ? local.readDir(path) : engine.readDir(at); },
  isExecutable: (path) => { const at = installedPath(path); return at === null ? local.isExecutable(path) : engine.isExecutable(at); },
  isDirectory: (path) => { const at = installedPath(path); return at === null ? local.isDirectory(path) : engine.isDirectory(at); },
};

const results = runSdkPinGate(fs, loadToolchainConfig(root).sdkPin);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id}: ${result.detail}`);
if (results.some((result) => !result.ok)) process.exit(1);
