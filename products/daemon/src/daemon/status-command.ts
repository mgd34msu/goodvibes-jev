/**
 * status-command.ts, `goodvibes-daemon status` and `goodvibes-daemon update`.
 *
 * The question a headless box's operator asks first: is it up, what version, on
 * what address, is anything unhealthy, and what did it do to itself while I was
 * not looking. Before this, the binary answered none of that, `status` fell
 * through the parser and started a SECOND daemon in the foreground.
 *
 * WHERE EACH LINE COMES FROM
 *
 * Everything about the RUNNING daemon comes from that daemon, over the
 * --host/--port/--token convention @goodvibes-jev/engine/terminal-shell
 * established: `/status` for identity, `/api/health` for the health roll-up and
 * the address it actually bound, `/api/channels/status` for the channels, and
 * `/api/cluster/status` for this machine's place in its group. Hosted sessions
 * are a ws-only verb family, so they go through `callDaemonWsVerb`, same
 * target, same token, different transport.
 *
 * Everything about the daemon's own HISTORY, uptime, the receipts it wrote,
 * the version an automatic rollback rejected, comes from files on the daemon's
 * host, because no verb reports them. That makes those lines local-only, and
 * they say so for a remote target instead of being guessed at.
 *
 * NOTHING HERE DECIDES WHAT AN ANSWER MEANS. A sub-question that fails is one
 * line saying it failed; only an unreachable daemon is a failed command.
 */
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  resolveRemoteDaemonTarget,
  type DaemonFetch,
  type DaemonVerbOutcome,
  type RemoteDaemonTarget,
} from '@goodvibes-jev/engine/terminal-shell';
import { callDaemonRoute } from '@goodvibes-jev/engine/terminal-shell';
import { callDaemonWsVerb, type DaemonWebSocketFactory } from '@goodvibes-jev/engine/terminal-shell';
import {
  describeLocalDaemonState,
  formatDuration,
  type LocalDaemonState,
  type LocalStateIo,
} from './local-daemon-state.js';

export interface DaemonCommandResult {
  readonly lines: readonly string[];
  readonly exitCode: number;
}

/** The target flags every remote-capable subcommand takes. */
export interface RemoteCommandFlags {
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly token: string | undefined;
  readonly json: boolean;
}

export interface RemoteCommandDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  /** Where the daemon writes its own lifecycle/receipt files, for the local-only lines. */
  readonly controlPlaneConfigDir: string;
  readonly fetchImpl?: DaemonFetch | undefined;
  readonly socketFactory?: DaemonWebSocketFactory | undefined;
  readonly readToken?: ((daemonHomeDir: string) => string | undefined) | undefined;
  readonly now?: (() => number) | undefined;
  readonly localStateIo?: LocalStateIo | undefined;
}

// ---------------------------------------------------------------------------
// The shapes this command reads. Only the fields it prints are declared: the
// daemon's schemas carry a great deal more, and re-declaring all of it here
// would be a second contract to keep in step with the first.
// ---------------------------------------------------------------------------

/**
 * `/status`. Answers with the payload itself, not a `{ ok, data }` wrapper.
 *
 * It carries a `cluster` block the operator contract does not list, and that
 * block is where this daemon's ROLE in its group comes from. `cluster.uptimeMs`
 * is the coordinator's, not the daemon's, it reads 0 on a daemon that has been
 * up for hours, so the uptime line comes from the lifecycle marker instead.
 */
interface ControlStatusPayload {
  readonly status?: string;
  readonly version?: string;
  readonly cluster?: {
    readonly enabled?: boolean;
    readonly role?: string;
    readonly nodeId?: string;
    readonly heldSurfaceCount?: number;
    readonly consumersRunning?: boolean;
    /** The daemon BUILD's version, which is not always `version` above. */
    readonly version?: string;
  };
}

interface HealthNetworkBinding {
  readonly host?: string;
  readonly port?: number;
  readonly scheme?: string;
  readonly ready?: boolean;
  readonly errors?: readonly string[];
}

interface HealthPayload {
  readonly overall?: string;
  readonly degradedDomains?: readonly string[];
  readonly providerProblems?: readonly string[];
  readonly integrationProblems?: readonly string[];
  readonly mcpProblems?: { readonly degraded?: readonly string[]; readonly quarantined?: readonly string[] };
  readonly network?: { readonly controlPlane?: HealthNetworkBinding };
}

interface ChannelsPayload {
  readonly channels?: readonly {
    readonly id?: string;
    readonly label?: string;
    readonly state?: string;
    readonly enabled?: boolean;
  }[];
}

