import type { CommandContext } from '../input/command-registry.ts';
import type { AgentWorkspaceChannelStatus } from '../input/agent-workspace-channels.ts';
import { readAgentChannelDeliveryReceipts } from '../agent/channel-delivery-receipts.ts';
import { buildAgentWorkspaceChannelTriage, type AgentWorkspaceChannelTriage } from '../input/agent-workspace-channel-triage.ts';
import { buildAgentWorkspaceChannelSetupGuide, buildAgentWorkspaceChannels } from '../input/agent-workspace-channels.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { withInventoryDisclosure } from './inventory-disclosure.ts';

export interface AgentHarnessChannelArgs {
  readonly channelId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type ChannelLookupSource = 'channelId' | 'target' | 'query';

type ChannelResolution =
  | { readonly status: 'found'; readonly channel: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type ChannelSetupGuideResolution =
  | { readonly status: 'found'; readonly guide: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function channelLookupFromArgs(args: AgentHarnessChannelArgs): { readonly source: ChannelLookupSource; readonly input: string } | null {
  const channelId = readString(args.channelId);
  if (channelId) return { source: 'channelId', input: channelId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function channelSearchText(channel: AgentWorkspaceChannelStatus): string {
  return [
    channel.id,
    channel.label,
    channel.delivery,
    channel.risk,
    channel.riskLabel,
    channel.setupState,
    channel.nextStep,
    ...channel.requiredKeys,
    ...channel.missingRequiredKeys,
    ...channel.defaultTargetKeys,
    ...channel.configuredDefaultTargetKeys,
  ].join('\n').toLowerCase();
}

function describeChannelCandidate(channel: AgentWorkspaceChannelStatus): Record<string, unknown> {
  return {
    channelId: channel.id,
    label: channel.label,
    setupState: channel.setupState,
    ready: channel.ready,
    delivery: channel.delivery,
    modelRoute: channelModelRoute(channel.id),
  };
}

function channelModelRoute(channelId?: string): string {
  return channelId
    ? `channels action:"channel" channelId:"${channelId}"`
    : 'channels action:"status"';
}

function channelSetupGuideModelRoute(channelId?: string): string {
  return channelId
    ? `channels action:"setup" channelId:"${channelId}"`
    : 'channels action:"setup"';
}

function channelDeliveriesModelRoute(): string {
  return 'channels action:"deliveries"';
}

function channelTriageModelRoute(): string {
  return 'channels action:"triage"';
}

function describeChannel(
  channel: AgentWorkspaceChannelStatus,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    id: channel.id,
    label: channel.label,
    enabled: channel.enabled,
    ready: channel.ready,
    setupState: channel.setupState,
    delivery: channel.delivery,
    risk: channel.risk,
    riskLabel: channel.riskLabel,
    missingConfigCount: channel.missingConfigCount,
    defaultTarget: channel.defaultTarget,
    nextStep: channel.nextStep,
    requiredConfigKeys: channel.requiredKeys,
    missingConfigKeys: channel.missingRequiredKeys,
    defaultTargetKeys: channel.defaultTargetKeys,
    configuredDefaultTargetKeys: channel.configuredDefaultTargetKeys,
    modelRoute: channelModelRoute(channel.id),
    setupGuideRoute: channelSetupGuideModelRoute(channel.id),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters
      ? {
        policy: {
          effect: 'read-only',
          values: 'Config key names and target key names are shown; secret values and stored target values are never returned.',
          delivery: 'Use agent_channel_send only for one explicit, confirmed delivery target requested by the user.',
          setup: 'Use connected-host setup/account/policy routes only as read-only diagnostics unless another confirmed first-class tool owns the mutation.',
        },
        modelAccess: {
          sendTool: 'agent_channel_send',
          notificationTool: 'agent_notify',
          reminderTool: 'agent_reminder_schedule',
          slashCommandDetail: `/channels show ${channel.id}`,
          readOnlyConnectedRoutes: [
            '/channels accounts',
            '/channels policies',
            '/channels status',
            `/channels doctor ${channel.id}`,
            `/channels setup ${channel.id}`,
          ],
          settingsFilter: `settings action:"list" prefix:"surfaces.${channel.id}" includeHidden:true`,
          connectedHostBoundary: 'host action:"capability" query:"delivery"',
          deliveryTargetShape: 'surface[:route[:label]]',
          exampleTarget: `${channel.id}:route:Label`,
        },
      }
      : {
        summary: previewHarnessText(channel.nextStep || `${channel.label} channel ${channel.setupState}`),
      }),
  };
}

export function channelReadinessCatalogStatus(context: CommandContext): Record<string, unknown> {
  const channels = buildAgentWorkspaceChannels(context);
  const guide = buildAgentWorkspaceChannelSetupGuide(channels);
  return {
    modes: ['channels', 'channel', 'channel_setup_guide', 'channel_triage', 'channel_deliveries'],
    modelRoute: 'channels action:"status"',
    channels: channels.length,
    enabled: channels.filter((channel) => channel.enabled).length,
    ready: channels.filter((channel) => channel.ready).length,
    attention: channels.filter((channel) => channel.enabled && channel.setupState !== 'ready').length,
    setupGuide: {
      status: guide.status,
      currentChannelId: guide.currentChannelId,
      currentStepId: guide.currentStepId,
      progressLabel: guide.progressLabel,
      modelRoute: channelSetupGuideModelRoute(guide.currentChannelId ?? undefined),
    },
    readOnly: true,
    deliveryTool: 'agent_channel_send',
    triage: channelTriageModelRoute(),
    deliveryReceipts: channelDeliveriesModelRoute(),
  };
}

export function listHarnessChannels(context: CommandContext, args: AgentHarnessChannelArgs): Record<string, unknown> {
  const rawQuery = readString(args.query);
  const query = rawQuery.toLowerCase();
  const includeParameters = args.includeParameters === true;
  const limit = readLimit(args.limit, 200);
  const channels = buildAgentWorkspaceChannels(context);
  const matched = channels.filter((channel) => !query || channelSearchText(channel).includes(query));
  const filtered = matched.slice(0, limit);
  const enabled = channels.filter((channel) => channel.enabled).length;
  const ready = channels.filter((channel) => channel.ready).length;

  // A query that matches nothing used to return a bare `channels: []` next to
  // `total: 14`, which reads as "this install has no channels", and that is
  // exactly how it was read: a request to send an email searched the catalog,
  // matched nothing, and was reported to the user as "email is not
  // configured". An empty list must therefore explain itself and hand back a
  // route out, never a silent empty array.
  //
  // Two rounds arrived at that conclusion independently, so the answer carries
  // both halves rather than one: the shared inventory disclosure below states
  // how much was withheld and names the route that lists everything, and the
  // channel-specific fields say which channels DO exist and how to reach them.
  const filteredOutByQuery = query !== '' && matched.length === 0 && channels.length > 0;

  return withInventoryDisclosure({
    channels: filtered.map((channel) => describeChannel(channel, { includeParameters })),
    returned: filtered.length,
    total: channels.length,
    enabled,
    ready,
    attention: channels.filter((channel) => channel.enabled && channel.setupState !== 'ready').length,
    ...(query === '' ? {} : { query: rawQuery }),
    ...(filteredOutByQuery
      ? {
        emptyReason: 'query-matched-nothing',
        emptyExplanation: `No channel matched "${rawQuery}". This install has ${channels.length} channel(s); the search simply did not match any of them. It does NOT mean no channels are configured, re-run without a query to see them all.`,
        availableChannelIds: channels.map((channel) => channel.id),
        retryModelRoute: 'channels action:"status"',
      }
      : {}),
    ...(channels.length === 0
      ? {
        emptyReason: 'no-channels-registered',
        emptyExplanation: 'This install genuinely has no channels registered.',
      }
      : {}),
    setupGuide: {
      status: buildAgentWorkspaceChannelSetupGuide(channels).status,
      modelRoute: channelSetupGuideModelRoute(),
    },
    triage: channelTriageModelRoute(),
    deliveryReceipts: channelDeliveriesModelRoute(),
    policy: 'Read-only channel readiness catalog. It returns key names, setup state, delivery posture, and model routes without printing secrets or sending messages.',
  }, {
    subject: 'channels',
    returned: filtered.length,
    total: channels.length,
    filters: { query, limit: query || filtered.length < channels.length ? limit : undefined },
    listAllRoute: 'agent_harness mode:"channels"',
    context: ready > 0 ? [`${String(ready)} of them are ready to use.`] : [],
  });
}

export function describeHarnessChannel(context: CommandContext, args: AgentHarnessChannelArgs): ChannelResolution {
  const lookup = channelLookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'channels action:"channel" requires channelId, target, or query. Use channels action:"status" to inspect available channel ids.',
    };
  }
  const channels = buildAgentWorkspaceChannels(context);
  const normalized = lookup.input.toLowerCase();
  const exact = channels.find((channel) => channel.id === lookup.input);
  if (exact) return { status: 'found', channel: describeChannel(exact, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'id' } }) };
  const insensitiveId = channels.find((channel) => channel.id.toLowerCase() === normalized);
  if (insensitiveId) return { status: 'found', channel: describeChannel(insensitiveId, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } }) };
  const insensitiveLabel = channels.find((channel) => channel.label.toLowerCase() === normalized);
  if (insensitiveLabel) return { status: 'found', channel: describeChannel(insensitiveLabel, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-label' } }) };
  const searched = channels.filter((channel) => channelSearchText(channel).includes(normalized));
  if (searched.length === 1) {
    return { status: 'found', channel: describeChannel(searched[0]!, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' } }) };
  }
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(describeChannelCandidate),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown channel ${lookup.input}. Use channels action:"status" to inspect available channel ids.`,
  };
}

export function describeHarnessChannelSetupGuide(context: CommandContext, args: AgentHarnessChannelArgs): ChannelSetupGuideResolution {
  const channels = buildAgentWorkspaceChannels(context);
  const lookup = channelLookupFromArgs(args);
  if (!lookup) {
    const guide = buildAgentWorkspaceChannelSetupGuide(channels);
    return {
      status: 'found',
      guide: {
        mode: 'channel_setup_guide',
        guide,
        routes: {
          channels: 'channels action:"status"',
          currentChannel: guide.currentChannelId ? channelSetupGuideModelRoute(guide.currentChannelId) : null,
        },
        policy: guide.policy,
      },
    };
  }
  const normalized = lookup.input.toLowerCase();
  const exact = channels.find((channel) => channel.id === lookup.input || channel.id.toLowerCase() === normalized || channel.label.toLowerCase() === normalized);
  if (exact) {
    const guide = buildAgentWorkspaceChannelSetupGuide(channels, { channelId: exact.id });
    return {
      status: 'found',
      guide: {
        mode: 'channel_setup_guide',
        guide,
        lookup: { ...lookup, resolvedBy: exact.id === lookup.input ? 'id' : 'case-insensitive' },
        routes: {
          channel: channelModelRoute(exact.id),
          channels: 'channels action:"status"',
        },
        policy: guide.policy,
      },
    };
  }
  const searched = channels.filter((channel) => channelSearchText(channel).includes(normalized));
  if (searched.length === 1) {
    const channel = searched[0]!;
    const guide = buildAgentWorkspaceChannelSetupGuide(channels, { channelId: channel.id });
    return {
      status: 'found',
      guide: {
        mode: 'channel_setup_guide',
        guide,
        lookup: { ...lookup, resolvedBy: 'search' },
        routes: {
          channel: channelModelRoute(channel.id),
          channels: 'channels action:"status"',
        },
        policy: guide.policy,
      },
    };
  }
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(describeChannelCandidate),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown channel setup guide target ${lookup.input}. Use channels action:"status" to inspect available channel ids.`,
  };
}

export function describeHarnessChannelDeliveries(context: CommandContext, args: AgentHarnessChannelArgs): Record<string, unknown> {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return {
      mode: 'channel_deliveries',
      status: 'unavailable',
      receipts: [],
      policy: 'Read-only delivery receipts require Agent shell path context. Sends still require explicit confirmation.',
      nextActions: ['Open a normal Agent workspace before relying on channel delivery receipts.'],
    };
  }
  const limit = readLimit(args.limit, 20);
  const snapshot = readAgentChannelDeliveryReceipts(shellPaths);
  const receipts = snapshot.receipts.slice(0, limit).map((receipt) => ({
    receiptId: receipt.id,
    createdAt: receipt.createdAt,
    source: receipt.source,
    status: receipt.status,
    target: receipt.target,
    title: receipt.title,
    messageLength: receipt.messageLength,
    messageDigest: receipt.messageDigest,
    messagePreview: receipt.messagePreview,
    strategyCount: receipt.strategyCount,
    responseId: receipt.responseId ?? null,
    userRoute: receipt.userRoute,
    modelRoute: receipt.modelRoute,
    authorization: receipt.authorization,
  }));
  return {
    mode: 'channel_deliveries',
    status: snapshot.parseError ? 'attention' : snapshot.exists ? 'ready' : 'empty',
    path: snapshot.path,
    total: snapshot.receipts.length,
    returned: receipts.length,
    receipts,
    routes: {
      command: '/channels deliveries',
      sendTool: 'agent_channel_send',
      channels: 'channels action:"status"',
    },
    ...(snapshot.parseError ? { parseError: snapshot.parseError } : {}),
    policy: 'Read-only confirmed delivery history. Receipt targets redact webhook/link addresses, message bodies are bounded/redacted, and new sends still require explicit user confirmation.',
  };
}

export async function describeHarnessChannelTriage(context: CommandContext, args: AgentHarnessChannelArgs): Promise<AgentWorkspaceChannelTriage> {
  return buildAgentWorkspaceChannelTriage(context, args);
}
