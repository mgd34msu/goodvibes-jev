import { expect, test } from 'bun:test';
import { ConfigManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import type { DaemonInboxControls, DaemonInboxFactory } from '../../runtime/daemon-handler-composition.js';
import { createReacquiringDaemonInboxSourceFactory, selectConfiguredSlackInboxAccount, selectConfiguredEmailInboxAccount, selectConfiguredDiscordInboxAccount } from '../../runtime/configured-inbox-accounts.js';
import { createOwnedInboxSource, type OwnedInboxSource, type OwnedInboxRead } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { DaemonInboxSourceFactory } from '../../runtime/multiowner-inbox-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const root = makeOwnedTempDir('configured-native-accounts');
  const config = new ConfigManager({ homeDir: root, workingDir: root, surfaceRoot: 'daemon' });
  let subscriptions = 0, credentials = 0;
  const context: HandlerContext = { catalog: new GatewayMethodCatalog(), configManager: config,
    credentials: createDaemonCredentialStore({ async get() { credentials++; throw new Error('Account selection must never infer identity from credentials'); }, async set() { throw new Error('No writes'); } }),
    workingDirectory: root, homeDirectory: root, logger: { info() {}, warn() {}, error() {} } };
  const controls: DaemonInboxControls = { gatePolling() {},
    onAccountInvalidation(listener) { subscriptions++; const stop = config.onDidInvalidate(listener);
      return () => { subscriptions--; stop(); }; },
    onConfigurationChange(key, listener) { subscriptions++; const stop = config.subscribe(key, listener);
      return () => { subscriptions--; stop(); }; },
  };
  return { config, context, controls, get subscriptions() { return subscriptions; }, get credentials() { return credentials; } };
}

test('native Slack selection requires a separately configured expected user and never derives it from a token', () => {
  const f = fixture(); f.config.set('surfaces.slack.enabled', true); f.config.set('surfaces.slack.workspaceId', 'T-SYNTHETIC');
  expect(() => selectConfiguredSlackInboxAccount(f.context, f.controls)).toThrow('expected workspace and user');
  expect(f.subscriptions).toBe(0); expect(f.credentials).toBe(0);
  f.config.set('surfaces.slack.inboxUserId', 'U-SYNTHETIC');
  const selected = selectConfiguredSlackInboxAccount(f.context, f.controls);
  expect(selected.account).toEqual({ workspaceId: 'T-SYNTHETIC', userId: 'U-SYNTHETIC' });
  f.config.set('surfaces.slack.inboxUserId', 'U-SYNTHETIC-OTHER'); f.config.set('surfaces.slack.inboxUserId', 'U-SYNTHETIC');
  expect(selected.operation.signal.aborted).toBe(true); expect(() => selected.operation.assertCurrent()).toThrow();
  selected.close(); expect(f.subscriptions).toBe(0); expect(f.credentials).toBe(0);
});

test('native IMAP-only setup selects the canonical TLS account without SMTP or a password read', () => {
  const f = fixture();
  f.config.set('surfaces.email.imapHost', 'imap.synthetic.test'); f.config.set('surfaces.email.imapUser', 'mailbox@synthetic.test');
  const selected = selectConfiguredEmailInboxAccount(f.context, f.controls);
  expect(selected.account).toEqual({ host: 'imap.synthetic.test', port: 993, username: 'mailbox@synthetic.test', mailbox: 'INBOX', security: 'tls' });
  expect(f.credentials).toBe(0); selected.operation.assertCurrent(); selected.close(); expect(f.subscriptions).toBe(0);
});

test('nested mailbox spelling retains canonical precedence and an exact source mutation fences its account', () => {
  const f = fixture(); f.config.set('surfaces.email.imapHost', 'legacy.synthetic.test');
  f.config.set('surfaces.email.imapUser', 'legacy@synthetic.test');
  f.config.set('surfaces.email.imap.host', 'preferred.synthetic.test'); f.config.set('surfaces.email.user', 'preferred@synthetic.test');
  f.config.set('surfaces.email.imap.mailbox', 'Selected mailbox'); f.config.set('surfaces.email.imap.port', 1993);
  const selected = selectConfiguredEmailInboxAccount(f.context, f.controls);
  expect(selected.account).toMatchObject({ host: 'preferred.synthetic.test', username: 'preferred@synthetic.test', mailbox: 'Selected mailbox', port: 1993 });
  f.config.set('surfaces.email.imap.mailbox', 'Other mailbox');
  expect(() => selected.operation.assertCurrent()).toThrow(); selected.close(); expect(f.subscriptions).toBe(0);
});

