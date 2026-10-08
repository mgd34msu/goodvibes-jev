import type { Socket } from 'node:net';
import { EmailService } from '@goodvibes-jev/engine/sdk/platform/email';
import type { EmailInboxAccount, ImapUidCheckpoint } from '@goodvibes-jev/engine/sdk/platform/intake';
import { SnapshotSocket } from '../helpers/email-snapshot-socket.js';
import { createEmailDaemonInboxFactory } from '../../runtime/email-inbox-composition.js';
import { composeMailDeps } from '../../runtime/mail-composition.js';
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'undici/index.js';
import { ConfigManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { ClusterCoordinator, FakeClusterClock, MemoryClusterBus } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { createSlackInboxOwner, registerInboxSurface, type SlackInboxAccount, type InboxPollingControl, type InboxListOutput } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import { createSlackDaemonInboxFactory } from '../../runtime/slack-inbox-composition.js';
import { inboxPollerGate } from '../../runtime/cluster-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const cleanups: Array<() => void | Promise<void>> = [];
const releases: Array<() => void> = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); for (const close of cleanups.splice(0).reverse()) await close(); });
const account = { workspaceId: 'T-SYNTHETIC-ALPHA', userId: 'U-SYNTHETIC-OWNER' };
const text = 'Contact person@example.test, keep the build notes.';
const logger = { debug() {}, info() {}, warn() {}, error() {} };
function hold() { const result = Promise.withResolvers<void>(); releases.push(result.resolve); return result; }
async function until(predicate: () => boolean) { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Cluster inbox fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function advance(clock: FakeClusterClock, ms: number) { for (let elapsed = 0; elapsed < ms; elapsed += 100) { clock.advance(Math.min(100, ms - elapsed)); for (let turn = 0; turn < 15; turn++) await Promise.resolve(); } }
function endpoints() {
  let actualAccount = { ...account };
  let token: string | null = 'xoxb-synthetic-alpha';
  let available = true;
  let semanticHeld = false;
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
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: semanticHeld ? 0 : 1 }, precise: { type: 'noul', noul: semanticHeld ? 0 : 1 } }, usage: { input_tokens: 10, output_tokens: 2 } });
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
    revokeSource() { authority.abort(); },
    holdSemantic() { semanticHeld = true; },
    holdCredential(value: Promise<void>) { credentialGate = value; },
    holdSource(value: Promise<void>) { sourceGate = value; },
  };
}

