/** Consumer-vantage pin for the host-only intake public package subpath. */
import { InboxCursorStore, buildAdapters, type AdapterContext, type InboundChannelItem, type InboxQuery, type IntakeCredentialStore } from '@goodvibes-jev/engine/sdk/platform/intake';

declare const credentials: IntakeCredentialStore;
declare const context: AdapterContext;
declare const item: InboundChannelItem;
declare const query: InboxQuery;
declare const store: InboxCursorStore;
const reader: (ref: string) => Promise<string | null> = credentials.resolveRef;
const pollers = buildAdapters(context);
const rows: InboundChannelItem[] = store.listItems(query);
const count: number = store.upsertItems([item]);
const closed: Promise<void> = store.close();
// @ts-expect-error, inbound adapters receive no credential-write capability.
credentials.put('fixture', 'fixture');
export { reader, pollers, rows, count, closed };
