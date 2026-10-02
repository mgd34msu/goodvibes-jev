import { createHash } from 'node:crypto';
import { formatAgentChannelDeliveryReceiptLine, readAgentChannelDeliveryReceipts } from '../agent/channel-delivery-receipts.ts';
import type { CommandContext } from './command-registry.ts';
import {
  fetchConnectedHostReadOnlyRoute,
  resolveConnectedHostConnection,
  type ConnectedHostConnection,
  type ConnectedHostRouteFailure,
  type ConnectedHostRouteResult,
} from './connected-host-routes.ts';
import type { AgentWorkspaceChannelStatus } from './agent-workspace-channels.ts';
import { buildAgentWorkspaceChannels } from './agent-workspace-channels.ts';
import { resolveChannelPrincipalAttribution, UNKNOWN_PRINCIPAL_LABEL } from '../agent/principal-attribution.ts';

type JsonRecord = Record<string, unknown>;

type TriageRouteState = 'ready' | 'empty' | 'unavailable';

export interface AgentWorkspaceChannelTriageArgs {
  readonly limit?: unknown;
  readonly includeParameters?: unknown;
}

export interface AgentWorkspaceChannelTriage {
  readonly mode: 'channel_triage';
  readonly status: 'ready' | 'attention' | 'blocked';
  readonly summary: string;
  readonly readiness: Record<string, unknown>;
  readonly deliveries: Record<string, unknown>;
  readonly surfaceMessages: Record<string, unknown>;
  readonly routeBindings: Record<string, unknown>;
  readonly receipts: Record<string, unknown>;
  readonly inboundFeed: Record<string, unknown>;
  readonly connectedHost: Record<string, unknown>;
  readonly routes: Record<string, unknown>;
  readonly policy: string;
}

interface DeliveryAttemptView {
  readonly id: string;
  readonly runId: string;
  readonly jobId: string;
  readonly status: string;
  readonly target: Record<string, unknown>;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly responseId?: string;
  readonly inspectRoute: string;
  readonly modelRoute: string;
}

const DELIVERY_ATTENTION_STATUSES = new Set(['failed', 'dead_lettered', 'pending', 'sending']);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: JsonRecord, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRecord(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function readRecordArray(record: JsonRecord, key: string): readonly JsonRecord[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function boundedText(value: string, max = 160): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1))}...`;
}

function redactText(value: string, max = 160): string {
  return boundedText(value
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$3[redacted]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]+)/g, '[redacted-token]'), max);
}

function redactedAddress(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  let display = '[redacted-address]';
  try {
    const parsed = new URL(value);
    display = `${parsed.protocol}//${parsed.host}/...`;
  } catch {
    display = '[redacted-address]';
  }
  return { address: display, addressDigest: `sha256:${digest(value)}` };
}

function routeFailureView(failure: ConnectedHostRouteFailure): Record<string, unknown> {
  return {
    route: failure.route,
    status: 'unavailable',
    kind: failure.kind,
    baseUrl: failure.baseUrl,
    message: redactText(failure.message),
  };
}

function routeState(result: ConnectedHostRouteResult, empty: boolean): TriageRouteState {
  if (!result.ok) return 'unavailable';
  return empty ? 'empty' : 'ready';
}

function channelTriageReadiness(channels: readonly AgentWorkspaceChannelStatus[], limit: number): Record<string, unknown> {
  const ready = channels.filter((channel) => channel.ready);
  const enabled = channels.filter((channel) => channel.enabled);
  const needsConfig = channels.filter((channel) => channel.setupState === 'needs-config');
  const needsTarget = channels.filter((channel) => channel.setupState === 'needs-target');
  const attention = channels.filter((channel) => channel.enabled && channel.setupState !== 'ready');
  return {
    totalChannels: channels.length,
    enabled: enabled.length,
    ready: ready.length,
    needsConfig: needsConfig.length,
    needsTarget: needsTarget.length,
    attention: attention.length,
    attentionChannels: attention.slice(0, limit).map((channel) => ({
      channelId: channel.id,
      label: channel.label,
      setupState: channel.setupState,
      delivery: channel.delivery,
      nextStep: channel.nextStep,
      userRoute: `/channels show ${channel.id}`,
      modelRoute: `channels action:"channel" channelId:"${channel.id}"`,
    })),
    routes: {
      readiness: '/channels',
      attention: '/channels attention',
      guide: '/channels guide',
    },
  };
}

