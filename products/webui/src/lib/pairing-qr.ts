/**
 * pairing-qr.ts, read a scanned pairing QR into something the sign-in screen
 * can act on.
 *
 * This is a PARSE-AT-THE-BOUNDARY module in the same shape as relay-pairing.ts's
 * decodeRelayPairingCode: one function, untrusted text in, a validated record
 * out, a thrown Error with a plain message on anything it does not recognize.
 * It performs no I/O and signs nobody in; SignedOutGate decides what to do with
 * the result and routes it into the code paths it already has.
 *
 * It parses exactly the shapes the GoodVibes family GENERATES, not a superset
 * invented here:
 *
 *   1. The SDK's companion connection payload, a JSON object
 *      `{url, token, username, password?, version, surface}` produced by
 *      encodeConnectionPayload (@goodvibes-jev/engine/sdk/platform/pairing) and
 *      served by goodvibes-app's /app/pairing/connection route. This is the QR
 *      the retired Android companion existed to scan, and the reason this file
 *      exists: the scanner replaces that app.
 *   2. The `goodvibes pair` hand-off link, `https://<webui-origin>/#pair=<token>`
 *      (optionally `&offers=…`), see pairing.ts. Parsed by pairing.ts's own
 *      parsePairingTokenFromHash so a scan and a followed link agree by
 *      construction rather than by two copies of the same rule.
 *   3. The relay pairing link/code, `#relay=<gvrelay1.…>` or the bare
 *      `gvrelay1.…` string, see relay-pairing.ts. The `gvrelay1.` prefix is
 *      documented upstream as self-describing precisely so a scanner can
 *      recognize it.
 *   4. `goodvibes://connect?token=…&baseUrl=…` and a bare `token=…&baseUrl=…`
 *      query string. The retired companion accepted these, so a QR minted for
 *      it still scans here instead of failing for no reason a person can act on.
 *
 * The token and password are secrets. They are carried in the returned record
 * and nowhere else: this module never logs, never stringifies a whole payload
 * into an error, and the error text it does produce names only the SHAPE that
 * was wrong. `describeScannedPairing` exists so the UI has something safe to
 * render, it deliberately has no access to the secret fields.
 */

import { parsePairingTokenFromHash } from './pairing';
import { parseRelayPairingFromHash } from './relay-pairing';

/** Which sign-in path a scanned QR feeds. */
export type ScannedPairingKind = 'token' | 'password' | 'relay';

/**
 * A validated scan, as a discriminated union so a consumer cannot reach for a
 * field the scanned kind does not carry. `url` is the daemon address the QR
 * named, when it carried one; it is not a secret and is safe to render.
 */
export type ScannedPairing =
  /** Secret: never log or render `token`. */
  | { readonly kind: 'token'; readonly token: string; readonly url?: string }
  /** Secret: never log or render `password`. */
  | { readonly kind: 'password'; readonly username: string; readonly password: string; readonly url?: string }
  | { readonly kind: 'relay'; readonly relayCode: string; readonly url?: string };

// ---------------------------------------------------------------------------
// Field names
// ---------------------------------------------------------------------------

// The first entry of each list is the SDK's own key (companion-token.ts's
// encodeConnectionPayload). The rest are aliases the retired Android companion
// accepted, kept so its QRs still scan. `version` and `surface` ride along in
// the SDK payload and are deliberately ignored: nothing on this screen acts on
// them, and the daemon is the authority on both.
const URL_KEYS = ['url', 'baseUrl', 'base_url', 'daemonUrl', 'daemon_url'] as const;
const TOKEN_KEYS = ['token', 'bearer', 'bearerToken', 'bearer_token', 'accessToken', 'access_token'] as const;
const USERNAME_KEYS = ['username', 'user'] as const;
const PASSWORD_KEYS = ['password', 'pass'] as const;
const RELAY_KEYS = ['relay', 'relayPairing', 'relay_pairing'] as const;

/** The self-describing prefix of a relay pairing string (transport-core's PAIRING_SCHEME). */
const RELAY_CODE_PREFIX = 'gvrelay1.';

