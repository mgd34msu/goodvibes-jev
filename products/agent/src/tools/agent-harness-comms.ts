import type { CommandContext } from '../input/command-registry.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogData, captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { captureHarnessLocalEffect } from './agent-harness-local-effect.ts';
import { captureAgentExportPath } from './agent-artifact-effect.ts';
import { harnessCatalogInvocationAuthority, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { resolveChannelDraftNativeReference } from './agent-channel-draft-reference.ts';
import { captureOperatorConnection } from '../agent/operator-connection-owner.ts';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';
import { screenOutboundForCardMaterial, CardMaterialRefusedError } from '../agent/payments-channel-guard.ts';
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
  channelDraftFilePath,
  CHANNEL_DRAFTS_SAVE_METHOD,
} from '../agent/channel-draft.ts';
import {
  listChannelProfileRoutes,
  getProfileForChannel,
  assignChannelToProfile,
  removeChannelProfileRoute,
  formatChannelProfileRoutes,
  CHANNEL_ROUTING_ASSIGN_METHOD,
  channelProfileRouteFilePath,
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

function captureCommsEffect(context: CommandContext, args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  target: typeof channelDraftFilePath, outward = false) {
  const assertContext = captureCatalogMethods(context, ['workspace', 'platform']);
  const workspace = context.workspace, platform = context.platform;
  const assertWorkspace = captureCatalogMethods(workspace, ['shellPaths']);
  const assertPlatform = captureCatalogMethods(platform, ['configManager', 'channelDeliveryRouter']);
  const paths = workspace.shellPaths;
  if (!paths) throw new ToolInputProjectionError('held');
  const assertPaths = captureCatalogMethods(paths, ['homeDirectory', 'workingDirectory', 'resolveUserPath', 'resolveProjectPath']);
  const local = captureHarnessLocalEffect(context, args, options, source => [target(source)]);
  const home = paths.homeDirectory, directory = paths.workingDirectory;
  const resolveUserPath = paths.resolveUserPath, resolveProjectPath = paths.resolveProjectPath, destination = target(paths);
  const parent = captureAgentExportPath(home, dirname(destination));
  const ledger = getSessionUntrustedContentLedger();
  captureCatalogMethods(ledger, ['originsThisTurn', 'exposuresThisTurn', 'taintSourcesThisTurn']);
  const assertLedger = captureCatalogMethods(ledger, [...Object.getOwnPropertyNames(ledger),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(ledger))]);
  const ledgerRevision = ledger.getPublicationRevision();
  const signature = () => JSON.stringify(captureCatalogData([ledger.originsThisTurn(), ledger.exposuresThisTurn(), ledger.taintSourcesThisTurn()]));
  const source = signature();
  const assertSourceCurrent = () => {
    assertContext(); assertWorkspace(); assertPlatform(); assertPaths(); assertLedger();
    options?.signal?.throwIfAborted();
    if (context.workspace !== workspace || workspace.shellPaths !== paths || paths.homeDirectory !== home || paths.workingDirectory !== directory
      || paths.resolveUserPath !== resolveUserPath || paths.resolveProjectPath !== resolveProjectPath || target(paths) !== destination
      || getSessionUntrustedContentLedger() !== ledger || ledger.getPublicationRevision() !== ledgerRevision
      || signature() !== source) throw new ToolInputProjectionError('stale');
    parent.assertCurrent(destination);
  };
  const assertCurrent = () => {
    assertContext(); assertWorkspace(); assertPlatform(); assertPaths();
    local();
    if (outward && !harnessCatalogInvocationAuthority(args, options, 'send')) throw new ToolInputProjectionError('held');
    assertSourceCurrent();
  };
  assertCurrent();
  retainHarnessCatalogCurrent(args)(assertSourceCurrent, 'agent.comms.effect-owner');
  return { assertCurrent, assertSourceCurrent, ledger, paths };
}

