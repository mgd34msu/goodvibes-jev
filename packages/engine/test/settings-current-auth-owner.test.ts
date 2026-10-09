/** Same-serving-owner SETTINGS authority. No socket, real credential, or config effect. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingTokenManager, PairingTokenStoreBusyError } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../sdk/src/platform/security/user-auth.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { createServingSettingsPrecondition } from '../sdk/src/platform/daemon/http/settings-precondition.js';
import { createDaemonSystemRouteHandlers } from '../daemon-sdk/src/system-routes.js';

const roots: string[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() { const dir = mkdtempSync(join(tmpdir(), 'settings-auth-owner-')); roots.push(dir); return dir; }
type Kind = 'shared' | 'paired' | 'session' | 'cookie';
function fixture(kind: Kind = 'shared', options: { maxSessions?: number; admin?: boolean } = {}) {
  const dir = root(); const file = join(dir, 'pairing.json');
  let shared = 'synthetic-settings-shared'; let lifetime: object | null = {};
  const pairing = new PairingTokenManager(file);
  const paired = kind === 'paired' ? pairing.mint({ name: 'Synthetic settings device' }) : undefined;
  const roles = options.admin === false ? ['viewer'] : ['admin'];
  const users = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'),
    bootstrapCredentialPath: join(dir, 'bootstrap.txt'), maxSessions: options.maxSessions,
    scryptParams: { N: 16, r: 1, p: 1 },
    users: [{ username: 'operator', passwordHash: 'synthetic-unused-hash', roles },
      { username: 'spare', passwordHash: 'synthetic-unused-hash', roles: ['admin'] }] });
  const session = users.createSession('operator');
  const context = { pairingTokens: pairing, userAuth: users, authToken: () => shared, settingsLifetime: () => lifetime };
  const helper = new DaemonControlPlaneHelper(context as unknown as DaemonControlPlaneContext);
  const token = kind === 'paired' ? paired!.token : kind === 'shared' ? shared : session.token;
  const requestFor = (value = token, asCookie = kind === 'cookie') => new Request('http://synthetic.invalid/config', {
    method: 'POST', headers: asCookie ? { cookie: `goodvibes_session=${value}` } : { authorization: `Bearer ${value}` },
  });
  const request = requestFor();
  return { dir, file, pairing, paired, users, session, roles, helper, request, requestFor, token, context,
    rotateShared: () => { shared = 'synthetic-replacement'; lifetime = {}; },
    restoreShared: () => { shared = 'synthetic-settings-shared'; lifetime = {}; },
    rebind: () => { lifetime = {}; }, stop: () => { lifetime = null; },
    revoke: () => kind === 'paired' ? pairing.revoke(paired!.id) : kind === 'shared' ? pairing.revokeLegacyShared() : users.revokeSession(session.token),
  };
}
function capture(f: ReturnType<typeof fixture>) {
  const authority = f.helper.captureSettingsAdminAuthority(f.request);
  expect(authority).not.toBeNull(); return authority!;
}
function commit(f: ReturnType<typeof fixture>, authority: ReturnType<typeof capture>, before: () => void = () => {}) {
  let effects = 0;
  const run = () => f.helper.withSettingsAdminAuthority(f.request, authority, assertCurrent => {
    before(); assertCurrent(); effects++; return 'committed';
  });
  return { run, effects: () => effects };
}

describe('strict SETTINGS serving-owner auth', () => {
  test.each(['shared', 'paired', 'session', 'cookie'] as const)('%s current authority is opaque, one-use, and credential-free', kind => {
    const f = fixture(kind); const authority = capture(f); const action = commit(f, authority);
    const serial = JSON.stringify(authority);
    expect(serial).not.toContain(f.token); expect(serial).not.toContain('tokenHash'); expect(serial).not.toContain('passwordHash');
    expect(action.run()).toBe('committed'); expect(action.effects()).toBe(1);
    expect(() => action.run()).toThrow(); expect(action.effects()).toBe(1);
  });

  test.each(['shared', 'paired', 'session', 'cookie'] as const)('%s revocation after capture/before dispatch refuses', async kind => {
    const f = fixture(kind); const authority = capture(f); await Promise.resolve(); f.revoke();
    const action = commit(f, authority); expect(() => action.run()).toThrow(); expect(action.effects()).toBe(0);
  });

  test.each(['session', 'cookie'] as const)('%s callback revocation, user deletion, and expiry refuse at final check', kind => {
    for (const change of ['revoke', 'delete', 'expire', 'roles', 'password'] as const) {
      const f = fixture(kind); const authority = capture(f);
      const action = commit(f, authority, () => {
        if (change === 'revoke') f.revoke();
        if (change === 'delete') f.users.deleteUser('operator');
        if (change === 'roles') f.roles.splice(0, 1, 'viewer');
        if (change === 'password') f.users.rotatePassword('operator', 'synthetic-new-password');
        if (change === 'expire') {
          const clock = spyOn(Date, 'now').mockReturnValue(f.session.expiresAt);
          restores.push(() => clock.mockRestore());
        }
      });
      expect(() => action.run()).toThrow(); expect(action.effects()).toBe(0);
      for (const restore of restores.splice(0)) restore();
    }
  });

  test('same username and public session fields do not substitute for the exact session object', () => {
    const f = fixture('session'); const authority = capture(f);
    // Synthetic storage fault: replacement has exactly the same fields, including token and expiry.
    (f.users as unknown as { sessions: Map<string, unknown> }).sessions.set(f.token, { ...f.session });
    const action = commit(f, authority); expect(() => action.run()).toThrow(); expect(action.effects()).toBe(0);
  });

  test('session eviction invalidates the previously captured actual session', () => {
    const f = fixture('session', { maxSessions: 1 }); const authority = capture(f);
    f.users.createSession('operator'); const action = commit(f, authority);
    expect(() => action.run()).toThrow(); expect(action.effects()).toBe(0);
  });

  test.each(['shared', 'paired'] as const)('%s commit holds the existing owner lock through callbacks and final effect', kind => {
    const f = fixture(kind); const authority = capture(f); const other = new PairingTokenManager(f.file);
    const action = commit(f, authority, () => {
      expect(() => kind === 'shared' ? other.revokeLegacyShared() : other.revoke(f.paired!.id)).toThrow(PairingTokenStoreBusyError);
      expect(existsSync(`${f.file}.owner-lock`)).toBe(true);
    });
    expect(action.run()).toBe('committed'); expect(action.effects()).toBe(1);
    expect(existsSync(`${f.file}.owner-lock`)).toBe(false);
    expect(() => kind === 'shared' ? other.revokeLegacyShared() : other.revoke(f.paired!.id)).not.toThrow();
  });

  test('held lock refuses without fallback and a copied/cross-helper handle cannot execute', () => {
    const f = fixture('paired'); const authority = capture(f);
    mkdirSync(`${f.file}.owner-lock`); const action = commit(f, authority);
    expect(() => action.run()).toThrow(PairingTokenStoreBusyError); expect(action.effects()).toBe(0);
    rmSync(`${f.file}.owner-lock`, { recursive: true });
    expect(() => f.helper.withSettingsAdminAuthority(f.request, { ...authority }, () => 'forged')).toThrow();
    const other = new DaemonControlPlaneHelper(f.context as unknown as DaemonControlPlaneContext);
    expect(() => other.withSettingsAdminAuthority(f.request, authority, () => 'wrong owner')).toThrow();
  });

  test('paired final check binds both immutable id and createdAt and does not stamp lastSeen', () => {
    for (const field of ['id', 'createdAt'] as const) {
      const f = fixture('paired'); const before = readFileSync(f.file, 'utf8'); const authority = capture(f);
      expect(readFileSync(f.file, 'utf8')).toBe(before);
      const action = commit(f, authority, () => {
        const parsed = JSON.parse(before);
        parsed.tokens[0][field] = field === 'id' ? 'pair-11111111-1111-4111-8111-111111111111' : parsed.tokens[0].createdAt + 1;
        writeFileSync(f.file, JSON.stringify(parsed));
      });
      expect(() => action.run()).toThrow(); expect(action.effects()).toBe(0);
    }
  });

  test('fresh absent shared store works; removed previously observed store never becomes fresh absence', () => {
    const fresh = fixture(); expect(existsSync(fresh.file)).toBe(false); expect(commit(fresh, capture(fresh)).run()).toBe('committed');
    const f = fixture(); f.pairing.mint({ name: 'Makes the store real' }); const authority = capture(f); rmSync(f.file);
    const action = commit(f, authority); expect(() => action.run()).toThrow(); expect(action.effects()).toBe(0);
    expect(f.helper.requireAdmin(f.request)).toBeNull();
  });

  test('same-owner malformed startup recovery cannot authorize shared SETTINGS through resulting ENOENT', () => {
    const dir = root(); const file = join(dir, 'pairing.json'); writeFileSync(file, '{broken');
    const manager = new PairingTokenManager(file);
    expect(manager.isLegacyRevoked()).toBe(false); // unchanged manual recovery behavior
    expect(manager.captureSettingsAuthority({ kind: 'shared-token' })).toBeNull();
    expect(manager.captureSettingsAuthority({ kind: 'pairing-token', token: 'gvp_synthetic' })).toBeNull();
  });

  test('strict pairing startup uses its observed snapshot instead of a second recovery-capable read', () => {
    const dir = root(); const file = join(dir, 'pairing.json'); let recovered = false;
    const original = atomic.readJsonFileOrQuarantine;
    const reader = spyOn(atomic, 'readJsonFileOrQuarantine').mockImplementation(<T>(path: string, options: atomic.QuarantineLoadOptions<T>): T | null => {
      if (path === file) { recovered = true; writeFileSync(file, '{synthetic concurrent corruption'); }
      return original(path, options);
    });
    restores.push(() => reader.mockRestore());
    const manager = new PairingTokenManager(file);
    // Before the correction, the second reader recovered to ENOENT and the
    // clean first read accidentally authorized that different observation.
    expect(recovered ? manager.captureSettingsAuthority({ kind: 'shared-token' }) : null).toBeNull();
    expect(recovered).toBe(false);
    expect(manager.captureSettingsAuthority({ kind: 'shared-token' })).not.toBeNull();
  });

  test('startup read errors and owner-lock uncertainty cannot become fresh shared authority', () => {
    const dir = root(); const file = join(dir, 'pairing.json'); mkdirSync(file);
    const unreadable = new PairingTokenManager(file);
    expect(unreadable.captureSettingsAuthority({ kind: 'shared-token' })).toBeNull();
    const absent = join(dir, 'other.json'); mkdirSync(`${absent}.owner-lock`);
    const unverified = new PairingTokenManager(absent); rmSync(`${absent}.owner-lock`, { recursive: true });
    expect(unverified.captureSettingsAuthority({ kind: 'shared-token' })).toBeNull();
  });

  test.each(['malformed', 'read-error', 'durability'] as const)('current %s refuses strict shared auth while legacy cached fallback remains', failure => {
    const f = fixture(); f.pairing.mint({ name: 'Existing file' }); const authority = capture(f);
    if (failure === 'malformed') writeFileSync(f.file, '{bad');
    if (failure === 'read-error') { rmSync(f.file); mkdirSync(f.file); }
    if (failure === 'durability') {
      const confirm = spyOn(atomic, 'confirmFileDurable').mockImplementation(() => { throw new Error('synthetic fsync'); });
      restores.push(() => confirm.mockRestore());
    }
    const action = commit(f, authority); expect(() => action.run()).toThrow(); expect(action.effects()).toBe(0);
    expect(f.helper.requireAdmin(f.request)).toBeNull();
  });

  test('observed failed pairing persistence remains a strict hold even after ordinary telemetry succeeds', () => {
    const f = fixture('paired'); const authority = capture(f);
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic persistence failure'); });
    try { expect(() => f.pairing.revoke(f.paired!.id)).toThrow('synthetic persistence failure'); } finally { write.mockRestore(); }
    expect(f.pairing.authenticate(f.token)).not.toBeNull();
    const action = commit(f, authority); expect(() => action.run()).toThrow(); expect(action.effects()).toBe(0);
    expect(f.helper.captureSettingsAdminAuthority(f.request)).toBeNull();
  });

  test('facade lifetime replacement, stop and token ABA retire captured authority', () => {
    for (const change of ['rebind', 'stop', 'replace', 'aba'] as const) {
      const f = fixture(); const authority = capture(f);
      const action = commit(f, authority, () => {
        if (change === 'rebind') f.rebind(); else if (change === 'stop') f.stop();
        else { f.rotateShared(); if (change === 'aba') f.restoreShared(); }
      });
      expect(() => action.run()).toThrow(); expect(action.effects()).toBe(0);
    }
  });

  test('missing facade lifetime, native-only pairing substitute, and non-admin sessions are refused', () => {
    const f = fixture(); const noLifetime = new DaemonControlPlaneHelper({ ...f.context, settingsLifetime: undefined } as unknown as DaemonControlPlaneContext);
    expect(noLifetime.captureSettingsAdminAuthority(f.request)).toBeNull();
    const nativeOnly = new DaemonControlPlaneHelper({ ...f.context, pairingTokens: {
      authenticate: () => null, isLegacyRevoked: () => false,
      authenticateNative: () => ({ kind: 'pairing-token', tokenId: 'fake', authorityRevision: 'fake' }),
    } } as unknown as DaemonControlPlaneContext);
    expect(nativeOnly.captureSettingsAdminAuthority(f.request)).toBeNull();
    const viewer = fixture('session', { admin: false }); expect(viewer.helper.captureSettingsAdminAuthority(viewer.request)).toBeNull();
  });

  test('different request credential cannot borrow a captured session for the same user', () => {
    const f = fixture('session'); const authority = capture(f); const replacement = f.users.createSession('operator');
    expect(() => f.helper.withSettingsAdminAuthority(f.requestFor(replacement.token), authority, () => 'wrong credential')).toThrow();
  });

  test('escaped final check and an async callback cannot continue after the synchronous owner boundary', async () => {
    const f = fixture('paired'); let entered = false;
    expect(() => f.helper.withSettingsAdminAuthority(f.request, capture(f), async () => { entered = true; })).toThrow(/synchronous/i);
    expect(entered).toBe(false);
    let escaped!: () => void; let effects = 0;
    expect(() => f.helper.withSettingsAdminAuthority(f.request, capture(f), assertCurrent => {
      escaped = assertCurrent;
      return Promise.resolve().then(() => { assertCurrent(); effects++; });
    })).toThrow(/synchronous/i);
    await Promise.resolve(); expect(() => escaped()).toThrow(); expect(effects).toBe(0);
    expect(existsSync(`${f.file}.owner-lock`)).toBe(false);
  });

  test('successful effect result is not retroactively denied by later auth change in presentation', () => {
    const f = fixture('session'); const authority = capture(f);
    expect(f.helper.withSettingsAdminAuthority(f.request, authority, assertCurrent => {
      assertCurrent(); const receipt = { committed: true }; f.revoke(); return receipt;
    })).toEqual({ committed: true });
  });
  test('same-user object replacement and mutated session expiry cannot substitute for captured objects', () => {
    for (const change of ['user', 'expiry'] as const) {
      const f = fixture('session'); const authority = capture(f);
      if (change === 'user') {
        const users = (f.users as unknown as { users: Map<string, object> }).users;
        users.set('operator', { ...users.get('operator')! });
      } else f.session.expiresAt += 60_000;
      const action = commit(f, authority); expect(() => action.run()).toThrow(); expect(action.effects()).toBe(0);
    }
  });

  test('direct owner handles reject copying and a different actual auth owner', () => {
    const f = fixture('paired'); const paired = f.pairing.captureSettingsAuthority({ kind: 'pairing-token', token: f.token })!;
    const otherPairing = new PairingTokenManager(f.file);
    expect(() => otherPairing.withSettingsAuthority(paired, () => 'substituted')).toThrow();
    expect(() => f.pairing.withSettingsAuthority({ ...paired }, () => 'copied')).toThrow();
    const session = f.users.captureSettingsAuthority(f.session.token)!;
    expect(() => f.users.assertSettingsAuthorityCurrent({ ...session })).toThrow();
    expect(() => fixture('session').users.assertSettingsAuthorityCurrent(session)).toThrow();
    const wire = JSON.stringify([paired, session]);
    expect(wire).not.toContain(f.token); expect(wire).not.toContain(f.session.token);
    expect(wire).not.toContain(JSON.parse(readFileSync(f.file, 'utf8')).tokens[0].tokenHash);
  });

  test('same-owner user-store startup recovery and observed durability errors remain strict holds', () => {
    for (const failure of ['malformed', 'durability'] as const) {
      const dir = root(); const file = join(dir, 'users.json');
      writeFileSync(file, failure === 'malformed' ? '{broken' : JSON.stringify({ version: 1,
        users: [{ username: 'operator', passwordHash: 'synthetic-hash', roles: ['admin'] }] }));
      if (failure === 'durability') {
        const confirm = spyOn(atomic, 'confirmFileDurable').mockImplementation(() => { throw new Error('synthetic fsync'); });
        restores.push(() => confirm.mockRestore());
      }
      const users = new UserAuthManager({ bootstrapFilePath: file, bootstrapCredentialPath: join(dir, 'bootstrap.txt') });
      const username = failure === 'malformed' ? 'admin' : 'operator'; const session = users.createSession(username);
      expect(users.validateSession(session.token)).not.toBeNull();
      expect(users.captureSettingsAuthority(session.token)).toBeNull();
      for (const restore of restores.splice(0)) restore();
    }
  });

  test('failed same-owner user persistence holds an otherwise-current admin session', () => {
    const dir = root(); const file = join(dir, 'users.json');
    writeFileSync(file, JSON.stringify({ version: 1, users: [
      { username: 'operator', passwordHash: 'synthetic-hash', roles: ['admin'] },
      { username: 'spare', passwordHash: 'synthetic-hash', roles: ['admin'] },
    ] }));
    const users = new UserAuthManager({ bootstrapFilePath: file, bootstrapCredentialPath: join(dir, 'bootstrap.txt') });
    const session = users.createSession('operator'); const authority = users.captureSettingsAuthority(session.token)!;
    expect(authority).not.toBeNull(); mkdirSync(`${file}.tmp`);
    expect(() => users.deleteUser('spare')).toThrow();
    expect(users.validateSession(session.token)).not.toBeNull();
    expect(() => users.assertSettingsAuthorityCurrent(authority)).toThrow();
    expect(users.captureSettingsAuthority(session.token)).toBeNull();
  });

  test('actual user-store load recovery after a clean preflight remains a strict hold', async () => {
    const dir = root(); const file = join(dir, 'users.json');
    writeFileSync(file, JSON.stringify({ version: 1,
      users: [{ username: 'operator', passwordHash: 'synthetic-hash', roles: ['admin'] }] }));
    const original = atomic.confirmFileDurable;
    let changed = false;
    const confirm = spyOn(atomic, 'confirmFileDurable').mockImplementation(path => {
      original(path);
      if (path === file && !changed) { changed = true; writeFileSync(file, '{synthetic load failure'); }
    });
    restores.push(() => confirm.mockRestore());
    const users = new UserAuthManager({ bootstrapFilePath: file, bootstrapCredentialPath: join(dir, 'bootstrap.txt') });
    const session = users.createSession('admin');
    expect(changed).toBe(true);
    expect(users.validateSession(session.token)).not.toBeNull();
    expect(users.captureSettingsAuthority(session.token)).toBeNull();
    const manager = new ConfigManager({ configDir: join(dir, 'config') });
    const lifetime = {};
    const helper = new DaemonControlPlaneHelper({ userAuth: users, authToken: () => null,
      settingsLifetime: () => lifetime } as unknown as DaemonControlPlaneContext);
    const protocol = createServingSettingsPrecondition(manager, { settingsLifetime: () => lifetime,
      captureSettingsAdminAuthority: req => helper.captureSettingsAdminAuthority(req),
      withSettingsAdminAuthority: (req, authority, callback) => helper.withSettingsAdminAuthority(req, authority, callback) });
    const handlers = createDaemonSystemRouteHandlers({ configManager: manager, requireAdmin: (req: Request) => helper.requireAdmin(req),
      parseJsonBody: (req: Request) => req.json(), isValidConfigKey: () => true, settingsPrecondition: protocol } as never);
    const request = (body: unknown) => new Request('http://synthetic.invalid/config', { method: 'POST',
      headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify(body) });
    const before = manager.get('display.theme');
    const held = await handlers.postConfig(request({ settingsPrecondition: { version: 1, action: 'capture',
      operation: 'set', key: 'display.theme', value: 'nord' } }));
    expect(held.status).toBe(409); expect(manager.get('display.theme')).toBe(before);
    expect(await held.json()).not.toHaveProperty('settingsPrecondition');
    // Ordinary legacy bootstrap/auth behavior was not tightened by this seam.
    const legacy = await handlers.postConfig(request({ key: 'display.theme', value: 'nord' }));
    expect(legacy.status).toBe(200); expect(manager.get('display.theme')).toBe('nord');
  });

  test('strict observations never weaken the one-way shared revocation after file replacement', () => {
    const f = fixture(); f.pairing.revokeLegacyShared();
    expect(f.helper.captureSettingsAdminAuthority(f.request)).toBeNull();
    writeFileSync(f.file, JSON.stringify({ tokens: [], legacyRevoked: false }));
    // The ordinary reader's compatibility behavior may publish this replacement.
    f.pairing.isLegacyRevoked();
    expect(f.helper.captureSettingsAdminAuthority(f.request)).toBeNull();
  });

  test('post-effect owner-lock cleanup failure preserves the receipt and blocks subsequent strict auth', () => {
    const f = fixture('paired');
    expect(f.helper.withSettingsAdminAuthority(f.request, capture(f), assertCurrent => {
      assertCurrent(); const receipt = { committed: true }; rmSync(`${f.file}.owner-lock`, { recursive: true }); return receipt;
    })).toEqual({ committed: true });
    expect(f.helper.captureSettingsAdminAuthority(f.request)).toBeNull();
  });

  test('no-op ordinary mutations on a genuinely fresh absent store do not invent persisted history', () => {
    const f = fixture(); expect(f.pairing.rename('missing', 'unused')).toBe(false);
    expect(f.pairing.revoke('missing')).toBe(false); expect(existsSync(f.file)).toBe(false);
    expect(commit(f, capture(f)).run()).toBe('committed');
  });

});