function deliveryTargetView(target: JsonRecord): Record<string, unknown> {
  const address = readString(target, 'address');
  return {
    kind: readString(target, 'kind', 'unknown'),
    surfaceKind: readString(target, 'surfaceKind') || null,
    routeId: readString(target, 'routeId') || null,
    label: redactText(readString(target, 'label'), 80) || null,
    ...redactedAddress(address),
  };
}

function deliveryAttemptView(attempt: JsonRecord): DeliveryAttemptView {
  const id = readString(attempt, 'id', 'delivery');
  const runId = readString(attempt, 'runId');
  const jobId = readString(attempt, 'jobId');
  const responseId = readString(attempt, 'responseId');
  const error = readString(attempt, 'error');
  return {
    id,
    runId,
    jobId,
    status: readString(attempt, 'status', 'unknown'),
    target: deliveryTargetView(readRecord(attempt, 'target')),
    ...(readNumber(attempt, 'startedAt') !== undefined ? { startedAt: readNumber(attempt, 'startedAt') } : {}),
    ...(readNumber(attempt, 'endedAt') !== undefined ? { endedAt: readNumber(attempt, 'endedAt') } : {}),
    ...(error ? { error: redactText(error) } : {}),
    ...(responseId ? { responseId } : {}),
    inspectRoute: `/api/deliveries/${encodeURIComponent(id)}`,
    modelRoute: runId
      ? `autonomy action:"queue" query:"${runId}"`
      : 'autonomy action:"queue"',
  };
}

function deliveryTriage(result: ConnectedHostRouteResult, limit: number): Record<string, unknown> {
  if (!result.ok) {
    return {
      route: result.route,
      state: 'unavailable',
      ...routeFailureView(result),
      totals: null,
      attempts: [],
      attentionCount: 0,
      retryCandidates: [],
    };
  }
  const root = isRecord(result.body) ? result.body : {};
  const attempts = readRecordArray(root, 'attempts');
  const views = attempts.map(deliveryAttemptView);
  const attention = views.filter((attempt) => DELIVERY_ATTENTION_STATUSES.has(attempt.status));
  const retryCandidates = views.filter((attempt) => attempt.status === 'failed' || attempt.status === 'dead_lettered');
  return {
    route: result.route,
    state: routeState(result, attempts.length === 0),
    totals: isRecord(root.totals) ? root.totals : null,
    totalAttempts: attempts.length,
    attentionCount: attention.length,
    retryCandidateCount: retryCandidates.length,
    retryCandidates: retryCandidates.slice(0, limit),
    attempts: views.slice(0, limit),
    policy: 'Read-only delivery attempt snapshot. Retry decisions should inspect the owning automation run/job before any confirmed mutation.',
  };
}

function surfaceMessageView(message: JsonRecord): Record<string, unknown> {
  return {
    id: readString(message, 'id', 'message'),
    surface: readString(message, 'surface', 'unknown'),
    createdAt: readNumber(message, 'createdAt') ?? null,
    level: readString(message, 'level', 'info'),
    title: redactText(readString(message, 'title'), 100),
    bodyPreview: redactText(readString(message, 'body'), 180),
    routeId: readString(message, 'routeId') || null,
    surfaceId: readString(message, 'surfaceId') || null,
    clientId: readString(message, 'clientId') || null,
    attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
  };
}

function surfaceMessageTriage(result: ConnectedHostRouteResult, limit: number): Record<string, unknown> {
  if (!result.ok) {
    return {
      route: result.route,
      state: 'unavailable',
      ...routeFailureView(result),
      totalMessages: 0,
      messages: [],
    };
  }
  const root = isRecord(result.body) ? result.body : {};
  const messages = readRecordArray(root, 'messages');
  return {
    route: result.route,
    state: routeState(result, messages.length === 0),
    totalMessages: messages.length,
    messages: messages.slice(0, limit).map(surfaceMessageView),
    policy: 'Read-only control-plane surface messages. This is a visible surface message feed, not provider-specific inbox polling.',
  };
}

