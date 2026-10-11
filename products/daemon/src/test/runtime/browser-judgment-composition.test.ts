import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noul, SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import type { AuthenticatedPrincipal } from '@goodvibes-jev/engine/daemon-sdk';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { BrowserJudgmentReferences, BrowserJudgmentRegistry, BrowserJudgmentService } from '@goodvibes-jev/engine/sdk/platform/judgment-browser';
import { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { JudgmentServices } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import { RuntimeEventBus } from '../../runtime/index.js';
import { createRuntimeServices, type RuntimeServices, type RuntimeServicesOptions } from '../../runtime/services.js';
import { trackIntervals } from '../helpers/intervals.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { composeBrowserJudgment } from '../../runtime/browser-judgment-composition.js';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { WEBUI_COMMAND_CATALOG_VERSION } from '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';

const BATTERY = 'webui.errors.daemon-refusal' as const;
const MARKER = 'synthetic-browser-composition-marker';
const principal: AuthenticatedPrincipal = {
  principalId: 'synthetic-browser-owner', principalKind: 'user', admin: true, scopes: ['write:judgment'],
};
const questions = { session_not_found: noul('Does this fixture name a missing session?') };

test.each(['TYPESAFE_BASE_URL', 'TYPESAFE_API_KEY', 'TYPESAFE_DEFAULT_MODEL'] as const)('fresh browser calls recover after observed %s environment changes', async (key) => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  using log = new SqliteDecisionLog(':memory:');
  let calls = 0;
  const env = { TYPESAFE_BASE_URL: 'http://127.0.0.1:9876', TYPESAFE_API_KEY: 'synthetic-first-key', TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0' };
  const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls++; entered.resolve(); await release.promise;
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: Object.fromEntries(Object.keys(input.questions).map((name) => [name, { type: 'noul', noul: 0.99 }])) as never };
  } };
  const cleanup: (() => void | Promise<void>)[] = [];
  const service = composeBrowserJudgment({ judgment: { port: withDecisionLog(inner, log), decisionLog: log }, env,
    methods: new GatewayMethodCatalog(), config: configuration().configManager, secrets: { onDidChange: () => () => {} },
    disposal: { add(_label, dispose) { cleanup.push(dispose); } },
  });
  const input = () => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.palette.command-rank', batteryVersion: 1,
    input: { query: { kind: 'inline', text: 'Synthetic query' }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION,
      candidates: [{ kind: 'builtin', commandId: 'nav.chat' }] } });
  try {
    const pending = service.execute(input(), principal, new AbortController().signal, () => principal);
    await entered.promise;
    env[key] = key === 'TYPESAFE_BASE_URL' ? 'http://127.0.0.1:9877' : key === 'TYPESAFE_DEFAULT_MODEL' ? 'jev-1.14.0' : 'synthetic-second-key';
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'JUDGMENT_PERMISSION_HELD' });
    expect(log.query()).toEqual([]);
    expect(await service.execute(input(), principal, new AbortController().signal, () => principal)).toMatchObject({ status: 'settled' });
    expect(calls).toBe(2); expect(log.query()).toHaveLength(1);
  } finally { release.resolve(); for (const dispose of cleanup.reverse()) await dispose(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Same owned config/home layout as daemon-fixture, with no server or external adapters. */
function configuration(): RuntimeServicesOptions {
  const root = makeOwnedTempDir('daemon-browser-judgment');
  const workingDir = join(root, 'workspace'); const homeDirectory = join(root, 'home');
  const cache = join(homeDirectory, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT);
  mkdirSync(workingDir, { recursive: true }); mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'benchmarks.json'), JSON.stringify({
    version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [],
  }));
  const configManager = new ConfigManager({
    configDir: join(homeDirectory, '.goodvibes', 'daemon'), workingDir, homeDir: homeDirectory,
    surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
  });
  configManager.set('judgment.model', 'jev-1.13.0');
  configManager.set('judgment.keySource', 'secret');
  return {
    configManager, workingDir, homeDirectory,
    runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
  };
}

