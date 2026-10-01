/**
 * useRelayPairingHandoff, turn a `#relay=<gvrelay1.…>` fragment into a stored relay
 * pairing for this device.
 *
 * Companion to usePairingHandoff (the `#pair=<token>` operator-token flow) but for a
 * DIFFERENT payload with a different job: a relay pairing carries no identity, just the
 * transport bootstrap (relay URL, rendezvous id, daemon public key, see
 * lib/relay-pairing.ts's header) that lets this device reach the daemon through the
 * relay when it cannot reach it directly. Storing it does not sign anyone in; the
 * existing token pairing/paste flow still handles authentication on top.
 *
 * Same capture-before-effect discipline as usePairingHandoff, and for the same reason:
 * useUrlState's own mount effect normalizes a bare URL and drops the fragment, so the
 * token/pairing MUST be read at module/render-init time, before any effect can run.
 *
 * Unlike the token flow, storing a relay pairing needs no round trip to the daemon to
 * validate, decoding it is fully offline (decodeRelayPairingString), so there is no
 * 'pending' network state. `status` is 'idle' until a fragment is present, 'stored' once
 * a decoded pairing has been persisted (a one-tick confirmation a caller can use to show
 * a toast), or 'error' when the fragment was malformed.
 */

import { useEffect, useState } from 'react';
import {
  decodeRelayPairingCode,
  parseRelayPairingFromHash,
  storeRelayPairing,
  stripRelayPairingFragment,
  type RelayPairingPayload,
} from '../lib/relay-pairing';

export type RelayPairingHandoffStatus = 'idle' | 'stored' | 'error';

export interface RelayPairingHandoff {
  status: RelayPairingHandoffStatus;
  error: unknown;
  pairing: RelayPairingPayload | null;
}

const capture: { done: boolean; code: string | null } = { done: false, code: null };

function captureRelayPairingCode(): string | null {
  if (!capture.done) {
    capture.done = true;
    capture.code = typeof window !== 'undefined'
      ? parseRelayPairingFromHash(window.location.hash)
      : null;
    if (capture.code !== null) stripRelayPairingFragment();
  }
  return capture.code;
}

/** Test-only: reset the module-level capture between cases. */
export function resetRelayPairingCaptureForTest(): void {
  capture.done = false;
  capture.code = null;
}

export function useRelayPairingHandoff(): RelayPairingHandoff {
  const [status, setStatus] = useState<RelayPairingHandoffStatus>('idle');
  const [error, setError] = useState<unknown>(null);
  const [pairing, setPairing] = useState<RelayPairingPayload | null>(null);

  useEffect(() => {
    const code = captureRelayPairingCode();
    if (code === null) return;
    try {
      const decoded = decodeRelayPairingCode(code);
      storeRelayPairing(decoded);
      setPairing(decoded);
      setStatus('stored');
    } catch (err) {
      setError(err);
      setStatus('error');
    }
    // Mount-once: the code was captured synchronously above; a later hash change is not
    // a new hand-off. No reactive value is read here (decode/store are pure/local), so
    // the empty deps array is genuinely exhaustive, unlike usePairingHandoff's version,
    // which also touches queryClient.
  }, []);

  return { status, error, pairing };
}
