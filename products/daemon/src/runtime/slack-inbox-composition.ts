import type { ClusterClock } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { ownInboxEligibility } from './inbox-eligibility.js';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireCrossProcessLock } from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import {
  createSlackInboxOwner, registerInboxSurface, createOwnedInboxSource,
  type SlackInboxAccount, type SlackInboxOwner, type InboxSurfaceRegistration,
} from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { DaemonInboxSourceFactory } from './multiowner-inbox-composition.js';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';

export interface SlackDaemonInboxOptions {
  /** Explicit expected Slack workspace AND user/bot identity; not token-derived. */
  readonly account: SlackInboxAccount;
  /** Trusted established local-service authority, including live revocation. */
  readonly screening: ProtectedSourceOwnerOptions;
  readonly timeoutMs?: number;
}

/** In-process constructor capabilities; never sourced from CLI/config/message data. */
export interface SlackDaemonInboxFactories {
  readonly createOwner?: (...args: Parameters<typeof createSlackInboxOwner>) => Promise<SlackInboxOwner>;
  readonly registerSurface?: typeof registerInboxSurface;
  /** Constructor-only deterministic clock, never decoded from configuration. */
  readonly eligibilityClock?: ClusterClock;
}

/** Independently owned Slack account, with no canonical method binding. */
export interface SlackDaemonInboxSourceFactories extends Omit<SlackDaemonInboxFactories, 'registerSurface'> {
  readonly createSource?: typeof createOwnedInboxSource;
}

export function createSlackDaemonInboxSourceFactory(
  options: SlackDaemonInboxOptions,
  factories: SlackDaemonInboxSourceFactories = {},
): DaemonInboxSourceFactory {
  return createSlackAccountFactory(options, factories, factories.createSource ?? createOwnedInboxSource, true);
}

/** Compatible single-source composition, including the injected registrar seam. */
export function createSlackDaemonInboxFactory(
  options: SlackDaemonInboxOptions,
  factories: SlackDaemonInboxFactories = {},
): DaemonInboxFactory {
  return createSlackAccountFactory(options, factories, factories.registerSurface ?? registerInboxSurface, false);
}

function createSlackAccountFactory<T extends InboxSurfaceRegistration>(
  options: SlackDaemonInboxOptions,
  factories: Pick<SlackDaemonInboxFactories, 'createOwner' | 'eligibilityClock'>,
  register: (context: Parameters<DaemonInboxFactory>[0], options: Parameters<typeof registerInboxSurface>[1]) => T,
  requireFinalProof: boolean,
): (...args: Parameters<DaemonInboxFactory>) => Promise<T> {
  return async (context, _routing, controls) => {
    const clustered = context.configManager.get('cluster.enabled') === true;
    if (clustered && !controls.gatePollingOwned) throw new Error('Clustered inbox requires owned gate retirement');
    if (clustered && !controls.onAccountInvalidation) throw new Error('Clustered Slack inbox requires owned account invalidation');
    if (context.configManager.get('surfaces.slack.enabled') !== true) throw new Error('Slack inbox composition requires Slack to be enabled');
    const expectedWorkspace = options.account.workspaceId;
    const account = Object.freeze({ workspaceId: expectedWorkspace, userId: options.account.userId });
    const current = (): void => {
      if ((context.configManager.get('cluster.enabled') === true) !== clustered
        || context.configManager.get('surfaces.slack.enabled') !== true
        || context.configManager.get('surfaces.slack.workspaceId') !== expectedWorkspace) {
        throw new Error('Slack inbox configuration scope changed');
      }
    };
    current();
    const workingDirectory = await realpath(context.workingDirectory);
    current();
    const owner = await (factories.createOwner ?? createSlackInboxOwner)(context, {
      account, screening: options.screening, assertCurrent: current,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    let eligibility: ReturnType<typeof ownInboxEligibility> | undefined;
    let unsubscribe: (() => void) | undefined;
    let release: (() => void) | undefined;
    let surface: T | undefined;
    try {
      if (requireFinalProof && typeof owner.acquireReadLease !== 'function') {
        throw new Error('Slack inbox source requires a generation-fenced read lease');
      }
      if (clustered && (typeof owner.verifyEligibility !== 'function' || typeof owner.invalidateCredential !== 'function')) {
        throw new Error('Clustered Slack inbox requires an eligible owner');
      }
      unsubscribe = controls.onAccountInvalidation?.(() => owner.invalidateCredential?.());
      current();
      const storeFileName = `inbox-slack-${owner.scopeId}.sqlite`;
      release = await acquireCrossProcessLock(join(workingDirectory, '.goodvibes', 'tui', 'operator', `${storeFileName}.owner.lock`), {
        strictOwnership: true, totalTimeoutMs: 100,
      });
      current();
      surface = register({ ...context, workingDirectory }, {
        adapters: new Map([['slack', owner.adapter]]), storeFileName, ...(clustered ? { awaitInitialPoll: false } : {}),
        ...(requireFinalProof
          ? { acquireReadLease: () => owner.acquireReadLease!() }
          : { assertReadCurrent: owner.assertReadCurrent }),
        // Keep wire provider='slack'; only the owner/election discriminator is scoped.
        gatePolling: (_provider, control) => {
          if (!clustered) return controls.gatePolling(`slack:${owner.scopeId}`, control);
          eligibility = ownInboxEligibility({ verify: async () => { await surface!.ready; return owner.verifyEligibility!(); }, control,
            ...(factories.eligibilityClock ? { clock: factories.eligibilityClock } : {}),
            register: gated => controls.gatePollingOwned!(`slack:${owner.scopeId}`, gated),
          });
          return () => eligibility!.close();
        },
      });
    } catch {
      try { await Promise.all([Promise.resolve().then(() => unsubscribe?.()), owner.close(), eligibility?.close()]); } finally { release?.(); }
      throw new Error('Slack inbox composition could not acquire its owned storage');
    }
    const registration = surface;
    const unlock = release;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing) {
        closing = Promise.resolve().then(async () => {
          let subscriptionFailure = false;
          try { unsubscribe?.(); } catch { subscriptionFailure = true; }
          const [store, provider] = await Promise.allSettled([registration.close(), owner.close()]);
          // Never release a store lease on a failed storage retirement.
          if (store.status === 'fulfilled') unlock();
          if (subscriptionFailure || store.status === 'rejected' || provider.status === 'rejected') throw new Error('Slack inbox composition did not close cleanly');
        });
      }
      return closing;
    };
    return {
      ...registration,
      unregister() { void close().catch(() => {}); },
      ready: Promise.all([registration.ready, eligibility?.ready]).then(() => {}),
      close,
    };
  };
}
