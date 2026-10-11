import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, SecretsManager, secretReferenceFor } from '@goodvibes-jev/engine/sdk/platform/config';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS, type LoopbackListener } from '@goodvibes-jev/engine/sdk/platform/google';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { executeAdmitted } from '../helpers/admitted-tool.ts';
import { createAgentGoogleTool, agentGoogleInputProjector } from '../../tools/agent-google-tool.ts';
import { captureGoogleConnectionCurrent } from '../../runtime/bootstrap-google-tool.ts';

const CLIENT_ID = '918273645500-abcdefghijklmnop.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-thisIsTheSecretValue';

async function toolRig(options: { readonly approved?: boolean; readonly account?: string } = {}) {
  const root = makeProjectTempDir('google-connect');
  const config = new ConfigManager({ configDir: join(root, 'config'), homeDir: root, workingDir: root, surfaceRoot: 'agent', diagnosticMode: 'structural' });
  config.load();
  if (options.account) config.setDynamic('email.username', options.account);
  const secrets = new SecretsManager({ projectRoot: root, globalHome: root, surfaceRoot: 'agent', configManager: config, diagnosticMode: 'structural',
    secureProjectFilePath: join(root, 'project-secrets.enc'), plaintextProjectFilePath: join(root, 'project-secrets.json'),
    secureUserFilePath: join(root, 'user-secrets.enc'), plaintextUserFilePath: join(root, 'user-secrets.json') });
  await secrets.set(GOOGLE_SECRET_KEYS.oauthClientSecret, CLIENT_SECRET);
  let closed = 0;
  let afterRefresh: (() => void | Promise<void>) | undefined;
  const requests: string[] = [];
  const deps = { configManager: config, secretsManager: secrets, homeDirectory: root };
  const tool = createAgentGoogleTool({ ...deps,
    configGet: key => {
      let value: unknown = config.getRaw();
      for (const part of key.split('.')) value = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, part)?.value : undefined;
      return value;
    }, secretGet: key => secrets.get(key), captureConnectionCurrent: () => captureGoogleConnectionCurrent(deps),
    loopback: (): LoopbackListener => ({ redirectUri: 'http://127.0.0.1:41234/', waitForCode: async () => {
      if (!options.approved) await new Promise<never>(() => {});
      return { code: 'synthetic-code', state: 'synthetic-state' };
    }, close() { closed++; } }),
    fetchImpl: async url => {
      requests.push(url);
      if (url.includes('oauth2')) {
        await afterRefresh?.();
        return Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600,
          scope: 'https://mail.google.com/ https://www.googleapis.com/auth/calendar', token_type: 'Bearer' });
      }
      return Response.json({ id: 'synthetic-send', threadId: 'synthetic-thread' });
    },
  });
  const run = async (args: Record<string, unknown>, admission: Parameters<typeof executeAdmitted>[2] = {}) => {
    try {
      return await executeAdmitted(tool, args, { ...admission, directory: root, configManager: config, registration: { inputProjection: agentGoogleInputProjector(tool) } });
    }
    catch (error) { return { success: false, output: undefined, error: error instanceof Error ? error.message : 'Google input or authority held.' }; }
  };
  return { root, config, secrets, tool, run, requests, closed: () => closed,
    afterRefresh(callback: () => void | Promise<void>) { afterRefresh = callback; } };
}

function clientJsonAt(root: string) {
  const directory = join(root, 'downloads'); mkdirSync(directory, { recursive: true });
  const path = join(directory, 'client.json');
  writeFileSync(path, JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } }));
  return path;
}

