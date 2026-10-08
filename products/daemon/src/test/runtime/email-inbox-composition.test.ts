import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { ConfigManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { EmailService } from '@goodvibes-jev/engine/sdk/platform/email';
import { createEmailInboxOwner, digestSender, registerInboxSurface,
  type EmailInboxAccount, type EmailInboxOwner, type ImapUidCheckpoint,
  type InboxListOutput, type InboxPollingControl } from '@goodvibes-jev/engine/sdk/platform/intake';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { UserAuthManager, type ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import { SnapshotSocket } from '../helpers/email-snapshot-socket.js';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import type { DaemonInboxControls, DaemonInboxFactory } from '../../runtime/daemon-handler-composition.js';
import { createDaemonHost, type DaemonHost } from '../../runtime/daemon-host.js';
import { createEmailDaemonInboxFactory } from '../../runtime/email-inbox-composition.js';
import { createFeatureFlagManager, deriveFeatureStates, RuntimeEventBus } from '../../runtime/index.js';
import { composeMailDeps } from '../../runtime/mail-composition.js';
import { createRuntimeServices } from '../../runtime/services.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

// No real mail transport, stored credential, hosted model, or built dist entry is used.
// Only the mail socket is synthetic: the service, source owner, HTTP route, and SQLite are real.
const account: EmailInboxAccount = { host: 'mail.synthetic.invalid', port: 993,
  username: 'owner@synthetic.invalid', mailbox: 'INBOX', security: 'tls' };
const sensitive = 'person@example.test';
const body = `Contact ${sensitive}, keep the build notes.`;
const html = `<p>Alternate ${sensitive} section.</p>`;
const redacted = 'Contact [redacted], keep the build notes.';
const sender = 'sender@synthetic.invalid';
let hosts: DaemonHost[];
let cleanups: Array<() => void | Promise<void>>;
let releases: Array<() => void>;
let restores: Array<() => void>;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 10));
function keep<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
function gate() { const result = Promise.withResolvers<void>(); releases.push(result.resolve); return result; }
function settled(promise: Promise<unknown>) {
  let done = false; void promise.then(() => { done = true; }, () => { done = true; }); return () => done;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Synthetic email fixture did not reach expected state'); await pause(); }
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

class MailSocket extends SnapshotSocket {
  constructor(options: ConstructorParameters<typeof SnapshotSocket>[0], readonly malformed?: 'search' | 'body' | 'unsupported') { super(options); }
  override headers(uid: number): string {
    return `From: ${sender}\r\nSubject: Review ${sensitive}\r\nContent-Type: multipart/alternative; boundary=synthetic\r\nDate: ${uid % 2 ? 'Thu, 01 Jan 1970' : 'Fri, 01 Jan 2100'} 00:00:00 +0000\r\n\r\n`;
  }
  override async answer(command: string): Promise<void> {
    const tag = command.split(' ')[0]; const done = `${tag} OK complete\r\n`;
    const uid = Number(/UID FETCH (\d+)/.exec(command)?.[1]);
    if (this.malformed === 'search' && command.includes(' SEARCH ALL')) { this.feed(`* SEARCH 42 invalid\r\n${done}`); return; }
    if (command.includes('BODYSTRUCTURE')) {
      const structure = this.malformed === 'unsupported' ? '("APPLICATION" "OCTET-STREAM" NIL NIL NIL "BASE64" 4)'
        : `(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${Buffer.byteLength(body)} 1)("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${Buffer.byteLength(html)} 1) "ALTERNATIVE")`;
      this.feed(`* 1 FETCH (UID ${uid} BODYSTRUCTURE ${structure})\r\n${done}`); return;
    }
    if (/BODY.PEEK\[[12]\]/.test(command)) {
      const section = /BODY.PEEK\[([12])\]/.exec(command)![1]!;
      if (this.malformed !== 'body') this.section(uid, section, section === '1' ? body : html);
      this.feed(done); return;
    }
    await super.answer(command);
  }
}

function remote() {
  let validity = 7, uids = [42, 43], secretReads = 0, constructors = 0;
  let token = 'synthetic-mail-secret';
  let credentialGate: Promise<void> | undefined, sourceGate: Promise<void> | undefined;
  let transportGate: Promise<void> | undefined;
  let malformed: 'search' | 'body' | 'unsupported' | undefined;
  let holdGreeting = false;
  const changes = new Set<(key: string) => void>();
  const sockets: MailSocket[] = [], sourceParts: string[][] = [], paths: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname; paths.push(path);
    const data = await request.json() as { messages?: { content: string }[] };
    if (path === '/v1/chat/completions') {
      const source = JSON.parse(data.messages![1]!.content) as { revision: string; parts: string[] };
      sourceParts.push(source.parts); await sourceGate;
      const spans = source.parts.flatMap((part, index) => Array.from(part.matchAll(/person@example\.test/g), match => ({ part: index, start: match.index!, end: match.index! + sensitive.length })));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } }, usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  cleanups.push(() => server.stop(true));
  const screening: ProtectedSourceOwnerOptions = {
    authority: { ownerId: 'synthetic-email-loopback', revision: '1', retention: 'ephemeral-no-log', signal: new AbortController().signal, assertCurrent() {} },
    proposal: { endpoint: `http://127.0.0.1:${server.port}`, model: 'synthetic-proposer' },
    judgment: { endpoint: `http://127.0.0.1:${server.port}`, model: 'jev-1.13.0' }, timeoutMs: 5_000,
  };
  return { screening, sockets, sourceParts, paths, changes,
    get secretReads() { return secretReads; }, get constructors() { return constructors; },
    createMail(configManager: ConfigManager): ReturnType<NonNullable<DaemonInboxControls['createEmailService']>> {
      constructors++; const disposers: Array<() => void> = []; let closed = false;
      const { emailServiceDeps } = composeMailDeps({ configManager,
        secretsManager: { async get(key) { expect(key).toBe('GOODVIBES_SURFACES_EMAIL_PASSWORD'); secretReads++; await credentialGate; return token; },
          onDidChange(listener) { changes.add(listener); return () => { changes.delete(listener); }; } },
        registerDispose(dispose) { disposers.push(dispose); },
      });
      return { service: new EmailService({ ...emailServiceDeps, async imapSocketFactory(host, port) {
        expect(host).toBe(configManager.get('surfaces.email.host')); expect(port).toBe(account.port);
        const socket = new MailSocket({ validity, uids: [...uids], ...(holdGreeting ? { hold: 'greeting' } : {}), closeGate: transportGate }, malformed);
        sockets.push(socket); setImmediate(() => socket.greet()); return socket as unknown as Socket;
      } }), close() { if (closed) return; closed = true; for (const dispose of disposers.reverse()) dispose(); } };
    },
    setMailbox(nextValidity: number, nextUids: number[]) { validity = nextValidity; uids = nextUids; },
    setMalformed(value?: 'search' | 'body' | 'unsupported') { malformed = value; },
    holdCredential(value: Promise<void>) { credentialGate = value; },
    holdSource(value: Promise<void>) { sourceGate = value; },
    holdTransportClose(value: Promise<void>) { holdGreeting = true; transportGate = value; },
    rotateSecret(value: string) { token = value; for (const change of changes) change('GOODVIBES_SURFACES_EMAIL_PASSWORD'); },
  };
}

