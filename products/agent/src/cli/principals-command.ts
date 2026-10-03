import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';
import {
  formatOperatorGatewayFailure,
  invokeOperatorGatewayMethod,
} from '../agent/operator-gateway-call.ts';
import { resolveAgentConnectedHostConnection } from '../agent/routine-schedule-promotion.ts';
import {
  operatorFlagValue,
  operatorRequiredFlag,
  parseIdentityPairs,
  parseOperatorCommandArgs,
} from './operator-command-args.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';
import { appendTemporalLabel } from './temporal-label.ts';

const PRINCIPALS_ROUTE = '/api/principals';
const PRINCIPAL_ROUTE = '/api/principals/{principalId}';
const PRINCIPALS_RESOLVE_ROUTE = '/api/principals/resolve';

const PRINCIPALS_GET_USAGE = 'Usage: goodvibes-agent principals get <id>';
const PRINCIPALS_CREATE_USAGE = 'Usage: goodvibes-agent principals create --name <name> --kind <user|bot|service|token> [--identity channel:value,channel:value] --yes';
const PRINCIPALS_UPDATE_USAGE = 'Usage: goodvibes-agent principals update <id> [--name <name>] [--kind <user|bot|service|token>] [--identity channel:value,channel:value] --yes';
const PRINCIPALS_DELETE_USAGE = 'Usage: goodvibes-agent principals delete <id> --yes';
const PRINCIPALS_RESOLVE_USAGE = 'Usage: goodvibes-agent principals resolve --channel <channel> --value <value>';
const PRINCIPALS_USAGE = 'Usage: goodvibes-agent principals [list|get <id>|create --name <name> --kind <user|bot|service|token> --yes|update <id> [--name ..] [--kind ..] --yes|delete <id> --yes|resolve --channel <channel> --value <value>]';

const PRINCIPAL_KINDS = new Set(['user', 'bot', 'service', 'token']);

type Principal = OperatorMethodOutput<'principals.list'>['principals'][number];
type PrincipalKind = OperatorMethodInput<'principals.create'>['kind'];

function jsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

function usageFailure(runtime: CliCommandRuntime, error: string): CliCommandOutput {
  return {
    output: jsonOrText(runtime, { ok: false, kind: 'invalid_principals_command', error }, error),
    exitCode: 2,
  };
}

function requirePrincipalKind(value: string, usage: string): PrincipalKind {
  const normalized = value.trim().toLowerCase();
  if (!PRINCIPAL_KINDS.has(normalized)) throw new Error(`${usage}\n--kind must be one of: user, bot, service, token.`);
  return normalized as PrincipalKind;
}

function renderPrincipal(principal: Principal): string {
  const identities = principal.identities.length > 0
    ? principal.identities.map((identity) => `${identity.channel}:${identity.value}`).join(', ')
    : '(none)';
  return [
    `Principal ${principal.id}`,
    `  name ${principal.name}`,
    `  kind ${principal.kind}`,
    `  identities ${identities}`,
    `  created ${appendTemporalLabel(new Date(principal.createdAt).toISOString(), principal.createdAt)}`,
    `  updated ${appendTemporalLabel(new Date(principal.updatedAt).toISOString(), principal.updatedAt)}`,
  ].join('\n');
}

function renderPrincipalLine(principal: Principal): string {
  const identities = principal.identities.length > 0
    ? principal.identities.map((identity) => `${identity.channel}:${identity.value}`).join(', ')
    : '(none)';
  return `  ${principal.id}  ${principal.kind.padEnd(8)} ${principal.name}  identities ${identities}`;
}

function renderPrincipalList(principals: readonly Principal[]): string {
  if (principals.length === 0) {
    return [
      'Principals',
      '  No principals registered yet.',
      '  next goodvibes-agent principals create --name <name> --kind user --yes',
    ].join('\n');
  }
  return [`Principals (${principals.length})`, ...principals.map(renderPrincipalLine)].join('\n');
}

async function handlePrincipalsList(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'principals.list', PRINCIPALS_ROUTE, {});
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return { output: jsonOrText(runtime, result, renderPrincipalList(result.data.principals)), exitCode: 0 };
}

async function handlePrincipalsGet(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args);
  const principalId = parsed.positionals[0];
  if (!principalId) return usageFailure(runtime, PRINCIPALS_GET_USAGE);
  const payload: OperatorMethodInput<'principals.get'> = { principalId };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'principals.get', PRINCIPAL_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return { output: jsonOrText(runtime, result, renderPrincipal(result.data.principal)), exitCode: 0 };
}

