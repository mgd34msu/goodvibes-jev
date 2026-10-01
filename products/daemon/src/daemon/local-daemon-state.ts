/**
 * local-daemon-state.ts, the two files a daemon writes about ITSELF.
 *
 * `status` and `update` want to report things no control-plane verb answers:
 * how long the daemon has been up, whether the last start followed a crash,
 * which version an automatic rollback rejected, and what the daemon has
 * written receipts about. All of that lives on the daemon's own host, in two
 * JSON files beside its control-plane state:
 *
 *   <control-plane config dir>/control-plane/daemon-lifecycle.json
 *   <control-plane config dir>/control-plane/daemon-receipts.json
 *
 * They are READ here and never written, and the receipts are never marked
 * delivered, `/status?receipts=consume` hands each receipt to the first
 * consuming reader exactly once, and a status command that quietly consumed
 * them would take them away from the surface they were written for.
 *
 * Which is also why this is honestly local-only: a `status --host other-box`
 * has no access to that box's filesystem, and these lines are reported as
 * unavailable rather than guessed at. See `describeLocalDaemonState`.
 *
 * The SDK owns the writers (`platform/daemon/lifecycle-marker.ts`,
 * `platform/daemon/receipts.ts`) and its readers are not exported from the
 * published package this repository pins, so the readers below are this
 * repository's own, bounded and content-validated the same way, and no more
 * trusting of the file than the SDK is. The shared-piece lane can re-point them
 * at the SDK's own readers once those are exported.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Mirrors the SDK's own clamp: a hand-edited counter is bounded, not trusted. */
const MAX_TRACKED_FAILED_STARTS = 32;
/** Mirrors the SDK's own clamp on a persisted version string. */
const MAX_TRACKED_VERSION_LENGTH = 64;
/** Enough receipts to explain a restart; a status page is not a log viewer. */
const MAX_REPORTED_RECEIPTS = 10;

export interface DaemonLifecycleMarker {
  readonly state: 'running' | 'clean-shutdown';
  readonly at: number;
  readonly pid: number | undefined;
  readonly failedStarts: number;
  readonly version: string | undefined;
  /** The version an automatic rollback moved AWAY from, the build that crash looped. */
  readonly rejectedVersion: string | undefined;
  /** When an automatic rollback last restored the kept previous binary. */
  readonly autoRollbackAt: number | undefined;
}

export interface DaemonReceipt {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly deliveredAt: number | undefined;
}

export interface LocalDaemonStatePaths {
  readonly markerPath: string;
  readonly receiptsPath: string;
}

/** The two paths, derived the same way the daemon facade derives them. */
export function localDaemonStatePaths(controlPlaneConfigDir: string): LocalDaemonStatePaths {
  return {
    markerPath: join(controlPlaneConfigDir, 'control-plane', 'daemon-lifecycle.json'),
    receiptsPath: join(controlPlaneConfigDir, 'control-plane', 'daemon-receipts.json'),
  };
}

export interface LocalStateIo {
  read(path: string): string | null;
}

export const realLocalStateIo: LocalStateIo = {
  read(path: string): string | null {
    try {
      return existsSync(path) ? readFileSync(path, 'utf-8') : null;
    } catch {
      return null;
    }
  },
};

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The marker as it stands, or null when there is none or it does not validate. */
export function readDaemonLifecycleMarker(
  markerPath: string,
  io: LocalStateIo = realLocalStateIo,
): DaemonLifecycleMarker | null {
  const raw = io.read(markerPath);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const state = record['state'];
  if (state !== 'running' && state !== 'clean-shutdown') return null;
  const at = finiteNumber(record['at']);
  if (at === undefined) return null;
  const failedStarts = finiteNumber(record['failedStarts']) ?? 0;
  return {
    state,
    at,
    pid: finiteNumber(record['pid']),
    failedStarts: Math.max(0, Math.min(MAX_TRACKED_FAILED_STARTS, Math.trunc(failedStarts))),
    version: boundedString(record['version'], MAX_TRACKED_VERSION_LENGTH),
    rejectedVersion: boundedString(record['rejectedVersion'], MAX_TRACKED_VERSION_LENGTH),
    autoRollbackAt: finiteNumber(record['autoRollbackAt']),
  };
}

/**
 * The receipts the daemon has written, newest last, capped.
 *
 * Read-only: nothing here marks a receipt delivered. The store's own
 * consume path is what a surface uses when it means to claim them.
 */
export function readDaemonReceipts(
  receiptsPath: string,
  io: LocalStateIo = realLocalStateIo,
): readonly DaemonReceipt[] {
  const raw = io.read(receiptsPath);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // The store persists either a bare array or `{ receipts: [...] }` depending
  // on its version; both are read rather than one being assumed.
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { receipts?: unknown }).receipts)
      ? (parsed as { receipts: unknown[] }).receipts
      : [];
  const receipts: DaemonReceipt[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const text = typeof record['text'] === 'string' ? record['text'] : undefined;
    const at = finiteNumber(record['at']);
    if (text === undefined || at === undefined) continue;
    receipts.push({
      id: typeof record['id'] === 'string' ? record['id'] : `${at}`,
      text,
      at,
      deliveredAt: finiteNumber(record['deliveredAt']),
    });
  }
  return receipts.slice(-MAX_REPORTED_RECEIPTS);
}

export interface LocalDaemonState {
  /** False when the caller asked about another machine, nothing below was read. */
  readonly available: boolean;
  /** Why it is unavailable, when it is. */
  readonly unavailableReason: string | undefined;
  readonly marker: DaemonLifecycleMarker | null;
  readonly receipts: readonly DaemonReceipt[];
  /** Milliseconds since the marker said the daemon started, when it says it is running. */
  readonly uptimeMs: number | undefined;
  /** True when an automatic rollback is in force and no clean start has cleared it. */
  readonly rolledBack: boolean;
}

export interface DescribeLocalDaemonStateInput {
  /** False for a remote target: nothing is read and the lines say why. */
  readonly isLocal: boolean;
  readonly controlPlaneConfigDir: string;
  readonly now?: (() => number) | undefined;
  readonly io?: LocalStateIo | undefined;
}

/**
 * What this machine's own files say about the daemon.
 *
 * Never throws and never asserts: an absent marker is an absent marker, which
 * is the ordinary state on a host where the daemon has not started yet.
 */
export function describeLocalDaemonState(input: DescribeLocalDaemonStateInput): LocalDaemonState {
  if (!input.isLocal) {
    return {
      available: false,
      unavailableReason:
        'the uptime, update receipts and rollback state are read from files on the daemon\'s own host; '
        + 'run this command on that machine to see them',
      marker: null,
      receipts: [],
      uptimeMs: undefined,
      rolledBack: false,
    };
  }
  const io = input.io ?? realLocalStateIo;
  const paths = localDaemonStatePaths(input.controlPlaneConfigDir);
  const marker = readDaemonLifecycleMarker(paths.markerPath, io);
  const receipts = readDaemonReceipts(paths.receiptsPath, io);
  const now = input.now?.() ?? Date.now();
  const uptimeMs = marker && marker.state === 'running' && marker.at <= now ? now - marker.at : undefined;
  return {
    available: true,
    unavailableReason: undefined,
    marker,
    receipts,
    uptimeMs,
    rolledBack: marker?.autoRollbackAt !== undefined,
  };
}

/** `3d 4h`, `4h 12m`, `12m 3s`, `9s`, two units, never more. */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
