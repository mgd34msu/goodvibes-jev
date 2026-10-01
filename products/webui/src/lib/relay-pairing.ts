/**
 * relay-pairing.ts, store and read a relay pairing payload for this device.
 *
 * A relay pairing is different from the existing operator-token pairing
 * (see pairing.ts / usePairingHandoff.ts): it carries no identity/auth material at
 * all. It is transport-level bootstrap, a relay URL, an unguessable rendezvous id,
 * and the daemon's pinned public key (@goodvibes-jev/engine/transport-core/relay's
 * `RelayPairingPayload`), that lets this browser reach the daemon through the
 * zero-knowledge relay when it cannot reach it directly (off the LAN). The daemon
 * mints this payload and shows it as a QR; scanning it with the device camera opens
 * a link back to this app carrying the encoded payload in the URL FRAGMENT, exactly
 * like the token pairing flow, and for the same reason: a `#`-fragment is never sent
 * to a server, so the payload never lands in an access log or a Referer header. The
 * relay docs call the payload itself "treat it like a credential", whoever holds a
 * valid one can reach the daemon through the relay, so it is stored locally, not
 * transmitted anywhere else, and can be cleared like a token.
 *
 * Once stored, the SDK client construction (lib/goodvibes.ts / lib/relay-connection.ts)
 * picks it up and uses it to build a relay-backed `fetch` for whenever the direct
 * connection is unreachable, see relay-connection.ts's routedFetch.
 *
 * Still auth-separate: a relay pairing gets you a TRANSPORT to the daemon, not a
 * signed-in session. The operator token pairing/paste flow still applies on top.
 */

import {
  decodeRelayPairingString,
  encodeRelayPairingString,
  type RelayPairingPayload,
} from '@goodvibes-jev/engine/transport-core/relay';

export type { RelayPairingPayload };

/** The fragment key the relay pairing link uses: `#relay=<gvrelay1.…>`. */
export const RELAY_PAIRING_FRAGMENT_KEY = 'relay';

/** localStorage key the pairing payload is persisted under (JSON of RelayPairingPayload). */
export const RELAY_PAIRING_STORAGE_KEY = 'goodvibes.webui.relayPairing';

/**
 * Extract a relay pairing code from a URL hash string (`window.location.hash`), or
 * null when none is present. Mirrors parsePairingTokenFromHash's tolerances: a
 * leading `#`, an empty hash, and other fragment keys alongside `relay`.
 */
export function parseRelayPairingFromHash(hash: string): string | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const trimmed = new URLSearchParams(raw).get(RELAY_PAIRING_FRAGMENT_KEY)?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Remove the `relay` key from the current URL's fragment via history.replaceState,
 * preserving the pathname, query string, and any other fragment keys. No-op-safe.
 */
export function stripRelayPairingFragment(): void {
  if (typeof window === 'undefined') return;
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(rawHash);
  if (!params.has(RELAY_PAIRING_FRAGMENT_KEY)) return;
  params.delete(RELAY_PAIRING_FRAGMENT_KEY);
  const remaining = params.toString();
  const url = `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}

/**
 * Decode a scanned/pasted relay pairing string (the `gvrelay1.…` code) into a
 * payload. Throws the SDK's own GoodVibesSdkError on malformed input, callers
 * render that with formatError, same as any other honest rejection.
 */
export function decodeRelayPairingCode(code: string): RelayPairingPayload {
  return decodeRelayPairingString(code.trim());
}

/** Re-export for symmetry, callers that already have a payload object (not a string). */
export { encodeRelayPairingString };

// ---------------------------------------------------------------------------
// Local persistence
// ---------------------------------------------------------------------------

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/**
 * A locally-detected notice (corrupt stored data, not a daemon-origin one), consumed
 * once, surfaced through the SAME one-line dismissible notice component
 * DaemonReceipts.tsx already renders for the daemon's own receipts
 * (useDaemonReceipts.ts merges this in), since both are the same kind of thing to an
 * operator: a plain line about something that happened, with a dismiss button.
 * Session-scoped (not persisted) and cleared after being read once via
 * takeRelayPairingCorruptionNotice.
 */
let corruptionNotice: { readonly id: string; readonly text: string; readonly at: number } | null = null;

/** Consume the pending corruption notice, if any. Returns null every call after the first. */
export function takeRelayPairingCorruptionNotice(): { readonly id: string; readonly text: string; readonly at: number } | null {
  const notice = corruptionNotice;
  corruptionNotice = null;
  return notice;
}

/** Read the stored relay pairing, or null if none is stored or it fails to parse. */
export function getStoredRelayPairing(): RelayPairingPayload | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(RELAY_PAIRING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' || parsed === null
      || typeof (parsed as Record<string, unknown>).relayUrl !== 'string'
      || typeof (parsed as Record<string, unknown>).rid !== 'string'
      || typeof (parsed as Record<string, unknown>).daemonPublicKey !== 'string'
    ) {
      console.warn('[relay-pairing] stored relay pairing record has an unrecognized shape, discarding it and treating this device as unpaired.');
      window.localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
      corruptionNotice = {
        id: `relay-pairing-corrupt-${Date.now()}`,
        text: 'Your saved relay connection details could not be read and were reset. Pair again if you reach this daemon through the relay.',
        at: Date.now(),
      };
      return null;
    }
    return parsed as RelayPairingPayload;
  } catch (error) {
    console.warn('[relay-pairing] stored relay pairing record failed to parse, discarding it and treating this device as unpaired.', error);
    try {
      window.localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
    } catch {
      // Storage already unusable (e.g. this catch fired because of a storage-access
      // failure, not a parse failure), nothing more can be done here.
    }
    corruptionNotice = {
      id: `relay-pairing-corrupt-${Date.now()}`,
      text: 'Your saved relay connection details could not be read and were reset. Pair again if you reach this daemon through the relay.',
      at: Date.now(),
    };
    return null;
  }
}

/** Persist a relay pairing payload for this device. */
export function storeRelayPairing(payload: RelayPairingPayload): void {
  if (!hasStorage()) return;
  window.localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, JSON.stringify(payload));
}

/** Clear the stored relay pairing, this device no longer has a relay route to any daemon. */
export function clearStoredRelayPairing(): void {
  if (!hasStorage()) return;
  window.localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
}
