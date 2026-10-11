/** Fixed private Linux cohorts. Never construct payload paths from untrusted target strings. */
export const DAEMON_NATIVE_TARGETS = ['linux-x64', 'linux-arm64'] as const;
export type DaemonNativeTarget = typeof DAEMON_NATIVE_TARGETS[number];
const PAYLOADS = {
  'linux-x64': ['goodvibes-daemon-linux-x64', 'goodvibes-daemon-linux-x64.bun', 'goodvibes-daemon-linux-x64.bun.LICENSE.md', 'goodvibes-daemon-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so'],
  'linux-arm64': ['goodvibes-daemon-linux-arm64', 'goodvibes-daemon-linux-arm64.bun', 'goodvibes-daemon-linux-arm64.bun.LICENSE.md', 'goodvibes-daemon-linux-arm64.bun.json', 'lib/sqlite-vec-linux-arm64/vec0.so'],
} as const;
export function daemonCiPayloads(target: DaemonNativeTarget): readonly string[] {
  if (target !== 'linux-x64' && target !== 'linux-arm64') throw new Error('Expected a supported Linux native target');
  return PAYLOADS[target];
}
/** Compatibility name for the existing x64 CI lane. */
export const DAEMON_CI_PAYLOADS = PAYLOADS['linux-x64'];
export function daemonNativeHost(platform: string = process.platform, arch: string = process.arch): DaemonNativeTarget {
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return arch === 'x64' ? 'linux-x64' : 'linux-arm64';
  throw new Error(`Local native installation requires linux-x64 or linux-arm64, received ${platform}-${arch}`);
}
export interface DaemonArtifactSource {
  sourceCommit: string;
  sourceTree: string;
  headCommit: string;
  /** Omitted only by existing x64 recording callers. */
  target?: DaemonNativeTarget;
}
export interface DaemonCiArtifact extends DaemonArtifactSource {
  schema: 1;
  target: DaemonNativeTarget;
  files: Array<{ path: string; sha256: string; mode: number; size: number }>;
}
