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
  let closeFailure: AggregateError | undefined;
  const close = () => {
    if (closed) { if (closeFailure) throw closeFailure; return; }
    closed = true; lifetime.abort();
    const failures: unknown[] = [];
    for (const unsubscribe of subscriptions.reverse()) { try { unsubscribe(); } catch (error) { failures.push(error); } }
    if (failures.length) {
      closeFailure = new AggregateError(failures, 'Configured inbox account subscriptions did not close');
      throw closeFailure;
    }
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

/** Replace a revoked native source only after its real storage and poll owners drain. */
export function createReacquiringDaemonInboxSourceFactory(provider: 'slack' | 'email' | 'discord',
  factory: DaemonInboxSourceFactory): DaemonInboxSourceFactory {
  return (context, routing, controls) => {
    const subscribe = controls.onAccountInvalidation;
    if (!subscribe) throw new Error('Native inbox source requires account invalidation');
    const lifetime = new AbortController();
    let revision = 0;
    let closed = false;
    let requested = false;
    let retirementFailed = false;
    let admissionFailure: { readonly error: unknown } | undefined;
    let current: OwnedInboxSource | undefined;
    let retiring: Promise<void> = Promise.resolve();
    let running: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    const unavailable = () => new Error('Native inbox account is unavailable');
    const retire = (source: OwnedInboxSource): Promise<void> => {
      let draining: Promise<void>;
      try { draining = source.close(); } catch (error) { draining = Promise.reject(error); }
      retiring = Promise.allSettled([retiring, draining]).then(results => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) {
          retirementFailed = true;
          throw new AggregateError(failures.map(result => result.reason), 'Native inbox source retirement failed');
        }
      });
      void retiring.catch(() => {});
      return retiring;
    };
    const retireCurrent = (): void => {
      const previous = current;
      current = undefined;
      if (previous) void retire(previous).catch(() => {});
    };
    // Closing this facade also revokes an account that is still being acquired.
    const ownedControls: Controls = { ...controls, onAccountInvalidation(listener) {
      if (closed) throw unavailable();
      const stopNative = subscribe(listener);
      const stop = () => listener();
      lifetime.signal.addEventListener('abort', stop, { once: true });
      return () => { lifetime.signal.removeEventListener('abort', stop); stopNative(); };
    } };
    const reconcile = async (): Promise<void> => {
      while (requested && !closed && !retirementFailed) {
        requested = false;
        await retiring;
        if (closed || retirementFailed) return;
        const captured = revision;
        let candidate: OwnedInboxSource | undefined;
        try {
          candidate = await factory(context, routing, ownedControls);
          await candidate.ready;
          if (candidate.providerIds.length !== 1 || candidate.providerIds[0] !== provider) {
            throw new Error('Native inbox source membership changed');
          }
          if (closed || captured !== revision) {
            await retire(candidate);
            continue;
          }
          current = candidate;
          admissionFailure = undefined;
        } catch (error) {
          admissionFailure = { error };
          if (candidate) await retire(candidate);
          if (retirementFailed) throw error;
          // Mutation onset can legitimately refuse new admission. Settlement
          // supplies another native notification; do not reuse a retired owner.
          try { context.logger.warn('Native inbox source admission is unavailable'); } catch { /* Reporting cannot grant admission. */ }
        }
      }
    };
    const queue = (): Promise<void> => {
      requested = true;
      if (running) return running;
      const work = Promise.resolve().then(reconcile);
      running = work;
      const settled = () => {
        if (running === work) running = undefined;
        if (requested && !closed && !retirementFailed) void queue().catch(() => {});
      };
      void work.then(settled, settled);
      return work;
    };
    const changed = (): void => {
      if (closed) return;
      revision++;
      retireCurrent();
      void queue().catch(() => {});
    };
    const unsubscribe = subscribe(changed);
    const ready = queue().then(() => {
      if (closed || retirementFailed) throw unavailable();
      if (!current) {
        if (admissionFailure) throw admissionFailure.error;
        throw unavailable();
      }
    });
    void ready.catch(() => {});
    const close = (): Promise<void> => {
      if (closing) return closing;
      const deferred = Promise.withResolvers<void>();
      closing = deferred.promise;
      closed = true; revision++;
      const failures: unknown[] = [];
      try { lifetime.abort(); } catch (error) { failures.push(error); }
      try { unsubscribe(); } catch (error) { failures.push(error); }
      retireCurrent();
      void (async () => {
        const acquisition = await Promise.allSettled([running]);
        if (acquisition[0]?.status === 'rejected') failures.push(acquisition[0].reason);
        try { await retiring; } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Native inbox source did not close cleanly');
      })().then(deferred.resolve, deferred.reject);
      return closing;
    };
    return {
      providerIds: Object.freeze([provider]), ready, close,
      unregister() { void close().catch(() => {}); },
      getImapCheckpoint(providerId) {
        if (closed || !current || !current.getImapCheckpoint) throw unavailable();
        return current.getImapCheckpoint(providerId);
      },
      async acquireRead(requireFinalProof) {
        await ready;
        const source = current, captured = revision;
        if (closed || !source || retirementFailed) throw unavailable();
        const read = await source.acquireRead(requireFinalProof);
        const assertCurrent = (): void => {
          if (closed || current !== source || captured !== revision || retirementFailed) throw unavailable();
          read.assertCurrent();
        };
        try { assertCurrent(); } catch (error) { read.release(); throw error; }
        return { ...read, assertCurrent, release: () => read.release(),
          async validate() { assertCurrent(); await read.validate(); assertCurrent(); },
        };
      },
    };
  };
}
