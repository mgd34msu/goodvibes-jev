import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'undici/index.js';
import { ConfigManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import {
  createSlackInboxOwner, digestSender, registerInboxSurface,
  type InboxListOutput, type InboxPollingControl, type SlackInboxAccount, type SlackInboxOwner,
} from '@goodvibes-jev/engine/sdk/platform/intake';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { UserAuthManager, type ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import type { DaemonInboxFactory } from '../../runtime/daemon-handler-composition.js';
import { createDaemonHost, type DaemonHost } from '../../runtime/daemon-host.js';
import { createFeatureFlagManager, deriveFeatureStates, RuntimeEventBus } from '../../runtime/index.js';
import { createRuntimeServices } from '../../runtime/services.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

// The normal daemon test command builds this entry first. Keep the fixture's
// SDK collaborators public while exercising the factory consumers actually load.
const { createSlackDaemonInboxFactory } = await import(new URL('../../../dist/cli/index.js', import.meta.url).href) as typeof import('../../cli/index.js');

let hosts: DaemonHost[];
let cleanups: Array<() => void | Promise<void>>;
let releases: Array<() => void>;
let restores: Array<() => void>;
const account = { workspaceId: 'T-SYNTHETIC-ALPHA', userId: 'U-SYNTHETIC-OWNER' };
const text = 'Contact person@example.test, keep the build notes.';
const redacted = 'Contact [redacted], keep the build notes.';
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 10));

function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function gate() {
  const result = Promise.withResolvers<void>();
  releases.push(result.resolve);
  return result;
}
function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Owned Slack fixture did not reach the expected state');
    await pause();
  }
}

beforeEach(() => {
  hosts = []; cleanups = []; releases = []; restores = [];
  keep(spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]));
  keep(spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue());
});
afterEach(async () => {
  for (const release of releases) release();
  for (const host of hosts) await host.close().catch(() => {});
  for (const cleanup of cleanups.reverse()) await cleanup();
  for (const restore of restores.reverse()) restore();
});

/** Both remote APIs are actual owned loopback sockets. Only their data is synthetic. */
function endpoints() {
  let actualAccount = { ...account };
  let token: string | null = 'xoxb-synthetic-alpha';
  let available = true;
  let credentialReads = 0;
  let credentialGate: Promise<void> | undefined;
  let sourceGate: Promise<void> | undefined;
  const messages = [{ ts: `${Math.floor((Date.now() - 20_000) / 1_000)}.000000`, user: 'U-SYNTHETIC-SENDER', text }];
  const slackCalls: Array<{ path: string; authorization: string | null; oldest: string | null }> = [];
  const sourceCalls: Array<{ path: string; parts?: string[] }> = [];
  const slack = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    slackCalls.push({ path: url.pathname, authorization: request.headers.get('authorization'), oldest: url.searchParams.get('oldest') });
    if (!available) return new Response('{}', { status: 503 });
    if (url.pathname === '/api/auth.test') return Response.json({ ok: true, team_id: actualAccount.workspaceId, user_id: actualAccount.userId });
    if (url.pathname === '/api/conversations.list') return Response.json({ ok: true, channels: [{ id: 'D-SYNTHETIC', user: 'U-SYNTHETIC-SENDER' }] });
    expect(url.pathname).toBe('/api/conversations.history');
    return Response.json({ ok: true, messages });
  } });
  const local = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json() as { messages?: Array<{ content: string }> };
    if (path === '/v1/chat/completions') {
      const source = JSON.parse(body.messages![1]!.content) as { revision: string; parts: string[] };
      sourceCalls.push({ path, parts: source.parts });
      await sourceGate;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
        revision: source.revision, spans: [{ part: 1, start: 8, end: 27 }, { part: 3, start: 8, end: 27 }],
      }) } }] });
    }
    sourceCalls.push({ path });
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } }, usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  cleanups.push(async () => { await local.stop(true); await slack.stop(true); });
  const authority = new AbortController();
  const screening: ProtectedSourceOwnerOptions = {
    authority: { ownerId: 'synthetic-loopback-services', revision: '1', retention: 'ephemeral-no-log', signal: authority.signal, assertCurrent() {} },
    proposal: { endpoint: `http://127.0.0.1:${local.port}`, model: 'synthetic-proposer' },
    judgment: { endpoint: `http://127.0.0.1:${local.port}`, model: 'jev-1.13.0' }, timeoutMs: 5_000,
  };
  return { screening, slackCalls, sourceCalls, messages,
    get credentialReads() { return credentialReads; },
    async resolveConfigSecret(key: string) {
      expect(key).toBe('surfaces.slack.botToken'); credentialReads++; await credentialGate; return token;
    },
    createClient(origin: string, options: Client.Options) {
      expect(origin).toBe('https://slack.com');
      expect(options).toMatchObject({ connect: { rejectUnauthorized: true }, pipelining: 0, allowH2: false });
      return new Client(`http://127.0.0.1:${slack.port}`, options);
    },
    setToken(value: string | null) { token = value; },
    setAccount(value: SlackInboxAccount) { actualAccount = { ...value }; },
    outage() { available = false; },
    holdCredential(value: Promise<void>) { credentialGate = value; },
    holdSource(value: Promise<void>) { sourceGate = value; },
  };
}

