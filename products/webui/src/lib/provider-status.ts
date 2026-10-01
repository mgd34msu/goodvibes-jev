/**
 * provider-status.ts, honest per-provider health, derived from the real
 * per-route freshness the wire returns (ProviderAuthRouteDescriptor.freshness),
 * never a decorative fallback.
 *
 * The wire exposes routes in two different shapes depending on which query
 * populated the record:
 *   - ModelRouteProviderRecord (models.list catalog): top-level `routes`,
 *     `configured`, `configuredVia`.
 *   - ProviderRuntimeSnapshot (providers.list / providers.get): nested at
 *     `runtime.auth.routes` / `runtime.auth.configured`.
 * ProvidersView merges both into one record per provider id, so a caller may
 * carry either shape (or both). This module reads all three candidate paths
 * so the deriver works regardless of which query populated which field.
 *
 * This module is the ONLY place that turns route freshness into a provider
 * pill. `bestStatus` (src/lib/object.ts) stays untouched, it is a generic
 * fallback other RecordList consumers rely on and must not gain
 * provider-specific meaning.
 */
import { asRecord, firstString, readPath } from './object';

/** The honest set of provider-pill states. Never "unknown". */
export type ProviderFreshness =
  | 'healthy'
  | 'expiring'
  | 'expired'
  | 'pending'
  | 'unconfigured'
  | 'status unavailable';

export interface ProviderRouteStatus {
  readonly route: string;
  readonly label: string;
  readonly freshness: ProviderFreshness;
  readonly configured: boolean;
  readonly usable?: boolean;
  readonly detail?: string;
  readonly repairHints: readonly string[];
}

export interface ProviderStatus {
  readonly freshness: ProviderFreshness;
  readonly configured: boolean;
  readonly configuredVia: string;
  readonly routes: readonly ProviderRouteStatus[];
}

// Worst-wins ranking among *meaningful* (i.e. actually-configured) routes.
//
// FORWARD-COMPAT / UNKNOWN-FRESHNESS RULING (F7f): normalizeRoute maps any freshness
// value this client build does not recognize (a future daemon could add one) to
// 'status unavailable' when the route IS configured, or 'unconfigured' when it isn't,
// NEVER silently to 'healthy'. So a new daemon freshness value can never masquerade as
// a clean pill. The remaining question is the ROLL-UP: a configured route whose
// freshness we can't classify must not be silently excluded either (that would let a
// provider read 'healthy' while holding a route we can't vouch for). Ruling, weighed
// against the honesty bar: SURFACE it, 'status unavailable' participates in worst-wins,
// ranked ABOVE healthy/pending ("we can't vouch for this") but BELOW the known-degraded
// states expiring/expired (a known, actionable fault is genuinely more severe). It is
// NOT relabelled as a fabricated 'warning' fault, 'status unavailable' is the honest
// name for "health absent/unknown", so we keep it, we just stop hiding it.
//
// 'unconfigured' deliberately has no rank, a route reporting 'unconfigured' isn't a
// severity level, it's "this route isn't set up", handled separately below.
const FRESHNESS_RANK: Record<string, number> = {
  healthy: 1,
  pending: 2,
  'status unavailable': 3,
  expiring: 4,
  expired: 5,
};

const ROUTE_PATHS: readonly (readonly string[])[] = [
  ['routes'],
  ['auth', 'routes'],
  ['runtime', 'auth', 'routes'],
];