function fixture(provider = remote(), settings: { root?: string; account?: EmailInboxAccount; holdGate?: boolean } = {}) {
  const root = settings.root ?? makeOwnedTempDir('email-daemon-composition');
  const homeDirectory = join(root, 'home'), workingDir = join(root, 'workspace'), configDir = join(homeDirectory, '.goodvibes', 'daemon');
  mkdirSync(configDir, { recursive: true }); mkdirSync(workingDir, { recursive: true });
  const expected = settings.account ?? account;
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir, homeDir: homeDirectory });
  configManager.set('cluster.enabled', false); configManager.set('relay.enabled', false);
  configManager.set('surfaces.email.host', expected.host);
  configManager.set('surfaces.email.user', expected.username);
  // Config mutations are driven explicitly; avoid a delayed file-watch echo of boot's migration.
  keep(spyOn(configManager, 'watchConfigFiles').mockImplementation(() => () => {}));
  const featureFlags = createFeatureFlagManager(); featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
  let port = 0, fileName = '', gateId = '', graphWasCold = false;
  let control: InboxPollingControl | undefined, handlerContext: HandlerContext | undefined;
  let routing: Parameters<DaemonInboxFactory>[1] | undefined;
  let readValidationGate: Promise<void> | undefined, readValidations = 0;
  const owners: EmailInboxOwner[] = [], retirements: Array<{ kind: string; leaseHeld: boolean }> = [];
  const composition = createEmailDaemonInboxFactory({ account: expected, screening: provider.screening }, {
    createOwner(options) {
      const owner = createEmailInboxOwner(options); const close = owner.close;
      keep(spyOn(owner, 'close').mockImplementation(async () => { await close(); retirements.push({ kind: 'provider', leaseHeld: existsSync(`${storePath()}.owner.lock`) }); }));
      owners.push(owner); return owner;
    },
    registerSurface(context, options) {
      fileName = options.storeFileName!;
      const acquire = options.acquireReadLease!;
      const surface = registerInboxSurface(context, { ...options, async acquireReadLease() {
        const validate = await acquire();
        return async () => { readValidations++; await readValidationGate; await validate(); };
      } });
      const close = surface.close;
      keep(spyOn(surface, 'close').mockImplementation(async () => { await close(); retirements.push({ kind: 'store', leaseHeld: existsSync(`${storePath()}.owner.lock`) }); }));
      return surface;
    },
  });
  const storePath = () => join(workingDir, '.goodvibes', 'tui', 'operator', fileName);
  const createEmailService = () => provider.createMail(configManager);
  const serveFactory = ((options) => { const server = Bun.serve(options); port = server.port!; return server; }) as typeof Bun.serve;
  const host = createDaemonHost({ runtime: { configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), featureFlags,
    homeDirectory, workingDir, daemonHomeDirectory: configDir,
    inboxFactory(context, route, controls) {
      handlerContext = context; routing = route;
      return composition(context, route, { createEmailService, gatePolling(id, next) {
        control = next; gateId = id; return controls.gatePolling(id, { start: () => settings.holdGate ? Promise.resolve() : next.start(), stop: () => next.stop() });
      } });
    },
    localUserAuthManager: new UserAuthManager({ bootstrapFilePath: join(homeDirectory, 'users.json'), bootstrapCredentialPath: join(homeDirectory, 'bootstrap.txt'),
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('fixture'), roles: ['admin'] }] }),
  }, daemon: { host: '127.0.0.1', port: 0, token: 'synthetic-email-daemon-token', serveFactory } }, { async createRuntime(options) {
    const before = provider.sockets.length; const runtime = await createRuntimeServices(options); graphWasCold = provider.sockets.length === before;
    keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockResolvedValue('')); return runtime;
  } });
  hosts.push(host);
  return { root, host, configManager, provider, owners, composition, retirements, createEmailService,
    holdReadValidation(value: Promise<void>) { readValidationGate = value; }, get readValidations() { return readValidations; },
    get graphWasCold() { return graphWasCold; }, get control() { return control!; }, get gateId() { return gateId; },
    get storePath() { return storePath(); }, get handlerContext() { return handlerContext!; }, get routing() { return routing!; },
    async wire(authenticated = true) {
      const response = await fetch(`http://127.0.0.1:${port}/api/channels/inbox`, { headers: authenticated ? { Authorization: 'Bearer synthetic-email-daemon-token' } : {} });
      return { status: response.status, text: await response.text() };
    },
    async inbox() { const response = await this.wire(); expect(response.status).toBe(200); return JSON.parse(response.text) as InboxListOutput; },
    async poll() { await control!.stop(); await control!.start(); },
  };
}

