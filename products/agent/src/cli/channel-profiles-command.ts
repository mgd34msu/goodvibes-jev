import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';
import {
  formatOperatorGatewayFailure,
  invokeOperatorGatewayMethod,
} from '../agent/operator-gateway-call.ts';
import { resolveAgentConnectedHostConnection } from '../agent/routine-schedule-promotion.ts';
import {
  operatorFlagValue,
  parseOperatorCommandArgs,
} from './operator-command-args.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';
import { appendTemporalLabel } from './temporal-label.ts';

const CHANNEL_PROFILES_ROUTE = '/api/channels/profiles';
const CHANNEL_PROFILE_ROUTE = '/api/channels/profiles/{surfaceKind}';

const CHANNEL_PROFILES_GET_USAGE = 'Usage: goodvibes-agent channel-profiles get <surfaceKind> [--channel-id <id>]';
const CHANNEL_PROFILES_SET_USAGE = 'Usage: goodvibes-agent channel-profiles set <surfaceKind> [--channel-id <id>] [--model <model>] [--provider <provider>] [--permission-mode <plan|normal|accept-edits|auto>] --yes';
const CHANNEL_PROFILES_DELETE_USAGE = 'Usage: goodvibes-agent channel-profiles delete <surfaceKind> [--channel-id <id>] --yes';
const CHANNEL_PROFILES_USAGE = 'Usage: goodvibes-agent channel-profiles [list|get <surfaceKind> [--channel-id <id>]|set <surfaceKind> [--channel-id <id>] [--model <model>] [--provider <provider>] [--permission-mode <mode>] --yes|delete <surfaceKind> [--channel-id <id>] --yes]';

const PERMISSION_MODES = new Set(['plan', 'normal', 'accept-edits', 'auto']);

type ChannelProfile = OperatorMethodOutput<'channels.profiles.list'>['bindings'][number];
type PermissionMode = NonNullable<OperatorMethodInput<'channels.profiles.set'>['permissionMode']>;

function jsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

function usageFailure(runtime: CliCommandRuntime, error: string): CliCommandOutput {
  return {
    output: jsonOrText(runtime, { ok: false, kind: 'invalid_channel_profiles_command', error }, error),
    exitCode: 2,
  };
}

function parsePermissionMode(value: string | undefined, usage: string): PermissionMode | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!PERMISSION_MODES.has(normalized)) throw new Error(`${usage}\n--permission-mode must be one of: plan, normal, accept-edits, auto.`);
  return normalized as PermissionMode;
}

function renderChannelProfile(binding: ChannelProfile): string {
  return [
    `Channel profile ${binding.id}`,
    `  surface ${binding.surfaceKind}${binding.channelId ? ` channel ${binding.channelId}` : ''}`,
    `  model ${binding.model ?? '(default)'}`,
    `  provider ${binding.provider ?? '(default)'}`,
    `  permission mode ${binding.permissionMode ?? '(default)'}`,
    `  updated ${appendTemporalLabel(new Date(binding.updatedAt).toISOString(), binding.updatedAt)}`,
  ].join('\n');
}

function renderChannelProfileLine(binding: ChannelProfile): string {
  const surface = binding.channelId ? `${binding.surfaceKind}:${binding.channelId}` : binding.surfaceKind;
  return `  ${surface.padEnd(24)} model ${(binding.model ?? '(default)').padEnd(20)} provider ${(binding.provider ?? '(default)').padEnd(14)} permission ${binding.permissionMode ?? '(default)'}`;
}

function renderChannelProfileList(bindings: readonly ChannelProfile[]): string {
  if (bindings.length === 0) {
    return [
      'Channel profiles',
      '  No per-channel profile bindings configured yet.',
      '  next goodvibes-agent channel-profiles set <surfaceKind> --model <model> --yes',
    ].join('\n');
  }
  return [`Channel profiles (${bindings.length})`, ...bindings.map(renderChannelProfileLine)].join('\n');
}

async function handleChannelProfilesList(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'channels.profiles.list', CHANNEL_PROFILES_ROUTE, {});
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return { output: jsonOrText(runtime, result, renderChannelProfileList(result.data.bindings)), exitCode: 0 };
}

async function handleChannelProfilesGet(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['channel-id']);
  const surfaceKind = parsed.positionals[0];
  if (!surfaceKind) return usageFailure(runtime, CHANNEL_PROFILES_GET_USAGE);
  const payload: OperatorMethodInput<'channels.profiles.get'> = {
    surfaceKind,
    channelId: operatorFlagValue(parsed, 'channel-id'),
  };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'channels.profiles.get', CHANNEL_PROFILE_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return { output: jsonOrText(runtime, result, renderChannelProfile(result.data.binding)), exitCode: 0 };
}

async function handleChannelProfilesSet(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['channel-id', 'model', 'provider', 'permission-mode']);
  const surfaceKind = parsed.positionals[0];
  if (!surfaceKind) return usageFailure(runtime, CHANNEL_PROFILES_SET_USAGE);
  let permissionMode: PermissionMode | undefined;
  try {
    permissionMode = parsePermissionMode(operatorFlagValue(parsed, 'permission-mode'), CHANNEL_PROFILES_SET_USAGE);
  } catch (error) {
    return usageFailure(runtime, error instanceof Error ? error.message : String(error));
  }
  if (!parsed.yes) {
    return { output: `Refusing to set channel profile ${surfaceKind} without --yes.`, exitCode: 2 };
  }
  const payload: OperatorMethodInput<'channels.profiles.set'> = {
    surfaceKind,
    channelId: operatorFlagValue(parsed, 'channel-id'),
    model: operatorFlagValue(parsed, 'model'),
    provider: operatorFlagValue(parsed, 'provider'),
    permissionMode,
  };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'channels.profiles.set', CHANNEL_PROFILES_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return {
    output: jsonOrText(runtime, result, [`Set channel profile ${result.data.binding.id}`, renderChannelProfile(result.data.binding)].join('\n')),
    exitCode: 0,
  };
}

async function handleChannelProfilesDelete(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['channel-id']);
  const surfaceKind = parsed.positionals[0];
  if (!surfaceKind) return usageFailure(runtime, CHANNEL_PROFILES_DELETE_USAGE);
  if (!parsed.yes) {
    return { output: `Refusing to delete channel profile ${surfaceKind} without --yes.`, exitCode: 2 };
  }
  const payload: OperatorMethodInput<'channels.profiles.delete'> = {
    surfaceKind,
    channelId: operatorFlagValue(parsed, 'channel-id'),
  };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'channels.profiles.delete', CHANNEL_PROFILE_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return {
    output: jsonOrText(runtime, result, `Deleted channel profile ${result.data.surfaceKind}${result.data.channelId ? `:${result.data.channelId}` : ''}: ${result.data.deleted ? 'ok' : 'not found'}`),
    exitCode: result.data.deleted ? 0 : 1,
  };
}

export async function handleChannelProfilesCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  switch (sub.toLowerCase()) {
    case 'list':
      return handleChannelProfilesList(runtime);
    case 'get':
    case 'show':
      return handleChannelProfilesGet(runtime, rest);
    case 'set':
    case 'update':
      return handleChannelProfilesSet(runtime, rest);
    case 'delete':
    case 'remove':
      return handleChannelProfilesDelete(runtime, rest);
    default:
      return usageFailure(runtime, CHANNEL_PROFILES_USAGE);
  }
}
