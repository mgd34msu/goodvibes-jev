import type { CommandContext } from '../input/command-registry.ts';
import {
  aggregateUnifiedInbox,
  fetchInboundChannelFeed,
  formatUnifiedInbox,
} from '../agent/unified-inbox.ts';
import {
  listDrafts,
  getDraft,
  saveDraft,
  queueDraftToSend,
  markDraftSent,
  markDraftFailed,
  fetchDaemonDrafts,
  mergeDraftViews,
  formatChannelDraftList,
  formatChannelDraft,
} from '../agent/channel-draft.ts';
import {
  listChannelProfileRoutes,
  getProfileForChannel,
  assignChannelToProfile,
  removeChannelProfileRoute,
  formatChannelProfileRoutes,
  CHANNEL_ROUTING_ASSIGN_METHOD,
} from '../agent/channel-profile-routing.ts';
import { buildAgentWorkspaceChannelTriage } from '../input/agent-workspace-channel-triage.ts';
import { deliverAgentChannelMessage } from '../agent/channel-delivery.ts';
import { requireConfirmedAction } from './agent-harness-tool-utils.ts';
import {
  createDaemonOperatorInvoke,
  resolveDaemonOperatorConnection,
  type DaemonOperatorInvoke,
} from '../agent/daemon-operator-client.ts';

/**
 * The connected-host caller for the comms modes, or null when this shell has
 * no platform to resolve one from.
 *
 * Null is not a failure state, it is a shell (a test harness, an early boot)
 * with no daemon address to call. The stores treat it as "not offered" rather
 * than as a daemon that refused, because those are different facts.
 */
function commsDaemonInvoke(context: CommandContext): DaemonOperatorInvoke | null {
  const configManager = context.platform?.configManager;
  const homeDirectory = context.workspace?.shellPaths?.homeDirectory;
  if (!configManager || !homeDirectory) return null;
  return createDaemonOperatorInvoke(() =>
    resolveDaemonOperatorConnection(configManager, homeDirectory));
}

/** Redact a draft's webhook (which can embed a token) in any structured display payload. */
function redactDraftWebhook<T extends { readonly webhook?: string }>(draft: T): T {
  return draft.webhook ? { ...draft, webhook: '[redacted]' } : draft;
}

export interface AgentHarnessCommsArgs {
  readonly draftId?: unknown;
  readonly draftStatus?: unknown;
  readonly draftTitle?: unknown;
  readonly draftMessage?: unknown;
  readonly draftChannel?: unknown;
  readonly draftRoute?: unknown;
  readonly draftWebhook?: unknown;
  readonly draftLink?: unknown;
  readonly draftTags?: unknown;
  readonly surfaceKind?: unknown;
  readonly profileId?: unknown;
  readonly routeLabel?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptString(value: unknown): string | undefined {
  const s = readString(value);
  return s || undefined;
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const arr = value.filter((v) => typeof v === 'string').map((v) => (v as string).trim()).filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}

// ---------------------------------------------------------------------------
// INBOX, unified_inbox
// ---------------------------------------------------------------------------

export async function unifiedInboxSummary(
  context: CommandContext,
  args: AgentHarnessCommsArgs,
): Promise<Record<string, unknown>> {
  const triage = await buildAgentWorkspaceChannelTriage(context, {});
  const limit = readLimit(args.limit, 50);
  const invoke = commsDaemonInvoke(context);
  const inboundChannelFeed = invoke
    ? await fetchInboundChannelFeed(invoke, { limit })
    : undefined;
  const inbox = aggregateUnifiedInbox(triage, {
    limit,
    ...(inboundChannelFeed ? { inboundChannelFeed } : {}),
  });
  return {
    mode: 'unified_inbox',
    status: inbox.status,
    summary: inbox.summary,
    items: inbox.items,
    sources: inbox.sources,
    deliveryItems: inbox.deliveryItems,
    surfaceMessageItems: inbox.surfaceMessageItems,
    routeBindingItems: inbox.routeBindingItems,
    inboundMessageItems: inbox.inboundMessageItems,
    inboundChannelFeed: inbox.inboundChannelFeed,
    formatted: formatUnifiedInbox(inbox),
    policy: inbox.policy,
  };
}

// ---------------------------------------------------------------------------
// DRAFTS, channel_drafts (read)
// ---------------------------------------------------------------------------

export async function channelDraftsSummary(
  context: CommandContext,
  args: AgentHarnessCommsArgs,
): Promise<Record<string, unknown>> {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return {
      mode: 'channel_drafts',
      status: 'unavailable',
      drafts: [],
      policy: 'Draft management requires an active Agent workspace with shell path context.',
    };
  }
  const draftId = readOptString(args.draftId || args.target || args.query);
  if (draftId) {
    const draft = getDraft(shellPaths, draftId);
    if (!draft) {
      return {
        mode: 'channel_drafts',
        status: 'not_found',
        draftId,
        policy: 'Draft not found. Use channel_drafts without draftId to list all drafts.',
      };
    }
    return {
      mode: 'channel_drafts',
      status: 'found',
      draft: redactDraftWebhook(draft),
      formatted: formatChannelDraft(draft),
      routes: {
        send: 'agent_harness mode:"channel_draft_send" draftId:"' + draft.id + '"',
      },
      policy: 'Read-only draft inspection. Use channel_draft_send to queue and deliver.',
    };
  }
  const statusFilter = readOptString(args.draftStatus) as 'draft' | 'queued' | 'sent' | 'failed' | undefined;
  const limit = readLimit(args.limit, 50);
  const snapshot = listDrafts(shellPaths, { status: statusFilter, limit });