/** Real admission/ownership with a synthetic battery; no fabricated answer or provider. */
function browserCapability(judgment: JudgmentServices, observeSignal: (signal: AbortSignal) => void = () => {}) {
  const references = new BrowserJudgmentReferences();
  const errorRef = references.issue({
    principalId: principal.principalId, battery: BATTERY, revision: 'synthetic-source-1',
    expiresAt: Date.now() + 60_000, snapshot: { message: MARKER },
    mayRead: () => true, assertCurrent() {},
  });
  const registry = new BrowserJudgmentRegistry();
  registry.register({
    id: BATTERY, version: 1, questions, maxCalls: 1,
    resolve: async (input, context) => references.resolve(input.errorRef, context.currentPrincipal, BATTERY,
      (snapshot) => snapshot as { message: string }),
    run: (port, state, { signal }) => { observeSignal(signal); return port.ask({ state, questions, signal }); },
    project() { throw new Error('The missing-key fixture must never project an answer'); },
  });
  const service = new BrowserJudgmentService({
    registry, references,
    currentRoute: () => ({ revision: 'synthetic-route-1', kind: 'local', port: judgment.port, assertCurrent() {} }),
    authorize: () => true,
  });
  const request = { protocolVersion: 1, requestId: crypto.randomUUID(), battery: BATTERY, batteryVersion: 1, input: { errorRef } };
  return { service, request, references, errorRef };
}

test('the actual product graph installs the closed browser registry without a provider credential', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const intervals = trackIntervals();
  let services: RuntimeServices | undefined;
  try {
    services = await createRuntimeServices(configuration());
    expect(services.browserJudgment).toBeDefined();
    expect(services.judgment.port.recorder).toBeDefined();
    await services.close();
    expect(intervals.remaining()).toEqual([]);
  } finally { try { await services?.close(); } finally { intervals.restore(); discovery.mockRestore(); } }
}, 30_000);

test('the product injects its recorded port and aborts/drains accepted browser calls before disposing its log', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const intervals = trackIntervals(); const input = configuration();
  const entered = deferred(); const releases = [deferred(), deferred()]; const aborted = deferred();
  const events: string[] = []; const restore: (() => void)[] = [];
  let services: RuntimeServices | undefined; let received: JudgmentServices | undefined;
  let browser: ReturnType<typeof browserCapability> | undefined; const runSignals: AbortSignal[] = [];
  let factoryCalls = 0; let browserCloseCalls = 0; let logDisposeCalls = 0; let keyLookups = 0; let aborts = 0;
  try {
    services = await createRuntimeServices({ ...input, createBrowserJudgment(judgment) {
      factoryCalls++; received = judgment;
      expect(judgment.port).toBe(judgmentPort('synthetic-browser-composition'));
      expect(judgment.port.recorder).toBeDefined();
      const record = judgment.decisionLog.record.bind(judgment.decisionLog);
      const recordSpy = spyOn(judgment.decisionLog, 'record').mockImplementation((entry) => {
        const id = record(entry); events.push('failure recorded'); return id;
      });
      const dispose = judgment.decisionLog[Symbol.dispose].bind(judgment.decisionLog);
      const disposeSpy = spyOn(judgment.decisionLog, Symbol.dispose).mockImplementation(() => {
        logDisposeCalls++; events.push('log disposed'); dispose();
      });
      browser = browserCapability(judgment, (signal) => {
        runSignals.push(signal);
        signal.addEventListener('abort', () => {
          events.push('call aborted'); if (++aborts === releases.length) aborted.resolve();
        }, { once: true });
      });
      const close = browser.service.close.bind(browser.service);
      const closeSpy = spyOn(browser.service, 'close').mockImplementation(() => {
        browserCloseCalls++; events.push('browser closing');
        return close().then(() => { events.push('browser drained'); });
      });
      restore.push(() => recordSpy.mockRestore(), () => disposeSpy.mockRestore(), () => closeSpy.mockRestore());
      return browser.service;
    } });
    expect(factoryCalls).toBe(1);
    expect(received).toBe(services.judgment);
    expect(services.browserJudgment).toBe(browser!.service);
    // Hold only the actual port's configured key acquisition. No credentials are
    // supplied and a missing key cannot start external inference. The real
    // recording wrapper remains in place throughout cancellation; a secret
    // getter that ignores it cannot strand accepted calls or the owned log.
    const secrets = spyOn(services.secretsManager, 'get').mockImplementation(async (key) => {
      if (key !== 'TYPESAFE_API_KEY') return null;
      const release = releases[keyLookups++];
      if (keyLookups === releases.length) entered.resolve();
      await release!.promise; return null;
    });
    restore.push(() => secrets.mockRestore());
    const pending = releases.map(() => services!.browserJudgment!.execute(
      { ...browser!.request, requestId: crypto.randomUUID() }, principal, new AbortController().signal, () => principal,
    ).catch((error: unknown) => error));
    await entered.promise;
    expect(runSignals).toHaveLength(2);
    expect(runSignals.every((signal) => !signal.aborted)).toBe(true);
    expect(services.judgment.decisionLog.query({ battery: BATTERY })).toEqual([]);

    let closed = false;
    const closing = services.close();
    expect(services.close()).toBe(closing);
    void closing.then(() => { closed = true; });
    await aborted.promise;
    expect(runSignals.every((signal) => signal.aborted)).toBe(true);
    expect(browserCloseCalls).toBe(1);
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ code: 'JUDGMENT_SHUTTING_DOWN' });
    await expect(browser!.service.execute(browser!.request, principal, new AbortController().signal, () => principal))
      .rejects.toMatchObject({ code: 'JUDGMENT_SHUTTING_DOWN' });
    expect(() => browser!.references.resolve(browser!.errorRef, () => principal, BATTERY, (state) => state)).toThrow();

    // Shutdown finishes while both key lookups are still pending. Their late
    // completion cannot restart work or write to a closed decision log.
    await closing;
    expect(closed).toBe(true);
    expect(events).toEqual(['browser closing', 'call aborted', 'call aborted', 'browser drained', 'log disposed']);
    expect(logDisposeCalls).toBe(1);
    for (const release of releases) release.resolve();
    await Bun.sleep(5); expect(logDisposeCalls).toBe(1);
    expect(() => services!.judgment.decisionLog.query()).toThrow();
    expect(intervals.remaining()).toEqual([]);
    // Reopen the actual product store: revoked browser snapshots must not
    // acquire source-bearing failure rows while the log drains and closes.
    const persisted = new SqliteDecisionLog(join(input.workingDir, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'decisions.sqlite'));
    try {
      const entries = persisted.query({ battery: BATTERY });
      expect(entries).toHaveLength(0);
      expect(JSON.stringify(entries)).not.toContain(MARKER);
    } finally { persisted[Symbol.dispose](); }
    await services.close(); expect(browserCloseCalls).toBe(1); expect(logDisposeCalls).toBe(1);
  } finally {
    for (const release of releases) release.resolve();
    try { await services?.close(); }
    finally { for (const dispose of restore.reverse()) dispose(); intervals.restore(); discovery.mockRestore(); }
  }
}, 30_000);