describe('Google model credential setup uses native opaque plans', () => {
  test('stored credential reference registers and returns the consent link in the same reply', async () => {
    const rig = await toolRig();
    const result = await rig.run({ action: 'connect.client', clientId: CLIENT_ID, clientSecretRef: secretReferenceFor(GOOGLE_SECRET_KEYS.oauthClientSecret) });
    expect(result.error).toBeUndefined(); expect(result.success).toBe(true); expect(result.output).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(rig.config.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe(CLIENT_ID);
    expect(await rig.secrets.get(GOOGLE_SECRET_KEYS.oauthClientSecret)).toBe(CLIENT_SECRET);
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });
  test('does not wait for the OAuth consent screen and requires no model confirmation flags', async () => {
    const rig = await toolRig();
    const result = await rig.run({ action: 'connect.client', clientId: CLIENT_ID });
    expect(result.error).toBeUndefined(); expect(result.success).toBe(true); expect(result.output).toContain('connect.complete'); expect(rig.closed()).toBe(0);
  });
  test('names the configured account in the actual native consent URL', async () => {
    const rig = await toolRig({ account: 'agent@example.com' });
    const result = await rig.run({ action: 'connect.client', clientId: CLIENT_ID });
    expect(result.output).toContain('login_hint=agent%40example.com');
  });
  test('exact client JSON ingress prepares and stores the private credential', async () => {
    const rig = await toolRig(); const path = clientJsonAt(rig.root);
    const result = await rig.run({ action: 'connect.clientFile', path });
    expect(result.error).toBeUndefined(); expect(result.success).toBe(true); expect(result.output).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(await rig.secrets.get(GOOGLE_SECRET_KEYS.oauthClientSecret)).toBe(CLIENT_SECRET);
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });
  test('a completed protocol does not write a token from a retired tool invocation', async () => {
    const rig = await toolRig({ approved: true });
    expect((await rig.run({ action: 'connect.client', clientId: CLIENT_ID })).success).toBe(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await rig.secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBeNull();
    expect((await rig.run({ action: 'connect.complete' })).success).toBe(true);
    expect(await rig.secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe('synthetic-refresh-token');
    expect((await rig.run({ action: 'connect.complete' })).success).toBe(false);
  });
  test('raw flags cannot register or complete a client', async () => {
    const rig = await toolRig();
    await expect(rig.tool.execute({ action: 'connect.client', clientId: CLIENT_ID, confirm: true })).rejects.toThrow();
    expect(rig.config.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe('');
  });
  test('inline secret material is refused at the canonical model boundary', async () => {
    const rig = await toolRig();
    expect((await rig.run({ action: 'connect.client', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })).success).toBe(false);
    expect(rig.config.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe('');
  });
  test('plan mode cannot bypass the concrete write floor even when readings say read', async () => {
    const rig = await toolRig();
    expect((await rig.run({ action: 'connect.client', clientId: CLIENT_ID }, { mode: 'plan' })).success).toBe(false);
    expect(rig.config.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe('');
  });
  test('missing or malformed client files are refused without a partial client config', async () => {
    const rig = await toolRig(); const malformed = join(rig.root, 'wrong.json'); writeFileSync(malformed, '{"refresh_token":"synthetic"}');
    expect((await rig.run({ action: 'connect.clientFile', path: join(rig.root, 'missing.json') })).success).toBe(false);
    expect((await rig.run({ action: 'connect.clientFile', path: malformed })).success).toBe(false);
    expect(rig.config.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe('');
  });
  test('account replacement before completion cannot adopt the pending token', async () => {
    const rig = await toolRig({ approved: true });
    expect((await rig.run({ action: 'connect.client', clientId: CLIENT_ID })).success).toBe(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    rig.config.setDynamic('email.username', 'different@example.com');
    expect((await rig.run({ action: 'connect.complete' })).success).toBe(false);
    expect(await rig.secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBeNull();
  });
  test('a changed client file is refused after original preparation before any effect', async () => {
    const rig = await toolRig(); const path = clientJsonAt(rig.root); let changed = false;
    const result = await rig.run({ action: 'connect.clientFile', path }, { beforeEffect() {
      if (!changed) { changed = true; writeFileSync(path, '{}'); }
    } });
    expect(result.success).toBe(false); expect(rig.config.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe('');
  });
  test('same-byte client file replacement is still a new source incarnation', async () => {
    const rig = await toolRig(); const path = clientJsonAt(rig.root), raw = readFileSync(path, 'utf8'); let changed = false;
    const result = await rig.run({ action: 'connect.clientFile', path }, { beforeEffect() {
      if (!changed) { changed = true; writeFileSync(path, raw); }
    } });
    expect(result.success).toBe(false); expect(rig.config.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe('');
  });
  test('a selected client symlink cannot be replaced and restored between preparation and effect', async () => {
    const rig = await toolRig(); const original = clientJsonAt(rig.root), other = join(rig.root, 'other.json');
    writeFileSync(other, readFileSync(original)); const path = join(rig.root, 'selected-client.json'); symlinkSync(original, path); let changed = false;
    const result = await rig.run({ action: 'connect.clientFile', path }, { beforeEffect() {
      if (!changed) { changed = true; unlinkSync(path); symlinkSync(other, path); unlinkSync(path); symlinkSync(original, path); }
    } });
    expect(result.success).toBe(false); expect(rig.config.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe('');
  });
  test.each(['account-aba', 'credential-aba', 'credential-file-aba'] as const)('native Google send retains %s during refresh', async change => {
    const rig = await toolRig({ account: 'agent@example.com' });
    rig.config.setDynamic(GOOGLE_CONFIG_KEYS.oauthClientId, CLIENT_ID);
    rig.config.setDynamic(GOOGLE_CONFIG_KEYS.oauthClientSecretRef, secretReferenceFor(GOOGLE_SECRET_KEYS.oauthClientSecret));
    await rig.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, 'synthetic-refresh-token');
    const plan = rig.secrets.prepareImport([{ key: GOOGLE_SECRET_KEYS.oauthRefreshToken, value: 'synthetic-refresh-token', scope: 'daemon' }]);
    const path = rig.secrets.inspectPreparedImport(plan).destinations.find(item => item.tier === 'daemon')!.path;
    rig.afterRefresh(async () => {
      if (change === 'account-aba') {
        rig.config.setDynamic('email.username', 'other@example.com'); rig.config.setDynamic('email.username', 'agent@example.com');
      } else if (change === 'credential-aba') {
        await rig.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, 'other-refresh-token');
        await rig.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, 'synthetic-refresh-token');
      } else writeFileSync(path, readFileSync(path));
    });
    const result = await rig.run({ action: 'mail.send', to: 'recipient@example.com', subject: 'Fixture', body: 'The fixture finished.' });
    expect(result.success).toBe(false);
    expect(rig.requests.filter(url => url.includes('/messages/send'))).toEqual([]);
  });
  test('native Google credentials reach an actual admitted send with no caller flags', async () => {
    const rig = await toolRig({ account: 'agent@example.com' });
    rig.config.setDynamic(GOOGLE_CONFIG_KEYS.oauthClientId, CLIENT_ID);
    rig.config.setDynamic(GOOGLE_CONFIG_KEYS.oauthClientSecretRef, secretReferenceFor(GOOGLE_SECRET_KEYS.oauthClientSecret));
    await rig.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, 'synthetic-refresh-token');
    const result = await rig.run({ action: 'mail.send', to: 'recipient@example.com', subject: 'Fixture', body: 'The fixture finished.' });
    expect(result.success).toBe(true);
    expect(rig.requests.filter(url => url.includes('/messages/send'))).toHaveLength(1);
  });
  test.each(['credential-aba', 'credential-file-aba'] as const)('native Google source rejects %s after original projection before admission', async change => {
    const rig = await toolRig({ account: 'agent@example.com' });
    rig.config.setDynamic(GOOGLE_CONFIG_KEYS.oauthClientId, CLIENT_ID);
    rig.config.setDynamic(GOOGLE_CONFIG_KEYS.oauthClientSecretRef, secretReferenceFor(GOOGLE_SECRET_KEYS.oauthClientSecret));
    await rig.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, 'synthetic-refresh-token');
    const native = agentGoogleInputProjector(rig.tool)!;
    const plan = rig.secrets.prepareImport([{ key: GOOGLE_SECRET_KEYS.oauthRefreshToken, value: 'synthetic-refresh-token', scope: 'daemon' }]);
    const path = rig.secrets.inspectPreparedImport(plan).destinations.find(item => item.tier === 'daemon')!.path;
    await expect(executeAdmitted(rig.tool, { action: 'mail.send', to: 'recipient@example.com', subject: 'Fixture', body: 'The fixture finished.' }, {
      directory: rig.root, configManager: rig.config, registration: { inputProjection: { async project(request) {
        const original = await native.project(request);
        if (change === 'credential-aba') {
          await rig.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, 'replacement-refresh-token');
          await rig.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, 'synthetic-refresh-token');
        } else writeFileSync(path, readFileSync(path));
        return original;
      } } },
    })).rejects.toThrow();
    expect(rig.requests).toEqual([]);
  });
});