function stored(path: string): { items: Array<{ id: string; bodyPreview: string; fromDigest: string }>; checkpoint: ImapUidCheckpoint | null; cursor: number } {
  if (!existsSync(path)) return { items: [], checkpoint: null, cursor: 0 };
  const db = new Database(path, { readonly: true });
  try { const row = db.query<{ checkpoint: string }, []>("SELECT checkpoint FROM imap_checkpoints WHERE provider = 'email'").get();
    return { items: db.query<{ id: string; bodyPreview: string; fromDigest: string }, []>('SELECT id, bodyPreview, fromDigest FROM items ORDER BY id').all(),
      checkpoint: row ? JSON.parse(row.checkpoint) as ImapUidCheckpoint : null,
      cursor: db.query<{ nextSince: number }, []>("SELECT nextSince FROM cursors WHERE provider = 'email'").get()?.nextSince ?? 0 };
  } finally { db.close(); }
}

test('cold owned composition explicitly seeds before content; authenticated HTTP serves fully screened, redacted mail', async () => {
  const f = fixture(undefined, { holdGate: true });
  expect(f.provider.constructors).toBe(0); expect(f.provider.secretReads).toBe(0);
  expect((await f.host.start()).state).toBe('ready'); expect(f.graphWasCold).toBe(true);
  expect(f.provider.constructors).toBe(1); expect(f.provider.secretReads).toBe(0); expect(f.provider.sockets).toHaveLength(0);
  expect(f.gateId).toBe(`email:${f.owners[0]!.scopeId}`); expect(f.storePath).toEndWith(`inbox-email-${f.owners[0]!.scopeId}.sqlite`);
  expect(f.owners[0]!.scopeId).toMatch(/^[a-f0-9]{64}$/); expect(f.storePath).not.toContain(account.username); expect(f.storePath).not.toContain(account.host);
  expect((await f.wire(false)).status).toBe(401); expect(f.provider.secretReads).toBe(0);
  expect((await f.wire()).status).toBe(503); // No durable generation has been authorized yet.
  await f.control.start();
  expect(f.provider.sourceParts).toEqual([]);
  expect(f.provider.sockets.every(socket => socket.commands.every(command => !command.includes('FETCH')))).toBe(true);
  expect(stored(f.storePath)).toMatchObject({ items: [], cursor: 0, checkpoint: { uidValidity: 7, lastTerminalUid: null, history: { kind: 'complete' } } });
  expect(await f.inbox()).toMatchObject({ total: 0, partial: true, providers: [{ provider: 'email', state: 'pending', mailboxHistory: { kind: 'complete', uidValidity: 7 }, mailboxProgress: { uidValidity: 7, pendingMessages: 2 } }] });
  await f.poll();
  const inbox = await f.inbox();
  expect(inbox).toMatchObject({ total: 2, partial: false,
    providers: [{ provider: 'email', state: 'ready', storedCount: 2, syncing: true, configured: true, mailboxProgress: { uidValidity: 7, pendingMessages: 0 } }] });
  for (const item of inbox.items) expect(item).toMatchObject({ provider: 'email', bodyPreview: redacted, subject: 'Review [redacted]', from: digestSender(`email:${sender}`) });
  expect(inbox.items.every(item => item.routeId === undefined)).toBe(true);
  expect(f.provider.sourceParts).toHaveLength(2); expect(f.provider.paths).toHaveLength(4);
  for (const parts of f.provider.sourceParts) {
    expect(parts).toHaveLength(5); expect(parts[0]).toContain(`From: ${sender}`); expect(parts[0]).toContain(`Subject: Review ${sensitive}`);
    expect(parts[1]).toContain('"HTML"'); expect(parts[2]).toBe(`${body}\n${html}`);
    expect(parts[3]).toBe(`Review ${sensitive}`); expect(parts[4]).toBe(body);
  }
  expect(stored(f.storePath)).toMatchObject({ cursor: 0, checkpoint: { uidValidity: 7, lastTerminalUid: 43 }, items: [{ bodyPreview: redacted }, { bodyPreview: redacted }] });
  const bytes = readFileSync(f.storePath).toString('utf8');
  for (const raw of [sensitive, sender, account.username, account.host, 'synthetic-mail-secret', html]) expect(bytes).not.toContain(raw);
  for (const item of stored(f.storePath).items) expect(item.id).toMatch(/^email:[a-f0-9]{64}:0000000007:000000004[23]$/);
  expect(JSON.stringify(inbox)).not.toContain(sender); expect(f.provider.sockets.every(socket => socket.closed)).toBe(true);
});