function guardedCommsInvoke(context: CommandContext, args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  owner: ReturnType<typeof captureCommsEffect>, nativeReference?: ReturnType<typeof resolveChannelDraftNativeReference>): DaemonOperatorInvoke | null {
  owner.assertCurrent();
  const platform = context.platform, config = platform?.configManager, paths = context.workspace.shellPaths;
  if (!config || !paths) return null;
  const assertCurrent = () => {
    owner.assertCurrent();
    if (context.platform !== platform || platform.configManager !== config || context.workspace.shellPaths !== paths
      || !harnessCatalogInvocationAuthority(args, options, 'send')) throw new ToolInputProjectionError('held');
  };
  const connection = captureOperatorConnection(paths, config, assertCurrent);
  const invoke = createDaemonOperatorInvoke(() => connection);
  return async (method, input = {}, supplied = {}) => {
    assertCurrent();
    if (method !== CHANNEL_DRAFTS_SAVE_METHOD && method !== CHANNEL_ROUTING_ASSIGN_METHOD) throw new ToolInputProjectionError('held');
    const { confirm: _confirm, explicitUserRequest: _request, admission: _admission, ...request } = input;
    if (nativeReference && (method !== CHANNEL_DRAFTS_SAVE_METHOD || request.id !== nativeReference.draftId)) {
      throw new ToolInputProjectionError('held');
    }
    const nativeInput = { ...request, ...(nativeReference ? { id: nativeReference.reference } : {}), admission: 'autonomous' };
    assertCurrent();
    const payload = JSON.stringify(nativeInput);
    const refusal = await screenOutboundForCardMaterial({ surface: 'connected-host', message: payload }, { signal: options?.signal, assertCurrent });
    assertCurrent();
    if (refusal) throw new CardMaterialRefusedError(refusal);
    const decision = await evaluateOutwardEffect({ request: { toolName: 'agent_harness', action: method, description: 'synchronizing a channel draft or routing assignment' },
      ledger: owner.ledger, content: { payload }, taintOptions: { signal: options?.signal } });
    assertCurrent();
    if (!decision.allowed) throw new Error(decision.reason ?? 'Outward channel synchronization held.');
    const { explicitUserRequest: _userRequest, ...restrictions } = supplied;
    return invoke(method, nativeInput, { ...restrictions, signal: options?.signal,
      assertCurrent: () => { supplied.assertCurrent?.(); assertCurrent(); } });
  };
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
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<Record<string, unknown> | string> {
  const confirmationError = requireConfirmedAction(args, options, 'Channel draft save');
  if (confirmationError) return confirmationError;

  const message = readString(args.draftMessage);
  if (!message) return 'channel_draft_save requires draftMessage.';

  const owner = captureCommsEffect(context, args, options, channelDraftFilePath);
  const shellPaths = owner.paths;
  const invoke = guardedCommsInvoke(context, args, options, owner);
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
    { ...(invoke ? { invoke } : {}), signal: options?.signal, assertCurrent: owner.assertCurrent, explicitUserRequest: false },
  );
  owner.assertCurrent();

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
      ? 'Draft held by the daemon and mirrored locally. Use channel_draft_send under current recorded admission to deliver.'
      : `Draft saved locally; the daemon does not hold it yet (${result.daemon.error}). Use channel_draft_send under current recorded admission to deliver.`,
  };
}

// ---------------------------------------------------------------------------
// DRAFTS, channel_draft_send (effect)
// ---------------------------------------------------------------------------

