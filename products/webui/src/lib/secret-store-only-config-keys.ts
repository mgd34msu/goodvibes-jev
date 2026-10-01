/**
 * secret-store-only-config-keys.ts, config keys a `config.set` write cannot
 * actually configure, no matter what value is sent.
 *
 * GROUNDED: for most secret-shaped config keys (surfaces.slack.botToken,
 * surfaces.telegram.botToken, ...), the daemon's own read path
 * (`resolveSecretInput` in the SDK's secret-refs.ts) accepts EITHER a
 * `goodvibes://…`/`env:…`/etc. secret reference OR a literal string, a
 * literal token pasted through `config.set` is read back and used as-is. For
 * those keys, config.set is a real, working write path (SettingsField.tsx's
 * ordinary masked-secret editor is correct for them).
 *
 * The daemon's own mailbox and calendar passwords are NOT like that. Their
 * resolvers deliberately never read a literal from config at all:
 *
 *   - `surfaces.email.password` / `.imapPassword` / `.imap.password` /
 *     `.smtp.password`, packages/sdk/src/platform/email/surface-config.ts:
 *     "Every password is fetched from the secret store under the name the
 *     config key derives (`daemonSecretKeyFor`), never read out of a settings
 *     file." `readSurfaceEmailSettings` does not even attempt to read these
 *     keys as config strings, only host/port/user/from are read that way.
 *   - `surfaces.calendar.caldavPassword`,
 *     packages/sdk/src/platform/calendar/caldav-gateway-config.ts:
 *     "A raw password pasted into config resolves to nothing rather than
 *     being used, which is deliberate: a credential in a settings file is a
 *     credential in every backup of it." A literal value stored there is
 *     first tried as a secret-store REFERENCE (so it resolves to nothing
 *     unless it happens to name a real stored secret) and then as a
 *     config-derived secret lookup (also empty, since nothing was ever
 *     written under that name), so the calendar reports
 *     `CALENDAR_CREDENTIALS_MISSING` regardless of what was "saved".
 *
 * So a `config.set` on one of these keys does two bad things at once: it
 * writes the operator's real password into the daemon's plaintext config
 * file (a credential in every backup of that file, per the CalDAV module's
 * own words), and it configures nothing, because the mail/calendar reader
 * never looks at that value. The UI reporting "Saved, stored in ..." on
 * that write is a lie by omission.
 *
 * There is no operator-exposed RPC that can write into the daemon's secret
 * store instead (searched the SDK's control-plane method catalog,
 * `method-catalog-admin.ts` exposes `credentials.get`, read-only, and no
 * `secrets.set`/`secrets.write` method at all). So the honest behavior for a
 * REMOTE browser client, which can only ever reach the daemon over this
 * wire, is to refuse the write for these keys and name the real mechanism:
 * setting the credential from a terminal with daemon access, which is where
 * `/secrets set` (the mechanism `surface-config.ts` and
 * `caldav-gateway-config.ts` both describe as "where setup stores it") is
 * available.
 */

/** Every config key whose real value only ever comes from the daemon's secret
 *  store, a `config.set` write here is inert and leaves a plaintext,
 *  never-read copy behind. */
export const SECRET_STORE_ONLY_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'surfaces.email.password',
  'surfaces.email.imapPassword',
  'surfaces.email.imap.password',
  'surfaces.email.smtp.password',
  'surfaces.calendar.caldavPassword',
]);

export function isSecretStoreOnlyConfigKey(key: string): boolean {
  return SECRET_STORE_ONLY_CONFIG_KEYS.has(key);
}

/**
 * The secret-store name this config key implies, ported verbatim from the
 * SDK's `daemonSecretKeyFor` (packages/sdk/src/platform/config/daemon-secret-keys.ts)
 * for the same reason config-ownership.ts and config-redaction.ts already port
 * SDK data rather than importing the config barrel: the barrel drags
 * SecretsManager / OAuth / node-only code into the browser bundle. This
 * function itself is pure string manipulation with no dependency of its own,
 * so the port is exact and has nothing to drift out of sync with beyond the
 * derivation rule itself, which is covered by daemonSecretKeyFor.test.ts.
 *
 * `surfaces.slack.botToken` → `GOODVIBES_SURFACES_SLACK_BOT_TOKEN`.
 */
export function daemonSecretKeyFor(configPath: string): string {
  const normalizeSecretKeyPart = (value: string): string =>
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
  return `GOODVIBES_${configPath.split('.').map(normalizeSecretKeyPart).filter(Boolean).join('_')}`;
}

/** The exact `/secrets set` command an operator can run from a terminal with
 *  daemon access to actually configure this credential. */
export function secretStoreSetCommandFor(key: string): string {
  return `/secrets set ${daemonSecretKeyFor(key)} <value>`;
}