function fixture(remote = endpoints(), settings: { root?: string; account?: SlackInboxAccount; holdGate?: boolean } = {}) {
  const root = settings.root ?? makeOwnedTempDir('slack-daemon-composition');
  const homeDirectory = join(root, 'home');
  const workingDir = join(root, 'workspace');
  const configDir = join(homeDirectory, '.goodvibes', 'daemon');
  mkdirSync(configDir, { recursive: true }); mkdirSync(workingDir, { recursive: true });
  const expected = settings.account ?? account;
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir, homeDir: homeDirectory });
  configManager.set('cluster.enabled', false); configManager.set('relay.enabled', false);
  configManager.set('surfaces.slack.enabled', true); configManager.set('surfaces.slack.workspaceId', expected.workspaceId);
  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
  let port = 0;
  let storeFileName = '';
  let control: InboxPollingControl | undefined;
  let gateId = '';
  let handlerContext: HandlerContext | undefined;
  let routing: Parameters<DaemonInboxFactory>[1] | undefined;
  const owners: SlackInboxOwner[] = [];
  const retirements: Array<{ kind: 'provider' | 'store'; leaseHeld: boolean }> = [];
  let graphWasCold = false;
  const composition = createSlackDaemonInboxFactory({ account: expected, screening: remote.screening, timeoutMs: 5_000 }, {
    async createOwner(context, options) {
      const owned = await createSlackInboxOwner(context, options, { createHttpClient: remote.createClient });
      const close = owned.close;
      keep(spyOn(owned, 'close').mockImplementation(async () => {
        await close();
        retirements.push({ kind: 'provider', leaseHeld: existsSync(join(workingDir, '.goodvibes', 'tui', 'operator', `${storeFileName}.owner.lock`)) });
      }));
      owners.push(owned); return owned;
    },
    registerSurface(context, options) {
      storeFileName = options.storeFileName!;
      const registration = registerInboxSurface(context, options);
      const close = registration.close;
      keep(spyOn(registration, 'close').mockImplementation(async () => {
        await close();
        retirements.push({ kind: 'store', leaseHeld: existsSync(join(workingDir, '.goodvibes', 'tui', 'operator', `${storeFileName}.owner.lock`)) });
      }));
      return registration;
    },
  });
  const serveFactory = ((options) => { const server = Bun.serve(options); port = server.port!; return server; }) as typeof Bun.serve;
  const host = createDaemonHost({
    runtime: {
      configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), featureFlags,
      homeDirectory, workingDir, daemonHomeDirectory: configDir,
      inboxFactory(context, route, controls) {
        // Only the handler's read-only config-secret port receives the synthetic token.
        // The real runtime credential services retain their ordinary empty fixture home.
        handlerContext = { ...context, credentials: { ...context.credentials, resolveConfigSecret: remote.resolveConfigSecret } };
        routing = route;
        return composition(handlerContext, route, { gatePolling(id, next) {
          control = next; gateId = id;
          return controls.gatePolling(id, {
            start: () => settings.holdGate ? Promise.resolve() : next.start(),
            stop: () => next.stop(),
          });
        } });
      },
      localUserAuthManager: new UserAuthManager({ bootstrapFilePath: join(homeDirectory, 'users.json'), bootstrapCredentialPath: join(homeDirectory, 'bootstrap.txt'),
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('fixture'), roles: ['admin'] }] }),
    },
    daemon: { host: '127.0.0.1', port: 0, token: 'synthetic-slack-daemon-token', serveFactory },
  }, { providerDiscovery: { scan: async () => ({ servers: [], scannedHosts: 0, scannedPorts: 0, durationMs: 0 }) }, async createRuntime(options) {
    const before = remote.slackCalls.length;
    const runtime = await createRuntimeServices(options);
    graphWasCold = remote.slackCalls.length === before;
    keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockResolvedValue(''));
    return runtime;
  } });
  hosts.push(host);
  return { root, host, configManager, remote, owners, composition, retirements,
    get graphWasCold() { return graphWasCold; },
    get control() { return control!; }, get gateId() { return gateId; },
    get storePath() { return join(workingDir, '.goodvibes', 'tui', 'operator', storeFileName); },
    get handlerContext() { return handlerContext!; }, get routing() { return routing!; },
    async wire(authenticated = true) {
      const response = await fetch(`http://127.0.0.1:${port}/api/channels/inbox`, {
        headers: authenticated ? { Authorization: 'Bearer synthetic-slack-daemon-token' } : {},
      });
      return { status: response.status, text: await response.text() };
    },
    async inbox() { const result = await this.wire(); expect(result.status).toBe(200); return JSON.parse(result.text) as InboxListOutput; },
    async poll() { await control!.stop(); await control!.start(); },
  };
}