async function node(bus: MemoryClusterBus, clock: FakeClusterClock, name: string, remote = endpoints(), root = makeOwnedTempDir('cluster-account-inbox'), events: string[] = []) {
  const workingDirectory = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: workingDirectory, homeDir: homeDirectory });
  configManager.set('cluster.enabled', true); configManager.set('surfaces.slack.enabled', true); configManager.set('surfaces.slack.workspaceId', account.workspaceId);
  const context: HandlerContext = { configManager, workingDirectory, homeDirectory, catalog: new GatewayMethodCatalog(), logger,
    credentials: { ...createDaemonCredentialStore({ async get() { return null; }, async set() {} }), resolveConfigSecret: remote.resolveConfigSecret } };
  const coordinator = new ClusterCoordinator({ settings: { enabled: true, heartbeatSeconds: 1, masterTimeoutSeconds: 3, bootProbeSeconds: 1,
    port: 0, multicastGroup: 'memory', secret: '', peers: [] }, version: '1.0.0', stateDirectory: root, logger,
    transport: bus.createTransport(name), clock, nodeId: name, random: () => 0 });
  cleanups.push(() => coordinator.stop()); await coordinator.start();
  const listeners = new Set<() => void>(); let enrollments = 0; let fileName = ''; let control: InboxPollingControl | undefined;
  const factory = createSlackDaemonInboxFactory({ account, screening: remote.screening }, {
    eligibilityClock: clock,
    async createOwner(ctx, options) {
      const owner = await createSlackInboxOwner(ctx, options, { createHttpClient: remote.createClient });
      const poll = owner.adapter.poll.bind(owner.adapter);
      owner.adapter.poll = async options => {
        events.push(`${name}:poll-start`);
        try { return await poll(options); } finally { events.push(`${name}:poll-drained`); }
      };
      return owner;
    },
    registerSurface(ctx, options) { fileName = options.storeFileName!; return registerInboxSurface(ctx, options); },
  });
  const registration = await factory(context, { async initialize() {}, async close() {}, unregister() {}, resolveProfileId: () => null }, {
    onAccountInvalidation(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    gatePolling() { throw new Error('Unexpected unverified gate'); },
    gatePollingOwned(id, next) { enrollments++; control = next; return coordinator.registerOwned(inboxPollerGate(id, {
      async start() { events.push(`${name}:consumer-start`); await next.start(); },
      async stop() { await next.stop(); events.push(`${name}:consumer-drained`); },
    })); },
  });
  void registration.ready!.catch(() => {});
  cleanups.push(() => registration.close());
  return { root, remote, coordinator, registration, clock, context,
    get enrollments() { return enrollments; }, get control() { return control!; },
    invalidate() { for (const listener of listeners) listener(); },
    async inbox() { return context.catalog.invoke('channels.inbox.list', { body: {}, context: {} }) as Promise<InboxListOutput>; },
    stored() { const path = join(workingDirectory, '.goodvibes', 'tui', 'operator', fileName); if (!existsSync(path)) return { rows: 0, cursor: 0 };
      const db = new Database(path, { readonly: true }); try { return { rows: (db.query('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n,
        cursor: (db.query('SELECT nextSince FROM cursors WHERE provider = ?').get('slack') as { nextSince: number } | null)?.nextSince ?? 0 }; } finally { db.close(); } },
  };
}

test('incapable preferred Slack node never enrolls; credential recovery enrolls without leaking account identity', async () => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus();
  const remoteA = endpoints(); remoteA.setToken(null);
  const a = await node(bus, clock, 'node-a', remoteA); await a.registration.ready;
  const b = await node(bus, clock, 'node-b'); await b.registration.ready;
  expect(a.enrollments).toBe(0); expect(b.enrollments).toBe(1);
  await advance(clock, 2000); await until(() => b.stored().rows === 1);
  expect(a.stored()).toEqual({ rows: 0, cursor: 0 });
  remoteA.setToken('xoxb-synthetic-recovered'); await advance(clock, 31000); await until(() => a.enrollments === 1);
  // Recovery joins as an eligible standby; it need not preempt a live holder.
  await b.registration.close(); await b.coordinator.stop();
  await advance(clock, 5000); await until(() => a.stored().rows === 1);
  const wire = bus.sent.map(packet => packet.raw).join('\n');
  expect(wire).not.toContain(account.workspaceId); expect(wire).not.toContain(account.userId); expect(wire).not.toContain('xoxb-');
});

test('same-account rotation withdraws and re-enrolls, while missing credentials remain withdrawn', async () => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus();
  const a = await node(bus, clock, 'node-a'); await a.registration.ready;
  await advance(clock, 2000); await until(() => a.stored().rows === 1);
  const before = a.stored(); a.remote.setToken('xoxb-synthetic-rotated'); a.invalidate();
  await until(() => a.coordinator.status().surfaces.length === 0);
  await advance(clock, 31000); await until(() => a.enrollments === 2);
  expect(a.stored()).toEqual(before);
  a.remote.setToken(null); a.invalidate(); await until(() => a.coordinator.status().surfaces.length === 0);
  await advance(clock, 31000); expect(a.enrollments).toBe(2); expect(a.stored()).toEqual(before);
});

test('a shutdown drains a stale metadata probe without late enrollment', async () => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus(), remote = endpoints();
  const gate = hold(); remote.holdCredential(gate.promise);
  const a = await node(bus, clock, 'node-a', remote); await until(() => remote.credentialReads > 0);
  const closing = a.registration.close(); gate.resolve(); await closing;
  await advance(clock, 60000); expect(a.enrollments).toBe(0); expect(a.coordinator.status().surfaces).toHaveLength(0);
});

