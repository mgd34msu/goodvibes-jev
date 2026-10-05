import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { BinaryTarget } from '../config.js';
import { resolveOwnedPackageManifest } from './binary-dependency-resolution.js';
import { BUN_1_3_14_LICENSE_NOTICE } from './bun-runtime-notices.js';
import { realExec, type Exec } from './effects.js';

/** Exact official distribution sources. Updates require a new notice and integrity review. */
const DISTRIBUTIONS = {
  'linux-x64': {
    packageName: '@oven/bun-linux-x64-baseline', architecture: 'x64', machine: 62,
    sha256: 'a8f9ebd1770ddc8e55dab7a68d4ec1ec1eebf374bb97cc65cf2c3cb373fc6791',
    integrity: 'sha512-q/8EdOC0yUE8FPeoOVq8/Pw5I9/tJaYmUfO/uDUAREx8IUnOJH1RJ5A3BjFqre8pvJoiZA9AovPJq5FnNNjSxA==',
  },
  'linux-arm64': {
    packageName: '@oven/bun-linux-aarch64', architecture: 'arm64', machine: 183,
    sha256: '37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086',
    integrity: 'sha512-X5SsPZHs+iYO8R/efIcRtc7gT2Q2DgPfliCxEkx4cXBumwkw0c/EsHMNwH3EgGpCDaZ7IYVPhpCG/xBOQHEwZw==',
  },
} as const;
type Distribution = (typeof DISTRIBUTIONS)[keyof typeof DISTRIBUTIONS];
const MAX_RUNTIME_BYTES = 160 * 1024 * 1024;

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}

/** Inspect the real payload, not its filename or the current host architecture. */
export function assertCapturedBunRuntimeElf(path: string, machine: number): void {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 64 || stat.size > MAX_RUNTIME_BYTES) throw new Error('Bun runtime must be a bounded regular ELF file');
  const bytes = readFileSync(path);
  if (bytes[0] !== 0x7f || bytes.toString('ascii', 1, 4) !== 'ELF' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== machine) {
    throw new Error('Bun runtime ELF architecture does not match the requested target');
  }
}

