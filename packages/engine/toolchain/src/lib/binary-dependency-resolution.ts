import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { BinaryTarget } from '../config.js';
import { consoleLogger, realExec, type Exec, type Logger } from './effects.js';

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly optionalDependencies?: Readonly<Record<string, unknown>>;
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}

function readPackage(directory: string, expectedName: string, boundary?: string): { path: string; directory: string; manifest: PackageManifest } {
  // Bind the package directory before following package.json. Linked package
  // directories are normal in workspaces; a manifest link must not redefine it.
  const packageDirectory = realpathSync(directory);
  if (boundary !== undefined && !isWithin(realpathSync(boundary), packageDirectory)) {
    throw new Error(`Native package ${expectedName} is outside its extraction directory`);
  }
  const manifestPath = realpathSync(join(packageDirectory, 'package.json'));
  if (!isWithin(packageDirectory, manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error(`Package manifest for ${expectedName} is outside its package directory`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  if (manifest.name !== expectedName) throw new Error(`Package name does not match ${expectedName}`);
  return { path: join(packageDirectory, 'package.json'), directory: packageDirectory, manifest };
}

/** Locate a package from its dependency owner, including linked stores and export subpaths. */
export function resolveOwnedPackageManifest(ownerManifestPath: string, packageName: string): string | null {
  // SDK imports can be export subpaths of the engine package. Resolve that
  // package's manifest rather than requiring a fictitious sdk/package.json.
  const parts = packageName.split('/');
  const ownerName = parts.slice(0, packageName.startsWith('@') ? 2 : 1).join('/');
  const require = createRequire(resolve(ownerManifestPath));
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    const directory = join(searchPath, ownerName);
    if (!existsSync(directory)) continue;
    return readPackage(directory, ownerName).path;
  }
  return null;
}

/** Match the requested target and pinned version before admitting its payload. */
export function resolveNativeAddonPayload(
  packageDirectory: string,
  packageName: string,
  version: string,
  file: string,
  extractionRoot?: string,
): string {
  const resolved = readPackage(packageDirectory, packageName, extractionRoot);
  if (resolved.manifest.version !== version) throw new Error(`Native package ${packageName} has a different installed version; expected ${version}`);
  if (basename(file) !== file || file === '.' || file === '..') throw new Error('Native addon filename must name one file');
  const payload = realpathSync(join(resolved.directory, file));
  if (!isWithin(resolved.directory, payload) || !statSync(payload).isFile()) {
    throw new Error(`Native addon ${packageName}/${file} is outside its package directory or is not a file`);
  }
  return payload;
}

export interface ProvideNativeAddonOptions {
  readonly root: string;
  readonly addonOutDir: string;
  readonly target: BinaryTarget;
  readonly sameHost: boolean;
  readonly sdkPackage?: string;
  readonly exec?: Exec;
  readonly logger?: Logger;
}

/** Stage from the installed dependency owner, or the existing pinned cross-target fetch. */
export function provideNativeAddon(options: ProvideNativeAddonOptions): boolean {
  const { root, target } = options;
  const packageName = target.nativeAddonPackage;
  const file = target.nativeAddonFile;
  if (!packageName || !file) return true;
  const productManifest = join(root, 'package.json');
  let ownerPath = resolveOwnedPackageManifest(productManifest, 'sqlite-vec');
  // Private clients depend on the engine; sqlite-vec belongs to that declared
  // dependency, not to a fictitious product-level or hoisted installation.
  if (ownerPath === null && options.sdkPackage) {
    const sdkName = options.sdkPackage.split('/').slice(0, options.sdkPackage.startsWith('@') ? 2 : 1).join('/');
    const product = JSON.parse(readFileSync(productManifest, 'utf8')) as PackageManifest;
    if (Object.hasOwn(product.dependencies ?? {}, sdkName) || Object.hasOwn(product.optionalDependencies ?? {}, sdkName)) {
      const sdkPath = resolveOwnedPackageManifest(productManifest, options.sdkPackage);
      if (sdkPath !== null) {
        const sdk = JSON.parse(readFileSync(sdkPath, 'utf8')) as PackageManifest;
        if (Object.hasOwn(sdk.dependencies ?? {}, 'sqlite-vec') || Object.hasOwn(sdk.optionalDependencies ?? {}, 'sqlite-vec')) {
          ownerPath = resolveOwnedPackageManifest(sdkPath, 'sqlite-vec');
        }
      }
    }
  }
  if (ownerPath === null) return false;
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as PackageManifest;
  const version = owner.optionalDependencies?.[packageName];
  // sqlite-vec declares exact per-platform versions. Do not silently replace a
  // missing/malformed target declaration with the current host or another range.
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`sqlite-vec does not pin a version for requested native package ${packageName}`);
  }
  const stage = (source: string): void => {
    const destDirectory = resolve(root, options.addonOutDir, packageName);
    mkdirSync(destDirectory, { recursive: true });
    copyFileSync(source, join(destDirectory, file));
  };
  const installed = resolveOwnedPackageManifest(ownerPath, packageName);
  if (installed !== null) {
    stage(resolveNativeAddonPayload(dirname(installed), packageName, version, file));
    return true;
  }
  if (options.sameHost) {
    (options.logger ?? consoleLogger).error(`[build-binaries] native addon missing for host target ${target.key}; run install`);
    return false;
  }
  const exec = options.exec ?? realExec;
  const scratch = mkdtempSync(join(tmpdir(), 'gv-addon-'));
  try {
    const packed = exec('npm', ['pack', `${packageName}@${version}`, '--pack-destination', scratch]);
    if (packed.status !== 0) return false;
    const tarball = packed.stdout.trim().split('\n').pop();
    if (!tarball || basename(tarball) !== tarball) return false;
    const unpacked = exec('tar', ['-xzf', join(scratch, tarball), '-C', scratch]);
    if (unpacked.status !== 0) return false;
    const payload = resolveNativeAddonPayload(join(scratch, 'package'), packageName, version, file, scratch);
    stage(payload);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
