/** Account eligibility owns election membership; content dispositions never do. */
import { createSystemClusterClock, type ClusterClock } from '@goodvibes-jev/engine/sdk/platform/cluster';
import type { InboxPollingControl } from '@goodvibes-jev/engine/sdk/platform/intake';

interface Eligibility {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
interface EligibilityOptions {
  readonly verify: () => Promise<Eligibility>;
  readonly control: InboxPollingControl;
  readonly register: (control: InboxPollingControl) => () => void | Promise<void>;
  readonly clock?: ClusterClock;
}

/**
 * Metadata-only probes are single-flight, once at startup then every 30 seconds
 * after completion. There is no content retry here and no time-based authority
 * expiry: transport uncertainty preserves a still-current proof. Explicit local
 * or provider invalidation withdraws immediately, even while a probe is pending.
 */
export function ownInboxEligibility(options: EligibilityOptions): { ready: Promise<void>; close(): Promise<void> } {
  const clock = options.clock ?? createSystemClusterClock();
  let closed = false;
  let proof: Eligibility | undefined;
  let unregister: (() => void | Promise<void>) | undefined;
  let unlisten: (() => void) | undefined;
  let cancelTimer: (() => void) | undefined;
  let transition: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let failed = false;
  const valid = (value: Eligibility | undefined): value is Eligibility => {
    try { if (!value || value.signal.aborted) return false; value.assertCurrent(); return true; }
    catch { return false; }
  };
  const serialize = (action: () => Promise<void>): Promise<void> => {
    const next = transition.then(action);
    transition = next.catch(() => { failed = true; });
    return next;
  };
  const retire = async (): Promise<void> => {
    proof = undefined;
    unlisten?.(); unlisten = undefined;
    // Remove eligibility immediately. Owned coordinator withdrawal retains the
    // exact retiring gate until its accepted polls drain before RESIGN/reentry.
    // A failure remains sticky and retains the enclosing lifetime storage lock.
    const cleanup = unregister;
    await Promise.all([cleanup?.(), options.control.stop()]);
    unregister = undefined;
  };
  const revoked = (): void => {
    proof = undefined;
    void serialize(retire).catch(() => {});
  };
  const probe = async (): Promise<void> => {
    if (closed || failed) return;
    if (proof && !valid(proof)) await serialize(retire);
    let next: Eligibility | undefined;
    try { next = await options.verify(); } catch { /* Keep only a still-current proof. */ }
    if (closed || failed) return;
    await serialize(async () => {
      if (closed || failed) return;
      if (!valid(next)) {
        if (proof && !valid(proof)) await retire();
        return;
      }
      if (valid(proof) && proof.signal === next.signal) return;
      if (unregister) await retire();
      if (closed || !valid(next)) return;
      const accepted = next;
      proof = accepted;
      accepted.signal.addEventListener('abort', revoked, { once: true });
      unlisten = () => accepted.signal.removeEventListener('abort', revoked);
      unregister = options.register({
        async start() {
          if (closed || failed || proof !== accepted || !valid(accepted)) throw new Error('Inbox account is not eligible');
          await options.control.start();
        },
        stop: () => options.control.stop(),
      });
      if (closed || !valid(accepted)) await retire();
    });
  };
  const schedule = (): void => {
    if (closed || failed) return;
    cancelTimer = clock.setTimer(() => {
      cancelTimer = undefined;
      probing = probe().catch(() => { failed = true; }).finally(schedule);
    }, 30_000);
  };
  let probing = Promise.resolve().then(probe);
  const ready = probing.finally(schedule);
  void ready.catch(() => {});
  return { ready, close() {
    if (!closing) {
      closed = true; cancelTimer?.(); cancelTimer = undefined;
      // Start drainage without waiting for an uncooperative metadata request.
      // The factory closes its provider concurrently to abort owned I/O.
      const retirement = serialize(retire);
      closing = Promise.allSettled([probing, retirement]).then(results => {
        if (failed || results.some(result => result.status === 'rejected')) throw new Error('Inbox eligibility did not retire cleanly');
      });
    }
    return closing;
  } };
}
