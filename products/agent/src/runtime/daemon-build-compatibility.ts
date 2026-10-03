/**
 * Daemon build compatibility, the other half of the build handshake.
 *
 * client-build-compatibility.ts is this process being judged: the daemon
 * publishes the oldest client it will let participate, and a build below that
 * floor stops taking shared-session work. This file is the reverse, and the
 * exposure it covers is real in a way that is easy to miss.
 *
 * This process talks to a daemon it did not start and cannot see, over a base
 * URL that may point at another machine. Every capability it has is something
 * the daemon performs on its behalf. When the daemon is too old to serve a verb
 * this build depends on, what an operator observes is one call returning 400 or
 * 404, which reads as a broken feature, not as an old daemon. The Agent keeps
 * running, half-working, against a peer nobody has any reason to suspect.
 *
 * So the daemon's build is checked once per attach against a floor this product
 * declares, using the `version` that `/status` has returned since the route
 * existed. The comparison is the SDK's (`evaluateDaemonStatusCompatibility`);
 * what lives here is this process's state around it, the latch, and the
 * once-only notification, for the same reason the forward guard's does.
 *
 * ON THE FLOOR VALUE
 *
 * `AGENT_DAEMON_BUILD_FLOOR` is '1.28.0'. The SDK is explicit that the floor
 * belongs to the consumer, not the platform: "the TUI, the agent and the web
 * UI need different daemon behaviors at different times, and a single
 * SDK-wide constant would either over-refuse for one of them or under-refuse
 * for another. Each consumer passes its own and states, in its own release
 * notes, what it raised the floor for."
 *
 * This is a breaking change: the daemon is its own product, with its own
 * repository, package and release line, separate from the embedded topology
 * this Agent built and shipped alongside itself before that split. A daemon
 * build below 1.28.0 belongs to that earlier topology.
 *
 * The floor REFUSES, it does not merely warn. A daemon below it is not adopted:
 * `judgeForAdoption` is asked before the memory spine activates, and a
 * below-floor answer means the spine stays on its local store, the inbound
 * continuation dispatch never binds, and every daemon-dependent path takes the
 * same route it takes when no daemon is configured at all, plus one notice
 * naming both versions. Half-adopting an old daemon is the state this exists to
 * prevent, so the refusal is at adoption, which is the single place adoption is
 * decided, rather than at each capability's call site.
 *
 * The owner is told exactly once, naming both versions, and the number is
 * recorded in this repository's CHANGELOG and release notes because raising the
 * floor costs every operator on an older daemon that notice and a forced update.
 */

import {
  evaluateDaemonStatusCompatibility,
  type DaemonCompatibilityVerdict,
} from '@goodvibes-jev/engine/sdk/platform/control-plane';

export type { DaemonCompatibilityVerdict };
export { evaluateDaemonStatusCompatibility };

/**
 * The oldest daemon build this Agent will work against, or undefined for "this
 * client is not asking for anything". See the note above before changing it.
 */
export const AGENT_DAEMON_BUILD_FLOOR: string | undefined = '1.28.0';

export interface DaemonBuildGuardOptions {
  /** The floor this client declares. Undefined means it declares none. */
  readonly floor?: string | undefined;
  /**
   * Invoked once, the first time an attached daemon is judged too old. Wiring
   * it to a visible surface is what turns "the daemon needs updating" into
   * something the owner actually sees, rather than a verb that quietly 404s.
   */
  readonly onDaemonUpdateRequired?: ((verdict: DaemonCompatibilityVerdict) => void) | undefined;
}

/**
 * The live verdict about the daemon this process is attached to.
 *
 * Latched, for the mirror image of the forward guard's reason: once a daemon
 * has been judged too old, a later read that cannot determine a version (a
 * restart, a truncated response) must not silently clear the finding.
 *
 * The latch is dropped by `reset()`, which the attach path calls when it moves
 * to a DIFFERENT daemon, a verdict about the old peer says nothing about the
 * new one, and carrying it over would report the wrong machine as stale.
 */
