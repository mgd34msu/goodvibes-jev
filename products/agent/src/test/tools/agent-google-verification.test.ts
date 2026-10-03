import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '@goodvibes-jev/engine/sdk/platform/google';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentGoogleTool } from '../../tools/agent-google-tool.ts';
import { getSessionExpectationBook, resetSessionExpectationBookForTests } from '../../agent/signup/session-expectations.ts';
import { resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * The correlation rule, exercised through the real tool.
 *
 * A verification mail is the one thing arriving by email that can yield
 * something actionable, and only because the agent provoked it. What decides a
 * match is the receiver-written Delivered-To header. `To:` is set by the
 * sender, so if it were accepted, anyone who guessed an open expectation's
 * alias could forge a header and have the agent follow their link.
 */

let home = '';
const ALIAS = 'owner+gv-example-com-abcd1234@example.com';


/**
 * The credential as a CONNECTED machine holds it: in the config and secret
 * stores, which is where adoption puts it.
 *
 * These tests used to write `~/.gmail-mcp` files and leave both stores empty,
 * because the resolver scanned that directory on every call. It no longer goes
 * looking, rummaging through a home directory for another tool's credential
 * files is not something to do unasked, so the state under test is the state
 * after adoption. The files are still written, unread, so a resolver that
 * quietly started scanning again would not make these pass for the wrong
 * reason.
 */
const STORED_CONFIG: Readonly<Record<string, unknown>> = {
  [GOOGLE_CONFIG_KEYS.oauthClientId]: 'x.apps.googleusercontent.com',
  [GOOGLE_CONFIG_KEYS.oauthClientSecretRef]: GOOGLE_CONFIG_KEYS.oauthClientSecretRef,
};

const STORED_SECRETS: Readonly<Record<string, string>> = {
  [GOOGLE_SECRET_KEYS.oauthClientSecret]: 's',
  [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'r',
};

const storedSecretGet = async (key: string): Promise<string | null> => STORED_SECRETS[key] ?? null;

function writeCredentials(root: string): void {
  const directory = join(root, '.gmail-mcp');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'gcp-oauth.keys.json'),
    JSON.stringify({ installed: { client_id: 'x.apps.googleusercontent.com', client_secret: 's' } }),
  );
  writeFileSync(
    join(directory, 'credentials.json'),
    JSON.stringify({ refresh_token: 'r', access_token: 'a', scope: 'https://mail.google.com/', expiry_date: 4102444800000 }),
  );
}

const VERIFICATION_BODY = 'Confirm here: https://example.com/verify?t=tok123';

/** A Gmail `messages.get` response with the headers this test is about. */
function gmailMessage(headers: readonly { name: string; value: string }[], body: string) {
  return {
    id: 'msg-1',
    threadId: 't-1',
    labelIds: [],
    snippet: '',
    payload: {
      mimeType: 'text/plain',
      headers,
      body: { data: Buffer.from(body).toString('base64url') },
      parts: [],
    },
  };
}

