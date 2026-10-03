/**
 * credential-scope.ts, which secret-store tier a credential belongs in, for
 * the credential names this product invents.
 *
 * The platform rule is the owner's: a capability configured on ANY surface is
 * the daemon's to use afterwards, with that surface's process closed. For a
 * credential that means one home, the daemon tier, because the daemon reads
 * only its own tier and a surface silo is a place the daemon never looks.
 *
 * The SDK already answers this for every credential whose name DERIVES from a
 * daemon-owned config path (`isDaemonOwnedSecretKey`, built from
 * `listDaemonOwnedConfigPaths`). `GOODVIBES_EMAIL_PASSWORD_REF`,
 * `GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF` and the `surfaces.*` tokens all
 * come out of that derivation, and `SecretsManager.set` relocates them to the
 * daemon tier no matter what scope a caller asks for.
 *
 * The derivation cannot see names this product invents on its own, and there
 * are two families of those. Both are read by the daemon on a SCHEDULE, which
 * is the strongest form of "the surface is closed when it matters":
 *
 *   - the per-subscription iCalendar feed URL
 *     (`GOODVIBES_CALENDAR_SUB_<NAME>`, agent/calendar-subscription-registry.ts).
 *     The URL is a credential in its own right, a Google "secret address"
 *     grants read access to the whole calendar to anyone holding it, and the
 *     refresh loop that fetches it runs unattended.
 *
 *   - the calendar OAuth token set, the account record and the
 *     reconnect-needed marker (`GOODVIBES_CALENDAR_<PROVIDER>_TOKENS` /
 *     `_ACCOUNT` / `_STATUS`, written by the SDK's `CalendarTokenStore`). The
 *     token set holds the refresh token. A refresh token filed in a surface
 *     silo means the daemon reports "no calendar account connected" the moment
 *     that surface exits, having watched the operator connect one.
 *
 * Both are stated here as NAMES rather than as config paths because neither has
 * a config path: they are secret-store keys built by this product and by the
 * SDK's token store, not references parked in settings.json.
 *
 * FORWARD PLAN. The SDK is growing a `platform/config/credential-scope-registry`
 * that answers this question for every product in one place, keyed on the same
 * "does the daemon read it" test. When it ships and this package's SDK
 * dependency carries it, this module collapses to a re-export of
 * `isDaemonNeededSecretKey` from there and the two name families below move
 * into the registry. Until then the answer has to exist somewhere, and being
 * wrong here means a calendar that stops working when the terminal closes.
 */

import { isDaemonOwnedSecretKey, resolveSecretWriteScope } from '@goodvibes-jev/engine/sdk/platform/config';
import type { SecretScope } from './secrets.ts';

/**
 * The stored feed URL for one named calendar subscription. Built by
 * `secretKeyForName` in agent/calendar-subscription-registry.ts; the suffix is
 * an upper-snake slug of the subscription name, so this is a prefix test.
 */
const CALENDAR_SUBSCRIPTION_SECRET_PREFIX = 'GOODVIBES_CALENDAR_SUB_';

/**
 * The three keys the SDK's CalendarTokenStore writes per provider. Spelled out
 * rather than matched by pattern: a pattern over `GOODVIBES_CALENDAR_*` would
 * also swallow `GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF`, which the SDK
 * already owns, and any future calendar key nobody has thought about yet.
 */
const CALENDAR_OAUTH_TOKEN_SECRET_KEYS: readonly string[] = [
  'GOODVIBES_CALENDAR_GOOGLE_TOKENS',
  'GOODVIBES_CALENDAR_GOOGLE_ACCOUNT',
  'GOODVIBES_CALENDAR_GOOGLE_STATUS',
  'GOODVIBES_CALENDAR_MICROSOFT_TOKENS',
  'GOODVIBES_CALENDAR_MICROSOFT_ACCOUNT',
  'GOODVIBES_CALENDAR_MICROSOFT_STATUS',
];

const CALENDAR_OAUTH_TOKEN_SECRET_KEY_SET = new Set(CALENDAR_OAUTH_TOKEN_SECRET_KEYS);

/** The agent-invented names, for tests and for anything that needs to enumerate them. */
export function listAgentDaemonNeededSecretKeys(): readonly string[] {
  return CALENDAR_OAUTH_TOKEN_SECRET_KEYS;
}

export { CALENDAR_SUBSCRIPTION_SECRET_PREFIX };

/**
 * True when the daemon is a reader of this credential, so the daemon tier is
 * its home, whether the SDK's derivation already knew that or this product
 * had to say so.
 */
export function isDaemonNeededSecretKey(key: string): boolean {
  if (isDaemonOwnedSecretKey(key)) return true;
  if (CALENDAR_OAUTH_TOKEN_SECRET_KEY_SET.has(key)) return true;
  return key.startsWith(CALENDAR_SUBSCRIPTION_SECRET_PREFIX);
}

/**
 * Where a write to `key` will actually land, given what the caller asked for.
 *
 * Daemon need beats an explicit scope, the same way it does inside the SDK, and
 * for the same reason: the ordinary way a person stores a credential passes a
 * scope on every call (`/secrets set` defaults one, the settings modal used to
 * hardcode one), so honouring the request would mean the flag an operator never
 * thought about decides whether their calendar keeps working overnight. The
 * write is relocated, never refused, a wall in front of the credentials people
 * most need to set is worse than a credential filed somewhere they did not name.
 */
export function resolveCredentialWriteScope(key: string, requested?: SecretScope | undefined): SecretScope {
  if (isDaemonNeededSecretKey(key)) return 'daemon';
  return resolveSecretWriteScope(key, requested);
}

/** True when `requested` would have sent a daemon-read credential out of the daemon's reach. */
export function credentialWriteScopeWasRelocated(key: string, requested?: SecretScope | undefined): boolean {
  return requested !== undefined && requested !== 'daemon' && isDaemonNeededSecretKey(key);
}

/**
 * The scope a DELETE should sweep for `key`.
 *
 * `undefined` means "every tier". A daemon-read credential lives in the daemon
 * tier even when the caller passed `--project`, so a delete narrowed to the
 * requested scope would report success and leave the live copy in place, a
 * credential the operator believes is revoked and is not.
 */
export function resolveCredentialDeleteScope(key: string, requested?: SecretScope | undefined): SecretScope | undefined {
  return isDaemonNeededSecretKey(key) ? undefined : requested;
}
