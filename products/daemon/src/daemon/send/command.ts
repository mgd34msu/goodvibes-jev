/** Standalone explicit send, adapted from goodvibes-daemon 254699bf. */
import { randomUUID } from 'node:crypto';
import { isDeclaredSecretBearingConfigKey, type ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import { operations } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { findSendChannel, readChannelReadiness, resolveDefaultChannel, SEND_CHANNELS } from './channels.js';
import { describeSendFailure } from './failure-text.js';
import { inertBodyFor } from './inert-text.js';

export type SendDeliver = (request: ChannelDeliveryRequest) => Promise<string | undefined>;
export interface SendCommandResult { readonly lines: readonly string[]; readonly exitCode: number }
export interface SendCommandDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  /** This port acquires the actual stack lazily on the first admitted send. */
  readonly deliver: SendDeliver;
  readonly readStdin: () => Promise<string>;
  readonly stdinIsTty: boolean;
  readonly newRunId?: () => string;
}
export interface ParsedSendArgs {
  readonly channel: string | null;
  readonly to: string | null;
  readonly title: string | null;
  readonly list: boolean;
  readonly words: readonly string[];
}
export type PreparedSendCommand = { readonly kind: 'result'; readonly result: SendCommandResult }
  | { readonly kind: 'send'; readonly args: ParsedSendArgs };
const USAGE = [
  'Usage: goodvibes-daemon send [MESSAGE...] [--channel <id>] [--to <address>] [--title <text>] [--list]',
  'Read MESSAGE from stdin when no argument is given. Use -- before text beginning with a dash.',
  'With no --channel, exactly one enabled channel with a configured destination is required.',
  '--list shows configured destinations; credential-bearing destinations are withheld.',
  'Requests use each surface’s markup escaping and canonical delivery gates.',
  'Success reports acceptance of the send request, not confirmed arrival at the recipient.',
].join('\n');
const answer = (exitCode: number, ...lines: string[]): SendCommandResult => ({ exitCode, lines });

/** Run before reading configuration/stdin or acquiring any delivery owner. */
export function prepareSendCommand(argv: readonly string[]): PreparedSendCommand {
  let channel: string | null = null; let to: string | null = null; let title: string | null = null;
  let list = false; let help = false; let ended = false;
  const words: string[] = []; const errors: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (ended) { words.push(arg); continue; }
    if (arg === '--') { ended = true; continue; }
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--list') { list = true; continue; }
    const flag = arg.split('=', 1)[0]!;
    if (['--channel', '-c', '--to', '--title'].includes(flag)) {
      const equal = arg.indexOf('=');
      const value = equal >= 0 ? arg.slice(equal + 1) : argv[i + 1];
      if (value === undefined || value.length === 0 || (equal < 0 && (value.startsWith('--') || value === '-c' || value === '-h'))) {
        errors.push(`${flag} needs a value.`); continue;
      }
      if (equal < 0) i += 1;
      if (flag === '--channel' || flag === '-c') channel = value;
      else if (flag === '--to') to = value;
      else title = value;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') { errors.push('Unknown send option.'); continue; }
    words.push(arg);
  }
  if (list && (words.length > 0 || channel !== null || to !== null || title !== null)) errors.push('--list cannot be combined with a message or destination options.');
  if (errors.length) return { kind: 'result', result: answer(2, ...errors, '', USAGE) };
  if (help) return { kind: 'result', result: answer(0, USAGE) };
  return { kind: 'send', args: { channel, to, title, list, words } };
}

function renderChannelList(config: Pick<ConfigManager, 'get'>): string[] {
  const lines = ['Configured send channels (credentials and provider availability are not verified):'];
  for (const entry of readChannelReadiness(config)) {
    const destination = entry.destination === null ? `not set (${entry.channel.destinationKey})`
      : isDeclaredSecretBearingConfigKey(entry.channel.destinationKey) ? '[configured; withheld]' : entry.destination;
    lines.push(`${entry.channel.id}: ${entry.enabled ? 'on' : 'off'}; ${entry.channel.addressLabel}: ${destination}`);
  }
  const resolution = resolveDefaultChannel(config);
  lines.push(resolution.kind === 'resolved' ? `Default: ${resolution.channel.id}.`
    : resolution.kind === 'none' ? 'No default channel is configured.'
    : 'Multiple channels qualify; --channel is required.');
  return lines;
}

export async function runPreparedSendCommand(args: ParsedSendArgs, deps: SendCommandDeps): Promise<SendCommandResult> {
  if (args.list) return answer(0, ...renderChannelList(deps.configManager));
  const resolution = args.channel === null ? resolveDefaultChannel(deps.configManager) : null;
  const channel = args.channel === null
    ? resolution?.kind === 'resolved' ? resolution.channel : undefined
    : findSendChannel(args.channel);
  if (!channel) return answer(2,
    args.channel !== null ? 'Unknown send channel.' : resolution?.kind === 'ambiguous'
      ? 'Multiple enabled channels have destinations; --channel is required.' : 'No enabled channel has a configured destination.',
    `Known channels: ${SEND_CHANNELS.map((entry) => entry.id).join(', ')}.`);
  if (deps.configManager.get(channel.enabledKey) !== true) return answer(1, `${channel.label} is disabled; nothing was sent.`, `Setting: ${channel.enabledKey}.`);
  const missing = operations.getMissingSurfaceFeatureFlags(deps.configManager, channel.id);
  if (missing.length) return answer(1, `${channel.label} delivery is disabled; nothing was sent.`,
    `Required settings: ${operations.surfaceFeatureGateSettingsKeys(missing).join(', ')}.`);
  if (args.to !== null && args.to.trim().length === 0) return answer(2, '--to needs a nonempty destination.');
  let message = args.words.join(' ');
  if (message.trim().length === 0) {
    if (deps.stdinIsTty) return answer(2, 'No message given. Pass an argument or pipe text on stdin.');
    try { message = await deps.readStdin(); }
    catch { return answer(1, 'Could not read the message from stdin; nothing was sent.'); }
  }
  if (message.trim().length === 0) return answer(2, 'The message was empty; nothing was sent.');
  const title = inertBodyFor(channel.surfaceKind, args.title ?? 'GoodVibes');
  const request: ChannelDeliveryRequest = {
    target: { kind: 'surface', surfaceKind: channel.surfaceKind, label: title, ...(args.to === null ? {} : { address: args.to }) },
    body: inertBodyFor(channel.surfaceKind, message), title,
    jobId: 'goodvibes-daemon-send', runId: deps.newRunId?.() ?? `cli-send-${randomUUID()}`,
    includeLinks: false, allowDuplicate: true,
  };
  try {
    // Await the real owner. No timeout race or retry can report ahead of the request.
    await deps.deliver(request);
    return answer(0, `${channel.label} send request accepted. Recipient arrival is not verified.`);
  } catch (error) {
    return answer(1, `Delivery to ${channel.label} was not confirmed.`, describeSendFailure(error));
  }
}

export async function runSendCommand(argv: readonly string[], deps: SendCommandDeps): Promise<SendCommandResult> {
  const prepared = prepareSendCommand(argv);
  return prepared.kind === 'result' ? prepared.result : runPreparedSendCommand(prepared.args, deps);
}
