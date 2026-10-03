/**
 * memory-spine-adoption.ts
 *
 * The single policy for deciding whether the agent's memory spine should be
 * routing over the wire (CLIENT mode, an adopted daemon owns the store) or
 * reading/writing its own local store (LOCAL mode), given the SAME
 * daemon-reachability signal already used by the session spine
 * (services.sessionSpineClient.probeReachability()), per Mike's direction to reuse
 * the agent's existing daemon-adoption signal rather than invent a second one.
 *
 * Extracted out of bootstrap.ts so this decision is unit-testable in isolation and
 * so the boot-time check and the periodic recheck (a daemon can appear or
 * disappear after boot) run through exactly ONE code path, not two copies that
 * could drift apart.
 */
import type { MemorySpineClient, MemoryTransport } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';

export interface MemorySpineAdoptionOptions {
  /** Only the three methods this policy needs, narrow on purpose so a test double is trivial to write. */
  readonly memorySpineClient: Pick<MemorySpineClient, 'active' | 'activate' | 'deactivate'>;
  readonly transport: MemoryTransport;
  /** The existing daemon-adoption signal, reuse services.sessionSpineClient.probeReachability() in production. */
  readonly probeReachability: () => Promise<'unknown' | 'online' | 'offline'>;
  readonly deactivateReason?: string;
  /**
   * Asked on the adoption edge, after reachability and before anything routes
   * over the wire: may this daemon be adopted at all?
   *
   * The agent wires this to the daemon build floor. A daemon older than the
   * floor answers some of the verbs this build depends on and not others, and
   * adopting it produces a half-working state where one call returns 404 and
   * reads as a broken feature rather than as an old daemon. Answering false
   * here means the daemon is NOT adopted: the memory spine stays on its local
   * store and the inbound dispatch never binds, which is exactly the path taken
   * when no daemon is configured.
   *
   * Absent means adopt on reachability alone. It is asked on every adoption
   * attempt rather than cached, so a daemon updated mid-session is adopted on
   * the next reconcile with nothing to reset.
   */
  readonly mayAdopt?: () => boolean | Promise<boolean>;
  /**
   * Called exactly on the transition INTO adoption (reachable AND not yet
   * active), i.e. once per (re)attach to a daemon, at boot and again whenever a
   * daemon reappears after a loss. The agent wires this to the single
   * `?receipts=consume` /status read the daemon delivers its one-shot honesty
   * receipts to (see services.consumeDaemonReceipts / daemon-receipts.ts):
   * reusing the existing adoption edge instead of inventing a second signal, per
   * the same reuse this reconciler already documents for reachability. Best
   * effort, its rejection is swallowed here so a failed receipt read can never
   * undo the adoption that just happened.
   */
  readonly onAttach?: () => void | Promise<void>;
  /**
   * Called exactly on the transition OUT of adoption, a daemon that was being
   * used stopped answering. The agent wires this to the inbound session
   * dispatch's `deactivate`, because a poller that keeps dialing a dead wire is
   * the same "guessing" this reconciler exists to avoid on the memory side. The
   * bound continuation runner is kept, so a daemon that comes back resumes
   * dispatch without re-binding anything.
   */
  readonly onDetach?: (reason: string) => void;
}

/**
 * Runs one reachability check and adopts/releases the daemon accordingly:
 *  - reachable AND not yet active AND `mayAdopt` allows it -> activate(transport)
 *    (adopt the daemon; every wire-covered memory op now routes over HTTP and the
 *    local store is never written again, for as long as this holds).
 *  - reachable AND not yet active AND `mayAdopt` REFUSES -> nothing happens: no
 *    activation, no attach edge, no dispatch binding. A daemon that is there but
 *    refused leaves this process in the same state as no daemon at all.
 *  - NOT reachable AND currently active -> deactivate(reason) (hand back to owned
 *    local access, a sustained daemon loss, never guessed from a single call
 *    failure elsewhere; see memory-spine/client.ts's honest-failure contract).
 *  - otherwise: no-op, already in the correct mode.
 *
 * A probe rejection propagates to the caller (it does not swallow errors), the
 * caller decides how to log a failed reachability check (see bootstrap.ts's
 * onError handling on the deferred startup task and the interval tick).
 */
export async function reconcileMemorySpineAdoption(options: MemorySpineAdoptionOptions): Promise<void> {
  const reachable = (await options.probeReachability()) === 'online';
  if (reachable && !options.memorySpineClient.active) {
    // Reachable is not the same as usable. A daemon this build refuses (too old
    // to serve what it depends on) is left exactly where an absent daemon leaves
    // things: local store, no wire, no dispatch binding. Asked before activate()
    // so nothing routes over the wire first and gets pulled back.
    if (options.mayAdopt && !(await options.mayAdopt())) return;
    options.memorySpineClient.activate(options.transport);
    if (options.onAttach) {
      // Adoption already happened synchronously above; a receipt-read failure
      // must not propagate and make the caller log a false "reachability
      // recheck failed", nor undo the adoption.
      await Promise.resolve().then(() => options.onAttach!()).catch(() => {});
    }
    return;
  }
  if (!reachable && options.memorySpineClient.active) {
    const reason = options.deactivateReason ?? 'daemon unreachable on periodic reachability check';
    options.memorySpineClient.deactivate(reason);
    // Same edge, same signal. A detach handler that throws must not make the
    // caller log a false "reachability recheck failed" for a release that has
    // already happened.
    try {
      options.onDetach?.(reason);
    } catch {
      // Nothing to undo: the memory spine is already back on local access.
    }
  }
}
