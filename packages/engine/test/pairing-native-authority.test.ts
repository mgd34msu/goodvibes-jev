import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PairingTokenManager, PairingTokenStoreBusyError } from '../sdk/src/platform/pairing/pairing-token-store.js';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import type { NativeExecutionAuthority } from '../sdk/src/platform/security/http-auth.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-native-pair-')); dirs.push(dir);
  const file = join(dir, 'pairing.json');
  const manager = new PairingTokenManager(file);
  const paired = manager.mint({ name: 'Synthetic device' });
  const catalog = new GatewayMethodCatalog();
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, pairingTokens: manager, authToken: () => 'synthetic-shared',
    userAuth: {
      validateSession: (token: string) => token === 'synthetic-session' ? { username: `pairing:${paired.id}` } : null,
      getUser: (username: string) => ({ username, roles: ['admin'] }),
    },
  } as unknown as DaemonControlPlaneContext);
  return { file, manager, paired, helper, catalog };
}
function persisted(file: string) { return JSON.parse(readFileSync(file, 'utf8')); }

describe('persisted paired native authority', () => {
  test('uses the persisted unique pairing incarnation, survives restart, never exposes secret/hash', () => {
    const item = fixture();
    const identity = item.manager.authenticateNative(item.paired.token);
    expect(identity).toEqual({ kind: 'pairing-token', tokenId: item.paired.id,
      principalId: `pairing:${item.paired.id}`, authorityId: `pairing:${item.paired.id}`, authorityRevision: item.paired.id });
    const diskBefore = readFileSync(item.file, 'utf8');
    expect(new PairingTokenManager(item.file).authenticateNative(item.paired.token)).toEqual(identity);
    expect(readFileSync(item.file, 'utf8')).toBe(diskBefore);
    item.manager.rename(item.paired.id, 'New label');
    expect(item.manager.authenticateNative(item.paired.token)).toEqual(identity);
    expect(JSON.stringify(identity)).not.toContain(item.paired.token);
    expect(JSON.stringify(identity)).not.toContain('tokenHash');
  });

  test('explicitly refuses shared/session credentials even when a session principal looks paired', () => {
    const item = fixture();
    expect(item.helper.describeAuthenticatedPrincipal('synthetic-shared')).not.toBeNull();
    expect(item.helper.describeAuthenticatedPrincipal('synthetic-session')?.principalId).toBe(`pairing:${item.paired.id}`);
    expect(item.helper.createNativeExecutionAuthority('synthetic-shared')).toBeNull();
    expect(item.helper.createNativeExecutionAuthority('synthetic-session')).toBeNull();
    expect(item.helper.createNativeExecutionAuthority(item.paired.token)?.current()?.kind).toBe('pairing-token');
    writeFileSync(item.file, '{corrupt paired store');
    expect(item.helper.createNativeExecutionAuthority(item.paired.token)).toBeNull();
    expect(item.helper.describeAuthenticatedPrincipal('synthetic-shared')).not.toBeNull();
    expect(item.helper.describeAuthenticatedPrincipal('synthetic-session')).not.toBeNull();
  });

  test('missing, corrupt, duplicate and replaced records fail closed without repairing persisted data', () => {
    const item = fixture(); const original = persisted(item.file);
    for (const value of ['{bad json', JSON.stringify({ tokens: [null] }),
      JSON.stringify({ tokens: [original.tokens[0], original.tokens[0]] }),
      JSON.stringify({ tokens: [{ ...original.tokens[0], id: 'pair-11111111-1111-4111-8111-111111111111' }] }),
      JSON.stringify({ tokens: [{ ...original.tokens[0], createdAt: original.tokens[0].createdAt + 1 }] }),
      JSON.stringify({ tokens: [] })]) {
      writeFileSync(item.file, value);
      expect(item.manager.authenticateNative(item.paired.token)).toBeNull();
      expect(readFileSync(item.file, 'utf8')).toBe(value);
    }
    rmSync(item.file);
    expect(item.manager.authenticateNative(item.paired.token)).toBeNull();
  });

  test('every stale writer reloads before mutation and cannot resurrect another owner\'s revocation', () => {
    for (const operation of ['last-seen', 'rename', 'mint', 'migrate', 'revoke', 'legacy'] as const) {
      const item = fixture();
      const stale = new PairingTokenManager(item.file);
      const survivor = item.manager.mint({ name: 'Other device' });
      item.manager.revoke(item.paired.id);
      expect(stale.authenticateNative(item.paired.token)).toBeNull();
      switch (operation) {
        case 'last-seen': expect(stale.authenticate(item.paired.token)).toBeNull(); stale.authenticate(survivor.token); break;
        case 'rename': expect(stale.rename(item.paired.id, 'Revived')).toBe(false); break;
        case 'mint': stale.mint({ name: 'New device' }); break;
        case 'migrate': stale.mintForMigration({ name: 'Migrated device' }); break;
        case 'revoke': stale.revoke(survivor.id); break;
        case 'legacy': stale.revokeLegacyShared(); break;
      }
      expect(persisted(item.file).tokens.some((record: { id: string }) => record.id === item.paired.id)).toBe(false);
      expect(new PairingTokenManager(item.file).authenticateNative(item.paired.token)).toBeNull();
    }
  });

  test('failed mint is never published and no uncommitted authority appears after restart', () => {
    const item = fixture(); const before = readFileSync(item.file, 'utf8');
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic disk failure'); });
    try { expect(() => item.manager.mint({ name: 'Never committed' })).toThrow('synthetic disk failure'); }
    finally { write.mockRestore(); }
    expect(item.manager.list()).toHaveLength(1);
    expect(readFileSync(item.file, 'utf8')).toBe(before);
    expect(new PairingTokenManager(item.file).list()).toHaveLength(1);
    expect(item.manager.authenticateNative(item.paired.token)).toBeNull();
  });

  test('failed revoke does not report success and ordinary last-seen cannot clear native failure', () => {
    const item = fixture();
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic disk failure'); });
    try { expect(() => item.manager.revoke(item.paired.id)).toThrow('synthetic disk failure'); }
    finally { write.mockRestore(); }
    expect(item.manager.authenticateNative(item.paired.token)).toBeNull();
    expect(item.manager.authenticate(item.paired.token)).not.toBeNull();
    expect(item.manager.authenticateNative(item.paired.token)).toBeNull();
    expect(item.manager.revoke(item.paired.id)).toBe(true);
    expect(new PairingTokenManager(item.file).authenticateNative(item.paired.token)).toBeNull();
  });

  test('owner lock covers awaits and rejects concurrent writers, releases on success/failure', async () => {
    const item = fixture(); const other = new PairingTokenManager(item.file);
    const capability = item.helper.createNativeExecutionAuthority(item.paired.token)!;
    const snapshot = capability.current()!;
    let escaped: (() => unknown) | undefined;
    await capability.withCurrent(snapshot, async assertCurrent => {
      escaped = assertCurrent;
      await Promise.resolve();
      expect(() => other.revoke(item.paired.id)).toThrow(PairingTokenStoreBusyError);
      expect(() => item.manager.rename(item.paired.id, 'Reentrant')).toThrow(PairingTokenStoreBusyError);
      expect(assertCurrent()).toEqual(snapshot);
    });
    expect(() => escaped!()).toThrow();
    await expect(capability.withCurrent(snapshot, () => { throw new Error('synthetic launch failure'); })).rejects.toThrow('synthetic launch failure');
    expect(other.revoke(item.paired.id)).toBe(true);
    expect(capability.current()).toBeNull();
    await expect(capability.withCurrent(snapshot, () => 'must not launch')).rejects.toThrow('no longer valid');
  });

  test('the native ownership fence is shared by a separate process', async () => {
    const item = fixture(); const capability = item.helper.createNativeExecutionAuthority(item.paired.token)!;
    const modulePath = fileURLToPath(new URL('../sdk/src/platform/pairing/pairing-token-store.ts', import.meta.url));
    await capability.withCurrent(capability.current()!, async assertCurrent => {
      const child = spawnSync(process.execPath, ['-e', `
        import { PairingTokenManager } from ${JSON.stringify(modulePath)};
        const manager = new PairingTokenManager(${JSON.stringify(item.file)});
        try { manager.revoke(${JSON.stringify(item.paired.id)}); process.exit(2); }
        catch (error) { if (error.code !== 'PAIRING_TOKEN_STORE_BUSY') throw error; }
      `], { encoding: 'utf8', timeout: 10_000 });
      expect(child.status).toBe(0);
      expect(child.stderr).toBe('');
      expect(assertCurrent().tokenId).toBe(item.paired.id);
    });
    expect(item.manager.revoke(item.paired.id)).toBe(true);
  });

  test('re-pairing creates a new persisted incarnation and rejects an old captured authority', async () => {
    const item = fixture(); const capability = item.helper.createNativeExecutionAuthority(item.paired.token)!;
    const expected = capability.current()!;
    const bounded = new PairingTokenManager(item.file, { maxPaired: () => 1 });
    const replacement = bounded.mint({ name: item.paired.name });
    expect(replacement.id).not.toBe(item.paired.id);
    expect(capability.current()).toBeNull();
    await expect(capability.withCurrent(expected, () => 'must not launch')).rejects.toThrow('no longer valid');
    expect(new PairingTokenManager(item.file).authenticateNative(replacement.token)?.authorityRevision).toBe(replacement.id);
  });

  test('a replaced lock invalidates final authorization and is never released as though still owned', async () => {
    const item = fixture(); const capability = item.helper.createNativeExecutionAuthority(item.paired.token)!;
    let launched = false;
    await expect(capability.withCurrent(capability.current()!, assertCurrent => {
      renameSync(`${item.file}.owner-lock`, `${item.file}.displaced-lock`);
      mkdirSync(`${item.file}.owner-lock`);
      assertCurrent();
      launched = true;
    })).rejects.toThrow(PairingTokenStoreBusyError);
    expect(launched).toBe(false);
    expect(existsSync(`${item.file}.owner-lock`)).toBe(true);
  });

  test('stale or externally held lock refuses launch without age-based stealing', async () => {
    const item = fixture(); const capability = item.helper.createNativeExecutionAuthority(item.paired.token)!;
    mkdirSync(`${item.file}.owner-lock`);
    let launched = false;
    await expect(capability.withCurrent(capability.current()!, () => { launched = true; })).rejects.toThrow(PairingTokenStoreBusyError);
    expect(launched).toBe(false);
  });

  test('live scopes are intersected with captured transport scope and checked again at launch', async () => {
    const item = fixture(); let liveScopes = ['read:synthetic', 'write:synthetic'];
    const catalog = spyOn(item.catalog, 'getAllScopes').mockImplementation(() => liveScopes);
    try {
      const capability = item.helper.createNativeExecutionAuthority(item.paired.token, ['write:synthetic'])!;
      const expected = capability.current()!;
      expect(expected.scopes).toEqual(['write:synthetic']);
      liveScopes = ['read:synthetic'];
      expect(capability.current()?.scopes).toEqual([]);
      let launched = false;
      await expect(capability.withCurrent(expected, () => { launched = true; })).rejects.toThrow('scopes');
      expect(launched).toBe(false);
      liveScopes = ['read:synthetic', 'write:synthetic', 'write:new'];
      expect(capability.current()?.scopes).toEqual(['write:synthetic']);
      await expect(capability.withCurrent(expected, async assertCurrent => {
        await Promise.resolve();
        liveScopes = ['read:synthetic'];
        assertCurrent();
        launched = true;
      })).rejects.toThrow('scopes');
      expect(launched).toBe(false);
    } finally { catalog.mockRestore(); }
  });

  test('gateway handler gets only the transport-created capability and cannot inject one in payload', async () => {
    const item = fixture(); let received: NativeExecutionAuthority | undefined;
    item.catalog.register({ id: 'synthetic.native', title: 'Native fixture', description: 'Fixture', category: 'fixture',
      source: 'builtin', access: 'admin', transport: ['http'], scopes: ['write:synthetic'],
      inputSchema: { type: 'object' } }, invocation => { received = invocation.nativeExecutionAuthority; return { kind: received?.current()?.kind }; });
    const call = (token: string) => item.helper.invokeGatewayMethodCall({ authToken: token, methodId: 'synthetic.native',
      context: { principalId: `pairing:${item.paired.id}`, principalKind: 'token', admin: true, scopes: ['write:synthetic'] },
      body: { nativeExecutionAuthority: { current: 'forged' } } });
    expect((await call(item.paired.token)).body).toEqual({ kind: 'pairing-token' });
    expect(JSON.stringify(received)).toBe('{}');
    expect((await call('synthetic-shared')).body).toEqual({ kind: undefined });
    expect(received).toBeUndefined();
  });
});
