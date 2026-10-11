/** Pinned built-in membership with explicit account/authority admission. */
import type { OwnedInboxSource, ProviderStatus } from '@goodvibes-jev/engine/sdk/platform/intake';
import { createMultiOwnerDaemonInboxFactory, type DaemonInboxSourceFactory } from './multiowner-inbox-composition.js';
import { createSlackDaemonInboxSourceFactory, type SlackDaemonInboxOptions, type SlackDaemonInboxSourceFactories } from './slack-inbox-composition.js';
import { createEmailDaemonInboxSourceFactory, type EmailDaemonInboxOptions, type EmailDaemonInboxSourceFactories } from './email-inbox-composition.js';
import { createDiscordDaemonInboxSourceFactory, type DiscordDaemonInboxOptions, type DiscordDaemonInboxSourceFactories } from './discord-inbox-composition.js';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';

/** Original254699bf inbox/index.ts registers precisely these three providers. */
export const BUILTIN_DAEMON_INBOX_PROVIDERS = ['slack', 'discord', 'email'] as const;
type Provider = typeof BUILTIN_DAEMON_INBOX_PROVIDERS[number];
export interface ProductionDaemonInboxOptions {
  /** Established trusted-local services and expected account, never message/config-derived authority. */
  readonly slack?: SlackDaemonInboxOptions;
  readonly discord?: DiscordDaemonInboxOptions;
  readonly email?: EmailDaemonInboxOptions;
}

const fields: Record<Provider, readonly string[]> = {
  slack: ['surfaces.slack.botToken'],
  discord: ['surfaces.discord.botToken'],
  email: ['surfaces.email.imapHost', 'surfaces.email.imapUser', 'surfaces.email.imapPassword',
    'surfaces.email.username', 'surfaces.email.password', 'surfaces.email.imap.host',
    'surfaces.email.host', 'surfaces.email.user', 'surfaces.email.imap.password'],
};

/** No source or provider network request is made while determining absence. */
function assertUnconfigured(provider: Provider, context: Parameters<DaemonInboxFactory>[0]): void {
  const prefix = `surfaces.${provider}`;
  const quarantine = context.configManager.getIngestionQuarantine?.();
  if (!quarantine || quarantine.some(entry => entry.key === '(whole file)'
    || entry.key === 'surfaces' || entry.key === prefix || entry.key.startsWith(`${prefix}.`))) {
    throw new Error('Inbox configuration admission is unavailable');
  }
  const config: { get(key: string): unknown } = context.configManager;
  if (provider !== 'email' && config.get(`surfaces.${provider}.enabled`) === true) {
    throw new Error(`Configured ${provider} inbox requires an admitted account and trusted local screening authority`);
  }
  for (const field of fields[provider]) {
    const setting = config.get(field);
    const presence = context.credentials.inspectConfigSecret?.(field);
    if (presence === undefined || presence === 'unavailable') throw new Error('Inbox credential admission is unavailable');
    if ((typeof setting === 'string' && setting.trim()) || presence === 'present') {
      throw new Error(`Configured ${provider} inbox requires an admitted account and trusted local screening authority`);
    }
  }
}

/** Absence is a fenced state, not a fake adapter, empty successful poll or stored feed. */
function unconfiguredSource(provider: Provider): DaemonInboxSourceFactory {
  return async (context, _routing, controls): Promise<OwnedInboxSource> => {
    if (!controls.onAccountInvalidation) throw new Error('Production inbox admission requires config and credential invalidation');
    let generation = 0;
    let closed = false;
    const unsubscribe = controls.onAccountInvalidation(() => { generation++; });
    const active = new Set<Promise<void>>();
    const assertCurrent = () => {
      if (closed) throw new Error('Inbox source is retired');
    };
    const validate = async () => {
      assertCurrent(); const captured = generation;
      await assertUnconfigured(provider, context); assertCurrent();
      if (captured !== generation) throw new Error('Inbox configuration changed during admission');
    };
    try { await validate(); } catch (error) { unsubscribe(); throw error; }
    const status: ProviderStatus = { id: provider, state: 'unavailable', configured: false, itemCount: 0,
      // No provider poll or sync receipt is claimed by an absence check.
      polled: false };
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing) { closed = true; unsubscribe(); closing = Promise.all([...active]).then(() => {}); }
      return closing;
    };
    return {
      providerIds: [provider], ready: Promise.resolve(), close, unregister() { void close(); },
      async acquireRead() {
        assertCurrent();
        let release!: () => void;
        const held = new Promise<void>(done => { release = done; }); active.add(held);
        let released = false;
        const retire = () => { if (!released) { released = true; active.delete(held); release(); } };
        const captured = generation;
        const current = () => {
          assertCurrent();
          if (released || captured !== generation) throw new Error('Inbox read is retired or configuration changed');
          assertUnconfigured(provider, context);
        };
        try {
          await validate(); current();
          return { providerIds: [provider], release: retire, assertCurrent: current,
            async validate() { current(); await validate(); current(); },
            sources: {
              store: { listItems: () => [], countItems: () => 0, countItemsByProvider: () => new Map(),
                maxReceivedAt: () => 0, getImapCheckpoint: () => null },
              poller: { snapshotStatuses: selected => !selected || selected.includes(provider) ? [{ ...status }] : [],
                isProviderRunning: () => false },
            },
          };
        } catch (error) { retire(); throw error; }
      },
    };
  };
}

/** One canonical registration; no inferred grants, historical-DM discovery claims or missing-provider omission. */
export function createProductionDaemonInboxFactory(options: ProductionDaemonInboxOptions = {},
  factories: { readonly slack?: SlackDaemonInboxSourceFactories; readonly email?: EmailDaemonInboxSourceFactories; readonly discord?: DiscordDaemonInboxSourceFactories } = {},
): DaemonInboxFactory {
  return createMultiOwnerDaemonInboxFactory([
    options.slack ? createSlackDaemonInboxSourceFactory(options.slack, factories.slack) : unconfiguredSource('slack'),
    options.discord ? createDiscordDaemonInboxSourceFactory(options.discord, factories.discord) : unconfiguredSource('discord'),
    options.email ? createEmailDaemonInboxSourceFactory(options.email, factories.email) : unconfiguredSource('email'),
  ]);
}
