/** Explicit Discord account/DM scope over the canonical source and registration owners. */
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireCrossProcessLock } from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import { createInboxRouteResolver } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { ClusterClock } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { createDiscordInboxOwner, createOwnedInboxSource,
  type DiscordInboxOwnerOptions, type VerifiedDiscordInboxOwner, type OwnedInboxSource,
} from '@goodvibes-jev/engine/sdk/platform/intake';
import { createMultiOwnerDaemonInboxFactory, type DaemonInboxSourceFactory } from './multiowner-inbox-composition.js';
import { attachDaemonInboxTagging, type DaemonTriageTaggingActivation } from './tagged-inbox-composition.js';
import { ownInboxEligibility } from './inbox-eligibility.js';

export interface DiscordDaemonInboxOptions extends Pick<DiscordInboxOwnerOptions, 'account' | 'channels' | 'screening' | 'timeoutMs'> {
  readonly triageTagging?: DaemonTriageTaggingActivation & {
    /** Exact constructor-owned custom label to forum-tag mapping. */
    readonly forumTagIds?: Readonly<Record<string, string>>;
  };
}
export interface DiscordDaemonInboxSourceFactories {
  readonly createOwner?: typeof createDiscordInboxOwner;
  readonly eligibilityClock?: ClusterClock;
}
export function createDiscordDaemonInboxFactory(options: DiscordDaemonInboxOptions,
  factories: DiscordDaemonInboxSourceFactories = {}) {
  return createMultiOwnerDaemonInboxFactory([createDiscordDaemonInboxSourceFactory(options, factories)]);
}
export function createDiscordDaemonInboxSourceFactory(options: DiscordDaemonInboxOptions,
  factories: DiscordDaemonInboxSourceFactories = {}): DaemonInboxSourceFactory {
  const createOwner = factories.createOwner ?? createDiscordInboxOwner;
  const triageTagging = options.triageTagging ? Object.freeze({ onReady: options.triageTagging.onReady,
    ...(options.triageTagging.forumTagIds ? { forumTagIds: Object.freeze({ ...options.triageTagging.forumTagIds }) } : {}),
  }) : undefined;
  if (triageTagging && typeof triageTagging.onReady !== 'function') throw new Error('Discord tagging requires an explicit owner callback');
  return async (context, routing, controls) => {
    if (triageTagging && !controls.createTriageTagging) throw new Error('Discord tagging requires the canonical permission owner');
    if (!controls.onAccountInvalidation) throw new Error('Discord inbox requires account and configuration invalidation');
    const clustered = context.configManager.get('cluster.enabled') === true;
    if (clustered && !controls.gatePollingOwned) throw new Error('Clustered Discord inbox requires owned gate retirement');
    const keys = ['surfaces.discord.enabled', 'surfaces.discord.applicationId', 'surfaces.discord.guildId', 'surfaces.discord.defaultChannelId'] as const;
    const settings = keys.map(key => context.configManager.get(key));
    if (settings[0] !== true) throw new Error('Discord inbox composition requires Discord to be enabled');
    let generation = 0, closed = false;
    let owner: VerifiedDiscordInboxOwner | undefined;
    let surface: OwnedInboxSource | undefined;
    let release: (() => void) | undefined;
    let eligibility: ReturnType<typeof ownInboxEligibility> | undefined;
    // Subscribe before the first await, including owner and storage construction.
    const unsubscribe = controls.onAccountInvalidation(() => { generation++; owner?.invalidateCredential(); });
    const startupGeneration = generation;
    const current = () => {
      const quarantine = context.configManager.getIngestionQuarantine?.();
      if (closed || !quarantine || quarantine.some(entry => entry.key === '(whole file)' || entry.key === 'surfaces'
        || entry.key === 'surfaces.discord' || entry.key.startsWith('surfaces.discord.'))
        || (context.configManager.get('cluster.enabled') === true) !== clustered
        || keys.some((key, i) => context.configManager.get(key) !== settings[i])) {
        throw new Error('Discord inbox configuration scope changed');
      }
    };
    const startupCurrent = () => { current(); if (generation !== startupGeneration) throw new Error('Discord inbox startup was revoked'); };
    try {
      startupCurrent();
      const workingDirectory = await realpath(context.workingDirectory); startupCurrent();
      const resolveProfileId = routing.resolveProfileId.bind(routing);
      const resolveRouteId = createInboxRouteResolver({ getProfileForChannel: resolveProfileId, resolveProfile: resolveProfileId });
      owner = await createOwner({ ...context, resolveRouteId }, {
        account: options.account, channels: options.channels, screening: options.screening, assertCurrent: current,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      startupCurrent();
      const storeFileName = `inbox-discord-${owner.scopeId}.sqlite`;
      release = await acquireCrossProcessLock(join(workingDirectory, '.goodvibes', 'tui', 'operator', `${storeFileName}.owner.lock`), {
        strictOwnership: true, totalTimeoutMs: 100,
      });
      startupCurrent();
      surface = createOwnedInboxSource({ ...context, workingDirectory }, {
        adapters: new Map([['discord', owner.adapter]]), storeFileName,
        ...(clustered ? { awaitInitialPoll: false } : {}), acquireReadLease: () => owner!.acquireReadLease(),
        gatePolling(_provider, control) {
          if (!clustered) return controls.gatePolling(`discord:${owner!.scopeId}`, control);
          eligibility = ownInboxEligibility({ verify: async () => { await surface!.ready; return owner!.verifyEligibility(); }, control,
            ...(factories.eligibilityClock ? { clock: factories.eligibilityClock } : {}),
            register: gated => controls.gatePollingOwned!(`discord:${owner!.scopeId}`, gated),
          });
          return () => eligibility!.close();
        },
      });
    } catch {
      closed = true; unsubscribe();
      const cleanup = await Promise.allSettled([surface?.close(), owner?.close(), eligibility?.close()]);
      if (cleanup[0]?.status === 'fulfilled') release?.();
      throw new Error('Discord inbox composition could not acquire its owned source');
    }
    const registration = surface;
    const owned = owner;
    const unlock = release;
    let closing: Promise<void> | undefined;
    const close = () => {
      if (!closing) {
        closed = true; // Fence new reads synchronously, before asynchronous drainage.
        closing = Promise.resolve().then(async () => {
          let failed = false; try { unsubscribe(); } catch { failed = true; }
          const [store, provider] = await Promise.allSettled([registration.close(), owned.close()]);
          if (store.status === 'fulfilled') unlock();
          if (failed || store.status === 'rejected' || provider.status === 'rejected') throw new Error('Discord inbox did not close cleanly');
        });
      }
      return closing;
    };
    const result = { ...registration, close, unregister() { void close().catch(() => {}); },
      ready: Promise.all([registration.ready, eligibility?.ready]).then(() => {}),
    };
    return triageTagging ? attachDaemonInboxTagging(result, triageTagging, controls, {
      provider: 'discord', accountScopeId: owned.scopeId, assertCurrent: current,
      ...(triageTagging.forumTagIds ? { forumTagIds: triageTagging.forumTagIds } : {}),
    }) : result;
  };
}
