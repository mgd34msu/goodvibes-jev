/**
 * Synthetic secrets cross real delivery transports but never public diagnostics.
 * The fetch mock is the only network boundary: production strategies, routing,
 * URL logging, and ActivityLogger serialization/persistence all run unchanged.
 * These are intentionally not tests of a list of credential-shaped strings.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { structuredTransience } from '@goodvibes-jev/engine/errors';
import { ChannelDeliveryRouter } from '../sdk/src/platform/channels/delivery-router.js';
import {
  createDiscordDeliveryStrategy,
  createSlackDeliveryStrategy,
  createTelegramDeliveryStrategy,
  createWebhookDeliveryStrategy,
} from '../sdk/src/platform/channels/delivery/strategies-core.js';
import { createBlueBubblesDeliveryStrategy } from '../sdk/src/platform/channels/delivery/strategies-bridge.js';
import type {
  ChannelDeliveryRequest,
  ChannelDeliveryRouteBinding,
  ChannelDeliveryStrategy,
} from '../sdk/src/platform/channels/delivery/types.js';
import type { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ServiceRegistry } from '../sdk/src/platform/config/service-registry.js';
import { DiscordIntegration } from '../sdk/src/platform/integrations/discord.js';
import { describeStructuralDeliveryError } from '../sdk/src/platform/integrations/delivery-diagnostics.js';
import { instrumentedFetch, sanitizeUrlForLog } from '../sdk/src/platform/utils/fetch-with-timeout.js';
import { ActivityLogger, logger } from '../sdk/src/platform/utils/logger.js';

const BODY = 'synthetic private message body: velvet apricot lantern';
const QUERY = 'synthetic-private-query-value';
const CAPABILITY = 'synthetic-private-capability-path';
const PRIVATE_ERROR = 'a private arbitrary sentence with no credential syntax';
const secrets = { get: async () => null, getGlobalHome: () => root };
const artifacts = {} as ArtifactStore;

function config(values: Record<string, unknown> = {}): ConfigManager {
  return { get: (key: string) => values[key] } as unknown as ConfigManager;
}

function services(values: Record<string, string> = {}): ServiceRegistry {
  return {
    get: () => undefined,
    // Always supply owned values for credentials consulted by the fixtures;
    // environment credentials cannot become inputs to these requests.
    resolveSecret: async (service: string, key: string) => values[`${service}:${key}`]
      ?? (key === 'primary' ? 'synthetic-owned-primary' : 'synthetic-owned-webhook'),
  } as unknown as ServiceRegistry;
}

function request(overrides: Partial<ChannelDeliveryRequest> = {}): ChannelDeliveryRequest {
  return {
    target: { kind: 'surface', surfaceKind: 'telegram', address: 'ordinary-chat-id' },
    body: BODY,
    title: 'Synthetic delivery',
    jobId: 'owned-job',
    runId: 'owned-run',
    includeLinks: false,
    ...overrides,
  };
}

function binding(surfaceKind: 'slack' | 'discord', metadata: Record<string, unknown> = {}): ChannelDeliveryRouteBinding {
  return { id: 'ordinary-route-id', surfaceKind, surfaceId: 'ordinary-surface-id', externalId: 'ordinary-conversation-id', metadata };
}

function router(strategy: ChannelDeliveryStrategy): ChannelDeliveryRouter {
  return new ChannelDeliveryRouter({ strategies: [strategy] });
}

type RecordedRequest = { url: string; method: string; body: string; headers: Headers };
let root: string;
let activity: ActivityLogger;
let calls: RecordedRequest[];
let respond: (call: RecordedRequest) => Response | Promise<Response>;
let restore: Array<() => void>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'channel-delivery-diagnostics-'));
  activity = new ActivityLogger();
  activity.configure(root);
  calls = [];
  respond = () => { throw new Error('Unexpected request in owned delivery fixture'); };
  // Forward to a real, separately owned ActivityLogger, so cleanup does not
  // dispose or reconfigure the process singleton used by other test files.
  const info = spyOn(logger, 'info').mockImplementation((...args) => activity.info(...args));
  const warn = spyOn(logger, 'warn').mockImplementation((...args) => activity.warn(...args));
  const error = spyOn(logger, 'error').mockImplementation((...args) => activity.error(...args));
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return respond(call);
  }, { preconnect() { throw new Error('Unexpected preconnect in owned fixture'); } }));
  restore = [() => fetch.mockRestore(), () => error.mockRestore(), () => warn.mockRestore(), () => info.mockRestore()];
});

afterEach(() => {
  for (const undo of restore) undo();
  activity.dispose();
  rmSync(root, { recursive: true, force: true });
});

function persisted(): string {
  activity.flushSync();
  const path = join(root, 'activity.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function records(): Array<Record<string, unknown>> {
  return [...persisted().matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
}

function excludesPrivate(value: unknown, ...privateValues: string[]): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const privateValue of privateValues) expect(serialized).not.toContain(privateValue);
}

describe('uniform URL query withholding', () => {
  test('a throwing diagnostic Request method getter cannot prevent transport', async () => {
    const input = new Request('https://example.invalid/ordinary/resource', { method: 'POST' });
    Object.defineProperty(input, 'method', { get() { throw new Error(PRIVATE_ERROR); } });
    respond = () => new Response('accepted', { status: 202 });
    const response = await instrumentedFetch(input);
    expect(response.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', method: 'OTHER', status: 202 });
    excludesPrivate(persisted(), PRIVATE_ERROR);
  });

  test('query keys and values, credentials and fragments never become log material', async () => {
    const url = `https://synthetic-user:synthetic-password@example.invalid/ordinary/resource?password=${QUERY}&apparentlyHarmless=${QUERY}&${CAPABILITY}=value#${BODY}`;
    respond = () => new Response('accepted', { status: 202 });
    const response = await instrumentedFetch(url, { method: 'POST', body: BODY });
    expect(response.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url, method: 'POST', body: BODY });
    expect(sanitizeUrlForLog(url)).toBe('https://example.invalid/ordinary/resource?[redacted]');
    expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', method: 'POST', status: 202 });
    excludesPrivate(persisted(), QUERY, CAPABILITY, BODY, 'synthetic-user', 'synthetic-password');
  });

  test('ordinary paths, real status, and logger content remain observable controls', async () => {
    respond = () => new Response('accepted', { status: 201 });
    const url = 'https://example.invalid/ordinary/resource';
    await instrumentedFetch(url);
    expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', method: 'GET', url, status: 201 });
    expect(typeof records()[0]?.latencyMs).toBe('number');
    // A global content scrubber or disabled logger cannot accidentally pass
    // the diagnostic assertions: the boundary must own what it publishes.
    activity.info('Owned negative control', { ordinary: PRIVATE_ERROR });
    expect(persisted()).toContain(PRIVATE_ERROR);
    expect(calls).toHaveLength(1);
  });
});

describe('credential-owning channel callsites', () => {
  for (const token of ['syntheticTelegramPathToken', '123456:synthetic+Telegram/token']) {
    test(`Telegram keeps its ${token.includes(':') ? 'encoded' : 'raw'} path credential on the wire only`, async () => {
      const delivery = router(createTelegramDeliveryStrategy(config(), services({ 'telegram:primary': token }), artifacts, secrets));
      respond = () => Response.json({ ok: true, result: { message_id: 42 } });
      const receipt = await delivery.deliver(request());
      expect(receipt).toBe('42');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`);
      expect(JSON.parse(calls[0]!.body)).toEqual({ chat_id: 'ordinary-chat-id', text: BODY, disable_web_page_preview: true });
      expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', method: 'POST', status: 200 });
      excludesPrivate([persisted(), receipt], token, encodeURIComponent(token), BODY);
    });
  }

  test('BlueBubbles password query is withheld while message and password reach transport', async () => {
    const password = 'synthetic+BlueBubbles/password';
    const delivery = router(createBlueBubblesDeliveryStrategy(
      config({ 'surfaces.bluebubbles.serverUrl': 'https://bluebubbles.example.invalid' }),
      services({ 'bluebubbles:password': password }), artifacts, secrets,
    ));
    respond = () => Response.json({ id: 'ordinary-provider-message-id' });
    const receipt = await delivery.deliver(request({ target: { kind: 'surface', surfaceKind: 'bluebubbles', address: 'ordinary-chat-guid' } }));
    expect(receipt).toBe('ordinary-provider-message-id');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://bluebubbles.example.invalid/api/v1/message/text?password=${encodeURIComponent(password)}`);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ chatGuid: 'ordinary-chat-guid', message: BODY });
    expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', status: 200 });
    excludesPrivate([persisted(), receipt], password, encodeURIComponent(password), BODY);
  });

  test('Discord interaction token is neither logged nor used as a receipt', async () => {
    const applicationId = '123456789012345678';
    const token = 'synthetic-discord-interaction-token';
    const delivery = router(createDiscordDeliveryStrategy(services(), config(), artifacts, secrets));
    respond = () => new Response('{}');
    const receipt = await delivery.deliver(request({ target: { kind: 'surface', surfaceKind: 'discord' }, binding: binding('discord', { applicationId, interactionToken: token }) }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, method: 'PATCH' });
    expect(calls[0]?.body).toContain(BODY);
    expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', status: 200 });
    excludesPrivate([persisted(), receipt], token, BODY);
  });

  test('Discord callback token remains private on the second interaction endpoint too', async () => {
    const interactionId = '123456789012345678';
    const token = 'synthetic-discord-callback-token';
    respond = () => new Response(null, { status: 204 });
    await new DiscordIntegration().respondToInteraction(interactionId, token, 4, { content: BODY });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `https://discord.com/api/v10/interactions/${interactionId}/${token}/callback`, method: 'POST' });
    expect(JSON.parse(calls[0]!.body)).toEqual({ type: 4, data: { content: BODY } });
    expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', status: 204 });
    excludesPrivate(persisted(), token, BODY);
  });

  test('Slack response capability URL reaches transport but never a log or receipt', async () => {
    const url = `https://hooks.slack.com/actions/${CAPABILITY}?unclassified=${QUERY}`;
    const delivery = router(createSlackDeliveryStrategy(services(), config(), artifacts, secrets));
    respond = () => new Response('{}');
    const receipt = await delivery.deliver(request({ target: { kind: 'surface', surfaceKind: 'slack' }, binding: binding('slack', { responseUrl: url }) }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url, method: 'POST' });
    expect(calls[0]?.body).toContain(BODY);
    expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', status: 200 });
    excludesPrivate([persisted(), receipt], CAPABILITY, QUERY, BODY);
  });

  for (const surface of ['slack', 'discord'] as const) {
    for (const source of ['target', 'configuration'] as const) {
      test(`${surface} ${source} webhook never becomes a credential-derived receipt`, async () => {
        const url = `https://${surface === 'slack' ? 'hooks.slack.com/services' : 'discord.com/api/webhooks/123456789012345678'}/${CAPABILITY}?unclassified=${QUERY}`;
        const registry = services({ [`${surface}:webhookUrl`]: url });
        const strategy = surface === 'slack'
          ? createSlackDeliveryStrategy(registry, config(), artifacts, secrets)
          : createDiscordDeliveryStrategy(registry, config(), artifacts, secrets);
        respond = () => new Response('{}');
        const receipt = await router(strategy).deliver(request({ target: { kind: 'surface', surfaceKind: surface, ...(source === 'target' ? { address: url } : {}) } }));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ url, method: 'POST' });
        expect(JSON.parse(calls[0]!.body)).toMatchObject(surface === 'slack' ? { text: BODY } : { content: BODY });
        // Slack's direct webhook currently has no OUTBOUND_HTTP wrapper.
        // Check any emitted log as well as the independently public receipt.
        if (surface === 'discord') expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', status: 200 });
        excludesPrivate([persisted(), receipt], CAPABILITY, QUERY, BODY);
      });
    }
  }

  for (const host of ['203.0.113.40', 'webhook.example.invalid']) {
    test(`generic webhook via ${host} preserves delivery and pinning without publishing its capability`, async () => {
      // A documentation address passes the existing public-target guard. The
      // owned resolver and intercepted fetch exercise both pinning branches
      // without DNS, connections, or altered trust rules.
      const path = `/callback/${CAPABILITY}?unclassified=${QUERY}`;
      const url = `https://${host}${path}`;
      const resolved: string[] = [];
      const strategy = createWebhookDeliveryStrategy(config(), artifacts, secrets, {
        resolveHost: async (hostname) => { resolved.push(hostname); return [{ address: '203.0.113.40', family: 4 }]; },
      });
      respond = () => new Response('{}');
      const receipt = await router(strategy).deliver(request({ target: { kind: 'webhook', address: url } }));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: `https://203.0.113.40${path}`, method: 'POST' });
      expect(resolved).toEqual(host === '203.0.113.40' ? [] : [host]);
      if (host !== '203.0.113.40') expect(calls[0]?.headers.get('host')).toBe(host);
      expect(JSON.parse(calls[0]!.body)).toEqual({ text: BODY, message: BODY, title: 'Synthetic delivery', jobId: 'owned-job', runId: 'owned-run', attachments: [], artifacts: [] });
      expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', status: 200 });
      excludesPrivate([persisted(), receipt], CAPABILITY, QUERY, BODY);
    });
  }

  test('a DNS-refused opaque webhook withholds capability material from SSRF_DENY diagnostics', async () => {
    const host = 'synthetic-private-capability-host.example.invalid';
    const url = `https://${host}/callback/${CAPABILITY}?unclassified=${QUERY}`;
    const resolved: string[] = [];
    const strategy = createWebhookDeliveryStrategy(config(), artifacts, secrets, {
      resolveHost: async (hostname) => { resolved.push(hostname); return [{ address: '127.0.0.1', family: 4 }]; },
    });
    let originalRefusal: unknown;
    const delivery = router({
      ...strategy,
      async deliver(input) {
        try { return await strategy.deliver(input); }
        catch (error) { originalRefusal = error; throw error; }
      },
    });
    const failure = await delivery.deliver(request({ target: { kind: 'webhook', address: url } }))
      .then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    expect(resolved).toEqual([host]);
    expect(calls).toHaveLength(0);
    expect(failure.error).toBeInstanceOf(Error);
    expect(failure.error).toBe(originalRefusal);
    expect((failure.error as Error).message).toBe(`Request blocked: host "${host}" resolves to 127.0.0.1, a loopback address, SSRF risk`);
    expect(persisted()).toContain('SSRF_DENY');
    expect(records().find((record) => record.url !== undefined)).toMatchObject({
      host: '[redacted-host]', url: '[redacted-url]', reason: 'Resolved address is not allowed',
    });
    expect(records().find((record) => record.surface === 'webhook')?.reason).toBe('Delivery failed');
    excludesPrivate(persisted(), host, url, CAPABILITY, QUERY, BODY);
  });
});

describe('structural failure publication preserves retry evidence', () => {
  test('provider error bodies and echoed tokens stay out of persisted failure diagnostics', async () => {
    const token = '123456:synthetic+failed/Telegram';
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
    const delivery = router(createTelegramDeliveryStrategy(config(), services({ 'telegram:primary': token }), artifacts, secrets));
    respond = () => Response.json({ ok: false, description: BODY, endpoint: url }, { status: 503 });
    const failure = await delivery.deliver(request()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(describeStructuralDeliveryError(failure)).toBe('HTTP 503');
    expect(structuredTransience(failure)).toMatchObject({ failureClass: 'retryable', basis: 'status' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(url);
    expect(JSON.parse(calls[0]!.body).text).toBe(BODY);
    expect(records().find((record) => record.reason !== undefined)?.reason).toBe('HTTP 503');
    excludesPrivate(persisted(), token, encodeURIComponent(token), BODY);
  });

  test('arbitrary rejection wording, cause and destination are private; original retry input survives', async () => {
    const cause = Object.assign(new Error(`${PRIVATE_ERROR} ${BODY}`), { code: 'ECONNREFUSED' });
    const original = new TypeError(PRIVATE_ERROR, { cause });
    const url = `https://example.invalid/${CAPABILITY}?apparentlyHarmless=${QUERY}`;
    const delivery = router({ id: 'owned-synthetic-transport', canHandle: () => true, deliver: async () => { throw original; } });
    const failure = await delivery.deliver(request({ target: { kind: 'webhook', address: url }, binding: binding('slack') })).catch((error: unknown) => error);
    expect(failure).toBe(original);
    expect(structuredTransience(failure)).toMatchObject({ failureClass: 'retryable', basis: 'errno' });
    expect(records()[0]).toMatchObject({ surface: 'webhook', strategy: 'custom', reason: 'Delivery failed' });
    expect(calls).toHaveLength(0);
    excludesPrivate(persisted(), PRIVATE_ERROR, BODY, CAPABILITY, QUERY);
  });

  test('an unknown thrown string is not treated as publishable diagnostic wording', async () => {
    const delivery = router({ id: 'owned-synthetic-transport', canHandle: () => true, deliver: async () => { throw PRIVATE_ERROR; } });
    const failure = await delivery.deliver(request()).catch((error: unknown) => error);
    expect(failure).toBe(PRIVATE_ERROR);
    expect(records()[0]?.reason).toBe('Delivery failed');
    excludesPrivate(persisted(), PRIVATE_ERROR);
  });

  test('hostile error getters and log coercion cannot replace the original rejection', async () => {
    let privateReads = 0;
    const original = { status: 429 };
    for (const key of ['message', 'name', 'stack', 'cause', 'body', 'toJSON', 'toString']) {
      Object.defineProperty(original, key, { enumerable: true, get() { privateReads++; throw new Error(PRIVATE_ERROR); } });
    }
    const delivery = router({ id: 'owned-synthetic-transport', canHandle: () => true, deliver: async () => { throw original; } });
    const failure = await delivery.deliver(request()).catch((error: unknown) => error);
    expect(failure).toBe(original);
    expect(privateReads).toBe(0);
    expect(records()[0]?.reason).toBe('HTTP 429');
    excludesPrivate(persisted(), PRIVATE_ERROR, BODY);
  });

  test('unreadable status and prototype fail closed without replacing the original rejection', async () => {
    const original = new Proxy({}, { getPrototypeOf() { throw new Error(PRIVATE_ERROR); }, get() { throw new Error(PRIVATE_ERROR); } });
    const delivery = router({ id: 'owned-synthetic-transport', canHandle: () => true, deliver: async () => { throw original; } });
    // Box the rejection: returning the Proxy directly asks Promise resolution
    // to read its hostile `then` getter before this assertion can inspect it.
    const failure = await delivery.deliver(request()).then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    expect(failure.error === original).toBe(true);
    expect(records()[0]?.reason).toBe('Delivery failed');
    excludesPrivate(persisted(), PRIVATE_ERROR);
  });

  test('destination and binding log getters cannot replace a failed delivery', async () => {
    const original = Object.assign(new Error(PRIVATE_ERROR), { status: 400 });
    const input = request();
    Object.defineProperty(input.target, 'address', { get() { throw new Error(BODY); } });
    Object.defineProperty(input, 'binding', { get() { throw new Error(CAPABILITY); } });
    const delivery = router({ id: 'owned-synthetic-transport', canHandle: () => true, deliver: async () => { throw original; } });
    const failure = await delivery.deliver(input).catch((error: unknown) => error);
    expect(failure).toBe(original);
    expect(records()[0]?.reason).toBe('HTTP 400');
    excludesPrivate(persisted(), PRIVATE_ERROR, BODY, CAPABILITY);
  });

  test('a logger failure cannot turn a delivered HTTP response into a retry', async () => {
    const logInfo = logger.info;
    logger.info = () => { throw new Error(PRIVATE_ERROR); };
    const response = new Response('accepted', { status: 202 });
    respond = () => response;
    try {
      expect(await instrumentedFetch('https://example.invalid/ordinary/resource', { method: 'POST', body: BODY })).toBe(response);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body).toBe(BODY);
    } finally { logger.info = logInfo; }
  });

  test('logging failures preserve the identical transport and router rejection', async () => {
    const original = Object.assign(new Error(PRIVATE_ERROR), { retryAfterMs: 1234 });
    const logInfo = logger.info;
    const logError = logger.error;
    logger.info = logger.error = () => { throw new Error(BODY); };
    respond = () => { throw original; };
    const delivery = router(createTelegramDeliveryStrategy(config(), services(), artifacts, secrets));
    try {
      const failure = await delivery.deliver(request()).catch((error: unknown) => error);
      expect(failure).toBe(original);
      expect(structuredTransience(failure)).toMatchObject({ failureClass: 'retryable', basis: 'retry-after' });
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]!.body).text).toBe(BODY);
    } finally { logger.info = logInfo; logger.error = logError; }
  });

  test('ordinary channel identifiers remain usable successful receipt controls', async () => {
    const channelId = '123456789012345678';
    respond = () => new Response('{}');
    const delivery = router(createDiscordDeliveryStrategy(services(), config(), artifacts, secrets));
    const receipt = await delivery.deliver(request({ target: { kind: 'surface', surfaceKind: 'discord', address: channelId } }));
    expect(receipt).toBe(channelId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://discord.com/api/v10/channels/${channelId}/messages`);
    expect(JSON.parse(calls[0]!.body).content).toBe(BODY);
    expect(records()[0]).toMatchObject({ type: 'OUTBOUND_HTTP', status: 200 });
    excludesPrivate(persisted(), BODY, 'synthetic-owned-primary');
  });
});
