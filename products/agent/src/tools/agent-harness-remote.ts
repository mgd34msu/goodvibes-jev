import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessRemoteArgs {
  readonly target?: unknown;
  readonly query?: unknown;
  readonly peerId?: unknown;
  readonly requestId?: unknown;
  readonly workId?: unknown;
  readonly command?: unknown;
  readonly payload?: unknown;
  readonly note?: unknown;
  readonly reason?: unknown;
  readonly limit?: unknown;
  readonly includeParameters?: unknown;
}

type RemoteReadSurface =
  | 'remote_snapshot'
  | 'remote_peers'
  | 'remote_work'
  | 'remote_pair_requests';

type RemoteMutationSurface =
  | 'remote_pair_approve'
  | 'remote_pair_reject'
  | 'remote_peers_invoke'
  | 'remote_work_cancel';

type RemoteSurface = RemoteReadSurface | RemoteMutationSurface;

interface RemoteMethodHandoff {
  readonly surface: RemoteSurface;
  readonly methodId: string;
  readonly route: string;
  readonly effect: 'confirmed-connected-host-state';
  readonly confirmationRequired: true;
  readonly input: Record<string, unknown>;
  readonly modelRoute: string;
  readonly policy: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// ---------------------------------------------------------------------------
// Catalog status (for summary mode inclusion)
// ---------------------------------------------------------------------------

export function remoteCatalogStatus(_context: CommandContext): Record<string, unknown> {
  return {
    modes: [
      'remote_snapshot',
      'remote_peers',
      'remote_work',
      'remote_pair_requests',
      'remote_pair_approve',
      'remote_pair_reject',
      'remote_peers_invoke',
      'remote_work_cancel',
    ],
    readModes: 4,
    mutationModes: 4,
    policy:
      'Distributed remote execution surface. Read modes call remote.snapshot, remote.peers.list, remote.work.list, and remote.pair.requests.list via agent_operator_method. Mutation modes (approve/reject pair requests, invoke peer command, cancel work) require confirm:true and explicitUserRequest and return an agent_operator_method handoff.',
  };
}

// ---------------------------------------------------------------------------
// Read surfaces, return route descriptors; agent_operator_method executes them
// ---------------------------------------------------------------------------

export function remoteSnapshotSummary(_args: AgentHarnessRemoteArgs): Record<string, unknown> {
  return {
    surface: 'remote_snapshot',
    methodId: 'remote.snapshot',
    route: 'GET /api/remote',
    effect: 'read-only-network',
    confirmationRequired: false,
    modelRoute: previewHarnessText('agent_operator_method methodId:"remote.snapshot" input:{}'),
    description:
      'Returns a distributed remote execution snapshot: connected peers, queued/leased work, and pair request counts.',
    policy:
      'Read-only. Call agent_operator_method methodId:"remote.snapshot" input:{} to fetch the live snapshot from the daemon.',
  };
}

export function remotePeersSummary(_args: AgentHarnessRemoteArgs): Record<string, unknown> {
  return {
    surface: 'remote_peers',
    methodId: 'remote.peers.list',
    route: 'GET /api/remote/peers',
    effect: 'read-only-network',
    confirmationRequired: false,
    modelRoute: previewHarnessText('agent_operator_method methodId:"remote.peers.list" input:{}'),
    description: 'Lists connected and recently-disconnected remote peers.',
    policy:
      'Read-only. Call agent_operator_method methodId:"remote.peers.list" input:{} to fetch the live peer list.',
  };
}

export function remoteWorkSummary(_args: AgentHarnessRemoteArgs): Record<string, unknown> {
  return {
    surface: 'remote_work',
    methodId: 'remote.work.list',
    route: 'GET /api/remote/work',
    effect: 'read-only-network',
    confirmationRequired: false,
    modelRoute: previewHarnessText('agent_operator_method methodId:"remote.work.list" input:{}'),
    description: 'Lists queued and leased remote work items.',
    policy:
      'Read-only. Call agent_operator_method methodId:"remote.work.list" input:{} to fetch queued and leased work.',
  };
}

export function remotePairRequestsSummary(_args: AgentHarnessRemoteArgs): Record<string, unknown> {
  return {
    surface: 'remote_pair_requests',
    methodId: 'remote.pair.requests.list',
    route: 'GET /api/remote/pair/requests',
    effect: 'read-only-network',
    confirmationRequired: false,
    modelRoute: previewHarnessText('agent_operator_method methodId:"remote.pair.requests.list" input:{}'),
    description: 'Lists pending, approved, and rejected remote pairing requests.',
    policy:
      'Read-only. Call agent_operator_method methodId:"remote.pair.requests.list" input:{} to fetch the current pair request queue.',
  };
}

// ---------------------------------------------------------------------------
// Mutation surfaces, confirmed, return agent_operator_method handoff objects
// ---------------------------------------------------------------------------

export function remotePairApproveHandoff(args: AgentHarnessRemoteArgs): RemoteMethodHandoff {
  const requestId = readString(args.requestId || args.target);
  const note = readString(args.note);
  const input: Record<string, unknown> = { requestId };
  if (note) input.note = note;
  return {
    surface: 'remote_pair_approve',
    methodId: 'remote.pair.requests.approve',
    route: 'POST /api/remote/pair/requests/{requestId}/approve',
    effect: 'confirmed-connected-host-state',
    confirmationRequired: true,
    input,
    modelRoute: previewHarnessText(
      `agent_operator_method methodId:"remote.pair.requests.approve" input:${JSON.stringify(input)} confirm:true explicitUserRequest:"..."`,
    ),
    policy:
      'Mutation. Approves a pending remote pair request by requestId. Route it through agent_operator_method with confirm:true and the user\'s explicit request.',
  };
}

export function remotePairRejectHandoff(args: AgentHarnessRemoteArgs): RemoteMethodHandoff {
  const requestId = readString(args.requestId || args.target);
  const note = readString(args.note);
  const input: Record<string, unknown> = { requestId };
  if (note) input.note = note;
  return {
    surface: 'remote_pair_reject',
    methodId: 'remote.pair.requests.reject',
    route: 'POST /api/remote/pair/requests/{requestId}/reject',
    effect: 'confirmed-connected-host-state',
    confirmationRequired: true,
    input,
    modelRoute: previewHarnessText(
      `agent_operator_method methodId:"remote.pair.requests.reject" input:${JSON.stringify(input)} confirm:true explicitUserRequest:"..."`,
    ),
    policy:
      'Mutation. Rejects a pending remote pair request by requestId. Route it through agent_operator_method with confirm:true and the user\'s explicit request.',
  };
}

export function remotePeersInvokeHandoff(args: AgentHarnessRemoteArgs): RemoteMethodHandoff {
  const peerId = readString(args.peerId || args.target);
  const command = readString(args.command);
  const payload = readRecord(args.payload);
  const input: Record<string, unknown> = { peerId, command };
  if (Object.keys(payload).length > 0) input.payload = payload;
  return {
    surface: 'remote_peers_invoke',
    methodId: 'remote.peers.invoke',
    route: 'POST /api/remote/peers/{peerId}/invoke',
    effect: 'confirmed-connected-host-state',
    confirmationRequired: true,
    input,
    modelRoute: previewHarnessText(
      `agent_operator_method methodId:"remote.peers.invoke" input:${JSON.stringify(input)} confirm:true explicitUserRequest:"..."`,
    ),
    policy:
      'Mutation. Invokes a command on a connected remote peer. Requires peerId and command. Route through agent_operator_method with confirm:true and the user\'s explicit request.',
  };
}

export function remoteWorkCancelHandoff(args: AgentHarnessRemoteArgs): RemoteMethodHandoff {
  const workId = readString(args.workId || args.target);
  const reason = readString(args.reason);
  const input: Record<string, unknown> = { workId };
  if (reason) input.reason = reason;
  return {
    surface: 'remote_work_cancel',
    methodId: 'remote.work.cancel',
    route: 'POST /api/remote/work/{workId}/cancel',
    effect: 'confirmed-connected-host-state',
    confirmationRequired: true,
    input,
    modelRoute: previewHarnessText(
      `agent_operator_method methodId:"remote.work.cancel" input:${JSON.stringify(input)} confirm:true explicitUserRequest:"..."`,
    ),
    policy:
      'Mutation. Cancels a queued or leased remote work item by workId. Route through agent_operator_method with confirm:true and the user\'s explicit request.',
  };
}