/** `/api/cluster/status`. Wrapped, and the group's own view of membership. */
interface ClusterStatusPayload {
  readonly membership?: string;
  readonly groupName?: string | null;
  readonly groupId?: string | null;
  readonly nodeName?: string;
  readonly memberCount?: number;
  readonly advice?: string;
}

interface HostedSessionsPayload {
  readonly sessions?: readonly { readonly id?: string; readonly status?: string }[];
}

// ---------------------------------------------------------------------------

function failure(error: string, fix: string, json: boolean): DaemonCommandResult {
  return {
    lines: json
      ? [JSON.stringify({ ok: false, error, fix }, null, 2)]
      : [error, `  ${fix}`],
    exitCode: 1,
  };
}

/**
 * Resolve the daemon to talk to, or explain why not.
 *
 * Shared by `status`, `update`, `sessions` and `pair` so all four default to
 * this machine and refuse in the same words when they cannot.
 */
export function resolveTargetOrFailure(
  flags: RemoteCommandFlags,
  deps: RemoteCommandDeps,
): { readonly ok: true; readonly target: RemoteDaemonTarget } | { readonly ok: false; readonly result: DaemonCommandResult } {
  const resolved = resolveRemoteDaemonTarget({
    flags: {
      ...(flags.host === undefined ? {} : { host: flags.host }),
      ...(flags.port === undefined ? {} : { port: flags.port }),
      ...(flags.token === undefined ? {} : { token: flags.token }),
    },
    configManager: deps.configManager,
    daemonHomeDir: deps.daemonHomeDir,
    ...(deps.readToken ? { readToken: deps.readToken } : {}),
  });
  if (!resolved.ok) {
    return { ok: false, result: failure(resolved.error, resolved.fix, flags.json) };
  }
  return { ok: true, target: resolved.target };
}

function optionalLine(label: string, value: string | undefined): string[] {
  return value === undefined ? [] : [`${label}${value}`];
}

/**
 * The version, and a second line when the daemon states two different ones.
 *
 * `/status` reports `version` from the platform package while the cluster block
 * it carries reports the DAEMON build's version, and against a live daemon
 * those disagreed, 1.21.0 against 1.28.0. Printing one of them silently would
 * put a number on this page that is wrong for whichever question the reader had
 * in mind, so both are printed and labelled until the daemon states one.
 */
function versionLines(identity: ControlStatusPayload): string[] {
  const platform = identity.version;
  const build = identity.cluster?.version;
  if (platform === undefined) return optionalLine('  version:  ', build);
  if (build === undefined || build === platform) return [`  version:  ${platform}`];
  return [
    `  version:  ${build} (the daemon build)`,
    `            ${platform} (the platform package it reports on /status)`,
  ];
}

/** The uptime / update / rollback block, or the one line saying why it is absent. */
function localStateLines(state: LocalDaemonState): string[] {
  if (!state.available) return [`  history:  ${state.unavailableReason}`];
  const lines: string[] = [];
  if (state.uptimeMs !== undefined) {
    lines.push(`  uptime:   ${formatDuration(state.uptimeMs)}`);
  } else if (state.marker?.state === 'clean-shutdown') {
    lines.push('  uptime:   the last daemon on this host shut down cleanly; this is a fresh start or none');
  } else {
    lines.push('  uptime:   not recorded yet on this host');
  }
  if (state.marker && state.marker.failedStarts > 0) {
    lines.push(`  starts:   ${state.marker.failedStarts} consecutive start attempts did not finish starting`);
  }
  if (state.marker?.rejectedVersion !== undefined) {
    lines.push(
      `  rejected: ${state.marker.rejectedVersion} crash looped and was rolled back; `
      + 'the update loop will not install that version again',
    );
  }
  if (state.rolledBack) {
    lines.push('  rollback: an automatic rollback is in force; no fully-started boot has cleared it yet');
  }
  if (state.receipts.length > 0) {
    lines.push('  receipts:');
    for (const receipt of state.receipts) {
      lines.push(`    ${new Date(receipt.at).toISOString()}  ${receipt.text}`);
    }
  } else {
    lines.push('  receipts: none written');
  }
  return lines;
}

function healthLines(outcome: DaemonVerbOutcome<HealthPayload>): string[] {
  if (!outcome.ok) return [`  health:   could not read: ${outcome.error}`];
  const health = outcome.data;
  const lines = [`  health:   ${health.overall ?? 'unknown'}`];
  const binding = health.network?.controlPlane;
  if (binding?.host !== undefined && binding.port !== undefined) {
    const ready = binding.ready === false ? ' (NOT ready)' : '';
    lines.push(`  bound:    ${binding.scheme ?? 'http'}://${binding.host}:${binding.port}${ready}`);
    for (const error of binding.errors ?? []) lines.push(`            ${error}`);
  }
  for (const domain of health.degradedDomains ?? []) lines.push(`            degraded: ${domain}`);
  for (const problem of health.providerProblems ?? []) lines.push(`            provider: ${problem}`);
  for (const problem of health.integrationProblems ?? []) lines.push(`            integration: ${problem}`);
  for (const server of health.mcpProblems?.quarantined ?? []) lines.push(`            mcp quarantined: ${server}`);
  return lines;
}

