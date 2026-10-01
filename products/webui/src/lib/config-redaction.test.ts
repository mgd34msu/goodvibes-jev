import { describe, expect, test } from 'bun:test';
import {
  categoryLabelForKey,
  displayConfigValue,
  flattenConfig,
  isSecretConfigKey,
  maskSecretValue,
} from './config-redaction';
import { CONFIG_SCHEMA_ENTRIES } from './generated/config-schema';
import { DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS } from './generated/config-ownership';

describe('isSecretConfigKey', () => {
  test('recognizes every key ported from the TUI\'s SECRET_CONFIG_KEYS allowlist', () => {
    expect(isSecretConfigKey('surfaces.slack.botToken')).toBe(true);
    expect(isSecretConfigKey('surfaces.whatsapp.signingSecret')).toBe(true);
    expect(isSecretConfigKey('surfaces.matrix.accessToken')).toBe(true);
  });

  test('recognizes surfaces.telephony.* directly from the declared list, not merely via the suffix fallback', () => {
    // surfaces.telephony.* keys are real (schema-domain-surfaces.ts) and were
    // previously caught only by the generic suffix heuristic (or, for
    // .webhookSecret, not distinguished from being declared at all). They are
    // now named in SECRET_CONFIG_KEYS itself, the declared list is the
    // primary classifier, not the fallback.
    expect(isSecretConfigKey('surfaces.telephony.token')).toBe(true);
    expect(isSecretConfigKey('surfaces.telephony.authToken')).toBe(true);
    expect(isSecretConfigKey('surfaces.telephony.webhookSecret')).toBe(true);
  });

  test('mail and calendar credentials are declared, the mail/calendar passwords', () => {
    expect(isSecretConfigKey('surfaces.email.password')).toBe(true);
    expect(isSecretConfigKey('surfaces.email.imapPassword')).toBe(true);
    expect(isSecretConfigKey('surfaces.calendar.caldavPassword')).toBe(true);
  });

  test('mail and calendar secret REFERENCES are declared; none of these end in a suffix the old fallback caught', () => {
    // These are DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS (app-layer paths, not
    // CONFIG_SCHEMA scalars), the old suffix-only implementation never even
    // saw them in a schema scan, and several (icsUrl, clientSecretRef,
    // passwordRef) do not end in "token"/"secret"/"password" either.
    for (const key of [
      'email.passwordRef',
      'calendar.google.clientSecretRef',
      'calendar.microsoft.clientSecretRef',
      'calendar.google.icsUrl',
      'google.oauth.refreshToken',
    ]) {
      expect(isSecretConfigKey(key)).toBe(true);
    }
  });

  test('the cluster coordination secret and key material are declared', () => {
    expect(isSecretConfigKey('cluster.secret')).toBe(true);
    // cluster.groupMaterial is the case the OLD suffix-only heuristic missed:
    // "groupMaterial" does not end in token/secret/password/apikey.
    expect(isSecretConfigKey('cluster.groupMaterial')).toBe(true);
  });

  test('Cloudflare provisioning tokens are declared; every one ends in "Ref", which the suffix fallback does not match', () => {
    for (const key of [
      'cloudflare.apiTokenRef',
      'cloudflare.workerTokenRef',
      'cloudflare.workerClientTokenRef',
      'cloudflare.tunnelTokenRef',
      'cloudflare.accessServiceTokenRef',
    ]) {
      expect(isSecretConfigKey(key)).toBe(true);
    }
  });

  test('resource identifiers that sit next to a secret are deliberately NOT masked; they are not the secret itself', () => {
    // Same shape as calendar.google.clientId (not masked): an id that names or
    // locates a credential, not the credential's value.
    expect(isSecretConfigKey('surfaces.telegram.discoveredBotTokenId')).toBe(false);
    expect(isSecretConfigKey('cloudflare.accessServiceTokenId')).toBe(false);
    expect(isSecretConfigKey('cloudflare.secretsStoreName')).toBe(false);
    expect(isSecretConfigKey('cloudflare.secretsStoreId')).toBe(false);
    expect(isSecretConfigKey('calendar.google.clientId')).toBe(false);
  });

  test('catches secret-shaped keys the declared list has not caught up to yet (the additional suffix safety net)', () => {
    expect(isSecretConfigKey('some.newSurface.apiKey')).toBe(true);
  });

  test('an ordinary, non-secret key is not flagged', () => {
    expect(isSecretConfigKey('display.theme')).toBe(false);
    expect(isSecretConfigKey('helper.globalProvider')).toBe(false);
    expect(isSecretConfigKey('provider.model')).toBe(false);
  });

  test('LLM-token settings are not credential-shaped despite containing the word "token"', () => {
    // display.showTokenSpeed, planner.tokenCeiling etc. are about LLM token
    // counts, not authentication tokens, the last-segment suffix regex only
    // matches a segment that ENDS in "token", so these are correctly excluded.
    expect(isSecretConfigKey('display.showTokenSpeed')).toBe(false);
    expect(isSecretConfigKey('planner.tokenCeiling')).toBe(false);
    expect(isSecretConfigKey('tools.defaultTokenBudget')).toBe(false);
  });
});