/** Read an already-persisted SQLite snapshot without acquiring a second writer. */
function stored(path: string) {
  // A never-written sql.js database has no snapshot. This is also evidence
  // that a cancelled first poll did not create a durable cursor or item.
  if (!existsSync(path)) return { items: [], cursor: 0 };
  const database = new Database(path, { readonly: true });
  try {
    return {
      items: database.query('SELECT id, bodyPreview, fromDigest FROM items ORDER BY receivedAt').all(),
      cursor: database.query<{ nextSince: number }, []>('SELECT nextSince FROM cursors WHERE provider = \'slack\'').get()?.nextSince ?? 0,
    };
  } finally { database.close(); }
}

test('cold composition waits for the real gate; authenticated HTTP serves protected Slack content from SQLite', async () => {
  const f = fixture(undefined, { holdGate: true });
  expect(f.remote.credentialReads).toBe(0); expect(f.remote.slackCalls).toEqual([]);
  expect((await f.host.start()).state).toBe('ready');
  expect(f.graphWasCold).toBe(true); expect(f.remote.credentialReads).toBe(0);
  expect(f.remote.slackCalls).toEqual([]); expect(f.remote.sourceCalls).toEqual([]);
  expect(f.gateId).toBe(`slack:${f.owners[0]!.scopeId}`);
  expect(f.storePath).toEndWith(`inbox-slack-${f.owners[0]!.scopeId}.sqlite`);
  expect((await f.wire(false)).status).toBe(401);
  expect(f.remote.credentialReads).toBe(0);
  expect(await f.inbox()).toMatchObject({ items: [], total: 0, providers: [{ provider: 'slack', state: 'pending', syncing: false }] });
  expect(f.remote.slackCalls.map(call => call.path)).toEqual(['/api/auth.test']);
  expect(f.remote.sourceCalls).toEqual([]);
  await f.control.start();
  const inbox = await f.inbox();
  expect(inbox).toMatchObject({ total: 1, partial: false, items: [{ provider: 'slack', bodyPreview: redacted, subject: 'Direct message', from: digestSender('U-SYNTHETIC-SENDER') }],
    providers: [{ provider: 'slack', state: 'ready', storedCount: 1, syncing: true, configured: true }] });
  expect(inbox.items[0]!.routeId).toBeUndefined();
  expect(f.remote.sourceCalls[0]!.parts).toEqual(['Direct message', text, 'Direct message', text]);
  expect(f.remote.sourceCalls).toHaveLength(2);
  expect(existsSync(f.storePath)).toBe(true);
  expect(stored(f.storePath)).toMatchObject({ items: [{ bodyPreview: redacted }], cursor: Number(f.remote.messages[0]!.ts) * 1_000 });
  const bytes = readFileSync(f.storePath).toString('utf8');
  expect(bytes).not.toContain('person@example.test'); expect(bytes).not.toContain('xoxb-synthetic-alpha');
  expect(JSON.stringify(inbox)).not.toContain('U-SYNTHETIC-SENDER');
});

test('same-account token rotation and restart preserve the cursor and deduplicate persisted history', async () => {
  const remote = endpoints(); const first = fixture(remote);
  await first.host.start(); const before = stored(first.storePath);
  remote.setToken('xoxb-synthetic-rotated');
  expect((await first.inbox()).total).toBe(1);
  expect(remote.slackCalls.at(-1)).toMatchObject({ path: '/api/auth.test', authorization: 'Bearer xoxb-synthetic-rotated' });
  await first.poll();
  expect(stored(first.storePath)).toEqual(before);
  expect(remote.slackCalls.at(-1)!.oldest).toBe((before.cursor / 1_000).toFixed(6));
  await first.host.close();
  const sourceCount = remote.sourceCalls.length;
  const second = fixture(remote, { root: first.root }); await second.host.start();
  expect(second.storePath).toBe(first.storePath);
  expect(remote.slackCalls.at(-1)!.oldest).toBe((before.cursor / 1_000).toFixed(6));
  expect(remote.sourceCalls).toHaveLength(sourceCount);
  expect((await second.inbox()).items).toHaveLength(1);
  expect(stored(second.storePath)).toEqual(before);
});

