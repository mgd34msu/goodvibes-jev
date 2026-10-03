import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';
import {
  formatOperatorGatewayFailure,
  invokeOperatorGatewayMethod,
} from '../agent/operator-gateway-call.ts';
import { resolveAgentConnectedHostConnection } from '../agent/routine-schedule-promotion.ts';
import {
  operatorFlagValue,
  operatorHasFlag,
  operatorParseIntFlag,
  operatorRequiredFlag,
  parseOperatorCommandArgs,
} from './operator-command-args.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';
import { appendTemporalLabel } from './temporal-label.ts';

const CI_STATUS_ROUTE = '/api/ci/status';
const CI_WATCHES_ROUTE = '/api/ci/watches';
const CI_WATCH_ROUTE = '/api/ci/watches/{watchId}';
const CI_WATCH_RUN_ROUTE = '/api/ci/watches/{watchId}/run';

const CI_STATUS_USAGE = 'Usage: goodvibes-agent ci status <repo> [--ref <ref>] [--pr <number>]';
const CI_WATCHES_CREATE_USAGE = 'Usage: goodvibes-agent ci watches create <repo> --delivery-channel <channel> [--ref <ref>] [--pr <number>] [--trigger-fix-session] --yes';
const CI_WATCHES_DELETE_USAGE = 'Usage: goodvibes-agent ci watches delete <watchId> --yes';
const CI_WATCHES_RUN_USAGE = 'Usage: goodvibes-agent ci watches run <watchId>';
const CI_USAGE = 'Usage: goodvibes-agent ci [status <repo> [--ref <ref>] [--pr <number>]|watches list|watches create <repo> --delivery-channel <channel> [--ref <ref>] [--pr <number>] [--trigger-fix-session] --yes|watches delete <watchId> --yes|watches run <watchId>]';

type CiReport = OperatorMethodOutput<'ci.status'>['report'];
type CiWatch = OperatorMethodOutput<'ci.watches.list'>['watches'][number];

function jsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

function usageFailure(runtime: CliCommandRuntime, error: string): CliCommandOutput {
  return {
    output: jsonOrText(runtime, { ok: false, kind: 'invalid_ci_command', error }, error),
    exitCode: 2,
  };
}

function renderCiJobs(report: CiReport): readonly string[] {
  if (report.jobs.length === 0) return ['  jobs (none reported)'];
  return [
    `  jobs (${report.jobs.length})`,
    ...report.jobs.map((job) => {
      const conclusion = job.conclusion ?? 'pending';
      const continueOnError = job.continueOnError ? ' continue-on-error' : '';
      return `    ${job.name.padEnd(32)} status ${job.status.padEnd(12)} conclusion ${conclusion}${continueOnError}`;
    }),
  ];
}

function renderCiReport(report: CiReport): string {
  return [
    `CI report ${report.repo}${report.ref ? ` @ ${report.ref}` : ''}${report.prNumber !== undefined ? ` PR #${report.prNumber}` : ''}`,
    `  overall ${report.overall}`,
    ...renderCiJobs(report),
    report.violations.length > 0 ? `  violations: ${report.violations.join('; ')}` : '  violations: none',
    `  checked at ${appendTemporalLabel(new Date(report.checkedAt).toISOString(), report.checkedAt)}`,
  ].join('\n');
}

function renderCiWatch(watch: CiWatch): string {
  return [
    `  ${watch.id}  ${watch.repo}${watch.ref ? ` @ ${watch.ref}` : ''}${watch.prNumber !== undefined ? ` PR #${watch.prNumber}` : ''}`,
    `    delivery ${watch.deliveryChannel}  trigger-fix-session ${watch.triggerFixSession ? 'yes' : 'no'}  last overall ${watch.lastOverall ?? 'unknown'}`,
  ].join('\n');
}

function renderCiWatchList(watches: readonly CiWatch[]): string {
  if (watches.length === 0) {
    return [
      'CI watches',
      '  No CI watches configured yet.',
      '  next goodvibes-agent ci watches create <repo> --delivery-channel <channel> --yes',
    ].join('\n');
  }
  return [`CI watches (${watches.length})`, ...watches.map(renderCiWatch)].join('\n');
}

async function handleCiStatus(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['ref', 'pr']);
  const repo = parsed.positionals[0];
  if (!repo) return usageFailure(runtime, CI_STATUS_USAGE);
  let prNumber: number | undefined;
  try {
    prNumber = operatorParseIntFlag(parsed, 'pr', CI_STATUS_USAGE);
  } catch (error) {
    return usageFailure(runtime, error instanceof Error ? error.message : String(error));
  }
  const payload: OperatorMethodInput<'ci.status'> = {
    repo,
    ref: operatorFlagValue(parsed, 'ref'),
    prNumber,
  };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'ci.status', CI_STATUS_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return { output: jsonOrText(runtime, result, renderCiReport(result.data.report)), exitCode: 0 };
}

