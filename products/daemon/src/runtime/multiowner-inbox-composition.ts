/** Explicit independent account ownership behind one canonical inbox method. */
import {
  registerCompositeInboxSurface,
  type InboxSurfaceRegistration,
  type OwnedInboxSource,
} from '@goodvibes-jev/engine/sdk/platform/intake';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';

export type DaemonInboxSourceFactory = (
  ...args: Parameters<DaemonInboxFactory>
) => OwnedInboxSource | Promise<OwnedInboxSource>;

/** No providers are inferred or enabled by this constructor. */
export function createMultiOwnerDaemonInboxFactory(
  sourceFactories: readonly DaemonInboxSourceFactory[],
): DaemonInboxFactory {
  const factories = [...sourceFactories];
  if (factories.length === 0) throw new Error('Multi-owner inbox requires explicit sources');
  return async (context, routing, controls) => {
    const sources: OwnedInboxSource[] = [];
    const providers = new Set<string>();
    let binding: InboxSurfaceRegistration | undefined;
    let closing: Promise<void> | undefined;
    // Start every retirement before awaiting any: an active projection can
    // hold leases in several sources while the borrowed binding drains it.
    const close = (): Promise<void> => {
      if (!closing) closing = (async () => {
        const owned = [...(binding ? [binding] : []), ...sources];
        const results = await Promise.allSettled(owned.map(owner => Promise.resolve().then(() => owner.close())));
        if (results.some(result => result.status === 'rejected')) {
          throw new Error('Multi-owner inbox composition did not close cleanly');
        }
      })();
      return closing;
    };
    try {
      for (const factory of factories) {
        const source = await factory(context, routing, controls);
        sources.push(source);
        // Observe readiness immediately, including during later acquisition.
        void source.ready.catch(() => {});
        for (const providerId of source.providerIds) {
          if (providers.has(providerId)) throw new Error(`Duplicate inbox provider: ${providerId}`);
          providers.add(providerId);
        }
      }
      binding = registerCompositeInboxSurface(context, sources);
    } catch (error) {
      await close();
      throw error;
    }
    const ready = Promise.all([binding.ready, ...sources.map(source => source.ready)])
      .then(() => {}, async error => { await close(); throw error; });
    // The host owns observing ready; avoid an unhandled failure while it wires up.
    void ready.catch(() => {});
    return { ready, close, unregister() { void close().catch(() => {}); } };
  };
}
