/**
 * unified-inbox.ts
 *
 * Agent-side unified inbox read-model. Aggregates four daemon-exposed sources:
 *
 *   1. /api/deliveries          , outbound delivery attempts (status / failures)
 *   2. /api/control-plane/messages, surface messages visible to the TUI client
 *   3. /api/routes/bindings     , live route binding continuity records
 *   4. channels.inbox.list      , provider-specific inbound messages
 *
 * The first three arrive already fetched, in an `AgentWorkspaceChannelTriage`.
 * The fourth is fetched here, by `fetchInboundChannelFeed`, because it is a
 * method call rather than one of triage's routes.
 *
 * When that call does not produce a feed, the reason says what actually
 * happened, the daemon's own answer, classified. It does not say the contract
 * is unpublished, because it is published: an inbox reporting a cause it did
 * not observe sends whoever reads it to fix the wrong thing.
 */

import type { AgentWorkspaceChannelTriage } from '../input/agent-workspace-channel-triage.ts';
import type { DaemonInvokeFailureKind, DaemonOperatorInvoke } from './daemon-operator-client.ts';
import { UNKNOWN_PRINCIPAL_LABEL } from './principal-attribution.ts';

/** The daemon method that serves provider inbound feeds. */
export const CHANNEL_INBOX_LIST_METHOD = 'channels.inbox.list';

// ---------------------------------------------------------------------------
// Item kinds
// ---------------------------------------------------------------------------

/** An outbound delivery attempt reported by /api/deliveries. */
export interface UnifiedInboxDeliveryItem {
  readonly kind: 'delivery';
  readonly id: string;
  readonly runId: string;
  readonly jobId: string;
  readonly status: 'queued' | 'sending' | 'completed' | 'failed' | 'dead_lettered' | string;
  readonly target: UnifiedInboxTarget;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly responseId?: string;
  /** Inspect route for the daemon UI / model tool. */
  readonly inspectRoute: string;
}

/** A control-plane surface message reported by /api/control-plane/messages. */
export interface UnifiedInboxSurfaceMessageItem {
  readonly kind: 'surface_message';
  readonly id: string;
  readonly surface: string;
  readonly level: 'info' | 'warning' | 'error' | string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly routeId: string | null;
  readonly surfaceId: string | null;
  readonly clientId: string | null;
  readonly attachmentCount: number;
  readonly createdAt: number | null;
}

/** A route binding reported by /api/routes/bindings. */
export interface UnifiedInboxRouteBindingItem {
  readonly kind: 'route_binding';
  readonly id: string;
  readonly bindingKind: string;
  readonly surfaceKind: string;
  readonly surfaceId: string | null;
  /** External id is digested, never the raw identifier. */
  readonly externalIdDigest: string | null;
  /** Resolved sender principal, when the channel identity maps to one. Never a guess. */
  readonly principal: { readonly id: string; readonly name: string; readonly kind: string } | null;
  /** Human-facing sender label, the resolved principal's "name (id)", or "unknown principal". */
  readonly principalLabel: string;
  readonly sessionPolicy: string | null;
  readonly threadPolicy: string | null;
  readonly deliveryGuarantee: string | null;
  readonly lastSeenAt: number | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly jobId: string | null;
}

/**
 * An inbound message reported by `channels.inbox.list`.
 *
 * The sender is carried as the daemon reports it rather than digested. The
 * route-binding item above digests its external id because that id is a
 * third-party correlation key nobody asked to read; this is the operator's own
 * inbox being shown back to the operator, where a sender they cannot identify
 * is not an inbox.
 */
export interface UnifiedInboxInboundMessageItem {
  readonly kind: 'inbound_message';
  readonly id: string;
  readonly provider: string;
  /** The provider's own kind for this item (dm, channel, thread, email, …). */
  readonly messageKind: string;
  readonly from: string;
  readonly fromAddress: string | null;
  readonly subject: string | null;
  readonly bodyPreview: string;
  readonly receivedAt: number;
  readonly unread: boolean;
  readonly routeId: string | null;
  readonly threadId: string | null;
  readonly attachmentCount: number;
}