test('held content screening and transport uncertainty retain verified election membership', async () => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus(), remote = endpoints();
  const gate = hold(); remote.holdSource(gate.promise);
  const a = await node(bus, clock, 'node-a', remote); await a.registration.ready;
  await advance(clock, 2000); await until(() => remote.sourceCalls.length > 0);
  remote.outage(); await advance(clock, 31000); await new Promise(resolve => setTimeout(resolve, 20));
  expect(a.enrollments).toBe(1); expect(a.coordinator.status().surfaces).toHaveLength(1);
  expect(a.stored()).toEqual({ rows: 0, cursor: 0 }); gate.resolve();
});

test('account cursor is node-local: a cold successor starts cold, returning owner keeps its durable cursor', async () => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus();
  const a = await node(bus, clock, 'node-a'); await a.registration.ready;
  await advance(clock, 2000); await until(() => a.stored().rows === 1);
  const prior = a.stored();
  const b = await node(bus, clock, 'node-b'); await b.registration.ready;
  expect(b.stored()).toEqual({ rows: 0, cursor: 0 });
  expect(b.remote.slackCalls.filter(call => call.path.endsWith('history'))).toHaveLength(0);
  await a.registration.close(); await a.coordinator.stop();
  await advance(clock, 5000); await until(() => b.stored().rows === 1);
  expect(b.remote.slackCalls.find(call => call.path.endsWith('history'))?.oldest).toBeNull();
  const returned = await node(bus, clock, 'node-a', endpoints(), a.root); await returned.registration.ready;
  expect(returned.stored()).toEqual(prior);
});

// Canonical mail service and observation generations, synthetic socket only.
test('cold email metadata eligibility precedes UID checkpoint seed and generation change re-enrolls safely', async () => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus(), remote = endpoints();
  const root = makeOwnedTempDir('cluster-email-inbox'), homeDirectory = join(root, 'home'), workingDirectory = join(root, 'workspace');
  mkdirSync(workingDirectory, { recursive: true });
  const mailAccount: EmailInboxAccount = { host: 'mail.synthetic.invalid', port: 993, username: 'owner@synthetic.invalid', mailbox: 'INBOX', security: 'tls' };
  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: workingDirectory, homeDir: homeDirectory });
  configManager.set('cluster.enabled', true); configManager.set('surfaces.email.host', mailAccount.host); configManager.set('surfaces.email.user', mailAccount.username);
  const context: HandlerContext = { configManager, workingDirectory, homeDirectory, catalog: new GatewayMethodCatalog(), logger,
    credentials: createDaemonCredentialStore({ async get() { return null; }, async set() {} }) };
  const coordinator = new ClusterCoordinator({ settings: { enabled: true, heartbeatSeconds: 1, masterTimeoutSeconds: 3, bootProbeSeconds: 1,
    port: 0, multicastGroup: 'memory', secret: '', peers: [] }, version: '1.0.0', stateDirectory: root, logger,
    transport: bus.createTransport('mail-node'), clock, nodeId: 'mail-node', random: () => 0 });
  cleanups.push(() => coordinator.stop()); await coordinator.start();
  let validity = 7, enrollments = 0, fileName = '';
  const sockets: SnapshotSocket[] = [];
  const factory = createEmailDaemonInboxFactory({ account: mailAccount, screening: remote.screening }, {
    eligibilityClock: clock, registerSurface(ctx, options) { fileName = options.storeFileName!; return registerInboxSurface(ctx, options); },
  });
  const registration = await factory(context, { async initialize() {}, async close() {}, unregister() {}, resolveProfileId: () => null }, {
    gatePolling() { throw new Error('Unexpected unverified gate'); },
    gatePollingOwned(id, control) { enrollments++; return coordinator.registerOwned(inboxPollerGate(id, control)); },
    createEmailService() {
      const disposers: Array<() => void> = [];
      const { emailServiceDeps } = composeMailDeps({ configManager,
        secretsManager: { async get() { return 'synthetic-mail-secret'; }, onDidChange() { return () => {}; } }, registerDispose(dispose) { disposers.push(dispose); } });
      const refuse = async (): Promise<never> => { throw new Error('Unexpected real mail transport'); };
      const service = new EmailService({ ...emailServiceDeps, transport: { connectImapTls: refuse, connectImapPlain: refuse, connectSmtpTls: refuse, connectSmtpStartTls: refuse },
        async imapSocketFactory() { const socket = new SnapshotSocket({ validity, uids: [42, 43] }); sockets.push(socket); setImmediate(() => socket.greet()); return socket as unknown as Socket; } });
      return { service, close() { for (const dispose of disposers.splice(0).reverse()) dispose(); } };
    },
  });
  void registration.ready!.catch(() => {}); cleanups.push(() => registration.close());
  const checkpoint = (): ImapUidCheckpoint | null => {
    const path = join(workingDirectory, '.goodvibes', 'tui', 'operator', fileName);
    if (!existsSync(path)) return null;
    const db = new Database(path, { readonly: true }); try {
      const row = db.query('SELECT checkpoint FROM imap_checkpoints WHERE provider = ?').get('email') as { checkpoint: string } | null;
      return row ? JSON.parse(row.checkpoint) as ImapUidCheckpoint : null;
    } finally { db.close(); }
  };
  await registration.ready;
  expect(enrollments).toBe(1); expect(checkpoint()).toBeNull();
  expect(sockets.flatMap(socket => socket.commands).some(command => command.includes('BODY'))).toBe(false);
  await advance(clock, 2000); await until(() => checkpoint()?.uidValidity === 7);
  expect(checkpoint()?.lastTerminalUid).toBeNull();
  validity = 8; await advance(clock, 31000); await until(() => enrollments === 2);
  await advance(clock, 2000); await until(() => checkpoint()?.uidValidity === 8);
  expect(checkpoint()?.lastTerminalUid).toBeNull();
  const wire = bus.sent.map(packet => packet.raw).join('\n');
  expect(wire).not.toContain(mailAccount.username); expect(wire).not.toContain(mailAccount.host); expect(wire).not.toContain('synthetic-mail-secret');
});


