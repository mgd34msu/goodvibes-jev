/**
 * Client build compatibility, this process's half of the daemon's floor.
 *
 * A daemon update swaps the daemon binary and nothing else. This process keeps
 * running the build it started with: same rules, same bugs, still attached to
 * the same shared session store, still able to execute shared-session work.
 * That is how a behavioral fix can land in the daemon, be verified present in
 * the installed binaries, and still not change what the owner observes, an
 * older process beside the new daemon simply keeps doing the old thing.
 *
 * So the daemon publishes the minimum client build it will let participate, as
 * an `X-Goodvibes-Client-Floor` response header on `/status`, the liveness
 * read this process already performs on a timer. When this build is below that
 * floor it says so plainly and stops taking shared-session work, rather than
 * quietly executing under superseded rules until someone notices.
 *
 * WHERE THIS RULE LIVES
 *
 * The comparison itself (`evaluateClientCompatibility`, the header name, the
 * verdict shape) is owned by the SDK, platform/control-plane/client-compatibility.ts,
 * public since the 1.21.0 re-pin, and imported below rather than duplicated.
 *
 * `ClientBuildGuard` stays local. It is not a second comparison; it is this
 * process's state around the SDK's: the latch, and the once-only notification.
 * Both are facts about THIS process's lifetime, how long it has been attached,
 * whether the owner has already been told, and neither is a value the SDK
 * could hold on its behalf.
 */

import {
  CLIENT_COMPATIBILITY_FLOOR_HEADER,
  evaluateClientCompatibility,
  readClientCompatibilityFloor,
  type ClientCompatibilityVerdict,
} from '@goodvibes-jev/engine/sdk/platform/control-plane';

export { CLIENT_COMPATIBILITY_FLOOR_HEADER, evaluateClientCompatibility, readClientCompatibilityFloor };
export type { ClientCompatibilityVerdict };

export interface ClientBuildGuardOptions {
  readonly clientVersion: string;
  /**
   * Invoked once, the first time this build is judged below the floor. Wiring
   * it to a visible surface is what turns "the daemon asked for a restart"
   * into something the owner actually sees.
   */
  readonly onRestartRequired?: ((verdict: ClientCompatibilityVerdict) => void) | undefined;
}

/**
 * The live verdict for this process, updated by whatever reads the daemon's
 * floor (the session-spine liveness probe) and consulted by whatever would
 * execute shared-session work (the continuation runner).
 *
 * Latching is deliberate: once a daemon has told this process it is too old,
 * a later probe that fails to read the header (a restart, a truncated
 * response) must not silently re-enable work.
 */
export class ClientBuildGuard {
  private verdict: ClientCompatibilityVerdict;
  private announced = false;

  constructor(private readonly options: ClientBuildGuardOptions) {
    this.verdict = {
      status: 'ok',
      message: 'No daemon floor observed yet.',
      clientVersion: options.clientVersion,
      floor: undefined,
    };
  }

  /** Feed a floor read from a daemon response. */
  observeFloor(floor: string | undefined): ClientCompatibilityVerdict {
    if (this.verdict.status === 'restart-required') return this.verdict;
    const next = evaluateClientCompatibility({ clientVersion: this.options.clientVersion, floor });
    this.verdict = next;
    if (next.status === 'restart-required' && !this.announced) {
      this.announced = true;
      this.options.onRestartRequired?.(next);
    }
    return next;
  }

  /** False once this build has been judged too old for the live daemon. */
  maySharedSessionWork(): boolean {
    return this.verdict.status !== 'restart-required';
  }

  current(): ClientCompatibilityVerdict {
    return this.verdict;
  }
}