test('durable UID checkpoint survives secret rotation and restart without repeating content or relying on Date headers', async () => {
  const provider = remote(); const first = fixture(provider); await first.host.start(); await first.poll();
  const before = stored(first.storePath); expect(before.checkpoint?.lastTerminalUid).toBe(43);
  provider.rotateSecret('synthetic-rotated-secret'); await first.poll(); expect(stored(first.storePath)).toEqual(before);
  await first.host.close(); expect(provider.changes.size).toBe(0);
  const calls = provider.sourceParts.length; const second = fixture(provider, { root: first.root }); await second.host.start();
  expect(second.storePath).toBe(first.storePath); expect(stored(second.storePath)).toEqual(before);
  expect(provider.sourceParts).toHaveLength(calls); expect((await second.inbox()).total).toBe(2);
  provider.setMailbox(7, [42, 43, 44]); await second.poll(); expect(stored(second.storePath).checkpoint?.lastTerminalUid).toBe(44);
  expect((await second.inbox()).total).toBe(3); expect(provider.sourceParts).toHaveLength(calls + 1);
});

test('bounded first-seed omissions and observed pending counts remain visible over authenticated HTTP after catch-up and restart', async () => {
  const provider = remote(); provider.setMailbox(7, Array.from({ length: 52 }, (_, n) => n + 1));
  const first = fixture(provider); await first.host.start();
  const history = { uidValidity: 7, kind: 'bounded-seed', lowerBoundUid: 3, skippedOlderMessages: 2 };
  expect(await first.inbox()).toMatchObject({ partial: true, total: 0, providers: [{ state: 'pending', mailboxHistory: history, mailboxProgress: { uidValidity: 7, pendingMessages: 50 } }] });
  expect(provider.sourceParts).toHaveLength(0);
  // Synthetic expunges leave two eligible messages; the durable seed fence must not widen.
  provider.setMailbox(7, [1, 2, 3, 4]); await first.poll();
  expect(await first.inbox()).toMatchObject({ partial: true, total: 2, providers: [{ state: 'ready', mailboxHistory: history, mailboxProgress: { uidValidity: 7, pendingMessages: 0 } }] });
  expect(provider.sourceParts).toHaveLength(2); expect(stored(first.storePath).checkpoint?.lastTerminalUid).toBe(4);
  await first.host.close(); const second = fixture(provider, { root: first.root }); await second.host.start();
  expect(await second.inbox()).toMatchObject({ partial: true, total: 2, providers: [{ mailboxHistory: history, mailboxProgress: { uidValidity: 7, pendingMessages: 0 } }] });
  expect(provider.sourceParts).toHaveLength(2);
});