test.each(['account', 'source'] as const)('verified Slack %s revocation withdraws account eligibility', async reason => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus();
  const a = await node(bus, clock, 'node-a'); await a.registration.ready;
  await advance(clock, 2000); await until(() => a.stored().rows === 1);
  const before = a.stored();
  if (reason === 'source') a.remote.revokeSource();
  else { a.remote.setAccount({ workspaceId: 'T-FOREIGN', userId: 'U-FOREIGN' }); await advance(clock, 31000); }
  await until(() => a.coordinator.status().surfaces.length === 0);
  expect(a.enrollments).toBe(1); expect(a.stored()).toEqual(before);
});

test.each(['credential', 'source'] as const)('revoked %s drains held incumbent screening before successor can consume', async reason => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus(), events: string[] = [], remote = endpoints();
  const a = await node(bus, clock, 'node-a', remote, makeOwnedTempDir('cluster-held-incumbent'), events);
  await a.registration.ready; await advance(clock, 2000); await until(() => a.stored().rows === 1);
  const before = a.stored();
  const b = await node(bus, clock, 'node-b', endpoints(), makeOwnedTempDir('cluster-held-successor'), events);
  await b.registration.ready;
  await a.control.stop(); events.length = 0;
  const source = hold(); remote.holdSource(source.promise);
  remote.messages.push({ ...remote.messages[0]!, ts: `${Math.floor(Date.now() / 1000)}.000000` });
  const sourceBefore = remote.sourceCalls.length;
  const polling = a.control.start(); void polling.catch(() => {});
  await until(() => remote.sourceCalls.length > sourceBefore);
  expect(events).not.toContain('node-a:poll-drained'); expect(events).not.toContain('node-b:poll-start');
  const sourceCalls = remote.sourceCalls.length;
  await advance(clock, 31000); await new Promise(resolve => setTimeout(resolve, 20));
  expect(a.enrollments).toBe(1); expect(remote.sourceCalls).toHaveLength(sourceCalls);
  expect(events).not.toContain('node-b:poll-start');
  if (reason === 'source') remote.revokeSource(); else { remote.setToken(null); a.invalidate(); }
  // Cancellation drains the actual HTTP client even while the synthetic server
  // deliberately withholds its old response.
  await until(() => events.includes('node-a:poll-drained'));
  await until(() => a.coordinator.status().surfaces.length === 0);
  await advance(clock, 5000); await until(() => b.stored().rows === 1);
  const successor = events.indexOf('node-b:poll-start');
  expect(successor).toBeGreaterThan(events.indexOf('node-a:poll-drained'));
  expect(successor).toBeGreaterThan(events.indexOf('node-a:consumer-drained'));
  expect(a.stored()).toEqual(before);
  source.resolve(); await Promise.allSettled([polling]); await new Promise(resolve => setTimeout(resolve, 20));
  expect(a.stored()).toEqual(before);
});