async function handlePrincipalsCreate(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['name', 'kind', 'identity']);
  let name: string;
  let kind: PrincipalKind;
  let identities: readonly { readonly channel: string; readonly value: string }[];
  try {
    name = operatorRequiredFlag(parsed, 'name', PRINCIPALS_CREATE_USAGE);
    kind = requirePrincipalKind(operatorRequiredFlag(parsed, 'kind', PRINCIPALS_CREATE_USAGE), PRINCIPALS_CREATE_USAGE);
    identities = parseIdentityPairs(operatorFlagValue(parsed, 'identity'));
  } catch (error) {
    return usageFailure(runtime, error instanceof Error ? error.message : String(error));
  }
  if (!parsed.yes) {
    return { output: `Refusing to create principal ${name} without --yes.`, exitCode: 2 };
  }
  const payload: OperatorMethodInput<'principals.create'> = {
    name,
    kind,
    identities: identities.length > 0 ? identities : undefined,
  };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'principals.create', PRINCIPALS_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return {
    output: jsonOrText(runtime, result, [`Created principal ${result.data.principal.id}`, renderPrincipal(result.data.principal)].join('\n')),
    exitCode: 0,
  };
}

async function handlePrincipalsUpdate(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['name', 'kind', 'identity']);
  const principalId = parsed.positionals[0];
  if (!principalId) return usageFailure(runtime, PRINCIPALS_UPDATE_USAGE);
  let kind: PrincipalKind | undefined;
  let identities: readonly { readonly channel: string; readonly value: string }[];
  try {
    const kindValue = operatorFlagValue(parsed, 'kind');
    kind = kindValue ? requirePrincipalKind(kindValue, PRINCIPALS_UPDATE_USAGE) : undefined;
    identities = parseIdentityPairs(operatorFlagValue(parsed, 'identity'));
  } catch (error) {
    return usageFailure(runtime, error instanceof Error ? error.message : String(error));
  }
  if (!parsed.yes) {
    return { output: `Refusing to update principal ${principalId} without --yes.`, exitCode: 2 };
  }
  const payload: OperatorMethodInput<'principals.update'> = {
    principalId,
    name: operatorFlagValue(parsed, 'name'),
    kind,
    identities: identities.length > 0 ? identities : undefined,
  };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'principals.update', PRINCIPAL_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return {
    output: jsonOrText(runtime, result, [`Updated principal ${result.data.principal.id}`, renderPrincipal(result.data.principal)].join('\n')),
    exitCode: 0,
  };
}

async function handlePrincipalsDelete(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args);
  const principalId = parsed.positionals[0];
  if (!principalId) return usageFailure(runtime, PRINCIPALS_DELETE_USAGE);
  if (!parsed.yes) {
    return { output: `Refusing to delete principal ${principalId} without --yes.`, exitCode: 2 };
  }
  const payload: OperatorMethodInput<'principals.delete'> = { principalId };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'principals.delete', PRINCIPAL_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return {
    output: jsonOrText(runtime, result, `Deleted principal ${result.data.principalId}: ${result.data.deleted ? 'ok' : 'not found'}`),
    exitCode: result.data.deleted ? 0 : 1,
  };
}

async function handlePrincipalsResolve(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['channel', 'value']);
  let channel: string;
  let value: string;
  try {
    channel = operatorRequiredFlag(parsed, 'channel', PRINCIPALS_RESOLVE_USAGE);
    value = operatorRequiredFlag(parsed, 'value', PRINCIPALS_RESOLVE_USAGE);
  } catch (error) {
    return usageFailure(runtime, error instanceof Error ? error.message : String(error));
  }
  const payload: OperatorMethodInput<'principals.resolve'> = { channel, value };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'principals.resolve', PRINCIPALS_RESOLVE_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  // known: false means the identity lookup found nothing for this channel/value, never assert a match in that case.
  const text = result.data.known
    ? [`known: true`, renderPrincipal(result.data.principal)].join('\n')
    : `known: false\n  No principal is mapped to ${channel}:${value}.`;
  return { output: jsonOrText(runtime, result, text), exitCode: 0 };
}

export async function handlePrincipalsCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  switch (sub.toLowerCase()) {
    case 'list':
      return handlePrincipalsList(runtime);
    case 'get':
    case 'show':
      return handlePrincipalsGet(runtime, rest);
    case 'create':
      return handlePrincipalsCreate(runtime, rest);
    case 'update':
      return handlePrincipalsUpdate(runtime, rest);
    case 'delete':
    case 'remove':
      return handlePrincipalsDelete(runtime, rest);
    case 'resolve':
      return handlePrincipalsResolve(runtime, rest);
    default:
      return usageFailure(runtime, PRINCIPALS_USAGE);
  }
}