export class DaemonBuildGuard {
  private verdict: DaemonCompatibilityVerdict;
  private announced = false;

  constructor(private readonly options: DaemonBuildGuardOptions = {}) {
    this.verdict = this.initialVerdict();
  }

  private initialVerdict(): DaemonCompatibilityVerdict {
    return {
      status: 'ok',
      message: 'No daemon build observed yet.',
      daemonVersion: undefined,
      floor: this.options.floor,
    };
  }

  /** Feed a parsed `/status` body. `daemonLabel` names the peer in the message. */
  observeStatus(statusPayload: unknown, daemonLabel?: string): DaemonCompatibilityVerdict {
    if (this.verdict.status === 'daemon-update-required') return this.verdict;
    const next = evaluateDaemonStatusCompatibility(statusPayload, this.options.floor, daemonLabel);
    this.verdict = next;
    if (next.status === 'daemon-update-required' && !this.announced) {
      this.announced = true;
      this.options.onDaemonUpdateRequired?.(next);
    }
    return next;
  }

  /**
   * Judge a freshly-read `/status` for the ADOPTION decision.
   *
   * Unlatched, unlike `observeStatus`, and deliberately so: a daemon CAN become
   * new enough while this process runs, that is exactly what a daemon update
   * does, and the attach that sees the newer build has to be allowed to adopt
   * it. The latch exists to stop an UNREADABLE later read from clearing a
   * finding; a read that positively reports a new-enough build is not that, so
   * it clears the finding and re-arms the notice for a future refusal.
   *
   * `observeStatus` keeps its latched behaviour for the capability verdict.
   * This is the one the adoption path calls.
   */
  judgeForAdoption(statusPayload: unknown, daemonLabel?: string): DaemonCompatibilityVerdict {
    const next = evaluateDaemonStatusCompatibility(statusPayload, this.options.floor, daemonLabel);
    this.verdict = next;
    if (next.status === 'daemon-update-required') {
      if (!this.announced) {
        this.announced = true;
        this.options.onDaemonUpdateRequired?.(next);
      }
      return next;
    }
    // A daemon that now meets the floor is a different situation from the one
    // that was announced, so the next refusal gets to speak again.
    this.announced = false;
    return next;
  }

  /**
   * False once the attached daemon has been judged too old for this build.
   *
   * This is what the adoption path asks before routing anything over the wire:
   * a daemon below the floor is not adopted at all, so the spine stays local and
   * the daemon-dependent services take the same path they take when no daemon is
   * configured. It is not a per-capability question asked at each call site,
   * adoption is the single choke point.
   */
  mayUseDaemonCapabilities(): boolean {
    return this.verdict.status !== 'daemon-update-required';
  }

  /** Forget everything observed. For an attach to a different daemon. */
  reset(): void {
    this.verdict = this.initialVerdict();
    this.announced = false;
  }

  current(): DaemonCompatibilityVerdict {
    return this.verdict;
  }
}

export interface DaemonStatusConnection {
  readonly baseUrl: string;
  readonly token: string | null;
}

/**
 * Read `/status` for the daemon's build.
 *
 * Its own read rather than a field pulled off the liveness probe: that probe
 * reports reachability as a boolean and surfaces only the client-floor header,
 * so the body carrying `version` never reaches a caller. Best-effort by
 * design, an unreachable daemon yields null, which the guard reads as
 * "nothing observed" rather than as a verdict.
 */
export async function readDaemonStatusPayload(
  connection: DaemonStatusConnection,
  options: { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch } = {},
): Promise<unknown | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, options.timeoutMs ?? 2000);
  try {
    const response = await fetchImpl(`${connection.baseUrl}/status`, {
      signal: controller.signal,
      ...(connection.token ? { headers: { authorization: `Bearer ${connection.token}` } } : {}),
    });
    if (!response.ok) return null;
    return await response.json() as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