export type UnifiedInboxItem =
  | UnifiedInboxDeliveryItem
  | UnifiedInboxSurfaceMessageItem
  | UnifiedInboxRouteBindingItem
  | UnifiedInboxInboundMessageItem;

export interface UnifiedInboxTarget {
  readonly kind: string;
  readonly surfaceKind: string | null;
  readonly routeId: string | null;
  readonly label: string | null;
  readonly address?: string;
}

// ---------------------------------------------------------------------------
// Aggregate model
// ---------------------------------------------------------------------------

export type UnifiedInboxSourceState = 'ready' | 'empty' | 'unavailable';

export interface UnifiedInboxSource {
  readonly name: string;
  readonly route: string;
  readonly state: UnifiedInboxSourceState;
  readonly itemCount: number;
  readonly error?: string;
}

export interface UnifiedInboxSummary {
  readonly totalItems: number;
  readonly deliveryItems: number;
  readonly surfaceMessageItems: number;
  readonly routeBindingItems: number;
  readonly inboundMessageItems: number;
  readonly attentionCount: number;
  readonly failureCount: number;
}

/**
 * Why the inbound feed is not here, when it is not.
 *
 * Each value names something that was actually observed:
 *
 *  `not_attempted`  , no connected-host caller was supplied, so nothing was
 *                      asked and nothing is claimed.
 *  `auth_required`  , no operator token, or the daemon rejected the one there.
 *  `daemon_unreachable`, the call did not complete.
 *  `method_unavailable`, the daemon answered, and its answer was that it does
 *                      not serve this method. This is what the live platform
 *                      says today: `channels.inbox.list` is cataloged with
 *                      `invokable: false` and no route serves its advertised
 *                      path, so the call returns rather than hanging.
 *  `daemon_error`   , it answered with something else.
 */
export type InboundChannelFeedUnavailableReason =
  | 'not_attempted'
  | 'auth_required'
  | 'daemon_unreachable'
  | 'method_unavailable'
  | 'daemon_error';

export type InboundChannelFeedState =
  | {
      readonly available: false;
      readonly reason: InboundChannelFeedUnavailableReason;
      readonly methodId: typeof CHANNEL_INBOX_LIST_METHOD;
      /** What the daemon said, verbatim, when it said anything. */
      readonly detail: string;
    }
  | {
      readonly available: true;
      readonly methodId: typeof CHANNEL_INBOX_LIST_METHOD;
      readonly items: readonly UnifiedInboxInboundMessageItem[];
      readonly total: number;
      readonly truncated: boolean;
    };

export interface UnifiedInbox {
  readonly mode: 'unified_inbox';
  readonly status: 'ready' | 'attention' | 'blocked';
  readonly summary: UnifiedInboxSummary;
  readonly items: readonly UnifiedInboxItem[];
  readonly sources: readonly UnifiedInboxSource[];
  /** Outbound delivery attempts. Subset of items where kind === 'delivery'. */
  readonly deliveryItems: readonly UnifiedInboxDeliveryItem[];
  /** Control-plane surface messages. Subset of items where kind === 'surface_message'. */
  readonly surfaceMessageItems: readonly UnifiedInboxSurfaceMessageItem[];
  /** Route binding continuity. Subset of items where kind === 'route_binding'. */
  readonly routeBindingItems: readonly UnifiedInboxRouteBindingItem[];
  /** Provider inbound messages. Subset of items where kind === 'inbound_message'. */
  readonly inboundMessageItems: readonly UnifiedInboxInboundMessageItem[];
  /** The inbound feed, or the observed reason there is none. */
  readonly inboundChannelFeed: InboundChannelFeedState;
  readonly policy: string;
}