  // The daemon's store is what the other surfaces are looking at, so the list
  // an operator sees here is both stores merged. A daemon that will not serve
  // them is reported rather than silently reducing this to the local view.
  const invoke = commsDaemonInvoke(context);
  const daemonResult = invoke
    ? await fetchDaemonDrafts(invoke, { ...(statusFilter ? { status: statusFilter } : {}), limit })
    : null;
  const daemonDrafts = daemonResult && 'drafts' in daemonResult ? daemonResult.drafts : [];
  const merged = mergeDraftViews(daemonDrafts, snapshot.drafts).slice(0, limit);

  return {
    mode: 'channel_drafts',
    status: merged.length > 0 ? 'ready' : 'empty',
    path: snapshot.path,
    total: merged.length,
    drafts: merged.map(redactDraftWebhook),
    formatted: formatChannelDraftList({ ...snapshot, drafts: merged }),
    daemon: daemonResult === null
      ? { available: false, reason: 'not_attempted' }
      : 'drafts' in daemonResult
        ? { available: true, count: daemonResult.drafts.length }
        : { available: false, reason: daemonResult.kind, detail: daemonResult.error },
    routes: {
      save: 'agent_harness mode:"channel_draft_save"',
      send: 'agent_harness mode:"channel_draft_send" draftId:"<id>"',
    },
    ...(snapshot.parseError ? { parseError: snapshot.parseError } : {}),
    policy: daemonResult !== null && 'drafts' in daemonResult
      ? 'Read-only draft list, merged from the daemon store and the local mirror. Use channel_draft_save to create or update. Use channel_draft_send to deliver.'
      : 'Read-only draft list from the local mirror; the daemon store could not be read, so drafts composed on other surfaces are not shown. Use channel_draft_save to create or update. Use channel_draft_send to deliver.',
  };
}

// ---------------------------------------------------------------------------
// DRAFTS, channel_draft_save (effect)
// ---------------------------------------------------------------------------

