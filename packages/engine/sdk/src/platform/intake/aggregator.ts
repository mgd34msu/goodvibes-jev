// ---------------------------------------------------------------------------
// The provider-inbound aggregator behind `channels.inbox.list`.
//
// ── What it reads, and why that is the live answer ─────────────────────────
//
// It serves the daemon's SYNCED MIRROR (cursor-store.ts), not a fresh remote
// fetch per call. That is a deliberate design decision, not a shortcut:
//
//   * The mirror is already live. Each adapter polls its provider on that
//     provider's own cadence (Slack/Discord 30s, email 60s) and writes what it
//     pulls straight into the store. Explicit triage can score its admitted
//     mirror selection; polling and listing never initiate scoring.
//   * A fetch-per-call would put a third-party rate limit behind a read verb
//     any client may call at any rate, so one impatient UI could get every
//     other consumer throttled by Slack.
//   * The cluster hands FETCHING for each inbox account to one elected node
//     (runtime/cluster-composition.ts). A read that fetched would make every
//     standby node fetch too, which is exactly the double-read the election
//     exists to prevent, while the READ is deliberately ungated so a standby
//     still answers.
//   * Optional triage enrichment reads exact-input receipts under the owned
//     account read lease. It never initiates a judgment or provider write.
//   * A provider outage would turn a read into a hang or a 500 instead of a
//     partial answer with a named cause.
//
// The cost of serving a mirror is that its age is not visible in the items. So
// the aggregator does not leave it implicit: `providers` reports every provider
// this node knows about on EVERY call, its state, when it last synced, how
// much of the mirror is its, and whether this node is the one fetching it.
//
// ── Honest partial results ────────────────────────────────────────────────
//
// A provider whose last sync failed is named and makes the answer partial.
// Existing mirrored items remain visible; a failure does not delete previously
// synced history. lastSyncAt is the last attempt (successful or not), as the
// shared wire schema defines. A provider with no mirrored history contributes
// no items, but that absence is not silently presented as a quiet mailbox.
// ---------------------------------------------------------------------------

import type { InboxCursorStore, InboxPosition } from './cursor-store.js';
import type { InboundPoller, ProviderStatus } from './poller.js';
import type { ImapUidCheckpoint, InboundChannelItem } from './provider-adapter.js';
import { GatewayVerbError as HandlerError } from '../control-plane/routes/gateway-verb-error.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/** SDK `channels.inbox.list` input. */
export interface InboxListInput {
  provider?: string;
  limit?: number;
  since?: number;
  cursor?: string;
}

/** One item in the SDK CHANNEL_INBOX_ITEM_SCHEMA wire shape. */
export interface ChannelInboxItem {
  id: string;
  provider: string;
  kind: string;
  /** Redacted sender token (sha256First, 16 hex). Never the raw id. */
  from: string;
  subject?: string;
  bodyPreview: string;
  receivedAt: number;
  unread: boolean;
  routeId?: string;
  triageScore?: number;
  triageLabel?: 'spam' | 'priority' | 'normal';
  triageTags?: string[];
}

/**
 * Per-provider standing, one entry per provider this node knows about, on every
 * call. See CHANNEL_INBOX_PROVIDER_STATUS_SCHEMA in the SDK catalog for the
 * meaning of each `state`.
 */
export interface ChannelInboxProviderStatus {
  provider: string;
  state: 'ready' | 'empty' | 'unconfigured' | 'error' | 'pending';
  /** Items this provider contributed to the page being returned. */
  itemCount: number;
  /** Items this provider holds in the mirror under the same filter. */
  storedCount: number;
  configured?: boolean;
  lastSyncAt?: number;
  /** Whether THIS node is currently fetching this provider. */
  syncing?: boolean;
  error?: string;
  /** Durable first-seed boundary for this mailbox generation; excluded history is not processed. */
  mailboxHistory?: ImapUidCheckpoint['history'] & { readonly uidValidity: number };
  /** Eligible messages remaining at lastSyncAt, not a live provider total. Absent when unknown. */
  mailboxProgress?: { readonly uidValidity: number; readonly pendingMessages: number };
}

/** SDK `channels.inbox.list` output. */
export interface InboxListOutput {
  items: ChannelInboxItem[];
  total: number;
  truncated: boolean;
  hasMore: boolean;
  cursor?: string;
  nextCursor?: string;
  providers: ChannelInboxProviderStatus[];
  partial: boolean;
}

/** The normalized read the aggregator performs. */
export interface InboxListQuery {
  providers?: string[];
  limit: number;
  since?: number;
  after?: InboxPosition;
}

/** Everything the aggregator reads from. Both are already-built collaborators. */
export interface InboxAggregatorSources {
  readonly store: Pick<InboxCursorStore, 'listItems' | 'countItems' | 'countItemsByProvider' | 'maxReceivedAt' | 'getImapCheckpoint'>;
  readonly poller: Pick<InboundPoller, 'snapshotStatuses' | 'isProviderRunning'>;
}

