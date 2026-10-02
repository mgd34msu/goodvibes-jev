#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { loadToolchainConfig } from '../lib/load-config.js';
import { realFsReader, consoleLogger } from '../lib/effects.js';
import { resolveTargets, runBuildBinaries } from '../lib/build-binaries.js';
import { readDependencyManifest, type DependencyManifest } from '../lib/optional-externals.js';
import { DEFAULT_SDK_PACKAGE, type BuildConfig } from '../config.js';

import { provideNativeAddon, resolveOwnedPackageManifest } from '../lib/binary-dependency-resolution.js';

const root = process.cwd();
const config = loadToolchainConfig(root);
if (!config.build) {
  consoleLogger.error('build-binaries: no `build` section in toolchain.config.json');
  process.exit(1);
}
const build: BuildConfig = config.build;

const nativeKey = `${process.platform === 'darwin' ? 'darwin' : process.platform}-${process.arch}`;

/**
 * The manifests whose optionalDependencies may be externalised: this repo's
 * own, plus the SDK it bundles. The SDK's are the ones that matter, it is
 * where the thirty optional packages are declared and where the dynamic
 * imports that make them genuinely optional live.
 */
function dependencyManifests(): DependencyManifest[] {
  const fs = realFsReader(root);
  const found: DependencyManifest[] = [];
  const own = readDependencyManifest(fs, 'package.json', 'this package');
  if (own) found.push(own);
  const sdkPackage = config.sdkPin?.sdkPackage ?? DEFAULT_SDK_PACKAGE;
  const sdkPath = resolveOwnedPackageManifest(join(root, 'package.json'), sdkPackage);
  const sdk = sdkPath === null ? null : readDependencyManifest(fs, sdkPath, sdkPackage);
  if (sdk) found.push(sdk);
  return found;
}

/**
 * Resolution from the build root, which is the same question bun's bundler
 * asks. `createRequire().resolve` answers it for a package that exists but has
 * no importable entry too, so a half-installed package is treated as present
 * exactly as bun would treat it.
 */
const manifests = dependencyManifests();
function isPackageInstalled(packageName: string): boolean {
  const owners = manifests.filter(manifest => manifest.required.includes(packageName) || manifest.optional.includes(packageName));
  return owners.every(owner => {
    const require = createRequire(resolve(root, owner.path));
    try { require.resolve(packageName); return true; } catch {
      return resolveOwnedPackageManifest(resolve(root, owner.path), packageName) !== null;
    }
  });
}

try {
  const selection = resolveTargets(process.argv.slice(2), build, nativeKey);
  const outcomes = runBuildBinaries({
    cwd: root, config: build, selection, nativeKey, provideAddon: (target, sameHost) => provideNativeAddon({ root, addonOutDir: build.addonOutDir, target, sameHost }), logger: consoleLogger,
    dependencyManifests: manifests,
    isPackageInstalled,
  });
  const failed = outcomes.filter((o) => !o.ok);
  consoleLogger.info(`build-binaries: ${outcomes.length - failed.length}/${outcomes.length} target(s) built`);
  process.exit(failed.length > 0 ? 1 : 0);
} catch (error) {
  consoleLogger.error(`build-binaries: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
