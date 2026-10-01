import { BrowserJudgmentError, BROWSER_JUDGMENT_LIMITS, type AuthenticatedPrincipal, type BrowserJudgmentBatteryId } from '@goodvibes-jev/engine/daemon-sdk';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { BrowserJudgmentResolvedInput } from './types.js';
import { consumeRejectedHook, granted, requireSynchronousAssertion } from './guards.js';

export interface BrowserJudgmentReferenceSource {
  readonly principalId: string; readonly battery: BrowserJudgmentBatteryId; readonly revision: string;
  readonly expiresAt: number; readonly snapshot: unknown; readonly assertCurrent: () => void;
  readonly mayRead: (principal: AuthenticatedPrincipal) => boolean;
}
const held = (): never => { throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); };
type OwnedReference = BrowserJudgmentReferenceSource & { readonly identity: symbol };

/** Ephemeral owned references. No HTTP mint endpoint and no persistence or implicit access grant. */
export class BrowserJudgmentReferences {
  readonly #entries = new Map<string, OwnedReference>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #closed = false;
  constructor(private readonly now: () => number = Date.now) {}

  issue(entry: BrowserJudgmentReferenceSource): string {
    this.sweep();
    const now = this.now();
    const { principalId, battery, revision, expiresAt, snapshot: input, assertCurrent, mayRead } = entry;
    if (this.#closed || !principalId || !revision || !Number.isFinite(now) || !Number.isFinite(expiresAt)
      || expiresAt <= now || expiresAt > now + 300_000 || this.#entries.size >= 64
      || typeof mayRead !== 'function' || typeof assertCurrent !== 'function') return held();
    let snapshot: unknown;
    try { requireSynchronousAssertion(() => assertCurrent.call(entry), 'JUDGMENT_REFERENCE_HELD'); snapshot = snapshotJudgmentInput(input); }
    catch { return held(); }
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > BROWSER_JUDGMENT_LIMITS.bodyBytes) return held();
    const id = crypto.randomUUID();
    const admittedAt = this.now();
    // Supplied callbacks and input accessors may have closed or filled the
    // store. No ownership is acquired until after those callbacks finish.
    if (this.#closed || this.#entries.size >= 64 || this.#entries.has(id)
      || !Number.isFinite(admittedAt) || expiresAt <= admittedAt) return held();
    const identity = Symbol();
    this.#entries.set(id, { principalId, battery, revision, expiresAt, snapshot, identity,
      assertCurrent: assertCurrent.bind(entry), mayRead: mayRead.bind(entry),
    });
    // This is an owned retention deadline, not only a check on the next read.
    // Capture no source/snapshot in the callback, and never extend past five
    // minutes even if the wall clock moves backwards while capturing input.
    try {
      const timer = setTimeout(() => {
        if (this.#entries.get(id)?.identity === identity) this.revoke(id);
      }, Math.min(300_000, expiresAt - admittedAt));
      this.#timers.set(id, timer);
      timer.unref?.();
    } catch { this.revoke(id); return held(); }
    return id;
  }

  resolve<S>(id: string, currentPrincipal: () => AuthenticatedPrincipal, battery: BrowserJudgmentBatteryId, parse: (value: unknown) => S): BrowserJudgmentResolvedInput<S> {
    this.sweep();
    const identity = this.#entries.get(id)?.identity;
    // These closures retain only the small identity, never the source row.
    const current = (): OwnedReference => {
      const now = this.now();
      const entry = this.#entries.get(id);
      if (this.#closed || !entry || entry.identity !== identity || !Number.isFinite(now)
        || entry.expiresAt <= now || entry.battery !== battery) return held();
      return entry;
    };
    const assertCurrent = (): void => {
      const entry = current();
      try {
        const principal = currentPrincipal();
        current();
        if (!principal || 'then' in principal || entry.principalId !== principal.principalId) { consumeRejectedHook(principal); return held(); }
        const allowed = granted(entry.mayRead(principal));
        current();
        if (!allowed) return held();
        requireSynchronousAssertion(() => entry.assertCurrent(), 'JUDGMENT_REFERENCE_HELD');
        current();
      }
      catch { return held(); }
    };
    assertCurrent();
    let state: S;
    try { state = parse(current().snapshot); } catch { return held(); }
    // Parsing is also supplied code. A revoked or replaced row cannot escape
    // as a successful lease, even when the parser returned the original data.
    assertCurrent();
    // The binding stays server-side; it is not an approval token and is never emitted.
    return { state, sourceBinding: id, assertCurrent };
  }
  revoke(id: string): void {
    this.#entries.delete(id);
    const timer = this.#timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(id);
  }
  close(): void {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear(); this.#entries.clear();
  }
  private sweep(): void {
    for (const [id, entry] of this.#entries) if (entry.expiresAt <= this.now()) this.revoke(id);
  }
}