interface PairingFields {
  url?: string;
  token?: string;
  username?: string;
  password?: string;
  relayCode?: string;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function fieldsFromRecord(record: Record<string, unknown>): PairingFields {
  const fields: PairingFields = {};
  const url = pick(record, URL_KEYS);
  const token = pick(record, TOKEN_KEYS);
  const username = pick(record, USERNAME_KEYS);
  const password = pick(record, PASSWORD_KEYS);
  const relayCode = pick(record, RELAY_KEYS);
  if (url !== undefined) fields.url = url;
  if (token !== undefined) fields.token = token;
  if (username !== undefined) fields.username = username;
  if (password !== undefined) fields.password = password;
  if (relayCode !== undefined) fields.relayCode = relayCode;
  return fields;
}

function hasAnyField(fields: PairingFields): boolean {
  return (
    fields.token !== undefined
    || fields.relayCode !== undefined
    || fields.password !== undefined
    || fields.username !== undefined
  );
}

// ---------------------------------------------------------------------------
// Per-shape readers, each returns null when the text is not that shape
// ---------------------------------------------------------------------------

/** Shape 1: the SDK's companion connection payload, a JSON object. */
function fromJson(raw: string): PairingFields | null {
  if (!raw.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return fieldsFromRecord(parsed as Record<string, unknown>);
}

/** Shape 3 (bare form): a relay pairing string on its own, no wrapper. */
function fromBareRelayCode(raw: string): PairingFields | null {
  return raw.startsWith(RELAY_CODE_PREFIX) ? { relayCode: raw } : null;
}

/** Shapes 2, 3 (link form) and 4 (custom scheme): anything the URL parser accepts. */
function fromUrl(raw: string): PairingFields | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // The hand-off link carries its secret in the FRAGMENT, by design (pairing.ts:
  // a fragment never reaches a server log or a Referer header). Read it with the
  // app's own fragment parsers so a scanned link and a followed link cannot drift.
  const fields: PairingFields = {};
  const hashToken = parsePairingTokenFromHash(url.hash);
  if (hashToken) fields.token = hashToken;
  const hashRelay = parseRelayPairingFromHash(url.hash);
  if (hashRelay) fields.relayCode = hashRelay;

  const query = fieldsFromRecord(Object.fromEntries(url.searchParams.entries()));
  const merged: PairingFields = { ...query, ...fields };

  // An http(s) hand-off link names its own daemon by its origin. A custom-scheme
  // payload (goodvibes://connect?…) has no meaningful origin, so only its
  // explicit url/baseUrl parameter counts.
  if (merged.url === undefined && (url.protocol === 'http:' || url.protocol === 'https:')) {
    merged.url = url.origin;
  }
  return hasAnyField(merged) ? merged : null;
}

/** Shape 4 (bare form): a query string with no scheme, `token=…&baseUrl=…`. */
function fromQueryString(raw: string): PairingFields | null {
  if (!raw.includes('=')) return null;
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  const fields = fieldsFromRecord(Object.fromEntries(params.entries()));
  return hasAnyField(fields) ? fields : null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Read one scanned QR's text into a validated ScannedPairing.
 *
 * Throws an Error with a person-readable message when the text is not a
 * GoodVibes pairing payload at all, or is one with nothing usable in it.
 * Callers render that with formatError, exactly as they already do for
 * decodeRelayPairingCode.
 *
 * Precedence when a payload carries several credentials: token, then
 * username+password, then relay. The SDK's companion payload always carries
 * BOTH a token and a `username` of "admin", so the token has to win or every
 * companion QR would take the password path and fail. Relay is last because it
 * is transport-only and signs nobody in, a payload that carries a token as well
 * should sign in with it.
 */
export function parseScannedPairing(rawText: string): ScannedPairing {
  const raw = rawText.trim();
  if (!raw) throw new Error('That QR code was empty');

  const fields =
    fromJson(raw)
    ?? fromBareRelayCode(raw)
    ?? fromUrl(raw)
    ?? fromQueryString(raw);

  if (!fields) throw new Error('That QR code is not a GoodVibes pairing code');
  if (!hasAnyField(fields)) {
    throw new Error('That QR code carried no operator token, sign-in credentials, or relay pairing code');
  }

  if (fields.token !== undefined) {
    return { kind: 'token', token: fields.token, url: fields.url };
  }

  if (fields.username !== undefined && fields.password !== undefined) {
    return { kind: 'password', username: fields.username, password: fields.password, url: fields.url };
  }

  if (fields.relayCode !== undefined) {
    return { kind: 'relay', relayCode: fields.relayCode, url: fields.url };
  }

  // Reached when a payload carried a username with no password (or the reverse):
  // recognizably ours, but not enough to act on.
  throw new Error('That QR code is missing the other half of its sign-in credentials');
}

/**
 * One safe sentence about a scan, for rendering. Names the KIND and, when the
 * payload carried one, the daemon address. Never touches token or password.
 */
export function describeScannedPairing(scanned: ScannedPairing): string {
  const where = scanned.url ? ` for ${scanned.url}` : '';
  switch (scanned.kind) {
    case 'token':
      return `Scanned an operator token${where}`;
    case 'password':
      return `Scanned sign-in credentials for ${scanned.username}${where}`;
    case 'relay':
      return 'Scanned a relay pairing code';
  }
}

/**
 * True when a scanned payload names a daemon at a DIFFERENT origin than the one
 * serving this page. Not a failure: the same daemon is routinely reachable at
 * more than one address (a LAN address in the QR, a Tailscale name in the
 * browser), so this only earns a note, never a block.
 */
export function isDifferentOrigin(scannedUrl: string | undefined, pageBaseUrl: string): boolean {
  if (!scannedUrl) return false;
  try {
    return new URL(scannedUrl).origin !== new URL(pageBaseUrl).origin;
  } catch {
    return false;
  }
}
