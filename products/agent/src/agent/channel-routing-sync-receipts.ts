/**
 * channel-routing-sync-receipts.ts, what happened to routing assignments that
 * were written before the daemon held the routing table.
 *
 * Those records were stored with `daemonSyncState: 'local_only'` and a
 * `daemonMethodNeeded: 'channels.routing.assign'` flag, which said: this
 * assignment is real, and there is no daemon method to give it to. There is
 * one now, so the flag is retired, and retiring it quietly would erase the
 * only evidence an operator has that their assignment was ever in that state,
 * and whether it made it to the daemon afterwards.
 *
 * So each migrated record leaves a receipt naming the record, what the daemon
 * was asked, and what it answered. A record the daemon refused is reported as
 * refused rather than dropped: it stays live locally and is offered again.
 *
 * Bounded like every other persisted store here: newest first, capped, and a
 * parse failure reports itself instead of taking the feature down.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreJson } from '@/utils/store-file.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

export type ChannelRoutingSyncOutcomeKind = 'synced' | 'refused';

export interface ChannelRoutingSyncReceipt {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  /** The local record this receipt is about. */
  readonly routeId: string;
  readonly surfaceKind: string;
  readonly channelRouteId?: string;
  readonly profileId: string;
  /** The state the record carried before this migration touched it. */
  readonly previousSyncState: string;
  readonly outcome: ChannelRoutingSyncOutcomeKind;
  /** The daemon's id for the assignment, when it took it. */
  readonly daemonAssignmentId?: string;
  /** The daemon's own words, when it did not. */
  readonly error?: string;
  readonly methodId: string;
}

export interface ChannelRoutingSyncReceiptSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly receipts: readonly ChannelRoutingSyncReceipt[];
  readonly parseError?: string;
}

interface ChannelRoutingSyncReceiptFile {
  readonly version: 1;
  readonly receipts: readonly ChannelRoutingSyncReceipt[];
}

type ShellPaths = Pick<ShellPathService, 'resolveUserPath'>;

const RECEIPT_VERSION = 1 as const;
const RECEIPT_LIMIT = 200;

export function channelRoutingSyncReceiptPath(shellPaths: ShellPaths): string {
  return shellPaths.resolveUserPath(
    GOODVIBES_AGENT_SURFACE_ROOT,
    'channels',
    'routing-sync-receipts.json',
  );
}

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

function parseReceipt(value: unknown): ChannelRoutingSyncReceipt | null {
  if (!isRecord(value) || value.version !== RECEIPT_VERSION) return null;
  const id = readString(value.id);
  const createdAt = readString(value.createdAt);
  const routeId = readString(value.routeId);
  const surfaceKind = readString(value.surfaceKind);
  const profileId = readString(value.profileId);
  const methodId = readString(value.methodId);
  if (!id || !createdAt || !routeId || !surfaceKind || !profileId || !methodId) return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  const outcome = value.outcome === 'synced' ? 'synced' : 'refused';
  return {
    version: RECEIPT_VERSION,
    id,
    createdAt,
    routeId,
    surfaceKind,
    profileId,
    previousSyncState: readString(value.previousSyncState) || 'unknown',
    outcome,
    methodId,
    ...(readOptString(value.channelRouteId) ? { channelRouteId: readOptString(value.channelRouteId) } : {}),
    ...(readOptString(value.daemonAssignmentId) ? { daemonAssignmentId: readOptString(value.daemonAssignmentId) } : {}),
    ...(readOptString(value.error) ? { error: readOptString(value.error) } : {}),
  };
}

export function readChannelRoutingSyncReceipts(
  shellPaths: ShellPaths,
): ChannelRoutingSyncReceiptSnapshot {
  const path = channelRoutingSyncReceiptPath(shellPaths);
  if (!existsSync(path)) return { path, exists: false, receipts: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const receipts = isRecord(parsed) && Array.isArray(parsed.receipts)
      ? parsed.receipts.map(parseReceipt).filter((r): r is ChannelRoutingSyncReceipt => r !== null)
      : [];
    return { path, exists: true, receipts };
  } catch (error) {
    return {
      path,
      exists: true,
      receipts: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Record receipts, newest first. Returns the path written. */
export function appendChannelRoutingSyncReceipts(
  shellPaths: ShellPaths,
  receipts: readonly ChannelRoutingSyncReceipt[],
): string {
  const path = channelRoutingSyncReceiptPath(shellPaths);
  if (receipts.length === 0) return path;
  const existing = readChannelRoutingSyncReceipts(shellPaths).receipts;
  const file: ChannelRoutingSyncReceiptFile = {
    version: RECEIPT_VERSION,
    receipts: [...receipts, ...existing].slice(0, RECEIPT_LIMIT),
  };
  writeStoreJson(path, file);
  return path;
}

export function formatChannelRoutingSyncReceipts(
  snapshot: ChannelRoutingSyncReceiptSnapshot,
): string {
  const lines = [
    'Channel Routing Sync Receipts',
    `  path: ${snapshot.path}`,
    `  total: ${snapshot.receipts.length}`,
    ...(snapshot.parseError ? [`  parse error: ${snapshot.parseError}`] : []),
    '',
  ];
  if (snapshot.receipts.length === 0) {
    lines.push('  no routing sync receipts');
    return lines.join('\n');
  }
  for (const receipt of snapshot.receipts) {
    const channel = receipt.channelRouteId
      ? `${receipt.surfaceKind}:${receipt.channelRouteId}`
      : receipt.surfaceKind;
    const tail = receipt.outcome === 'synced'
      ? `daemon assignment=${receipt.daemonAssignmentId ?? 'unknown'}`
      : `refused: ${receipt.error ?? 'no reason given'}`;
    lines.push(
      `  ${receipt.createdAt}  ${receipt.routeId}  channel=${channel} → profile=${receipt.profileId}  was=${receipt.previousSyncState}  ${tail}`,
    );
  }
  return lines.join('\n');
}