async function routeBindingView(binding: JsonRecord, connection: ConnectedHostConnection): Promise<Record<string, unknown>> {
  const externalId = readString(binding, 'externalId');
  const surfaceKind = readString(binding, 'surfaceKind', 'unknown');
  const attribution = await resolveChannelPrincipalAttribution(connection, surfaceKind, externalId);
  return {
    id: readString(binding, 'id', 'binding'),
    kind: readString(binding, 'kind', 'unknown'),
    surfaceKind,
    surfaceId: readString(binding, 'surfaceId') || null,
    title: redactText(readString(binding, 'title'), 100) || null,
    externalIdDigest: externalId ? `sha256:${digest(externalId)}` : null,
    principal: attribution.principal,
    principalLabel: attribution.label,
    ...(attribution.error ? { principalResolutionError: attribution.error } : {}),
    sessionPolicy: readString(binding, 'sessionPolicy') || null,
    threadPolicy: readString(binding, 'threadPolicy') || null,
    deliveryGuarantee: readString(binding, 'deliveryGuarantee') || null,
    lastSeenAt: readNumber(binding, 'lastSeenAt') ?? null,
    sessionId: readString(binding, 'sessionId') || null,
    runId: readString(binding, 'runId') || null,
    jobId: readString(binding, 'jobId') || null,
  };
}

async function routeBindingTriage(
  result: ConnectedHostRouteResult,
  limit: number,
  connection: ConnectedHostConnection,
): Promise<Record<string, unknown>> {
  if (!result.ok) {
    return {
      route: result.route,
      state: 'unavailable',
      ...routeFailureView(result),
      totalBindings: 0,
      bindings: [],
    };
  }
  const root = isRecord(result.body) ? result.body : {};
  const bindings = readRecordArray(root, 'bindings');
  const sliced = bindings.slice(0, limit);
  const bindingViews = await Promise.all(sliced.map((binding) => routeBindingView(binding, connection)));
  return {
    route: result.route,
    state: routeState(result, bindings.length === 0),
    totalBindings: bindings.length,
    bindings: bindingViews,
    policy: `Read-only route continuity. External ids are digested so channel identifiers are not printed into chat. Sender attribution shows the resolved principal when the channel identity maps to one, and "${UNKNOWN_PRINCIPAL_LABEL}" otherwise.`,
  };
}

function receiptTriage(context: CommandContext, limit: number): Record<string, unknown> {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return {
      state: 'unavailable',
      totalReceipts: 0,
      receipts: [],
      reason: 'Agent shell paths unavailable.',
    };
  }
  const snapshot = readAgentChannelDeliveryReceipts(shellPaths);
  return {
    state: snapshot.parseError ? 'attention' : snapshot.exists ? 'ready' : 'empty',
    path: snapshot.path,
    totalReceipts: snapshot.receipts.length,
    receipts: snapshot.receipts.slice(0, limit).map((receipt) => ({
      receiptId: receipt.id,
      line: formatAgentChannelDeliveryReceiptLine(receipt),
      createdAt: receipt.createdAt,
      source: receipt.source,
      status: receipt.status,
      target: receipt.target,
      messageDigest: receipt.messageDigest,
      messagePreview: receipt.messagePreview,
    })),
    ...(snapshot.parseError ? { parseError: snapshot.parseError } : {}),
  };
}

function routeFailureCount(results: readonly ConnectedHostRouteResult[]): number {
  return results.filter((result) => !result.ok).length;
}

function triageStatus(input: {
  readonly readinessAttention: number;
  readonly deliveryAttention: number;
  readonly routeFailures: number;
}): AgentWorkspaceChannelTriage['status'] {
  if (input.routeFailures > 0) return 'blocked';
  if (input.readinessAttention > 0 || input.deliveryAttention > 0) return 'attention';
  return 'ready';
}

