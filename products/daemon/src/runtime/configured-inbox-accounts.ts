/** Native account selectors remain independent of permission to screen message text. */
import { createSurfaceEmailInboxConfigReader } from '@goodvibes-jev/engine/sdk/platform/email';
import type { EmailInboxAccount, SlackInboxAccount, OwnedInboxSource } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';
import type { DaemonInboxSourceFactory } from './multiowner-inbox-composition.js';
import { createSlackDaemonInboxSourceFactory, type SlackDaemonInboxSourceFactories } from './slack-inbox-composition.js';
import { createEmailDaemonInboxSourceFactory, type EmailDaemonInboxSourceFactories } from './email-inbox-composition.js';
import { createConfiguredDiscordDaemonInboxSourceFactory, type DiscordDaemonInboxSourceFactories } from './discord-inbox-composition.js';
import type { HostedInboxScreeningOperation } from './hosted-source-screening-composition.js';

const slackKeys = ['surfaces.slack.enabled', 'surfaces.slack.workspaceId', 'surfaces.slack.inboxUserId'] as const;
const emailKeys = ['surfaces.email.imap.host', 'surfaces.email.host', 'surfaces.email.imapHost',
  'surfaces.email.user', 'surfaces.email.username', 'surfaces.email.imapUser', 'surfaces.email.imap.port',
  'surfaces.email.imapPort', 'surfaces.email.imap.secure', 'surfaces.email.imap.mailbox'] as const;
const discordKeys = ['surfaces.discord.enabled', 'surfaces.discord.inboxBotUserId', 'surfaces.discord.inboxChannelIds'] as const;
type Context = Parameters<DaemonInboxFactory>[0];
type Controls = Parameters<DaemonInboxFactory>[2];

function selectedAccount<T>(context: Context, controls: Controls, provider: 'slack' | 'email' | 'discord',
  keys: readonly ConfigKey[], read: () => T): { account: T; operation: HostedInboxScreeningOperation; close(): void } {
  if (!controls.onAccountInvalidation || !controls.onConfigurationChange) throw new Error('Configured inbox requires native account subscriptions');
  const lifetime = new AbortController();
  const subscriptions: Array<() => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; lifetime.abort();
    const failures: unknown[] = [];
    for (const unsubscribe of subscriptions.reverse()) { try { unsubscribe(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Configured inbox account subscriptions did not close');
  };
  try {
    subscriptions.push(controls.onAccountInvalidation(() => lifetime.abort()));
    for (const key of keys) subscriptions.push(controls.onConfigurationChange(key, () => lifetime.abort()));
    const values = keys.map(key => context.configManager.get(key));
    const assertCurrent = (): void => {
      lifetime.signal.throwIfAborted();
      const quarantine = context.configManager.getIngestionQuarantine?.();
      if (closed || !quarantine || quarantine.some(entry => entry.key === '(whole file)' || entry.key === 'surfaces'
        || entry.key === `surfaces.${provider}` || entry.key.startsWith(`surfaces.${provider}.`))
        || keys.some((key, index) => context.configManager.get(key) !== values[index])) {
        throw new Error('Configured inbox account changed or is unavailable');
      }
    };
    assertCurrent();
    const account = read();
    assertCurrent();
    return { account, operation: { signal: lifetime.signal, assertCurrent }, close };
  } catch (error) { close(); throw error; }
}

function boundedName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 320 && value.trim() === value && !/[\r\n\0]/.test(value);
}

export function selectConfiguredSlackInboxAccount(context: Context, controls: Controls) {
  return selectedAccount(context, controls, 'slack', slackKeys, (): SlackInboxAccount => {
    const reader: { get(key: string): unknown } = context.configManager;
    const workspaceId = reader.get('surfaces.slack.workspaceId'), userId = reader.get('surfaces.slack.inboxUserId');
    if (reader.get('surfaces.slack.enabled') !== true || !boundedName(workspaceId) || workspaceId.length > 200
      || !boundedName(userId) || userId.length > 200) throw new Error('Slack inbox requires its expected workspace and user identity');
    return Object.freeze({ workspaceId, userId });
  });
}

export function selectConfiguredEmailInboxAccount(context: Context, controls: Controls) {
  return selectedAccount(context, controls, 'email', emailKeys, (): EmailInboxAccount => {
    const reader: { get(key: string): unknown } = context.configManager;
    const mail = createSurfaceEmailInboxConfigReader(key => reader.get(key));
    const host = mail('email.imapHost'), username = mail('email.username'), mailbox = mail('email.mailbox');
    const port = mail('email.imapPort');
    if (!boundedName(host) || !boundedName(username) || !boundedName(mailbox)
      || mail('email.imapSecurity') !== 'tls' || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Email inbox requires its expected TLS host, account, port and mailbox');
    }
    return Object.freeze({ host, username, mailbox, port, security: 'tls' });
  });
}

export function selectConfiguredDiscordInboxAccount(context: Context, controls: Controls) {
  return selectedAccount(context, controls, 'discord', discordKeys, () => {
    const userId = context.configManager.get('surfaces.discord.inboxBotUserId');
    const registry = context.configManager.get('surfaces.discord.inboxChannelIds');
    const snowflake = (value: unknown): value is string => typeof value === 'string'
      && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) < (1n << 64n);
    if (context.configManager.get('surfaces.discord.enabled') !== true || !snowflake(userId)
      || typeof registry !== 'string' || registry.length > 4_300) throw new Error('Discord inbox requires its expected bot and one-to-one DM registry');
    const channelIds = registry.split(',').map(value => value.trim());
    if (channelIds.length < 1 || channelIds.length > 200 || channelIds.some(id => !snowflake(id))
      || new Set(channelIds).size !== channelIds.length) throw new Error('Discord inbox requires 1–200 unique canonical one-to-one DM channel IDs');
    return Object.freeze({ userId, channelIds: Object.freeze(channelIds) });
  });
}

