/**
 * cli-redaction.test.ts
 *
 * A support bundle is a file an owner emails to someone. Filing a credential
 * in the right store buys nothing if the diagnostic dump then prints it.
 *
 * The bug class this pins: `isSensitiveConfigPath` once matched a config path
 * by its trailing WORD, so a key whose last segment merely CONTAINS the word,
 * `caldavPassword`, `imapPassword`, `appPassword`, `authToken`, was written to
 * the bundle in the clear. Schema keys are now answered by the platform's
 * declared secret-bearing list and every other path by the
 * `config.credential-key` reading (faked here); these tests keep both paths
 * honest as keys are added.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  REDACTED_VALUE,
  collectSensitiveConfigValues,
  isSensitiveConfigPath,
  redactConfig,
  redactSerializedSecrets,
  redactText,
} from '@goodvibes-jev/engine/terminal-shell';


/** Every credential-bearing config path a front-end's own config surface can hold. */
const CREDENTIAL_PATHS: readonly string[] = [
  // Mail and calendar, the ones that used to slip through entirely.
  'surfaces.email.password',
  'surfaces.email.imapPassword',
  'surfaces.email.imap.password',
  'surfaces.email.smtp.password',
  'surfaces.calendar.caldavPassword',
  // Telephony.
  'surfaces.telephony.authToken',
  'surfaces.telephony.token',
  'surfaces.telephony.webhookSecret',
  // Chat/notification surfaces.
  'surfaces.slack.botToken',
  'surfaces.slack.appToken',
  'surfaces.slack.signingSecret',
  'surfaces.discord.botToken',
  'surfaces.telegram.botToken',
  'surfaces.telegram.webhookSecret',
  'surfaces.ntfy.token',
  'surfaces.webhook.secret',
  'surfaces.matrix.accessToken',
  'surfaces.mattermost.botToken',
  'surfaces.whatsapp.accessToken',
  'surfaces.whatsapp.verifyToken',
  'surfaces.whatsapp.signingSecret',
  'surfaces.msteams.appPassword',
  'surfaces.bluebubbles.password',
  'surfaces.imessage.token',
  'surfaces.signal.token',
  'surfaces.homeassistant.accessToken',
  'surfaces.homeassistant.webhookSecret',
  'surfaces.googleChat.verificationToken',
  'cluster.secret',
  // Cloudflare token references (backstop, these normally hold a ref).
  'cloudflare.apiTokenRef',
  'cloudflare.tunnelTokenRef',
  'cloudflare.accessServiceTokenRef',
  'cloudflare.workerTokenRef',
  'cloudflare.workerClientTokenRef',
  // Provider API keys.
  'providers.acme.apiKey',
];

/** The four names the old trailing-word pattern is provably blind to. */
const MIDDLE_WORD_PATHS: readonly string[] = [
  'surfaces.calendar.caldavPassword',
  'surfaces.email.imapPassword',
  'surfaces.msteams.appPassword',
  'surfaces.telephony.authToken',
];

/** Stand-in for the model on the paths these tests use: a key naming a credential is one. */
let answer: (key: string) => number = (key) => (/password|token|secret|apikey|card|cvv/i.test(key) ? 0.97 : 0.03);
let asked: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => {
  asked = [];
  answer = (key) => (/password|token|secret|apikey|card|cvv/i.test(key) ? 0.97 : 0.03);
  previous = installJudgmentPort(fakePort((_name, _question, state) => {
    const key = (state as { key: string }).key;
    asked.push(key);
    return noulAnswer(answer(key));
  }).port);
});
afterEach(() => {
  installJudgmentPort(previous);
});

function nest(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
  return root;
}

describe('isSensitiveConfigPath', () => {
  test('recognises every credential-bearing config path', async () => {
    const missed: string[] = [];
    for (const path of CREDENTIAL_PATHS) if (!(await isSensitiveConfigPath(path))) missed.push(path);
    expect(missed).toEqual([]);
  });

  test('names carrying the credential word in the middle are recognised, not just trailing ones', async () => {
    for (const path of MIDDLE_WORD_PATHS) {
      expect(await isSensitiveConfigPath(path)).toBe(true);
    }
  });

  test('ordinary settings are left alone', async () => {
    for (const path of [
      'surfaces.email.host',
      'surfaces.email.imapHost',
      'surfaces.email.imapPort',
      'surfaces.calendar.caldavUrl',
      'surfaces.calendar.caldavUser',
      'display.themeMode',
      'planner.tokenCeiling',
      'display.showTokenSpeed',
      'cloudflare.accountId',
      'cloudflare.zoneName',
    ]) {
      expect(await isSensitiveConfigPath(path)).toBe(false);
    }
  });
});

