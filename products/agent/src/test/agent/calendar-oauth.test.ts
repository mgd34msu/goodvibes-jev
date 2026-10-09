/**
 * Calendar OAuth agent-side tests.
 *
 * The deep OAuth + provider-API flow is proven at the SDK level against fake servers
 * (goodvibes-sdk/test/platform-calendar-oauth.test.ts). Here we prove the AGENT half:
 *  - the advanced-credentials wizard stores the client id in config and the client
 *    secret through the secret manager (never in plain config, status, or result),
 *    using a real ConfigManager + in-memory secret store.
 *  - the service's config resolution: bundled-default placeholder vs a config
 *    override, and reading a secret-backed client secret; the placeholder guard
 *    short-circuits a connect BEFORE any network call.
 *  - the connect/disconnect/accounts commands route + report honestly, driven by an
 *    injected fake service (no real network, port, or browser anywhere in this file).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CalendarConnector } from '@goodvibes-jev/engine/sdk/platform/calendar';
import type { CommandContext } from '../../input/command-registry.ts';
import {
  CALENDAR_OAUTH_CLIENT_ID_KEYS,
  CalendarOAuthService,
  type CalendarConfigReader,
  type CalendarSecretSlice,
} from '../../agent/calendar/calendar-oauth-service.ts';
import {
  createCalendarOAuthEditor,
  submitAgentWorkspaceCalendarOAuthEditor,
  type AgentWorkspaceCalendarOAuthEditorHost,
} from '../../input/agent-workspace-calendar-oauth-editor.ts';
import {
  normalizeProvider,
  runCalendarAccounts,
  runCalendarConnect,
  runCalendarDisconnect,
  type CalendarServiceFactory,
} from '../../input/commands/calendar-connect-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// --- shared doubles ---------------------------------------------------------

function memorySecrets(): CalendarSecretSlice & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async set(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

function mapConfig(values: Record<string, unknown> = {}): CalendarConfigReader {
  return { get: (key: string) => values[key] };
}

/** A connector stub that fails loudly if the guard fails to short-circuit. */
function throwingConnector(): CalendarConnector {
  const boom = () => { throw new Error('connector should not be called'); };
  return { beginConnectAuthCode: boom, beginConnectDeviceCode: boom, listAccounts: async () => [] } as unknown as CalendarConnector;
}

function capturingContext(): { ctx: CommandContext; lines: string[] } {
  const lines: string[] = [];
  const ctx = { print: (s: string) => { lines.push(s); } } as unknown as CommandContext;
  return { ctx, lines };
}

// --- normalizeProvider ------------------------------------------------------

describe('normalizeProvider', () => {
  test('maps provider words to ids', () => {
    expect(normalizeProvider('google')).toBe('google');
    expect(normalizeProvider('outlook')).toBe('microsoft');
    expect(normalizeProvider('microsoft')).toBe('microsoft');
    expect(normalizeProvider('nope')).toBeNull();
    expect(normalizeProvider(undefined)).toBeNull();
  });
});

// --- advanced-credentials wizard --------------------------------------------

const RAW_SECRET = 'confidential-client-secret-value';