test.each([{ workspaceId: 'T-SYNTHETIC-OTHER', userId: account.userId }, { workspaceId: account.workspaceId, userId: 'U-SYNTHETIC-OTHER' }])(
  'changed credential account %j cannot expose old rows or advance the stored cursor', async foreign => {
    const f = fixture(); await f.host.start(); const before = stored(f.storePath);
    f.remote.setToken('xoxb-synthetic-foreign'); f.remote.setAccount(foreign);
    f.remote.messages.push({ ...f.remote.messages[0]!, ts: `${Math.floor((Date.now() - 2_000) / 1_000)}.000000` });
    const previousCalls = f.remote.slackCalls.length; const previousSourceCalls = f.remote.sourceCalls.length;
    const refused = await f.wire(); expect(refused.status).toBe(503); expect(refused.text).not.toContain(redacted);
    await f.poll();
    expect(f.remote.slackCalls.slice(previousCalls).map(call => call.path)).toEqual(['/api/auth.test', '/api/auth.test']);
    expect(f.remote.sourceCalls).toHaveLength(previousSourceCalls);
    expect(stored(f.storePath)).toEqual(before);
    expect((await f.wire()).status).toBe(503);
  },
);

test('provider outage leaves previously verified rows eligible and marks the authenticated result partial', async () => {
  const f = fixture(); await f.host.start(); const before = stored(f.storePath);
  f.remote.outage(); await f.poll(); const calls = f.remote.slackCalls.length;
  expect(await f.inbox()).toMatchObject({ total: 1, partial: true, items: [{ bodyPreview: redacted }], providers: [{ provider: 'slack', state: 'error', storedCount: 1 }] });
  expect(f.remote.slackCalls).toHaveLength(calls); expect(stored(f.storePath)).toEqual(before);
});

test('a credential swap during protected source mapping cannot commit an old poll or advance its cursor', async () => {
  const f = fixture(); await f.host.start(); const before = stored(f.storePath);
  const held = gate(); f.remote.holdSource(held.promise);
  f.remote.messages.push({ ...f.remote.messages[0]!, ts: `${Math.floor((Date.now() - 2_000) / 1_000)}.000000` });
  const sourceCalls = f.remote.sourceCalls.length;
  const polling = f.poll();
  await until(() => f.remote.sourceCalls.length > sourceCalls);
  f.remote.setToken('xoxb-synthetic-rotated'); held.resolve(); await polling;
  expect(stored(f.storePath)).toEqual(before);
  expect(await f.inbox()).toMatchObject({ total: 1, partial: true, providers: [{ state: 'error' }] });
  await f.poll();
  expect(await f.inbox()).toMatchObject({ total: 2, partial: false });
  expect(stored(f.storePath).cursor).toBe(Number(f.remote.messages[1]!.ts) * 1_000);
});

test('live workspace configuration invalidation fences mirror reads and polling before more credential or source work', async () => {
  const f = fixture(); await f.host.start(); const before = stored(f.storePath);
  const credentialReads = f.remote.credentialReads;
  const calls = f.remote.slackCalls.length; const sources = f.remote.sourceCalls.length;
  f.configManager.set('surfaces.slack.workspaceId', 'T-SYNTHETIC-OTHER');
  const refused = await f.wire(); expect(refused.status).toBe(503); expect(refused.text).not.toContain(redacted);
  await f.poll();
  expect(f.remote.credentialReads).toBe(credentialReads);
  expect(f.remote.slackCalls).toHaveLength(calls); expect(f.remote.sourceCalls).toHaveLength(sources);
  expect(stored(f.storePath)).toEqual(before);
});