function toolWith(headers: readonly { name: string; value: string }[], body: string = VERIFICATION_BODY) {
  return createAgentGoogleTool({
    homeDirectory: home,
    configGet: (key: string) => STORED_CONFIG[key],
    secretGet: storedSecretGet,
    fetchImpl: async (url: string) =>
      new Response(
        JSON.stringify(url.includes('/messages/') ? gmailMessage(headers, body) : { access_token: 'a', expires_in: 3600, scope: 'https://mail.google.com/', token_type: 'Bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
}

function run(tool: ReturnType<typeof createAgentGoogleTool>, args: Record<string, unknown>) {
  return tool.execute(args) as Promise<{ success: boolean; output?: string; error?: string }>;
}

describe('reading a verification mail', () => {
  beforeEach(() => {
    home = makeProjectTempDir('google-verify');
    writeCredentials(home);
    resetSessionExpectationBookForTests();
    resetSessionUntrustedContentLedgerForTests();
    getSessionExpectationBook().openExpectation({
      serviceDomain: 'example.com',
      recipientAddress: ALIAS,
      purpose: 'signing up at example.com',
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    resetSessionExpectationBookForTests();
    resetSessionUntrustedContentLedgerForTests();
  });

  test('a message delivered to the minted alias yields its verification link', async () => {
    const tool = toolWith([
      { name: 'From', value: 'noreply@example.com' },
      { name: 'To', value: ALIAS },
      { name: 'Delivered-To', value: ALIAS },
    ]);

    const result = await run(tool, { action: 'mail.verification', id: 'msg-1' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('https://example.com/verify?t=tok123');
  });

  test('a forged To: header with no delivery evidence is refused', async () => {
    // Exactly the attack the branded type exists to prevent: the sender names
    // the open expectation's alias in a header they control.
    const tool = toolWith([
      { name: 'From', value: 'attacker@evil.test' },
      { name: 'To', value: ALIAS },
    ]);

    const result = await run(tool, { action: 'mail.verification', id: 'msg-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('no delivery evidence');
    expect(result.error).toContain('Nothing was extracted');
    expect(result.error).not.toContain('tok123');
  });

  test('a message delivered to a different address does not match', async () => {
    const tool = toolWith([
      { name: 'From', value: 'noreply@example.com' },
      { name: 'To', value: ALIAS },
      { name: 'Delivered-To', value: 'someone-else@example.com' },
    ]);

    const result = await run(tool, { action: 'mail.verification', id: 'msg-1' });

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('tok123');
  });

  test('a welcome note arriving first does not spend the window', async () => {
    // A signup provokes more than one mail at the alias, and the welcome note
    // usually beats the verification. If the match consumed the expectation,
    // this first message would close it and the real verification behind it
    // would then be refused as unsolicited.
    const headers = [
      { name: 'From', value: 'noreply@example.com' },
      { name: 'To', value: ALIAS },
      { name: 'Delivered-To', value: ALIAS },
    ];

    const welcome = await run(toolWith(headers, 'Welcome aboard. Nothing to do yet.'), {
      action: 'mail.verification',
      id: 'msg-1',
    });
    expect(welcome.success).toBe(false);
    expect(welcome.error).toContain('No verification link or code');
    expect(getSessionExpectationBook().list()).toHaveLength(1);

    const real = await run(toolWith(headers), { action: 'mail.verification', id: 'msg-1' });
    expect(real.success).toBe(true);
    expect(real.output).toContain('https://example.com/verify?t=tok123');
  });

  test('a link pointing at another host is refused without spending the window', async () => {
    // The shape of a forgery aimed at a guessed alias. Burning the expectation
    // on it would buy an attacker a denial of the real verification for the
    // price of one message.
    const headers = [
      { name: 'From', value: 'noreply@example.com' },
      { name: 'To', value: ALIAS },
      { name: 'Delivered-To', value: ALIAS },
    ];

    const forged = await run(toolWith(headers, 'Confirm here: https://evil.test/verify?t=tok123'), {
      action: 'mail.verification',
      id: 'msg-1',
    });
    expect(forged.success).toBe(false);
    expect(forged.error).toContain('evil.test');
    expect(getSessionExpectationBook().list()).toHaveLength(1);

    const real = await run(toolWith(headers), { action: 'mail.verification', id: 'msg-1' });
    expect(real.success).toBe(true);
    expect(real.output).toContain('https://example.com/verify?t=tok123');
  });

  test('once a token is handed over the expectation is closed', async () => {
    const headers = [
      { name: 'From', value: 'noreply@example.com' },
      { name: 'To', value: ALIAS },
      { name: 'Delivered-To', value: ALIAS },
    ];

    const first = await run(toolWith(headers), { action: 'mail.verification', id: 'msg-1' });
    expect(first.success).toBe(true);
    expect(getSessionExpectationBook().list()).toHaveLength(0);

    const replay = await run(toolWith(headers), { action: 'mail.verification', id: 'msg-1' });
    expect(replay.success).toBe(false);
    expect(replay.error).not.toContain('tok123');
  });

  test('with no expectation open, verification mail is not acted on at all', async () => {
    resetSessionExpectationBookForTests();
    const tool = toolWith([
      { name: 'From', value: 'noreply@example.com' },
      { name: 'Delivered-To', value: ALIAS },
    ]);

    const result = await run(tool, { action: 'mail.verification', id: 'msg-1' });

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('tok123');
  });
});
