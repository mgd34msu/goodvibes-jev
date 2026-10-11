/** Read-only native receipt admission shared by the source installer and launcher. */
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { compareVersions, sha256, verifyChecksum } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { daemonCiPayloads, daemonNativeHost, DAEMON_NATIVE_TARGETS, type DaemonNativeTarget, type DaemonArtifactSource, type DaemonCiArtifact } from './native-artifact.ts';
const PACKAGE = '@goodvibes-jev/daemon';
const RECEIPT = 'daemon-installation.json';
export interface DaemonInstallOwner extends DaemonArtifactSource { readonly version: string; readonly target: DaemonNativeTarget; }
export interface InstallationReceipt { schema: 1; packageName: typeof PACKAGE; version: string; artifact: DaemonCiArtifact; }

export function validateOwner(owner: DaemonInstallOwner): void {
  daemonCiPayloads(owner.target);
  for (const value of [owner.sourceCommit, owner.sourceTree, owner.headCommit]) {
    if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Install requires exact source commit/tree/head SHAs');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+]|$)/.test(owner.version)) throw new Error('Install requires the source product SemVer');
  compareVersions(owner.version, owner.version);
}

export function assertPath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Install prefix must be an absolute normalized path');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Install path contains a symlink: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}
export function targetPaths(prefix: string, target: DaemonNativeTarget = daemonNativeHost()) {
  assertPath(prefix);
  return [...daemonCiPayloads(target), RECEIPT].map((path, index) => {
    const target = join(prefix, path); assertPath(target);
    return { label: path, path: target, assetName: `member-${index}`, executable: index < 2 };
  });
}
export function expectedModes(artifact: DaemonCiArtifact): void {
  const payloads = daemonCiPayloads(artifact.target);
  if (artifact.schema !== 1 || artifact.files.length !== payloads.length) throw new Error('Expected the complete Linux native CI cohort');
  for (const [index, file] of artifact.files.entries()) {
    if (file.path !== payloads[index] || file.mode !== (index < 2 ? 0o755 : 0o644)) throw new Error('Native cohort paths/modes do not match the current artifact contract');
  }
}

export function assertNativeInstallHost(platform: string = process.platform, arch: string = process.arch, target: DaemonNativeTarget = daemonNativeHost(platform, arch)): void {
  daemonCiPayloads(target);
  if (daemonNativeHost(platform, arch) !== target) throw new Error(`Native target ${target} does not match host ${platform}-${arch}`);
}

/** Validate only fixed cohort paths, never paths supplied by receipt JSON. */
export function inspectInstallationIdentity(prefix: string, suffix: '' | '.previous', target: DaemonNativeTarget = daemonNativeHost()): InstallationReceipt | null {
  const paths = targetPaths(prefix, target);
  const exists = (path: string): boolean => {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  for (const other of DAEMON_NATIVE_TARGETS.filter(value => value !== target)) {
    for (const path of daemonCiPayloads(other)) for (const ending of [suffix, '.update-transaction', '.update-download', '.update-previous', '.rollback-exchange']) {
      const foreign = join(prefix, path) + ending; assertPath(foreign);
      if (exists(foreign)) throw new Error('Installation contains a different native target');
    }
  }
  if (!paths.some(target => exists(target.path + suffix))) return null;
  const receiptPath = join(prefix, RECEIPT + suffix); assertPath(receiptPath);
  const receiptStat = lstatSync(receiptPath);
  if (!receiptStat.isFile() || (receiptStat.mode & 0o777) !== 0o644) throw new Error('Invalid installation receipt file');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as InstallationReceipt;
  if (receipt.schema !== 1 || receipt.packageName !== PACKAGE) throw new Error('Receipt is not a daemon installation');
  validateOwner({ ...receipt.artifact, version: receipt.version }); expectedModes(receipt.artifact);
  if (receipt.artifact.target !== target) throw new Error('Installation target differs from the requested native target');
  return receipt;
}

/** Full admission is required for installation, native launch and the cohort being restored. */
export function inspectInstallation(prefix: string, suffix: '' | '.previous', target: DaemonNativeTarget = daemonNativeHost()): InstallationReceipt | null {
  const receipt = inspectInstallationIdentity(prefix, suffix, target);
  if (!receipt) return null;
  for (const [index, member] of targetPaths(prefix, target).entries()) {
    const path = member.path + suffix; assertPath(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o777) !== (member.executable ? 0o755 : 0o644)) throw new Error(`Invalid cohort member: ${member.label}`);
    if (index < receipt.artifact.files.length) {
      const file = receipt.artifact.files[index]!;
      verifyChecksum(member.label, sha256(readFileSync(path)), file.sha256);
      if (stat.size !== file.size) throw new Error(`Invalid cohort size: ${member.label}`);
    }
  }
  return receipt;
}
