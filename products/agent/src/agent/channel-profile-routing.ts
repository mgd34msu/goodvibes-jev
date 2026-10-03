/**
 * channel-profile-routing.ts
 *
 * Which profile an incoming channel interaction is answered as.
 *
 * An assignment binds a channel (surface kind, optional route id) to a
 * GoodVibes profile. The daemon owns the routing table the platform routes
 * against, `channels.routing.assign` writes it, and every surface reads the
 * same one, so an assignment made here is offered to the daemon first and
 * kept here as well.
 *
 * The local file is a MIRROR, not a second opinion. It exists because the
 * daemon is a peer this process does not control: a laptop off the LAN, a
 * daemon mid-restart, a token not yet minted. An assignment made in one of
 * those moments is still the operator's instruction, and dropping it because
 * the peer was busy would be worse than holding it. Held assignments carry
 * `daemonSyncState: 'pending'` with the reason the daemon gave, and
 * `syncChannelProfileRoutes` offers them again.
 *
 * Persistence: JSON file at {agentRoot}/channels/profile-routes.json via
 * ShellPathService.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreJson } from '@/utils/store-file.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { DaemonInvokeFailureKind, DaemonOperatorInvoke } from './daemon-operator-client.ts';
import {
  appendChannelRoutingSyncReceipts,
  type ChannelRoutingSyncReceipt,
} from './channel-routing-sync-receipts.ts';

/** The daemon method that owns the routing table. */
export const CHANNEL_ROUTING_ASSIGN_METHOD = 'channels.routing.assign';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Where an assignment stands with the daemon.
 *
 * `synced`, the daemon holds it, and `assignmentId` is the daemon's own id.
 * `pending`, it was offered and the daemon did not take it; `syncError` says
 *   why, in the daemon's words. The assignment is live locally and will be
 *   offered again.
 */
export type ChannelProfileRouteSyncState = 'synced' | 'pending';

/**
 * Represents a channel-to-profile assignment.
 *
 * `surfaceKind` maps to the existing ChannelDeliverySurfaceKind values
 * (slack, discord, telegram, etc.) plus 'any' as a wildcard.
 */
export interface ChannelProfileRoute {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The channel surface kind (e.g. 'slack', 'discord', 'telegram'). Use 'any' as wildcard. */
  readonly surfaceKind: string;
  /** Optional route id to narrow beyond surface kind. */
  readonly routeId?: string;
  /** The profile id to route this channel to. */
  readonly profileId: string;
  /** Optional human-readable label. */
  readonly label?: string;
  /** Whether the daemon holds this assignment. */
  readonly daemonSyncState: ChannelProfileRouteSyncState;
  /** The daemon's id for this assignment, once it has taken it. */
  readonly daemonAssignmentId?: string;
  /** Why the daemon did not take it, in the daemon's words. Absent when synced. */
  readonly syncError?: string;
  /** The classified shape of that refusal, for a caller that renders by kind. */
  readonly syncFailureKind?: DaemonInvokeFailureKind;
}

export interface ChannelProfileRouteSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly routes: readonly ChannelProfileRoute[];
  readonly parseError?: string;
}

export interface ChannelProfileRouteAssignResult {
  readonly route: ChannelProfileRoute;
  readonly path: string;
  readonly created: boolean;
  /** What the daemon said when this assignment was offered to it. */
  readonly daemon: ChannelProfileRouteSyncOutcome;
}

/** The result of offering one assignment to the daemon. */
export type ChannelProfileRouteSyncOutcome =
  | { readonly synced: true; readonly assignmentId: string }
  | { readonly synced: false; readonly kind: DaemonInvokeFailureKind; readonly error: string }
  /** No daemon transport was supplied, so nothing was offered and nothing is claimed. */
  | { readonly synced: false; readonly kind: 'not_attempted'; readonly error: string };

// ---------------------------------------------------------------------------
// Internal file model
// ---------------------------------------------------------------------------

interface ChannelProfileRouteFile {
  readonly version: 1;
  readonly routes: readonly ChannelProfileRoute[];
}

type ShellPaths = Pick<ShellPathService, 'resolveUserPath'>;

const ROUTE_VERSION = 1 as const;
const ROUTE_FILE_VERSION = 1 as const;
const ROUTE_LIMIT = 500;

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

export function channelProfileRouteFilePath(shellPaths: ShellPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'channels', 'profile-routes.json');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptString(value: unknown): string | undefined {
  const s = readString(value);
  return s || undefined;
}

function parseSyncState(value: unknown): ChannelProfileRouteSyncState {
  // Anything else, including the retired 'local_only' written by builds from
  // before the daemon held this table, reads as pending. That is the honest
  // reading: the daemon has not been told about the record, so it is owed an
  // offer, and `syncChannelProfileRoutes` makes it.
  return value === 'synced' ? 'synced' : 'pending';
}

