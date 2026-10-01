/**
 * pairing.ts, consume a pairing hand-off carried in the URL fragment.
 *
 * The terminal command `goodvibes pair` shows a QR code that encodes a link back
 * to this web app with an operator token in the URL FRAGMENT, e.g.
 * `https://<webui-origin>/#pair=<token>` (optionally alongside a `?view=…`
 * query). The fragment is chosen deliberately: a `#`-fragment is never sent to
 * the server, so the one-time token never lands in an access log, a proxy log,
 * or a Referer header. This module only READS that fragment; QR *generation*
 * lives entirely on the daemon/TUI side, never here.
 *
 * SDK 1.8.0's pairing.handoff.create rides the EXACT SAME `#pair=<token>`
 * fragment shape, with an offer set alongside in an `offers=` key this module
 * did not used to read at all (the SDK's own pairing-handoff.ts header notes
 * this deliberately: "the web app... ignores any other fragment keys", this
 * file is the "ignores" it meant, now made offer-aware). A plain `#pair=<token>`
 * link (no `offers=`) still parses exactly as before, parsePairingOffersFromHash
 * simply returns [] for it.
 *
 * Functions, all pure over `window.location`:
 *   - parsePairingTokenFromHash, pull the token out of a hash string.
 *   - parsePairingOffersFromHash, pull the offer-kind list out of the same hash.
 *   - stripPairingFragment, remove ONLY the `pair`/`offers` keys from the live
 *     URL via history.replaceState, so the secret does not linger in the address
 *     bar or a back/forward history entry once it has been consumed.
 */

/** The fragment key the pairing link uses: `#pair=<token>`. */
export const PAIRING_FRAGMENT_KEY = 'pair';
/** The fragment key an offer-bearing hand-off link uses alongside `pair`. */
export const PAIRING_OFFERS_FRAGMENT_KEY = 'offers';

/** The set-up steps a pairing hand-off can offer, mirrors the SDK's PairingHandoffOfferKind. */
export type PairingOfferKind = 'notifications' | 'relay' | 'passkey';
const PAIRING_OFFER_KINDS: readonly PairingOfferKind[] = ['notifications', 'relay', 'passkey'];

function isPairingOfferKind(value: string): value is PairingOfferKind {
  return (PAIRING_OFFER_KINDS as readonly string[]).includes(value);
}

/**
 * Extract a pairing token from a URL hash string (`window.location.hash`), or
 * null when none is present. Tolerates a leading `#`, an empty hash, and a hash
 * that carries other fragment keys alongside `pair`.
 */
export function parsePairingTokenFromHash(hash: string): string | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const trimmed = new URLSearchParams(raw).get(PAIRING_FRAGMENT_KEY)?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extract the offer-kind list from the same hash a pairing token rides in
 * (comma-separated, e.g. `#pair=tok&offers=notifications,relay`), in the SDK's
 * canonical order, deduped, and dropping any kind this web app does not
 * recognize. Returns [] for a plain token-only link, an absent hash, or a hash
 * with no `pair` key at all (an offer set with no token to pair is meaningless).
 */
export function parsePairingOffersFromHash(hash: string): PairingOfferKind[] {
  if (!hash) return [];
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return [];
  const params = new URLSearchParams(raw);
  if (!params.get(PAIRING_FRAGMENT_KEY)?.trim()) return [];
  const requested = (params.get(PAIRING_OFFERS_FRAGMENT_KEY) ?? '').split(',').map((s) => s.trim());
  const present = new Set(requested.filter(isPairingOfferKind));
  return PAIRING_OFFER_KINDS.filter((kind) => present.has(kind));
}

/**
 * Remove the `pair` (and, when present, `offers`) key from the current URL's
 * fragment via history.replaceState, preserving the pathname, query string,
 * and any other fragment keys. A no-op-safe call: if there is no `pair` key,
 * the URL is left unchanged. Never adds a history entry.
 */
export function stripPairingFragment(): void {
  if (typeof window === 'undefined') return;
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(rawHash);
  if (!params.has(PAIRING_FRAGMENT_KEY)) return;
  params.delete(PAIRING_FRAGMENT_KEY);
  params.delete(PAIRING_OFFERS_FRAGMENT_KEY);
  const remaining = params.toString();
  const url = `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}