test.each(['browser', 'inbox'] as const)('failed %s factory acquisition releases the product-owned graph and permits reusing its config', async (failureAt) => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const intervals = trackIntervals(); const input = configuration();
  const failure = new Error(`synthetic ${failureAt} acquisition failure`);
  const previousPort: JudgmentPort = { model: 'jev-1.13.0', async ask() { throw new Error('Unexpected fixture judgment'); } };
  const originalPort = installJudgmentPort(previousPort);
  const subscribe = input.configManager.subscribe.bind(input.configManager);
  const live = new Set<object>(); const restore: (() => void)[] = [];
  const observation = spyOn(input.configManager, 'subscribe').mockImplementation((key, listener) => {
    const release = subscribe(key as never, listener as never); const token = {}; live.add(token);
    return () => { live.delete(token); release(); };
  });
  let received: JudgmentServices | undefined; let browser: ReturnType<typeof browserCapability> | undefined;
  let rebuilt: RuntimeServices | undefined; let browserCloseCalls = 0; let logDisposeCalls = 0;
  const events: string[] = [];
  try {
    await expect(createRuntimeServices({ ...input,
      createBrowserJudgment(judgment) {
        received = judgment;
        expect(judgmentPort('synthetic-browser-acquisition')).toBe(judgment.port);
        expect(live.size).toBeGreaterThan(0);
        const dispose = judgment.decisionLog[Symbol.dispose].bind(judgment.decisionLog);
        const disposeSpy = spyOn(judgment.decisionLog, Symbol.dispose).mockImplementation(() => {
          logDisposeCalls++; events.push('log disposed'); dispose();
        });
        restore.push(() => disposeSpy.mockRestore());
        if (failureAt === 'browser') throw failure;
        browser = browserCapability(judgment);
        const close = browser.service.close.bind(browser.service);
        const closeSpy = spyOn(browser.service, 'close').mockImplementation(() => {
          browserCloseCalls++; return close().then(() => { events.push('browser drained'); });
        });
        restore.push(() => closeSpy.mockRestore());
        return browser.service;
      },
      inboxFactory() {
        expect(failureAt).toBe('inbox'); expect(intervals.count).toBeGreaterThan(0); throw failure;
      },
    })).rejects.toBe(failure);
    expect(received).toBeDefined();
    expect(logDisposeCalls).toBe(1);
    expect(browserCloseCalls).toBe(failureAt === 'inbox' ? 1 : 0);
    expect(events).toEqual(failureAt === 'inbox' ? ['browser drained', 'log disposed'] : ['log disposed']);
    expect(() => received!.decisionLog.query()).toThrow();
    expect(judgmentPort('synthetic-after-rollback')).toBe(previousPort);
    expect(live.size).toBe(0);
    expect(intervals.remaining()).toEqual([]);
    if (browser) {
      await expect(browser.service.execute(browser.request, principal, new AbortController().signal, () => principal))
        .rejects.toMatchObject({ code: 'JUDGMENT_SHUTTING_DOWN' });
    }

    rebuilt = await createRuntimeServices({ ...input, createBrowserJudgment: (judgment) => browserCapability(judgment).service });
    expect(rebuilt.browserJudgment).toBeDefined();
    expect(rebuilt.judgment.port).not.toBe(received!.port);
    expect(rebuilt.judgment.decisionLog.query()).toEqual([]);
    expect(live.size).toBeGreaterThan(0);
    await rebuilt.close();
    expect(live.size).toBe(0);
    expect(intervals.remaining()).toEqual([]);
    expect(judgmentPort('synthetic-after-retry')).toBe(previousPort);
  } finally {
    try { await rebuilt?.close(); }
    finally {
      for (const dispose of restore.reverse()) dispose(); observation.mockRestore();
      intervals.restore(); discovery.mockRestore(); installJudgmentPort(originalPort);
    }
  }
}, 30_000);