function ordinaryBun(path: string, version: string, exec: Exec): void {
  // No inherited BUN_BE_BUN, preload, bunfig, or project code. --print must be
  // evaluated by an ordinary interpreter, not merely echoed by an app's --version.
  const scratch = mkdtempSync(join(tmpdir(), 'gv-bun-probe-'));
  try {
    const probe = exec(path, ['--no-env-file', '--no-autoload-bunfig', '--print', 'JSON.stringify({version:Bun.version,platform:process.platform,arch:process.arch})'],
      { cwd: scratch, env: { HOME: scratch, TMPDIR: scratch }, timeoutMs: 10_000 });
    if (probe.status !== 0 || probe.stderr.trim() !== '' || probe.stdout.trim() !== JSON.stringify({ version, platform: process.platform, arch: process.arch })) {
      throw new Error(`Bun runtime is not an ordinary ${version} interpreter for this host`);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function packagePayload(manifestPath: string, distribution: Distribution, version: string, boundary?: string): string {
  const directory = realpathSync(dirname(manifestPath));
  const manifest = realpathSync(manifestPath);
  if (!within(directory, manifest) || (boundary && !within(realpathSync(boundary), directory))) throw new Error('Bun package manifest escaped its package boundary');
  const value = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown; os?: unknown; cpu?: unknown };
  if (value.name !== distribution.packageName || value.version !== version || !Array.isArray(value.os) || !value.os.includes('linux') || !Array.isArray(value.cpu) || !value.cpu.includes(distribution.architecture)) {
    throw new Error('Bun package name, version, or platform does not match the pinned target');
  }
  const payload = realpathSync(join(directory, 'bin/bun'));
  if (!within(directory, payload)) throw new Error('Bun runtime escaped its package boundary');
  assertCapturedBunRuntimeElf(payload, distribution.machine);
  return payload;
}

export interface ProvideCapturedBunRuntimeOptions {
  readonly root: string;
  readonly outDir: string;
  readonly target: BinaryTarget;
  /** Only artifact names actually compiled in this invocation. */
  readonly artifacts: readonly string[];
  readonly exec?: Exec;
}

/** Stage ordinary Bun beside compiled products. No runtime download or PATH lookup. */
export function provideCapturedBunRuntime(options: ProvideCapturedBunRuntimeOptions): void {
  const { target } = options;
  if (!target.capturedBunRuntime) return;
  if (target.capturedBunRuntime !== '1.3.14' || !Object.hasOwn(DISTRIBUTIONS, target.key) || target.bunTarget !== `bun-${target.key}`) {
    throw new Error(`Captured Bun runtime is unsupported for ${target.key}/${target.bunTarget}`);
  }
  if (options.artifacts.length === 0 || options.artifacts.some(name => !name || basename(name) !== name || name === '.' || name === '..')) throw new Error('Bun sidecars require compiled artifact filenames');
  const distribution = DISTRIBUTIONS[target.key as keyof typeof DISTRIBUTIONS];
  const version = target.capturedBunRuntime;
  const exec = options.exec ?? realExec;
  const sameHost = process.platform === 'linux' && process.arch === distribution.architecture;
  const output = resolve(options.root, options.outDir);
  mkdirSync(output, { recursive: true });
  const outputRoot = realpathSync(output);
  for (const artifact of options.artifacts) {
    const compiled = join(outputRoot, artifact);
    if (!existsSync(compiled) || !lstatSync(compiled).isFile()) throw new Error(`Compiled artifact missing or not a regular file: ${artifact}`);
  }
  // The temporary files and rename prevent following preexisting sidecar links.
  const stage = (source: string, provenance: string, pinnedPackage = false): void => {
    const staging = mkdtempSync(join(outputRoot, '.bun-runtime-'));
    try {
      const runtime = join(staging, 'bun');
      copyFileSync(source, runtime);
      chmodSync(runtime, 0o755);
      assertCapturedBunRuntimeElf(runtime, distribution.machine);
      const sha256 = createHash('sha256').update(readFileSync(runtime)).digest('hex');
      if (pinnedPackage && sha256 !== distribution.sha256) throw new Error('Bun runtime payload does not match the pinned official binary');
      if (sameHost) ordinaryBun(runtime, version, exec);
      const notice = `Bun ${version} ordinary runtime sidecar\nSource: https://github.com/oven-sh/bun/tree/bun-v${version}\nUpstream notice: https://github.com/oven-sh/bun/blob/bun-v${version}/LICENSE.md\n\nThe Bun binary includes components under other licenses, including statically linked LGPL JavaScriptCore/WebKit. Retain this notice and the corresponding source/relink materials when redistributing. This notice alone is not a release-compliance certification.\n\n${BUN_1_3_14_LICENSE_NOTICE}`;
      for (const artifact of options.artifacts) {
        const compiled = join(outputRoot, artifact);
        const dest = `${compiled}.bun`;
        copyFileSync(runtime, join(staging, 'next')); chmodSync(join(staging, 'next'), 0o755); renameSync(join(staging, 'next'), dest);
        writeFileSync(join(staging, 'notice'), notice); renameSync(join(staging, 'notice'), `${dest}.LICENSE.md`);
        writeFileSync(join(staging, 'provenance'), `${JSON.stringify({ version, target: target.key, ...(pinnedPackage ? { package: distribution.packageName } : {}), source: provenance, sha256, upstreamSource: `https://github.com/oven-sh/bun/tree/bun-v${version}` }, null, 2)}\n`);
        renameSync(join(staging, 'provenance'), `${dest}.json`);
      }
    } finally { rmSync(staging, { recursive: true, force: true }); }
  };
  // The currently executing interpreter is already the trusted build tool;
  // admit it only after matching the declared version, platform, and CLI mode.
  if (sameHost && process.versions.bun === version) {
    assertCapturedBunRuntimeElf(process.execPath, distribution.machine);
    stage(realpathSync(process.execPath), 'build-interpreter');
    return;
  }
  const installed = resolveOwnedPackageManifest(join(options.root, 'package.json'), distribution.packageName);
  if (installed !== null) {
    stage(packagePayload(installed, distribution, version), `installed:${distribution.packageName}@${version}`, true);
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'gv-bun-package-'));
  try {
    const packed = exec('npm', ['pack', `${distribution.packageName}@${version}`, '--ignore-scripts', '--registry=https://registry.npmjs.org', '--cache', join(scratch, 'cache'), '--pack-destination', scratch], { cwd: scratch, timeoutMs: 120_000 });
    if (packed.status !== 0) throw new Error(`Cannot fetch pinned Bun package ${distribution.packageName}@${version}: ${packed.stderr}`);
    const tarball = packed.stdout.trim().split('\n').at(-1);
    if (!tarball || basename(tarball) !== tarball || !tarball.endsWith('.tgz')) throw new Error('Invalid Bun package archive filename');
    const archive = join(scratch, tarball);
    if (!lstatSync(archive).isFile() || statSync(archive).size > MAX_RUNTIME_BYTES) throw new Error('Invalid Bun package archive');
    const integrity = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
    if (integrity !== distribution.integrity) throw new Error('Bun package archive does not match pinned integrity');
    const listed = exec('tar', ['-tvzf', archive], { timeoutMs: 30_000 });
    const entries = listed.stdout.trim().split('\n');
    if (listed.status !== 0 || entries.length !== 3 || entries.some(line => !line.startsWith('-') || !/ package\/(?:package\.json|README\.md|bin\/bun)$/.test(line))) throw new Error('Bun archive contains unexpected files or links');
    const unpacked = exec('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', scratch, 'package/package.json', 'package/bin/bun'], { timeoutMs: 30_000 });
    if (unpacked.status !== 0) throw new Error('Cannot extract pinned Bun runtime');
    stage(packagePayload(join(scratch, 'package/package.json'), distribution, version, scratch), `npm:${distribution.packageName}@${version}#${integrity}`, true);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
