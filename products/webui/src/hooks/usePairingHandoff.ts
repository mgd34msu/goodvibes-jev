/**
 * usePairingHandoff, turn a `#pair=<token>` fragment into a signed-in session,
 * and, when the link is a hand-off bundle (SDK 1.8.0's pairing.handoff.create,
 * `#pair=<token>&offers=…`), surface the offer set for a caller to drive
 * (see PairingHandoffOffers, which calls pairing.handoff.complete).
 *
 * When the URL fragment carries a pairing token (the QR from `goodvibes pair` in
 * the terminal, or the newer hand-off bundle), this:
 *   1. captures the token (and any offer set) and strips both from the URL
 *      IMMEDIATELY, so the one-time secret never lingers in the address bar or
 *      a history entry;
 *   2. stores it via the existing token store and validates it against the
 *      daemon's cheap authenticated `auth.current` call (setExplicitAuthToken,
 *      which self-clears a token the daemon rejects);
 *   3. on success, invalidates every query so the shell reveals itself, and,
 *      if the link carried a non-empty offer set, publishes it via `offers` so
 *      the app can render the accept/decline UI. A plain `#pair=<token>` link
 *      (no offers) behaves exactly as before: `offers` stays [].
 *   4. also reads this device's own TLS/capability posture (pairing.posture.get,
 *      SDK 1.8.0's LAN-http posture work) for `window.location.origin` and, when
 *      it carries the one honest plain-http-on-LAN notice line, publishes it via
 *      `postureNotice`, verbatim daemon wording, rendered ONCE by the caller
 *      (App.tsx) and cleared via `dismissPostureNotice`, never re-shown on this
 *      hand-off. A posture read failure is swallowed (this is a nice-to-have
 *      notice, never a blocker on completing the pairing itself).
 *
 * WHY CAPTURE HAPPENS AT MODULE/RENDER TIME, NOT IN AN EFFECT: useUrlState's own
 * mount effect normalizes a bare URL to `?view=chat` and, in doing so, drops the
 * fragment. Its effect runs before this hook's effect (earlier hook order), so an
 * effect here would read an already-stripped hash and lose the token. The capture
 * runs once, synchronously, the first time the hook module is exercised, before
 * any effect, so it always beats that normalization.
 *
 * The status drives first paint: `pending` shows a neutral "pairing" splash
 * INSTEAD of the signed-out gate (no gate flash while the token validates);
 * `error` falls through to the gate, which surfaces the rejection.
 */

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sdk, setExplicitAuthToken } from '../lib/goodvibes';
import { parsePairingOffersFromHash, parsePairingTokenFromHash, stripPairingFragment, type PairingOfferKind } from '../lib/pairing';

export type PairingStatus = 'idle' | 'pending' | 'error';

export interface PairingHandoff {
  status: PairingStatus;
  error: unknown;
  /** The hand-off offer set this link carried, once the token has validated. [] for a plain token link, and [] again after dismissOffers(). */
  offers: readonly PairingOfferKind[];
  /** Clears `offers`, call once the offer-decision UI has finished (submitted or explicitly skipped). */
  dismissOffers: () => void;
  /**
   * The daemon's one honest plain-http-on-LAN notice line for this device's own origin,
   * once read, null when the origin is already a secure context (nothing to say), the
   * read hasn't finished yet, or it failed. Present for exactly one render pass unless
   * dismissed sooner; never re-appears for this hand-off.
   */
  postureNotice: string | null;
  /** Clears `postureNotice`, call once the caller has shown it (or chooses to skip it). */
  dismissPostureNotice: () => void;
}

// The pairing token/offers captured ONCE, the first time either is asked for,
// before any router normalization can strip the fragment. Consuming it here
// (and stripping the URL) is idempotent across React StrictMode's double render.
const capture: { done: boolean; token: string | null; offers: PairingOfferKind[] } = {
  done: false,
  token: null,
  offers: [],
};

function capturePairingHandoff(): { token: string | null; offers: readonly PairingOfferKind[] } {
  if (!capture.done) {
    capture.done = true;
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    capture.token = parsePairingTokenFromHash(hash);
    capture.offers = capture.token !== null ? parsePairingOffersFromHash(hash) : [];
    if (capture.token !== null) stripPairingFragment();
  }
  return { token: capture.token, offers: capture.offers };
}

/** Test-only: reset the module-level capture between cases. */
export function resetPairingCaptureForTest(): void {
  capture.done = false;
  capture.token = null;
  capture.offers = [];
}

export function usePairingHandoff(): PairingHandoff {
  const queryClient = useQueryClient();
  // capturePairingHandoff() runs during this first-render initializer, before
  // any effect (including useUrlState's URL normalization), so the fragment is
  // read and scrubbed before it can be dropped.
  const [status, setStatus] = useState<PairingStatus>(() =>
    capturePairingHandoff().token ? 'pending' : 'idle',
  );
  const [error, setError] = useState<unknown>(null);
  const [offers, setOffers] = useState<readonly PairingOfferKind[]>([]);
  const [postureNotice, setPostureNotice] = useState<string | null>(null);

  useEffect(() => {
    const { token, offers: capturedOffers } = capturePairingHandoff();
    if (token === null) return;
    void (async () => {
      try {
        await setExplicitAuthToken(token);
        // Auth/boot/health flip to signed-in and the shell reveals.
        await queryClient.invalidateQueries();
        setStatus('idle');
        if (capturedOffers.length > 0) setOffers(capturedOffers);
      } catch (err) {
        setError(err);
        setStatus('error');
        return;
      }
      // Best-effort, AFTER the pairing itself has succeeded: a posture read failure
      // never blocks or errors the hand-off, it just means no notice line shows.
      try {
        const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
        const { posture } = await sdk.operator.pairing.posture.get(origin);
        if (posture.notice) setPostureNotice(posture.notice);
      } catch {
        // Swallowed, see above.
      }
    })();
    // Mount-once: the token was captured synchronously above; a later hash change
    // is not a new pairing hand-off (the app is already mounted and interactive).
    // A setState after an unmount is a silent no-op in React 19, so no cancel flag
    // is needed for this one-shot hand-off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissOffers = useCallback(() => setOffers([]), []);
  const dismissPostureNotice = useCallback(() => setPostureNotice(null), []);

  return { status, error, offers, dismissOffers, postureNotice, dismissPostureNotice };
}
