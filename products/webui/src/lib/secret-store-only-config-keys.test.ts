import { describe, expect, test } from 'bun:test';
import { daemonSecretKeyFor as sdkDaemonSecretKeyFor } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  daemonSecretKeyFor,
  isSecretStoreOnlyConfigKey,
  SECRET_STORE_ONLY_CONFIG_KEYS,
  secretStoreSetCommandFor,
} from './secret-store-only-config-keys';

describe('isSecretStoreOnlyConfigKey', () => {
  test('the mail passwords and the CalDAV password are declared', () => {
    expect(isSecretStoreOnlyConfigKey('surfaces.email.password')).toBe(true);
    expect(isSecretStoreOnlyConfigKey('surfaces.email.imapPassword')).toBe(true);
    expect(isSecretStoreOnlyConfigKey('surfaces.email.imap.password')).toBe(true);
    expect(isSecretStoreOnlyConfigKey('surfaces.email.smtp.password')).toBe(true);
    expect(isSecretStoreOnlyConfigKey('surfaces.calendar.caldavPassword')).toBe(true);
  });

  test('an ordinary secret-shaped key that IS read literally from config is not flagged', () => {
    // surfaces.slack.botToken supports a literal value stored directly in
    // config (resolveSecretInput falls through to the trimmed literal when the
    // string is not a recognized secret-ref format), config.set genuinely
    // configures it, so it must not be refused.
    expect(isSecretStoreOnlyConfigKey('surfaces.slack.botToken')).toBe(false);
    expect(isSecretStoreOnlyConfigKey('surfaces.telegram.botToken')).toBe(false);
  });

  test('an ordinary non-secret key is not flagged', () => {
    expect(isSecretStoreOnlyConfigKey('display.theme')).toBe(false);
    expect(isSecretStoreOnlyConfigKey('surfaces.email.host')).toBe(false);
  });
});

describe('daemonSecretKeyFor: ported derivation matches the installed SDK exactly', () => {
  test('matches the real SDK function for every declared key', () => {
    for (const key of SECRET_STORE_ONLY_CONFIG_KEYS) {
      expect(daemonSecretKeyFor(key)).toBe(sdkDaemonSecretKeyFor(key));
    }
  });

  test('produces the documented names', () => {
    expect(daemonSecretKeyFor('surfaces.email.password')).toBe('GOODVIBES_SURFACES_EMAIL_PASSWORD');
    expect(daemonSecretKeyFor('surfaces.calendar.caldavPassword')).toBe('GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD');
  });

  test('both spellings of the IMAP password derive the same secret name', () => {
    // surface-config.ts: "surfaces.email.imap.password and surfaces.email.imapPassword
    // both derive GOODVIBES_SURFACES_EMAIL_IMAP_PASSWORD".
    expect(daemonSecretKeyFor('surfaces.email.imapPassword')).toBe(daemonSecretKeyFor('surfaces.email.imap.password'));
    expect(daemonSecretKeyFor('surfaces.email.imapPassword')).toBe('GOODVIBES_SURFACES_EMAIL_IMAP_PASSWORD');
  });
});

describe('secretStoreSetCommandFor', () => {
  test('names the real command with the derived secret-store key', () => {
    expect(secretStoreSetCommandFor('surfaces.email.password')).toBe(
      '/secrets set GOODVIBES_SURFACES_EMAIL_PASSWORD <value>',
    );
  });
});
