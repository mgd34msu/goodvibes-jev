/** Real native factory callers, canonical mirror/triage stores and recorded synthetic judgments. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { FakeClusterClock } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { EmailService, describeSenderClaimNeutrally } from '@goodvibes-jev/engine/sdk/platform/email';
import { InboxCursorStore, inboxTriage, registerCompositeInboxSurface, registerInboxSurface,
  type InboxListOutput, type InboxPollingControl, type InboxTriageAuthority,
  type InboundProviderAdapter, type OwnedInboxSource, type OwnedTriagedInboxSource,
} from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import type { DaemonInboxControls, DaemonInboxFactory } from '../../runtime/daemon-handler-composition.js';
import { createDiscordDaemonInboxSourceFactory } from '../../runtime/discord-inbox-composition.js';
import { createEmailDaemonInboxFactory, createEmailDaemonInboxSourceFactory } from '../../runtime/email-inbox-composition.js';
import { createSlackDaemonInboxFactory, createSlackDaemonInboxSourceFactory } from '../../runtime/slack-inbox-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const providers = ['slack', 'discord', 'email'] as const;
type Provider = typeof providers[number];
const logger = { info() {}, warn() {}, error() {} };
const routing: Parameters<DaemonInboxFactory>[1] = {
  async initialize() {}, async close() {}, unregister() {}, resolveProfileId: () => null,
};
function triaged(source: OwnedInboxSource): OwnedTriagedInboxSource {
  if (!('runInboxTriage' in source) || typeof source.runInboxTriage !== 'function') {
    throw new Error('Native factory did not restore the canonical triaged source');
  }
  // The callable was established by the real constructor, not source/config JSON.
  return source as OwnedTriagedInboxSource;
}

async function fixture(provider: Provider, options: { noAuthority?: boolean; scope?: string;
  directory?: string; clustered?: boolean; failReady?: boolean; deferReady?: boolean;
  throwAfterGate?: boolean; lifecycle?: { closed: boolean; metadataCalls: number };
  metadataHeld?: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> };
  held?: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } } = {}) {
  const directory = options.directory ?? makeOwnedTempDir(`native-${provider}-triage`);
  const catalog = new GatewayMethodCatalog();
  const config = new ConfigManager({ workingDir: directory, homeDir: directory, surfaceRoot: 'daemon' });
  config.set('cluster.enabled', options.clustered === true);
  config.set('surfaces.slack.enabled', true); config.set('surfaces.slack.workspaceId', 'T-SYNTHETIC');
  config.set('surfaces.discord.enabled', true);
  config.set('surfaces.email.imapHost', 'mail.synthetic.invalid');
  config.set('surfaces.email.username', 'owner@synthetic.invalid');
  const context: HandlerContext = { catalog, configManager: config, workingDirectory: directory,
    homeDirectory: directory, logger, credentials: { resolveConfigSecret: async () => null,
      resolveRef: async () => null, put: async () => {}, has: async () => false } };
  const scopeId = options.scope ?? `synthetic-${provider}-account`;
  const storage = join(directory, '.goodvibes', 'tui', 'operator');
  const mirror = join(storage, `inbox-${provider}-${scopeId}.sqlite`);
  if (options.failReady) {
    const failure = spyOn(InboxCursorStore.prototype, 'init').mockImplementation(async () => {
      throw new Error('Synthetic native mirror bootstrap failure');
    });
    cleanups.push(() => failure.mockRestore());
  }
  const semantic = new AbortController();
  let current = true, validations = 0, polls = 0, providerClosed = false, enrollments = 0, metadataCalls = 0;
  const assertCurrent = () => { if (!current) throw new Error('Synthetic native account retired'); };
  const acquireReadLease = async () => Object.assign(async () => { assertCurrent(); validations++; }, { assertCurrent });
  const adapter: InboundProviderAdapter = { id: provider, pollIntervalMs: 3_600_000, async poll() {
    assertCurrent(); polls++;
    return { state: 'ready', configured: true, items: [{ id: `${provider}:one`, provider, kind: 'dm',
      fromDigest: 'cafebabedeadbeef', subjectPreview: 'Release review',
      bodyPreview: 'Please review our release checklist before the rehearsal this afternoon.',
      receivedAt: Date.now(), unread: true }] };
  } };
  const fake = fakePort((name, question, state) => {
    expect(state).toEqual({ items: [{ id: `${provider}:one`, surface: provider, subject: 'Release review',
      snippet: 'Please review our release checklist before the rehearsal this afternoon.', conversationKind: 'direct', unread: true }] });
    const key = name === 'item0__spam' ? 'spam' : name === 'item0__urgency' ? 'urgency' : undefined;
    if (!key) throw new Error('Unexpected registered triage question');
    expect(question).toEqual({ ...inboxTriage.items[key].question,
      instructions: `For items[0] only: ${inboxTriage.items[key].question.instructions}` });
    return noulAnswer(key === 'spam' ? .01 : .99);
  });
  const log = new SqliteDecisionLog(':memory:'); cleanups.push(() => log[Symbol.dispose]());
  const inner: JudgmentPort = options.held ? { model: 'jev-1.13.0', async ask(request) {
    options.held!.entered.resolve(); await options.held!.release.promise; return fake.port.ask(request);
  } } : fake.port;
  const authority: InboxTriageAuthority = { accountScopeId: scopeId, providerId: provider,
    destinationId: 'synthetic-recorded-only', retention: 'ephemeral-no-log',
    port: withDecisionLog(inner, log), signal: semantic.signal, assertCurrent };
  // This grant is constructor-owned fixture provenance. No service is contacted.
  const screening: ProtectedSourceOwnerOptions = { authority: { ownerId: 'synthetic-fixture-only', revision: 'one',
    retention: 'ephemeral-no-log', signal: semantic.signal, assertCurrent },
    proposal: { endpoint: 'http://127.0.0.1:1', model: 'synthetic-proposer' },
    judgment: { endpoint: 'http://127.0.0.1:1', model: 'jev-1.13.0' } };
  const native = { scopeId, adapter, acquireReadLease, assertReadCurrent: async () => { assertCurrent(); },
    invalidateCredential() { current = false; },
    verifyEligibility: async () => {
      metadataCalls++;
      if (options.lifecycle) options.lifecycle.metadataCalls++;
      if (options.metadataHeld) { options.metadataHeld.entered.resolve(); await options.metadataHeld.release.promise; }
      assertCurrent(); return { signal: semantic.signal, assertCurrent };
    },
    async close() { current = false; providerClosed = true; if (options.lifecycle) options.lifecycle.closed = true; } };
  let control: InboxPollingControl | undefined;
  const noTransport = async (): Promise<never> => { throw new Error('Unexpected mail transport'); };
  const service = new EmailService({ getConfig: () => undefined, secretsManager: { get: async () => null },
    describeSenderClaim: describeSenderClaimNeutrally,
    transport: { connectImapTls: noTransport, connectSmtpTls: noTransport, connectSmtpStartTls: noTransport } });
  const controls: DaemonInboxControls = { gatePolling(_id, value) { control = value; },
    gatePollingOwned(_id, value) { enrollments++; control = value; return () => value.stop(); },
    onAccountInvalidation() { return () => {}; }, createEmailService: () => ({ service, close() {} }) };
  const semanticOptions = options.noAuthority ? {} : { triageAuthority: authority };
  const slackAccount = { workspaceId: 'T-SYNTHETIC', userId: 'U-SYNTHETIC' };
  const discordAccount = { userId: '100000000000000001' };
  const emailAccount = { host: 'mail.synthetic.invalid', port: 993, username: 'owner@synthetic.invalid',
    mailbox: 'INBOX', security: 'tls' as const };
  const eligibilityClock = new FakeClusterClock();
  if (options.throwAfterGate) {
    const registerSurface: typeof registerInboxSurface = (_ctx, source) => {
      source.gatePolling?.(provider, { async start() { throw new Error('Unconstructed source must not start'); }, async stop() {} });
      throw new Error('Synthetic registrar failed after offering its gate');
    };
    if (provider === 'slack') {
      await createSlackDaemonInboxFactory({ account: slackAccount, screening }, {
        eligibilityClock, registerSurface, createOwner: async () => ({ ...native, account: slackAccount }),
      })(context, routing, controls);
    } else if (provider === 'email') {
      await createEmailDaemonInboxFactory({ account: emailAccount, screening }, {
        eligibilityClock, registerSurface, createOwner: () => ({ ...native, account: emailAccount }),
      })(context, routing, controls);
    } else throw new Error('Discord has no alternate registrar seam');
    throw new Error('Failing registrar unexpectedly returned');
  }
  const create = provider === 'slack'
    ? createSlackDaemonInboxSourceFactory({ account: slackAccount, screening, ...semanticOptions },
      { eligibilityClock, createOwner: async () => ({ ...native, account: slackAccount }) })
    : provider === 'discord'
      ? createDiscordDaemonInboxSourceFactory({ account: discordAccount, screening, ...semanticOptions,
        channels: { channelIds: ['100000000000000002'], revision: 'synthetic-dm-registry',
          signal: semantic.signal, assertCurrent } },
        { eligibilityClock, createOwner: async () => ({ ...native, account: discordAccount }) })
      : createEmailDaemonInboxSourceFactory({ account: emailAccount, screening, ...semanticOptions },
        { eligibilityClock, createOwner: () => ({ ...native, account: emailAccount }) });
  const owned = triaged(await create(context, routing, controls));
  cleanups.push(() => owned.close());
  void owned.ready.catch(() => {});
  if (!options.deferReady) {
    await owned.ready;
    if (!control) throw new Error('Native factory did not register its polling gate');
    await control.start();
    if (options.clustered) {
      // Cluster start admits its asynchronous seed before storage publication.
      const deadline = Date.now() + 5_000;
      for (;;) {
        const read = await owned.acquireRead(true);
        let count: number;
        try { count = read.sources.store.countItems(); await read.validate(); } finally { read.release(); }
        if (count === 1) break;
        if (Date.now() > deadline) throw new Error('Synthetic native seed did not publish');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    await control.stop();
  }
  const binding = registerCompositeInboxSurface(context, [owned]); cleanups.push(() => binding.close());
  void binding.ready.catch(() => {});
  if (!options.deferReady) await binding.ready;
  const read = () => catalog.invoke('channels.inbox.list', { body: {}, context: { scopes: ['read:channels'] } }) as Promise<InboxListOutput>;
  const close = async () => { await Promise.all([binding.close(), owned.close()]); };
  return { owned, read, fake, log, semantic, mirror, directory, storage, catalog, close,
    revoke() { current = false; }, validations: () => validations, polls: () => polls,
    providerClosed: () => providerClosed, enrollments: () => enrollments,
    metadataCalls: () => metadataCalls, eligibilityClock };
}

for (const provider of providers) {
  test(`${provider} native factory enriches its existing mirror from persisted account-bound triage without automatic scoring`, async () => {
    const first = await fixture(provider);
    const plain = await first.read(); expect(plain.items[0]?.triageLabel).toBeUndefined();
    expect(first.fake.requests).toHaveLength(0); expect(first.log.query()).toHaveLength(0);
    expect(await first.owned.runInboxTriage()).toMatchObject({ total: 1, receipts: [{ status: 'settled', label: 'priority' }] });
    const enriched = await first.read(); expect(enriched.items[0]).toMatchObject({ triageLabel: 'priority', triageScore: .99,
      triageTags: ['GoodVibes/Priority'] });
    expect(first.fake.requests).toHaveLength(1); expect(first.log.query()).toMatchObject([{ status: 'answered', model: 'jev-1.13.0' }]);
    expect(first.polls()).toBe(1); expect(first.validations()).toBeGreaterThanOrEqual(3);
    expect(existsSync(first.mirror)).toBe(true); expect(existsSync(`${first.mirror}.owner.lock`)).toBe(true);
    expect(readdirSync(first.storage).filter(name => name.startsWith('inbox-owned-'))).toEqual([]);
    expect(first.catalog.hasHandler('inbox.triage.run')).toBe(false); expect(first.catalog.hasHandler('inbox.triage.tag')).toBe(false);
    await first.close(); expect(existsSync(`${first.mirror}.owner.lock`)).toBe(false); expect(first.providerClosed()).toBe(true);
    const second = await fixture(provider, { directory: first.directory });
    expect((await second.read()).items[0]?.triageLabel).toBe('priority'); expect(second.fake.requests).toHaveLength(0);
    second.semantic.abort(); await expect(second.read()).rejects.toMatchObject({ code: 'INBOX_TRIAGE_AUTHORITY_UNAVAILABLE' });
    expect(second.fake.requests).toHaveLength(0);
  });

  test(`${provider} native enrichment keeps the explicit authority prerequisite and isolates a different account`, async () => {
    const missing = await fixture(provider, { noAuthority: true });
    expect((await missing.read()).items[0]?.triageLabel).toBeUndefined();
    await expect(missing.owned.runInboxTriage()).rejects.toMatchObject({ code: 'INBOX_TRIAGE_AUTHORITY_UNAVAILABLE' });
    expect(missing.fake.requests).toHaveLength(0); expect(missing.log.query()).toHaveLength(0);
    await missing.close();
    const first = await fixture(provider, { directory: missing.directory }); await first.owned.runInboxTriage(); await first.close();
    const changed = await fixture(provider, { directory: missing.directory, scope: `different-${provider}-account` });
    expect((await changed.read()).items[0]?.triageLabel).toBeUndefined(); expect(changed.fake.requests).toHaveLength(0);
  });

  test(`${provider} actual caller retains its native lease and mirror lock while a cancelled scoring read drains`, async () => {
    const held = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const f = await fixture(provider, { held });
    const scoring = f.owned.runInboxTriage(); void scoring.catch(() => {}); await held.entered.promise;
    f.revoke(); let closed = false; const closing = f.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 5)); expect(closed).toBe(false);
    expect(existsSync(`${f.mirror}.owner.lock`)).toBe(true);
    held.release.resolve(); await expect(scoring).rejects.toThrow(); await closing;
    expect(existsSync(`${f.mirror}.owner.lock`)).toBe(false);
    expect(readdirSync(f.storage).filter(name => /^inbox-triage-.*\.sqlite$/.test(name))).toEqual([]);
    await expect(f.read()).rejects.toThrow();
  });

  test(`${provider} clustered native constructor awaits its returned source and real mirror readiness before enrollment`, async () => {
    const f = await fixture(provider, { clustered: true });
    expect(f.enrollments()).toBe(1); expect(f.metadataCalls()).toBe(1); expect(f.polls()).toBe(1);
    expect((await f.read()).total).toBe(1); expect(f.fake.requests).toHaveLength(0);
    await f.close(); expect(f.providerClosed()).toBe(true); expect(f.eligibilityClock.pendingTimers).toBe(0);
    expect(existsSync(`${f.mirror}.owner.lock`)).toBe(false);
  });

  test(`${provider} failed native mirror readiness never probes account metadata or enrolls and drains its real source`, async () => {
    const f = await fixture(provider, { clustered: true, failReady: true, deferReady: true });
    await expect(f.owned.ready).rejects.toThrow();
    expect(f.enrollments()).toBe(0); expect(f.metadataCalls()).toBe(0); expect(f.polls()).toBe(0);
    expect(f.fake.requests).toHaveLength(0);
    await f.close(); expect(f.providerClosed()).toBe(true); expect(f.eligibilityClock.pendingTimers).toBe(0);
    expect(existsSync(`${f.mirror}.owner.lock`)).toBe(false);
  });

  test(`${provider} close drains a held post-construction metadata probe without late enrollment or source work`, async () => {
    const metadataHeld = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const f = await fixture(provider, { clustered: true, metadataHeld, deferReady: true });
    await metadataHeld.entered.promise;
    let closed = false; const closing = f.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 5)); expect(closed).toBe(false);
    expect(f.providerClosed()).toBe(true); expect(existsSync(`${f.mirror}.owner.lock`)).toBe(true);
    metadataHeld.release.resolve(); await closing;
    expect(f.enrollments()).toBe(0); expect(f.polls()).toBe(0); expect(f.fake.requests).toHaveLength(0);
    expect(f.eligibilityClock.pendingTimers).toBe(0); expect(existsSync(`${f.mirror}.owner.lock`)).toBe(false);
  });

  test(`${provider} rejected canonical source construction retires its acquired native owner and releases the mirror lease`, async () => {
    const directory = makeOwnedTempDir(`native-${provider}-construction-failure`);
    const lifecycle = { closed: false, metadataCalls: 0 };
    await expect(fixture(provider, { directory, clustered: true, scope: '', lifecycle })).rejects.toThrow('could not acquire');
    expect(lifecycle).toEqual({ closed: true, metadataCalls: 0 });
    expect(existsSync(join(directory, '.goodvibes', 'tui', 'operator', `inbox-${provider}-.sqlite.owner.lock`))).toBe(false);
  });
}

for (const provider of ['slack', 'email'] as const) {
  test(`${provider} constructor rejection after a registrar offers its gate settles the probe before owner drainage`, async () => {
    const directory = makeOwnedTempDir(`native-${provider}-registrar-failure`);
    const lifecycle = { closed: false, metadataCalls: 0 };
    await expect(fixture(provider, { directory, clustered: true, throwAfterGate: true, lifecycle }))
      .rejects.toThrow('could not acquire');
    expect(lifecycle).toEqual({ closed: true, metadataCalls: 0 });
    expect(existsSync(join(directory, '.goodvibes', 'tui', 'operator', `inbox-${provider}-synthetic-${provider}-account.sqlite.owner.lock`))).toBe(false);
  });
}
