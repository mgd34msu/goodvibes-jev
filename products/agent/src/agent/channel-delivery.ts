import type {
  ChannelDeliveryRequest,
  ChannelDeliveryRouter,
  ChannelDeliverySurfaceKind,
  ChannelDeliveryTarget,
} from '@goodvibes-jev/engine/sdk/platform/channels';
import {
  CardMaterialRefusedError,
  resolveDeliverySurfaceName,
  screenOutboundForCardMaterial,
} from './payments-channel-guard.ts';
import { isRoutineScheduleDeliverySurfaceKind } from './schedule-delivery-targets.ts';

type AgentChannelDeliveryRouter = Pick<ChannelDeliveryRouter, 'deliver' | 'listStrategies'>;
type AgentChannelDeliverySurfaceKind = ChannelDeliverySurfaceKind | 'telephony';
type AgentChannelDeliveryTarget = Omit<ChannelDeliveryTarget, 'surfaceKind'> & {
  readonly surfaceKind?: AgentChannelDeliverySurfaceKind;
};
type AgentChannelDeliveryRequest = Omit<ChannelDeliveryRequest, 'target'> & {
  readonly target: AgentChannelDeliveryTarget;
};

export interface AgentChannelDeliveryInput {
  readonly message: string;
  readonly title?: string;
  readonly channel?: string;
  readonly route?: string;
  readonly webhook?: string;
  readonly link?: string;
}

export interface AgentChannelDeliveryPreview {
  readonly message: string;
  readonly title: string;
  readonly target: AgentChannelDeliveryTarget;
  readonly request: AgentChannelDeliveryRequest;
}

export interface AgentChannelDeliveryResult {
  readonly responseId?: string;
  readonly message: string;
  readonly title: string;
  readonly target: AgentChannelDeliveryTarget;
  readonly strategyCount: number;
}

function readText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// The channel surfaces a schedule may deliver to are the same set an immediate
// send accepts, so both read the one list in schedule-delivery-targets.ts.
const isDeliverySurfaceKind: (value: string) => value is AgentChannelDeliverySurfaceKind =
  isRoutineScheduleDeliverySurfaceKind;

function parseChannelTarget(raw: string): AgentChannelDeliveryTarget {
  const [surfaceKind = '', routeId, label] = raw.split(':');
  if (!isDeliverySurfaceKind(surfaceKind)) {
    throw new Error(`Unsupported delivery channel "${surfaceKind}".`);
  }
  return {
    kind: 'surface',
    surfaceKind,
    ...(readText(routeId) ? { routeId: readText(routeId) } : {}),
    ...(readText(label) ? { label: readText(label) } : {}),
  };
}

function parseRouteTarget(raw: string): AgentChannelDeliveryTarget {
  const [routeId = '', label] = raw.split(':');
  const normalizedRouteId = readText(routeId);
  if (!normalizedRouteId) throw new Error('Route delivery target requires a route id.');
  return {
    kind: 'surface',
    routeId: normalizedRouteId,
    ...(readText(label) ? { label: readText(label) } : {}),
  };
}

function parseWebhookTarget(raw: string): AgentChannelDeliveryTarget {
  const normalized = readText(raw);
  if (!normalized) throw new Error('Webhook delivery target requires a URL.');
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    throw new Error('Webhook delivery target must be a valid http(s) URL.');
  }
  return { kind: 'webhook', address: normalized };
}

function parseLinkTarget(raw: string): AgentChannelDeliveryTarget {
  const normalized = readText(raw);
  if (!normalized) throw new Error('Link delivery target requires a URL or label.');
  return { kind: 'link', address: normalized };
}

function selectedTargetInputs(input: AgentChannelDeliveryInput): readonly string[] {
  return [input.channel, input.route, input.webhook, input.link].map(readText).filter((value): value is string => Boolean(value));
}

