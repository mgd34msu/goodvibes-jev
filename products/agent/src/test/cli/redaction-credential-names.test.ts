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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { SECRET_CONFIG_KEYS } from '../../config/secret-config.ts';
import { REDACTED_VALUE, isSensitiveConfigPath, redactConfig, redactText, redactSerializedSecrets } from '@goodvibes-jev/engine/terminal-shell';
import { registerAccountIdentityRedaction } from '@goodvibes-jev/engine/sdk/platform/utils';
import { cliRedactionAnswer } from '../helpers/cli-redaction-readings.ts';

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
];

/**
 * Settings whose name mentions a credential word but whose VALUE is a number, a
 * boolean or an identifier. Redacting these would hide the thing being
 * diagnosed while protecting nothing.
 */
const MUST_NOT_REDACT_PATHS: readonly string[] = [
  'controlPlane.tls.keyFile',
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

const credentialPaths = new Set([...CREDENTIAL_PATHS, ...ALREADY_COVERED_PATHS, ...SECRET_CONFIG_KEYS]);
const safePaths = new Set([...MUST_NOT_REDACT_PATHS, ...[...credentialPaths, ...MUST_NOT_REDACT_PATHS]
  .flatMap(path => path.split('.').slice(0, -1).map((_, index) => path.split('.').slice(0, index + 1).join('.')))]);
let previous: JudgmentPort | undefined;
beforeEach(() => {
  previous = installJudgmentPort(fakePort((name, question, state) => {
    if (name !== 'credential') return cliRedactionAnswer(name, question, state);
    const key = (state as { key: string }).key;
    return noulAnswer(credentialPaths.has(key) ? 0.99 : safePaths.has(key) ? 0.01 : 0.5);
  }).port);
});
afterEach(() => { installJudgmentPort(previous); });

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
    test(`${path} is treated as sensitive`, async () => {
      expect(await isSensitiveConfigPath(path)).toBe(true);
    });

    test(`a literal stored at ${path} never reaches the bundle`, async () => {
      const result = await redactConfig(nest(path, 'the-literal-credential-value'));
      expect(JSON.stringify(result.value)).not.toContain('the-literal-credential-value');
      expect(JSON.stringify(result.value)).toContain(REDACTED_VALUE);
      expect(result.redactedPaths).toContain(path);
    });
  }

  for (const path of ALREADY_COVERED_PATHS) {
    test(`${path} stays sensitive`, async () => {
      expect(await isSensitiveConfigPath(path)).toBe(true);
    });
  }

  for (const path of MUST_NOT_REDACT_PATHS) {
    test(`${path} is left readable`, async () => {
      expect(await isSensitiveConfigPath(path)).toBe(false);
      const result = await redactConfig(nest(path, 42));
      expect(result.redactedPaths).toHaveLength(0);
    });
  }

  test('a goodvibes:// reference at a credential path is left visible, being a pointer not a value', async () => {
    const ref = 'goodvibes://secrets/goodvibes/GOODVIBES_EMAIL_PASSWORD_REF';
    const result = await redactConfig(nest('email.passwordRef', ref));
    expect(JSON.stringify(result.value)).toContain(ref);
    expect(result.redactedPaths).toHaveLength(0);
  });

  test('inline private material under a path-typed field stays out of serialized export and wire', async () => {
    const privatePem = '-----BEGIN PRIVATE KEY-----\nSyntheticPrivateMaterialAbcdef0123456789+/=\n-----END PRIVATE KEY-----';
    const fake = fakePort((name, question, state) => {
      if (name === 'kind') {
        const field = state !== null && typeof state === 'object' && 'field' in state ? state.field : undefined;
        return choiceAnswer(question, 'other', ['controlPlane', 'tls', 'keyFile'].includes(String(field)) ? 0.99 : 0.5);
      }
      throw new Error('Unexpected inline-private-material reading.');
    });
    installJudgmentPort(fake.port);
    const serialized = await redactSerializedSecrets(JSON.stringify(nest('controlPlane.tls.keyFile', privatePem)), []);
    expect(serialized).not.toContain('SyntheticPrivateMaterial');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).toContain('[REDACTED]');
    expect(JSON.stringify(fake.requests)).not.toContain('SyntheticPrivateMaterial');
    expect(JSON.stringify(fake.requests)).not.toContain('BEGIN PRIVATE KEY');
  });

  test('a readable TLS path still conceals account identity before export or wire', async () => {
    const dispose = registerAccountIdentityRedaction(() => ({ homeDirectory: '/home/fixture-private-owner', userName: 'fixture-private-owner' }));
    const publicPath = '/home/[REDACTED]/server-key.pem';
    const fake = fakePort((name, question, state) => {
      if (name === 'kind') {
        const field = state !== null && typeof state === 'object' && 'field' in state ? state.field : undefined;
        return choiceAnswer(question, 'other', ['controlPlane', 'tls', 'keyFile'].includes(String(field)) ? 0.99 : 0.5);
      }
      if (name === 'lineHasCredential' || name === 'spanIsCredential') {
        const parts = state !== null && typeof state === 'object' && 'parts' in state && Array.isArray(state.parts) ? state.parts : [];
        return noulAnswer(JSON.stringify(parts) === JSON.stringify([{ kind: 'text', text: publicPath }]) ? 0.01 : 0.5);
      }
      throw new Error('Unexpected account-path export reading.');
    });
    installJudgmentPort(fake.port);
    try {
      expect(await isSensitiveConfigPath('controlPlane.tls.keyFile')).toBe(false);
      const serialized = await redactSerializedSecrets(JSON.stringify(nest('controlPlane.tls.keyFile', '/home/fixture-private-owner/server-key.pem')), []);
      expect(serialized).toContain(publicPath);
      expect(serialized).not.toContain('fixture-private-owner');
      expect(JSON.stringify(fake.requests)).not.toContain('fixture-private-owner');
    } finally { dispose(); }
  });

  test('every path this product routes through the secret manager is sensitive without restating it', async () => {
    const { SECRET_CONFIG_KEYS } = await import('../../config/secret-config.ts');
    for (const key of SECRET_CONFIG_KEYS) {
      expect(await isSensitiveConfigPath(key as unknown as string)).toBe(true);
    }
  });
});

describe('model-provider credentials in bundle TEXT', () => {
  test('a provider API key in an environment-assignment line is masked', async () => {
    for (const line of [
      'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      'GEMINI_API_KEY=AIzaSyAbcdefghijklmnopqrstuvwxyz0123456',
      'DEEPSEEK_API_KEY=some-long-provider-credential-value',
    ]) {
      const masked = await redactText(line);
      expect(masked).toMatch(/\[REDACTED(?:_API_KEY)?\]/);
      expect(masked).not.toContain(line.split('=')[1]);
    }
  });

  test('a bare provider-shaped credential in prose is masked', async () => {
    const masked = await redactText('the run failed while using sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 as auth');
    expect(masked).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
    expect(masked).toContain('[REDACTED_API_KEY]');
  });
});