test('semantic held outcome alone keeps membership without an eligibility-triggered content resample', async () => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus(), remote = endpoints(), events: string[] = [];
  remote.holdSemantic();
  const a = await node(bus, clock, 'node-a', remote, makeOwnedTempDir('cluster-semantic-held'), events);
  await a.registration.ready; await advance(clock, 2000); await until(() => events.includes('node-a:poll-drained'));
  const calls = remote.sourceCalls.length; expect(calls).toBeGreaterThan(0);
  expect(a.stored()).toEqual({ rows: 0, cursor: 0 });
  await advance(clock, 31000); await new Promise(resolve => setTimeout(resolve, 20));
  expect(a.enrollments).toBe(1); expect(a.coordinator.status().surfaces).toHaveLength(1);
  expect(remote.sourceCalls).toHaveLength(calls);
  expect(events.filter(event => event === 'node-a:poll-start')).toHaveLength(1);
});

test('returning standby mirror remains protected after same-account rotation and credential revocation', async () => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus();
  const a = await node(bus, clock, 'node-a'); await a.registration.ready;
  await advance(clock, 2000); await until(() => a.stored().rows === 1);
  await a.registration.close(); await a.coordinator.stop();
  const b = await node(bus, clock, 'node-b'); await b.registration.ready;
  await advance(clock, 2000); await until(() => b.stored().rows === 1);
  const returned = await node(bus, clock, 'node-a', endpoints(), a.root); await returned.registration.ready;
  expect((await returned.inbox()).items).toHaveLength(1);
  returned.remote.setToken('xoxb-synthetic-rotated'); returned.invalidate();
  const reads = returned.remote.credentialReads;
  expect((await returned.inbox()).items).toHaveLength(1);
  expect(returned.remote.credentialReads).toBeGreaterThan(reads);
  await advance(clock, 31000); await until(() => returned.enrollments === 2);
  expect((await returned.inbox()).items).toHaveLength(1);
  returned.remote.setToken(null); returned.invalidate();
  await expect(returned.inbox()).rejects.toThrow();
  expect(returned.stored().rows).toBe(1);
});

test('held initial screening cannot suppress holder heartbeats or admit a second consumer', async () => {
  const clock = new FakeClusterClock(), bus = new MemoryClusterBus(), events: string[] = [], remote = endpoints();
  const source = hold(); remote.holdSource(source.promise);
  const a = await node(bus, clock, 'node-a', remote, makeOwnedTempDir('cluster-held-initial'), events);
  await a.registration.ready; await advance(clock, 2000); await until(() => remote.sourceCalls.length > 0);
  const b = await node(bus, clock, 'node-b', endpoints(), makeOwnedTempDir('cluster-held-initial-standby'), events);
  await b.registration.ready;
  await advance(clock, 31000); await new Promise(resolve => setTimeout(resolve, 20));
  expect(events).not.toContain('node-a:poll-drained');
  expect(events).not.toContain('node-b:poll-start');
  expect(a.enrollments).toBe(1); expect(a.coordinator.status().surfaces).toHaveLength(1);
  remote.setToken(null); a.invalidate();
  await until(() => events.includes('node-a:poll-drained'));
  await until(() => a.coordinator.status().surfaces.length === 0);
  await advance(clock, 5000); await until(() => b.stored().rows === 1);
  expect(events.indexOf('node-b:poll-start')).toBeGreaterThan(events.indexOf('node-a:poll-drained'));
  expect(events.indexOf('node-b:poll-start')).toBeGreaterThan(events.indexOf('node-a:consumer-drained'));
  expect(a.stored()).toEqual({ rows: 0, cursor: 0 });
  source.resolve(); await new Promise(resolve => setTimeout(resolve, 20));
  expect(a.stored()).toEqual({ rows: 0, cursor: 0 });
});
