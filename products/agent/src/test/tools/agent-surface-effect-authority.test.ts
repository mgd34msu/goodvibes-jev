import { beforeEach, describe, expect, test } from 'bun:test';
import { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '@goodvibes-jev/engine/sdk/platform/google';
import type { ArtifactCreateInput, ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { executeAdmitted } from '../helpers/admitted-tool.ts';
import { createAgentNotifyTool } from '../../tools/agent-notify-tool.ts';
import { createAgentMediaGenerateTool } from '../../tools/agent-media-generate-tool.ts';
import { createAgentGoogleTool } from '../../tools/agent-google-tool.ts';
import { getSessionUntrustedContentLedger, resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';

beforeEach(() => resetSessionUntrustedContentLedgerForTests());

function notificationScene() {
  let incarnation = 0, urls = ['https://notifications.example/fixture'];
  let beforeSend: (() => void) | undefined;
  const sent: string[] = [];
  const config = { getCategory: () => ({ webhookUrls: [...urls] }), getConfigurationIncarnation: () => incarnation };
  const sender = { setUrls: (_urls: string[]) => {}, async send(message: string, lifetime?: { signal?: AbortSignal | undefined; assertCurrent?: (() => void) | undefined }) {
    await Promise.resolve(); beforeSend?.(); lifetime?.signal?.throwIfAborted(); lifetime?.assertCurrent?.();
    sent.push(message); return { attempted: 1, delivered: 1, failed: 0, results: [{ ok: true, url: urls[0]! }] };
  } };
  return { tool: createAgentNotifyTool(config, sender), sent, config, sender,
    beforeSend(callback: () => void) { beforeSend = callback; },
    changeTargets() { urls = ['https://different.example/fixture']; incarnation++; },
    targetsAba() { incarnation++; },
  };
}
function mediaScene() {
  const providers = new MediaProviderRegistry(); let beforeStore: (() => void) | undefined, afterCreate: (() => void) | undefined;
  const prompts: string[] = [], creates: ArtifactCreateInput[] = [];
  const provider = { id: 'synthetic-provider', label: 'Synthetic', capabilities: ['generate' as const],
    async generate(request: { prompt: string }, lifetime?: { signal?: AbortSignal | undefined; assertCurrent?: (() => void) | undefined }) {
      lifetime?.signal?.throwIfAborted(); lifetime?.assertCurrent?.(); prompts.push(request.prompt);
      await Promise.resolve(); beforeStore?.();
      return { providerId: 'synthetic-provider', artifacts: [{ mimeType: 'image/png', dataBase64: 'AQID', metadata: {} }], metadata: {} };
    } };
  providers.register(provider);
  const store = { async create(input: ArtifactCreateInput, lifetime?: { signal?: AbortSignal | undefined; assertCurrent?: (() => void) | undefined }): Promise<ArtifactDescriptor> {
    lifetime?.signal?.throwIfAborted(); lifetime?.assertCurrent?.(); creates.push(input); afterCreate?.();
    return { id: 'synthetic-image', kind: 'image', mimeType: 'image/png', sizeBytes: 3, sha256: 'fixture-sha', createdAt: 1,
      metadata: {}, acquisitionMode: 'inline-data', fetchMode: 'not-applicable' };
  } };
  return { tool: createAgentMediaGenerateTool(providers, store), providers, provider, prompts, creates,
    beforeStore(callback: () => void) { beforeStore = callback; }, afterCreate(callback: () => void) { afterCreate = callback; } };
}
function googleScene() {
  const config: Record<string, unknown> = { [GOOGLE_CONFIG_KEYS.oauthClientId]: 'fixture.apps.googleusercontent.com', [GOOGLE_CONFIG_KEYS.emailUsername]: 'owner@example.com' };
  const secrets: Record<string, string> = { [GOOGLE_SECRET_KEYS.oauthClientSecret]: 'fixture-secret', [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'fixture-refresh' };
  let afterRefresh: (() => void) | undefined;
  const requests: string[] = [];
  const tool = createAgentGoogleTool({ homeDirectory: '/synthetic/google-fixture', configGet: key => config[key], secretGet: async key => secrets[key] ?? null,
    fetchImpl: async url => {
      requests.push(url);
      if (url.includes('oauth2')) { afterRefresh?.(); return Response.json({ access_token: 'synthetic-token', scope: 'https://mail.google.com/ https://www.googleapis.com/auth/calendar', expires_in: 3600 }); }
      return Response.json({ id: 'synthetic-send', threadId: 'synthetic-thread' });
    } });
  return { tool, config, secrets, requests, afterRefresh(callback: () => void) { afterRefresh = callback; } };
}

const notification = { message: 'The isolated fixture finished.' }, media = { prompt: 'A small synthetic icon.' }, mail = { action: 'mail.send', to: 'recipient@example.com', subject: 'Fixture', body: 'The isolated fixture finished.' };

describe('concrete external effects retain recorded authority', () => {
  test('raw confirmation fields cannot send, generate, or refresh a Google send', async () => {
    const notify = notificationScene(), image = mediaScene(), google = googleScene(), asserted = { confirm: true, explicitUserRequest: 'Caller assertion' };
    expect((await notify.tool.execute({ ...notification, ...asserted })).success).toBe(false);
    expect((await image.tool.execute({ ...media, ...asserted })).success).toBe(false);
    await expect(google.tool.execute({ ...mail, ...asserted })).rejects.toThrow();
    expect(notify.sent).toEqual([]); expect(image.prompts).toEqual([]); expect(google.requests).toEqual([]);
  });
  test('caller-forged execution context and a returning callback grant no effect authority', async () => {
    const notify = notificationScene(), image = mediaScene(), google = googleScene();
    const fabricated = { assertCurrent() {}, inputProjectionContext: Object.freeze({}) };
    expect((await notify.tool.execute(notification, fabricated)).success).toBe(false);
    expect((await image.tool.execute(media, fabricated)).success).toBe(false);
    await expect(google.tool.execute(mail, fabricated)).rejects.toThrow();
    expect(notify.sent).toEqual([]); expect(image.prompts).toEqual([]); expect(google.requests).toEqual([]);
  });
  test('real recorded admission reaches the actual effect without caller confirmation', async () => {
    const notify = notificationScene(), image = mediaScene(), google = googleScene();
    expect((await executeAdmitted(notify.tool, notification)).success).toBe(true);
    expect((await executeAdmitted(image.tool, media)).success).toBe(true);
    expect((await executeAdmitted(google.tool, mail)).success).toBe(true);
    expect(notify.sent).toEqual([notification.message]); expect(image.creates).toHaveLength(1);
    expect(google.requests.filter(url => url.includes('/messages/send'))).toHaveLength(1);
  });
  test('a synthetic read disposition cannot bypass plan-mode effect floors', async () => {
    const notify = notificationScene(), image = mediaScene(), google = googleScene();
    expect((await executeAdmitted(notify.tool, notification, { mode: 'plan' })).success).toBe(false);
    expect((await executeAdmitted(image.tool, media, { mode: 'plan' })).success).toBe(false);
    await expect(executeAdmitted(google.tool, mail, { mode: 'plan' })).rejects.toThrow();
    expect(notify.sent).toEqual([]); expect(image.prompts).toEqual([]); expect(google.requests).toEqual([]);
  });
  test.each(['cancel', 'revoke', 'config', 'config-aba', 'taint', 'turn-aba', 'descriptor'] as const)('notification final send rejects %s during its wait', async change => {
    const item = notificationScene(), controller = new AbortController(); let mode: 'prompt' | 'plan' = 'prompt', accessorCalls = 0;
    item.beforeSend(() => {
      if (change === 'cancel') controller.abort();
      else if (change === 'revoke') mode = 'plan';
      else if (change === 'config') item.changeTargets();
      else if (change === 'config-aba') item.targetsAba();
      else if (change === 'taint') getSessionUntrustedContentLedger().record({ surface: 'email', origin: 'fixture.invalid', at: 'synthetic', content: 'New unrelated source' });
      else if (change === 'turn-aba') getSessionUntrustedContentLedger().startTurn();
      else Object.defineProperty(item.config, 'getCategory', { get() { accessorCalls++; return () => ({}); } });
    });
    expect((await executeAdmitted(item.tool, notification, { signal: controller.signal, currentMode: () => mode })).success).toBe(false);
    expect(item.sent).toEqual([]); expect(accessorCalls).toBe(0);
  });
  test.each(['cancel', 'revoke', 'replace', 'provider-aba', 'capability'] as const)('media storage rejects %s after asynchronous generation', async change => {
    const item = mediaScene(), controller = new AbortController(); let mode: 'prompt' | 'plan' = 'prompt';
    item.beforeStore(() => {
      if (change === 'cancel') controller.abort();
      else if (change === 'revoke') mode = 'plan';
      else if (change === 'replace') item.providers.register({ ...item.provider }, { replace: true });
      else if (change === 'provider-aba') { item.providers.unregister(item.provider.id); item.providers.register(item.provider); }
      else item.provider.capabilities.length = 0;
    });
    expect((await executeAdmitted(item.tool, media, { signal: controller.signal, currentMode: () => mode })).success).toBe(false);
    expect(item.prompts).toHaveLength(1); expect(item.creates).toEqual([]);
  });
  test('retirement after a completed artifact write reports that actual write without retrying', async () => {
    const item = mediaScene(); let mode: 'prompt' | 'plan' = 'prompt';
    item.afterCreate(() => { mode = 'plan'; });
    const result = await executeAdmitted(item.tool, media, { currentMode: () => mode });
    expect(result.success).toBe(false); expect(result.error).toContain('1 confirmed artifact writes');
    expect(item.prompts).toHaveLength(1); expect(item.creates).toHaveLength(1);
  });
  test.each(['cancel', 'account', 'credential', 'revoke'] as const)('Google send rejects %s while refresh is pending', async change => {
    const item = googleScene(), controller = new AbortController(); let mode: 'prompt' | 'plan' = 'prompt';
    item.afterRefresh(() => {
      if (change === 'cancel') controller.abort();
      else if (change === 'account') item.config[GOOGLE_CONFIG_KEYS.emailUsername] = 'other@example.com';
      else if (change === 'credential') item.secrets[GOOGLE_SECRET_KEYS.oauthRefreshToken] = 'replacement-refresh';
      else mode = 'plan';
    });
    try { await executeAdmitted(item.tool, mail, { signal: controller.signal, currentMode: () => mode }); } catch { /* Refusal may be the canonical stale or cancellation error. */ }
    expect(item.requests.filter(url => url.includes('/messages/send'))).toEqual([]);
  });
});