/**
 * The channel roll-up.
 *
 * Only a channel that is switched ON and not healthy is named. Every channel
 * the daemon knows about appears in this payload, and a daemon with one
 * configured channel ships sixteen more in state `disabled`, listing those as
 * problems produced a seventeen-line wall under a healthy daemon and buried the
 * one line that meant something.
 */
function channelLines(outcome: DaemonVerbOutcome<ChannelsPayload>): string[] {
  if (!outcome.ok) return [`  channels: could not read: ${outcome.error}`];
  const channels = outcome.data.channels ?? [];
  if (channels.length === 0) return ['  channels: none configured'];
  const on = channels.filter((channel) => channel.enabled !== false);
  const unhealthy = on.filter((channel) => channel.state !== undefined
    && channel.state !== 'ready'
    && channel.state !== 'healthy'
    && channel.state !== 'connected');
  const lines = [`  channels: ${on.length} of ${channels.length} switched on`];
  for (const channel of unhealthy) {
    lines.push(`            ${channel.label ?? channel.id ?? 'a channel'}: ${channel.state}`);
  }
  return lines;
}

/**
 * This machine's place in its group.
 *
 * Two sources, because neither answers the whole question: `/status` carries
 * the ROLE this node currently holds, and `/api/cluster/status` carries the
 * GROUP it holds that role in. A daemon with sharing switched off says so and
 * stops, a role inside no group is not information.
 */
function clusterLines(
  identity: ControlStatusPayload,
  outcome: DaemonVerbOutcome<ClusterStatusPayload>,
): string[] {
  const role = identity.cluster?.role;
  if (identity.cluster?.enabled === false) {
    return ['  cluster:  off, this machine handles its own inbound work'];
  }
  if (!outcome.ok) {
    return [
      role === undefined
        ? `  cluster:  could not read: ${outcome.error}`
        : `  cluster:  ${role} (the group view could not be read: ${outcome.error})`,
    ];
  }
  const cluster = outcome.data;
  if (cluster.membership === 'no-group') {
    return ['  cluster:  in no group yet, `goodvibes-daemon cluster create` starts one'];
  }
  const group = cluster.groupName ?? cluster.groupId ?? 'its group';
  const members = cluster.memberCount === undefined ? '' : ` of ${cluster.memberCount}`;
  return [`  cluster:  ${role ?? cluster.membership ?? 'a member'} in "${group}"${members}`];
}

function hostedSessionLines(outcome: DaemonVerbOutcome<HostedSessionsPayload>): string[] {
  if (!outcome.ok) return [`  sessions: could not read: ${outcome.error}`];
  const sessions = outcome.data.sessions ?? [];
  return [`  sessions: ${sessions.length} hosted by this daemon`];
}

export interface RunStatusCommandInput extends RemoteCommandDeps {
  readonly flags: RemoteCommandFlags;
}

/**
 * `goodvibes-daemon status [--json]`.
 *
 * Exit 0 when the daemon answered its identity call, 1 when it could not be
 * reached. Every other sub-question that fails is one line inside a successful
 * report, a daemon with a broken channel is up, and saying otherwise would be
 * the kind of wrong that makes an operator distrust the whole page.
 */