export async function buildAgentWorkspaceChannelTriage(
  context: CommandContext,
  args: AgentWorkspaceChannelTriageArgs = {},
): Promise<AgentWorkspaceChannelTriage> {
  const limit = readLimit(args.limit, 12);
  const channels = buildAgentWorkspaceChannels(context);
  const connection = resolveConnectedHostConnection(context);
  const [deliveriesResult, messagesResult, bindingsResult] = await Promise.all([
    fetchConnectedHostReadOnlyRoute(context, '/api/deliveries'),
    fetchConnectedHostReadOnlyRoute(context, '/api/control-plane/messages'),
    fetchConnectedHostReadOnlyRoute(context, '/api/routes/bindings'),
  ]);
  const readiness = channelTriageReadiness(channels, limit);
  const deliveries = deliveryTriage(deliveriesResult, limit);
  const surfaceMessages = surfaceMessageTriage(messagesResult, limit);
  const routeBindings = await routeBindingTriage(bindingsResult, limit, connection);
  const receipts = receiptTriage(context, limit);
  const routeFailures = routeFailureCount([deliveriesResult, messagesResult, bindingsResult]);
  const readinessAttention = typeof readiness.attention === 'number' ? readiness.attention : 0;
  const deliveryAttention = typeof deliveries.attentionCount === 'number' ? deliveries.attentionCount : 0;
  const status = triageStatus({ readinessAttention, deliveryAttention, routeFailures });
  const messageCount = typeof surfaceMessages.totalMessages === 'number' ? surfaceMessages.totalMessages : 0;
  const bindingCount = typeof routeBindings.totalBindings === 'number' ? routeBindings.totalBindings : 0;
  const retryCount = typeof deliveries.retryCandidateCount === 'number' ? deliveries.retryCandidateCount : 0;
  return {
    mode: 'channel_triage',
    status,
    summary: `${readinessAttention} channel setup blocker(s), ${deliveryAttention} delivery attention item(s), ${retryCount} retry candidate(s), ${messageCount} visible surface message(s), ${bindingCount} route binding(s).`,
    readiness,
    deliveries,
    surfaceMessages,
    routeBindings,
    receipts,
    inboundFeed: {
      status: messageCount > 0 ? 'visible_surface_messages' : 'no_visible_surface_messages',
      route: '/api/control-plane/messages',
      providerInboxFeed: 'not_published_by_current_channel_contract',
      summary: 'GoodVibes daemon exposes control-plane surface messages, route bindings, delivery attempts, and session/companion message APIs. It does not expose a general provider-specific channel inbox feed, so Agent triage does not claim unread Slack/Discord/email polling.',
    },
    connectedHost: {
      routesChecked: ['/api/deliveries', '/api/control-plane/messages', '/api/routes/bindings'],
      failures: [deliveriesResult, messagesResult, bindingsResult].filter((result): result is ConnectedHostRouteFailure => !result.ok).map(routeFailureView),
    },
    routes: {
      command: '/channels triage',
      deliveries: '/channels deliveries',
      readiness: '/channels attention',
      status: '/channels status',
      policies: '/channels policies',
      setupGuide: '/channels guide',
      modelRoute: 'channels action:"triage"',
      deliveryReceipts: 'channels action:"deliveries"',
      sendTool: 'agent_channel_send',
    },
    policy: 'Read-only channel triage. It never sends messages, mutates route bindings, repairs channels, retries jobs, or prints raw external addresses; every effect remains on an explicit confirmed route.',
  };
}

function deliveryTargetLine(target: Record<string, unknown>): string {
  const parts = [
    typeof target.kind === 'string' ? target.kind : 'target',
    typeof target.surfaceKind === 'string' ? target.surfaceKind : '',
    typeof target.routeId === 'string' ? `route=${target.routeId}` : '',
    typeof target.label === 'string' ? `label=${target.label}` : '',
    typeof target.address === 'string' ? target.address : '',
  ].filter(Boolean);
  return parts.join(' ');
}

