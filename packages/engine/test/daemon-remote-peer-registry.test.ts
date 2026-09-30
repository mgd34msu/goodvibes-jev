import { describe, expect, it } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { HandlerSqliteStore } from '../sdk/src/platform/state/daemon-handler-sqlite-store.ts';
import {
  PeerRegistry,
  PeerRegistryValidationError,
  normalizeBackendConfig,
} from '../sdk/src/platform/runtime/remote/host/peer-registry.ts';

const PEER_ROW_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS peers (
     peerId TEXT PRIMARY KEY,
     displayName TEXT NOT NULL,
     backendKind TEXT NOT NULL,
     backendConfig TEXT NOT NULL
   )`,
];

/**
 * Write directly to the same sqlite file a PeerRegistry opens, bypassing
 * register()'s normalizeBackendConfig() validation entirely. This is the
 * only way to produce the row shape a hand-edited database, a stale schema
 * version, or on-disk corruption would leave behind, register() itself
 * refuses to write anything malformed.
 *
 * Precondition: close any open PeerRegistry on this directory first. Both
 * stores save a whole-file image, so a still-open registry's next save()
 * would overwrite the corruption written here.
 */
async function corruptRow(dir: string, peerId: string, columns: { backendKind?: string; backendConfig?: string }): Promise<void> {
  const raw = new HandlerSqliteStore({ workingDirectory: dir, fileName: 'peer-registry.sqlite', schema: PEER_ROW_SCHEMA });
  await raw.init();
  if (columns.backendKind !== undefined) {
    raw.run('UPDATE peers SET backendKind = ? WHERE peerId = ?', [columns.backendKind, peerId]);
  }
  if (columns.backendConfig !== undefined) {
    raw.run('UPDATE peers SET backendConfig = ? WHERE peerId = ?', [columns.backendConfig, peerId]);
  }
  await raw.save();
  raw.close();
}

const SECRET_REF = 'goodvibes://secrets/goodvibes/REMOTE_SSH_KEY';
const CRED_REF = 'goodvibes://secrets/goodvibes/CLOUD_CRED';

async function freshRegistry(): Promise<PeerRegistry> {
  const registry = new PeerRegistry(makeProjectTempDir('remote-peers'));
  await registry.init();
  return registry;
}

describe('normalizeBackendConfig', () => {
  it('normalizes a docker config without credentials', () => {
    const config = normalizeBackendConfig('docker', { containerName: 'web', extra: 'ignored' });
    expect(config).toEqual({ kind: 'docker', containerName: 'web' });
  });

  it('accepts a docker host socket path with no embedded credentials', () => {
    const config = normalizeBackendConfig('docker', {
      containerName: 'web',
      dockerHost: 'unix:///var/run/docker.sock',
    });
    expect(config).toMatchObject({ kind: 'docker', dockerHost: 'unix:///var/run/docker.sock' });
  });

  it('rejects a docker host that embeds credentials and is not a secret ref', () => {
    expect(() =>
      normalizeBackendConfig('docker', {
        containerName: 'web',
        dockerHost: 'tcp://user:wordfake@10.0.0.1:2376',
      }),
    ).toThrow(PeerRegistryValidationError);
  });

  it('accepts a docker host that is a valid goodvibes://secrets/ reference', () => {
    const config = normalizeBackendConfig('docker', {
      containerName: 'web',
      dockerHost: 'goodvibes://secrets/goodvibes/DOCKER_TLS_HOST',
    });
    expect(config).toMatchObject({
      kind: 'docker',
      dockerHost: 'goodvibes://secrets/goodvibes/DOCKER_TLS_HOST',
    });
  });

  it('rejects a TLS docker host given as a raw URL (must be a secret ref)', () => {
    // A TLS daemon endpoint carries credentials out-of-band; docker.ts only
    // resolves goodvibes:// values, so a raw https:// host would bypass the
    // credential store entirely. Registration must reject it up front.
    expect(() =>
      normalizeBackendConfig('docker', {
        containerName: 'web',
        dockerHost: 'https://10.0.0.1:2376',
      }),
    ).toThrow(/TLS Docker daemon/);
  });

  it('rejects a malformed goodvibes:// docker host that is not a valid secret ref', () => {
    // Would be handed to credentials.resolveRef() and fail opaquely; reject now.
    expect(() =>
      normalizeBackendConfig('docker', {
        containerName: 'web',
        dockerHost: 'goodvibes://docker-host-typo',
      }),
    ).toThrow(/malformed/);
  });

  it('requires a secret reference for the ssh identity', () => {
    expect(() =>
      normalizeBackendConfig('ssh', {
        sshHost: 'host.example',
        sshUser: 'deploy',
        identityRef: 'word-style-fake-private-key-not-a-ref',
      }),
    ).toThrow(/goodvibes:\/\/secrets/);
  });

  it('normalizes a valid ssh config with a secret ref and port', () => {
    const config = normalizeBackendConfig('ssh', {
      sshHost: 'host.example',
      sshUser: 'deploy',
      identityRef: SECRET_REF,
      sshPort: 2222,
    });
    expect(config).toEqual({
      kind: 'ssh',
      sshHost: 'host.example',
      sshUser: 'deploy',
      identityRef: SECRET_REF,
      sshPort: 2222,
    });
  });

  it('rejects an out-of-range ssh port', () => {
    expect(() =>
      normalizeBackendConfig('ssh', {
        sshHost: 'host.example',
        sshUser: 'deploy',
        identityRef: SECRET_REF,
        sshPort: 70000,
      }),
    ).toThrow(PeerRegistryValidationError);
  });

  it('requires a secret reference for the cloud credential and validates provider', () => {
    expect(() =>
      normalizeBackendConfig('cloud-terminal', {
        provider: 'gcp',
        credentialRef: 'raw-word-fake-credential',
      }),
    ).toThrow(/goodvibes:\/\/secrets/);
    expect(() =>
      normalizeBackendConfig('cloud-terminal', {
        provider: 'digitalocean',
        credentialRef: CRED_REF,
      }),
    ).toThrow(/provider/);
  });

  it('normalizes a cloud-terminal config with optional location/instance', () => {
    const config = normalizeBackendConfig('cloud-terminal', {
      provider: 'aws',
      credentialRef: CRED_REF,
      location: 'us-east-1',
      instance: 'i-123',
    });
    expect(config).toEqual({
      kind: 'cloud-terminal',
      provider: 'aws',
      credentialRef: CRED_REF,
      location: 'us-east-1',
      instance: 'i-123',
    });
  });

  it('normalizes a local-process allowlist, dropping blanks', () => {
    const config = normalizeBackendConfig('local-process', {
      cwd: '/srv/app',
      allowedCommands: ['git', '  ', 'ls', 42],
    });
    expect(config).toEqual({
      kind: 'local-process',
      cwd: '/srv/app',
      allowedCommands: ['git', 'ls'],
    });
  });
});

describe('PeerRegistry', () => {
  it('registers, retrieves, lists, and removes peers', async () => {
    const registry = await freshRegistry();
    const record = await registry.register({
      peerId: 'peer-ssh',
      displayName: 'SSH Peer',
      backendKind: 'ssh',
      backendConfig: { sshHost: 'host.example', sshUser: 'deploy', identityRef: SECRET_REF },
    });
    expect(record.backendConfig).toEqual({
      kind: 'ssh',
      sshHost: 'host.example',
      sshUser: 'deploy',
      identityRef: SECRET_REF,
    });

    expect(registry.get('peer-ssh')?.displayName).toBe('SSH Peer');
    expect(registry.get('missing')).toBeNull();
    expect(registry.list().map((p) => p.peerId)).toEqual(['peer-ssh']);

    expect(await registry.remove('peer-ssh')).toBe(true);
    expect(await registry.remove('peer-ssh')).toBe(false);
    expect(registry.get('peer-ssh')).toBeNull();
    registry.close();
  });

  it('upserts on conflicting peerId and persists across reopen', async () => {
    const dir = makeProjectTempDir('remote-peers-persist');
    const first = new PeerRegistry(dir);
    await first.init();
    await first.register({
      peerId: 'peer-local',
      displayName: 'Local',
      backendKind: 'local-process',
      backendConfig: { allowedCommands: ['echo'] },
    });
    await first.register({
      peerId: 'peer-local',
      displayName: 'Local Renamed',
      backendKind: 'local-process',
      backendConfig: { allowedCommands: ['echo', 'ls'] },
    });
    first.close();

    const second = new PeerRegistry(dir);
    await second.init();
    const reloaded = second.get('peer-local');
    expect(reloaded?.displayName).toBe('Local Renamed');
    expect(reloaded?.backendConfig).toEqual({
      kind: 'local-process',
      allowedCommands: ['echo', 'ls'],
    });
    second.close();
  });

  it('rejects an embedded secret in a registered peer config', async () => {
    const registry = await freshRegistry();
    await expect(
      registry.register({
        peerId: 'peer-bad',
        displayName: 'Bad',
        backendKind: 'ssh',
        backendConfig: { sshHost: 'h', sshUser: 'u', identityRef: 'inline-word-fake-key' },
      }),
    ).rejects.toThrow(PeerRegistryValidationError);
    registry.close();
  });

  it('throws when used before init', () => {
    const registry = new PeerRegistry(makeProjectTempDir('remote-peers-noinit'));
    expect(() => registry.get('x')).toThrow(/not initialized/);
  });

  describe('a corrupt row takes the degrade path (clear, typed error)', () => {
    it('a backendConfig that is not valid JSON is rejected, not thrown as a raw parse error', async () => {
      const dir = makeProjectTempDir('remote-peers-corrupt-json');
      const seed = new PeerRegistry(dir);
      await seed.init();
      await seed.register({
        peerId: 'peer-bad-json',
        displayName: 'Bad JSON',
        backendKind: 'local-process',
        backendConfig: {},
      });
      seed.close();

      await corruptRow(dir, 'peer-bad-json', { backendConfig: 'not json{{{' });

      const registry = new PeerRegistry(dir);
      await registry.init();
      expect(() => registry.get('peer-bad-json')).toThrow(PeerRegistryValidationError);
      expect(() => registry.list()).toThrow(PeerRegistryValidationError);
      registry.close();
    });

    it('a backendConfig that parses but is not an object is rejected', async () => {
      const dir = makeProjectTempDir('remote-peers-corrupt-shape');
      const seed = new PeerRegistry(dir);
      await seed.init();
      await seed.register({
        peerId: 'peer-bad-shape',
        displayName: 'Bad Shape',
        backendKind: 'local-process',
        backendConfig: {},
      });
      seed.close();

      await corruptRow(dir, 'peer-bad-shape', { backendConfig: '"just a string"' });

      const registry = new PeerRegistry(dir);
      await registry.init();
      expect(() => registry.get('peer-bad-shape')).toThrow(PeerRegistryValidationError);
      registry.close();
    });

    it('a backendConfig missing a field its backendKind requires is rejected', async () => {
      const dir = makeProjectTempDir('remote-peers-corrupt-missing-field');
      const seed = new PeerRegistry(dir);
      await seed.init();
      await seed.register({
        peerId: 'peer-missing-field',
        displayName: 'Missing Field',
        backendKind: 'ssh',
        backendConfig: { sshHost: 'host.example', sshUser: 'deploy', identityRef: SECRET_REF },
      });
      seed.close();

      // A legacy/hand-edited row that dropped the required identityRef.
      await corruptRow(dir, 'peer-missing-field', {
        backendConfig: JSON.stringify({ kind: 'ssh', sshHost: 'host.example', sshUser: 'deploy' }),
      });

      const registry = new PeerRegistry(dir);
      await registry.init();
      expect(() => registry.get('peer-missing-field')).toThrow(/identityRef/);
      registry.close();
    });

    it('an unknown backendKind is rejected instead of flowing downstream unvalidated', async () => {
      const dir = makeProjectTempDir('remote-peers-corrupt-kind');
      const seed = new PeerRegistry(dir);
      await seed.init();
      await seed.register({
        peerId: 'peer-bad-kind',
        displayName: 'Bad Kind',
        backendKind: 'local-process',
        backendConfig: {},
      });
      seed.close();

      await corruptRow(dir, 'peer-bad-kind', { backendKind: 'quantum-teleport' });

      const registry = new PeerRegistry(dir);
      await registry.init();
      expect(() => registry.get('peer-bad-kind')).toThrow(PeerRegistryValidationError);
      expect(() => registry.get('peer-bad-kind')).toThrow(/backendKind/);
      registry.close();
    });

    it('remove() deletes a corrupt row that get() and list() reject', async () => {
      const dir = makeProjectTempDir('remote-peers-remove-corrupt');
      const seed = new PeerRegistry(dir);
      await seed.init();
      await seed.register({
        peerId: 'peer-corrupt',
        displayName: 'Corrupt',
        backendKind: 'local-process',
        backendConfig: {},
      });
      await seed.register({
        peerId: 'peer-good',
        displayName: 'Good',
        backendKind: 'local-process',
        backendConfig: {},
      });
      seed.close();

      await corruptRow(dir, 'peer-corrupt', { backendKind: 'quantum-teleport' });

      const registry = new PeerRegistry(dir);
      await registry.init();
      expect(() => registry.list()).toThrow(PeerRegistryValidationError);
      expect(await registry.remove('peer-corrupt')).toBe(true);
      expect(registry.list().map((peer) => peer.peerId)).toEqual(['peer-good']);
      expect(await registry.remove('peer-corrupt')).toBe(false);
      registry.close();
    });

    it('a registry with only well-formed rows lists and reads them exactly as registered', async () => {
      const dir = makeProjectTempDir('remote-peers-clean-list');
      const registry = new PeerRegistry(dir);
      await registry.init();
      await registry.register({
        peerId: 'peer-clean',
        displayName: 'Clean',
        backendKind: 'local-process',
        backendConfig: { cwd: '/srv/app' },
      });
      expect(registry.list().map((p) => p.peerId)).toEqual(['peer-clean']);
      registry.close();
    });
  });
});
