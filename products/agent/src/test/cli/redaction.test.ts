import { describe, expect, it } from 'bun:test';
import { isSensitiveConfigPath, REDACTED_VALUE, redactConfig, redactText } from '../../cli/redaction.ts';

describe('redactText', () => {
  it('redacts assignment-form sensitive keywords', () => {
    expect(redactText('token=abc123xyz')).toBe(`token=${REDACTED_VALUE}`);
    expect(redactText('api_key=sk-abc123')).toBe(`api_key=${REDACTED_VALUE}`);
    expect(redactText('api-key=sk-abc123')).toBe(`api-key=${REDACTED_VALUE}`);
    expect(redactText('secret=my-secret')).toBe(`secret=${REDACTED_VALUE}`);
    expect(redactText('password=hunter2')).toBe(`password=${REDACTED_VALUE}`);
    expect(redactText('access_token=eyJhbGci')).toBe(`access_token=${REDACTED_VALUE}`);
  });

  it('redacts colon-form sensitive keywords', () => {
    expect(redactText('token: abc123xyz')).toBe(`token: ${REDACTED_VALUE}`);
    expect(redactText('api_key: sk-abc123')).toBe(`api_key: ${REDACTED_VALUE}`);
    expect(redactText('secret: my-secret')).toBe(`secret: ${REDACTED_VALUE}`);
    expect(redactText('password: hunter2')).toBe(`password: ${REDACTED_VALUE}`);
  });

  it('does NOT redact false-positive keyword substrings (monkey=, donkey=, keyboard=)', () => {
    expect(redactText('monkey=foo')).toBe('monkey=foo');
    expect(redactText('donkey=bar')).toBe('donkey=bar');
    expect(redactText('keyboard=qwerty')).toBe('keyboard=qwerty');
    expect(redactText('hotkey=ctrl+s')).toBe('hotkey=ctrl+s');
  });

  it('redacts token that starts at a word boundary without preceding letter', () => {
    // e.g. in a query string or log line
    expect(redactText('?token=abc&other=val')).toContain(REDACTED_VALUE);
    expect(redactText('?token=abc&other=val')).not.toContain('abc');
  });

  it('does not disturb text without sensitive keywords', () => {
    const safe = 'hello world, status=ok, count=42';
    expect(redactText(safe)).toBe(safe);
  });
});

describe('shouldRedactValue (via redactConfig)', () => {
  // Redaction rule: on a sensitive path, redact non-empty strings (not goodvibes:// refs),
  // and truthy non-string values. Do NOT redact false, 0, null, undefined, or empty string.
  it('redacts a non-empty string value on a sensitive path', () => {
    const { value } = redactConfig({ token: 'abc123' });
    expect((value as { token: unknown }).token).toBe(REDACTED_VALUE);
  });

  it('does not redact false on a sensitive path (falsy non-string)', () => {
    const { value } = redactConfig({ token: false });
    expect((value as { token: unknown }).token).toBe(false);
  });

  it('does not redact 0 on a sensitive path (falsy non-string)', () => {
    const { value } = redactConfig({ token: 0 });
    expect((value as { token: unknown }).token).toBe(0);
  });

  it('does not redact empty string on a sensitive path', () => {
    const { value } = redactConfig({ token: '' });
    expect((value as { token: unknown }).token).toBe('');
  });

  it('redacts a truthy number on a sensitive path', () => {
    // Non-zero numbers on sensitive paths are redacted (truthy non-string).
    // Rationale: a numeric token/port stored as number under a secret key is a real secret.
    // isSensitiveConfigPath('.token') => true; value is 4242 (truthy) => redacted.
    const { value } = redactConfig({ token: 4242 });
    expect((value as { token: unknown }).token).toBe(REDACTED_VALUE);
  });
});

describe('the merged redactor is the general one, not the narrow payments fix', () => {
  /**
   * A sibling round added a dedicated regex for exactly four card fields,
   * because none of their names ends in a word the suffix list knows. It was
   * right about the defect and narrow about the cure: the next credential whose
   * name does not fit the habit would need a third pattern.
   *
   * The declared set is the cure. These assertions fail if a merge ever takes
   * the narrow version instead.
   */
  const CARD_FIELDS = ['payments.cardNumber', 'payments.cardExpiry', 'payments.cardCvv', 'payments.cardholderName'];

  it('the four card fields are still redacted after the merge', () => {
    for (const path of CARD_FIELDS) {
      expect(isSensitiveConfigPath(path)).toBe(true);
    }
  });

  it('credentials whose names fit no suffix habit are redacted too', () => {
    // Each of these ends in a word the suffix list does not know, and each is a
    // credential. They are covered because they are declared.
    for (const path of ['calendar.google.icsUrl', 'surfaces.googleChat.webhookUrl', 'cluster.secret']) {
      expect(isSensitiveConfigPath(path)).toBe(true);
    }
  });

  it('an ordinary setting is still not redacted', () => {
    // Deliberately not spelling a `surfaces.email.*` or `surfaces.calendar.*`
    // key here: settings-consumed-keys.test.ts counts a key as consumed by this
    // repo when any source line names it, and a negative assertion naming one
    // would make this file look like its consumer.
    for (const path of ['display.theme', 'payments.currency', 'behavior.autoApprove']) {
      expect(isSensitiveConfigPath(path)).toBe(false);
    }
  });
});

describe('a support bundle never carries card material', () => {
  /**
   * The same assertion as the TUI's, deliberately duplicated rather than
   * shared: the two products keep separate redactor lists, and a test that
   * lived in only one of them would let the other drift back. The defect being
   * pinned is that the rule keyed on a naming habit, a trailing
   * `password`/`token`/`secret`, and `cardNumber`, `cardExpiry` and
   * `cardholderName` end in none of them.
   */
  const CARD_CONFIG = {
    payments: {
      cardNumber: '4111111111111111',
      cardExpiry: '12/29',
      cardCvv: '123',
      cardholderName: 'M Davis',
      currency: 'USD',
    },
  };

  it('every card field is redacted out of a bundled config', () => {
    const { value } = redactConfig(CARD_CONFIG);
    expect(value.payments.cardNumber).toBe(REDACTED_VALUE);
    expect(value.payments.cardExpiry).toBe(REDACTED_VALUE);
    expect(value.payments.cardCvv).toBe(REDACTED_VALUE);
    expect(value.payments.cardholderName).toBe(REDACTED_VALUE);
  });

  it('the card number never survives anywhere in the serialised bundle', () => {
    const { value } = redactConfig(CARD_CONFIG);
    expect(JSON.stringify(value)).not.toContain('4111111111111111');
    expect(JSON.stringify(value)).not.toContain('M Davis');
  });

  it('an ordinary payments setting is left alone, so this is not blanket masking', () => {
    const { value } = redactConfig(CARD_CONFIG);
    expect(value.payments.currency).toBe('USD');
  });
});