// ---------------------------------------------------------------------------
// Internal helpers, converting triage sub-records to typed items
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringOrNull(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value ? value : null;
}

function toDeliveryItem(raw: Record<string, unknown>): UnifiedInboxDeliveryItem {
  const target = isRecord(raw.target) ? raw.target : {};
  return {
    kind: 'delivery',
    id: readString(raw, 'id', 'delivery'),
    runId: readString(raw, 'runId'),
    jobId: readString(raw, 'jobId'),
    status: readString(raw, 'status', 'unknown'),
    target: {
      kind: readString(target, 'kind', 'unknown'),
      surfaceKind: readStringOrNull(target, 'surfaceKind'),
      routeId: readStringOrNull(target, 'routeId'),
      label: readStringOrNull(target, 'label'),
      ...(typeof target.address === 'string' && target.address ? { address: target.address } : {}),
    },
    ...(readNumber(raw, 'startedAt') !== null ? { startedAt: readNumber(raw, 'startedAt') as number } : {}),
    ...(readNumber(raw, 'endedAt') !== null ? { endedAt: readNumber(raw, 'endedAt') as number } : {}),
    ...(readString(raw, 'error') ? { error: readString(raw, 'error') } : {}),
    ...(readString(raw, 'responseId') ? { responseId: readString(raw, 'responseId') } : {}),
    inspectRoute: readString(raw, 'inspectRoute', `/api/deliveries/${encodeURIComponent(readString(raw, 'id', 'delivery'))}`),
  };
}

function toSurfaceMessageItem(raw: Record<string, unknown>): UnifiedInboxSurfaceMessageItem {
  return {
    kind: 'surface_message',
    id: readString(raw, 'id', 'message'),
    surface: readString(raw, 'surface', 'unknown'),
    level: readString(raw, 'level', 'info'),
    title: readString(raw, 'title'),
    bodyPreview: readString(raw, 'bodyPreview'),
    routeId: readStringOrNull(raw, 'routeId'),
    surfaceId: readStringOrNull(raw, 'surfaceId'),
    clientId: readStringOrNull(raw, 'clientId'),
    attachmentCount: typeof raw.attachmentCount === 'number' ? raw.attachmentCount : 0,
    createdAt: readNumber(raw, 'createdAt'),
  };
}

function toPrincipalOrNull(raw: Record<string, unknown>): { readonly id: string; readonly name: string; readonly kind: string } | null {
  const principalRaw = isRecord(raw.principal) ? raw.principal : null;
  if (!principalRaw) return null;
  const id = readString(principalRaw, 'id');
  const name = readString(principalRaw, 'name');
  const kind = readString(principalRaw, 'kind');
  return id && name && kind ? { id, name, kind } : null;
}

function toRouteBindingItem(raw: Record<string, unknown>): UnifiedInboxRouteBindingItem {
  return {
    kind: 'route_binding',
    id: readString(raw, 'id', 'binding'),
    bindingKind: readString(raw, 'kind', 'unknown'),
    surfaceKind: readString(raw, 'surfaceKind', 'unknown'),
    surfaceId: readStringOrNull(raw, 'surfaceId'),
    externalIdDigest: readStringOrNull(raw, 'externalIdDigest'),
    principal: toPrincipalOrNull(raw),
    principalLabel: readString(raw, 'principalLabel', UNKNOWN_PRINCIPAL_LABEL),
    sessionPolicy: readStringOrNull(raw, 'sessionPolicy'),
    threadPolicy: readStringOrNull(raw, 'threadPolicy'),
    deliveryGuarantee: readStringOrNull(raw, 'deliveryGuarantee'),
    lastSeenAt: readNumber(raw, 'lastSeenAt'),
    sessionId: readStringOrNull(raw, 'sessionId'),
    runId: readStringOrNull(raw, 'runId'),
    jobId: readStringOrNull(raw, 'jobId'),
  };
}