test('default configured browser policy admits only the issued mail-subject purpose and fences source retirement', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const calls: unknown[] = [];
  const source = new AbortController();
  const cleanup: (() => void | Promise<void>)[] = [];
  const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state);
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: { already_reply: { type: 'noul', noul: 0.99 } } as never };
  } };
  const service = composeBrowserJudgment({ judgment: { port: withDecisionLog(inner, log), decisionLog: log }, env: {},
    methods: new GatewayMethodCatalog(), config: configuration().configManager, secrets: { onDidChange: () => () => {} },
    disposal: { add(_label, dispose) { cleanup.push(dispose); } },
  });
  try {
    const subjectRef = service.issueMailSubjectReference({ principal, snapshot: { revision: 'synthetic-canonical-read', subject: 'AW: Synthetic note', signal: source.signal, assertCurrent: () => source.signal.throwIfAborted() } });
    expect(subjectRef).toBeString();
    const request = { protocolVersion: 1, batteryVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.mail.reply-subject', input: { subjectRef } };
    expect(await service.execute(request, principal, new AbortController().signal, () => principal)).toMatchObject({ status: 'settled', value: { alreadyReply: true } });
    expect(calls).toEqual([{ subject: 'AW: Synthetic note' }]);
    expect(log.query()).toHaveLength(1);
    source.abort();
    await expect(service.execute({ ...request, requestId: crypto.randomUUID() }, principal, new AbortController().signal, () => principal)).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
    expect(calls).toHaveLength(1);
  } finally { for (const dispose of cleanup.reverse()) await dispose(); }
});

test.each(['webui.config.credential-key', 'webui.settings.card-material-key'] as const)('%s uses the product config incarnation and never its values', async battery => {
  using log = new SqliteDecisionLog(':memory:');
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const calls: unknown[] = []; const cleanup: (() => void | Promise<void>)[] = [];
  const config = configuration().configManager;
  const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state); entered.resolve(); await release.promise;
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: { [battery === 'webui.config.credential-key' ? 'credential' : 'material']: { type: 'noul', noul: 0.001 } } as never };
  } };
  const service = composeBrowserJudgment({ judgment: { port: withDecisionLog(inner, log), decisionLog: log }, env: {},
    methods: new GatewayMethodCatalog(), config, secrets: { onDidChange: () => () => {} },
    disposal: { add(_label, dispose) { cleanup.push(dispose); } },
  });
  const request = () => ({ protocolVersion: 1, batteryVersion: 1, requestId: crypto.randomUUID(), battery, input: { keys: ['display.stream'] } });
  try {
    const pending = service.execute(request(), principal, new AbortController().signal, () => principal);
    const observed = pending.then(() => 'unexpected-settled', () => 'held');
    await entered.promise;
    config.set('display.stream', !config.get('display.stream'));
    release.resolve(); expect(await observed).toBe('held'); expect(log.query()).toEqual([]);
    expect(await service.execute(request(), principal, new AbortController().signal, () => principal)).toMatchObject({ status: 'settled', value: { matches: [false] } });
    expect(calls).toEqual([{ key: 'display.stream', description: 'Stream LLM tokens as they arrive' }, { key: 'display.stream', description: 'Stream LLM tokens as they arrive' }]);
    expect(log.query()).toHaveLength(1);
  } finally { release.resolve(); for (const dispose of cleanup.reverse()) await dispose(); }
});