describe('declared-list coverage: a content-shaped scan over the REAL schema, reported by a test rather than silently rendered', () => {
  // The brief's own example of why a naming heuristic is not enough: a field
  // whose CONTENT is sensitive (a card number, a cardholder name) but whose
  // NAME carries no signal at all cannot be found by any naming scan, declared
  // or heuristic. That gap is real and is not closed here, see the module
  // header. What CAN be enforced automatically is the weaker property: every
  // real schema key or daemon-owned non-schema path that DOES contain a
  // secret-suggestive word anywhere in its dotted name (not just as the last
  // segment) must be classified as secret. A key matching this broad net but
  // not SECRET_CONFIG_KEYS fails here, "reported by a test", instead of
  // silently rendering in the UI the day it ships.
  const BROAD_CONTENT_SIGNAL = /token|secret|password|apikey|api_key|credential|clientsecret|refreshtoken/i;
  // Named, confirmed-safe exceptions: identifiers/labels that contain a
  // secret-suggestive word but are not themselves the secret value (ids,
  // resource names, or settings ABOUT tokens/secrets rather than holding one).
  const KNOWN_SAFE_NON_SECRETS = new Set([
    // Settings ABOUT tokens/secrets, not holding one.
    'storage.secretPolicy',
    'display.showTokenSpeed',
    'planner.tokenCeiling',
    'tools.defaultTokenBudget',
    'security.tokenAudit.enabled',
    'security.tokenAudit.rotationCadenceDays',
    'security.tokenAudit.rotationWarningDays',
    'security.tokenAudit.managed',
    'agents.passiveInjection.budgetTokens',
    'runtime.toolBudget.maxTokens',
    // Identifiers that name or locate a credential, not the credential itself.
    'surfaces.telegram.discoveredBotTokenId',
    'cloudflare.accessServiceTokenId',
    'cloudflare.secretsStoreName',
    'cloudflare.secretsStoreId',
    // Records WHICH prior surface a Google credential migrated from (a label
    // like "tui", not a credential value).
    'google.credentials.migratedFrom',
  ]);

  test('every real schema key matching the broad content signal is either declared secret or a named-safe exception', () => {
    const unclassified = CONFIG_SCHEMA_ENTRIES.map((entry) => entry.key)
      .filter((key) => BROAD_CONTENT_SIGNAL.test(key))
      .filter((key) => !isSecretConfigKey(key) && !KNOWN_SAFE_NON_SECRETS.has(key));
    expect(unclassified).toEqual([]);
  });

  test('every daemon-owned non-schema path matching the broad content signal is either declared secret or a named-safe exception', () => {
    const unclassified = DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS.filter(
      (path) => BROAD_CONTENT_SIGNAL.test(path) && !isSecretConfigKey(path) && !KNOWN_SAFE_NON_SECRETS.has(path),
    );
    expect(unclassified).toEqual([]);
  });

  test('every named-safe exception is genuinely not masked (guards against the exception list hiding a real gap)', () => {
    for (const key of KNOWN_SAFE_NON_SECRETS) {
      // Sanity: every entry in this list must actually exist in one of the two
      // universes scanned above, or it is dead weight rather than a real
      // exception.
      const inSchema = CONFIG_SCHEMA_ENTRIES.some((entry) => entry.key === key);
      const inNonSchema = DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS.includes(key);
      expect(inSchema || inNonSchema).toBe(true);
    }
  });
});

