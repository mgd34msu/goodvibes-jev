import type { CommandRegistry } from '../command-registry.ts';
import type { CommandContext } from '../command-registry.ts';
import type { AgentWorkspaceChannelSetupGuide, AgentWorkspaceChannelStatus } from '../agent-workspace-channels.ts';
import { buildAgentWorkspaceChannelTriage, formatAgentWorkspaceChannelTriage } from '../agent-workspace-channel-triage.ts';
import { buildAgentWorkspaceChannelSetupGuide, buildAgentWorkspaceChannels } from '../agent-workspace-channels.ts';
import { fetchConnectedHostReadOnlyRoute, formatConnectedHostRouteFailure } from '../connected-host-routes.ts';
import {
  buildAgentChannelDeliveryPreview,
  deliverAgentChannelMessage,
  formatAgentChannelDeliveryPreview,
  formatAgentChannelDeliveryResult,
} from '../../agent/channel-delivery.ts';
import {
  formatAgentChannelDeliveryReceiptLine,
  readAgentChannelDeliveryReceipts,
  recordAgentChannelDeliveryReceipt,
} from '../../agent/channel-delivery-receipts.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';

type ChannelFilter = 'all' | 'ready' | 'attention';
type JsonRecord = Record<string, unknown>;

interface ChannelSendArgs {
  readonly message: string;
  readonly title?: string;
  readonly channel?: string;
  readonly route?: string;
  readonly webhook?: string;
  readonly link?: string;
  readonly yes: boolean;
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: JsonRecord, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function readBoolean(record: JsonRecord, key: string, fallback = false): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readLimitValue(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function readRecordArray(record: JsonRecord, key: string): readonly JsonRecord[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readFlagValue(args: readonly string[], index: number, flag: string, errors: string[]): string | null {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    errors.push(`${flag} requires a value.`);
    return null;
  }
  return value;
}

function parseChannelSendArgs(args: readonly string[]): ChannelSendArgs {
  const parsed = stripYesFlag([...args]);
  const errors: string[] = [];
  const messageParts: string[] = [];
  let title: string | undefined;
  let channel: string | undefined;
  let route: string | undefined;
  let webhook: string | undefined;
  let link: string | undefined;

  for (let index = 0; index < parsed.rest.length; index += 1) {
    const arg = parsed.rest[index];
    if (arg === '--title' || arg === '--message' || arg === '--channel' || arg === '--route' || arg === '--webhook' || arg === '--link') {
      const value = readFlagValue(parsed.rest, index, arg, errors);
      index += 1;
      if (!value) continue;
      if (arg === '--title') title = value;
      else if (arg === '--message') messageParts.push(value);
      else if (arg === '--channel') channel = value;
      else if (arg === '--route') route = value;
      else if (arg === '--webhook') webhook = value;
      else link = value;
    } else if (arg?.startsWith('--')) {
      errors.push(`Unknown channel send flag ${arg}`);
    } else if (arg) {
      messageParts.push(arg);
    }
  }

  const message = messageParts.join(' ').trim();
  if (!message) errors.push('Channel send message is required.');
  return {
    message,
    ...(title ? { title } : {}),
    ...(channel ? { channel } : {}),
    ...(route ? { route } : {}),
    ...(webhook ? { webhook } : {}),
    ...(link ? { link } : {}),
    yes: parsed.yes,
    errors,
  };
}

function formatChannelDeliveryReceipts(context: CommandContext, limitArg?: string): string {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return [
      'Channel Delivery Receipts',
      '  status unavailable',
      '  reason Agent shell paths are unavailable in this runtime.',
    ].join('\n');
  }
  const limit = readLimitValue(limitArg, 10);
  const snapshot = readAgentChannelDeliveryReceipts(shellPaths);
  const receipts = snapshot.receipts.slice(0, limit);
  return [
    'Channel Delivery Receipts',
    `  path ${snapshot.path}`,
    `  total ${snapshot.receipts.length}`,
    `  returned ${receipts.length}`,
    `  status ${snapshot.parseError ? 'attention' : snapshot.exists ? 'ready' : 'empty'}`,
    ...(snapshot.parseError ? [`  parse error ${snapshot.parseError}`] : []),
    '  policy confirmed sends only; message bodies and secret-bearing target values are bounded or redacted',
    ...receipts.map((receipt) => `  ${formatAgentChannelDeliveryReceiptLine(receipt)}`),
    ...(receipts.length === 0 ? ['  no channel deliveries recorded yet'] : []),
  ].join('\n');
}

function formatChannelLine(channel: AgentWorkspaceChannelStatus): string {
  const missing = channel.missingRequiredKeys.length > 0
    ? ` missing=${channel.missingRequiredKeys.join('|')}`
    : '';
  const target = channel.configuredDefaultTargetKeys.length > 0
    ? ` target=${channel.configuredDefaultTargetKeys.join('|')}`
    : channel.defaultTargetKeys.length > 0
      ? ` target=missing(${channel.defaultTargetKeys.join('|')})`
      : ' target=not-required';
  return [
    `  ${channel.label}: ${channel.setupState}`,
    `ready=${channel.ready ? 'yes' : 'no'}`,
    `delivery=${channel.delivery}`,
    `risk=${channel.risk}`,
    target,
    missing,
  ].join(' ');
}

function filterChannels(
  channels: readonly AgentWorkspaceChannelStatus[],
  filter: ChannelFilter,
): readonly AgentWorkspaceChannelStatus[] {
  if (filter === 'ready') return channels.filter((channel) => channel.ready);
  if (filter === 'attention') return channels.filter((channel) => channel.enabled && channel.setupState !== 'ready');
  return channels;
}

function printChannelSummary(
  print: (message: string) => void,
  channels: readonly AgentWorkspaceChannelStatus[],
  filter: ChannelFilter,
): void {
  const ready = channels.filter((channel) => channel.ready);
  const enabled = channels.filter((channel) => channel.enabled);
  const needsTarget = channels.filter((channel) => channel.setupState === 'needs-target');
  const needsConfig = channels.filter((channel) => channel.setupState === 'needs-config');
  const filtered = filterChannels(channels, filter);
  const title = filter === 'ready'
    ? 'Channel Readiness: Ready'
    : filter === 'attention'
      ? 'Channel Readiness: Needs Attention'
      : 'Channel Readiness';
  const lines: string[] = [
    title,
    `  ready: ${ready.length}/${channels.length}`,
    `  enabled: ${enabled.length}/${channels.length}`,
    `  needs target: ${needsTarget.length}`,
    `  needs config: ${needsConfig.length}`,
    '  policy: read-only inspection; sends require explicit user action and Agent policy',
    '  details: /channels show <id>',
    '',
    ...(filtered.length > 0
      ? filtered.map(formatChannelLine)
      : [`  No ${filter === 'ready' ? 'ready' : 'attention'} channels matched.`]),
  ];
  print(lines.join('\n'));
}

function printChannelDetail(
  print: (message: string) => void,
  channel: AgentWorkspaceChannelStatus,
): void {
  print([
    `Channel: ${channel.label} (${channel.id})`,
    `  state: ${channel.setupState}`,
    `  enabled: ${channel.enabled ? 'yes' : 'no'}`,
    `  ready: ${channel.ready ? 'yes' : 'no'}`,
    `  delivery: ${channel.delivery}`,
    `  risk: ${channel.risk} (${channel.riskLabel})`,
    `  required config keys: ${channel.requiredKeys.join(', ') || 'none'}`,
    `  missing config keys: ${channel.missingRequiredKeys.join(', ') || 'none'}`,
    `  default target keys: ${channel.defaultTargetKeys.join(', ') || 'not required'}`,
    `  configured target keys: ${channel.configuredDefaultTargetKeys.join(', ') || 'none'}`,
    `  next: ${channel.nextStep}`,
    '  policy: this command never prints secret values and never sends messages',
  ].join('\n'));
}

function formatGuideStepStatus(status: string): string {
  if (status === 'complete') return '[x]';
  if (status === 'current') return '[>]';
  return '[ ]';
}

function formatChannelSetupGuide(guide: AgentWorkspaceChannelSetupGuide): string {
  const lines = [
    'Channel Setup Guide',
    `  state: ${guide.status}`,
    `  progress: ${guide.progressLabel}`,
    `  current channel: ${guide.currentChannelLabel ?? 'choose a channel'}${guide.currentChannelId ? ` (${guide.currentChannelId})` : ''}`,
    `  summary: ${guide.summary}`,
    `  ready: ${guide.readyChannels}/${guide.totalChannels}; enabled: ${guide.enabledChannels}; attention: ${guide.attentionChannels}; targets: ${guide.configuredTargets}`,
    `  policy: ${guide.policy}`,
    '',
    '  Steps',
  ];
  for (const step of guide.steps) {
    lines.push(`  ${formatGuideStepStatus(step.status)} ${step.label}: ${step.userRoute}`);
    if (step.status === 'current') lines.push(`      next: ${step.detail}`);
  }
  lines.push('', '  Channel order');
  for (const channel of guide.channels.slice(0, 10)) {
    lines.push(`  - ${channel.label}: ${channel.setupState}; ${channel.summary}; guide ${channel.guideRoute}`);
  }
  if (guide.channels.length > 10) lines.push(`  ${guide.channels.length - 10} more channel(s) omitted.`);
  return lines.join('\n');
}

function formatChannelAccounts(body: unknown): string {
  const root = isRecord(body) ? body : {};
  const accounts = readRecordArray(root, 'accounts');
  const lines = [
    'Channel Accounts',
    `  accounts ${accounts.length}`,
    '  policy read-only account posture; secret values are never shown',
    '',
  ];
  if (accounts.length === 0) return [...lines, '  No channel accounts reported by connected host.'].join('\n');
  for (const account of accounts.slice(0, 20)) {
    const surface = readString(account, 'surface', 'unknown');
    const accountId = readString(account, 'accountId', '');
    const authState = readString(account, 'authState', readString(account, 'state', 'unknown'));
    const configured = readBoolean(account, 'configured') ? 'configured' : 'not-configured';
    const linked = readBoolean(account, 'linked') ? 'linked' : 'not-linked';
    const secretFields = readRecordArray(account, 'secrets')
      .map((secret) => readString(secret, 'field', 'secret'))
      .join(', ') || 'none';
    lines.push(`  ${surface}${accountId ? `/${accountId}` : ''}: ${configured}; ${linked}; auth=${authState}; secret refs=${secretFields === 'none' ? 'none' : secretFields.split(', ').map((field) => `${field}:config`).join(',')}`);
  }
  if (accounts.length > 20) lines.push(`  ${accounts.length - 20} more account(s) omitted.`);
  return lines.join('\n');
}

function formatChannelPolicies(body: unknown): string {
  const root = isRecord(body) ? body : {};
  const policies = readRecordArray(root, 'policies');
  const lines = [
    'Channel Policies',
    `  policies ${policies.length}`,
    '  policy read-only policy posture; use exact confirmed commands for changes',
    '',
  ];
  if (policies.length === 0) return [...lines, '  No channel policies reported by connected host.'].join('\n');
  for (const policy of policies.slice(0, 20)) {
    const surface = readString(policy, 'surface', 'unknown');
    const direct = readBoolean(policy, 'allowDirectMessages') ? 'direct=yes' : 'direct=no';
    const users = Array.isArray(policy.allowlistUserIds) ? policy.allowlistUserIds.length : 0;
    const groups = Array.isArray(policy.allowlistGroupIds) ? policy.allowlistGroupIds.length : 0;
    const groupPolicies = readRecordArray(policy, 'groupPolicies').length;
    lines.push(`  ${surface}: ${direct}; allowlist users=${users}; groups=${groups}; group policies=${groupPolicies}`);
  }
  if (policies.length > 20) lines.push(`  ${policies.length - 20} more policy record(s) omitted.`);
  return lines.join('\n');
}

function formatChannelStatus(body: unknown): string {
  const root = isRecord(body) ? body : {};
  const channels = readRecordArray(root, 'channels');
  const lines = [
    'Connected Channel Status',
    `  channels ${channels.length}`,
    '  policy read-only connected-host status',
    '',
  ];
  if (channels.length === 0) return [...lines, '  No connected channel status reported.'].join('\n');
  for (const channel of channels.slice(0, 20)) {
    const surface = readString(channel, 'surface', 'unknown');
    const state = readString(channel, 'state', readString(channel, 'status', 'unknown'));
    const enabled = readBoolean(channel, 'enabled') ? 'enabled' : 'disabled';
    const ready = readBoolean(channel, 'ready') ? 'ready' : 'not-ready';
    lines.push(`  ${surface}: ${enabled}; ${ready}; state=${state}`);
  }
  if (channels.length > 20) lines.push(`  ${channels.length - 20} more channel(s) omitted.`);
  return lines.join('\n');
}

function formatChannelDoctor(surface: string, body: unknown): string {
  const root = isRecord(body) ? body : {};
  const checks = readRecordArray(root, 'checks');
  const repairActions = readRecordArray(root, 'repairActions');
  const lines = [
    `Channel Doctor: ${readString(root, 'surface', surface)}`,
    `  checks ${checks.length}`,
    `  repair actions ${repairActions.length}`,
    '  policy read-only doctor report; repair actions are not run here',
    '',
  ];
  if (checks.length === 0) lines.push('  No doctor checks reported.');
  for (const check of checks.slice(0, 20)) {
    lines.push(`  ${readString(check, 'id', 'check')}: ${readString(check, 'status', 'unknown')}`);
  }
  if (repairActions.length > 0) {
    lines.push('', '  Available repair action ids:');
    for (const action of repairActions.slice(0, 12)) lines.push(`  - ${readString(action, 'id', 'action')}`);
  }
  return lines.join('\n');
}

function formatChannelSetup(surface: string, body: unknown): string {
  const root = isRecord(body) ? body : {};
  const fields = readRecordArray(root, 'fields');
  const secretTargets = readRecordArray(root, 'secretTargets');
  const lines = [
    `Channel Setup Schema: ${readString(root, 'surface', surface)}`,
    `  version ${typeof root.version === 'number' ? root.version : 'unknown'}`,
    `  fields ${fields.length}`,
    `  secret targets ${secretTargets.length}`,
    '  policy read-only setup form; no credentials or values are printed',
    '',
  ];
  if (fields.length > 0) {
    lines.push('  Fields');
    for (const field of fields.slice(0, 20)) lines.push(`  - ${readString(field, 'id', 'field')}`);
  }
  if (secretTargets.length > 0) {
    lines.push('', '  Secret targets');
    for (const target of secretTargets.slice(0, 12)) {
      const required = readBoolean(target, 'required') ? 'required' : 'optional';
      lines.push(`  - ${readString(target, 'id', 'secret')} (${required})`);
    }
  }
  return lines.join('\n');
}

async function printReadOnlyChannelRoute(
  context: CommandContext,
  title: string,
  route: string,
  format: (body: unknown) => string,
): Promise<void> {
  const result = await fetchConnectedHostReadOnlyRoute(context, route);
  if (!result.ok) {
    context.print(formatConnectedHostRouteFailure(title, result, 'read-only; no channel send/action route was called'));
    return;
  }
  context.print(format(result.body));
}

export function registerChannelsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'channels',
    aliases: ['channel'],
    description: 'Inspect Agent channel readiness or send an explicitly confirmed delivery message',
    hidden: true,
    usage: '[list|readiness|ready|attention|triage [limit]|guide [id]|show <id>|deliveries [limit]|send --channel <id> --message <text> --yes|accounts|policies|status|doctor <id>|setup <id>]',
    argsHint: 'list|readiness|ready|attention|triage|guide|show|deliveries|send|accounts|policies|status|doctor|setup',
    async handler(args, ctx) {
      const channels = buildAgentWorkspaceChannels(ctx);
      const subcommand = (args[0] ?? 'readiness').trim().toLowerCase();

      if (subcommand === 'list' || subcommand === 'readiness') {
        printChannelSummary(ctx.print, channels, 'all');
        return;
      }

      if (subcommand === 'ready') {
        printChannelSummary(ctx.print, channels, 'ready');
        return;
      }

      if (subcommand === 'attention' || subcommand === 'issues') {
        printChannelSummary(ctx.print, channels, 'attention');
        return;
      }

      if (subcommand === 'guide' || subcommand === 'setup-guide') {
        const channelId = args[1]?.trim();
        ctx.print(formatChannelSetupGuide(buildAgentWorkspaceChannelSetupGuide(channels, channelId ? { channelId } : {})));
        return;
      }

      if (subcommand === 'triage' || subcommand === 'inbox') {
        ctx.print(formatAgentWorkspaceChannelTriage(await buildAgentWorkspaceChannelTriage(ctx, { limit: args[1] })));
        return;
      }

      if (subcommand === 'show') {
        const channelId = args[1]?.trim().toLowerCase();
        if (!channelId) {
          ctx.print('Usage: /channels show <id>');
          return;
        }
        const channel = channels.find((entry) => entry.id.toLowerCase() === channelId || entry.label.toLowerCase() === channelId);
        if (!channel) {
          ctx.print(`Unknown channel ${channelId}\nUse /channels list to see available channel ids.`);
          return;
        }
        printChannelDetail(ctx.print, channel);
        return;
      }

      if (subcommand === 'deliveries' || subcommand === 'receipts') {
        ctx.print(formatChannelDeliveryReceipts(ctx, args[1]));
        return;
      }

      if (subcommand === 'send') {
        const router = ctx.platform.channelDeliveryRouter;
        if (!router) {
          ctx.print('Channel delivery is not available in this Agent runtime.');
          return;
        }
        const parsed = parseChannelSendArgs(args.slice(1));
        if (parsed.errors.length > 0) {
          ctx.print(`[channels] ${parsed.errors.join('\n[channels] ')}`);
          return;
        }
        let preview: ReturnType<typeof buildAgentChannelDeliveryPreview>;
        try {
          preview = buildAgentChannelDeliveryPreview(parsed);
        } catch (error) {
          ctx.print(`[channels] ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (!parsed.yes) {
          ctx.print(formatAgentChannelDeliveryPreview(preview, router.listStrategies().length));
          requireYesFlag(ctx, 'send a channel delivery message', '/channels send --channel <surface[:route[:label]]> --message <text> --yes');
          return;
        }
        try {
          const result = await deliverAgentChannelMessage(router, parsed);
          const lines = [formatAgentChannelDeliveryResult(result)];
          if (ctx.workspace?.shellPaths) {
            try {
              const receipt = recordAgentChannelDeliveryReceipt(ctx.workspace.shellPaths, {
                source: 'command',
                deliveryInput: parsed,
                result,
              });
              lines.push(`  receipt ${receipt.id}`);
            } catch (receiptError) {
              lines.push(`  receipt unavailable ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`);
            }
          }
          ctx.print(lines.join('\n'));
        } catch (error) {
          ctx.print(`[channels] Send failed ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (subcommand === 'accounts') {
        await printReadOnlyChannelRoute(ctx, 'Channel accounts', '/api/channels/accounts', formatChannelAccounts);
        return;
      }

      if (subcommand === 'policies') {
        await printReadOnlyChannelRoute(ctx, 'Channel policies', '/api/channels/policies', formatChannelPolicies);
        return;
      }

      if (subcommand === 'status') {
        await printReadOnlyChannelRoute(ctx, 'Channel status', '/api/channels/status', formatChannelStatus);
        return;
      }

      if (subcommand === 'doctor' || subcommand === 'setup') {
        const channelId = args[1]?.trim().toLowerCase();
        if (!channelId) {
          ctx.print(`Usage: /channels ${subcommand} <id>`);
          return;
        }
        const encoded = encodeURIComponent(channelId);
        if (subcommand === 'doctor') {
          await printReadOnlyChannelRoute(ctx, 'Channel doctor', `/api/channels/doctor/${encoded}`, (body) => formatChannelDoctor(channelId, body));
          return;
        }
        await printReadOnlyChannelRoute(ctx, 'Channel setup', `/api/channels/setup/${encoded}`, (body) => formatChannelSetup(channelId, body));
        return;
      }

      ctx.print('Usage: /channels [list|readiness|ready|attention|triage [limit]|guide [id]|show <id>|deliveries [limit]|send --channel <id> --message <text> --yes|accounts|policies|status|doctor <id>|setup <id>]');
    },
  });
}