function tmpRoot(): string {
  const dir = makeProjectTempDir(`gv-cal-oauth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

function wizardContext(root: string, secrets: CalendarSecretSlice): CommandContext {
  const cm = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'global-tui') });
  return {
    session: {} as never,
    provider: {} as never,
    workspace: {} as never,
    platform: { config: {} as never, configManager: cm, secretsManager: secrets } as never,
    ops: {} as never,
    extensions: {} as never,
    clients: {} as never,
    renderRequest: () => {},
    print: () => {},
    exit: () => {},
  } as CommandContext;
}

function persistedSettings(root: string): string {
  const candidates = [
    join(root, '.goodvibes', 'global-tui', 'settings.json'),
    join(root, '.goodvibes', 'global-tui', 'user-settings.json'),
  ];
  return candidates.filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf-8')).join('');
}

function host(): AgentWorkspaceCalendarOAuthEditorHost {
  return { localEditor: null, status: '', lastActionResult: null };
}

describe('calendar OAuth advanced-credentials wizard', () => {
  test('the client-secret field is masked and the confirm step is last', () => {
    const editor = createCalendarOAuthEditor('google');
    expect(editor.kind).toBe('calendar-oauth-google');
    expect(editor.fields.find((f) => f.id === 'clientSecret')?.redact).toBe(true);
    expect(editor.fields.at(-1)?.id).toBe('confirm');
  });

  // F1c: the card's message is build-state-aware, it must stop claiming
  // "most people can skip this and just run the connect command" while a
  // bare connect always fails at the config stage (the placeholder state),
  // and it should keep that original skip-this wording once a client id has
  // actually been configured.
  test('placeholder state: the card states a client id is needed, not that most people can skip it', () => {
    const google = createCalendarOAuthEditor('google', false);
    expect(google.message).toContain('This build needs a client id');
    expect(google.message).not.toContain('Most people can skip this');

    const microsoft = createCalendarOAuthEditor('microsoft', false);
    expect(microsoft.message).toContain('This build needs a client id');
    expect(microsoft.message).not.toContain('Most people can skip this');
  });

  test('configured state: the card keeps the original skip-this-if-you-do-not-need-it wording', () => {
    const google = createCalendarOAuthEditor('google', true);
    expect(google.message).toContain('Most people can skip this and just run the connect command');
    expect(google.message).not.toContain('This build needs a client id');

    const microsoft = createCalendarOAuthEditor('microsoft', true);
    expect(microsoft.message).toContain('Most people can skip this and just run the connect command');
    expect(microsoft.message).not.toContain('This build needs a client id');
  });

  test('stores the client id in config and the secret through the secret manager, never echoing it', async () => {
    const root = tmpRoot();
    const secrets = memorySecrets();
    const ctx = wizardContext(root, secrets);
    const h = host();
    const editor = createCalendarOAuthEditor('google');
    const fields: Record<string, string> = { clientId: 'my-desktop-client.apps.googleusercontent.com', clientSecret: RAW_SECRET, confirm: 'yes' };
    await submitAgentWorkspaceCalendarOAuthEditor(h, editor, ctx, (id) => fields[id] ?? '');

    const cm = ctx.platform.configManager as unknown as { get: (k: string) => unknown };
    expect(cm.get(CALENDAR_OAUTH_CLIENT_ID_KEYS.google)).toBe('my-desktop-client.apps.googleusercontent.com');
    // the raw secret reached the secret store, NOT settings.json / status / result
    expect([...secrets.store.values()]).toContain(RAW_SECRET);
    expect(persistedSettings(root)).not.toContain(RAW_SECRET);
    expect(h.status).not.toContain(RAW_SECRET);
    expect(JSON.stringify(h.lastActionResult)).not.toContain(RAW_SECRET);
    expect(h.lastActionResult?.title).toBe('Google Calendar credentials stored');
  });

  test('an unconfirmed submit writes nothing', async () => {
    const root = tmpRoot();
    const secrets = memorySecrets();
    const ctx = wizardContext(root, secrets);
    const h = host();
    const editor = createCalendarOAuthEditor('microsoft');
    const fields: Record<string, string> = { clientId: 'id', clientSecret: '', confirm: 'no' };
    await submitAgentWorkspaceCalendarOAuthEditor(h, editor, ctx, (id) => fields[id] ?? '');
    expect(h.status).toContain('not confirmed');
    expect(secrets.store.size).toBe(0);
  });
});

// --- service config resolution + guard --------------------------------------

describe('CalendarOAuthService config resolution', () => {
  test('an environment with no registered OAuth app resolves as not configured', async () => {
    const service = new CalendarOAuthService({ config: mapConfig(), secrets: memorySecrets(), connector: throwingConnector() });
    const config = await service.resolveConfig('google');
    expect(config.isConfigured).toBe(false);
    expect(config.clientId).toBe('');
    expect(config.clientIdConfigKey).toBe('calendar.google.clientId');
  });

  test('the connect refusal names the key the operator has to set', async () => {
    const service = new CalendarOAuthService({ config: mapConfig(), secrets: memorySecrets(), connector: throwingConnector() });
    const result = await service.connectLoopback('google');
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('config');
    expect(result.error).toContain('calendar.google.clientId');
    expect(result.error).toContain('register your own OAuth app');
  });

  test("the operator's configured client id resolves into the flow config", async () => {
    const service = new CalendarOAuthService({
      config: mapConfig({ 'calendar.google.clientId': 'user-supplied-id' }),
      secrets: memorySecrets(),
      connector: throwingConnector(),
    });
    const config = await service.resolveConfig('google');
    expect(config.clientId).toBe('user-supplied-id');
    expect(config.isConfigured).toBe(true);
  });

  test('reads a secret-backed client secret from the secret store', async () => {
    const secrets = memorySecrets();
    await secrets.set('GOODVIBES_CALENDAR_MICROSOFT_CLIENT_SECRET_REF', 'ms-secret');
    const service = new CalendarOAuthService({
      config: mapConfig({
        'calendar.microsoft.clientId': 'ms-id',
        'calendar.microsoft.clientSecretRef': 'goodvibes://secrets/goodvibes/GOODVIBES_CALENDAR_MICROSOFT_CLIENT_SECRET_REF',
      }),
      secrets,
      connector: throwingConnector(),
    });
    const overrides = await service.resolveOverrides('microsoft');
    expect(overrides.clientId).toBe('ms-id');
    expect(overrides.clientSecret).toBe('ms-secret');

    // The other value of the same setting: a client id with no secret
    // reference beside it. A public client with "Allow public client flows"
    // enabled needs no secret, so this is a real configuration rather than an
    // error, and the overrides must carry no secret at all rather than an
    // empty string, which the connector would try to send.
    const noRef = new CalendarOAuthService({
      config: mapConfig({ 'calendar.microsoft.clientId': 'ms-id' }),
      secrets: memorySecrets(),
      connector: throwingConnector(),
    });
    expect((await noRef.resolveOverrides('microsoft')).clientSecret).toBeUndefined();
  });

  test('the placeholder guard short-circuits connect before any connector call', async () => {
    const service = new CalendarOAuthService({ config: mapConfig(), secrets: memorySecrets(), connector: throwingConnector() });
    const result = await service.connectAuto('google');
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('config'); // throwingConnector proves begin* was never reached
  });

  // F1b: the guard's error is a flat, deterministic statement (nothing about it
  // is a maybe, no client id ships, so an environment where nobody registered
  // an app is always this state) carrying the exact next step, not a hedged
  // "either...or" pair of possibilities.
  test('the not-configured guard states the situation flatly and names the exact next step, per provider', async () => {
    const google = new CalendarOAuthService({ config: mapConfig(), secrets: memorySecrets(), connector: throwingConnector() });
    const googleResult = await google.connectAuto('google');
    expect(googleResult.error).toContain('No Google Calendar client id is configured');
    expect(googleResult.error).not.toContain('Either');
    // The key to set is named, so the operator never has to guess it.
    expect(googleResult.error).toContain('calendar.google.clientId');
    expect(googleResult.error).toContain('/calendar connect');
    expect(googleResult.error).toContain('Connect Google Calendar');
    expect(googleResult.error).toContain('/agent personal-ops');

    const microsoft = new CalendarOAuthService({ config: mapConfig(), secrets: memorySecrets(), connector: throwingConnector() });
    const microsoftResult = await microsoft.connectAuto('microsoft');
    expect(microsoftResult.error).toContain('No Microsoft Outlook client id is configured');
    expect(microsoftResult.error).toContain('calendar.microsoft.clientId');
    expect(microsoftResult.error).toContain('Connect Microsoft Outlook');
  });
});

// --- commands with an injected fake service ---------------------------------

function fakeServiceFactory(overrides: Partial<CalendarOAuthService>): CalendarServiceFactory {
  return () => overrides as unknown as CalendarOAuthService;
}

describe('calendar connect/disconnect/accounts commands', () => {
  test('connect reports an honest connected result', async () => {
    const { ctx, lines } = capturingContext();
    const factory = fakeServiceFactory({
      connectAuto: async () => ({ ok: true, transport: 'loopback', account: { provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: ['calendar.events'], connectedAt: 1 } }),
    });
    await runCalendarConnect(['connect', 'google'], ctx, factory);
    const out = lines.join('\n');
    expect(out).toContain('Connected Google Calendar');
    expect(out).toContain('user@gmail.com');
    expect(out).toContain('browser sign-in');
  });

  test('connect --device drives the device-code path and shows the user code', async () => {
    const { ctx, lines } = capturingContext();
    const factory = fakeServiceFactory({
      connectDeviceCode: async (_p, hooks) => {
        hooks?.onDeviceCode?.({ deviceCode: 'dc', userCode: 'ABCD-1234', verificationUri: 'https://ms.test/device', expiresAt: 0, intervalMs: 5000 });
        return { ok: true, transport: 'device-code', account: { provider: 'microsoft', accountId: 'microsoft', label: 'me@outlook.com', scopes: [], connectedAt: 1 } };
      },
    });
    await runCalendarConnect(['connect', 'outlook', '--device'], ctx, factory);
    const out = lines.join('\n');
    expect(out).toContain('ABCD-1234');
    expect(out).toContain('Connected Microsoft Outlook');
  });

  test('connect surfaces an honest stage failure', async () => {
    const { ctx, lines } = capturingContext();
    const factory = fakeServiceFactory({
      connectAuto: async () => ({ ok: false, stage: 'token', error: 'the provider rejected the code' }),
    });
    await runCalendarConnect(['connect', 'google'], ctx, factory);
    const out = lines.join('\n');
    expect(out).toContain('Could not connect Google Calendar (token stage)');
    expect(out).toContain('the provider rejected the code');
  });

  test('disconnect reports remote revocation honestly for each provider', async () => {
    const revoked = capturingContext();
    await runCalendarDisconnect(['disconnect', 'google'], revoked.ctx, fakeServiceFactory({ disconnect: async () => ({ revokedRemotely: true }) }));
    expect(revoked.lines.join('\n')).toContain('revoked at the provider');

    const local = capturingContext();
    await runCalendarDisconnect(['disconnect', 'outlook'], local.ctx, fakeServiceFactory({ disconnect: async () => ({ revokedRemotely: false }) }));
    expect(local.lines.join('\n')).toContain('no token-revocation endpoint');
  });

  test('accounts lists connected accounts with their honest state', async () => {
    const empty = capturingContext();
    await runCalendarAccounts(empty.ctx, fakeServiceFactory({ listAccounts: async () => [] }));
    expect(empty.lines.join('\n')).toContain('None.');

    const populated = capturingContext();
    await runCalendarAccounts(populated.ctx, fakeServiceFactory({
      listAccounts: async () => [
        { account: { provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 1 }, state: 'reconnect-needed' },
      ],
    }));
    const out = populated.lines.join('\n');
    expect(out).toContain('Google Calendar');
    expect(out).toContain('reconnect needed');
  });

  test('connect rejects an unknown provider with the short usage form', async () => {
    const { ctx, lines } = capturingContext();
    await runCalendarConnect(['connect', 'yahoo'], ctx, fakeServiceFactory({}));
    const out = lines.join('\n');
    expect(out).toContain('Usage: /calendar connect');
    expect(out).toContain("Unknown calendar provider 'yahoo'");
  });

  // F1a: a bare `/calendar connect` (no provider at all) is a dead end today
  // without a real guide, it must explain what connecting does, name both
  // providers, and (since this build always ships the SDK placeholder client
  // ids) state that honestly with the concrete next steps, not a bare usage
  // line.
  test('connect with no provider prints a real guide: what it does, both providers, and the honest no-client-id situation with next steps', async () => {
    const { ctx, lines } = capturingContext();
    await runCalendarConnect(['connect'], ctx, fakeServiceFactory({}));
    const out = lines.join('\n');
    expect(out).toContain('google');
    expect(out).toContain('outlook');
    expect(out).toContain('/calendar connect google');
    expect(out).toContain('/calendar connect outlook');
    expect(out).toContain('This build has no built-in Google/Microsoft sign-in configured');
    expect(out).toContain('Register a free OAuth app');
    expect(out).toContain('Connect Google Calendar (advanced)');
    expect(out).toContain('Connect Microsoft Outlook (advanced)');
    expect(out).toContain('/agent personal-ops');
    expect(out).not.toBe('Usage: /calendar connect <google|outlook> [--device]');
  });
});

describe('calendar OAuth service permission reading', () => {
  test('the real service/connector propagates an exact Jev permission and owned cancellation', async () => {
    const { CalendarConnector, CalendarTokenStore, providerProfile, resolveClientConfig } = await import('@goodvibes-jev/engine/sdk/platform/calendar');
    const { installJudgmentPort } = await import('@goodvibes-jev/engine/errors');
    const { fakePort, choiceAnswer, noulAnswer } = await import('@goodvibes-jev/judgment/testing');
    const fake = fakePort((name, question, state) => {
      const id = (state as { tokens: { id: string; text: string }[] }).tokens.find((token) => token.text === 'calendar.events.readonly')!.id;
      return name === 'pick' ? choiceAnswer(question, id, 0.98) : noulAnswer(name === `fits_${id}` ? 0.98 : 0.02);
    });
    const previous = installJudgmentPort(fake.port);
    try {
      const secrets = memorySecrets();
      await new CalendarTokenStore({ secrets }).save('google', { accessToken: 'synthetic-calendar-token', tokenType: 'Bearer', expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() },
        { provider: 'google', accountId: 'google', label: 'Fixture', scopes: [], connectedAt: Date.now() });
      let calls = 0;
      const connector = new CalendarConnector({ secrets, fetchImpl: async () => {
        calls++;
        return { status: 403, ok: false, header: () => null, text: async () => 'calendar.events.readonly is missing for this request.', json: async () => ({}) };
      } });
      const service = new CalendarOAuthService({ config: mapConfig(), secrets, connector });
      const config = resolveClientConfig(providerProfile('google'), { clientId: 'synthetic-client' });
      const window = { timeMin: '2026-07-01T00:00:00Z', timeMax: '2026-08-01T00:00:00Z' };
      const controller = new AbortController();
      await expect(service.listEventsForProvider(config, window, { signal: controller.signal }))
        .rejects.toMatchObject({ degraded: { kind: 'insufficient-scope', missingScope: 'calendar.events.readonly' } });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.signal).toBe(controller.signal);
      expect(JSON.stringify(fake.requests[0]?.state)).not.toContain('synthetic-calendar-token');
      controller.abort();
      await expect(service.listEvents(window, { signal: controller.signal })).rejects.toThrow();
      expect(calls).toBe(1);
    } finally { installJudgmentPort(previous); }
  });
});
