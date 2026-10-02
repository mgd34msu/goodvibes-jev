import { createHash } from 'node:crypto';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessNotificationArgs {
  readonly notificationTargetId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface NotificationTargetDescriptor {
  readonly id: string;
  readonly index: number;
  readonly fingerprint: string;
  readonly validUrl: boolean;
  readonly protocol?: string;
  readonly host?: string;
  readonly pathDepth?: number;
  readonly hasQuery?: boolean;
}

type NotificationTargetLookupSource = 'notificationTargetId' | 'target' | 'query';

type NotificationTargetResolution =
  | { readonly status: 'found'; readonly target: Record<string, unknown> }
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

function readConfiguredWebhookUrls(context: CommandContext): readonly string[] {
  const notifications = context.platform.configManager.getCategory('notifications') as { readonly webhookUrls?: unknown } | null;
  const urls = Array.isArray(notifications?.webhookUrls) ? notifications.webhookUrls : [];
  return urls
    .filter((url): url is string => typeof url === 'string')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function pathDepth(pathname: string): number {
  return pathname
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .length;
}

function describeWebhookUrl(url: string, index: number): NotificationTargetDescriptor {
  const id = `notification-target-${index + 1}`;
  try {
    const parsed = new URL(url);
    return {
      id,
      index: index + 1,
      fingerprint: fingerprint(url),
      validUrl: true,
      protocol: parsed.protocol.replace(/:$/, ''),
      host: parsed.host,
      pathDepth: pathDepth(parsed.pathname),
      hasQuery: parsed.search.length > 0,
    };
  } catch {
    return {
      id,
      index: index + 1,
      fingerprint: fingerprint(url),
      validUrl: false,
    };
  }
}

function notificationTargets(context: CommandContext): readonly NotificationTargetDescriptor[] {
  return readConfiguredWebhookUrls(context).map(describeWebhookUrl);
}

function lookupFromArgs(args: AgentHarnessNotificationArgs): { readonly source: NotificationTargetLookupSource; readonly input: string } | null {
  const notificationTargetId = readString(args.notificationTargetId);
  if (notificationTargetId) return { source: 'notificationTargetId', input: notificationTargetId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function targetSearchText(target: NotificationTargetDescriptor): string {
  return [
    target.id,
    String(target.index),
    target.fingerprint,
    target.protocol ?? '',
    target.host ?? '',
    target.validUrl ? 'valid' : 'invalid',
    target.hasQuery ? 'query' : 'no-query',
  ].join('\n').toLowerCase();
}

function describeTargetCandidate(target: NotificationTargetDescriptor): Record<string, unknown> {
  return {
    notificationTargetId: target.id,
    index: target.index,
    fingerprint: target.fingerprint,
    validUrl: target.validUrl,
    ...(target.host ? { host: target.host } : {}),
    modelRoute: notificationTargetModelRoute(),
  };
}

function notificationTargetModelRoute(): string {
  return 'agent_notify or agent_harness mode:"notification_target"';
}

function describeTarget(
  target: NotificationTargetDescriptor,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    id: target.id,
    index: target.index,
    fingerprint: target.fingerprint,
    validUrl: target.validUrl,
    ...(target.protocol ? { protocol: target.protocol } : {}),
    ...(target.host ? { host: target.host } : {}),
    ...(target.pathDepth !== undefined ? { pathDepth: target.pathDepth } : {}),
    ...(target.hasQuery !== undefined ? { hasQuery: target.hasQuery } : {}),
    value: '<redacted>',
    modelRoute: notificationTargetModelRoute(),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters
      ? {
        policy: {
          effect: 'read-only',
          values: 'Full webhook URLs are not returned because they can contain bearer tokens or secret path/query values.',
          delivery: 'Use agent_notify only for one explicit, confirmed notification requested by the user.',
          management: 'Use confirmed /notify mirrors only when the user explicitly asks to add, remove, clear, test, or send notification targets.',
        },
        modelAccess: {
          sendTool: 'agent_notify',
          listCommand: '/notify list',
          addCommand: '/notify add <url> --yes',
          removeCommand: '/notify remove <url> --yes',
          clearCommand: '/notify clear --yes',
          testCommand: '/notify test --yes',
          settingsCategory: 'notifications.webhookUrls',
          targetValueRequiredForRemove: true,
          targetValuePolicy: 'Ask the user for the exact webhook URL before removing one target; do not infer it from redacted metadata.',
        },
      }
      : {
        summary: previewHarnessText(`${target.validUrl ? 'valid' : 'invalid'} notification webhook target ${target.index}`),
      }),
  };
}

export function notificationTargetCatalogStatus(context: CommandContext): Record<string, unknown> {
  const targets = notificationTargets(context);
  return {
    modes: ['notifications', 'notification_target'],
    targets: targets.length,
    validTargets: targets.filter((target) => target.validUrl).length,
    invalidTargets: targets.filter((target) => !target.validUrl).length,
    readOnly: true,
    deliveryTool: 'agent_notify',
    values: 'redacted',
  };
}

export function listHarnessNotificationTargets(context: CommandContext, args: AgentHarnessNotificationArgs): Record<string, unknown> {
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const targets = notificationTargets(context);
  const filtered = targets
    .filter((target) => !query || targetSearchText(target).includes(query))
    .slice(0, readLimit(args.limit, 100));
  return {
    targets: filtered.map((target) => describeTarget(target, { includeParameters })),
    returned: filtered.length,
    total: targets.length,
    validTargets: targets.filter((target) => target.validUrl).length,
    invalidTargets: targets.filter((target) => !target.validUrl).length,
    policy: 'Read-only notification target catalog. Full webhook values are redacted; sends and target management require explicit confirmation through the owning tool or slash-command mirror.',
  };
}

export function describeHarnessNotificationTarget(
  context: CommandContext,
  args: AgentHarnessNotificationArgs,
): NotificationTargetResolution {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'notification_target requires notificationTargetId, target, or query. Use mode:"notifications" to inspect configured redacted target refs.',
    };
  }
  const targets = notificationTargets(context);
  const normalized = lookup.input.toLowerCase();
  const exact = targets.find((target) => target.id === lookup.input || String(target.index) === lookup.input || target.fingerprint === lookup.input);
  if (exact) return { status: 'found', target: describeTarget(exact, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'id-or-index' } }) };
  const searched = targets.filter((target) => targetSearchText(target).includes(normalized));
  if (searched.length === 1) {
    return { status: 'found', target: describeTarget(searched[0]!, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' } }) };
  }
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(describeTargetCandidate),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown notification target ${lookup.input}. Use mode:"notifications" to inspect configured redacted target refs.`,
  };
}
