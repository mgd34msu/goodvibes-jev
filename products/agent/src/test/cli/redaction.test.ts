import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { isSensitiveConfigPath, REDACTED_VALUE, redactConfig, redactText } from '@goodvibes-jev/engine/terminal-shell';
import { cliRedactionAnswer } from '../helpers/cli-redaction-readings.ts';

const REDACTED_TEXT = '[REDACTED]';

const credentialPaths = new Set(['token', 'payments.cardNumber', 'payments.cardExpiry', 'payments.cardCvv', 'payments.cardholderName',
  'calendar.google.icsUrl', 'surfaces.googleChat.webhookUrl', 'cluster.secret']);
const safePaths = new Set(['display.theme', 'payments.currency', 'behavior.autoApprove', ...[...credentialPaths, 'display.theme', 'behavior.autoApprove']
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

describe('redactText', () => {
  it('redacts assignment-form sensitive keywords', async () => {
    expect(await redactText('token=abc123xyz')).toBe(`token=${REDACTED_TEXT}`);
    expect(await redactText('api_key=sk-abc123')).toBe('api_key=[REDACTED_API_KEY]');
    expect(await redactText('api-key=sk-abc123')).toBe('api-key=[REDACTED_API_KEY]');
    expect(await redactText('secret=my-secret')).toBe(`secret=${REDACTED_TEXT}`);
    expect(await redactText('password=hunter2')).toBe(`password=${REDACTED_TEXT}`);
    expect(await redactText('access_token=eyJhbGci')).toBe(`access_token=${REDACTED_TEXT}`);
  });

  it('redacts colon-form sensitive keywords', async () => {
    expect(await redactText('token: abc123xyz')).toBe(`token: ${REDACTED_TEXT}`);
    expect(await redactText('api_key: sk-abc123')).toBe('api_key: [REDACTED_API_KEY]');
    expect(await redactText('secret: my-secret')).toBe(`secret: ${REDACTED_TEXT}`);
    expect(await redactText('password: hunter2')).toBe(`password: ${REDACTED_TEXT}`);
  });

  it('does NOT redact false-positive keyword substrings (monkey=, donkey=, keyboard=)', async () => {
    expect(await redactText('monkey=foo')).toBe('monkey=foo');
    expect(await redactText('donkey=bar')).toBe('donkey=bar');
    expect(await redactText('keyboard=qwerty')).toBe('keyboard=qwerty');
    expect(await redactText('hotkey=ctrl+s')).toBe('hotkey=ctrl+s');
  });

  it('redacts token that starts at a word boundary without preceding letter', async () => {
    // e.g. in a query string or log line
    expect(await redactText('?token=abc&other=val')).toContain(REDACTED_TEXT);
    expect(await redactText('?token=abc&other=val')).not.toContain('abc');
  });

  it('does not disturb text without sensitive keywords', async () => {
    const safe = 'hello world, status=ok, count=42';
    expect(await redactText(safe)).toBe(safe);
  });
});

describe('shouldRedactValue (via redactConfig)', () => {
  // Redaction rule: on a sensitive path, redact non-empty strings (not goodvibes:// refs),
  // and truthy non-string values. Do NOT redact false, 0, null, undefined, or empty string.
  it('redacts a non-empty string value on a sensitive path', async () => {
    const { value } = await redactConfig({ token: 'abc123' });
    expect((value as { token: unknown }).token).toBe(REDACTED_VALUE);
  });

  it('does not redact false on a sensitive path (falsy non-string)', async () => {
    const { value } = await redactConfig({ token: false });
    expect((value as { token: unknown }).token).toBe(false);
  });

  it('does not redact 0 on a sensitive path (falsy non-string)', async () => {
    const { value } = await redactConfig({ token: 0 });
    expect((value as { token: unknown }).token).toBe(0);
  });

  it('does not redact empty string on a sensitive path', async () => {
    const { value } = await redactConfig({ token: '' });
    expect((value as { token: unknown }).token).toBe('');
  });

  it('redacts a truthy number on a sensitive path', async () => {
    // Non-zero numbers on sensitive paths are redacted (truthy non-string).
    // Rationale: a numeric token/port stored as number under a secret key is a real secret.
    // await isSensitiveConfigPath('.token') => true; value is 4242 (truthy) => redacted.
    const { value } = await redactConfig({ token: 4242 });
    expect((value as { token: unknown }).token).toBe(REDACTED_VALUE);
  });
});

describe('declared credential fields use the shared redactor', () => {
  const CARD_FIELDS = ['payments.cardNumber', 'payments.cardExpiry', 'payments.cardCvv', 'payments.cardholderName'];

  it('the four card fields are still redacted after the merge', async () => {
    for (const path of CARD_FIELDS) {
      expect(await isSensitiveConfigPath(path)).toBe(true);
    }
  });

  it('credentials whose names fit no suffix habit are redacted too', async () => {
    // Each of these ends in a word the suffix list does not know, and each is a
    // credential. They are covered because they are declared.
    for (const path of ['calendar.google.icsUrl', 'surfaces.googleChat.webhookUrl', 'cluster.secret']) {
      expect(await isSensitiveConfigPath(path)).toBe(true);
    }
  });

  it('an ordinary setting is still not redacted', async () => {
    // Deliberately not spelling a `surfaces.email.*` or `surfaces.calendar.*`
    // key here: settings-consumed-keys.test.ts counts a key as consumed by this
    // repo when any source line names it, and a negative assertion naming one
    // would make this file look like its consumer.
    for (const path of ['display.theme', 'payments.currency', 'behavior.autoApprove']) {
      expect(await isSensitiveConfigPath(path)).toBe(false);
    }
  });
});

describe('a support bundle never carries card material', () => {
  const CARD_CONFIG = {
    payments: {
      cardNumber: '4111111111111111',
      cardExpiry: '12/29',
      cardCvv: '123',
      cardholderName: 'M Davis',
      currency: 'USD',
    },
  };

  it('every card field is redacted out of a bundled config', async () => {
    const { value } = await redactConfig(CARD_CONFIG);
    expect(value).toEqual({ payments: {
      cardNumber: REDACTED_VALUE,
      cardExpiry: REDACTED_VALUE,
      cardCvv: REDACTED_VALUE,
      cardholderName: REDACTED_VALUE,
      currency: 'USD',
    } });
  });

  it('the card number never survives anywhere in the serialised bundle', async () => {
    const { value } = await redactConfig(CARD_CONFIG);
    expect(JSON.stringify(value)).not.toContain('4111111111111111');
    expect(JSON.stringify(value)).not.toContain('M Davis');
  });

  it('an ordinary payments setting is left alone, so this is not blanket masking', async () => {
    const { value } = await redactConfig(CARD_CONFIG);
    expect(value).toMatchObject({ payments: { currency: 'USD' } });
  });
});