describe('redactConfig', () => {
  test('masks every credential value and reports the path it masked', async () => {
    for (const path of CREDENTIAL_PATHS) {
      const secret = `live-value-for-${path}`;
      const result = await redactConfig(nest(path, secret));
      expect(result.redactedPaths).toContain(path);
      expect(JSON.stringify(result.value)).not.toContain(secret);
      expect(JSON.stringify(result.value)).toContain(REDACTED_VALUE);
    }
  });

  test('the mail and calendar passwords the owner configures are masked', async () => {
    const config = {
      surfaces: {
        email: {
          host: 'imap.example.com',
          user: 'someone@example.com',
          password: 'mailbox-pw',
          imapPassword: 'imap-pw',
          imap: { host: 'imap.example.com', password: 'imap-nested-pw' },
          smtp: { password: 'smtp-pw' },
        },
        calendar: {
          caldavUrl: 'https://dav.example.com/',
          caldavUser: 'someone@example.com',
          caldavPassword: 'caldav-pw',
        },
      },
    };
    const result = await redactConfig(config);
    const serialized = JSON.stringify(result.value);
    for (const secret of ['mailbox-pw', 'imap-pw', 'imap-nested-pw', 'smtp-pw', 'caldav-pw']) {
      expect(serialized).not.toContain(secret);
    }
    // Non-credential neighbours survive, a bundle that redacts the hostname is
    // useless for diagnosing a connection.
    expect(serialized).toContain('imap.example.com');
    expect(serialized).toContain('someone@example.com');
    expect([...result.redactedPaths].sort()).toEqual([
      'surfaces.calendar.caldavPassword',
      'surfaces.email.imap.password',
      'surfaces.email.imapPassword',
      'surfaces.email.password',
      'surfaces.email.smtp.password',
    ].sort());
  });

  test('a goodvibes:// secret reference is left readable: it is a pointer, not a value', async () => {
    const result = await redactConfig(nest(
      'surfaces.email.password',
      'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_EMAIL_PASSWORD',
    ));
    expect(result.redactedPaths).toEqual([]);
    expect(JSON.stringify(result.value)).toContain('GOODVIBES_SURFACES_EMAIL_PASSWORD');
  });

  test('an empty credential is not reported as redacted', async () => {
    expect((await redactConfig(nest('surfaces.calendar.caldavPassword', ''))).redactedPaths).toEqual([]);
  });
});

describe('collectSensitiveConfigValues', () => {
  test('collects the middle-word credential values so the serialized bundle can be swept', async () => {
    const config = {
      surfaces: {
        calendar: { caldavPassword: 'caldav-pw' },
        email: { imapPassword: 'imap-pw' },
        msteams: { appPassword: 'teams-pw' },
        telephony: { authToken: 'twilio-token' },
      },
    };
    expect([...(await collectSensitiveConfigValues(config))].sort())
      .toEqual(['caldav-pw', 'imap-pw', 'teams-pw', 'twilio-token']);
  });
});

describe('redactSerializedSecrets', () => {
  test('sweeps a credential out of a diagnostic blob it was copied into', async () => {
    const config = { surfaces: { calendar: { caldavPassword: 'caldav-pw-9times' } } };
    const values = await collectSensitiveConfigValues(config);
    const blob = JSON.stringify({
      config,
      diagnostics: { logTail: 'CalDAV auth failed for principal using caldav-pw-9times' },
    });
    const swept = redactSerializedSecrets(blob, values);
    expect(swept).not.toContain('caldav-pw-9times');
    expect(swept).toContain(REDACTED_VALUE);
  });
});

