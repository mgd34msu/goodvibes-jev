/**
 * client-compatibility.ts, this build's own copy of the client-build-floor check.
 *
 * A daemon update swaps the daemon binary. It does not restart the clients already
 * attached to it: this browser tab, opened days earlier, keeps running its own build
 * and keeps participating in shared-session work under whatever rules that build
 * shipped with. A behavioral fix landed in the daemon is invisible for as long as one
 * stale client stays attached. The daemon publishes the minimum client build it will
 * accept as a full participant as the `X-Goodvibes-Client-Floor` response header
 * (CLIENT_COMPATIBILITY_FLOOR_HEADER below); a client below it says so plainly rather
 * than silently executing shared-session work under superseded rules.
 *
 * PROVENANCE: this logic is also implemented in the installed
 * @pellux/goodvibes-sdk (platform/control-plane/client-compatibility.ts,
 * evaluateClientCompatibility/compareBuildVersions/readClientCompatibilityFloor), but
 * that module is exported only through the daemon-facing `@goodvibes-jev/engine/sdk/platform/control-plane`
 * subpath, whose barrel also carries the gateway/session-broker/route-dispatch server
 * implementation (dispatchDaemonApiRoutes, SharedSessionBroker, ControlPlaneGateway, …),
 * not something this browser bundle should import. No browser-safe subpath exposes it at
 * the installed 2.0.0 pin (re-verified at this pin: `./platform/control-plane` is still
 * the only export surfacing it, and its barrel still carries the full server
 * implementation). This module is a small, independently-tested copy of the same three
 * functions' documented semantics, kept here until a future SDK release exposes them
 * through a seam this app can import directly (a `// SWAP:` seam, same pattern
 * contract-bridge-types.ts uses for a bridge type ahead of its generated counterpart).
 * Re-diffed field-by-field against the 2.0.0 SDK's
 * dist/platform/control-plane/client-compatibility.js at this re-pin: compareBuildVersions
 * and evaluateClientCompatibility are byte-identical in logic (the browser copy's
 * messages say "reload the page" / "Reload from the current install" where the SDK's
 * process-oriented copy says "restart it", a deliberate, permanent surface-appropriate
 * wording divergence, not drift to fix).
 *
 * ALSO NOTE: at the installed 2.0.0 pin the daemon's own HTTP router still never actually
 * writes this header onto a response, it only threads the constant name partway into an
 * internal context object with no consumer that calls it. So this module has nothing real
 * to read against a live 2.0.0 daemon today; it is exercised here by unit test with a
 * fabricated header, ready for the header the day a daemon actually sends it.
 */

/** Response header carrying the daemon's minimum acceptable client build. */
export const CLIENT_COMPATIBILITY_FLOOR_HEADER = 'X-Goodvibes-Client-Floor';

export type ClientCompatibilityStatus = 'ok' | 'restart-required' | 'unknown';

export interface ClientCompatibilityVerdict {
  readonly status: ClientCompatibilityStatus;
  /** One plain line naming the real situation, for a log or a notice. */
  readonly message: string;
  readonly clientVersion: string | undefined;
  readonly floor: string | undefined;
}

/**
 * Compare two dotted build versions numerically, segment by segment. Returns <0, 0, >0.
 * Pre-release suffixes ("1.14.0-rc.1") compare on their numeric prefix, so a release
 * candidate is treated as its release, this gates on behavior, and an rc carries it.
 */
export function compareBuildVersions(a: string, b: string): number {
  const parse = (value: string): number[] => value
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Judge this build against a floor the daemon announced.
 *
 * An unparseable or absent client version is 'unknown', NOT 'ok': the point of the
 * floor is that a build which cannot prove it carries a required behavior is treated
 * as one that does not. An absent floor is a different thing, a daemon too old to
 * publish one, and yields 'ok', because that daemon is not asking for anything.
 */
export function evaluateClientCompatibility(input: {
  readonly clientVersion: string | undefined;
  readonly floor: string | undefined;
}): ClientCompatibilityVerdict {
  const floor = input.floor?.trim();
  const clientVersion = input.clientVersion?.trim();

  if (!floor) {
    return {
      status: 'ok',
      message: 'The daemon publishes no client build floor; nothing to check.',
      clientVersion,
      floor: undefined,
    };
  }
  if (!clientVersion || !/\d/.test(clientVersion)) {
    return {
      status: 'unknown',
      message: `This build does not report a version, so it cannot be checked against the daemon's floor of ${floor}. Reload from the current install to be sure it is current.`,
      clientVersion,
      floor,
    };
  }
  if (compareBuildVersions(clientVersion, floor) < 0) {
    return {
      status: 'restart-required',
      message: `This tab is running build ${clientVersion}; the daemon requires ${floor} or newer. It has stopped taking shared-session work, reload the page to pick up the current build.`,
      clientVersion,
      floor,
    };
  }
  return {
    status: 'ok',
    message: `Build ${clientVersion} meets the daemon's floor of ${floor}.`,
    clientVersion,
    floor,
  };
}

/** Read the floor a daemon announced, from any response's headers. */
export function readClientCompatibilityFloor(headers: { get(name: string): string | null } | undefined): string | undefined {
  const value = headers?.get(CLIENT_COMPATIBILITY_FLOOR_HEADER)
    ?? headers?.get(CLIENT_COMPATIBILITY_FLOOR_HEADER.toLowerCase());
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Observed-floor store
// ---------------------------------------------------------------------------
//
// goodvibes.ts's requestJson/requestStream is the one HTTP helper every operator
// call passes through; it records whatever floor (or absence of one) the MOST
// RECENT response carried here, so any part of the app can read the daemon's
// current stance without threading a value through every call site, the same
// external-store shape lib/relay-connection.ts's active-route tracking already
// uses (subscribe/get, driven with React's useSyncExternalStore).

let observedFloor: string | undefined;
const listeners = new Set<(floor: string | undefined) => void>();

/** Record the floor the most recent daemon response carried (or none). */
export function recordObservedClientCompatibilityFloor(floor: string | undefined): void {
  if (floor === observedFloor) return;
  observedFloor = floor;
  for (const listener of listeners) listener(floor);
}

/** The floor the most recent daemon response carried, or undefined if none has. */
export function getObservedClientCompatibilityFloor(): string | undefined {
  return observedFloor;
}

/** Subscribe to floor changes. Returns an unsubscribe function. */
export function subscribeObservedClientCompatibilityFloor(listener: (floor: string | undefined) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
