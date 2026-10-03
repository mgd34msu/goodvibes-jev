/**
 * credential-status.ts, client-side, secret-FREE credential STATUS read.
 *
 * When GoodVibes Agent acts as a CLIENT of an adopted
 * external daemon, it reads credential *status* (configured / usable) from the
 * daemon's shared store over the wire, the `credentials.get` operator method
 * (GET /config/credentials, admin + read:config). It NEVER receives raw secret
 * bytes: the wire contract (CREDENTIALS_SNAPSHOT_SCHEMA) carries status metadata
 * only. This is a VISIBILITY path, not secret transport.
 *
 * Host-vs-client (see the SDK decision record 2026-07-06-config-sharing): a surface
 * that IS the daemon host reads its own local SecretsManager directly (no wire hop,
 * src/config/secrets.ts). A surface acting as a daemon client reads STATUS here.
 * Secret RESOLUTION (the value provider auth needs) always stays local/env; only the
 * status read moves to the daemon path.
 *
 * The degrade contract mirrors goodvibes-webui v1.0.1 `deriveCredentialAvailability`
 * exactly: a 503 CREDENTIAL_STORE_UNAVAILABLE (by machine code), a METHOD_NOT_FOUND
 * from an older daemon, or any transport failure yields an honest reason-carrying
 * `available: false`, NEVER a fabricated "configured", NEVER a surfaced secret byte.
 */

/** One credential's status metadata from the daemon's shared store, never bytes. */
export interface CredentialStatusEntry {
  readonly key: string;
  readonly configured: boolean;
  readonly usable: boolean;
  readonly source?: string;
  readonly scope?: string;
  readonly secure?: boolean;
  readonly overriddenByEnv?: boolean;
  readonly refSource?: string;
}

export type CredentialAvailability =
  | { readonly available: true; readonly credentials: readonly CredentialStatusEntry[] }
  | { readonly available: false; readonly reason: string };

/** Minimal connection shape for the daemon-client status read. */
export interface CredentialStatusConnection {
  readonly baseUrl: string;
  readonly token: string | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CREDENTIALS_ROUTE = '/config/credentials';
const CREDENTIAL_STATUS_TIMEOUT_MS = 1500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const item = record[key];
    if (typeof item === 'string' && item.trim()) return item;
  }
  return '';
}

/**
 * Fold a `credentials.get` outcome into an honest availability value. Pure, this is
 * the exact degrade contract mirrored from webui v1.0.1: keyed on the MACHINE CODE, it
 * never fabricates "configured" and never carries a secret value. A malformed body (no
 * credentials array) is treated as unavailable, not silently empty-but-configured.
 */
export function deriveCredentialAvailability(
  outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
): CredentialAvailability {
  if (!outcome.ok) {
    const err = asRecord(outcome.error);
    const code = err ? firstString(err, ['code']) : '';
    if (code === 'CREDENTIAL_STORE_UNAVAILABLE') {
      return { available: false, reason: 'The daemon has no shared credential store wired.' };
    }
    if (code === 'METHOD_NOT_FOUND' || code === 'NOT_INVOKABLE') {
      return { available: false, reason: 'This daemon does not serve credential status yet.' };
    }
    return { available: false, reason: 'Credential status unavailable right now.' };
  }
  const value = asRecord(outcome.value);
  const raw = value?.credentials;
  if (!Array.isArray(raw)) return { available: false, reason: 'Credential status unavailable right now.' };
  const credentials: CredentialStatusEntry[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    const key = rec ? firstString(rec, ['key']) : '';
    if (!rec || !key) continue;
    credentials.push({
      key,
      configured: rec.configured === true,
      usable: rec.usable === true,
      source: firstString(rec, ['source']) || undefined,
      scope: firstString(rec, ['scope']) || undefined,
      secure: rec.secure === true ? true : rec.secure === false ? false : undefined,
      overriddenByEnv: rec.overriddenByEnv === true ? true : rec.overriddenByEnv === false ? false : undefined,
      refSource: firstString(rec, ['refSource']) || undefined,
    });
  }
  return { available: true, credentials };
}

/**
 * Extract the machine code from a non-2xx daemon response body, falling back to the
 * HTTP status for legacy daemons that predate the code field. A 404 with no code is
 * treated as METHOD_NOT_FOUND (older daemon without the route, same as webui's
 * isMethodUnavailableError); a 503 with no code as CREDENTIAL_STORE_UNAVAILABLE.
 */
function machineCodeFromResponse(body: unknown, status: number): string {
  const record = asRecord(body);
  const direct = record ? firstString(record, ['code']) : '';
  if (direct) return direct;
  const nested = record ? asRecord(record.error) : null;
  const nestedCode = nested ? firstString(nested, ['code']) : '';
  if (nestedCode) return nestedCode;
  if (status === 404) return 'METHOD_NOT_FOUND';
  if (status === 503) return 'CREDENTIAL_STORE_UNAVAILABLE';
  return '';
}

/**
 * Read credential status from the connected daemon as a client, honestly degraded.
 * Status only, the response is folded through {@link deriveCredentialAvailability},
 * so a down store, an older daemon, an absent token, or a transport failure all become
 * a reason-carrying `available: false`, never a fabricated "configured" and never a
 * secret byte. `key` narrows to a single credential (the daemon's caller-named probe).
 */
export async function fetchDaemonCredentialAvailability(
  connection: CredentialStatusConnection,
  options: { readonly key?: string; readonly fetchImpl?: FetchLike } = {},
): Promise<CredentialAvailability> {
  if (!connection.token) {
    return { available: false, reason: 'No connected-host operator token; credential status is unavailable.' };
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) {
    return { available: false, reason: 'Credential status unavailable right now.' };
  }
  const query = options.key ? `?key=${encodeURIComponent(options.key)}` : '';
  const url = `${connection.baseUrl}${CREDENTIALS_ROUTE}${query}`;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(CREDENTIAL_STATUS_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text.trim() ? JSON.parse(text) as unknown : {};
    } catch {
      body = text;
    }
    if (!response.ok) {
      return deriveCredentialAvailability({
        ok: false,
        error: { code: machineCodeFromResponse(body, response.status), status: response.status },
      });
    }
    return deriveCredentialAvailability({ ok: true, value: body });
  } catch (error) {
    return deriveCredentialAvailability({ ok: false, error });
  }
}
