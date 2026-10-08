/**
 * Host-side inbound feed persistence and provider contracts (Node/Bun).
 * Not part of the browser/runtime-neutral SDK facade. Provider credentials
 * remain read-only ports; semantic mapping and triage are separate layers.
 */
export type { IntakeCredentialStore, IntakeLogger } from './context.js';
export { createProtectedInboxMapper } from './protected-preview.js';
export type { ProtectedInboxPreviewInput, ProtectedInboxPreviewFields } from './protected-preview.js';
export { createEmailInboxOwner } from './providers/email-owner.js';
export type { EmailInboxAccount, EmailInboxOwnerOptions, EmailInboxOwner } from './providers/email-owner.js';
export { createSlackInboxOwner } from './providers/slack-owner.js';
export type { SlackInboxAccount, SlackInboxOwnerOptions, SlackInboxOwnerFactories, SlackInboxOwner } from './providers/slack-owner.js';
export { sha256First, digestSender, stripMarkup, normalizeWhitespace } from './text-normalization.js';
export type {
  ImapUidCheckpoint, ImapUidCheckpointAdvance, ImapUidTerminalDisposition,
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

export {
  ImapClient as IntakeImapClient, imapDate as intakeImapDate,
  parseFetchResponse as parseIntakeFetchResponse, decodeHeader as decodeIntakeImapHeader,
} from './providers/imap-client.js';
export type {
  ImapConfig as IntakeImapConfig, ImapEnvelope as IntakeImapEnvelope,
  ImapSocket as IntakeImapSocket, ImapConnector as IntakeImapConnector,
} from './providers/imap-client.js';
export { resolveRouteId as resolveIntakeRouteId } from './providers/route-util.js';

export { inboxTriage, TRIAGE_MODEL } from './triage/battery.js';
export { labelToTag } from './triage/evidence.js';
export { scoreInboxTriage } from './triage/scorer.js';
export { SqliteTriageStore } from './triage/store.js';
export { runInboxTriage, readTriageMetadataBatch, enrichItemsWithTriage } from './triage/pipeline.js';
export type {
  TriageInput, TriageLabel, TriageBinding, TriageEvidence, TriageReceipt,
  TriageStoredRecord, TriageStore, RunInboxTriageOptions,
} from './triage/types.js';