async function handleCiWatchesList(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'ci.watches.list', CI_WATCHES_ROUTE, {});
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return { output: jsonOrText(runtime, result, renderCiWatchList(result.data.watches)), exitCode: 0 };
}

async function handleCiWatchesCreate(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['ref', 'pr', 'delivery-channel']);
  const repo = parsed.positionals[0];
  if (!repo) return usageFailure(runtime, CI_WATCHES_CREATE_USAGE);
  let deliveryChannel: string;
  let prNumber: number | undefined;
  try {
    deliveryChannel = operatorRequiredFlag(parsed, 'delivery-channel', CI_WATCHES_CREATE_USAGE);
    prNumber = operatorParseIntFlag(parsed, 'pr', CI_WATCHES_CREATE_USAGE);
  } catch (error) {
    return usageFailure(runtime, error instanceof Error ? error.message : String(error));
  }
  if (!parsed.yes) {
    return { output: `Refusing to create a CI watch for ${repo} without --yes.`, exitCode: 2 };
  }
  const payload: OperatorMethodInput<'ci.watches.create'> = {
    repo,
    ref: operatorFlagValue(parsed, 'ref'),
    prNumber,
    deliveryChannel,
    triggerFixSession: operatorHasFlag(parsed, 'trigger-fix-session') || undefined,
  };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'ci.watches.create', CI_WATCHES_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return {
    output: jsonOrText(runtime, result, [`Created CI watch ${result.data.watch.id}`, renderCiWatch(result.data.watch)].join('\n')),
    exitCode: 0,
  };
}

async function handleCiWatchesDelete(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args);
  const watchId = parsed.positionals[0];
  if (!watchId) return usageFailure(runtime, CI_WATCHES_DELETE_USAGE);
  if (!parsed.yes) {
    return { output: `Refusing to delete CI watch ${watchId} without --yes.`, exitCode: 2 };
  }
  const payload: OperatorMethodInput<'ci.watches.delete'> = { watchId };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'ci.watches.delete', CI_WATCH_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return {
    output: jsonOrText(runtime, result, `Deleted CI watch ${result.data.watchId}: ${result.data.deleted ? 'ok' : 'not found'}`),
    exitCode: result.data.deleted ? 0 : 1,
  };
}

async function handleCiWatchesRun(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args);
  const watchId = parsed.positionals[0];
  if (!watchId) return usageFailure(runtime, CI_WATCHES_RUN_USAGE);
  const payload: OperatorMethodInput<'ci.watches.run'> = { watchId };
  const connection = resolveAgentConnectedHostConnection(runtime.configManager, runtime.homeDirectory);
  const result = await invokeOperatorGatewayMethod(connection, 'ci.watches.run', CI_WATCH_RUN_ROUTE, payload);
  if (!result.ok) {
    return { output: jsonOrText(runtime, result, formatOperatorGatewayFailure(result)), exitCode: 1 };
  }
  return {
    output: jsonOrText(runtime, result, [
      renderCiReport(result.data.report),
      `  notified ${result.data.notified ? 'yes' : 'no'}${result.data.notificationId ? ` (${result.data.notificationId})` : ''}`,
      `  fix session triggered ${result.data.fixSessionTriggered ? 'yes' : 'no'}${result.data.fixSessionId ? ` (${result.data.fixSessionId})` : ''}`,
    ].join('\n')),
    exitCode: 0,
  };
}

async function handleCiWatchesCommand(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const [sub = 'list', ...rest] = args;
  switch (sub.toLowerCase()) {
    case 'list':
      return handleCiWatchesList(runtime);
    case 'create':
      return handleCiWatchesCreate(runtime, rest);
    case 'delete':
    case 'remove':
      return handleCiWatchesDelete(runtime, rest);
    case 'run':
      return handleCiWatchesRun(runtime, rest);
    default:
      return usageFailure(runtime, CI_USAGE);
  }
}

export async function handleCiCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub, ...rest] = runtime.cli.commandArgs;
  switch ((sub ?? '').toLowerCase()) {
    case 'status':
      return handleCiStatus(runtime, rest);
    case 'watches':
      return handleCiWatchesCommand(runtime, rest);
    default:
      return usageFailure(runtime, CI_USAGE);
  }
}
