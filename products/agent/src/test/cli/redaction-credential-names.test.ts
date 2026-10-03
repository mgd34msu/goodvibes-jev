/**
 * redaction-credential-names.test.ts, a support bundle is a file the owner
 * emails to someone. Every credential-bearing config path has to be masked in
 * it by NAME, whatever the value happens to be.
 *
 * The failure class this pins: the redactor matched a config path whose last
 * SEGMENT was one of a dozen words (`botToken`, `signingSecret`, `password`).
 * `email.passwordRef`, `calendar.google.clientSecretRef`,
 * `google.oauth.refreshToken`, `surfaces.msteams.appPassword` and
 * `cloudflare.apiTokenRef` name credential material and match none of them, so
 * a literal stored at any of those paths went into the bundle in the clear.
 *
 * The other half of the test is what must NOT be redacted. Widening the word
 * list until it caught the misses would swallow `display.showTokenSpeed`,
 * `planner.tokenCeiling` and `security.tokenAudit.enabled`, settings a support
 * bundle exists to show, replaced by `<redacted>`.
 */

import { describe, expect, test } from 'bun:test';
import { REDACTED_VALUE, isSensitiveConfigPath, redactConfig, redactText } from '../../cli/redaction.ts';

/** Every path that holds credential material and is missed by the word list. */
const CREDENTIAL_PATHS: readonly string[] = [
  // Mail.
  'email.passwordRef',
  'email.smtpPasswordRef',
  'surfaces.email.imapPassword',
  // Calendar, including the private feed address, which grants calendar read
  // access to anyone holding it.
  'calendar.google.clientSecretRef',
  'calendar.microsoft.clientSecretRef',
  'calendar.google.icsUrl',
  'surfaces.calendar.caldavPassword',
  // Google OAuth.
  'google.oauth.refreshToken',
  // Chat / telephony surfaces.
  'surfaces.msteams.appPassword',
  'surfaces.telephony.authToken',
  'surfaces.googleChat.webhookUrl',
  // Cloudflare.
  'cloudflare.apiTokenRef',
  'cloudflare.tunnelTokenRef',
  'cloudflare.workerTokenRef',
  'cloudflare.workerClientTokenRef',
  'cloudflare.accessServiceTokenRef',
  // Cluster key material.
  'cluster.groupMaterial',
];

/** Paths the original word list already covered. Kept so a rewrite cannot lose them. */
const ALREADY_COVERED_PATHS: readonly string[] = [
  'surfaces.slack.botToken',
  'surfaces.slack.appToken',
  'surfaces.slack.signingSecret',
  'surfaces.telegram.botToken',
  'surfaces.telegram.webhookSecret',
  'surfaces.discord.botToken',
  'surfaces.whatsapp.accessToken',
  'surfaces.whatsapp.verifyToken',
  'surfaces.googleChat.verificationToken',
  'surfaces.matrix.accessToken',
  'surfaces.bluebubbles.password',
  'surfaces.webhook.secret',
  'surfaces.email.password',
  'cluster.secret',
  'controlPlane.tls.keyFile',
];

/**
 * Settings whose name mentions a credential word but whose VALUE is a number, a
 * boolean or an identifier. Redacting these would hide the thing being
 * diagnosed while protecting nothing.
 */
const MUST_NOT_REDACT_PATHS: readonly string[] = [
  'display.showTokenSpeed',
  'planner.tokenCeiling',
  'tools.defaultTokenBudget',
  'runtime.toolBudget.maxTokens',
  'agents.passiveInjection.budgetTokens',
  'security.tokenAudit.enabled',
  'security.tokenAudit.rotationCadenceDays',
  'storage.secretPolicy',
  'cluster.keyRotationHours',
  'cloudflare.secretsStoreName',
  'cloudflare.secretsStoreId',
  'cloudflare.accessServiceTokenId',
  'surfaces.telegram.discoveredBotTokenId',
];

/** Build a nested config object from a dotted path. */
function nest(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next: Record<string, unknown> = {};
    cursor[parts[index]!] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]!] = value;
  return root;
}

describe('support-bundle redaction covers credentials named by full key', () => {
  for (const path of CREDENTIAL_PATHS) {
    test(`${path} is treated as sensitive`, () => {
      expect(isSensitiveConfigPath(path)).toBe(true);
    });

    test(`a literal stored at ${path} never reaches the bundle`, () => {
      const result = redactConfig(nest(path, 'the-literal-credential-value'));
      expect(JSON.stringify(result.value)).not.toContain('the-literal-credential-value');
      expect(JSON.stringify(result.value)).toContain(REDACTED_VALUE);
      expect(result.redactedPaths).toContain(path);
    });
  }

  for (const path of ALREADY_COVERED_PATHS) {
    test(`${path} stays sensitive`, () => {
      expect(isSensitiveConfigPath(path)).toBe(true);
    });
  }

  for (const path of MUST_NOT_REDACT_PATHS) {
    test(`${path} is left readable`, () => {
      expect(isSensitiveConfigPath(path)).toBe(false);
      const result = redactConfig(nest(path, 42));
      expect(result.redactedPaths).toHaveLength(0);
    });
  }

  test('a goodvibes:// reference at a credential path is left visible, being a pointer not a value', () => {
    const ref = 'goodvibes://secrets/goodvibes/GOODVIBES_EMAIL_PASSWORD_REF';
    const result = redactConfig(nest('email.passwordRef', ref));
    expect(JSON.stringify(result.value)).toContain(ref);
    expect(result.redactedPaths).toHaveLength(0);
  });

  test('every path this product routes through the secret manager is sensitive without restating it', async () => {
    const { SECRET_CONFIG_KEYS } = await import('../../config/secret-config.ts');
    for (const key of SECRET_CONFIG_KEYS) {
      expect(isSensitiveConfigPath(key as unknown as string)).toBe(true);
    }
  });
});

describe('model-provider credentials in bundle TEXT', () => {
  test('a provider API key in an environment-assignment line is masked', () => {
    for (const line of [
      'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      'GEMINI_API_KEY=AIzaSyAbcdefghijklmnopqrstuvwxyz0123456',
      'DEEPSEEK_API_KEY=some-long-provider-credential-value',
    ]) {
      const masked = redactText(line);
      expect(masked).toContain(REDACTED_VALUE);
      expect(masked).not.toContain(line.split('=')[1]);
    }
  });

  test('a bare provider-shaped credential in prose is masked', () => {
    const masked = redactText('the run failed while using sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 as auth');
    expect(masked).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
    expect(masked).toContain(REDACTED_VALUE);
  });
});