function toInboundMessageItem(raw: Record<string, unknown>): UnifiedInboxInboundMessageItem {
  return {
    kind: 'inbound_message',
    id: readString(raw, 'id', 'inbound'),
    provider: readString(raw, 'provider', 'unknown'),
    messageKind: readString(raw, 'kind', 'unknown'),
    from: readString(raw, 'from', UNKNOWN_PRINCIPAL_LABEL),
    fromAddress: readStringOrNull(raw, 'fromAddress'),
    subject: readStringOrNull(raw, 'subject'),
    bodyPreview: readString(raw, 'bodyPreview'),
    receivedAt: readNumber(raw, 'receivedAt') ?? 0,
    unread: raw.unread === true,
    routeId: readStringOrNull(raw, 'routeId'),
    threadId: readStringOrNull(raw, 'threadId'),
    attachmentCount: typeof raw.attachmentCount === 'number' ? raw.attachmentCount : 0,
  };
}

/** Map a transport failure onto the reason an operator should act on. */
function inboundFailureReason(kind: DaemonInvokeFailureKind): InboundChannelFeedUnavailableReason {
  if (kind === 'auth_required') return 'auth_required';
  if (kind === 'connected_host_unavailable') return 'daemon_unreachable';
  if (kind === 'connected_host_route_unavailable') return 'method_unavailable';
  return 'daemon_error';
}

/**
 * Ask the daemon for the provider inbound feed.
 *
 * Separate from `aggregateUnifiedInbox` so that function stays a pure
 * transformation of things already fetched, the property its tests rely on.
 * A caller with no daemon to ask simply does not call this, and the aggregate
 * says `not_attempted` rather than inventing a cause.
 */
export async function fetchInboundChannelFeed(
  invoke: DaemonOperatorInvoke,
  options: { readonly provider?: string; readonly limit?: number; readonly since?: number } = {},
): Promise<InboundChannelFeedState> {
  const result = await invoke(CHANNEL_INBOX_LIST_METHOD, {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
    ...(typeof options.since === 'number' ? { since: options.since } : {}),
  });
  if (!result.ok) {
    return {
      available: false,
      reason: inboundFailureReason(result.kind),
      methodId: CHANNEL_INBOX_LIST_METHOD,
      detail: result.error,
    };
  }
  if (!isRecord(result.body) || !Array.isArray(result.body.items)) {
    return {
      available: false,
      reason: 'daemon_error',
      methodId: CHANNEL_INBOX_LIST_METHOD,
      detail: `${CHANNEL_INBOX_LIST_METHOD} answered without an items array`,
    };
  }
  const items = (result.body.items as unknown[]).filter(isRecord).map(toInboundMessageItem);
  return {
    available: true,
    methodId: CHANNEL_INBOX_LIST_METHOD,
    items,
    total: typeof result.body.total === 'number' ? result.body.total : items.length,
    truncated: result.body.truncated === true,
  };
}

const DELIVERY_ATTENTION_STATUSES = new Set(['failed', 'dead_lettered', 'pending', 'sending']);

const INBOUND_FEED_NOT_ATTEMPTED: InboundChannelFeedState = {
  available: false,
  reason: 'not_attempted',
  methodId: CHANNEL_INBOX_LIST_METHOD,
  detail: 'no connected-host caller was supplied, so the daemon was not asked for an inbound feed',
};

// ---------------------------------------------------------------------------
// Public aggregation API
// ---------------------------------------------------------------------------

/**
 * Build a UnifiedInbox from an already-fetched AgentWorkspaceChannelTriage.
 *
 * This is intentionally a pure transformation, it does not perform any I/O.
 * The caller (command handler or tool) is responsible for calling
 * `buildAgentWorkspaceChannelTriage` first.
 */
