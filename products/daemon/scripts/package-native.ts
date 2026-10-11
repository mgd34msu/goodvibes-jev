#!/usr/bin/env bun
/** Private offline native cohort gate. Never invokes a registry, release, or build. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readVerifiedDaemonCiArtifact } from './ci-artifact.ts';
import { daemonCiPayloads } from '../src/cli/native-artifact.ts';
import { stageDaemonCiArchive } from './acquire-native.ts';
import { installDaemonNative, readDaemonInstallOwner, type DaemonInstallOwner } from './install-native.ts';
import { assertPath, expectedModes, inspectInstallation, validateOwner } from '../src/cli/native-installation.ts';
import { verifiedDaemonNativePath } from '../src/cli/native-launch.ts';

/** Pack only admitted captured bytes, then re-admit the actual tarball before returning it. */
export async function packDaemonNative(artifactRoot: string, owner: DaemonInstallOwner): Promise<Buffer> {
  owner = { ...owner }; validateOwner(owner); assertPath(resolve(artifactRoot));
  const manifestPath = resolve(artifactRoot, 'native/ci-artifact.json'); assertPath(manifestPath);
  if (!lstatSync(manifestPath).isFile()) throw new Error('Native package manifest must be a regular file');
  const artifact = await readVerifiedDaemonCiArtifact(artifactRoot, owner); expectedModes(artifact);
  const scratch = mkdtempSync(join(tmpdir(), 'daemon-private-pack-'));
  try {
    const native = join(scratch, 'products/daemon/native'); mkdirSync(native, { recursive: true });
    for (const file of artifact.files) {
      const source = join(artifactRoot, 'native', file.path); assertPath(resolve(source));
      if (!lstatSync(source).isFile()) throw new Error('Native package member must remain a regular file');
      const target = join(native, file.path); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(source), { flag: 'wx', mode: file.mode }); chmodSync(target, file.mode);
    }
    writeFileSync(join(native, 'ci-artifact.json'), JSON.stringify(artifact, null, 2) + '\n', { mode: 0o644 });
    chmodSync(join(native, 'ci-artifact.json'), 0o644);
    // Detect source changes between initial verification and capture.
    await readVerifiedDaemonCiArtifact(join(scratch, 'products/daemon'), owner);
    const archive = join(scratch, 'cohort.tgz');
    execFileSync('tar', ['--format=ustar', '-czf', archive, ...[...daemonCiPayloads(owner.target), 'ci-artifact.json'].map(path => `products/daemon/native/${path}`)], { cwd: scratch });
    const bytes = readFileSync(archive);
    const restored = stageDaemonCiArchive(bytes, join(scratch, 'restored'), owner.target);
    await readVerifiedDaemonCiArtifact(restored, owner);
    return bytes;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Install the real archive into a fresh owned prefix, then run the production isolated verifier. */
export async function verifyDaemonNativePackage(archive: Uint8Array, owner: DaemonInstallOwner): Promise<void> {
  owner = { ...owner }; validateOwner(owner);
  const scratch = mkdtempSync(join(tmpdir(), 'daemon-private-consumer-'));
  try {
    const artifactRoot = stageDaemonCiArchive(archive, join(scratch, 'restored'), owner.target);
    const prefix = join(scratch, 'installed');
    await installDaemonNative({ artifactRoot, prefix, owner });
    const binary = verifiedDaemonNativePath(prefix, owner);
    // Remove the unpacked source before executing the installed artifact.
    rmSync(join(scratch, 'restored'), { recursive: true, force: true });
    execFileSync('node', [resolve(import.meta.dir, 'verify-binary.mjs'), '--binary', binary], {
      cwd: scratch, stdio: 'inherit', timeout: 300_000,
    });
    // The behavior probe must not mutate its installed cohort.
    const receipt = inspectInstallation(prefix, '', owner.target);
    if (!receipt || receipt.version !== owner.version) throw new Error('Native package installation disappeared during verification');
    verifiedDaemonNativePath(prefix, owner);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function parseNativePackageArgs(args: readonly string[]) {
  const usage = 'Usage: package-native.ts --artifact-root PATH --output ABSOLUTE_PATH --source-commit SHA --head-commit SHA';
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!['--artifact-root', '--output', '--source-commit', '--head-commit'].includes(key) || !value || value.startsWith('--') || values.has(key)) throw new Error(usage);
    values.set(key, value);
  }
  if (values.size !== 4) throw new Error(usage);
  const output = values.get('--output')!; assertPath(output);
  return { artifactRoot: values.get('--artifact-root')!, output, sourceCommit: values.get('--source-commit')!, headCommit: values.get('--head-commit')! };
}

if (import.meta.main) {
  try {
    const args = parseNativePackageArgs(process.argv.slice(2));
    const owner = readDaemonInstallOwner(resolve(import.meta.dir, '../../..'), args.sourceCommit, args.headCommit);
    const archive = await packDaemonNative(args.artifactRoot, owner);
    await verifyDaemonNativePackage(archive, owner);
    // Never replace an existing artifact; failed verification publishes no output.
    writeFileSync(args.output, archive, { flag: 'wx', mode: 0o600 });
    console.log(`[native:package] Verified private offline cohort: ${args.output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  }
}
