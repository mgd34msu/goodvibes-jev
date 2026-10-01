import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { PeerRegistry, normalizeBackendConfig, PeerRegistryValidationError } from '../sdk/src/platform/runtime/remote/host/peer-registry.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function makeRegistry() {
  const directory = makeProjectTempDir('daemon-remote-peer-lifecycle');
  return { directory, registry: new PeerRegistry(directory) };
}

const LOCAL = { peerId: 'local', displayName: 'Local', backendKind: 'local-process' as const, backendConfig: {} };

describe('remote registry lifecycle', () => {
  test('close during background init cannot reopen the registry after teardown', async () => {
    const { registry } = makeRegistry();
    const initializing = registry.init();
    registry.close();
    await expect(initializing).rejects.toThrow('closed during initialization');
    expect(() => registry.list()).toThrow('not initialized');
    await registry.init();
    await registry.register(LOCAL);
    expect(registry.get('local')?.displayName).toBe('Local');
    registry.close();
  });

  test('concurrent init and writes persist every peer at the historical path', async () => {
    const { directory, registry } = makeRegistry();
    expect(registry.dbPath).toBe(join(directory, '.goodvibes', 'tui', 'operator', 'peer-registry.sqlite'));
    await Promise.all([registry.init(), registry.init(), registry.init()]);
    await Promise.all(Array.from({ length: 12 }, (_, i) => registry.register({ ...LOCAL, peerId: `peer-${i}` })));
    registry.close();
    const reopened = new PeerRegistry(directory);
    try {
      await reopened.init();
      expect(reopened.list()).toHaveLength(12);
      for (let i = 0; i < 12; i += 1) expect(reopened.get(`peer-${i}`)?.backendKind).toBe('local-process');
    } finally { reopened.close(); }
  });

  test('close is idempotent and post-close operations require a new init', async () => {
    const { registry } = makeRegistry();
    await registry.init();
    registry.close();
    registry.close();
    expect(() => registry.list()).toThrow('not initialized');
    await expect(registry.register(LOCAL)).rejects.toThrow('not initialized');
    await expect(registry.remove('local')).rejects.toThrow('not initialized');
  });
});

describe('remote registry credential references', () => {
  test.each([
    'goodvibes://secrets/',
    'goodvibes://secrets/goodvibes/',
    'goodvibes://elsewhere/goodvibes/KEY',
    'env:KEY',
    'file:/tmp/key',
  ])('rejects a prefix-only or non-daemon identity reference: %s', (identityRef) => {
    expect(() => normalizeBackendConfig('ssh', { sshHost: 'host.invalid', sshUser: 'fixture', identityRef }))
      .toThrow(PeerRegistryValidationError);
  });

  test('retains string ports, ref-only storage, whitespace normalization and sorted peer order', async () => {
    const { registry } = makeRegistry();
    await registry.init();
    try {
      await registry.register({
        peerId: ' z ', displayName: ' Z ', backendKind: 'ssh',
        backendConfig: { sshHost: ' host.invalid ', sshUser: ' fixture ', sshPort: '2222', identityRef: ' goodvibes://secrets/goodvibes/KEY ' },
      });
      await registry.register({ ...LOCAL, peerId: 'a' });
      expect(registry.list().map((peer) => peer.peerId)).toEqual(['a', 'z']);
      expect(registry.get('z')?.backendConfig).toEqual({
        kind: 'ssh', sshHost: 'host.invalid', sshUser: 'fixture', sshPort: 2222,
        identityRef: 'goodvibes://secrets/goodvibes/KEY',
      });
    } finally { registry.close(); }
  });
});