// ---------------------------------------------------------------------------
// Page cursors
// ---------------------------------------------------------------------------

/**
 * A page cursor is the position of the last item handed out, base64url-encoded
 * so it reads as opaque and callers do not build one by hand. It is NOT the
 * `cursor` field in the answer, that one is the freshness watermark a caller
 * feeds back as `since`. Two different questions ("what is new" vs "the next
 * page down"), so two different values; collapsing them is how a paging client
 * ends up silently re-reading page one forever.
 */
export function encodePageCursor(position: InboxPosition): string {
  return Buffer.from(`${position.receivedAt}:${position.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a page cursor, or refuse. A malformed cursor is a 400 naming the
 * field, never a silently-ignored one: quietly restarting from the top would
 * hand a paging caller the same first page forever and look like data loss
 * further down.
 */
export function decodePageCursor(raw: string): InboxPosition {
  let decoded = '';
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw invalidCursor();
  }
  const split = decoded.indexOf(':');
  if (split <= 0) throw invalidCursor();
  const receivedAt = Number(decoded.slice(0, split));
  const id = decoded.slice(split + 1);
  if (!Number.isFinite(receivedAt) || receivedAt < 0 || id.length === 0) throw invalidCursor();
  return { receivedAt: Math.floor(receivedAt), id };
}

function invalidCursor(): HandlerError {
  return new HandlerError(
    'cursor is not a cursor this method issued; pass back a nextCursor value verbatim, or omit it to start from the newest item',
    'INVALID_ARGUMENT',
    400,
  );
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Normalize the invocation's params.
 *
 * Both sources are read because both are real: the advertised REST path is a
 * GET, so `?limit=10` arrives as a query STRING, while a methodId invoke can
 * carry the same field as a number in the body. A handler that read only the
 * body would answer the default page to every plain-REST caller and look like
 * it was ignoring them.
 */
export function normalizeInboxQuery(
  body: unknown,
  query: Readonly<Record<string, string>> = {},
): InboxListQuery {
  const fromBody = (body ?? {}) as InboxListInput;
  const provider = firstString(query.provider, fromBody.provider);
  const limitRaw = firstNumber(query.limit, fromBody.limit);
  const sinceRaw = firstNumber(query.since, fromBody.since);
  const cursor = firstString(query.cursor, fromBody.cursor);

  const limit = limitRaw === undefined
    ? DEFAULT_LIMIT
    : Math.min(Math.max(1, Math.floor(limitRaw)), MAX_LIMIT);

  return {
    ...(provider ? { providers: [provider] } : {}),
    limit,
    ...(sinceRaw !== undefined && sinceRaw >= 0 ? { since: Math.floor(sinceRaw) } : {}),
    ...(cursor ? { after: decodePageCursor(cursor) } : {}),
  };
}

function firstString(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function firstNumber(...candidates: (string | number | undefined)[]): number | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The aggregate read
// ---------------------------------------------------------------------------

/** Map a daemon-internal item onto the SDK CHANNEL_INBOX_ITEM_SCHEMA wire shape. */
export function toWireItem(item: InboundChannelItem): ChannelInboxItem {
  const wire: ChannelInboxItem = {
    id: item.id,
    provider: item.provider,
    kind: item.kind,
    from: item.fromDigest,
    bodyPreview: item.bodyPreview,
    receivedAt: item.receivedAt,
    unread: item.unread,
  };
  if (item.subjectPreview.length > 0) wire.subject = item.subjectPreview;
  if (item.routeId != null) wire.routeId = item.routeId;
  return wire;
}

/**
 * Merge the mirror into one bounded, paginated page and attach every provider's
 * standing to it.
 *
 * The merge itself is the store's ordering (receivedAt DESC, id ASC across all
 * providers), so items interleave by arrival rather than being grouped by
 * provider, an inbox is a timeline, and each item carries its own `provider`
 * so attribution survives the merge.
 */
export function aggregateInbox(
  sources: InboxAggregatorSources,
  query: InboxListQuery,
): InboxListOutput {
  const { store, poller } = sources;
  const providers = query.providers;

  // One row past the page. `hasMore` then reports what the store actually
  // holds rather than being inferred from "the page came back full", which is
  // wrong exactly when the last page is full.
  const fetched = store.listItems({
    ...(providers ? { providers } : {}),
    ...(query.since !== undefined ? { since: query.since } : {}),
    ...(query.after ? { after: query.after } : {}),
    limit: query.limit + 1,
  });
  const hasMore = fetched.length > query.limit;
  const pageItems = hasMore ? fetched.slice(0, query.limit) : fetched;
  const items = pageItems.map(toWireItem);

  const total = store.countItems(providers, query.since);
  const storedByProvider = store.countItemsByProvider(providers, query.since);
  const pageByProvider = new Map<string, number>();
  for (const item of pageItems) {
    pageByProvider.set(item.provider, (pageByProvider.get(item.provider) ?? 0) + 1);
  }

  const statuses = describeProviders({
    poller, store,
    requested: providers,
    storedByProvider,
    pageByProvider,
  });

  const output: InboxListOutput = {
    items,
    total,
    // Retained spelling of hasMore. Both are set and always agree; the old name
    // is what the already-shipped agent-side reader looks at.
    truncated: hasMore,
    hasMore,
    providers: statuses,
    // An explicit missing configuration is not an outage. An unavailable
    // provider with true OR unknown configuration is reported as an error.
    partial: statuses.some((status) => status.state === 'error'
      || (status.mailboxHistory !== undefined && (status.mailboxHistory.skippedOlderMessages > 0 || status.mailboxProgress === undefined))
      || (status.mailboxProgress?.pendingMessages ?? 0) > 0),
  };

  const watermark = store.maxReceivedAt(providers);
  const nextSince = Math.max(query.since ?? 0, watermark);
  if (nextSince > 0) output.cursor = String(nextSince);

  const last = pageItems[pageItems.length - 1];
  if (hasMore && last) {
    output.nextCursor = encodePageCursor({ receivedAt: last.receivedAt, id: last.id });
  }

  return output;
}

/**
 * Turn the poller's per-provider record into the wire statuses.
 *
 * Every provider the node has an adapter for appears, including ones that
 * contributed nothing and ones nobody has configured, a provider missing from
 * this list would be a hole the caller could not even see.
 */
function describeProviders(input: {
  poller: InboxAggregatorSources['poller'];
  store: InboxAggregatorSources['store'];
  requested: readonly string[] | undefined;
  storedByProvider: Map<string, number>;
  pageByProvider: Map<string, number>;
}): ChannelInboxProviderStatus[] {
  const { poller, store, requested, storedByProvider, pageByProvider } = input;
  const known = poller.snapshotStatuses(requested);

  // A `?provider=` filter naming something this node has no adapter for gets an
  // empty list and no status, which reads as "we have nothing", so it is
  // reported explicitly instead.
  const reported = new Set(known.map((status) => status.id));
  const unknownRequested = (requested ?? []).filter((id) => !reported.has(id));

  const out: ChannelInboxProviderStatus[] = known.map((status) => {
    const storedCount = storedByProvider.get(status.id) ?? 0;
    const wire: ChannelInboxProviderStatus = {
      provider: status.id,
      state: wireState(status, storedCount),
      itemCount: pageByProvider.get(status.id) ?? 0,
      storedCount,
      syncing: poller.isProviderRunning(status.id),
    };
    const checkpoint = store.getImapCheckpoint?.(status.id);
    if (checkpoint) wire.mailboxHistory = { ...checkpoint.history, uidValidity: checkpoint.uidValidity };
    if (checkpoint && status.mailboxProgress?.uidValidity === checkpoint.uidValidity) wire.mailboxProgress = { ...status.mailboxProgress };
    if (status.configured !== undefined) wire.configured = status.configured;
    if (status.lastPolledAt !== undefined) wire.lastSyncAt = status.lastPolledAt;
    // The error belongs to the `error` state only. Carrying the "missing
    // credential" text on an `unconfigured` entry would read as a fault, and
    // it is not one.
    if (wire.state === 'error' && status.error !== undefined) wire.error = status.error;
    return wire;
  });

  for (const id of unknownRequested) {
    out.push({
      provider: id,
      state: 'unconfigured',
      itemCount: 0,
      storedCount: storedByProvider.get(id) ?? 0,
      configured: false,
      syncing: false,
    });
  }

  return out;
}

/**
 * Map the poller's internal state onto the wire vocabulary.
 *
 * The internal 'unavailable' covers two situations the wire deliberately keeps
 * apart, nothing configured, versus configured and failing, because a caller
 * does something different about each.
 *
 * ready-vs-empty is decided by the MIRROR, not by the last poll. The poller's
 * 'ready' means "that fetch brought something in", which goes back to 'empty'
 * on the next quiet tick even though the items are still sitting there; a
 * reader of this verb is asking whether this provider has anything to show,
 * so the stored count is what answers it.
 */
function wireState(
  status: ProviderStatus,
  storedCount: number,
): ChannelInboxProviderStatus['state'] {
  if (!status.polled || status.state === 'pending') return 'pending';
  if (status.state === 'unavailable') {
    return status.configured === false ? 'unconfigured' : 'error';
  }
  return storedCount > 0 ? 'ready' : 'empty';
}