export function aggregateUnifiedInbox(
  triage: AgentWorkspaceChannelTriage,
  options: {
    readonly limit?: number;
    /** The feed a caller already fetched. Absent means it never asked. */
    readonly inboundChannelFeed?: InboundChannelFeedState;
  } = {},
): UnifiedInbox {
  const limit = typeof options.limit === 'number' && options.limit > 0 ? Math.min(options.limit, 200) : 50;
  const inboundChannelFeed = options.inboundChannelFeed ?? INBOUND_FEED_NOT_ATTEMPTED;
  const inboundMessageItems = inboundChannelFeed.available
    ? inboundChannelFeed.items.slice(0, limit)
    : [];

  // --- Delivery items ---
  const deliveriesSection = triage.deliveries;
  const rawAttempts = Array.isArray(deliveriesSection.attempts)
    ? (deliveriesSection.attempts as unknown[]).filter(isRecord)
    : [];
  const deliveryItems = rawAttempts.slice(0, limit).map(toDeliveryItem);
  const deliveriesState: UnifiedInboxSourceState = deliveriesSection.state === 'unavailable'
    ? 'unavailable'
    : deliveriesSection.state === 'empty' || deliveryItems.length === 0
      ? 'empty'
      : 'ready';

  // --- Surface message items ---
  const messagesSection = triage.surfaceMessages;
  const rawMessages = Array.isArray(messagesSection.messages)
    ? (messagesSection.messages as unknown[]).filter(isRecord)
    : [];
  const surfaceMessageItems = rawMessages.slice(0, limit).map(toSurfaceMessageItem);
  const messagesState: UnifiedInboxSourceState = messagesSection.state === 'unavailable'
    ? 'unavailable'
    : messagesSection.state === 'empty' || surfaceMessageItems.length === 0
      ? 'empty'
      : 'ready';

  // --- Route binding items ---
  const bindingsSection = triage.routeBindings;
  const rawBindings = Array.isArray(bindingsSection.bindings)
    ? (bindingsSection.bindings as unknown[]).filter(isRecord)
    : [];
  const routeBindingItems = rawBindings.slice(0, limit).map(toRouteBindingItem);
  const bindingsState: UnifiedInboxSourceState = bindingsSection.state === 'unavailable'
    ? 'unavailable'
    : bindingsSection.state === 'empty' || routeBindingItems.length === 0
      ? 'empty'
      : 'ready';

  const items: UnifiedInboxItem[] = [
    ...deliveryItems,
    ...surfaceMessageItems,
    ...routeBindingItems,
    ...inboundMessageItems,
  ];

  const attentionCount = deliveryItems.filter((item) => DELIVERY_ATTENTION_STATUSES.has(item.status)).length;
  const failureCount = deliveryItems.filter((item) => item.status === 'failed' || item.status === 'dead_lettered').length;

  const sources: UnifiedInboxSource[] = [
    {
      name: 'deliveries',
      route: '/api/deliveries',
      state: deliveriesState,
      itemCount: deliveryItems.length,
      ...(deliveriesState === 'unavailable' && typeof deliveriesSection.message === 'string'
        ? { error: deliveriesSection.message as string }
        : {}),
    },
    {
      name: 'surface_messages',
      route: '/api/control-plane/messages',
      state: messagesState,
      itemCount: surfaceMessageItems.length,
      ...(messagesState === 'unavailable' && typeof messagesSection.message === 'string'
        ? { error: messagesSection.message as string }
        : {}),
    },
    {
      name: 'route_bindings',
      route: '/api/routes/bindings',
      state: bindingsState,
      itemCount: routeBindingItems.length,
      ...(bindingsState === 'unavailable' && typeof bindingsSection.message === 'string'
        ? { error: bindingsSection.message as string }
        : {}),
    },
    {
      name: 'inbound_messages',
      route: CHANNEL_INBOX_LIST_METHOD,
      state: inboundChannelFeed.available
        ? (inboundMessageItems.length === 0 ? 'empty' : 'ready')
        : 'unavailable',
      itemCount: inboundMessageItems.length,
      ...(inboundChannelFeed.available ? {} : { error: inboundChannelFeed.detail }),
    },
  ];

  const blockedSources = sources.filter((s) => s.state === 'unavailable').length;
  const overallStatus: UnifiedInbox['status'] =
    blockedSources === sources.length ? 'blocked' : attentionCount > 0 ? 'attention' : 'ready';

  return {
    mode: 'unified_inbox',
    status: overallStatus,
    summary: {
      totalItems: items.length,
      deliveryItems: deliveryItems.length,
      surfaceMessageItems: surfaceMessageItems.length,
      routeBindingItems: routeBindingItems.length,
      inboundMessageItems: inboundMessageItems.length,
      attentionCount,
      failureCount,
    },
    items,
    sources,
    deliveryItems,
    surfaceMessageItems,
    routeBindingItems,
    inboundMessageItems,
    inboundChannelFeed,
    policy: inboundChannelFeed.available
      ? 'Read-only unified inbox. Aggregates daemon-exposed delivery attempts, control-plane surface messages, route bindings, and provider inbound messages.'
      : 'Read-only unified inbox. Aggregates daemon-exposed delivery attempts, control-plane surface messages, and route bindings. '
        + `The provider inbound feed is absent: ${inboundChannelFeed.detail}`,
  };
}