test('new UIDVALIDITY withholds old rows before reset, durably removes them at reset, and consumes lower UIDs next', async () => {
  const f = fixture(); await f.host.start(); await f.poll(); const before = stored(f.storePath); expect(before.items).toHaveLength(2);
  f.provider.setMailbox(9, [1, 2]); const refused = await f.wire(); expect(refused.status).toBe(503); expect(refused.text).not.toContain(redacted);
  expect(stored(f.storePath)).toEqual(before); const screens = f.provider.sourceParts.length;
  await f.poll(); expect(stored(f.storePath)).toMatchObject({ items: [], checkpoint: { uidValidity: 9, lastTerminalUid: null } });
  expect(f.provider.sourceParts).toHaveLength(screens); expect((await f.inbox()).total).toBe(0);
  await f.poll(); expect(stored(f.storePath)).toMatchObject({ checkpoint: { uidValidity: 9, lastTerminalUid: 2 } });
  expect((await f.inbox()).total).toBe(2); expect(stored(f.storePath).items.every(item => item.id.includes(':0000000009:'))).toBe(true);
});

test('a projected old-generation HTTP result is withheld when reset commits before post-read authentication', async () => {
  const f = fixture(); await f.host.start(); await f.poll();
  expect(stored(f.storePath).items).toHaveLength(2);
  const held = gate(), validations = f.readValidations; f.holdReadValidation(held.promise);
  const response = f.wire(); await until(() => f.readValidations > validations);
  f.provider.setMailbox(9, [1]); await f.poll();
  expect(stored(f.storePath)).toMatchObject({ items: [], checkpoint: { uidValidity: 9, lastTerminalUid: null } });
  held.resolve(); const refused = await response; expect(refused.status).toBe(503); expect(refused.text).not.toContain(redacted);
  expect((await f.inbox()).total).toBe(0);
});