test('plaintext IMAP fails native account admission before acquiring screening credentials', () => {
  const f = fixture(); f.config.set('surfaces.email.imapHost', 'imap.synthetic.test');
  f.config.set('surfaces.email.imapUser', 'mailbox@synthetic.test'); f.config.set('surfaces.email.imap.secure', false);
  expect(() => selectConfiguredEmailInboxAccount(f.context, f.controls)).toThrow('TLS');
  expect(f.credentials).toBe(0); expect(f.subscriptions).toBe(0);
});

test('native Discord selector admits only the explicit bot-bound canonical one-to-one DM registry', () => {
  const f = fixture(); f.config.set('surfaces.discord.enabled', true); f.config.set('surfaces.discord.inboxBotUserId', '100000000000000001');
  f.config.set('surfaces.discord.inboxChannelIds', '100000000000000002,100000000000000003');
  const selected = selectConfiguredDiscordInboxAccount(f.context, f.controls);
  expect(selected.account).toEqual({ userId: '100000000000000001', channelIds: ['100000000000000002', '100000000000000003'] });
  f.config.set('surfaces.discord.inboxChannelIds', '100000000000000099'); f.config.set('surfaces.discord.inboxChannelIds', '100000000000000002,100000000000000003');
  expect(() => selected.operation.assertCurrent()).toThrow(); selected.close(); expect(f.subscriptions).toBe(0);
  f.config.set('surfaces.discord.inboxChannelIds', '100000000000000002,100000000000000002');
  expect(() => selectConfiguredDiscordInboxAccount(f.context, f.controls)).toThrow('unique canonical');
  expect(f.subscriptions).toBe(0); expect(f.credentials).toBe(0);
});


const nativeRouting: Parameters<DaemonInboxFactory>[1] = {
  async initialize() {}, async close() {}, unregister() {}, resolveProfileId: () => null,
};
const nextTurn = () => new Promise<void>(resolve => { setImmediate(resolve); });

/** Real storage and read leases; no provider content request is admitted. */
function nativeFixtureSource(context: HandlerContext, retireGate?: () => void): OwnedInboxSource {
  return createOwnedInboxSource(context, { storeFileName: 'native-reacquiring-email.sqlite',
    adapters: new Map([['email', { id: 'email', pollIntervalMs: 3_600_000,
      async poll() { throw new Error('Lifecycle fixture must not poll provider content'); },
    }]]),
    skipInitialPoll: true, gatePolling: () => retireGate,
  });
}
function containsFailure(value: unknown, expected: Error): boolean {
  return value === expected || (value instanceof AggregateError
    && value.errors.some((error: unknown) => containsFailure(error, expected)));
}

test('native invalidation fences the old read immediately and replacement waits its actual source drain', async () => {
  const f = fixture();
  const oldCloseEntered = Promise.withResolvers<void>(), replacementCreated = Promise.withResolvers<void>();
  let constructions = 0, oldDrained = false, replacementBeforeDrain = false;
  const factory: DaemonInboxSourceFactory = context => {
    const ordinal = ++constructions;
    const source = nativeFixtureSource(context);
    if (ordinal > 1) {
      replacementBeforeDrain = !oldDrained;
      void source.ready.then(replacementCreated.resolve, replacementCreated.reject);
    }
    return { ...source, async close() {
      const draining = source.close();
      if (ordinal === 1) oldCloseEntered.resolve();
      await draining;
      if (ordinal === 1) oldDrained = true;
    } };
  };
  const owned = await createReacquiringDaemonInboxSourceFactory('email', factory)(f.context, nativeRouting, f.controls);
  let oldRead: OwnedInboxRead | undefined;
  let freshRead: OwnedInboxRead | undefined;
  try {
    await owned.ready;
    const heldRead = await owned.acquireRead(true); oldRead = heldRead;
    heldRead.assertCurrent();
    f.config.invalidateExternalPolicy();
    expect(() => heldRead.assertCurrent()).toThrow('unavailable');
    await expect(owned.acquireRead(true)).rejects.toThrow('unavailable');
    await oldCloseEntered.promise;
    await nextTurn();
    expect(oldDrained).toBe(false); expect(constructions).toBe(1);
    oldRead.release();
    await replacementCreated.promise;
    await nextTurn();
    expect(oldDrained).toBe(true); expect(replacementBeforeDrain).toBe(false);
    expect(constructions).toBe(2);
    freshRead = await owned.acquireRead(true); freshRead.assertCurrent();
    expect(freshRead.providerIds).toEqual(['email']);
    expect(() => heldRead.assertCurrent()).toThrow('unavailable');
    expect(f.credentials).toBe(0);
  } finally {
    oldRead?.release(); freshRead?.release();
    await owned.close();
  }
  expect(f.subscriptions).toBe(0);
});