/**
 * Format a UnifiedInbox for human-readable output.
 */
export function formatUnifiedInbox(inbox: UnifiedInbox): string {
  const { summary, sources, deliveryItems, surfaceMessageItems, routeBindingItems, inboundMessageItems } = inbox;
  const feed = inbox.inboundChannelFeed;
  const lines: string[] = [
    'Unified Inbox',
    `  status: ${inbox.status}`,
    `  items: ${summary.totalItems} (deliveries: ${summary.deliveryItems}, surface messages: ${summary.surfaceMessageItems}, route bindings: ${summary.routeBindingItems}, inbound: ${summary.inboundMessageItems})`,
    `  attention: ${summary.attentionCount}  failures: ${summary.failureCount}`,
    `  inbound channel feed: ${feed.available
      ? `${feed.total} message(s)${feed.truncated ? ', truncated' : ''} via ${feed.methodId}`
      : `unavailable (${feed.reason}), ${feed.detail}`}`,
    `  policy: ${inbox.policy}`,
    '',
    '  Sources',
  ];

  for (const source of sources) {
    const errorPart = source.error ? ` error=${source.error}` : '';
    lines.push(`  ${source.name}: ${source.state} (${source.itemCount} items) route=${source.route}${errorPart}`);
  }

  if (deliveryItems.length > 0) {
    lines.push('', '  Delivery Attempts');
    for (const item of deliveryItems.slice(0, 10)) {
      const targetDesc = [item.target.surfaceKind, item.target.routeId, item.target.label].filter(Boolean).join('/');
      lines.push(`  - [${item.status}] ${item.id} target=${targetDesc || item.target.kind}${item.error ? ` err=${item.error}` : ''}`);
    }
  }

  if (surfaceMessageItems.length > 0) {
    lines.push('', '  Surface Messages');
    for (const item of surfaceMessageItems.slice(0, 10)) {
      lines.push(`  - [${item.level}] ${item.surface}: ${item.title}`);
    }
  }

  if (routeBindingItems.length > 0) {
    lines.push('', '  Route Bindings');
    for (const item of routeBindingItems.slice(0, 10)) {
      lines.push(`  - ${item.id}: ${item.surfaceKind} ${item.bindingKind} ext=${item.externalIdDigest ?? 'none'} sender=${item.principalLabel}`);
    }
  }

  if (inboundMessageItems.length > 0) {
    lines.push('', '  Inbound Messages');
    for (const item of inboundMessageItems.slice(0, 10)) {
      const heading = item.subject ?? item.bodyPreview.slice(0, 60);
      lines.push(`  - [${item.provider}${item.unread ? ' unread' : ''}] ${item.from}: ${heading}`);
    }
  }

  return lines.join('\n');
}