export async function channelDraftSaveHandoff(
  context: CommandContext,
  args: AgentHarnessCommsArgs,
): Promise<Record<string, unknown> | string> {
  const confirmationError = requireConfirmedAction(args, 'Channel draft save');
  if (confirmationError) return confirmationError;

  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return 'Channel draft save requires an active workspace.';

  const message = readString(args.draftMessage);
  if (!message) return 'channel_draft_save requires draftMessage.';

  const invoke = commsDaemonInvoke(context);
  const result = await saveDraft(
    shellPaths,
    {
      id: readOptString(args.draftId),
      message,
      title: readOptString(args.draftTitle),
      channel: readOptString(args.draftChannel),
      route: readOptString(args.draftRoute),
      webhook: readOptString(args.draftWebhook),
      link: readOptString(args.draftLink),
      tags: readStringArray(args.draftTags),
    },
    invoke ? { invoke } : {},
  );

  return {
    mode: 'channel_draft_save',
    draft: redactDraftWebhook(result.draft),
    path: result.path,
    daemon: result.daemon,
    routes: {
      send: 'agent_harness mode:"channel_draft_send" draftId:"' + result.draft.id + '"',
      list: 'agent_harness mode:"channel_drafts"',
    },
    policy: result.daemon.synced
      ? 'Draft held by the daemon and mirrored locally, so it is visible on every surface. Use channel_draft_send with confirm:true and explicitUserRequest to deliver.'
      : `Draft saved locally; the daemon does not hold it yet (${result.daemon.error}), so other surfaces cannot see it. Use channel_draft_send with confirm:true and explicitUserRequest to deliver.`,
  };
}

// ---------------------------------------------------------------------------
// DRAFTS, channel_draft_send (effect)
// ---------------------------------------------------------------------------

export async function channelDraftSendHandoff(
  context: CommandContext,
  args: AgentHarnessCommsArgs,
): Promise<Record<string, unknown> | string> {
  const confirmationError = requireConfirmedAction(args, 'Channel draft send');
  if (confirmationError) return confirmationError;

  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return 'Channel draft send requires an active workspace.';

  const draftId = readString(args.draftId || args.target);
  if (!draftId) return 'channel_draft_send requires draftId.';

  const router = context.platform?.channelDeliveryRouter;
  if (!router) {
    return 'Channel delivery router is not available. Ensure the Agent is connected to a channel delivery service.';
  }

  const invoke = commsDaemonInvoke(context);
  let queueResult: Awaited<ReturnType<typeof queueDraftToSend>>;
  try {
    queueResult = await queueDraftToSend(shellPaths, draftId, invoke ? { invoke } : {});
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  try {
    const result = await deliverAgentChannelMessage(router, queueResult.deliveryInput);
    const sentDraft = markDraftSent(shellPaths, draftId, result.responseId);
    return {
      mode: 'channel_draft_send',
      status: 'sent',
      draftId,
      responseId: result.responseId ?? null,
      draft: sentDraft ? redactDraftWebhook(sentDraft) : sentDraft,
      delivery: {
        message: result.message,
        title: result.title,
        target: result.target,
        strategyCount: result.strategyCount,
      },
      policy: 'Draft delivered and marked sent. Receipt recorded via delivery path.',
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      markDraftFailed(shellPaths, draftId, errorMessage);
    } catch {
      // best-effort
    }
    return {
      mode: 'channel_draft_send',
      status: 'failed',
      draftId,
      error: errorMessage,
      policy: 'Delivery failed. Draft marked failed. Retry with channel_draft_send or use agent_channel_send directly.',
    };
  }
}

// ---------------------------------------------------------------------------
// ROUTING, channel_routing (read)
// ---------------------------------------------------------------------------

export function channelRoutingSummary(
  context: CommandContext,
  args: AgentHarnessCommsArgs,
): Record<string, unknown> {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return {
      mode: 'channel_routing',
      status: 'unavailable',
      routes: [],
      policy: 'Channel routing requires an active Agent workspace with shell path context.',
    };
  }
  const surfaceKind = readOptString(args.surfaceKind || args.target || args.query);
  if (surfaceKind) {
    const profileId = getProfileForChannel(shellPaths, surfaceKind, readOptString(args.draftRoute));
    const snapshot = listChannelProfileRoutes(shellPaths, { surfaceKind });
    return {
      mode: 'channel_routing',
      status: snapshot.exists ? 'ready' : 'empty',
      surfaceKind,
      resolvedProfileId: profileId,
      routes: snapshot.routes,
      formatted: formatChannelProfileRoutes(snapshot),
      policy: 'Read-only routing inspection. Use channel_routing_assign to add or update a profile assignment.',
    };
  }
  const limit = readLimit(args.limit, 50);
  const snapshot = listChannelProfileRoutes(shellPaths);
  const limited = { ...snapshot, routes: snapshot.routes.slice(0, limit) };
  return {
    mode: 'channel_routing',
    status: snapshot.exists ? 'ready' : 'empty',
    path: snapshot.path,
    total: snapshot.routes.length,
    returned: limited.routes.length,
    routes: limited.routes,
    formatted: formatChannelProfileRoutes(limited),
    assignRoute: 'agent_harness mode:"channel_routing_assign"',
    removeRoute: 'agent_harness mode:"channel_routing_remove"',
    ...(snapshot.parseError ? { parseError: snapshot.parseError } : {}),
    policy: 'Read-only routing list. Assignments are local-only until daemon publishes channels.routing.assign.',
  };
}