function extractRoutes(record: unknown): unknown[] {
  for (const path of ROUTE_PATHS) {
    const value = readPath(record, [...path]);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function extractConfigured(record: unknown): { configured: boolean; configuredVia: string } {
  const top = asRecord(record);
  const configuredVia = firstString(record, ['configuredVia']);
  const nestedConfigured =
    readPath(record, ['runtime', 'auth', 'configured']) === true ||
    readPath(record, ['auth', 'configured']) === true;
  // The daemon's aggregate flag has been observed FALSE while one of its own
  // routes reports configured+usable (subscription-oauth on a provider whose
  // env API key is absent). A usable route IS a configured provider, so the
  // routes are consulted, not just the rollup, and the header can never
  // contradict a healthy pill derived from those same routes.
  const routeConfigured = extractRoutes(record).some((route) => {
    const r = asRecord(route);
    return r.configured === true || r.usable === true;
  });
  const configured = top.configured === true || nestedConfigured || routeConfigured || configuredVia.length > 0;
  return { configured, configuredVia };
}

function normalizeRoute(raw: unknown): ProviderRouteStatus {
  const record = asRecord(raw);
  const configured = record.configured === true;
  const freshnessRaw = firstString(record, ['freshness']);
  const freshness: ProviderFreshness =
    freshnessRaw === 'healthy' ||
    freshnessRaw === 'expiring' ||
    freshnessRaw === 'expired' ||
    freshnessRaw === 'pending' ||
    freshnessRaw === 'unconfigured'
      ? freshnessRaw
      : configured
        ? 'status unavailable'
        : 'unconfigured';
  return {
    route: firstString(record, ['route']) || 'route',
    label: firstString(record, ['label', 'route']) || 'Route',
    freshness,
    configured,
    usable: typeof record.usable === 'boolean' ? record.usable : undefined,
    detail: firstString(record, ['detail']) || undefined,
    repairHints: Array.isArray(record.repairHints)
      ? record.repairHints.filter((hint): hint is string => typeof hint === 'string')
      : [],
  };
}

/**
 * Roll every route's freshness into one honest provider pill.
 *
 *   - Any meaningful (non-"unconfigured") freshness present -> worst wins
 *     (expired > expiring > status-unavailable > pending > healthy). A configured
 *     route with an unrecognized/future freshness value counts as
 *     'status unavailable' here (see FRESHNESS_RANK's forward-compat ruling) so it
 *     surfaces rather than hiding behind a healthy sibling.
 *   - Routes exist but every single one reports 'unconfigured' -> the whole
 *     provider is 'unconfigured' (a real, known state).
 *   - No route data at all (or an empty route list) -> 'status unavailable'
 *     (health is genuinely absent, distinct from 'unconfigured').
 */
export function deriveProviderStatus(record: unknown): ProviderStatus {
  const { configured, configuredVia } = extractConfigured(record);
  const routes = extractRoutes(record).map(normalizeRoute);

  const meaningful = routes.filter((route) => route.freshness in FRESHNESS_RANK);
  if (meaningful.length > 0) {
    const worst = meaningful.reduce((worstSoFar, route) =>
      FRESHNESS_RANK[route.freshness] > FRESHNESS_RANK[worstSoFar.freshness] ? route : worstSoFar,
    );
    return { freshness: worst.freshness, configured, configuredVia, routes };
  }

  const allExplicitlyUnconfigured = routes.length > 0 && routes.every((route) => route.freshness === 'unconfigured');
  return {
    freshness: allExplicitlyUnconfigured ? 'unconfigured' : 'status unavailable',
    configured,
    configuredVia,
    routes,
  };
}

/** Pill text, the freshness label itself, never a decorative fallback. */
export function providerStatusLabel(status: ProviderStatus): string {
  return status.freshness;
}

/** Header text, matched to the real `configured` flag, not the merged list record's flat (often-absent) copy of it. */
export function providerHeaderLabel(status: ProviderStatus): string {
  if (!status.configured) return 'not configured';
  return status.configuredVia ? `configured via ${status.configuredVia}` : 'configured';
}

// ---------------------------------------------------------------------------
// Shared credential-status consumption (secret-free, honest-degrade)
// ---------------------------------------------------------------------------

/** One credential's status metadata from the daemon's shared store, never bytes. */
export interface CredentialStatusEntry {
  readonly key: string;
  readonly configured: boolean;
  readonly usable: boolean;
  readonly source?: string;
  readonly secure?: boolean;
}

export type CredentialAvailability =
  | { readonly available: true; readonly credentials: readonly CredentialStatusEntry[] }
  | { readonly available: false; readonly reason: string };

/**
 * Fold a `credentials.get` outcome into an honest availability value. The
 * degrade contract (see the 1.0.1 cross-surface credential status entry in
 * CHANGELOG.md): a 503 `CREDENTIAL_STORE_UNAVAILABLE`, a `METHOD_NOT_FOUND`
 * from an older daemon, or any transport failure yields `available: false`
 * with a plain reason, NEVER a fabricated "configured".
 */
export function deriveCredentialAvailability(outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): CredentialAvailability {
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
      secure: rec.secure === true ? true : rec.secure === false ? false : undefined,
    });
  }
  return { available: true, credentials };
}

// ---------------------------------------------------------------------------
// Plain-language state for the settings dialog's provider rows
// ---------------------------------------------------------------------------

/** The status-dot tone for a freshness (settings dialog rows). */
export function freshnessTone(freshness: ProviderFreshness): 'ok' | 'warn' | 'bad' | 'info' | 'idle' {
  switch (freshness) {
    case 'healthy': return 'ok';
    case 'expiring': return 'warn';
    case 'expired': return 'bad';
    case 'pending': return 'info';
    case 'status unavailable': return 'warn';
    case 'unconfigured': return 'idle';
  }
}

/** The words beside the dot: what the freshness means to a person, never the wire value. */
export function freshnessPhrase(freshness: ProviderFreshness): string {
  switch (freshness) {
    case 'healthy': return 'Signed in';
    case 'expiring': return 'Sign-in expiring soon';
    case 'expired': return 'Sign-in expired';
    case 'pending': return 'Sign-in pending';
    case 'status unavailable': return 'Status unavailable';
    case 'unconfigured': return 'Not set up';
  }
}

/** One line for a provider row: its state, plus where it was set up when the daemon says. */
export function providerStatePhrase(status: ProviderStatus): string {
  const phrase = freshnessPhrase(status.freshness);
  return status.configured && status.configuredVia ? `${phrase} · set up via ${status.configuredVia}` : phrase;
}
