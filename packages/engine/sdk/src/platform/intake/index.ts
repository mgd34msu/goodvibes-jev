/**
 * Host-side inbound feed persistence and provider contracts (Node/Bun).
 * Not part of the browser/runtime-neutral SDK facade. Provider credentials
 * remain read-only ports; semantic mapping and triage are separate layers.
 */
export type { IntakeCredentialStore, IntakeLogger } from './context.js';
export type {
  InboundChannelItem, ProviderState, ProviderPollResult, ProviderPollOptions,
  AdapterContext, RouteResolver, InboundProviderAdapter, AdapterFactory,
} from './provider-adapter.js';
export {
  POLL_CADENCE_MS, registerAdapterFactory, registeredProviderIds, buildAdapters,
  clearAdapterRegistry,
} from './provider-adapter.js';
export {
  InboxCursorStore, INBOX_ITEM_TTL_MS, INBOX_ITEM_CAP, INBOX_SWEEP_INTERVAL_MS,
} from './cursor-store.js';
export type {
  InboxSweepSummary, InboxCursorStoreOptions, InboxPosition, InboxQuery,
} from './cursor-store.js';

export { InboundPoller } from './poller.js';
export type { ProviderStatus, PollerOptions } from './poller.js';

export {
  DEFAULT_LIMIT, MAX_LIMIT, encodePageCursor, decodePageCursor,
  normalizeInboxQuery, toWireItem, aggregateInbox,
} from './aggregator.js';
export type {
  InboxListInput, ChannelInboxItem, ChannelInboxProviderStatus,
  InboxListOutput, InboxListQuery, InboxAggregatorSources,
} from './aggregator.js';

export { INBOX_LIST_METHOD_ID, registerInboxSurface } from './registration.js';
export type {
  InboxPollingControl, InboxSurfaceContext, RegisterInboxSurfaceOptions, InboxSurfaceRegistration,
} from './registration.js';
