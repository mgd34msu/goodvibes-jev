import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDaemonNativePayloads, resolveDaemonNativeTargets, sha256, type DaemonInstallationReceipt } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import type { DaemonNativeTarget } from '../../cli/native-artifact.ts';
/** Metadata fixture for inert/synthetic interpreters; it does not claim actual ELF execution. */
export function nativeRuntimeProvenance(runtime: string, target: DaemonNativeTarget = 'linux-x64'): string {
  return JSON.stringify({ version: '1.3.14', target, source: 'build-interpreter', sha256: sha256(Buffer.from(runtime)),
    upstreamSource: 'https://github.com/oven-sh/bun/tree/bun-v1.3.14' });
}

/** Complete inert native metadata; no fixture payload is executed. */
export function writeNativeInstallationFixture(prefix: string, version: string, arch: 'x64' | 'arm64' = 'x64') {
  const target = arch === 'x64' ? 'linux-x64' : 'linux-arm64';
  const payloads = resolveDaemonNativePayloads('linux', arch);
  const execPath = join(prefix, `goodvibes-daemon-linux-${arch}`);
  const targets = resolveDaemonNativeTargets(execPath, 'linux', arch);
  if (!payloads || !targets) throw new Error('Fixture requires the native Linux contract');
  const runtime = `synthetic runtime ${version}`;
  const buffers = [Buffer.from(`synthetic daemon ${version}`), Buffer.from(runtime), Buffer.from('synthetic runtime license'),
    Buffer.from(nativeRuntimeProvenance(runtime, target)), Buffer.from(`synthetic addon ${version}`)];
  const artifact = {
    schema: 1, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), target,
    files: payloads.map((payload, index) => {
      const bytes = buffers[index];
      if (!bytes) throw new Error('Fixture payload count changed');
      return { path: payload.relativePath, sha256: sha256(bytes), mode: payload.executable ? 0o755 : 0o644, size: bytes.length };
    }),
  } satisfies DaemonInstallationReceipt['artifact'];
  const receipt = { schema: 1, packageName: '@goodvibes-jev/daemon', version, artifact } satisfies DaemonInstallationReceipt;
  const assets: Record<string, Buffer> = {};
  for (const [index, member] of targets.entries()) {
    const bytes = buffers[index] ?? Buffer.from(JSON.stringify(receipt));
    mkdirSync(dirname(member.path), { recursive: true });
    writeFileSync(member.path, bytes); chmodSync(member.path, member.executable ? 0o755 : 0o644);
    assets[member.assetName] = index === buffers.length ? Buffer.from(JSON.stringify(artifact)) : bytes;
  }
  return { execPath, targets, buffers, receipt, assets,
    options: { bundled: true, execPath, version, platform: 'linux', arch },
    checksumManifest: Object.entries(assets).map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join(''),
  };
}