for (const phase of ['screening', 'commit'] as const) for (const mutation of ['account', 'config', 'secret'] as const) {
  test(`${mutation} ABA during held ${phase} leaves the durable seed and all messages pending`, async () => {
    const f = fixture(); await f.host.start(); const before = stored(f.storePath); const held = gate(); const reached = gate();
    if (phase === 'screening') f.provider.holdSource(held.promise);
    else {
      const write = fs.writeFile;
      keep(spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        if (String(args[0]).startsWith(`${f.storePath}.`)) { reached.resolve(); await held.promise; }
        return write(...args);
      }));
    }
    const polling = f.poll();
    if (phase === 'screening') await until(() => f.provider.sourceParts.length > 0); else await until(settled(reached.promise));
    if (mutation === 'account') { f.configManager.set('surfaces.email.user', 'other@synthetic.invalid'); f.configManager.set('surfaces.email.user', account.username); }
    else if (mutation === 'config') { f.configManager.set('surfaces.email.imap.port', 1993); f.configManager.set('surfaces.email.imap.port', account.port); }
    else { f.provider.rotateSecret('temporary-synthetic-secret'); f.provider.rotateSecret('synthetic-mail-secret'); }
    held.resolve(); await polling; expect(stored(f.storePath)).toEqual(before);
    expect(await f.inbox()).toMatchObject({ total: 0, partial: true });
    await f.poll(); expect(stored(f.storePath).checkpoint?.lastTerminalUid).toBe(43); expect((await f.inbox()).total).toBe(2);
  });
}

test.each(['search', 'body', 'unsupported'] as const)('malformed or unsupported %s source remains pending without screening or persistence', async malformed => {
  const f = fixture(); await f.host.start(); const before = stored(f.storePath); f.provider.setMalformed(malformed);
  await f.poll(); expect(stored(f.storePath)).toEqual(before); expect(f.provider.sourceParts).toEqual([]);
  f.provider.setMalformed(); expect(await f.inbox()).toMatchObject({ total: 0, partial: true, providers: [{ state: 'error' }] });
  await f.poll(); expect((await f.inbox()).total).toBe(2);
});

test('account mismatch blocks old mirror reads and polling before more credentials or source work', async () => {
  const f = fixture(); await f.host.start(); await f.poll(); const before = stored(f.storePath);
  const reads = f.provider.secretReads, sockets = f.provider.sockets.length, screens = f.provider.sourceParts.length;
  f.configManager.set('surfaces.email.user', 'other@synthetic.invalid');
  const refused = await f.wire(); expect(refused.status).toBe(503); expect(refused.text).not.toContain(redacted); await f.poll();
  expect(f.provider.secretReads).toBe(reads); expect(f.provider.sockets).toHaveLength(sockets); expect(f.provider.sourceParts).toHaveLength(screens);
  expect(stored(f.storePath)).toEqual(before);
});

test('duplicate lifetime owner cannot acquire the store; an explicit different account is isolated', async () => {
  const provider = remote(); const first = fixture(provider); await first.host.start(); const before = stored(first.storePath);
  const reads = provider.secretReads;
  await expect(first.composition(first.handlerContext, first.routing, { createEmailService: first.createEmailService, gatePolling() {} })).rejects.toThrow('owned account and storage');
  expect(first.owners).toHaveLength(2); await expect(first.owners[1]!.assertReadCurrent()).rejects.toThrow('unavailable');
  expect(provider.changes.size).toBe(1); expect(provider.secretReads).toBe(reads); expect(stored(first.storePath)).toEqual(before);
  await first.host.close(); expect(existsSync(`${first.storePath}.owner.lock`)).toBe(false);
  const second = fixture(provider, { root: first.root, account: { ...account, username: 'other@synthetic.invalid' }, holdGate: true });
  await second.host.start(); expect(second.storePath).not.toBe(first.storePath); expect(second.gateId).not.toBe(first.gateId);
  expect(stored(second.storePath).checkpoint).toBeNull(); expect(stored(first.storePath)).toEqual(before);
});

