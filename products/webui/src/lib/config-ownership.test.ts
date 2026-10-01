/**
 * config-ownership.test.ts: the daemon-owned badge predicate. The local predicate must
 * agree with the SDK's own isDaemonOwnedConfigKey for every schema key and every
 * non-schema path, and the listed rulings are the classifications a user sees.
 */
import { describe, expect, test } from 'bun:test';
import {
  DAEMON_OWNED_CONFIG_KEYS as SDK_KEYS,
  DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS as SDK_NON_SCHEMA_PATHS,
  isDaemonOwnedConfigKey as sdkIsDaemonOwnedConfigKey,
} from '@goodvibes-jev/engine/sdk/platform/config';
import { isDaemonOwnedConfigKey } from './config-ownership';
import { CONFIG_SCHEMA_ENTRIES } from './generated/config-schema';

describe('the local predicate agrees with the SDK predicate', () => {
  const corpus = [
    ...CONFIG_SCHEMA_ENTRIES.map((entry) => entry.key),
    ...SDK_NON_SCHEMA_PATHS,
    ...SDK_KEYS,
    // Keys that share a prefix WORD but not the dotted prefix, and keys under no namespace.
    'webhookRetryLimit',
    'relayed.enabled',
    'surfacesX.y',
    'daemon',
    '',
  ];

  test('for every schema key, every non-schema path, and the prefix-collision shapes', () => {
    const disagreements = corpus.filter((key) => isDaemonOwnedConfigKey(key) !== sdkIsDaemonOwnedConfigKey(key));
    expect(disagreements).toEqual([]);
    // Both answers occur in the corpus, so agreement is not "everything is false".
    expect(corpus.some((key) => isDaemonOwnedConfigKey(key))).toBe(true);
    expect(corpus.some((key) => !isDaemonOwnedConfigKey(key))).toBe(true);
  });
});

describe('the rulings the badge shows', () => {
  test('surfaces, control plane, payments and the mail/calendar credential paths are daemon-owned', () => {
    expect(isDaemonOwnedConfigKey('surfaces.telegram.botToken')).toBe(true);
    expect(isDaemonOwnedConfigKey('controlPlane.bindHost')).toBe(true);
    expect(isDaemonOwnedConfigKey('payments.budget.dailyItem')).toBe(true);
    expect(isDaemonOwnedConfigKey('email.passwordRef')).toBe(true);
    expect(isDaemonOwnedConfigKey('calendar.google.icsUrl')).toBe(true);
  });

  test('daemon.timezone is the one daemon.* key the daemon owns; daemon.enabled and service.* are per-installation', () => {
    expect(isDaemonOwnedConfigKey('daemon.timezone')).toBe(true);
    expect(isDaemonOwnedConfigKey('daemon.enabled')).toBe(false);
    expect(isDaemonOwnedConfigKey('service.autostart')).toBe(false);
  });

  test('client-side settings are not daemon-owned: display, provider, behavior, and the wake word that listens in each client', () => {
    expect(isDaemonOwnedConfigKey('display.theme')).toBe(false);
    expect(isDaemonOwnedConfigKey('provider.model')).toBe(false);
    expect(isDaemonOwnedConfigKey('behavior.hitlMode')).toBe(false);
    expect(isDaemonOwnedConfigKey('voice.wake.enabled')).toBe(false);
  });

  test('a key that only shares a prefix word, not the dotted prefix, is not flagged', () => {
    expect(isDaemonOwnedConfigKey('webhookRetryLimit')).toBe(false);
  });
});