export async function channelDraftSendHandoff(
  context: CommandContext,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<Record<string, unknown> | string> {
  const confirmationError = requireConfirmedAction(args, options, 'Channel draft send');
  if (confirmationError) return confirmationError;
  const nativeReference = resolveChannelDraftNativeReference(args, options);

  const draftId = nativeReference?.draftId ?? readString(args.draftId || args.target);
  if (!draftId) return 'channel_draft_send requires draftId.';
  const publicReference = nativeReference?.reference ?? draftId;
  const publicText = (text: string) => nativeReference?.publicText(text) ?? text;
  const publicDraft = (draft: NonNullable<ReturnType<typeof getDraft>>) => ({
    ...redactDraftWebhook(draft), id: publicReference,
    ...(draft.syncError ? { syncError: publicText(draft.syncError) } : {}),
    ...(draft.sendError ? { sendError: publicText(draft.sendError) } : {}),
    ...(draft.sentResponseId ? { sentResponseId: publicText(draft.sentResponseId) } : {}),
  });

  const owner = captureCommsEffect(context, args, options, channelDraftFilePath, true);
  const shellPaths = owner.paths;
  const router = context.platform.channelDeliveryRouter;
  if (!router) {
    return 'Channel delivery router is not available. Ensure the Agent is connected to a channel delivery service.';
  }

  const assertRouter = captureCatalogMethods(router, ['deliver', 'listStrategies']);
  const deliver = router.deliver, listStrategies = router.listStrategies;
  const listed = listStrategies.call(router);
  captureCatalogMethods(listed, ['length', 'map']);
  const assertListed = captureCatalogMethods(listed, ['length', 'map', ...Object.getOwnPropertyNames(listed)]);
  const strategies = listed.map(strategy => {
    const assertMethods = captureCatalogMethods(strategy, ['deliver', 'canHandle']);
    return { strategy, assertMethods, deliver: strategy.deliver, canHandle: strategy.canHandle };
  });
  let expectedDraft = JSON.stringify(getDraft(shellPaths, draftId));
  const assertSelectedSourceCurrent = () => {
    owner.assertSourceCurrent();
    assertRouter(); assertListed();
    for (const strategy of strategies) strategy.assertMethods();
    if (context.platform.channelDeliveryRouter !== router || router.deliver !== deliver || router.listStrategies !== listStrategies
      || JSON.stringify(getDraft(shellPaths, draftId)) !== expectedDraft) throw new ToolInputProjectionError('stale');
    const current = listStrategies.call(router);
    captureCatalogMethods(current, ['length']);
    captureCatalogMethods(current, ['length', ...Object.getOwnPropertyNames(current)]);
    if (current.length !== strategies.length || strategies.some((source, index) => current[index] !== source.strategy
      || source.strategy.deliver !== source.deliver || source.strategy.canHandle !== source.canHandle)) throw new ToolInputProjectionError('stale');
  };
  const assertCurrent = () => { owner.assertCurrent(); assertSelectedSourceCurrent(); };
  assertCurrent();
  retainHarnessCatalogCurrent(args)(assertSelectedSourceCurrent, `agent.comms.draft:${publicReference}`);
  const invoke = guardedCommsInvoke(context, args, options, { ...owner, assertCurrent }, nativeReference);
  const preparePublication = (path: string, contents: string) => {
    assertCurrent();
    if (path !== channelDraftFilePath(shellPaths)) throw new ToolInputProjectionError('stale');
    const planned: unknown = JSON.parse(contents);
    if (!planned || typeof planned !== 'object' || !('drafts' in planned) || !Array.isArray(planned.drafts)
      || !planned.drafts.some((draft: unknown) => draft && typeof draft === 'object' && 'id' in draft && draft.id === draftId)) {
      throw new ToolInputProjectionError('held');
    }
    const adoptReference = nativeReference?.preparePublication(path, contents);
    return () => {
      options?.signal?.throwIfAborted(); owner.assertSourceCurrent();
      if (readFileSync(path, 'utf8') !== contents) throw new ToolInputProjectionError('stale');
      expectedDraft = JSON.stringify(getDraft(shellPaths, draftId));
      adoptReference?.();
      assertCurrent();
    };
  };
  const storeOptions = { ...(invoke ? { invoke } : {}), signal: options?.signal, assertCurrent, preparePublication, explicitUserRequest: false };
  let queueResult: Awaited<ReturnType<typeof queueDraftToSend>>;
  try {
    queueResult = await queueDraftToSend(shellPaths, draftId, storeOptions);
    assertCurrent();
  } catch (err) {
    return publicText(err instanceof Error ? err.message : String(err));
  }

  try {
    const decision = await evaluateOutwardEffect({ request: { toolName: 'agent_harness', action: 'channel_draft_send', description: 'delivering the captured channel draft' },
      ledger: owner.ledger, content: { ...queueResult.deliveryInput },
      taintOptions: { signal: options?.signal, exactMatchFields: ['channel', 'route', 'webhook', 'link'] } });
    assertCurrent();
    if (!decision.allowed) throw new Error(decision.reason ?? 'Channel draft delivery held.');
    const result = await deliverAgentChannelMessage(router, queueResult.deliveryInput, { signal: options?.signal, assertCurrent });
    assertCurrent();
    const sentDraft = markDraftSent(shellPaths, draftId, result.responseId, storeOptions);
    return {
      mode: 'channel_draft_send',
      status: 'sent',
      draftId: publicReference,
      responseId: result.responseId ? publicText(result.responseId) : null,
      draft: sentDraft ? publicDraft(sentDraft) : sentDraft,
      delivery: {
        message: publicText(result.message),
        title: publicText(result.title),
        target: { ...result.target,
          ...(result.target.address ? { address: publicText(result.target.address) } : {}),
          ...(result.target.routeId ? { routeId: publicText(result.target.routeId) } : {}),
          ...(result.target.label ? { label: publicText(result.target.label) } : {}),
        },
        strategyCount: result.strategyCount,
      },
      policy: 'Draft delivered and marked sent. Receipt recorded via delivery path.',
    };
  } catch (err) {
    const errorMessage = publicText(err instanceof Error ? err.message : String(err));
    let markedFailed = false;
    try {
      assertCurrent(); markDraftFailed(shellPaths, draftId, errorMessage, storeOptions); markedFailed = true;
    } catch {
      // best-effort
    }
    return {
      mode: 'channel_draft_send',
      status: markedFailed ? 'failed' : 'held',
      draftId: publicReference,
      error: errorMessage,
      policy: markedFailed
        ? 'Delivery failed and the current draft was marked failed.'
        : 'Delivery or its receipt was held after authority or source changed. The draft status was preserved; check the delivery before retrying.',
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
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<Record<string, unknown> | string> {
  const confirmationError = requireConfirmedAction(args, options, 'Channel routing assignment');
  if (confirmationError) return confirmationError;

  const surfaceKind = readString(args.surfaceKind);
  if (!surfaceKind) return 'channel_routing_assign requires surfaceKind.';
  const profileId = readString(args.profileId);
  if (!profileId) return 'channel_routing_assign requires profileId.';

  const owner = captureCommsEffect(context, args, options, channelProfileRouteFilePath);
  const shellPaths = owner.paths;
  const invoke = guardedCommsInvoke(context, args, options, owner);
  const result = await assignChannelToProfile(
    shellPaths,
    {
      surfaceKind,
      routeId: readOptString(args.draftRoute),
      profileId,
      label: readOptString(args.routeLabel),
    },
    { ...(invoke ? { invoke } : {}), signal: options?.signal, assertCurrent: owner.assertCurrent, explicitUserRequest: false },
  );
  owner.assertCurrent();

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
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Record<string, unknown> | string {
  const confirmationError = requireConfirmedAction(args, options, 'Channel routing removal');
  if (confirmationError) return confirmationError;

  const routeId = readString(args.draftRoute || args.target);
  if (!routeId) return 'channel_routing_remove requires draftRoute (the route id to remove).';

  const owner = captureCommsEffect(context, args, options, channelProfileRouteFilePath);
  const shellPaths = owner.paths;
  const removed = removeChannelProfileRoute(shellPaths, routeId, { signal: options?.signal, assertCurrent: owner.assertCurrent });
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