test.each(['cluster', 'unconfigured', 'constructor'] as const)('%s refusal precedes service construction, credentials, files, and polling', async mode => {
  const root = makeOwnedTempDir('email-refused-composition'), workingDirectory = join(root, 'workspace'); mkdirSync(workingDirectory);
  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: workingDirectory, homeDir: join(root, 'home') });
  configManager.set('cluster.enabled', mode === 'cluster');
  if (mode !== 'unconfigured') { configManager.set('surfaces.email.host', account.host); configManager.set('surfaces.email.user', account.username); }
  let effects = 0; const context: HandlerContext = { configManager, workingDirectory, homeDirectory: join(root, 'home'), catalog: new GatewayMethodCatalog(),
    credentials: createDaemonCredentialStore({ async get() { effects++; return null; }, async set() { effects++; } }), logger: { info() {}, warn() {}, error() {} } };
  const composition = createEmailDaemonInboxFactory({ account, screening: remote().screening }, {
    createOwner() { effects++; throw new Error('Unexpected owner'); }, registerSurface() { effects++; throw new Error('Unexpected registration'); },
  });
  const routing = { async initialize() {}, async close() {}, unregister() {}, resolveProfileId: () => null };
  await expect(composition(context, routing, { gatePolling() { effects++; }, ...(mode === 'constructor' ? {} : { createEmailService() { effects++; throw new Error('Unexpected mail'); } }) })).rejects.toThrow(mode === 'constructor' ? 'canonical' : 'single-node');
  expect(effects).toBe(0); expect(existsSync(join(workingDirectory, '.goodvibes', 'tui', 'operator'))).toBe(false);
});

test('stopping an admitted screening poll drains it, retains the lease, and permits a fresh controlled retry', async () => {
  const f = fixture(); await f.host.start(); const before = stored(f.storePath), held = gate(); f.provider.holdSource(held.promise);
  const polling = f.poll(); void polling.catch(() => {}); await until(() => f.provider.sourceParts.length > 0);
  await f.control.stop(); await polling.catch(() => {}); held.resolve();
  expect(stored(f.storePath)).toEqual(before); expect(existsSync(`${f.storePath}.owner.lock`)).toBe(true);
  expect(await f.inbox()).toMatchObject({ partial: true, total: 0 });
  await f.control.start(); expect(stored(f.storePath).checkpoint?.lastTerminalUid).toBe(43); expect((await f.inbox()).total).toBe(2);
});

test.each(['credential', 'transport', 'source'] as const)('shutdown drains held %s work before releasing the owner lease and cannot publish late results', async mode => {
  const f = fixture(); await f.host.start(); const before = stored(f.storePath), held = gate();
  const reads = f.provider.secretReads, sockets = f.provider.sockets.length;
  if (mode === 'credential') f.provider.holdCredential(held.promise);
  else if (mode === 'transport') f.provider.holdTransportClose(held.promise);
  else f.provider.holdSource(held.promise);
  const pending = f.poll(); void pending.catch(() => {});
  await until(() => mode === 'credential' ? f.provider.secretReads > reads : mode === 'transport' ? f.provider.sockets.length > sockets : f.provider.sourceParts.length > 0);
  const closing = f.host.close(), done = settled(closing); expect(f.host.close()).toBe(closing);
  if (mode !== 'source') { await pause(); expect(done()).toBe(false); expect(existsSync(`${f.storePath}.owner.lock`)).toBe(true); held.resolve(); }
  await pending.catch(() => {}); await closing; held.resolve(); await pause();
  expect(stored(f.storePath)).toEqual(before); expect(existsSync(`${f.storePath}.owner.lock`)).toBe(false); expect(f.provider.changes.size).toBe(0);
  expect(f.retirements.map(value => value.kind).sort()).toEqual(['provider', 'store']); expect(f.retirements.every(value => value.leaseHeld)).toBe(true);
  expect(f.provider.sockets.every(socket => socket.closed)).toBe(true); await expect(f.control.start()).rejects.toThrow('stopped');
  const next = fixture(f.provider, { root: f.root, holdGate: true }); await next.host.start(); expect(next.storePath).toBe(f.storePath);
});
