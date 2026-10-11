#!/usr/bin/env bun
/** Explicit offline consumer of the existing private Linux native CI cohort. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  applyVerifiedUpdate, captureUpdateFileIo, realUpdateFileIo, rollbackKeptPrevious, sha256, UpdateTransactionError,
  type UpdateFileIo, type UpdateFetchLike,
} from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { readVerifiedDaemonCiArtifact } from './ci-artifact.ts';
import { assertNativeInstallHost, assertPath, expectedModes, inspectInstallation, inspectInstallationIdentity, targetPaths, validateOwner, type DaemonInstallOwner, type InstallationReceipt } from '../src/cli/native-installation.ts';
import { daemonNativeHost, type DaemonNativeTarget } from '../src/cli/native-artifact.ts';

export { assertNativeInstallHost, type DaemonInstallOwner } from '../src/cli/native-installation.ts';

const PACKAGE = '@goodvibes-jev/daemon';
const LOCAL_ORIGIN = 'https://daemon-local-artifacts.invalid';
/** Version identity belongs to the selected daemon source manifest, not root release tags. */
export function readDaemonInstallOwner(repoRoot: string, sourceCommit: string, headCommit: string, target: DaemonNativeTarget = daemonNativeHost()): DaemonInstallOwner {
  for (const value of [sourceCommit, headCommit]) if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Expected an exact Git commit SHA');
  const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const manifest = JSON.parse(git('show', `${sourceCommit}:products/daemon/package.json`)) as { name?: unknown; private?: unknown; version?: unknown };
  if (manifest.name !== PACKAGE || manifest.private !== true || typeof manifest.version !== 'string') throw new Error('Source must identify the private daemon product');
  const owner = { sourceCommit, sourceTree: git('rev-parse', `${sourceCommit}^{tree}`), headCommit, target, version: manifest.version };
  validateOwner(owner);
  return owner;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path));
}
export interface InstallDaemonNativeOptions {
  readonly artifactRoot: string;
  readonly prefix: string;
  readonly owner: DaemonInstallOwner;
  readonly signal?: AbortSignal;
  readonly io?: UpdateFileIo;
}

/** No network, scripts, service registration, PATH mutation or default install destination. */
export async function installDaemonNative(options: InstallDaemonNativeOptions): Promise<void> {
  const owner = { ...options.owner }; validateOwner(owner);
  assertNativeInstallHost(process.platform, process.arch, owner.target);
  const { prefix, signal } = options;
  const io = captureUpdateFileIo(options.io ?? realUpdateFileIo);
  assertPath(resolve(options.artifactRoot));
  const artifactRoot = realpathSync(options.artifactRoot);
  const targets = targetPaths(prefix, owner.target);
  if (contains(artifactRoot, prefix) || contains(prefix, artifactRoot)) throw new Error('Install prefix and artifact source must not overlap');
  signal?.throwIfAborted();
  const artifact = await readVerifiedDaemonCiArtifact(artifactRoot, owner);
  expectedModes(artifact);
  // Snapshot after verification; canonical checksum verification below catches
  // any bytes changed since the verifier ran, before the first destination write.
  const buffers = artifact.files.map(file => { const path = join(artifactRoot, 'native', file.path); assertPath(path); return readFileSync(path); });
  const receipt: InstallationReceipt = { schema: 1, packageName: PACKAGE, version: owner.version, artifact };
  buffers.push(Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
  const hashes = [...artifact.files.map(file => file.sha256), sha256(buffers[buffers.length - 1]!)];
  const checksums = targets.map((target, index) => `${hashes[index]}  ${target.assetName}`).join('\n');
  // This adapter only serves captured local bytes. It cannot fall through to fetch.
  const readLocal: UpdateFetchLike = async url => {
    if (url === `${LOCAL_ORIGIN}/SHA256SUMS.txt`) return new Response(checksums);
    const index = targets.findIndex(target => url === `${LOCAL_ORIGIN}/${target.assetName}`);
    return index < 0 ? new Response(null, { status: 404 }) : new Response(new Uint8Array(buffers[index]!));
  };
  const alreadyInstalled = new Error('Identical daemon cohort already installed');
  try {
    await applyVerifiedUpdate({ fetchImpl: readLocal, downloadBaseUrl: LOCAL_ORIGIN, targets, platform: 'linux',
      ...(signal ? { signal } : {}), ...(io ? { io } : {}),
      beforeCommit: () => {
        const current = inspectInstallation(prefix, '', owner.target);
        const previous = inspectInstallation(prefix, '.previous', owner.target);
        if (!current && previous) throw new Error('Previous daemon cohort exists without a current installation');
        if (current && JSON.stringify(current) === JSON.stringify(receipt)) throw alreadyInstalled;
      },
    });
  } catch (error) {
    // Canonical compensation removes staging and claims. A repeat must not
    // discard the valuable previous cohort by rotating identical bytes again.
    if (error instanceof UpdateTransactionError && error.cause === alreadyInstalled && !error.receipt.recoveryRequired) return;
    throw error;
  }
}

/** Refuse partial previous cohorts; validate under canonical claims before any swap. */
export function rollbackDaemonNative(prefix: string, io?: UpdateFileIo): void {
  assertNativeInstallHost();
  if (!lstatSync(prefix).isDirectory()) throw new Error('Rollback prefix must already be an installation directory');
  const targets = targetPaths(prefix);
  const result = rollbackKeptPrevious(targets, io, () => {
    // The current payload may be damaged: rollback is its recovery path.
    // Admit only its owner/target here; fully verify the previous bytes below.
    if (!inspectInstallationIdentity(prefix, '')) throw new Error('No owned current daemon cohort is available');
    if (!inspectInstallation(prefix, '.previous')) throw new Error('No complete previous daemon cohort is available');
  });
  if (result.skipped.length) throw new Error('Previous native cohort changed before rollback completed');
}

export function parseNativeInstallArgs(args: readonly string[]): { action: 'install' | 'rollback'; prefix: string; artifactRoot?: string; sourceCommit?: string; headCommit?: string } {
  const [action, ...rest] = args;
  const usage = 'Usage: install-native.ts install --artifact-root PATH --prefix ABSOLUTE_PATH --source-commit SHA --head-commit SHA | rollback --prefix ABSOLUTE_PATH';
  if (action !== 'install' && action !== 'rollback') throw new Error(usage);
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!; const value = rest[i + 1];
    if (!['--prefix', '--artifact-root', '--source-commit', '--head-commit'].includes(key) || !value || value.startsWith('--') || values.has(key)) throw new Error(usage);
    values.set(key, value);
  }
  const prefix = values.get('--prefix'); if (!prefix || values.size !== (action === 'install' ? 4 : 1)) throw new Error(usage);
  assertPath(prefix);
  return action === 'rollback' ? { action, prefix } : { action, prefix, artifactRoot: values.get('--artifact-root')!, sourceCommit: values.get('--source-commit')!, headCommit: values.get('--head-commit')! };
}

if (import.meta.main) {
  try {
    const args = parseNativeInstallArgs(process.argv.slice(2));
    if (args.action === 'rollback') rollbackDaemonNative(args.prefix);
    else {
      const owner = readDaemonInstallOwner(resolve(import.meta.dir, '../../..'), args.sourceCommit!, args.headCommit!);
      await installDaemonNative({ prefix: args.prefix, artifactRoot: args.artifactRoot!, owner });
    }
    console.log(`[native:${args.action}] ${args.prefix}. No service or automatic updater was configured.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UpdateTransactionError && error.receipt.recoveryRequired) console.error(JSON.stringify(error.receipt));
    process.exitCode = 1;
  }
}
