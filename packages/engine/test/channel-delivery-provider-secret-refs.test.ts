/** Owned synthetic credentials exercise the production router and wire boundary. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { ChannelDeliveryRouter } from '../sdk/src/platform/channels/delivery-router.js';
import type { ChannelDeliveryRequest, ChannelDeliverySurfaceKind } from '../sdk/src/platform/channels/delivery/types.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ConfigKey } from '../sdk/src/platform/config/schema-types.js';
import type { SecretsManager } from '../sdk/src/platform/config/secrets.js';
import type { ServiceRegistry, ServiceSecretField } from '../sdk/src/platform/config/service-registry.js';
import { isDeclaredSecretBearingConfigKey } from '../sdk/src/platform/config/secret-bearing-config-keys.js';
import { logger } from '../sdk/src/platform/utils/logger.js';

const SECRET_KEY = 'owned-delivery-fixture-secret';
const SECRET_REF = `goodvibes://secrets/goodvibes/${SECRET_KEY}`;
const RESOLVED = 'owned+resolved/credential';
const LITERAL = 'owned+legacy/literal';
const REGISTERED = 'owned+registry/credential';
const ENVIRONMENT = 'owned+environment/credential';
const TEAMS_TOKEN = 'owned+teams/access-token';
const BODY = 'Owned private delivery body';

interface ProviderCase {
  readonly name: string;
  readonly surface: ChannelDeliverySurfaceKind;
  readonly configKey: string;
  readonly environmentKey: string;
  readonly serviceField: ServiceSecretField;
  readonly config: Record<string, unknown>;
  readonly optionalAuth?: boolean;
}

const providers: readonly ProviderCase[] = [
  {
    name: 'Signal', surface: 'signal', configKey: 'surfaces.signal.token',
    environmentKey: 'SIGNAL_BRIDGE_TOKEN', serviceField: 'primary', optionalAuth: true,
    config: { 'surfaces.signal.bridgeUrl': 'https://signal.example.invalid/send' },
  },
  {
    name: 'WhatsApp bridge', surface: 'whatsapp', configKey: 'surfaces.whatsapp.accessToken',
    environmentKey: 'WHATSAPP_ACCESS_TOKEN', serviceField: 'primary', optionalAuth: true,
    config: { 'surfaces.whatsapp.provider': 'bridge' },
  },
  {
    name: 'WhatsApp Meta Cloud', surface: 'whatsapp', configKey: 'surfaces.whatsapp.accessToken',
    environmentKey: 'WHATSAPP_ACCESS_TOKEN', serviceField: 'primary',
    config: { 'surfaces.whatsapp.provider': 'meta-cloud', 'surfaces.whatsapp.phoneNumberId': 'owned-phone-id' },
  },
  {
    name: 'iMessage', surface: 'imessage', configKey: 'surfaces.imessage.token',
    environmentKey: 'IMESSAGE_BRIDGE_TOKEN', serviceField: 'primary', optionalAuth: true,
    config: { 'surfaces.imessage.bridgeUrl': 'https://imessage.example.invalid/send' },
  },
  {
    name: 'BlueBubbles', surface: 'bluebubbles', configKey: 'surfaces.bluebubbles.password',
    environmentKey: 'BLUEBUBBLES_PASSWORD', serviceField: 'password',
    config: { 'surfaces.bluebubbles.serverUrl': 'https://bluebubbles.example.invalid' },
  },
  {
    name: 'Microsoft Teams', surface: 'msteams', configKey: 'surfaces.msteams.appPassword',
    environmentKey: 'MSTEAMS_APP_PASSWORD', serviceField: 'password',
    config: { 'surfaces.msteams.serviceUrl': 'https://teams.example.invalid', 'surfaces.msteams.tenantId': 'owned-tenant-id' },
  },
  {
    name: 'Mattermost', surface: 'mattermost', configKey: 'surfaces.mattermost.botToken',
    environmentKey: 'MATTERMOST_BOT_TOKEN', serviceField: 'primary',
    config: { 'surfaces.mattermost.baseUrl': 'https://mattermost.example.invalid' },
  },
  {
    name: 'Matrix', surface: 'matrix', configKey: 'surfaces.matrix.accessToken',
    environmentKey: 'MATRIX_ACCESS_TOKEN', serviceField: 'primary',
    config: { 'surfaces.matrix.homeserverUrl': 'https://matrix.example.invalid' },
  },
];

type WireCall = { url: string; method: string; headers: Headers; body: string };
let calls: WireCall[];
let logs: unknown[][];
let restore: Array<() => void>;
let transportFailure: Error | undefined;
let httpFailure = false;
let fixtureNumber = 0;

beforeEach(() => {
  calls = [];
  logs = [];
  restore = [];
  transportFailure = undefined;
  httpFailure = false;
  // Every environment input used by these providers is owned by the fixture.
  const environment: Record<string, string | undefined> = {
    ...Object.fromEntries(providers.map((provider) => [provider.environmentKey, undefined])),
    WHATSAPP_BRIDGE_URL: 'https://whatsapp-bridge.example.invalid/send',
    WHATSAPP_BASE_URL: 'https://whatsapp.example.invalid',
  };
  for (const [key, value] of Object.entries(environment)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    restore.push(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  for (const level of ['info', 'warn', 'error'] as const) {
    const spy = spyOn(logger, level).mockImplementation((...args) => { logs.push(args); });
    restore.push(() => spy.mockRestore());
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    if (transportFailure) throw transportFailure;
    if (httpFailure) return new Response(`${SECRET_REF}: ${RESOLVED}: ${BODY}`, { status: 503 });
    if (new URL(call.url).hostname === 'login.microsoftonline.com') {
      return Response.json({ access_token: TEAMS_TOKEN, expires_in: 3600 });
    }
    return Response.json({ id: 'owned-message-id' });
  }, { preconnect() { throw new Error('Unexpected preconnect in owned fixture'); } }));
  restore.push(() => fetch.mockRestore());
});

afterEach(() => {
  try {
    const serialized = JSON.stringify(logs);
    for (const value of [SECRET_REF, RESOLVED, LITERAL, REGISTERED, ENVIRONMENT, TEAMS_TOKEN, BODY]) {
      expect(serialized).not.toContain(value);
      expect(serialized).not.toContain(encodeURIComponent(value));
    }
  } finally {
    for (const undo of restore.reverse()) undo();
  }
});

function fixture(provider: ProviderCase, configured: unknown, options: {
  readonly registered?: string | null;
  readonly resolved?: string | null;
} = {}) {
  const values: Record<string, unknown> = {
    ...provider.config,
    [provider.configKey]: configured,
    // Each case must exchange its own credential instead of hitting the Teams cache.
    'surfaces.msteams.appId': `owned-app-id-${++fixtureNumber}`,
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigManager;
  const reads: string[] = [];
  const secretReads: string[] = [];
  const serviceReads: Array<[string, ServiceSecretField]> = [];
  const services = {
    get: () => null,
    resolveSecret: async (service: string, field: ServiceSecretField) => {
      serviceReads.push([service, field]);
      return options.registered ?? null;
    },
  } as unknown as ServiceRegistry;
  const secrets: Pick<SecretsManager, 'get' | 'getGlobalHome'> = {
    get: async (key) => {
      secretReads.push(key);
      return options.resolved === undefined ? RESOLVED : options.resolved;
    },
    getGlobalHome: () => '/tmp/owned-provider-fixture-home',
  };
  const delivery = new ChannelDeliveryRouter({
    configManager: {
      get: (key: ConfigKey) => { reads.push(key); return config.get(key); },
    } as unknown as ConfigManager,
    serviceRegistry: services,
    secretsManager: secrets,
    artifactStore: {} as ArtifactStore,
  });
  const request: ChannelDeliveryRequest = {
    target: { kind: 'surface', surfaceKind: provider.surface, address: 'owned-recipient' },
    body: BODY, title: 'Owned delivery', jobId: 'owned-job', runId: 'owned-run', includeLinks: false,
  };
  return { send: () => delivery.deliver(request), reads, secretReads, serviceReads };
}

function expectWireCredential(provider: ProviderCase, credential: string | undefined): void {
  expect(calls).toHaveLength(provider.surface === 'msteams' ? 2 : 1);
  const first = calls[0]!;
  if (provider.surface === 'bluebubbles') {
    expect(new URL(first.url).searchParams.get('password')).toBe(credential ?? null);
  } else if (provider.surface === 'msteams') {
    const exchange = new URLSearchParams(first.body);
    expect(exchange.get('client_secret')).toBe(credential ?? null);
    expect(exchange.get('grant_type')).toBe('client_credentials');
    expect(calls[1]!.headers.get('Authorization')).toBe(`Bearer ${TEAMS_TOKEN}`);
  } else {
    expect(first.headers.get('Authorization')).toBe(credential ? `Bearer ${credential}` : null);
  }
  expect(calls.at(-1)!.body).toContain(BODY);
  expect(calls.every((call) => call.method === 'POST')).toBe(true);
  expect(JSON.stringify(calls)).not.toContain(SECRET_REF);
  expect(logs.some((entry) => entry[0] === 'OUTBOUND_HTTP')).toBe(true);
}

for (const provider of providers) {
  describe(`${provider.name} canonical delivery credential`, () => {
    test('the declared surface reference resolves before the wire request', async () => {
      expect(isDeclaredSecretBearingConfigKey(provider.configKey)).toBe(true);
      process.env[provider.environmentKey] = ENVIRONMENT;
      const delivery = fixture(provider, SECRET_REF);
      expect(await delivery.send()).toBe('owned-message-id');
      expect(delivery.secretReads).toEqual([SECRET_KEY]);
      expect(delivery.serviceReads).toEqual([[provider.surface, provider.serviceField]]);
      expectWireCredential(provider, RESOLVED);
    });

    test('structured secret references use the same resolver', async () => {
      const delivery = fixture(provider, { source: 'goodvibes', id: SECRET_KEY });
      await delivery.send();
      expect(delivery.secretReads).toEqual([SECRET_KEY]);
      expectWireCredential(provider, RESOLVED);
    });

    test('legacy literal config keeps precedence over the environment', async () => {
      process.env[provider.environmentKey] = ENVIRONMENT;
      const delivery = fixture(provider, `  ${LITERAL}  `);
      await delivery.send();
      expect(delivery.secretReads).toEqual([]);
      expectWireCredential(provider, LITERAL);
    });

    test('ServiceRegistry wins without resolving an unused broken config fallback', async () => {
      process.env[provider.environmentKey] = ENVIRONMENT;
      const delivery = fixture(provider, SECRET_REF, { registered: REGISTERED, resolved: null });
      await delivery.send();
      expect(delivery.reads).not.toContain(provider.configKey);
      expect(delivery.secretReads).toEqual([]);
      expectWireCredential(provider, REGISTERED);
    });

    test('empty config and registry preserve the environment fallback', async () => {
      process.env[provider.environmentKey] = ENVIRONMENT;
      const delivery = fixture(provider, '   ', { registered: '   ' });
      await delivery.send();
      expect(delivery.secretReads).toEqual([]);
      expectWireCredential(provider, ENVIRONMENT);
    });

    test('an unresolved configured reference refuses before transport or environment fallback', async () => {
      process.env[provider.environmentKey] = ENVIRONMENT;
      const delivery = fixture(provider, SECRET_REF, { resolved: null });
      await expect(delivery.send()).rejects.toThrow(`Could not resolve channel delivery credential for ${provider.configKey}`);
      expect(delivery.secretReads).toEqual([SECRET_KEY]);
      expect(calls).toHaveLength(0);
    });

    test('a malformed configured reference is never sent as a literal', async () => {
      const malformed = 'goodvibes://secrets/owned-malformed-reference';
      const delivery = fixture(provider, malformed);
      await expect(delivery.send()).rejects.toThrow(`Could not resolve channel delivery credential for ${provider.configKey}`);
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(logs)).not.toContain(malformed);
    });

    test('the original private transport failure remains available without being logged', async () => {
      const error = new Error(`${RESOLVED}: ${SECRET_REF}: ${BODY}`);
      transportFailure = error;
      const delivery = fixture(provider, SECRET_REF);
      await expect(delivery.send()).rejects.toBe(error);
      expect(calls).toHaveLength(1);
    });

    test('a provider failure keeps its status and private response while logs exclude credentials', async () => {
      httpFailure = true;
      const delivery = fixture(provider, SECRET_REF);
      let error: unknown;
      try { await delivery.send(); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(RESOLVED);
      expect((error as { status: number }).status).toBe(503);
      expect(calls).toHaveLength(1);
    });

    if (provider.optionalAuth) {
      test('absent optional bridge auth still allows an unauthenticated owned request', async () => {
        const delivery = fixture(provider, undefined);
        await delivery.send();
        expectWireCredential(provider, undefined);
      });
    } else {
      test('absent required auth refuses before transport', async () => {
        const delivery = fixture(provider, undefined);
        await expect(delivery.send()).rejects.toThrow(/Missing .* (?:token|password)/);
        expect(calls).toHaveLength(0);
      });
    }
  });
}