export async function runStatusCommand(input: RunStatusCommandInput): Promise<DaemonCommandResult> {
  const { flags } = input;
  const resolved = resolveTargetOrFailure(flags, input);
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;
  const fetchImpl = input.fetchImpl ?? fetch;

  // `/status` answers with the payload itself; `/api/cluster/*` wraps it. Each
  // call states which, because reading one as the other turns a healthy 200
  // into "the daemon refused the request".
  const identity = await callDaemonRoute<ControlStatusPayload>(
    target, '/status', { method: 'GET', envelope: 'raw' }, fetchImpl,
  );
  if (!identity.ok) return failure(identity.error, identity.fix, flags.json);

  const [health, channels, cluster, hosted] = await Promise.all([
    callDaemonRoute<HealthPayload>(target, '/api/health', { method: 'GET', envelope: 'raw' }, fetchImpl),
    callDaemonRoute<ChannelsPayload>(target, '/api/channels/status', { method: 'GET', envelope: 'raw' }, fetchImpl),
    callDaemonRoute<ClusterStatusPayload>(target, '/api/cluster/status', { method: 'GET', envelope: 'wrapped' }, fetchImpl),
    callDaemonWsVerb<HostedSessionsPayload>(target, 'sessions.hosted.list', {
      ...(input.socketFactory ? { socketFactory: input.socketFactory } : {}),
    }),
  ]);

  const local = describeLocalDaemonState({
    isLocal: target.isLocal,
    controlPlaneConfigDir: input.controlPlaneConfigDir,
    ...(input.now ? { now: input.now } : {}),
    ...(input.localStateIo ? { io: input.localStateIo } : {}),
  });

  if (flags.json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: {
          target: target.baseUrl,
          isLocal: target.isLocal,
          identity: identity.data,
          health: health.ok ? health.data : { error: health.error },
          channels: channels.ok ? channels.data : { error: channels.error },
          cluster: cluster.ok ? cluster.data : { error: cluster.error },
          hostedSessions: hosted.ok
            ? { count: (hosted.data.sessions ?? []).length, sessions: hosted.data.sessions ?? [] }
            : { error: hosted.error },
          local: local.available
            ? {
              uptimeMs: local.uptimeMs,
              marker: local.marker,
              receipts: local.receipts,
              rolledBack: local.rolledBack,
            }
            : { available: false, reason: local.unavailableReason },
        },
      }, null, 2)],
    };
  }

  const where = target.isLocal ? 'this machine' : target.baseUrl;
  return {
    exitCode: 0,
    lines: [
      `goodvibes daemon on ${where}`,
      ...versionLines(identity.data),
      ...optionalLine('  state:    ', identity.data.status),
      ...healthLines(health),
      ...localStateLines(local),
      ...channelLines(channels),
      ...clusterLines(identity.data, cluster),
      ...hostedSessionLines(hosted),
    ],
  };
}

export interface RunUpdateCommandInput extends RemoteCommandDeps {
  readonly flags: RemoteCommandFlags & { readonly check: boolean };
}

/**
 * `goodvibes-daemon update [--check]`.
 *
 * What the daemon knows about its own updates: the running version, the
 * receipts it wrote about swaps and restarts, the version an automatic rollback
 * rejected, and whether a rollback is in force.
 *
 * --check is honest about a gap. The daemon runs the whole self-update loop
 * itself, it checks hourly, swaps at an idle moment and keeps the outgoing
 * binary, but the control plane publishes NO verb to trigger that check early:
 * the operator contract this build was written against has no update method of
 * any kind (no `update.*`, no `admin.update`, nothing under `control.` that
 * checks). Rather than invent a verb this daemon does not answer, --check says
 * so and names the two things that do work: waiting for the hourly check, or
 * restarting the service, which checks on the way up.
 */
export async function runUpdateCommand(input: RunUpdateCommandInput): Promise<DaemonCommandResult> {
  const { flags } = input;
  const resolved = resolveTargetOrFailure(flags, input);
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;
  const fetchImpl = input.fetchImpl ?? fetch;

  const identity = await callDaemonRoute<ControlStatusPayload>(
    target, '/status', { method: 'GET', envelope: 'raw' }, fetchImpl,
  );
  if (!identity.ok) return failure(identity.error, identity.fix, flags.json);

  const local = describeLocalDaemonState({
    isLocal: target.isLocal,
    controlPlaneConfigDir: input.controlPlaneConfigDir,
    ...(input.now ? { now: input.now } : {}),
    ...(input.localStateIo ? { io: input.localStateIo } : {}),
  });

  const checkNote = flags.check
    ? [
      '',
      'update --check: this daemon publishes no verb to trigger an update check early.',
      '  It checks once an hour on its own and swaps only at an idle moment.',
      '  To make it check now, restart it; it checks on the way up:',
      '    goodvibes-daemon restart-service',
    ]
    : [];

  if (flags.json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: {
          target: target.baseUrl,
          isLocal: target.isLocal,
          version: identity.data.version,
          checkRequested: flags.check,
          checkVerbAvailable: false,
          local: local.available
            ? {
              marker: local.marker,
              receipts: local.receipts,
              rejectedVersion: local.marker?.rejectedVersion,
              rolledBack: local.rolledBack,
            }
            : { available: false, reason: local.unavailableReason },
        },
      }, null, 2)],
    };
  }

  const where = target.isLocal ? 'this machine' : target.baseUrl;
  return {
    exitCode: 0,
    lines: [
      `goodvibes daemon updates on ${where}`,
      ...versionLines(identity.data),
      ...localStateLines(local),
      ...checkNote,
    ],
  };
}