describe('redactText', () => {
  test('masks assignment and colon forms in a log tail', () => {
    expect(redactText('imap password=hunter2 rejected')).not.toContain('hunter2');
    expect(redactText('api_key: sk-live-abcdefgh')).not.toContain('sk-live-abcdefgh');
    expect(redactText('access_token=ya29.a0Af')).not.toContain('ya29.a0Af');
  });

  test('does not fire on ordinary words that merely end in the keyword letters', () => {
    expect(redactText('monkey=banana')).toContain('banana');
    expect(redactText('donkey=grey')).toContain('grey');
  });

  test('still masks the vendor-shaped literals', () => {
    expect(redactText('found sk-abcdefghijklmnopqrst in the log')).not.toContain('sk-abcdefghijklmnopqrst');
    expect(redactText('bot xoxb-1234567890-abcdefghij here')).not.toContain('xoxb-1234567890-abcdefghij');
  });
});

describe('a support bundle never carries card material', () => {
  /**
   * The defect this pins, in its exact original form: the redactor keyed on a
   * naming habit, a trailing `password`/`token`/`secret`, and `cardNumber`,
   * `cardExpiry` and `cardholderName` end in none of them. Four card fields
   * matched nothing and would have gone into a support bundle in the clear.
   *
   * The cure is that they are DECLARED, not that a second regex was bolted on
   * beside the first. These tests assert the outcome, so a merge that takes one
   * product's list wholesale in place of another's fails here rather than
   * silently dropping whatever the winner omits.
   */
  const CARD_CONFIG = {
    payments: {
      cardNumber: '4111111111111111',
      cardExpiry: '12/29',
      cardCvv: '123',
      cardholderName: 'A Chen',
      currency: 'USD',
    },
  };

  test('every card field is redacted out of a bundled config', async () => {
    const { value } = await redactConfig(CARD_CONFIG);
    const payments = value.payments;
    expect(payments.cardNumber).toBe(REDACTED_VALUE);
    expect(payments.cardExpiry).toBe(REDACTED_VALUE);
    expect(payments.cardCvv).toBe(REDACTED_VALUE);
    expect(payments.cardholderName).toBe(REDACTED_VALUE);
  });

  test('the card number never survives anywhere in the serialised bundle', async () => {
    const { value } = await redactConfig(CARD_CONFIG);
    expect(JSON.stringify(value)).not.toContain('4111111111111111');
    expect(JSON.stringify(value)).not.toContain('A Chen');
  });

  test('an ordinary payments setting is left alone, so this is not blanket masking', async () => {
    const { value } = await redactConfig(CARD_CONFIG);
    expect(value.payments.currency).toBe('USD');
  });

  test('each card field is recognised individually', async () => {
    for (const path of ['payments.cardNumber', 'payments.cardExpiry', 'payments.cardCvv', 'payments.cardholderName']) {
      expect(await isSensitiveConfigPath(path)).toBe(true);
      // ...and case-insensitively, because the lookup lowercases.
      expect(await isSensitiveConfigPath(path.toUpperCase())).toBe(true);
    }
  });
});


describe('which paths are read, and what the code does with the reading', () => {
  test('a schema key is answered by the declaration and asks nothing', async () => {
    expect(await isSensitiveConfigPath('surfaces.email.password')).toBe(true);
    expect(await isSensitiveConfigPath('display.themeMode')).toBe(false);
    expect(asked).toEqual([]);
  });

  test('a path outside the schema is read, and only a confident no leaves it in the clear', async () => {
    answer = () => 0.5;
    expect(await isSensitiveConfigPath('mcp.servers.github.env.UNSURE_SETTING')).toBe(true);
    answer = () => 0.03;
    expect(await isSensitiveConfigPath('mcp.servers.fs.args.0')).toBe(false);
    expect(asked).toEqual(['mcp.servers.github.env.UNSURE_SETTING', 'mcp.servers.fs.args.0']);
  });

  test('a user-named env key under an MCP server is masked when read as a credential', async () => {
    const result = await redactConfig({ mcp: { servers: { github: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'ghp-live' } } } } });
    expect(result.redactedPaths).toContain('mcp.servers.github.env.GITHUB_TOKEN');
    expect(JSON.stringify(result.value)).not.toContain('ghp-live');
    expect(JSON.stringify(result.value)).toContain('gh-mcp');
  });
});
