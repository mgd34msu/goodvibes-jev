import { expect, test } from 'bun:test';
import { ConfigManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import type { DaemonInboxControls } from '../../runtime/daemon-handler-composition.js';
import { selectConfiguredSlackInboxAccount, selectConfiguredEmailInboxAccount, selectConfiguredDiscordInboxAccount } from '../../runtime/configured-inbox-accounts.js';
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