test('daemon composition explicitly authorizes canonical chat speech seams on the configured judgment route', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const content = 'Dr. Rivera paused. Next came silence.'; const calls: unknown[] = [];
  const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state);
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: Object.fromEntries(Object.keys(input.questions).map(name => [name, { type: 'noul', noul: 0.999 }])) as never };
  } };
  const cleanup: (() => void | Promise<void>)[] = [];
  const service = composeBrowserJudgment({ judgment: { port: withDecisionLog(inner, log), decisionLog: log },
    env: { TYPESAFE_BASE_URL: 'http://127.0.0.1:9876', TYPESAFE_API_KEY: 'synthetic-speech-key', TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0' },
    methods: new GatewayMethodCatalog(), config: configuration().configManager, secrets: { onDidChange: () => () => {} },
    disposal: { add(_label, dispose) { cleanup.push(dispose); } },
  });
  const session = { id: 'speech-chat', title: 'Synthetic', createdAt: 1, updatedAt: 2 };
  const message = { id: 'speech-message', sessionId: session.id, content, createdAt: 3 };
  const release = service.bindChatSessions({ getSession: id => id === session.id ? session : null, getMessages: () => [message] });
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
    const contentDigest = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const result = await service.execute({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.voice.speech-seams', batteryVersion: 1,
      input: { sessionId: session.id, messageId: message.id, start: 0, end: content.length, cursor: 0, contentDigest } }, principal, new AbortController().signal, () => principal);
    expect(result).toMatchObject({ status: 'settled', battery: 'webui.voice.speech-seams' }); expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ paragraph: content });
  } finally { release(); for (const dispose of cleanup.reverse()) await dispose(); }
});

test.each(['config', 'credentials', 'registry'] as const)('catalog browser composition retires the actual %s owner before publishing', async kind => {
  using log = new SqliteDecisionLog(':memory:');
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const calls: unknown[] = []; const cleanup: (() => void | Promise<void>)[] = [];
  const config = configuration().configManager;
  let generation = 0; let changed: (key: string) => void = () => {};
  const registry = { captureProviderCatalogIds() {
    const epoch = generation;
    return { providerIds: ['inception'], catalogProviderIds: ['inceptionlabs'], assertCurrent() { if (epoch !== generation) throw new Error('Changed source'); } };
  } };
  const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state); entered.resolve(); await release.promise;
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: { matches: { type: 'noul', noul: 0.999 } } } as never;
  } };
  const service = composeBrowserJudgment({ judgment: { port: withDecisionLog(inner, log), decisionLog: log }, env: {},
    methods: new GatewayMethodCatalog(), config, providers: () => registry,
    secrets: { onDidChange(listener) { changed = listener; return () => {}; } },
    disposal: { add(_label, dispose) { cleanup.push(dispose); } },
  });
  const request = () => ({ protocolVersion: 1, batteryVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.models.catalog-provider-match', input: { providerId: 'inception', keys: ['inceptionlabs'] } });
  try {
    const result = service.execute(request(), principal, new AbortController().signal, () => principal).then(() => 'published', () => 'held');
    await entered.promise;
    if (kind === 'config') config.set('display.stream', !config.get('display.stream'));
    if (kind === 'credentials') changed('fixture-key');
    if (kind === 'registry') generation++;
    release.resolve(); expect(await result).toBe('held'); expect(log.query()).toEqual([]);
    expect(await service.execute(request(), principal, new AbortController().signal, () => principal)).toMatchObject({ status: 'settled', value: { matches: [true] } });
    expect(calls).toEqual([{ providerId: 'inception', key: 'inceptionlabs' }, { providerId: 'inception', key: 'inceptionlabs' }]);
  } finally { release.resolve(); for (const dispose of cleanup.reverse()) await dispose(); }
});