// ---------------------------------------------------------------------------
// ROUTING, channel_routing_assign (effect)
// ---------------------------------------------------------------------------

export async function channelRoutingAssignHandoff(
  context: CommandContext,
  args: AgentHarnessCommsArgs,
): Promise<Record<string, unknown> | string> {
  const confirmationError = requireConfirmedAction(args, 'Channel routing assignment');
  if (confirmationError) return confirmationError;

  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return 'Channel routing assign requires an active workspace.';

  const surfaceKind = readString(args.surfaceKind);
  if (!surfaceKind) return 'channel_routing_assign requires surfaceKind.';
  const profileId = readString(args.profileId);
  if (!profileId) return 'channel_routing_assign requires profileId.';

  const invoke = commsDaemonInvoke(context);
  const result = await assignChannelToProfile(
    shellPaths,
    {
      surfaceKind,
      routeId: readOptString(args.draftRoute),
      profileId,
      label: readOptString(args.routeLabel),
    },
    invoke ? { invoke } : {},
  );

  return {
    mode: 'channel_routing_assign',
    created: result.created,
    route: result.route,
    path: result.path,
    daemon: result.daemon,
    routes: {
      list: 'agent_harness mode:"channel_routing"',
      remove: 'agent_harness mode:"channel_routing_remove" draftRoute:"' + (result.route.routeId ?? '') + '" surfaceKind:"' + surfaceKind + '"',
    },
    policy: result.daemon.synced
      ? 'Assignment held by the daemon and mirrored locally, so every surface routes the same way.'
      : `Assignment saved locally and awaiting the daemon (${CHANNEL_ROUTING_ASSIGN_METHOD}): ${result.daemon.error}`,
  };
}

// ---------------------------------------------------------------------------
// ROUTING, channel_routing_remove (effect)
// ---------------------------------------------------------------------------

export function channelRoutingRemoveHandoff(
  context: CommandContext,
  args: AgentHarnessCommsArgs,
): Record<string, unknown> | string {
  const confirmationError = requireConfirmedAction(args, 'Channel routing removal');
  if (confirmationError) return confirmationError;

  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return 'Channel routing remove requires an active workspace.';

  const routeId = readString(args.draftRoute || args.target);
  if (!routeId) return 'channel_routing_remove requires draftRoute (the route id to remove).';

  const removed = removeChannelProfileRoute(shellPaths, routeId);
  return {
    mode: 'channel_routing_remove',
    removed,
    routeId,
    routes: {
      list: 'agent_harness mode:"channel_routing"',
    },
    policy: removed
      ? 'Route removed locally. Daemon sync state is local_only until daemon contract is published.'
      : 'No matching route found with that routeId.',
  };
}
