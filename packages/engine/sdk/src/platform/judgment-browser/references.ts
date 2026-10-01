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

/** Ephemeral owned references. No HTTP mint endpoint and no persistence or implicit access grant. */
export class BrowserJudgmentReferences {
  readonly #entries = new Map<string, BrowserJudgmentReferenceSource>();
  #closed = false;
  constructor(private readonly now: () => number = Date.now) {}

  issue(entry: BrowserJudgmentReferenceSource): string {
    this.sweep();
    if (this.#closed || !entry.principalId || !entry.revision || !Number.isFinite(entry.expiresAt)
      || entry.expiresAt <= this.now() || entry.expiresAt > this.now() + 300_000 || this.#entries.size >= 64
      || typeof entry.mayRead !== 'function' || typeof entry.assertCurrent !== 'function') return held();
    let snapshot: unknown;
    try { requireSynchronousAssertion(entry.assertCurrent, 'JUDGMENT_REFERENCE_HELD'); snapshot = snapshotJudgmentInput(entry.snapshot); }
    catch { return held(); }
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > BROWSER_JUDGMENT_LIMITS.bodyBytes) return held();
    const id = crypto.randomUUID();
    this.#entries.set(id, { ...entry, snapshot });
    return id;
  }

  resolve<S>(id: string, currentPrincipal: () => AuthenticatedPrincipal, battery: BrowserJudgmentBatteryId, parse: (value: unknown) => S): BrowserJudgmentResolvedInput<S> {
    this.sweep();
    const entry = this.#entries.get(id);
    const assertCurrent = (): void => {
      if (this.#closed || !entry || this.#entries.get(id) !== entry || entry.expiresAt <= this.now() || entry.battery !== battery) return held();
      try {
        const principal = currentPrincipal();
        if (!principal || 'then' in principal || entry.principalId !== principal.principalId) { consumeRejectedHook(principal); return held(); }
        if (!granted(entry.mayRead(principal))) return held();
        requireSynchronousAssertion(entry.assertCurrent, 'JUDGMENT_REFERENCE_HELD');
      }
      catch { return held(); }
    };
    assertCurrent();
    let state: S;
    try { state = parse(entry!.snapshot); } catch { return held(); }
    // The binding stays server-side; it is not an approval token and is never emitted.
    return { state, sourceBinding: id, assertCurrent };
  }
  revoke(id: string): void { this.#entries.delete(id); }
  close(): void { this.#closed = true; this.#entries.clear(); }
  private sweep(): void {
    for (const [id, entry] of this.#entries) if (entry.expiresAt <= this.now()) this.#entries.delete(id);
  }
}
