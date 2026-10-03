/**
 * Finishing a Google connection from inside the conversation.
 *
 * The defect these close: the guided walkthrough sent the owner to a Google
 * console dialog, told him to copy a client id and a client secret, and then
 * had nothing to do with them. Its only possible ending was "now go and type
 * /google client <id> <secret>", a chore handed over at the exact moment the
 * platform held everything it needed. The string was the symptom; the missing
 * capability was that the `google` TOOL had no action that could register
 * pasted values, so the model could not act on them either.
 *
 * So the load-bearing assertions here are: two pasted values register and come
 * back with a consent link in the SAME reply, a named path does the same, and
 * the secret never appears in anything anyone could read afterwards.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeProjectTempDir } from '../helpers/project-temp.ts';

import { createAgentGoogleTool } from '../../tools/agent-google-tool.ts';
import {
  GOOGLE_CONFIG_KEYS,
  GOOGLE_SECRET_KEYS,
  type LoopbackListener,
} from '@goodvibes-jev/engine/sdk/platform/google';

const CLIENT_ID = '918273645500-abcdefghijklmnop.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-thisIsTheSecretValue';

/** Swept by the shared helper, so no scratch directory outlives the run. */
function tempRoot(): string {
  return makeProjectTempDir('google-connect');
}

/**
 * The tool over writable stores.
 *
 * `waitForever` is the default because that is what a real consent does: the
 * listener sits bound until a person visits the link. A test that let it
 * resolve immediately would not prove the reply does not wait for it.
 */
function toolRig(options: { readonly waitForever?: boolean; readonly config?: Record<string, unknown> } = {}) {
  const config: Record<string, unknown> = { ...options.config };
  const secrets: Record<string, string> = {};
  let listenerClosed = 0;

  const tool = createAgentGoogleTool({
    homeDirectory: tempRoot(),
    configGet: (key: string) => config[key],
    secretGet: async (key: string) => secrets[key] ?? null,
    configSet: (key: string, value: unknown) => { config[key] = value; },
    secretSet: async (key: string, value: string) => { secrets[key] = value; },
    loopback: (): LoopbackListener => ({
      redirectUri: 'http://127.0.0.1:41234/',
      waitForCode: async () => {
        if (options.waitForever !== false) await new Promise<never>(() => {});
        return { code: 'code-1', state: 'state' };
      },
      close: () => { listenerClosed += 1; },
    }),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ access_token: 'at', refresh_token: 'rt-1', expires_in: 3600, scope: '', token_type: 'Bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });

  return { tool, config, secrets, closed: () => listenerClosed };
}

function run(tool: ReturnType<typeof createAgentGoogleTool>, args: Record<string, unknown>) {
  return tool.execute(args) as Promise<{ success: boolean; output?: string; error?: string }>;
}

describe('the tool can finish what the walkthrough started', () => {
  test('connect.client is an action the model can actually call', () => {
    const { tool } = toolRig();
    const parameters = tool.definition.parameters as { properties: Record<string, { enum?: string[] }> };
    expect(parameters.properties.action.enum).toContain('connect.client');
    expect(parameters.properties.action.enum).toContain('connect.clientFile');
  });

  test('two pasted values register and the consent link comes back in the same reply', async () => {
    const rig = toolRig();
    const result = await run(rig.tool, {
      action: 'connect.client',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(result.success).toBe(true);
    // Registered...
    expect(rig.config[GOOGLE_CONFIG_KEYS.oauthClientId]).toBe(CLIENT_ID);
    expect(rig.secrets[GOOGLE_SECRET_KEYS.oauthClientSecret]).toBe(CLIENT_SECRET);
    // ...and continued, without a second round trip.
    expect(result.output).toContain('https://accounts.google.com/o/oauth2/v2/auth');
  });

  test('the reply does not wait for the person to approve', async () => {
    // The listener in this rig never resolves. If the action awaited consent,
    // this test would hang rather than fail, which is exactly what a turn
    // that blocked on a consent screen would do to a conversation.
    const rig = toolRig();
    const answered = await Promise.race([
      run(rig.tool, { action: 'connect.client', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      new Promise<'timed-out'>((resolve) => { setTimeout(() => resolve('timed-out'), 2_000); }),
    ]);
    expect(answered).not.toBe('timed-out');
  });

  test('the secret is never echoed back, in any form', async () => {
    const rig = toolRig();
    const result = await run(rig.tool, {
      action: 'connect.client',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain(CLIENT_SECRET);
    // Confirmation is by the id's tail, which identifies the client without
    // reproducing anything worth stealing.
    expect(result.output).toContain(CLIENT_ID.slice(-12));
  });

  test('it names the account to approve as, when config knows one', async () => {
    const rig = toolRig({ config: { 'email.username': 'agent@example.com' } });
    const result = await run(rig.tool, {
      action: 'connect.client',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(result.output).toContain('agent@example.com');
    expect(result.output).toContain('login_hint=agent%40example.com');
  });

  test('no confirm:true is demanded for values the user just handed over', async () => {
    // The confirm gate guards things that LEAVE this machine. A credential
    // write is a local store of what the owner pasted this turn, and asking
    // him to confirm it is the second question the zero-friction rule deletes.
    const rig = toolRig();
    const result = await run(rig.tool, {
      action: 'connect.client',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(result.success).toBe(true);
    expect(result.error ?? '').not.toContain('confirm:true');
  });

  test('a missing half is refused before anything is stored', async () => {
    const rig = toolRig();
    const result = await run(rig.tool, { action: 'connect.client', clientId: CLIENT_ID });
    expect(result.success).toBe(false);
    expect(Object.keys(rig.secrets)).toEqual([]);
  });
});

describe('a path the user named', () => {
  function clientJsonAt(root: string): string {
    const dir = join(root, 'downloads');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'client.json');
    writeFileSync(path, JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } }));
    return path;
  }

  test('connect.clientFile reads it, registers it and returns the consent link', async () => {
    const rig = toolRig();
    const path = clientJsonAt(tempRoot());

    const result = await run(rig.tool, { action: 'connect.clientFile', path });

    expect(result.success).toBe(true);
    expect(rig.config[GOOGLE_CONFIG_KEYS.oauthClientId]).toBe(CLIENT_ID);
    expect(rig.secrets[GOOGLE_SECRET_KEYS.oauthClientSecret]).toBe(CLIENT_SECRET);
    expect(result.output).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });

  test('a path with nothing at it says so plainly and asks for the right one', async () => {
    const rig = toolRig();
    const result = await run(rig.tool, { action: 'connect.clientFile', path: join(tempRoot(), 'absent.json') });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no readable file');
    expect(Object.keys(rig.secrets)).toEqual([]);
  });

  test('a file that is not a client JSON is refused rather than half-stored', async () => {
    const rig = toolRig();
    const root = tempRoot();
    const path = join(root, 'wrong.json');
    writeFileSync(path, JSON.stringify({ refresh_token: 'not-a-client' }));

    const result = await run(rig.tool, { action: 'connect.clientFile', path });
    expect(result.success).toBe(false);
    expect(Object.keys(rig.secrets)).toEqual([]);
  });
});

describe('a surface with no writable store', () => {
  test('says so rather than reporting a registration it did not perform', async () => {
    // The same rule the approval path follows: a missing mechanism is stated,
    // never papered over with an invented remedy.
    const tool = createAgentGoogleTool({
      homeDirectory: tempRoot(),
      configGet: () => undefined,
      secretGet: async () => null,
    });
    const result = await run(tool, {
      action: 'connect.client',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('were not stored anywhere');
  });
});
