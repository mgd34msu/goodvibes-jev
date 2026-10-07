import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBotApi } from '../sdk/src/platform/channels/telegram/api.js';
import { TelegramIngressSupervisor } from '../sdk/src/platform/channels/telegram/ingress.js';
import { BuiltinChannelRuntime } from '../sdk/src/platform/channels/builtin-runtime.js';
import { SecretsManager } from '../sdk/src/platform/config/secrets.js';
import { ServiceRegistry } from '../sdk/src/platform/config/service-registry.js';
import {
  createTelegramSourceAccountOwner,
  type TelegramSourceAccountHandle,
  type TelegramSourceAccountOwner,
} from '../sdk/src/platform/channels/telegram/source-account.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const ok = (result: unknown): Response => Response.json({ ok: true, result });
const bot = (id = 123, username = 'verified_bot') => ({ id, username, is_bot: true, first_name: 'Synthetic bot' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
function attach(owner: TelegramSourceAccountOwner, id = '123', username = 'verified_bot') {
  const lifetime = new AbortController();
  const lease = owner.attach({ lifetime: lifetime.signal, isCurrent: async () => true, isCurrentSync: () => true, readIdentity: async () => ({ id, username }) });
  return { lifetime, lease };
}
async function snapshot(owner: TelegramSourceAccountOwner) {
  const handle = await owner.reader.acquire();
  expect(handle).not.toBeNull();
  return (await owner.reader.read(handle!))!;
}

describe('strict Telegram getMe provenance', () => {
  test('requires the provider identity and passes the exact lifetime signal', async () => {
    const abort = new AbortController();
    const calls: string[] = [];
    const api = new TelegramBotApi('123:synthetic-secret', async (url, init) => {
      calls.push(url.split('/').pop()!);
      expect(init.signal).toBe(abort.signal);
      return ok(bot());
    });
    expect(await api.getVerifiedIdentity(abort.signal)).toEqual({ id: '123', username: 'verified_bot', displayName: 'Synthetic bot' });
    expect(calls).toEqual(['getMe']);
  });

  test.each([
    { label: 'missing id', result: { username: 'verified_bot', is_bot: true } },
    { label: 'string id', result: { ...bot(), id: '123' } },
    { label: 'non-numeric id', result: { ...bot(), id: 'unknown' } },
    { label: 'zero id', result: bot(0) },
    { label: 'fractional id', result: bot(123.1) },
    { label: 'unsafe id', result: bot(Number.MAX_SAFE_INTEGER + 1) },
    { label: 'mismatched id', result: bot(456) },
    { label: 'empty username', result: bot(123, ' ') },
    { label: 'display name as username', result: bot(123, '@configured alias') },
    { label: 'missing bot proof', result: { id: 123, username: 'verified_bot' } },
    { label: 'human proof', result: { ...bot(), is_bot: false } },
  ])('rejects $label without token-prefix fallback', async ({ result }) => {
    const api = new TelegramBotApi('123:synthetic-secret', async () => ok(result));
    expect(await api.getVerifiedIdentity()).toBeNull();
  });

  test('unknown token prefix cannot establish a verified identity', async () => {
    const api = new TelegramBotApi('unknown:synthetic-secret', async () => ok(bot()));
    expect(await api.getVerifiedIdentity()).toBeNull();
  });
});

describe('opaque session-bound source accounts', () => {
  test('installation is lazy, success is cached only inside the current session, and handles do not serialize', async () => {
    const owner = createTelegramSourceAccountOwner(); let reads = 0;
    owner.attach({ lifetime: new AbortController().signal, isCurrent: async () => true, isCurrentSync: () => true,
      readIdentity: async () => { reads++; return { id: '123', username: 'verified_bot' }; } });
    expect(reads).toBe(0); expect(owner.reader.current()).toBeNull();
    const handle = (await owner.reader.acquire())!;
    const account = await owner.reader.read(handle);
    expect(account).toMatchObject({ id: '123', username: 'verified_bot' });
    expect(Object.keys(account!)).toEqual(['id', 'username', 'revision']);
    expect(JSON.stringify(handle)).toBe('{}');
    expect(await owner.reader.read(JSON.parse(JSON.stringify(handle)) as TelegramSourceAccountHandle)).toBeNull();
    expect(await createTelegramSourceAccountOwner().reader.read(handle)).toBeNull();
    expect(() => createTelegramSourceAccountOwner().reader.assertCurrent(handle)).toThrow('unavailable');
    expect(() => owner.reader.assertCurrent(handle)).not.toThrow();
    await owner.reader.acquire(); expect(reads).toBe(1);
  });

  test('same-bot transport replacement preserves revision while A→B→A gets distinct revisions', async () => {
    const owner = createTelegramSourceAccountOwner();
    const first = attach(owner); const handle = (await first.lease.acquire())!;
    const a = (await owner.reader.read(handle))!;
    owner.invalidate(); expect(owner.reader.current()).toBeNull(); expect(await owner.reader.read(handle)).toBeNull();
    expect(() => owner.reader.assertCurrent(handle)).toThrow('unavailable');
    attach(owner); const rotated = await snapshot(owner);
    expect(rotated.revision).toBe(a.revision);
    expect(await first.lease.acquire()).toBeNull();
    attach(owner, '456', 'verified_bot'); const b = await snapshot(owner);
    expect(b.revision).not.toBe(a.revision);
    attach(owner); const backToA = await snapshot(owner);
    expect(backToA.revision).not.toBe(a.revision); expect(backToA.revision).not.toBe(b.revision);
    // An independently retained public value is not erased by admission loss.
    expect(a.id).toBe('123');
  });

  test('a late getMe response cannot revive an invalidated session or replace its successor', async () => {
    const owner = createTelegramSourceAccountOwner(); const gate = deferred<{ id: string; username: string }>();
    const started = deferred<void>();
    const old = owner.attach({ lifetime: new AbortController().signal, isCurrent: async () => true, isCurrentSync: () => true,
      readIdentity: async () => { started.resolve(); return gate.promise; } });
    const pending = old.acquire(); await started.promise;
    attach(owner, '456', 'next_bot'); const replacement = await snapshot(owner);
    gate.resolve({ id: '123', username: 'old_bot' });
    expect(await pending).toBeNull(); expect(owner.reader.current()).toEqual(replacement);
    expect(await old.acquire()).toBeNull();
  });

  test('a post-await credential change prevents snapshot publication and permanently retires the lease', async () => {
    const owner = createTelegramSourceAccountOwner(); let current = true;
    const lease = owner.attach({ lifetime: new AbortController().signal, isCurrent: async () => current, isCurrentSync: () => current,
      readIdentity: async () => { current = false; return { id: '123', username: 'verified_bot' }; } });
    expect(await lease.acquire()).toBeNull(); expect(owner.reader.current()).toBeNull();
    current = true; expect(await lease.acquire()).toBeNull();
  });

  test('read fences in-flight currentness checks against replacement and revoked lifetime', async () => {
    const owner = createTelegramSourceAccountOwner(); const gate = deferred<boolean>();
    let delayed = false;
    const lifetime = new AbortController();
    owner.attach({ lifetime: lifetime.signal, isCurrent: async () => delayed ? gate.promise : true, isCurrentSync: () => true,
      readIdentity: async () => ({ id: '123', username: 'verified_bot' }) });
    const handle = (await owner.reader.acquire())!;
    delayed = true; const pending = owner.reader.read(handle);
    lifetime.abort(); attach(owner, '456', 'next_bot'); const replacement = await snapshot(owner);
    gate.resolve(true); expect(await pending).toBeNull(); expect(owner.reader.current()).toEqual(replacement);
  });

  test.each(['unknown', '', '1.1', '0', '-5', '00123'])('refuses invalid numeric identity %s at the owner boundary', async (id) => {
    const owner = createTelegramSourceAccountOwner(); attach(owner, id);
    expect(await owner.reader.acquire()).toBeNull(); expect(owner.reader.current()).toBeNull();
  });

  test('already-aborted lifetimes and currentness failures never acquire', async () => {
    const owner = createTelegramSourceAccountOwner(); const lifetime = new AbortController(); lifetime.abort(); let reads = 0;
    owner.attach({ lifetime: lifetime.signal, isCurrent: async () => true, isCurrentSync: () => true, readIdentity: async () => { reads++; return null; } });
    expect(await owner.reader.acquire()).toBeNull(); expect(reads).toBe(0);
    owner.attach({ lifetime: new AbortController().signal, isCurrent: async () => { throw new Error('unavailable'); }, isCurrentSync: () => true, readIdentity: async () => { reads++; return null; } });
    expect(await owner.reader.acquire()).toBeNull(); expect(reads).toBe(0);
  });
});

function pollingHarness(options: { readonly secrets?: SecretsManager; readonly registry?: ServiceRegistry; readonly config?: Record<string, unknown> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-source-account-'));
  const owner = createTelegramSourceAccountOwner();
  const config: Record<string, unknown> = { 'surfaces.telegram.enabled': true, 'surfaces.telegram.mode': 'polling',
    'surfaces.telegram.botToken': '123:synthetic-one', 'surfaces.telegram.botUsername': 'configured_stale_bot', ...options.config };
  let registryToken: string | null = null;
  const secretListeners = new Set<(key: string) => void>();
  let result: Record<string, unknown> = bot();
  let pendingIdentity: Promise<Record<string, unknown>> | null = null;
  const calls: string[] = [];
  const supervisor = new TelegramIngressSupervisor({
    configManager: { get: (key: string) => config[key], set: (key: string, value: unknown) => { config[key] = value; } } as never,
    secretsManager: options.secrets ?? { get: () => null, getGlobalHome: () => undefined,
      resolveLocalSecretSync: () => registryToken === null ? { state: 'absent' } : { state: 'resolved', value: registryToken },
      onDidChange: (listener: (key: string) => void) => { secretListeners.add(listener); return () => { secretListeners.delete(listener); }; },
    } as never,
    serviceRegistry: options.registry ?? { resolveSecret: async () => registryToken,
      get: () => registryToken === null ? null : { name: 'telegram', authType: 'bearer', tokenKey: 'SYNTHETIC_TELEGRAM_TOKEN' },
    } as never,
    offsetFilePath: join(directory, 'offset.json'), telegramSourceAccounts: owner,
    buildSurfaceAdapterContext: () => ({}) as never,
    createApi: (token) => new TelegramBotApi(token, async (url, init) => {
      const method = url.split('/').pop()!; calls.push(method);
      if (method === 'getMe') return ok(pendingIdentity ? await pendingIdentity : result);
      if (method === 'getUpdates') return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
      });
      return ok(true);
    }),
  });
  cleanups.push(async () => { await supervisor.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { owner, supervisor, config, calls, setIdentity: (value: Record<string, unknown>) => { result = value; },
    setPendingIdentity: (value: Promise<Record<string, unknown>> | null) => { pendingIdentity = value; },
    setRegistryToken: (value: string | null) => { registryToken = value; for (const listener of secretListeners) listener('SYNTHETIC_TELEGRAM_TOKEN'); } };
}

function localCredentials() {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-local-credentials-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const secrets = new SecretsManager({ projectRoot: join(directory, 'project'), globalHome: join(directory, 'home'),
    surfaceRoot: 'synthetic-fixture', policy: 'plaintext_allowed' });
  const registryPath = join(directory, 'services.json');
  const registry = new ServiceRegistry(registryPath, { secretsManager: secrets, subscriptionManager: {} as never });
  return { secrets, registry, registryPath };
}

describe('real polling supervisor provenance wiring', () => {
  test('unrelated local secret edits preserve proof; real same-bot rotation re-verifies after ordinary restart', async () => {
    const local = localCredentials(); await local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', '123:synthetic-one');
    const f = pollingHarness({ ...local, config: { 'surfaces.telegram.botToken': 'goodvibes://secrets/goodvibes/SYNTHETIC_TELEGRAM_TOKEN' } });
    await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    const original = await f.owner.reader.read(handle);
    await local.secrets.set('SYNTHETIC_UNRELATED_API_KEY', 'synthetic-unrelated');
    expect(f.owner.reader.assertCurrent(handle)).toEqual(original!);
    expect(await f.owner.reader.read(handle)).toEqual(original);
    expect(f.calls.filter(method => method === 'getMe')).toHaveLength(1);
    await local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', '123:synthetic-rotated');
    expect(() => f.owner.reader.assertCurrent(handle)).toThrow('unavailable');
    await f.supervisor.start(); const replacement = await snapshot(f.owner);
    expect(replacement.revision).toBe(original!.revision);
    expect(f.calls.filter(method => method === 'getMe')).toHaveLength(2);
  });

  test('a real local-secret write after read is fenced synchronously before capture', async () => {
    const local = localCredentials(); await local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', '123:synthetic-one');
    const f = pollingHarness({ ...local, config: { 'surfaces.telegram.botToken': 'goodvibes://secrets/goodvibes/SYNTHETIC_TELEGRAM_TOKEN' } });
    await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    expect(await f.owner.reader.read(handle)).toMatchObject({ id: '123' });
    const changing = local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', '456:synthetic-two');
    expect(() => f.owner.reader.assertCurrent(handle)).toThrow('unavailable');
    await changing; expect(f.owner.reader.current()).toBeNull();
  });

  test('an actual registry-file rewrite after read cannot reuse the verified old account', async () => {
    const local = localCredentials();
    await local.secrets.set('SYNTHETIC_TELEGRAM_A', '123:synthetic-one');
    await local.secrets.set('SYNTHETIC_TELEGRAM_B', '456:synthetic-two');
    const setRegistry = (tokenKey: string) => writeFileSync(local.registryPath, JSON.stringify({ telegram: { name: 'telegram', authType: 'bearer', tokenKey } }));
    setRegistry('SYNTHETIC_TELEGRAM_A'); const f = pollingHarness(local);
    await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    expect(await f.owner.reader.read(handle)).toMatchObject({ id: '123' });
    setRegistry('SYNTHETIC_TELEGRAM_B');
    expect(() => f.owner.reader.assertCurrent(handle)).toThrow('unavailable');
  });

  test('an out-of-band local secret-store edit after read is caught without a change notification', async () => {
    const local = localCredentials(); await local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', '123:synthetic-one');
    const record = (await local.secrets.listDetailed()).find(value => value.key === 'SYNTHETIC_TELEGRAM_TOKEN')!;
    expect(record.secure).toBe(false);
    const f = pollingHarness({ ...local, config: { 'surfaces.telegram.botToken': 'goodvibes://secrets/goodvibes/SYNTHETIC_TELEGRAM_TOKEN' } });
    await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    expect(await f.owner.reader.read(handle)).toMatchObject({ id: '123' });
    writeFileSync(record.path!, JSON.stringify({ SYNTHETIC_TELEGRAM_TOKEN: '456:synthetic-two' }));
    expect(() => f.owner.reader.assertCurrent(handle)).toThrow('unavailable');
  });

  test('environment rotation after read is fenced before returning an identity snapshot', async () => {
    const key = 'SYNTHETIC_TELEGRAM_SYNC_TOKEN'; const previous = process.env[key];
    process.env[key] = '123:synthetic-one';
    cleanups.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    const f = pollingHarness({ config: { 'surfaces.telegram.botToken': { source: 'env', id: key } } });
    await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    expect(await f.owner.reader.read(handle)).toMatchObject({ id: '123' });
    expect(f.owner.reader.assertCurrent(handle)).toMatchObject({ id: '123' });
    process.env[key] = '456:synthetic-two';
    expect(() => f.owner.reader.assertCurrent(handle)).toThrow('unavailable');
  });

  test('nested local secret references remain unsupported for selected intake', async () => {
    const local = localCredentials(); await local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', 'goodvibes://secrets/goodvibes/SYNTHETIC_TELEGRAM_INNER');
    await local.secrets.set('SYNTHETIC_TELEGRAM_INNER', '123:synthetic-one');
    const f = pollingHarness({ ...local, config: { 'surfaces.telegram.botToken': 'goodvibes://secrets/goodvibes/SYNTHETIC_TELEGRAM_TOKEN' } });
    await f.supervisor.start(); expect(await f.owner.reader.acquire()).toBeNull();
    expect(f.calls.filter(method => method === 'getMe')).toHaveLength(0);
  });

  test.each([
    { source: 'file', path: '/synthetic/not-read-by-this-test' },
    { source: 'exec', command: 'synthetic-never-executed', args: [] },
    { source: '1password', ref: 'op://synthetic/bot/token' },
    { source: 'vaultwarden', item: 'synthetic-item', field: 'password' },
    { source: 'bws', id: 'synthetic-id' },
  ])('external $source registry refs cannot qualify selected admission', async (tokenRef) => {
    // The legacy resolver is explicitly injected; this never reads the file,
    // launches a command, or contacts any external credential backend.
    const f = pollingHarness({ registry: {
      get: () => ({ name: 'telegram', authType: 'bearer', tokenKey: '', tokenRef }),
      resolveSecret: async () => '123:synthetic-one',
    } as never });
    await f.supervisor.start(); expect(await f.owner.reader.acquire()).toBeNull();
    expect(f.calls.filter(method => method === 'getMe')).toHaveLength(0);
  });

  test('local synchronous resolver preserves env precedence and refuses stored or env references', async () => {
    const local = localCredentials(); const key = 'SYNTHETIC_LOCAL_RESOLVER_KEY'; const previous = process.env[key];
    cleanups.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    delete process.env[key];
    await local.secrets.set(key, 'stored-synthetic');
    expect(local.secrets.resolveLocalSecretSync(key)).toEqual({ state: 'resolved', value: 'stored-synthetic' });
    process.env[key] = 'environment-synthetic';
    expect(local.secrets.resolveLocalSecretSync(key)).toEqual({ state: 'resolved', value: 'environment-synthetic' });
    process.env[key] = 'goodvibes://secrets/goodvibes/SYNTHETIC_OTHER';
    expect(local.secrets.resolveLocalSecretSync(key)).toEqual({ state: 'unsupported' });
    delete process.env[key];
    await local.secrets.set(key, 'op://synthetic/item/password');
    expect(local.secrets.resolveLocalSecretSync(key)).toEqual({ state: 'unsupported' });
    expect(local.secrets.resolveLocalSecretSync('SYNTHETIC_MISSING_KEY')).toEqual({ state: 'absent' });
  });

  test('configured stale username cannot substitute for actual getMe and installing the seam adds no call', async () => {
    const f = pollingHarness(); await f.supervisor.start();
    expect(f.calls.filter(x => x === 'getMe')).toHaveLength(0);
    const account = await snapshot(f.owner);
    expect(account).toMatchObject({ id: '123', username: 'verified_bot' });
    expect(f.config['surfaces.telegram.botUsername']).toBe('configured_stale_bot');
    expect(f.calls.filter(x => x === 'getMe')).toHaveLength(1);
    await snapshot(f.owner); expect(f.calls.filter(x => x === 'getMe')).toHaveLength(1);
    const publicData = JSON.stringify({ account, current: f.owner.reader.current() });
    expect(publicData).not.toContain('synthetic-one'); expect(publicData).not.toContain('123:');
  });

  test('a different-bot secret rotation with unchanged config username is held until new verified session', async () => {
    const f = pollingHarness(); await f.supervisor.start(); const a = await snapshot(f.owner);
    f.setRegistryToken('456:synthetic-two'); f.setIdentity(bot(456, 'new_bot'));
    expect(await f.owner.reader.acquire()).toBeNull();
    await f.supervisor.start(); const b = await snapshot(f.owner);
    expect(b).toMatchObject({ id: '456', username: 'new_bot' }); expect(b.revision).not.toBe(a.revision);
    expect(f.config['surfaces.telegram.botUsername']).toBe('configured_stale_bot');
  });

  test('same-bot token rotation reacquires proof with the original account revision', async () => {
    const f = pollingHarness(); await f.supervisor.start(); const a = await snapshot(f.owner);
    f.setRegistryToken('123:synthetic-rotated'); expect(await f.owner.reader.acquire()).toBeNull();
    await f.supervisor.start(); const rotated = await snapshot(f.owner);
    expect(rotated.revision).toBe(a.revision); expect(f.calls.filter(x => x === 'getMe')).toHaveLength(2);
  });

  test('a stale actual getMe response cannot relabel the replacement polling session', async () => {
    const f = pollingHarness(); await f.supervisor.start();
    const gate = deferred<Record<string, unknown>>(); f.setPendingIdentity(gate.promise);
    const old = f.owner.reader.acquire();
    for (let i = 0; i < 30 && !f.calls.includes('getMe'); i++) await Promise.resolve();
    expect(f.calls.filter(x => x === 'getMe')).toHaveLength(1);
    await f.supervisor.stop(); f.setPendingIdentity(null);
    f.config['surfaces.telegram.botToken'] = '456:synthetic-two'; f.setIdentity(bot(456, 'replacement_bot'));
    await f.supervisor.start(); const replacement = await snapshot(f.owner);
    gate.resolve(bot(123, 'stale_bot'));
    expect(await old).toBeNull(); expect(f.owner.reader.current()).toEqual(replacement);
    expect(replacement.id).toBe('456');
  });

  test('stop immediately revokes handles and webhook mode never attaches a qualifying session', async () => {
    const f = pollingHarness(); await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    const stopping = f.supervisor.stop(); expect(f.owner.reader.current()).toBeNull();
    expect(await f.owner.reader.read(handle)).toBeNull(); await stopping;
    f.config['surfaces.telegram.mode'] = 'webhook'; f.config['web.publicBaseUrl'] = 'https://synthetic.example';
    await f.supervisor.start(); expect(await f.owner.reader.acquire()).toBeNull();
    expect(f.calls.filter(x => x === 'getMe')).toHaveLength(1);
  });

  test.each(['disabled', 'mode', 'identity unavailable'] as const)('%s refuses new source admission', async (change) => {
    const f = pollingHarness(); await f.supervisor.start();
    if (change === 'disabled') f.config['surfaces.telegram.enabled'] = false;
    else if (change === 'mode') f.config['surfaces.telegram.mode'] = 'webhook';
    else f.setIdentity({ username: 'unverified', is_bot: true });
    expect(await f.owner.reader.acquire()).toBeNull();
  });

  test('builtin config watcher invalidates before its debounced restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'telegram-source-watch-'));
    const owner = createTelegramSourceAccountOwner(); const callbacks = new Map<string, () => void>();
    const runtime = new BuiltinChannelRuntime({ telegramSourceAccounts: owner, telegramOffsetPath: join(directory, 'offset.json'),
      configManager: { get: (key: string) => key === 'surfaces.telegram.botToken' ? '123:synthetic-one' : undefined,
        subscribe: (key: string, callback: () => void) => { callbacks.set(key, callback); return () => callbacks.delete(key); } },
      secretsManager: { get: () => null, getGlobalHome: () => undefined }, serviceRegistry: { resolveSecret: async () => null },
    } as never);
    cleanups.push(async () => { await runtime.stopIngress(); rmSync(directory, { recursive: true, force: true }); });
    await runtime.startIngress(); attach(owner); await snapshot(owner);
    callbacks.get('surfaces.telegram.botToken')!(); expect(owner.reader.current()).toBeNull();
    expect(await owner.reader.acquire()).toBeNull();
  });
});
