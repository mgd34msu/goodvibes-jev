/** Fixed daemon payloads and receipt admission. Update publication stays in self-update.ts. */
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { parseSemanticVersion } from './semantic-version.js';
import type { UpdateFileIo, UpdateTarget } from './self-update.js';

export const DAEMON_NATIVE_TARGETS = ['linux-x64', 'linux-arm64'] as const;
export type DaemonNativeTarget = typeof DAEMON_NATIVE_TARGETS[number];
export const DAEMON_INSTALLATION_RECEIPT = 'daemon-installation.json';
export interface DaemonNativePayload { readonly relativePath: string; readonly assetName: string; readonly executable: boolean; }
export interface DaemonArtifactSource { sourceCommit: string; sourceTree: string; headCommit: string; target?: DaemonNativeTarget; }
export interface DaemonCiArtifact extends DaemonArtifactSource {
  schema: 1;
  target: DaemonNativeTarget;
  files: Array<{ path: string; sha256: string; mode: number; size: number }>;
}
export interface DaemonInstallationReceipt {
  schema: 1;
  packageName: '@goodvibes-jev/daemon';
  version: string;
  artifact: DaemonCiArtifact;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function resolveDaemonNativePayloads(platform: string, arch: string): readonly DaemonNativePayload[] | null {
  if (platform !== 'linux' || (arch !== 'x64' && arch !== 'arm64')) return null;
  const binary = `goodvibes-daemon-linux-${arch}`;
  return Object.freeze([
    { relativePath: binary, assetName: binary, executable: true },
    { relativePath: `${binary}.bun`, assetName: `${binary}.bun`, executable: true },
    { relativePath: `${binary}.bun.LICENSE.md`, assetName: `${binary}.bun.LICENSE.md`, executable: false },
    { relativePath: `${binary}.bun.json`, assetName: `${binary}.bun.json`, executable: false },
    { relativePath: `lib/sqlite-vec-linux-${arch}/vec0.so`, assetName: `sqlite-vec-linux-${arch}.so`, executable: false },
  ].map(value => Object.freeze(value)));
}
export function resolveDaemonNativeTargets(execPath: string, platform: string, arch: string): readonly UpdateTarget[] | null {
  const payloads = resolveDaemonNativePayloads(platform, arch);
  if (!payloads) return null;
  const root = dirname(execPath), binary = payloads[0];
  if (!binary) throw new Error('Native daemon payload contract is empty');
  if (basename(execPath) !== 'goodvibes-daemon' && basename(execPath) !== binary.relativePath) throw new Error('Native daemon executable path has the wrong product identity');
  const targets = payloads.map((payload, index) => ({ label: payload.relativePath,
    path: index === 0 ? execPath : index < 4 ? execPath + payload.relativePath.slice(binary.relativePath.length) : join(root, payload.relativePath),
    assetName: payload.assetName, executable: payload.executable }));
  return Object.freeze([...targets.map(value => Object.freeze(value)), Object.freeze({ label: DAEMON_INSTALLATION_RECEIPT,
    path: join(root, DAEMON_INSTALLATION_RECEIPT), assetName: `${binary.assetName}.ci-artifact.json`, executable: false })]);
}
export function parseDaemonCiArtifact(value: unknown, target: DaemonNativeTarget): DaemonCiArtifact {
  const payloads = resolveDaemonNativePayloads('linux', target.slice('linux-'.length));
  if (!payloads || !record(value) || !exact(value, ['schema', 'sourceCommit', 'sourceTree', 'headCommit', 'target', 'files'])
    || value.schema !== 1 || value.target !== target || !Array.isArray(value.files) || value.files.length !== payloads.length) throw new Error('Native daemon artifact identity is invalid');
  const { sourceCommit, sourceTree, headCommit } = value;
  if (typeof sourceCommit !== 'string' || typeof sourceTree !== 'string' || typeof headCommit !== 'string'
    || ![sourceCommit, sourceTree, headCommit].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Native daemon artifact requires exact source identities');
  const files = value.files.map((file: unknown, index) => {
    const payload = payloads[index];
    if (!payload || !record(file) || !exact(file, ['path', 'sha256', 'mode', 'size']) || typeof file.path !== 'string' || file.path !== payload.relativePath
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.mode !== 'number' || file.mode !== (payload.executable ? 0o755 : 0o644)
      || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('Native daemon artifact has an incomplete or invalid payload');
    return { path: file.path, sha256: file.sha256, mode: file.mode, size: file.size };
  });
  return { schema: 1, sourceCommit, sourceTree, headCommit, target, files };
}
export function parseDaemonInstallationReceipt(value: unknown, target: DaemonNativeTarget): DaemonInstallationReceipt {
  if (!record(value) || !exact(value, ['schema', 'packageName', 'version', 'artifact']) || value.schema !== 1 || value.packageName !== '@goodvibes-jev/daemon'
    || typeof value.version !== 'string' || !parseSemanticVersion(value.version)) throw new Error('Native daemon installation receipt is invalid');
  return { schema: 1, packageName: '@goodvibes-jev/daemon', version: value.version, artifact: parseDaemonCiArtifact(value.artifact, target) };
}
export function assertDaemonNativePayloadBytes(artifact: DaemonCiArtifact, buffers: readonly Buffer[]): void {
  if (buffers.length !== artifact.files.length) throw new Error('Native daemon payload set is incomplete');
  for (const [index, file] of artifact.files.entries()) {
    const bytes = buffers[index];
    if (!bytes || bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error(`Native daemon payload differs from its source manifest: ${file.path}`);
  }
  const bun = buffers[1], metadata = buffers[3];
  if (!bun || !metadata) throw new Error('Native daemon runtime is incomplete');
  const value: unknown = JSON.parse(metadata.toString('utf8'));
  if (!record(value) || value.version !== '1.3.14' || value.target !== artifact.target || value.sha256 !== digest(bun)
    || value.upstreamSource !== 'https://github.com/oven-sh/bun/tree/bun-v1.3.14' || typeof value.source !== 'string'
    || !(value.source === 'build-interpreter' || value.source.startsWith('installed:@oven/bun-linux-') || value.source.startsWith('npm:@oven/bun-linux-'))) throw new Error('Native daemon Bun runtime provenance is invalid');
}
/** Resolve the fixed paths ourselves; receipt JSON never supplies filesystem paths. */
export function inspectDaemonNativeInstallation(execPath: string, platform: string, arch: string, suffix: '' | '.previous', io: UpdateFileIo,
  options: { readonly integrity?: boolean } = {}): DaemonInstallationReceipt | null {
  const targets = resolveDaemonNativeTargets(execPath, platform, arch);
  if (!targets) throw new Error('Native daemon target is unsupported');
  if (!io.readFile || !io.observe) throw new Error('Native daemon I/O requires retained file observations and reads');
  for (const other of DAEMON_NATIVE_TARGETS.filter(target => target !== `linux-${arch}`)) {
    const payloads = resolveDaemonNativePayloads('linux', other.slice('linux-'.length));
    for (const payload of payloads ?? []) if (io.observe(join(dirname(execPath), payload.relativePath) + suffix) !== null) throw new Error('Native daemon installation contains a different target');
  }
  if (targets.every(target => io.observe!(target.path + suffix) === null)) return null;
  const target: DaemonNativeTarget = arch === 'x64' ? 'linux-x64' : 'linux-arm64';
  const receiptTarget = targets[targets.length - 1];
  if (!receiptTarget) throw new Error('Native daemon receipt contract is empty');
  const observation = io.observe(receiptTarget.path + suffix);
  if (!observation || observation.mode !== 0o644) throw new Error('Native daemon receipt is missing or invalid');
  const receipt = parseDaemonInstallationReceipt(JSON.parse(io.readFile(receiptTarget.path + suffix).toString('utf8')), target);
  if (options.integrity !== false) {
    const buffers = targets.slice(0, -1).map(member => {
      const observation = io.observe!(member.path + suffix);
      if (!observation || observation.mode !== (member.executable ? 0o755 : 0o644)) throw new Error(`Native daemon payload is missing or has the wrong mode: ${member.label}`);
      return io.readFile!(member.path + suffix);
    });
    assertDaemonNativePayloadBytes(receipt.artifact, buffers);
  }
  return receipt;
}
/** Complete physical identities and bytes are retained across asynchronous preparation. */
export function retainDaemonNativeFiles(targets: readonly UpdateTarget[], io: UpdateFileIo): () => void {
  const readFile = io.readFile, observe = io.observe;
  if (!readFile || !observe) throw new Error('Native daemon I/O requires retained file observations and reads');
  const snapshot = (path: string) => {
    const stat = observe(path);
    return stat === null ? null : `${stat.identity}:${stat.mode}:${digest(readFile(path))}`;
  };
  const retained = targets.flatMap(target => [target.path, target.path + '.previous']).map(path => ({ path, identity: snapshot(path) }));
  return () => { for (const file of retained) if (snapshot(file.path) !== file.identity) throw new Error('Native daemon installation changed during preparation'); };
}
export interface DaemonNativeRenameGuard {
  beforeRename(from: string, to: string, recovering: boolean): void;
  afterRename(from: string, to: string, recovering: boolean): void;
}
/** Advance only the exact native renames recorded by the existing transaction. */
export function createDaemonNativeRenameGuard(targets: readonly UpdateTarget[], io: UpdateFileIo): DaemonNativeRenameGuard {
  const readFile = io.readFile, observe = io.observe;
  if (!readFile || !observe) throw new Error('Native daemon I/O requires retained file observations and reads');
  const snapshot = (path: string) => {
    const stat = observe(path);
    if (stat !== null && !stat.ownerIdentity) throw new Error('Native daemon physical file ownership is unavailable');
    return stat === null ? null : { ...stat, hash: digest(readFile(path)) };
  };
  const states = new Map(targets.flatMap(target => ['', '.previous', '.update-download', '.update-previous', '.rollback-exchange'].map(suffix => {
    const path = target.path + suffix; return [path, snapshot(path)] as const;
  })));
  const check = (path: string) => {
    if (!states.has(path) || JSON.stringify(snapshot(path)) !== JSON.stringify(states.get(path))) throw new Error('Native daemon replacement is not the retained transaction owner');
  };
  return {
    beforeRename(from, to, recovering) {
      if (recovering) { check(from); check(to); }
      else for (const path of states.keys()) check(path);
      if (states.get(from) === null || states.get(to) !== null) throw new Error('Native daemon rename ownership is invalid');
    },
    afterRename(from, to, recovering) {
      const expected = states.get(from), actual = snapshot(to);
      if (!expected || !actual || actual.ownerIdentity !== expected.ownerIdentity || actual.hash !== expected.hash
        || actual.mode !== expected.mode || snapshot(from) !== null) throw new Error('Native daemon rename result is unknown');
      states.set(from, null); states.set(to, actual);
      if (!recovering) for (const path of states.keys()) check(path);
    },
  };
}