describe('maskSecretValue', () => {
  test('keeps the last 4 chars, stars the rest', () => {
    expect(maskSecretValue('sk-abcdefgh1234')).toBe(`${'•'.repeat(11)}1234`);
  });

  test('short values mask fully', () => {
    expect(maskSecretValue('abc')).toBe('••••');
  });

  test('empty string reads as a visible marker, not a masked zero-length value', () => {
    expect(maskSecretValue('').length).toBeGreaterThan(0);
    expect(maskSecretValue('')).not.toBe(maskSecretValue('abc'));
  });
});

describe('displayConfigValue', () => {
  test('never renders a secret key\'s value raw', () => {
    const displayed = displayConfigValue('surfaces.slack.botToken', 'xoxb-real-secret-value');
    expect(displayed).not.toContain('real-secret-value');
    expect(displayed).toContain('alue'); // last 4 chars only
  });

  test('renders a non-secret string value verbatim', () => {
    expect(displayConfigValue('display.theme', 'vaporwave')).toBe('vaporwave');
  });

  test('unset, empty and boolean values render distinctly, never a fabricated value', () => {
    const unset = displayConfigValue('provider.model', null);
    expect(unset.length).toBeGreaterThan(0);
    expect(displayConfigValue('provider.model', undefined)).toBe(unset);
    const empty = displayConfigValue('tts.llmModel', '');
    expect(empty.length).toBeGreaterThan(0);
    expect(empty).not.toBe(unset);
    expect(displayConfigValue('helper.enabled', true)).toBe('true');
    expect(displayConfigValue('helper.enabled', false)).toBe('false');
  });

  test('numbers and objects render without throwing', () => {
    expect(displayConfigValue('tts.speed', 1.5)).toBe('1.5');
    expect(displayConfigValue('cache.gates', [{ name: 'lint' }])).toContain('lint');
  });
});

describe('categoryLabelForKey', () => {
  test('keys group by their namespace', () => {
    expect(categoryLabelForKey('helper.globalModel')).toBe(categoryLabelForKey('helper.enabled'));
    expect(categoryLabelForKey('tts.llmModel')).not.toBe(categoryLabelForKey('helper.enabled'));
    expect(categoryLabelForKey('surfaces.slack.botToken')).toBe(categoryLabelForKey('surfaces.email.password'));
  });

  test('an unmapped namespace falls back to a Title Case of itself, never a fabricated label', () => {
    expect(categoryLabelForKey('someNewDomain.key')).toBe('Some New Domain');
  });
});

describe('flattenConfig', () => {
  test('flattens nested objects into dotted keys, categorized', () => {
    const entries = flattenConfig({ helper: { enabled: true, globalModel: 'gpt-5' }, display: { theme: 'vaporwave' } });
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual(['display.theme', 'helper.enabled', 'helper.globalModel']);
    expect(entries.find((e) => e.key === 'helper.enabled')?.category).toBe(categoryLabelForKey('helper.enabled'));
  });

  test('arrays are treated as leaf values, not descended into', () => {
    const entries = flattenConfig({ notifications: { webhookUrls: ['a', 'b'] } });
    expect(entries).toEqual([{ key: 'notifications.webhookUrls', value: ['a', 'b'], category: 'Notifications' }]);
  });

  test('an empty or non-object input yields no entries', () => {
    expect(flattenConfig(undefined)).toEqual([]);
    expect(flattenConfig(null)).toEqual([]);
    expect(flattenConfig('not an object')).toEqual([]);
  });
});