test('a failed actual source retirement permanently prevents replacement and remains visible at shutdown', async () => {
  const f = fixture();
  const cleanupFailure = new Error('Synthetic native gate retirement failure');
  const retirementEntered = Promise.withResolvers<void>(), retired = Promise.withResolvers<unknown>();
  let constructions = 0;
  const factory: DaemonInboxSourceFactory = context => {
    constructions++;
    const source = nativeFixtureSource(context, () => { retirementEntered.resolve(); throw cleanupFailure; });
    return { ...source, close() {
      const draining = source.close();
      void draining.then(() => { retired.resolve(undefined); }, retired.resolve);
      return draining;
    } };
  };
  const owned = await createReacquiringDaemonInboxSourceFactory('email', factory)(f.context, nativeRouting, f.controls);
  try {
    await owned.ready;
    f.config.invalidateExternalPolicy();
    await retirementEntered.promise;
    expect(containsFailure(await retired.promise, cleanupFailure)).toBe(true);
    await nextTurn();
    expect(constructions).toBe(1);
    f.config.invalidateExternalPolicy();
    await nextTurn();
    expect(constructions).toBe(1);
    await expect(owned.acquireRead(true)).rejects.toThrow('unavailable');
    const closing = owned.close();
    expect(owned.close()).toBe(closing);
    const result: unknown = await closing.then(() => undefined, (error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(containsFailure(result, cleanupFailure)).toBe(true);
    const later: unknown = await owned.close().then(() => undefined, (error: unknown) => error);
    expect(later).toBe(result);
  } finally { await owned.close().catch(() => {}); }
  expect(f.subscriptions).toBe(0);
});

test('close aborts native account selection and waits a pending acquisition without publishing its late source', async () => {
  const f = fixture();
  f.config.set('surfaces.email.imapHost', 'imap.synthetic.test');
  f.config.set('surfaces.email.imapUser', 'mailbox@synthetic.test');
  const acquired = Promise.withResolvers<ReturnType<typeof selectConfiguredEmailInboxAccount>>();
  const releaseAcquisition = Promise.withResolvers<void>();
  let constructed = 0, drained = 0;
  const factory: DaemonInboxSourceFactory = async (context, _routing, controls) => {
    const selection = selectConfiguredEmailInboxAccount(context, controls);
    acquired.resolve(selection);
    // Deliberately let the owned acquisition finish late after its signal aborts.
    await releaseAcquisition.promise;
    const source = nativeFixtureSource(context); constructed++;
    return { ...source, async close() {
      try { selection.close(); } finally { await source.close(); }
      drained++;
    } };
  };
  const owned = await createReacquiringDaemonInboxSourceFactory('email', factory)(f.context, nativeRouting, f.controls);
  const readiness = owned.ready.then(() => undefined, (error: unknown) => error);
  try {
    const selected = await acquired.promise;
    const closing = owned.close();
    expect(owned.close()).toBe(closing);
    expect(selected.operation.signal.aborted).toBe(true);
    expect(() => selected.operation.assertCurrent()).toThrow();
    let settled = false;
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await nextTurn();
    expect(settled).toBe(false); expect(constructed).toBe(0);
    releaseAcquisition.resolve();
    await closing;
    expect(constructed).toBe(1); expect(drained).toBe(1);
    expect(await readiness).toBeInstanceOf(Error);
    await expect(owned.acquireRead(true)).rejects.toThrow('unavailable');
    expect(f.credentials).toBe(0);
  } finally {
    releaseAcquisition.resolve();
    await readiness;
    await owned.close();
  }
  expect(f.subscriptions).toBe(0);
});