/** Selected account lifetime encloses acquisition and every original provider operation. */
export function createConfiguredHostedInboxSourceFactory(provider: 'slack' | 'email' | 'discord',
  factories: { readonly slack?: SlackDaemonInboxSourceFactories; readonly email?: EmailDaemonInboxSourceFactories;
    readonly discord?: DiscordDaemonInboxSourceFactories } = {}): DaemonInboxSourceFactory {
  return async (context, routing, controls) => {
    if (!controls.acquireHostedScreening) throw new Error('Configured inbox requires native hosted screening consent and credentials');
    const selection = provider === 'slack' ? selectConfiguredSlackInboxAccount(context, controls)
      : provider === 'email' ? selectConfiguredEmailInboxAccount(context, controls) : selectConfiguredDiscordInboxAccount(context, controls);
    let acquisition: Awaited<ReturnType<NonNullable<Controls['acquireHostedScreening']>>> | undefined;
    let source: OwnedInboxSource | undefined;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing) closing = (async () => {
        // Abort first, drain the source, then release its acquisition subscriptions.
        const failures: unknown[] = [];
        try { selection.close(); } catch (error) { failures.push(error); }
        try { await source?.close(); } catch (error) { failures.push(error); }
        try { await acquisition?.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Configured inbox source did not close cleanly');
      })();
      return closing;
    };
    try {
      acquisition = await controls.acquireHostedScreening(provider === 'slack' ? 'slack-inbox'
        : provider === 'email' ? 'email-inbox' : 'discord-bot-dms', selection.operation);
      selection.operation.assertCurrent();
      const screening: ProtectedSourceOwnerOptions = acquisition.options;
      if (provider === 'slack' && 'workspaceId' in selection.account) {
        source = await createSlackDaemonInboxSourceFactory({ account: selection.account, screening }, factories.slack)(context, routing, controls);
      } else if (provider === 'email' && 'host' in selection.account) {
        source = await createEmailDaemonInboxSourceFactory({ account: selection.account, screening }, factories.email)(context, routing, controls);
      } else if (provider === 'discord' && 'channelIds' in selection.account) {
        source = await createConfiguredDiscordDaemonInboxSourceFactory(screening, factories.discord)(context, routing, controls);
      } else throw new Error('Configured inbox account family changed');
      selection.operation.assertCurrent();
      return { ...source, close, unregister() { void close().catch(() => {}); } };
    } catch (error) { await close(); throw error; }
  };
}
