/** Read-only fanout. Storage, polling, and account authority stay with each owner. */
import type { InboxAggregatorSources } from './aggregator.js';

export interface InboxReadSource {
  readonly providerIds: readonly string[];
  readonly sources: InboxAggregatorSources;
}

/** Match SQLite's default BINARY collation, including non-ASCII identifiers. */
function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function composeInboxReads(input: readonly InboxReadSource[]): InboxAggregatorSources {
  const sources = input.map(source => ({ providerIds: [...source.providerIds], sources: source.sources }));
  const owners = new Map<string, InboxAggregatorSources>();
  for (const source of sources) for (const id of source.providerIds) {
    if (owners.has(id)) throw new Error('Inbox provider IDs must have exactly one owner');
    owners.set(id, source.sources);
  }
  const selected = (providers?: readonly string[]): readonly InboxReadSource[] =>
    providers?.length ? sources.filter(source => source.providerIds.some(id => providers.includes(id))) : sources;
  return {
    store: {
      listItems(query) {
        // Each source needs the entire global lookahead, not a divided quota.
        return selected(query.providers).flatMap(source => source.sources.store.listItems(query))
          .sort((a, b) => b.receivedAt - a.receivedAt || compareIds(a.id, b.id))
          .slice(0, query.limit);
      },
      countItems(providers, since) {
        return selected(providers).reduce((total, source) => total + source.sources.store.countItems(providers, since), 0);
      },
      countItemsByProvider(providers, since) {
        const counts = new Map<string, number>();
        for (const source of selected(providers)) for (const [id, count] of source.sources.store.countItemsByProvider(providers, since)) {
          counts.set(id, (counts.get(id) ?? 0) + count);
        }
        return counts;
      },
      maxReceivedAt(providers) {
        return selected(providers).reduce((max, source) => Math.max(max, source.sources.store.maxReceivedAt(providers)), 0);
      },
      getImapCheckpoint(provider) { return owners.get(provider)?.store.getImapCheckpoint(provider) ?? null; },
    },
    poller: {
      snapshotStatuses(providers) {
        if (providers?.length) return providers.flatMap(id => owners.get(id)?.poller.snapshotStatuses([id]) ?? []);
        return sources.flatMap(source => source.sources.poller.snapshotStatuses());
      },
      isProviderRunning(provider) { return owners.get(provider)?.poller.isProviderRunning(provider) ?? false; },
    },
  };
}