test('a second owner cannot open the same store; a different explicit account has an isolated store', async () => {
  const remote = endpoints(); const first = fixture(remote); await first.host.start(); const before = stored(first.storePath);
  const calls = remote.slackCalls.length;
  await expect(first.composition(first.handlerContext, first.routing, { gatePolling() {} })).rejects.toThrow('owned storage');
  expect(first.owners).toHaveLength(2); expect(remote.slackCalls).toHaveLength(calls);
  await expect(first.owners[1]!.assertReadCurrent()).rejects.toThrow('unavailable');
  expect(stored(first.storePath)).toEqual(before); expect((await first.inbox()).total).toBe(1);
  await first.host.close();
  const foreign = { workspaceId: account.workspaceId, userId: 'U-SYNTHETIC-OTHER' };
  remote.setAccount(foreign); remote.setToken('xoxb-synthetic-foreign');
  const second = fixture(remote, { root: first.root, account: foreign, holdGate: true }); await second.host.start();
  expect(second.storePath).not.toBe(first.storePath); expect(second.gateId).not.toBe(first.gateId);
  expect(await second.inbox()).toMatchObject({ items: [], total: 0, providers: [{ state: 'pending' }] });
  expect(stored(second.storePath)).toEqual({ items: [], cursor: 0 });
  expect(stored(first.storePath)).toEqual(before);
});

test.each(['cluster', 'disabled', 'workspace'] as const)('unsupported %s configuration is rejected before provider, credentials, gate or inbox storage effects', async mode => {
  const root = makeOwnedTempDir('slack-refused-composition');
  const workingDirectory = join(root, 'workspace'); mkdirSync(workingDirectory);
  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: workingDirectory, homeDir: join(root, 'home') });
  configManager.set('cluster.enabled', mode === 'cluster'); configManager.set('surfaces.slack.enabled', mode !== 'disabled');
  configManager.set('surfaces.slack.workspaceId', mode === 'workspace' ? 'T-OTHER' : account.workspaceId);
  let effects = 0;
  const context: HandlerContext = { configManager, workingDirectory, homeDirectory: join(root, 'home'), catalog: new GatewayMethodCatalog(),
    credentials: createDaemonCredentialStore({ async get() { effects++; return null; }, async set() { effects++; } }), logger: { info() {}, warn() {}, error() {} } };
  const screening: ProtectedSourceOwnerOptions = { authority: { ownerId: 'synthetic', revision: '1', retention: 'ephemeral-no-log', signal: new AbortController().signal, assertCurrent() {} },
    proposal: { endpoint: 'http://127.0.0.1:1', model: 'synthetic' }, judgment: { endpoint: 'http://127.0.0.1:1', model: 'jev-1.13.0' } };
  const composition = createSlackDaemonInboxFactory({ account, screening }, {
    async createOwner() { effects++; throw new Error('Unexpected provider construction'); },
    registerSurface() { effects++; throw new Error('Unexpected inbox registration'); },
  });
  const routing = { async initialize() {}, async close() {}, unregister() {}, resolveProfileId: () => null };
  await expect(composition(context, routing, { gatePolling() { effects++; } })).rejects.toThrow(mode === 'cluster' ? 'owned gate retirement' : mode === 'disabled' ? 'enabled' : 'scope changed');
  expect(effects).toBe(0); expect(existsSync(join(workingDirectory, '.goodvibes', 'tui', 'operator'))).toBe(false);
});

test.each(['credential', 'source'] as const)('shutdown drains late %s work before releasing the account store and cannot persist its result', async mode => {
  const remote = endpoints(); const f = fixture(remote, { holdGate: true }); await f.host.start();
  const held = gate();
  if (mode === 'credential') remote.holdCredential(held.promise); else remote.holdSource(held.promise);
  const pending = f.control.start(); void pending.catch(() => {});
  await until(() => mode === 'credential' ? remote.credentialReads > 0 : remote.sourceCalls.length > 0);
  const closing = f.host.close(); const done = settled(closing); expect(f.host.close()).toBe(closing);
  if (mode === 'credential') {
    await pause(); expect(done()).toBe(false);
    expect(existsSync(`${f.storePath}.owner.lock`)).toBe(true);
    held.resolve();
  }
  // A delayed remote response is cancelled at the owned HTTP client. Shutdown
  // need not await a remote server's handler after its socket has been retired.
  await pending.catch(() => {}); await closing;
  expect(f.retirements.map(event => event.kind).sort()).toEqual(['provider', 'store']);
  expect(f.retirements.every(event => event.leaseHeld)).toBe(true);
  held.resolve(); await pause();
  expect(stored(f.storePath)).toEqual({ items: [], cursor: 0 });
  expect(existsSync(`${f.storePath}.owner.lock`)).toBe(false);
  if (mode === 'credential') expect(remote.slackCalls).toEqual([]);
  const calls = remote.slackCalls.length;
  await expect(f.control.start()).rejects.toThrow('stopped');
  expect(remote.slackCalls).toHaveLength(calls);
  const second = fixture(remote, { root: f.root, holdGate: true }); await second.host.start();
  expect(second.storePath).toBe(f.storePath);
});
