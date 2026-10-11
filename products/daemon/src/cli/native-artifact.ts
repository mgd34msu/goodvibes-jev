/** Fixed private Linux cohorts shared with actual update and rollback publication. */
import { resolveDaemonNativePayloads, type DaemonNativeTarget } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
export { DAEMON_NATIVE_TARGETS, type DaemonNativeTarget, type DaemonArtifactSource, type DaemonCiArtifact } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
export function daemonCiPayloads(target: DaemonNativeTarget): readonly string[] {
  if (target !== 'linux-x64' && target !== 'linux-arm64') throw new Error('Expected a supported Linux native target');
  const payloads = resolveDaemonNativePayloads('linux', target.slice('linux-'.length));
  if (!payloads) throw new Error('Expected a supported Linux native target');
  return Object.freeze(payloads.map(payload => payload.relativePath));
}
/** Compatibility name for the existing x64 CI lane. */
export const DAEMON_CI_PAYLOADS = daemonCiPayloads('linux-x64');
export function daemonNativeHost(platform: string = process.platform, arch: string = process.arch): DaemonNativeTarget {
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return arch === 'x64' ? 'linux-x64' : 'linux-arm64';
  throw new Error(`Local native installation requires linux-x64 or linux-arm64, received ${platform}-${arch}`);
}
