/**
 * Existing /config await-window regression. Real HTTP auth owners and handler;
 * only the effect sink is intercepted. This does not claim conditional config
 * CAS, post-dispatch cancellation or a strict persisted-auth mutation lease.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonSystemRouteHandlers } from '../daemon-sdk/src/system-routes.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../sdk/src/platform/security/user-auth.js';

const roots: string[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
type AuthKind = 'shared' | 'paired' | 'session' | 'cookie';
function fixture(kind: AuthKind, payload: Record<string, unknown> | Response = { key: 'display.theme', value: 'nord' }, admin = true) {
  const root = mkdtempSync(join(tmpdir(), 'config-current-auth-')); roots.push(root);
  let shared = 'synthetic-shared-operator';
  const pairing = new PairingTokenManager(join(root, 'pairing.json'));
  const paired = kind === 'paired' ? pairing.mint({ name: 'Synthetic test pairing' }) : undefined;
  const users = new UserAuthManager({ bootstrapFilePath: join(root, 'unused-users.json'),
    bootstrapCredentialPath: join(root, 'unused-bootstrap.txt'),
    users: [{ username: 'synthetic-admin', passwordHash: 'unused-synthetic-hash', roles: admin ? ['admin'] : ['viewer'] },
      { username: 'synthetic-spare', passwordHash: 'unused-synthetic-hash', roles: ['viewer'] }] });
  const session = users.createSession('synthetic-admin');
  const helper = new DaemonControlPlaneHelper({ pairingTokens: pairing, userAuth: users,
    authToken: () => shared } as unknown as DaemonControlPlaneContext);
  const token = kind === 'paired' ? paired!.token : kind === 'shared' ? shared : session.token;
  const request = new Request('http://synthetic.invalid/config', { method: 'POST', headers:
    kind === 'cookie' ? { cookie: `goodvibes_session=${token}` } : { authorization: `Bearer ${token}` } });
  let bodyStarted!: () => void; const started = new Promise<void>(resolve => { bodyStarted = resolve; });
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  let bodyCalls = 0; let swaps = 0;
  const writes: { key: string; value: unknown }[] = [];
  const values = new Map<string, unknown>([['display.theme', 'vaporwave']]);
  const handlers = createDaemonSystemRouteHandlers({
    requireAdmin: (req: Request) => helper.requireAdmin(req),
    parseJsonBody: async () => { bodyCalls++; bodyStarted(); await waiting; return payload; },
    isValidConfigKey: (key: string) => key === 'display.theme',
    swapManager: { requestSwap: async (current: string) => { swaps++; return { ok: true, current, previous: '/synthetic/previous' }; } },
    configManager: {
      get: (key: string) => values.get(key), getAll: () => ({}), getConfigPath: () => join(root, 'settings.json'),
      setDynamic: (key: string, value: unknown) => { writes.push({ key, value }); values.set(key, value); },
    },
  } as never);
  const revoke = () => {
    if (kind === 'paired') pairing.revoke(paired!.id);
    else if (kind === 'shared') pairing.revokeLegacyShared();
    else users.revokeSession(session.token);
  };
  return { run: () => handlers.postConfig(request), started, release, revoke, writes,
    bodyCalls: () => bodyCalls, swaps: () => swaps,
    deleteUser: () => { users.deleteUser('synthetic-admin'); },
    expireSession: () => {
      const clock = spyOn(Date, 'now').mockReturnValue(session.expiresAt + 1);
      restores.push(() => clock.mockRestore());
    },
    rotateShared: () => { shared = 'synthetic-replacement-operator'; } };
}

test.each(['shared', 'paired', 'session', 'cookie'] as const)('%s auth revoked during body await cannot mutate settings', async kind => {
  const f = fixture(kind); const operation = f.run(); await f.started;
  f.revoke(); f.release();
  const response = await operation;
  expect(f.writes).toHaveLength(0);
  expect(response.status).toBe(401);
});

test.each(['shared', 'paired', 'session', 'cookie'] as const)('unchanged %s authority retains the legacy config payload', async kind => {
  const f = fixture(kind); const operation = f.run(); await f.started; f.release();
  expect((await operation).status).toBe(200);
  expect(f.writes).toEqual([{ key: 'display.theme', value: 'nord' }]);
});

test('shared-token replacement during body await retires the old request', async () => {
  const f = fixture('shared'); const operation = f.run(); await f.started;
  f.rotateShared(); f.release();
  const response = await operation;
  expect(f.writes).toHaveLength(0); expect(response.status).toBe(401);
});

test.each(['session', 'cookie'] as const)('%s expiration during body await prevents mutation', async kind => {
  const f = fixture(kind); const operation = f.run(); await f.started;
  f.expireSession(); f.release();
  const response = await operation;
  expect(f.writes).toHaveLength(0); expect(response.status).toBe(401);
});

test.each(['session', 'cookie'] as const)('%s user deletion during body await prevents mutation', async kind => {
  const f = fixture(kind); const operation = f.run(); await f.started;
  f.deleteUser(); f.release();
  const response = await operation;
  expect(f.writes).toHaveLength(0); expect(response.status).toBe(401);
});

test('initial non-admin refusal still avoids reading the body', async () => {
  const f = fixture('session', undefined, false);
  expect((await f.run()).status).toBe(403);
  expect(f.bodyCalls()).toBe(0); expect(f.writes).toHaveLength(0);
});

test('malformed-body response stays unchanged and never mutates', async () => {
  const f = fixture('shared', new Response('Synthetic invalid JSON', { status: 400 }));
  const operation = f.run(); await f.started; f.release();
  expect((await operation).status).toBe(400); expect(f.writes).toHaveLength(0);
});

test('the same post-body authority check precedes manual workspace dispatch', async () => {
  const f = fixture('shared', { key: 'runtime.workingDir', value: '/synthetic/next' });
  const operation = f.run(); await f.started; f.revoke(); f.release();
  const response = await operation;
  expect(f.swaps()).toBe(0); expect(response.status).toBe(401);
});