export function buildAgentChannelDeliveryPreview(input: AgentChannelDeliveryInput): AgentChannelDeliveryPreview {
  const message = readText(input.message);
  if (!message) throw new Error('Channel delivery message is required.');
  const targets = selectedTargetInputs(input);
  if (targets.length === 0) throw new Error('Choose one delivery target: channel, route, webhook, or link.');
  if (targets.length > 1) throw new Error('Choose exactly one delivery target.');

  const channel = readText(input.channel);
  const route = readText(input.route);
  const webhook = readText(input.webhook);
  const link = readText(input.link);
  const target = channel
    ? parseChannelTarget(channel)
    : route
      ? parseRouteTarget(route)
      : webhook
        ? parseWebhookTarget(webhook)
        : parseLinkTarget(link ?? '');
  const title = readText(input.title) ?? 'GoodVibes Agent message';
  return {
    message,
    title,
    target,
    request: {
      target,
      body: message,
      title,
      jobId: 'agent-channel-send',
      runId: `agent-channel-send-${Date.now()}`,
      status: 'completed',
      includeLinks: true,
      metadata: {
        product: 'goodvibes-agent',
        source: 'agent-channel-send',
      },
    },
  };
}

/**
 * How many channel deliveries are awaiting their strategy right now.
 *
 * Every send in the agent funnels through deliverAgentChannelMessage below, so
 * one counter here is the whole in-flight picture. It exists because a
 * long-running agent may replace its own binary and restart while it is
 * running: "is this agent busy?" has to include a message that has left the
 * conversation but has not reached the person yet, or a self-update could
 * restart the process between the send and its delivery.
 */
let inFlightDeliveries = 0;

export function channelDeliveriesInFlight(): number {
  return inFlightDeliveries;
}

export async function deliverAgentChannelMessage(
  router: AgentChannelDeliveryRouter,
  input: AgentChannelDeliveryInput,
): Promise<AgentChannelDeliveryResult> {
  const preview = buildAgentChannelDeliveryPreview(input);

  // Card material never leaves this program toward a remote channel. This is
  // the single outbound funnel (see channelDeliveriesInFlight above), so one
  // check here covers every send: a model composing a message, a routine, a
  // person answering a prompt in the wrong place.
  //
  // It refuses BEFORE router.deliver, so nothing reaches a provider, and it
  // throws rather than returning a result, so no caller can treat a refusal as
  // a successful send. The thrown message is the SDK's refusal wording and
  // contains no part of what was refused, see agent/payments-channel-guard.ts.
  const refusal = await screenOutboundForCardMaterial({
    surface: resolveDeliverySurfaceName(preview.target),
    message: preview.message,
    title: preview.title,
  });
  if (refusal) throw new CardMaterialRefusedError(refusal);

  inFlightDeliveries += 1;
  let responseId: string | undefined;
  try {
    responseId = await router.deliver(preview.request as ChannelDeliveryRequest);
  } finally {
    // Decremented on the failure path too: a delivery that threw is finished,
    // and a leaked counter would pin the agent "busy" forever.
    inFlightDeliveries = Math.max(0, inFlightDeliveries - 1);
  }
  return {
    responseId,
    message: preview.message,
    title: preview.title,
    target: preview.target,
    strategyCount: router.listStrategies().length,
  };
}

function formatTarget(target: AgentChannelDeliveryTarget): string {
  if (target.kind === 'surface') {
    const base = target.surfaceKind ?? 'route';
    const details = [
      target.routeId ? `route ${target.routeId}` : '',
      target.label ? `label ${target.label}` : '',
    ].filter(Boolean);
    return `${base}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
  }
  return target.address ? `${target.kind} ${target.address}` : target.kind;
}

export function formatAgentChannelDeliveryPreview(preview: AgentChannelDeliveryPreview, strategyCount: number): string {
  return [
    'Agent channel delivery preview',
    `  title ${preview.title}`,
    `  target ${formatTarget(preview.target)}`,
    `  strategies ${strategyCount}`,
    `  message ${preview.message}`,
    '  policy external delivery requires an explicit user request and confirmation',
  ].join('\n');
}

export function formatAgentChannelDeliveryResult(result: AgentChannelDeliveryResult): string {
  return [
    'Agent channel delivery sent',
    `  title ${result.title}`,
    `  target ${formatTarget(result.target)}`,
    `  strategies ${result.strategyCount}`,
    ...(result.responseId ? [`  response ${result.responseId}`] : []),
  ].join('\n');
}