function parseRoute(value: unknown): ChannelProfileRoute | null {
  if (!isRecord(value) || value.version !== ROUTE_VERSION) return null;
  const id = readString(value.id);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  const surfaceKind = readString(value.surfaceKind);
  const profileId = readString(value.profileId);
  if (!id || !createdAt || !updatedAt || !surfaceKind || !profileId) return null;
  if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) return null;
  const daemonSyncState = parseSyncState(value.daemonSyncState);
  return {
    version: ROUTE_VERSION,
    id,
    createdAt,
    updatedAt,
    surfaceKind,
    profileId,
    ...( readOptString(value.routeId) ? { routeId: readOptString(value.routeId) } : {}),
    ...( readOptString(value.label) ? { label: readOptString(value.label) } : {}),
    daemonSyncState,
    ...( readOptString(value.daemonAssignmentId) ? { daemonAssignmentId: readOptString(value.daemonAssignmentId) } : {}),
    ...( daemonSyncState === 'pending' && readOptString(value.syncError) ? { syncError: readOptString(value.syncError) } : {}),
  };
}

function parseRouteFile(raw: unknown): ChannelProfileRouteFile {
  if (!isRecord(raw)) return { version: ROUTE_FILE_VERSION, routes: [] };
  const routes = Array.isArray(raw.routes)
    ? raw.routes.map(parseRoute).filter((r): r is ChannelProfileRoute => r !== null)
    : [];
  return { version: ROUTE_FILE_VERSION, routes };
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export function readChannelProfileRoutes(shellPaths: ShellPaths): ChannelProfileRouteSnapshot {
  const path = channelProfileRouteFilePath(shellPaths);
  if (!existsSync(path)) return { path, exists: false, routes: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return { path, exists: true, routes: parseRouteFile(parsed).routes };
  } catch (error) {
    return {
      path,
      exists: true,
      routes: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeRoutes(path: string, routes: readonly ChannelProfileRoute[]): void {
  const file: ChannelProfileRouteFile = {
    version: ROUTE_FILE_VERSION,
    routes: routes.slice(0, ROUTE_LIMIT),
  };
  writeStoreJson(path, file);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function readDaemonAssignmentId(body: unknown): string {
  if (!isRecord(body)) return '';
  return readString(body.assignmentId);
}

/**
 * Offer one assignment to the daemon's routing table.
 *
 * `confirm: true` plus the explicit-user-request claim is what the daemon's
 * confirmation gate asks for. Both are honest at this call site: an assignment
 * only reaches here through the harness's own confirmed-action gate, which
 * already required the operator to ask for it by name.
 */
async function offerRouteToDaemon(
  invoke: DaemonOperatorInvoke | undefined,
  route: ChannelProfileRoute,
): Promise<ChannelProfileRouteSyncOutcome> {
  if (!invoke) {
    return {
      synced: false,
      kind: 'not_attempted',
      error: 'no connected-host transport was supplied, so the daemon was not offered this assignment',
    };
  }
  const result = await invoke(
    CHANNEL_ROUTING_ASSIGN_METHOD,
    {
      surfaceKind: route.surfaceKind,
      profileId: route.profileId,
      ...(route.routeId ? { routeId: route.routeId } : {}),
      ...(route.label ? { label: route.label } : {}),
      confirm: true,
    },
    { explicitUserRequest: true },
  );
  if (!result.ok) return { synced: false, kind: result.kind, error: result.error };
  const assignmentId = readDaemonAssignmentId(result.body);
  if (!assignmentId) {
    return {
      synced: false,
      kind: 'connected_host_error',
      error: `${CHANNEL_ROUTING_ASSIGN_METHOD} answered without an assignmentId, so nothing proves the daemon holds this assignment`,
    };
  }
  return { synced: true, assignmentId };
}

/** Fold a sync outcome onto a record, so the record states only what is true. */
function withSyncOutcome(
  route: ChannelProfileRoute,
  outcome: ChannelProfileRouteSyncOutcome,
): ChannelProfileRoute {
  if (outcome.synced) {
    const { syncError: _dropped, syncFailureKind: _alsoDropped, ...rest } = route;
    return { ...rest, daemonSyncState: 'synced', daemonAssignmentId: outcome.assignmentId };
  }
  return {
    ...route,
    daemonSyncState: 'pending',
    syncError: outcome.error,
    ...(outcome.kind === 'not_attempted' ? {} : { syncFailureKind: outcome.kind }),
  };
}

/**
 * Assign a channel (identified by surfaceKind + optional routeId) to a profile.
 *
 * If an assignment for the same (surfaceKind, routeId) pair already exists,
 * it is updated in-place. Otherwise a new assignment is created.
 *
 * The daemon is offered the assignment first, because the daemon's table is the
 * one the platform routes against. The local write happens either way: the
 * record is the operator's instruction, and a daemon that could not be reached
 * is a reason to hold it, not to lose it.
 */
export async function assignChannelToProfile(
  shellPaths: ShellPaths,
  input: {
    readonly surfaceKind: string;
    readonly routeId?: string;
    readonly profileId: string;
    readonly label?: string;
  },
  options: { readonly invoke?: DaemonOperatorInvoke } = {},
): Promise<ChannelProfileRouteAssignResult> {
  const surfaceKind = input.surfaceKind.trim();
  const profileId = input.profileId.trim();
  if (!surfaceKind) throw new Error('surfaceKind is required for channel-to-profile assignment.');
  if (!profileId) throw new Error('profileId is required for channel-to-profile assignment.');

  const snapshot = readChannelProfileRoutes(shellPaths);
  const path = channelProfileRouteFilePath(shellPaths);
  const now = new Date().toISOString();

  // Find existing assignment for the same (surfaceKind, routeId) pair
  const routeId = input.routeId?.trim() || undefined;
  const existingIndex = snapshot.routes.findIndex(
    (r) => r.surfaceKind === surfaceKind && r.routeId === routeId,
  );
  const existing = existingIndex >= 0 ? snapshot.routes[existingIndex] : null;
  const created = !existing;

  const draft: ChannelProfileRoute = {
    version: ROUTE_VERSION,
    id: existing?.id ?? `cpr-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    surfaceKind,
    profileId,
    ...(routeId ? { routeId } : {}),
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    daemonSyncState: 'pending',
  };

  const daemon = await offerRouteToDaemon(options.invoke, draft);
  const route = withSyncOutcome(draft, daemon);

  let updatedRoutes: readonly ChannelProfileRoute[];
  if (existingIndex >= 0) {
    updatedRoutes = snapshot.routes.map((r, i) => (i === existingIndex ? route : r));
  } else {
    updatedRoutes = [route, ...snapshot.routes];
  }

  writeRoutes(path, updatedRoutes);
  return { route, path, created, daemon };
}

/**
 * The `daemonSyncState` values as they sit on disk, keyed by record id.
 *
 * Read raw rather than through `parseRoute`, which normalizes the retired
 * `local_only` to `pending`. A migration receipt has to name the state the
 * record was ACTUALLY in, and after normalization that information is gone.
 */
function readOnDiskSyncStates(shellPaths: ShellPaths): Map<string, string> {
  const states = new Map<string, string>();
  const path = channelProfileRouteFilePath(shellPaths);
  if (!existsSync(path)) return states;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.routes)) return states;
    for (const entry of parsed.routes) {
      if (!isRecord(entry)) continue;
      const id = readString(entry.id);
      if (id) states.set(id, readString(entry.daemonSyncState) || 'unknown');
    }
  } catch {
    // A file that will not parse has no states to report; the snapshot reader
    // is what surfaces the parse error to a caller.
  }
  return states;
}

export interface ChannelProfileRouteSyncReport {
  readonly attempted: number;
  readonly synced: number;
  readonly refused: number;
  readonly routes: readonly ChannelProfileRoute[];
  /** Where the receipts for this run were written, when any were. */
  readonly receiptPath?: string;
}

/**
 * Offer every assignment the daemon does not hold, and receipt what happened.
 *
 * This is both the retry for an assignment made while the daemon was
 * unreachable and the migration for records written before the daemon held
 * this table at all. The two are the same operation: a record the daemon does
 * not have, offered to it.
 *
 * Records that came from a build that wrote `daemonSyncState: 'local_only'`
 * carried a `daemonMethodNeeded` flag naming the method that did not exist.
 * The method exists now, so the flag is retired, with a receipt naming the
 * record and the daemon's answer, rather than by deleting the field and
 * leaving nothing behind.
 */
export async function syncChannelProfileRoutes(
  shellPaths: ShellPaths,
  invoke: DaemonOperatorInvoke,
): Promise<ChannelProfileRouteSyncReport> {
  const snapshot = readChannelProfileRoutes(shellPaths);
  const previousStates = readOnDiskSyncStates(shellPaths);
  const pending = snapshot.routes.filter((route) => route.daemonSyncState !== 'synced');
  if (pending.length === 0) {
    return { attempted: 0, synced: 0, refused: 0, routes: snapshot.routes };
  }

  const receipts: ChannelRoutingSyncReceipt[] = [];
  const updatedById = new Map<string, ChannelProfileRoute>();
  const now = new Date().toISOString();
  let synced = 0;
  let refused = 0;

  for (const route of pending) {
    const outcome = await offerRouteToDaemon(invoke, route);
    const next = withSyncOutcome(route, outcome);
    updatedById.set(route.id, next);
    if (outcome.synced) synced += 1;
    else refused += 1;
    receipts.push({
      version: 1,
      id: `crs-${now.replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      createdAt: now,
      routeId: route.id,
      surfaceKind: route.surfaceKind,
      profileId: route.profileId,
      previousSyncState: previousStates.get(route.id) ?? 'unknown',
      outcome: outcome.synced ? 'synced' : 'refused',
      methodId: CHANNEL_ROUTING_ASSIGN_METHOD,
      ...(route.routeId ? { channelRouteId: route.routeId } : {}),
      ...(outcome.synced ? { daemonAssignmentId: outcome.assignmentId } : { error: outcome.error }),
    });
  }

  const routes = snapshot.routes.map((route) => updatedById.get(route.id) ?? route);
  writeRoutes(channelProfileRouteFilePath(shellPaths), routes);
  const receiptPath = appendChannelRoutingSyncReceipts(shellPaths, receipts);
  return { attempted: pending.length, synced, refused, routes, receiptPath };
}

/** List all channel-to-profile assignments, optionally filtered by profileId. */
export function listChannelProfileRoutes(
  shellPaths: ShellPaths,
  options: { readonly profileId?: string; readonly surfaceKind?: string } = {},
): ChannelProfileRouteSnapshot {
  const snapshot = readChannelProfileRoutes(shellPaths);
  let routes = snapshot.routes;
  if (options.profileId) {
    routes = routes.filter((r) => r.profileId === options.profileId);
  }
  if (options.surfaceKind) {
    routes = routes.filter((r) => r.surfaceKind === options.surfaceKind || r.surfaceKind === 'any');
  }
  return { ...snapshot, routes };
}

/**
 * Get the profile id for an incoming channel message.
 *
 * Resolution order: exact (surfaceKind + routeId) → surface wildcard (surfaceKind only) → any wildcard.
 * Returns null if no assignment exists.
 */
export function getProfileForChannel(
  shellPaths: ShellPaths,
  surfaceKind: string,
  routeId?: string,
): string | null {
  const snapshot = readChannelProfileRoutes(shellPaths);
  const { routes } = snapshot;

  // Exact match: surfaceKind + routeId
  if (routeId) {
    const exact = routes.find((r) => r.surfaceKind === surfaceKind && r.routeId === routeId);
    if (exact) return exact.profileId;
  }

  // Surface match: surfaceKind only (no routeId on the assignment)
  const surfaceMatch = routes.find((r) => r.surfaceKind === surfaceKind && !r.routeId);
  if (surfaceMatch) return surfaceMatch.profileId;

  // Wildcard match
  const wildcard = routes.find((r) => r.surfaceKind === 'any');
  if (wildcard) return wildcard.profileId;

  return null;
}

/** Remove a channel-to-profile assignment by id. Returns true if removed. */
export function removeChannelProfileRoute(
  shellPaths: ShellPaths,
  routeId: string,
): boolean {
  const snapshot = readChannelProfileRoutes(shellPaths);
  const before = snapshot.routes.length;
  const updated = snapshot.routes.filter((r) => r.id !== routeId);
  if (updated.length === before) return false;
  writeRoutes(channelProfileRouteFilePath(shellPaths), updated);
  return true;
}

/** Format the routing table for human-readable output. */
export function formatChannelProfileRoutes(snapshot: ChannelProfileRouteSnapshot): string {
  const pending = snapshot.routes.filter((route) => route.daemonSyncState !== 'synced').length;
  const lines = [
    'Channel-to-Profile Routing',
    `  path: ${snapshot.path}`,
    `  total: ${snapshot.routes.length}`,
    `  daemon: ${snapshot.routes.length - pending} synced, ${pending} awaiting ${CHANNEL_ROUTING_ASSIGN_METHOD}`,
    `  status: ${snapshot.parseError ? 'attention' : snapshot.exists ? 'ready' : 'empty'}`,
    ...(snapshot.parseError ? [`  parse error: ${snapshot.parseError}`] : []),
    '',
  ];
  if (snapshot.routes.length === 0) {
    lines.push('  no channel-to-profile assignments');
  } else {
    for (const route of snapshot.routes) {
      const channelDesc = route.routeId ? `${route.surfaceKind}:${route.routeId}` : route.surfaceKind;
      lines.push(`  ${route.id}  channel=${channelDesc} → profile=${route.profileId}${route.label ? ` (${route.label})` : ''}  sync=${route.daemonSyncState}`);
      if (route.syncError) lines.push(`    daemon: ${route.syncError}`);
    }
  }
  return lines.join('\n');
}