export function formatAgentWorkspaceChannelTriage(triage: AgentWorkspaceChannelTriage): string {
  const readiness = triage.readiness;
  const deliveries = triage.deliveries;
  const messages = triage.surfaceMessages;
  const bindings = triage.routeBindings;
  const receipts = triage.receipts;
  const lines = [
    'Channel Triage',
    `  status: ${triage.status}`,
    `  summary: ${triage.summary}`,
    `  policy: ${triage.policy}`,
    `  inbox: ${triage.inboundFeed.status}; provider inbox feed ${triage.inboundFeed.providerInboxFeed}`,
    '',
    '  Readiness',
    `  ready: ${readiness.ready}/${readiness.totalChannels}; enabled: ${readiness.enabled}; needs config: ${readiness.needsConfig}; needs target: ${readiness.needsTarget}`,
  ];
  const attentionChannels = Array.isArray(readiness.attentionChannels) ? readiness.attentionChannels.filter(isRecord) : [];
  for (const channel of attentionChannels.slice(0, 6)) {
    lines.push(`  - ${readString(channel, 'label', readString(channel, 'channelId'))}: ${readString(channel, 'setupState')}; ${readString(channel, 'userRoute')}`);
  }
  if (attentionChannels.length === 0) lines.push('  no enabled channel setup blockers');

  lines.push('', '  Delivery Attempts');
  if (deliveries.state === 'unavailable') {
    lines.push(`  unavailable: ${deliveries.kind}; ${deliveries.message}`);
  } else {
    const totals = isRecord(deliveries.totals) ? deliveries.totals : {};
    lines.push(`  state: ${deliveries.state}; total: ${deliveries.totalAttempts}; attention: ${deliveries.attentionCount}; retry candidates: ${deliveries.retryCandidateCount}`);
    lines.push(`  totals: queued=${totals.queued ?? 0}; started=${totals.started ?? 0}; succeeded=${totals.succeeded ?? 0}; failed=${totals.failed ?? 0}; dead-lettered=${totals.deadLettered ?? 0}`);
    const retryCandidates = Array.isArray(deliveries.retryCandidates) ? deliveries.retryCandidates.filter(isRecord) : [];
    for (const attempt of retryCandidates.slice(0, 5)) {
      const target = isRecord(attempt.target) ? attempt.target : {};
      const error = readString(attempt, 'error');
      lines.push(`  - ${readString(attempt, 'id')}: ${readString(attempt, 'status')} ${deliveryTargetLine(target)}${error ? ` error=${error}` : ''} inspect=${readString(attempt, 'inspectRoute')}`);
    }
    if (retryCandidates.length === 0) lines.push('  no failed or dead-lettered delivery attempts reported');
  }

  lines.push('', '  Surface Messages');
  if (messages.state === 'unavailable') {
    lines.push(`  unavailable: ${messages.kind}; ${messages.message}`);
  } else {
    lines.push(`  state: ${messages.state}; total: ${messages.totalMessages}`);
    const visibleMessages = Array.isArray(messages.messages) ? messages.messages.filter(isRecord) : [];
    for (const message of visibleMessages.slice(0, 5)) {
      lines.push(`  - ${readString(message, 'surface')}: ${readString(message, 'level')} ${readString(message, 'title')}${readString(message, 'routeId') ? ` route=${readString(message, 'routeId')}` : ''}`);
    }
    if (visibleMessages.length === 0) lines.push('  no visible control-plane surface messages reported');
  }

  lines.push('', '  Route Bindings');
  if (bindings.state === 'unavailable') {
    lines.push(`  unavailable: ${bindings.kind}; ${bindings.message}`);
  } else {
    lines.push(`  state: ${bindings.state}; total: ${bindings.totalBindings}`);
    const routeRows = Array.isArray(bindings.bindings) ? bindings.bindings.filter(isRecord) : [];
    for (const binding of routeRows.slice(0, 5)) {
      lines.push(`  - ${readString(binding, 'id')}: ${readString(binding, 'surfaceKind')} ${readString(binding, 'kind')} external=${readString(binding, 'externalIdDigest')} sender=${readString(binding, 'principalLabel', UNKNOWN_PRINCIPAL_LABEL)}`);
    }
    if (routeRows.length === 0) lines.push('  no route bindings reported');
  }

  lines.push('', '  Agent Receipts');
  if (receipts.state === 'unavailable') {
    lines.push(`  unavailable: ${receipts.reason}`);
  } else {
    lines.push(`  state: ${receipts.state}; total: ${receipts.totalReceipts}`);
    const receiptRows = Array.isArray(receipts.receipts) ? receipts.receipts.filter(isRecord) : [];
    for (const receipt of receiptRows.slice(0, 5)) lines.push(`  - ${readString(receipt, 'line')}`);
    if (receiptRows.length === 0) lines.push('  no confirmed Agent channel sends recorded');
  }

  lines.push('', '  Next Routes');
  lines.push('  /channels attention');
  lines.push('  /channels deliveries');
  lines.push('  /channels status');
  lines.push('  channels action:"triage"');
  return lines.join('\n');
}
