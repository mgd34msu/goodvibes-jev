import { dirname, join } from 'node:path';
import { resolveDaemonNativePayloads, sha256, type DaemonCiArtifact, type UpdateFileIo } from '../../sdk/src/platform/runtime/self-update.ts';

export function nativeCohortFixture(options: {
  readonly version: string;
  readonly daemonBytes: string;
  readonly bunBytes?: string;
  readonly addonBytes?: string;
  readonly arch?: 'x64' | 'arm64';
}) {
  const arch = options.arch ?? 'x64';
  const payloads = resolveDaemonNativePayloads('linux', arch);
  if (!payloads) throw new Error('Native fixture requires a supported Linux target');
  const daemonAsset = `goodvibes-daemon-linux-${arch}`;
  const bun = Buffer.from(options.bunBytes ?? `bun-${options.version}`);
  const bodies = [
    Buffer.from(options.daemonBytes),
    bun,
    Buffer.from(`Bun license ${options.version}\n`),
    Buffer.from(JSON.stringify({
      version: '1.3.14', target: `linux-${arch}`, source: 'build-interpreter',
      sha256: sha256(bun), upstreamSource: 'https://github.com/oven-sh/bun/tree/bun-v1.3.14',
    })),
    Buffer.from(options.addonBytes ?? `addon-${options.version}`),
  ];
  const members = payloads.map((payload, index) => {
    const bytes = bodies[index];
    if (!bytes) throw new Error('Native fixture payload count changed');
    return { ...payload, bytes, mode: payload.executable ? 0o755 : 0o644 };
  });
  const artifact = {
    schema: 1,
    sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40),
    target: `linux-${arch}`,
    files: members.map(member => ({ path: member.relativePath, sha256: sha256(member.bytes), mode: member.mode, size: member.bytes.length })),
  } satisfies DaemonCiArtifact;
  const receipt = Buffer.from(JSON.stringify({ schema: 1, packageName: '@goodvibes-jev/daemon', version: options.version, artifact }));
  const assets = Object.fromEntries(members.map(member => [member.assetName, member.bytes]));
  assets[`${daemonAsset}.ci-artifact.json`] = Buffer.from(JSON.stringify(artifact));
  return {
    members, artifact, receipt, assets,
    installation(execPath: string, suffix = ''): Record<string, Buffer> {
      return Object.fromEntries([
        ...members.map((member, index) => {
          const path = index === 0 ? execPath
            : member.relativePath.startsWith(`${daemonAsset}.`)
              ? execPath + member.relativePath.slice(daemonAsset.length)
              : join(dirname(execPath), member.relativePath);
          return [path + suffix, member.bytes];
        }),
        [join(dirname(execPath), 'daemon-installation.json') + suffix, receipt],
      ]);
    },
    checksumManifest: Object.entries(assets).map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join(''),
  };
}

export function fixtureStrings(files: Record<string, Buffer>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, bytes.toString('utf8')]));
}

function fixtureMode(path: string): number {
  const live = path.replace(/\.(previous|update-download|update-previous|rollback-exchange|update-transaction)$/, '');
  return live.endsWith('.bun') || (!live.includes('/lib/') && !live.endsWith('.json') && !live.endsWith('.md')) ? 0o755 : 0o644;
}

/** Files have independent inode identities; renaming retains their identity. */
export function nativeMemoryIo(initial: Record<string, Buffer>) {
  const files = new Map<string, Buffer>(Object.entries(initial).map(([path, data]) => [path, Buffer.from(data)]));
  const modes = new Map<string, number>(Object.keys(initial).map(path => [path, fixtureMode(path)]));
  const identities = new Map<string, string>();
  let nextIdentity = 0;
  for (const path of files.keys()) identities.set(path, `inode-${++nextIdentity}`);
  const mutations: string[] = [];
  const io: UpdateFileIo & {
    readFile(path: string): Buffer;
    observe(path: string): { identity: string; ownerIdentity: string; mode: number } | null;
  } = {
    writeExclusive(path, data) {
      mutations.push(`claim:${path}`);
      if (files.has(path)) throw new Error(`file already exists: ${path}`);
      files.set(path, Buffer.from(data)); modes.set(path, 0o600); identities.set(path, `inode-${++nextIdentity}`);
    },
    remove(path) { mutations.push(`remove:${path}`); files.delete(path); modes.delete(path); identities.delete(path); },
    writeFile(path, data) {
      mutations.push(`write:${path}`); files.set(path, Buffer.from(data));
      if (!identities.has(path)) identities.set(path, `inode-${++nextIdentity}`);
      if (!modes.has(path)) modes.set(path, 0o600);
    },
    rename(from, to) {
      mutations.push(`rename:${from}:${to}`);
      const data = files.get(from); const mode = modes.get(from); const identity = identities.get(from);
      if (!data || mode === undefined || identity === undefined) throw new Error(`rename source missing: ${from}`);
      files.delete(from); modes.delete(from); identities.delete(from);
      files.set(to, data); modes.set(to, mode); identities.set(to, identity);
    },
    chmod(path, mode) { mutations.push(`chmod:${path}`); modes.set(path, mode); },
    exists(path) { return files.has(path); },
    mkdir(path) { mutations.push(`mkdir:${path}`); },
    readFile(path) {
      const data = files.get(path);
      if (!data) throw new Error(`read source missing: ${path}`);
      return Buffer.from(data);
    },
    observe(path) {
      if (!files.has(path)) return null;
      const mode = modes.get(path); const identity = identities.get(path);
      if (mode === undefined || identity === undefined) throw new Error(`fixture observation missing: ${path}`);
      return { identity, ownerIdentity: identity, mode };
    },
  };
  return { files, modes, identities, mutations, io };
}
