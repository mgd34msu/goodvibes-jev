import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noul, SqliteDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
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

const BATTERY = 'webui.errors.daemon-refusal' as const;
const MARKER = 'synthetic-browser-composition-marker';
const principal: AuthenticatedPrincipal = {
  principalId: 'synthetic-browser-owner', principalKind: 'user', admin: true, scopes: ['write:judgment'],
};
const questions = { session_not_found: noul('Does this fixture name a missing session?') };

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

test('the actual product graph leaves browser judgment absent without explicit installation', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const intervals = trackIntervals();
  let services: RuntimeServices | undefined;
  try {
    services = await createRuntimeServices(configuration());
    expect(services.browserJudgment).toBeUndefined();
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
    expect(events).toEqual(['browser closing', 'call aborted', 'call aborted', 'failure recorded', 'failure recorded', 'browser drained', 'log disposed']);
    expect(logDisposeCalls).toBe(1);
    for (const release of releases) release.resolve();
    await Bun.sleep(5); expect(logDisposeCalls).toBe(1);
    expect(() => services!.judgment.decisionLog.query()).toThrow();
    expect(intervals.remaining()).toEqual([]);
    // Reopen the actual product store after shutdown to prove the accepted calls
    // were durably recorded before its owned connection closed.
    const persisted = new SqliteDecisionLog(join(input.workingDir, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'decisions.sqlite'));
    try {
      const entries = persisted.query({ battery: BATTERY });
      expect(entries).toHaveLength(2);
      for (const entry of entries) expect(entry).toMatchObject({ status: 'failed', error: { kind: 'aborted' },
        context: { battery: BATTERY, batteryVersion: 1, site: 'browser.judgment' } });
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
