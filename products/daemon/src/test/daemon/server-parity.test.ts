/**
 * Source parity with daemon254699bf5d834cdca41436211ada1ae32bf89258.
 * The product runtime graph and real HTTP listeners are composed here. Only
 * external discovery/catalog transport, recorded Jev fixture readings, and TLS
 * option observation are synthetic. Root admission is held at its real cancellable
 * judgment boundary so queue/visibility assertions never claim model completion.
 * Historical cases 34/55 are adapted to current exact-owner transport semantics;
 * each also executes a real autonomous tool through canonical admission without
 * a human approval. No live-provider calibration or external delivery is claimed.
 */
import { executeToolCalls } from '@goodvibes-jev/engine/sdk/platform/core';
import { Client } from 'undici/index.js';
import { createSlackInboxOwner } from '@goodvibes-jev/engine/sdk/platform/intake';
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonServer, HttpListener } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { ProviderRegistry, BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { RuntimeEventBus, createFeatureFlagManager, deriveFeatureStates, type TransportEvent } from '../../runtime/index.js';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.js';
import { createProductionDaemonInboxFactory } from '../../runtime/production-inbox-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { installProviderPricingFixture } from '../helpers/provider-pricing-fixture.js';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { buildOperatorContract } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createHmac } from 'node:crypto';
import { GOODVIBES_NTFY_AGENT_TOPIC } from '@goodvibes-jev/engine/sdk/platform/integrations';
const parityReadings = fakePort((name, question, state) => {
  if (name === 'security_code' || name === 'wanted' || name === 'serve' || name === 'keep' || name === 'attached') return noulAnswer(0.01);
  if (name === 'pick' && question.type === 'choice' && 'title-1' in question.criteria) return choiceAnswer(question, 'title-1', 0.99);
  if (name === 'memory_class') return choiceAnswer(question, 'fact', 0.99);
  if (name === 'reading') return choiceAnswer(question, 'approve', 0.99);
  if (name === 'fits_0') return noulAnswer(0.99);
  if (name === 'supported') return noulAnswer(0.99);
  if (name === 'main_1' && (state as { title?: string }).title === 'Knowledge Route Page') return noulAnswer(0.99);
  if (name === 'excerptUseful') {
    const excerpts: readonly string[] = [
      "Daemon route coverage. Knowledge Route Page\nDaemon route coverage.",
      "Knowledge Route Page\nDaemon route coverage.",
      "Knowledge Route Page",
      "Daemon route coverage. Knowledge Route Page\nDaemon route coverage.\n\nKnowledge Route Page\nDaemon route coverage.\n\nKnowledge Route Page\n\nDaemon route coverage. Knowledge Route Page\nDaemon route coverage.\n\nKnowledge Route Page\nDaemon route coverage.\n\nKnowledge Route Page\n\nKnowledge Route Page\nDaemon route coverage."
    ];
    return noulAnswer(excerpts.includes((state as { candidate: { text: string } }).candidate.text) ? 0.99 : 0.01);
  }
  if (name === 'kind' && question.type === 'choice' && 'document' in question.criteria) {
    const mimeType = (state as { mimeType: string }).mimeType;
    if (['text/html', 'text/markdown', 'text/plain'].includes(mimeType)) return choiceAnswer(question, 'document', 0.99);
    if (['text/csv', 'application/json'].includes(mimeType)) return choiceAnswer(question, 'data', 0.99);
  }
  if (name === 'useful') {
    const title = (state as { candidate?: { title?: string } }).candidate?.title;
    return noulAnswer(title === 'Knowledge Route Page' ? 0.99 : 0.01);
  }
  throw new Error(`Unscripted parity judgment: ${name}`);
});
const TEST_TOKEN = 'server-parity-synthetic-token';
async function waitFor<T>(fn: () => Promise<T | undefined | null> | T | undefined | null, timeoutMs = 5_000, intervalMs = 25): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for value');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function waitForSocketFrame(
  socket: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      reject(new Error('Timed out waiting for WebSocket frame'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };

    const onError = () => {
      cleanup();
      reject(new Error('WebSocket error'));
    };

    const onMessage = (event: MessageEvent<string>) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(frame)) return;
      cleanup();
      resolve(frame);
    };

    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}


function createAuthenticatedWebSocket(token: string) {
  return class extends WebSocket {
    constructor(url: string) { super(url, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[]); }
  };
}

describe('daemon server source parity: restored source assertions', () => {
  let daemon: DaemonServer;
  let tempRoot: string;
  let workingDir: string;
  let homeDir: string;
  let configDir: string;
  let runtimeServices: RuntimeServices;
  let boundPort = 0;
  const servers: DaemonServer[] = [];
  const rootSignals: AbortSignal[] = [];
  const graphs: RuntimeServices[] = [];
  const restores: (() => void)[] = [];
  const capturingServe = ((options) => {
    const server = Bun.serve(options);
    if (server.port !== undefined) boundPort = server.port;
    return server;
  }) as typeof Bun.serve;
  const makeConfig = () => new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir, homeDir });
  const makeFeatureFlags = () => {
    const featureFlags = createFeatureFlagManager();
    const flags = deriveFeatureStates(makeConfig());
    for (const id of ['automation-domain', 'control-plane-gateway', 'delivery-engine', 'hitl-ux-modes',
      'ntfy-surface', 'permission-divergence-dashboard', 'policy-as-code', 'route-binding',
      'service-management', 'slack-surface', 'unified-runtime-task', 'watcher-framework', 'web-surface', 'webhook-surface']) flags[id] = 'enabled';
    featureFlags.loadFromConfig({ flags });
    return featureFlags;
  };
  const makeUserAuth = () => new UserAuthManager({
    bootstrapFilePath: join(homeDir, 'auth-users.json'),
    bootstrapCredentialPath: join(homeDir, 'auth-bootstrap.txt'),
    users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
  });
  async function createTestDaemon(options: {
    readonly configManager?: ConfigManager; readonly runtimeServices?: RuntimeServices;
    readonly userAuth?: UserAuthManager; readonly serveFactory?: typeof Bun.serve;
    readonly runtimeBus?: RuntimeEventBus; readonly port?: number; readonly host?: string;
  } = {}): Promise<DaemonServer> {
    const config = options.configManager ?? makeConfig();
    let inboxFactory = createProductionDaemonInboxFactory();
    if (config.get('surfaces.slack.enabled') === true) {
      const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/api/auth.test') return Response.json({ ok: true, team_id: 'workspace-1', user_id: 'U123' });
        if (path === '/api/conversations.list') return Response.json({ ok: true, channels: [] });
        throw new Error(`Unscripted Slack fixture request: ${path}`);
      } });
      restores.push(() => provider.stop(true));
      inboxFactory = createProductionDaemonInboxFactory({ slack: {
        account: { workspaceId: 'workspace-1', userId: 'U123' },
        screening: {
          authority: { ownerId: 'server-parity-local-screening', revision: 'one', retention: 'ephemeral-no-log', signal: new AbortController().signal, assertCurrent() {} },
          proposal: { endpoint: `http://127.0.0.1:${provider.port}`, model: 'synthetic-proposer' },
          judgment: { endpoint: `http://127.0.0.1:${provider.port}`, model: 'jev-1.13.0' },
        },
      } }, { slack: { createOwner(context, ownerOptions) {
        return createSlackInboxOwner(context, ownerOptions, { createHttpClient(origin, clientOptions) {
          expect(origin).toBe('https://slack.com');
          return new Client(`http://127.0.0.1:${provider.port}`, clientOptions);
        } });
      } } });
    }
    const services = options.runtimeServices ?? await createRuntimeServices({
      inboxFactory,
      runtimeStore: createRuntimeStore(), runtimeBus: options.runtimeBus ?? new RuntimeEventBus(),
      configManager: config, workingDir, homeDirectory: homeDir,
      featureFlags: makeFeatureFlags(), getConversationTitle: () => 'Server parity',
    });
    if (!graphs.includes(services)) { graphs.push(services); await services.startCluster(); }
    const server = new DaemonServer({ port: options.port ?? 0, host: options.host ?? '127.0.0.1',
      userAuth: options.userAuth ?? makeUserAuth(), runtimeServices: services,
      serveFactory: options.serveFactory ?? capturingServe, runtimeBus: options.runtimeBus ?? services.runtimeBus,
      hasOverriddenHome: true, clusterCoordinator: services.clusterCoordinator,
      clusterGroupVerbs: services.clusterGroup.verbs, paymentReplies: services.daemonHandlers.paymentReplies,
    });
    servers.push(server); runtimeServices = services;
    const scripted: typeof parityReadings.port = { model: parityReadings.port.model, ask(request) {
      if ('forbids_delegation' in request.questions) {
        if (!request.signal) throw new Error('Root admission must carry cancellation');
        const signal = request.signal;
        rootSignals.push(signal);
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('Owned parity admission cancelled', 'AbortError'));
          if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        });
      }
      return parityReadings.port.ask(request);
    } };
    const previous = installJudgmentPort(withDecisionLog(scripted, services.judgment.decisionLog)); restores.push(() => { installJudgmentPort(previous); });
    const judgmentSpy = spyOn(services.judgment.port, 'ask').mockImplementation(request => scripted.ask(request));
    restores.push(() => judgmentSpy.mockRestore());
    return server;
  }
  beforeEach(async () => {
    rootSignals.length = 0;
    tempRoot = makeOwnedTempDir('server-parity'); workingDir = join(tempRoot, 'workspace');
    homeDir = join(tempRoot, 'home'); configDir = join(homeDir, '.goodvibes', 'tui');
    mkdirSync(workingDir, { recursive: true }); mkdirSync(configDir, { recursive: true });
    for (const spy of [spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]),
      spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined),
      spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined)]) restores.push(() => spy.mockRestore());
    restores.push(installProviderPricingFixture());
    daemon = await createTestDaemon();
  });
  afterEach(async () => {
    try { for (const server of servers.splice(0).reverse()) await server.stop(); }
    finally {
      try { for (const graph of graphs.splice(0).reverse()) await graph.close(); }
      finally { for (const restore of restores.splice(0).reverse()) restore(); }
    }
  });

async function proveAutonomousRead(): Promise<void> {
    const path = join(workingDir, 'autonomous-proof.txt');
    writeFileSync(path, 'owned autonomous server parity receipt\n');
    const readings = fakePort((name, question) => {
      if (name === 'disposition') return choiceAnswer(question, 'act', 0.99);
      if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.99);
      if (name === 'kind') return choiceAnswer(question, 'other', 0.99);
      if (name === 'hazard') return choiceAnswer(question, 'none', 0.99);
      if (name === 'category') return choiceAnswer(question, 'lasting', 0.99);
      if (name === 'names_path' || name === 'owned_targets') return noulAnswer(0.99);
      if (question.type === 'noul') return noulAnswer(0.01);
      throw new Error(`Unexpected autonomous read question: ${name}`);
    });
    const recorded = withDecisionLog(readings.port, runtimeServices.judgment.decisionLog);
    const previous = installJudgmentPort(recorded);
    const port = spyOn(runtimeServices.judgment.port, 'ask').mockImplementation(request => recorded.ask(request));
    const humans = spyOn(runtimeServices.approvalBroker, 'requestApproval').mockImplementation(async () => { throw new Error('Autonomous read must not ask a person'); });
    try {
      const results = await executeToolCalls({
        autonomousSource: () => ({ goal: 'Read only the owned autonomous-proof.txt fixture', criteria: ['No network, writes or human wait'] }),
        permissionManager: runtimeServices.permissionManager,
        toolRegistry: runtimeServices.agentOrchestrator.getToolRegistry(), hookDispatcher: null,
        runtimeBus: runtimeServices.runtimeBus, sessionId: 'server-parity-autonomous',
        emitterContext: () => ({ sessionId: 'server-parity-autonomous', traceId: 'server-parity', source: 'orchestrator' }),
      }, 'server-parity-read', [{ id: 'server-parity-read', name: 'read', arguments: { files: [{ path }] } }]);
      expect(results[0]?.success).toBe(true);
      expect(results[0]?.output).toContain('owned autonomous server parity receipt');
      expect(humans).not.toHaveBeenCalled();
      expect(readings.requests.some(request => 'disposition' in request.questions)).toBe(true);
    } finally { humans.mockRestore(); port.mockRestore(); installJudgmentPort(previous); }
  }

  // Original server case 1, source line 203.
  test('isRunning is false before start', () => {
    expect(daemon.isRunning).toBe(false);
  });

  // Original server case 2, source line 207.
  test('refuses to start when disabled (default state)', async () => {
    await daemon.start();
    expect(daemon.isRunning).toBe(false);
  });

  // Original server case 3, source line 212.
  test('enable returns false when danger.daemon is false', () => {
    const result = daemon.enable({ daemon: false }, TEST_TOKEN);
    expect(result).toBe(false);
  });

  // Original server case 4, source line 217.
  test('enable returns true when danger.daemon is true', () => {
    const result = daemon.enable({ daemon: true }, TEST_TOKEN);
    expect(result).toBe(true);
  });

  // Original server case 5, source line 222.
  test('starts when enabled', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    expect(daemon.isRunning).toBe(true);
  });

  // Original server case 6, source line 228.
  test('passes TLS options to Bun.serve when direct daemon TLS is enabled', async () => {
    const certDir = join(homeDir, '.goodvibes', 'tui', 'certs');
    mkdirSync(certDir, { recursive: true });
    const certFile = join(certDir, 'fullchain.pem');
    const keyFile = join(certDir, 'privkey.pem');
    writeFileSync(certFile, 'CERT\n', 'utf-8');
    writeFileSync(keyFile, 'KEY\n', 'utf-8');
    const config = makeConfig();
    config.set('controlPlane.tls.mode', 'direct');
    let capturedOptions: Record<string, unknown> | null = null;
    const serveFactory = mock((options: unknown) => {
      capturedOptions = options as Record<string, unknown>;
      return {
      stop: mock(() => {}),
      port: (capturedOptions as Record<string, unknown>).port,
      hostname: (capturedOptions as Record<string, unknown>).hostname,
    };
    });
    daemon = await createTestDaemon({
      configManager: config,
      userAuth: makeUserAuth(),
      serveFactory: serveFactory as unknown as typeof Bun.serve,
    });

    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    expect(serveFactory).toHaveBeenCalledTimes(1);
    expect(capturedOptions).toMatchObject({
      port: 0,
      hostname: '127.0.0.1',
      tls: {
        cert: Bun.file(certFile),
        key: Bun.file(keyFile),
      },
    });
  });

  // Original server case 7, source line 266.
  test('emits transport lifecycle when starting and stopping', async () => {
    const runtimeBus = new RuntimeEventBus();
    const transportEvents: TransportEvent[] = [];
    runtimeBus.onDomain('transport', ({ payload }) => transportEvents.push(payload));
    daemon = await createTestDaemon({
      userAuth: makeUserAuth(),
      runtimeBus,
    });

    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    await daemon.stop();

    // Transport IDs/endpoints are built from the CONFIGURED port, which is 0
    // here (ephemeral bind). DaemonServer never rewrites this.port to the OS-
    // assigned port, so these strings stay deterministically ':0', the real
    // bound port is captured separately (boundPort) for the fetch-based tests.
    expect(transportEvents).toEqual([
      {
        type: 'TRANSPORT_INITIALIZING',
        transportId: 'daemon:http:127.0.0.1:0',
        protocol: 'http-daemon',
      },
      {
        type: 'TRANSPORT_CONNECTED',
        transportId: 'daemon:http:127.0.0.1:0',
        endpoint: 'http://127.0.0.1:0',
      },
      {
        type: 'TRANSPORT_DISCONNECTED',
        transportId: 'daemon:http:127.0.0.1:0',
        reason: 'Daemon server stopped',
        willRetry: false,
      },
    ]);
  });

  // Original server case 8, source line 303.
  test('start is idempotent; does not throw when called twice', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    await daemon.start(); // second call should be a no-op
    expect(daemon.isRunning).toBe(true);
  });

  // Original server case 9, source line 310.
  test('stop works when running', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    await daemon.stop();
    expect(daemon.isRunning).toBe(false);
  });

  // Original server case 10, source line 317.
  test('stop is safe when not running', async () => {
    // Should not throw
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(daemon.isRunning).toBe(false);
  });

  // Original server case 11, source line 323.
  test('GET /status returns 401 without token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/status`);
    expect(res.status).toBe(401);
  });

  // Original server case 12, source line 330.
  test('POST /login returns session token for valid credentials', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(typeof body.token).toBe('string');
    expect(res.headers.get('set-cookie')).toContain('goodvibes_session=');
  });

  // Original server case 13, source line 345.
  test('session cookies authenticate REST and SSE control-plane requests', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();
    const login = await fetch(`http://127.0.0.1:${boundPort}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    expect(login.status).toBe(200);
    const sessionCookie = login.headers.get('set-cookie');
    expect(sessionCookie).toContain('goodvibes_session=');
    const cookieHeader = sessionCookie!.split(';', 1)[0];

    const snapshot = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane`, {
      headers: { Cookie: cookieHeader },
    });
    expect(snapshot.status).toBe(200);

    const stream = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/events?domains=control-plane`, {
      headers: { Cookie: cookieHeader },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    const firstChunk = await reader!.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain('event: ready');
    await reader!.cancel();
  });

  // Original server case 14, source line 374.
  test('control-plane auth introspection reports anonymous, shared-token, and session-cookie principals', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const anonymous = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/auth`);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({
      authenticated: false,
      authMode: 'anonymous',
      tokenPresent: false,
      authorizationHeaderPresent: false,
      sessionCookiePresent: false,
      principalId: null,
      principalKind: null,
      admin: false,
      scopes: [],
      roles: [],
    });

    const shared = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/auth`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(shared.status).toBe(200);
    const sharedBody = await shared.json() as {
      authenticated: boolean;
      authMode: string;
      principalId: string | null;
      principalKind: string | null;
      admin: boolean;
      scopes: string[];
    };
    expect(sharedBody.authenticated).toBe(true);
    expect(sharedBody.authMode).toBe('shared-token');
    expect(sharedBody.principalId).toBe('shared-token');
    expect(sharedBody.principalKind).toBe('token');
    expect(sharedBody.admin).toBe(true);
    expect(sharedBody.scopes).toContain('read:control-plane');
    expect(sharedBody.scopes).toContain('read:telemetry');

    await daemon.stop();
    daemon.enable({ daemon: true });
    await daemon.start();

    const login = await fetch(`http://127.0.0.1:${boundPort}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const sessionCookie = login.headers.get('set-cookie');
    expect(sessionCookie).toContain('goodvibes_session=');
    const cookieHeader = sessionCookie!.split(';', 1)[0];

    const session = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/auth`, {
      headers: { Cookie: cookieHeader },
    });
    expect(session.status).toBe(200);
    const sessionBody = await session.json() as {
      authenticated: boolean;
      authMode: string;
      sessionCookiePresent: boolean;
      principalId: string | null;
      principalKind: string | null;
      roles: string[];
    };
    expect(sessionBody.authenticated).toBe(true);
    expect(sessionBody.authMode).toBe('session');
    expect(sessionBody.sessionCookiePresent).toBe(true);
    expect(sessionBody.principalId).toBe('admin');
    expect(sessionBody.principalKind).toBe('user');
    expect(sessionBody.roles).toContain('admin');
  });

  // Original server case 15, source line 446.
  test('control-plane event streams no longer accept auth tokens in query parameters', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const stream = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/events?token=${TEST_TOKEN}&domains=control-plane`);
    expect(stream.status).toBe(401);
  });

  // Original server case 16, source line 453.
  test('knowledge routes ingest and query structured knowledge', async () => {
    const sourceUrl = 'https://example.com/knowledge-route-page';
    const sourceUrlList = `${sourceUrl}?connector=1`;
    const sourceHtml = '<html><head><title>Knowledge Route Page</title></head><body><h1>Knowledge Route Page</h1><p>Daemon route coverage.</p></body></html>';
    const originalFetch = globalThis.fetch;
    const mockFetch = async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === sourceUrl || url === sourceUrlList) {
        return new Response(sourceHtml, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    try {
      const ingest = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/ingest/url`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: sourceUrl, sessionId: 'session-1' }),
    });
    expect(ingest.status, ingest.status === 201 ? undefined : (await ingest.clone().text()).slice(0, 500)).toBe(201);
    const ingested = await ingest.json() as { source: { id: string } };
    expect(ingested.source.id).toBeTruthy();

    await waitFor(async () => {
      const results = await runtimeServices.knowledgeService.search('Knowledge Route Page');
      return results.length > 0 ? results : null;
    });
    const search = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'Knowledge Route Page' }),
    });
    expect(search.status, search.status === 200 ? undefined : (await search.clone().text()).slice(0, 500)).toBe(200);
    const searchJson = await search.json() as { results: Array<{ id: string }> };
    expect(searchJson.results.length).toBeGreaterThan(0);

    const connectors = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/connectors`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(connectors.status, connectors.status === 200 ? undefined : (await connectors.clone().text()).slice(0, 500)).toBe(200);
    const connectorsJson = await connectors.json() as { connectors: Array<{ id: string }> };
    expect(connectorsJson.connectors.some((connector) => connector.id === 'bookmark')).toBe(true);

    const connectorDoctor = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/connectors/bookmark/doctor`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(connectorDoctor.status, connectorDoctor.status === 200 ? undefined : (await connectorDoctor.clone().text()).slice(0, 500)).toBe(200);
    const connectorDoctorJson = await connectorDoctor.json() as { report: { ready: boolean } };
    expect(connectorDoctorJson.report.ready).toBe(true);

    const connectorIngest = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/ingest/connector`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connectorId: 'url-list',
        content: `${sourceUrlList}\n`,
        sessionId: 'session-connector',
      }),
    });
    expect(connectorIngest.status, connectorIngest.status === 201 ? undefined : (await connectorIngest.clone().text()).slice(0, 500)).toBe(201);
    const connectorIngestJson = await connectorIngest.json() as {
      imported: number;
      failed: number;
      errors: string[];
      sources: Array<{ id: string }>;
    };
    expect(connectorIngestJson.imported + connectorIngestJson.failed).toBeGreaterThan(0);
    expect(Array.isArray(connectorIngestJson.sources)).toBe(true);

    const csvPath = join(workingDir, 'knowledge.csv');
    writeFileSync(csvPath, 'project,owner\nGoodVibes,buzzkill\n');
    const ingestArtifact = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/ingest/artifact`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: csvPath, connectorId: 'artifact', sessionId: 'session-artifact' }),
    });
    expect(ingestArtifact.status, ingestArtifact.status === 201 ? undefined : (await ingestArtifact.clone().text()).slice(0, 500)).toBe(201);
    const ingestArtifactJson = await ingestArtifact.json() as { source: { id: string } };
    expect(ingestArtifactJson.source.id).toBeTruthy();

    const multipartArtifact = new FormData();
    multipartArtifact.append('file', new Blob(['room,device\nKitchen,Light\n'], { type: 'text/csv' }), 'home-inventory.csv');
    multipartArtifact.append('connectorId', 'artifact');
    multipartArtifact.append('sessionId', 'session-artifact-upload');
    multipartArtifact.append('title', 'Uploaded home inventory');
    multipartArtifact.append('tags', 'upload,knowledge');
    const ingestMultipartArtifact = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/ingest/artifact`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: multipartArtifact,
    });
    expect(ingestMultipartArtifact.status, ingestMultipartArtifact.status === 201 ? undefined : (await ingestMultipartArtifact.clone().text()).slice(0, 500)).toBe(201);
    const ingestMultipartArtifactJson = await ingestMultipartArtifact.json() as { source: { id: string; title?: string } };
    expect(ingestMultipartArtifactJson.source.id).toBeTruthy();
    expect(ingestMultipartArtifactJson.source.title).toBe('Uploaded home inventory');

    const extractions = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/extractions?limit=10`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(extractions.status, extractions.status === 200 ? undefined : (await extractions.clone().text()).slice(0, 500)).toBe(200);
    const extractionsJson = await extractions.json() as { extractions: Array<{ id: string; format: string }> };
    expect(extractionsJson.extractions.some((extraction) => extraction.format === 'csv')).toBe(true);

    const projections = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/projections?limit=5`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(projections.status, projections.status === 200 ? undefined : (await projections.clone().text()).slice(0, 500)).toBe(200);
    const projectionsJson = await projections.json() as { targets: Array<{ kind: string }> };
    expect(projectionsJson.targets.some((target) => target.kind === 'overview')).toBe(true);

    const packet = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/packet`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 'Knowledge Route Page' }),
    });
    expect(packet.status, packet.status === 200 ? undefined : (await packet.clone().text()).slice(0, 500)).toBe(200);
    const packetJson = await packet.json() as { items: Array<{ id: string }> };
    expect(packetJson.items.length).toBeGreaterThan(0);

    for (let index = 0; index < 3; index += 1) {
      await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'daemon route coverage' }),
      });
      await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/packet`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ task: 'daemon route coverage' }),
      });
    }

    const usage = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/usage?limit=10`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(usage.status, usage.status === 200 ? undefined : (await usage.clone().text()).slice(0, 500)).toBe(200);
    expect(((await usage.json()) as { usage: Array<{ usageKind: string }> }).usage.length).toBeGreaterThan(0);

    const jobs = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/jobs`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(jobs.status, jobs.status === 200 ? undefined : (await jobs.clone().text()).slice(0, 500)).toBe(200);
    const jobsJson = await jobs.json() as { jobs: Array<{ id: string }> };
    expect(jobsJson.jobs.some((job) => job.id === 'knowledge-lint')).toBe(true);
    expect(jobsJson.jobs.some((job) => job.id === 'knowledge-light-consolidation')).toBe(true);

    const runJob = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/jobs/knowledge-light-consolidation/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'inline' }),
    });
    expect(runJob.status, runJob.status === 200 ? undefined : (await runJob.clone().text()).slice(0, 500)).toBe(200);
    const runJobJson = await runJob.json() as { run: { id: string; status: string } };
    expect(runJobJson.run.status).toBe('completed');

    const candidates = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/candidates?limit=10`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(candidates.status, candidates.status === 200 ? undefined : (await candidates.clone().text()).slice(0, 500)).toBe(200);
    const candidatesJson = await candidates.json() as { candidates: Array<{ candidateType: string }> };
    expect(Array.isArray(candidatesJson.candidates)).toBe(true);

    const schedules = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/schedules?limit=10`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(schedules.status, schedules.status === 200 ? undefined : (await schedules.clone().text()).slice(0, 500)).toBe(200);
    const schedulesJson = await schedules.json() as { schedules: Array<{ jobId: string }> };
    expect(schedulesJson.schedules.some((schedule) => schedule.jobId === 'knowledge-light-consolidation')).toBe(true);

    const jobRuns = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/job-runs?limit=10`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(jobRuns.status, jobRuns.status === 200 ? undefined : (await jobRuns.clone().text()).slice(0, 500)).toBe(200);
    const jobRunsJson = await jobRuns.json() as { runs: Array<{ id: string; jobId: string }> };
    expect(jobRunsJson.runs.some((run) => run.id === runJobJson.run.id && run.jobId === 'knowledge-light-consolidation')).toBe(true);

    const renderProjection = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/projections/render`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind: 'source', id: ingested.source.id }),
    });
    expect(renderProjection.status, renderProjection.status === 200 ? undefined : (await renderProjection.clone().text()).slice(0, 500)).toBe(200);
    const renderJson = await renderProjection.json() as { pageCount: number; pages: Array<{ content: string }> };
    expect(renderJson.pageCount).toBe(1);
    expect(renderJson.pages[0]?.content).toContain('Knowledge Route Page');

    const materializeProjection = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/projections/materialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind: 'source', id: ingested.source.id }),
    });
    expect(materializeProjection.status, materializeProjection.status === 201 ? undefined : (await materializeProjection.clone().text()).slice(0, 500)).toBe(201);
    const materializeJson = await materializeProjection.json() as { artifact: { id: string; mimeType: string } };
    expect(materializeJson.artifact.id).toBeTruthy();
    expect(materializeJson.artifact.mimeType).toBe('text/markdown');

    const graphqlSchema = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/graphql/schema`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(graphqlSchema.status, graphqlSchema.status === 200 ? undefined : (await graphqlSchema.clone().text()).slice(0, 500)).toBe(200);
    const graphqlSchemaJson = await graphqlSchema.json() as { schema: string };
    expect(graphqlSchemaJson.schema).toContain('type Query');

    const graphql = await fetch(`http://127.0.0.1:${boundPort}/api/knowledge/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          query KnowledgeRouteGraph($sourceId: String!) {
            status { sourceCount }
            projection(kind: SOURCE, id: $sourceId) {
              target { kind }
              pageCount
            }
          }
        `,
        variables: { sourceId: ingested.source.id },
      }),
    });
    expect(graphql.status, graphql.status === 200 ? undefined : (await graphql.clone().text()).slice(0, 500)).toBe(200);
    const graphqlJson = await graphql.json() as {
      data: {
        status: { sourceCount: number };
        projection: { target: { kind: string }; pageCount: number };
      };
    };
    expect(graphqlJson.data.status.sourceCount).toBeGreaterThan(0);
    expect(graphqlJson.data.projection.target.kind).toBe('SOURCE');
    expect(graphqlJson.data.projection.pageCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Original server case 17, source line 726.
  test('local auth admin API can inspect, add users, rotate password, and revoke sessions', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();

    const login = await fetch(`http://127.0.0.1:${boundPort}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const loginBody = await login.json() as { token: string };
    const authz = { Authorization: `Bearer ${loginBody.token}`, 'Content-Type': 'application/json' };

    const inspect = await fetch(`http://127.0.0.1:${boundPort}/api/local-auth`, { headers: authz });
    expect(inspect.status, inspect.status === 200 ? undefined : (await inspect.clone().text()).slice(0, 500)).toBe(200);
    const inspectBody = await inspect.json() as { userCount: number };
    expect(inspectBody.userCount).toBe(1);

    const add = await fetch(`http://127.0.0.1:${boundPort}/api/local-auth/users`, {
      method: 'POST',
      headers: authz,
      body: JSON.stringify({ username: 'ops', password: 'supersecret', roles: ['admin', 'operator'] }),
    });
    expect(add.status, add.status === 201 ? undefined : (await add.clone().text()).slice(0, 500)).toBe(201);

    const rotate = await fetch(`http://127.0.0.1:${boundPort}/api/local-auth/users/admin/password`, {
      method: 'POST',
      headers: authz,
      body: JSON.stringify({ password: 'newadminpass' }),
    });
    expect(rotate.status, rotate.status === 200 ? undefined : (await rotate.clone().text()).slice(0, 500)).toBe(200);

    const relogin = await fetch(`http://127.0.0.1:${boundPort}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'newadminpass' }),
    });
    expect(relogin.status, relogin.status === 200 ? undefined : (await relogin.clone().text()).slice(0, 500)).toBe(200);
    const reloginBody = await relogin.json() as { token: string };

    const revoke = await fetch(`http://127.0.0.1:${boundPort}/api/local-auth/sessions/${reloginBody.token}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${reloginBody.token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(revoke.status, revoke.status === 200 ? undefined : (await revoke.clone().text()).slice(0, 500)).toBe(200);
  });

  // Original server case 18, source line 775.
  test('multimodal routes analyze documents and write results back into knowledge', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const createArtifact = await fetch(`http://127.0.0.1:${boundPort}/api/artifacts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'attachment', mimeType: 'text/markdown',
        filename: 'multimodal-notes.md',
        text: '# Multimodal Notes\n\nThe knowledge system should improve itself over time.\n',
      }),
    });
    expect(createArtifact.status, createArtifact.status === 201 ? undefined : (await createArtifact.clone().text()).slice(0, 500)).toBe(201);
    const created = await createArtifact.json() as { artifact: { id: string } };

    const analyze = await fetch(`http://127.0.0.1:${boundPort}/api/multimodal/analyze`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        artifactId: created.artifact.id,
        includePacket: true,
        writeback: true,
        sessionId: 'session-mm-route',
      }),
    });
    expect(analyze.status, analyze.status === 201 ? undefined : (await analyze.clone().text()).slice(0, 500)).toBe(201);
    const analyzeJson = await analyze.json() as {
      analysis: { kind: string; providerIds: string[] };
      packet: { rendered: string };
      writeback: { knowledgeSourceId?: string };
    };
    expect(analyzeJson.analysis.kind).toBe('document');
    expect(analyzeJson.analysis.providerIds).toContain('knowledge-extractors');
    expect(analyzeJson.packet.rendered).toContain('Multimodal Analysis');
    expect(typeof analyzeJson.writeback.knowledgeSourceId).toBe('string');
  });

  // Original server case 19, source line 819.
  test('GET /status returns 401 with wrong token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/status`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  // Original server case 20, source line 828.
  test('GET /status returns running status with valid token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/status`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('running');
  });

  // Original server case 21, source line 839.
  test('integration helper API exposes review, settings and continuity', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const review = await fetch(`http://127.0.0.1:${boundPort}/api/review`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(review.status, review.status === 200 ? undefined : (await review.clone().text()).slice(0, 500)).toBe(200);
    const reviewBody = await review.json() as Record<string, unknown>;
    expect(Array.isArray(reviewBody.apiFamilies)).toBe(true);
    expect(Array.isArray(reviewBody.routes)).toBe(true);
    expect((reviewBody.routes as string[]).includes('GET /api/settings')).toBe(true);

    // Panels are a surface concept and the daemon has none, the route answers
    // with an empty list rather than an error, and opening one is a 404. Pinned
    // here because "the daemon grew a panel" is the shape of a regression that
    // would put screen state back inside the process that has no screen.
    const panels = await fetch(`http://127.0.0.1:${boundPort}/api/panels`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(panels.status, panels.status === 200 ? undefined : (await panels.clone().text()).slice(0, 500)).toBe(200);
    const panelsBody = await panels.json() as { panels: Array<{ id: string }> };
    expect(panelsBody.panels).toEqual([]);

    const settings = await fetch(`http://127.0.0.1:${boundPort}/api/settings`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(settings.status, settings.status === 200 ? undefined : (await settings.clone().text()).slice(0, 500)).toBe(200);

    const continuity = await fetch(`http://127.0.0.1:${boundPort}/api/continuity`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(continuity.status, continuity.status === 200 ? undefined : (await continuity.clone().text()).slice(0, 500)).toBe(200);

    const remote = await fetch(`http://127.0.0.1:${boundPort}/api/remote`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(remote.status, remote.status === 200 ? undefined : (await remote.clone().text()).slice(0, 500)).toBe(200);
    const remoteBody = await remote.json() as { registry: { contractEntries: unknown[] } };
    expect(Array.isArray(remoteBody.registry.contractEntries)).toBe(true);
  });

  // Original server case 22, source line 881.
  test('remote distributed runtime supports pairing, invoke, and token rotation', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const requestPair = await fetch(`http://127.0.0.1:${boundPort}/api/remote/pair/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerKind: 'node',
        label: 'daemon-test-node',
        requestedId: 'node-daemon-test',
        capabilities: ['invoke'],
        commands: ['status'],
      }),
    });
    expect(requestPair.status, requestPair.status === 201 ? undefined : (await requestPair.clone().text()).slice(0, 500)).toBe(201);
    const requested = await requestPair.json() as {
      request: { id: string };
      challenge: string;
    };

    const approve = await fetch(`http://127.0.0.1:${boundPort}/api/remote/pair/requests/${requested.request.id}/approve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ note: 'approved in test' }),
    });
    expect(approve.status, approve.status === 200 ? undefined : (await approve.clone().text()).slice(0, 500)).toBe(200);

    const verify = await fetch(`http://127.0.0.1:${boundPort}/api/remote/pair/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: requested.request.id,
        challenge: requested.challenge,
      }),
    });
    expect(verify.status, verify.status === 200 ? undefined : (await verify.clone().text()).slice(0, 500)).toBe(200);
    const verified = await verify.json() as {
      peer: { id: string };
      token: { id: string; value: string };
    };

    const heartbeat = await fetch(`http://127.0.0.1:${boundPort}/api/remote/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verified.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ version: '1.0.0' }),
    });
    expect(heartbeat.status, heartbeat.status === 200 ? undefined : (await heartbeat.clone().text()).slice(0, 500)).toBe(200);

    const invokePromise = fetch(`http://127.0.0.1:${boundPort}/api/remote/peers/${verified.peer.id}/invoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        command: 'status',
        payload: { target: 'daemon' },
        waitMs: 1_000,
      }),
    });

    const pull = await fetch(`http://127.0.0.1:${boundPort}/api/remote/work/pull`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verified.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ maxItems: 1 }),
    });
    expect(pull.status, pull.status === 200 ? undefined : (await pull.clone().text()).slice(0, 500)).toBe(200);
    const pulled = await pull.json() as { work: Array<{ id: string; status: string }> };
    expect(pulled.work).toHaveLength(1);
    expect(pulled.work[0]?.status).toBe('claimed');

    const complete = await fetch(`http://127.0.0.1:${boundPort}/api/remote/work/${pulled.work[0]!.id}/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verified.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        result: { ok: true, summary: 'status collected' },
      }),
    });
    expect(complete.status, complete.status === 200 ? undefined : (await complete.clone().text()).slice(0, 500)).toBe(200);

    const invoke = await invokePromise;
    expect(invoke.status, invoke.status === 202 ? undefined : (await invoke.clone().text()).slice(0, 500)).toBe(202);
    const invokeBody = await invoke.json() as { completed: boolean; work: { status: string } };
    expect(invokeBody.completed).toBe(true);
    expect(invokeBody.work.status).toBe('completed');

    const rotate = await fetch(`http://127.0.0.1:${boundPort}/api/remote/peers/${verified.peer.id}/token/rotate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label: 'rotated-token' }),
    });
    expect(rotate.status, rotate.status === 200 ? undefined : (await rotate.clone().text()).slice(0, 500)).toBe(200);
    const rotated = await rotate.json() as { token: { value: string } };

    const oldHeartbeat = await fetch(`http://127.0.0.1:${boundPort}/api/remote/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verified.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(oldHeartbeat.status, oldHeartbeat.status === 401 ? undefined : (await oldHeartbeat.clone().text()).slice(0, 500)).toBe(401);

    const newHeartbeat = await fetch(`http://127.0.0.1:${boundPort}/api/remote/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rotated.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(newHeartbeat.status, newHeartbeat.status === 200 ? undefined : (await newHeartbeat.clone().text()).slice(0, 500)).toBe(200);

    const limitedRotate = await fetch(`http://127.0.0.1:${boundPort}/api/remote/peers/${verified.peer.id}/token/rotate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label: 'heartbeat-only', scopes: ['remote:heartbeat'] }),
    });
    expect(limitedRotate.status, limitedRotate.status === 200 ? undefined : (await limitedRotate.clone().text()).slice(0, 500)).toBe(200);
    const limited = await limitedRotate.json() as { token: { value: string } };

    const limitedHeartbeat = await fetch(`http://127.0.0.1:${boundPort}/api/remote/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${limited.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(limitedHeartbeat.status, limitedHeartbeat.status === 200 ? undefined : (await limitedHeartbeat.clone().text()).slice(0, 500)).toBe(200);

    const limitedPull = await fetch(`http://127.0.0.1:${boundPort}/api/remote/work/pull`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${limited.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ maxItems: 1 }),
    });
    expect(limitedPull.status, limitedPull.status === 403 ? undefined : (await limitedPull.clone().text()).slice(0, 500)).toBe(403);
  });

  // Original server case 23, source line 1043.
  test('remote peer disconnect requeues claimed work for later pulls', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const requestPair = await fetch(`http://127.0.0.1:${boundPort}/api/remote/pair/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerKind: 'device',
        label: 'daemon-test-device',
        requestedId: 'device-daemon-test',
      }),
    });
    const requested = await requestPair.json() as { request: { id: string }; challenge: string };

    await fetch(`http://127.0.0.1:${boundPort}/api/remote/pair/requests/${requested.request.id}/approve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const verify = await fetch(`http://127.0.0.1:${boundPort}/api/remote/pair/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: requested.request.id,
        challenge: requested.challenge,
      }),
    });
    const verified = await verify.json() as { peer: { id: string }; token: { value: string } };

    const invoke = await fetch(`http://127.0.0.1:${boundPort}/api/remote/peers/${verified.peer.id}/invoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        command: 'status',
      }),
    });
    expect(invoke.status, invoke.status === 202 ? undefined : (await invoke.clone().text()).slice(0, 500)).toBe(202);

    const pull = await fetch(`http://127.0.0.1:${boundPort}/api/remote/work/pull`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verified.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ maxItems: 1 }),
    });
    const pulled = await pull.json() as { work: Array<{ id: string; status: string }> };
    expect(pulled.work[0]?.status).toBe('claimed');

    const disconnect = await fetch(`http://127.0.0.1:${boundPort}/api/remote/peers/${verified.peer.id}/disconnect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requeueClaimedWork: true }),
    });
    expect(disconnect.status, disconnect.status === 200 ? undefined : (await disconnect.clone().text()).slice(0, 500)).toBe(200);

    const work = await fetch(`http://127.0.0.1:${boundPort}/api/remote/work`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const workBody = await work.json() as { work: Array<{ status: string }> };
    expect(workBody.work.some((entry) => entry.status === 'queued')).toBe(true);
  });

  // Original server case 24, source line 1117.
  test('automation helper API exposes jobs and recent runs', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch(`http://127.0.0.1:${boundPort}/api/automation/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'every',
        every: '15m',
        name: 'API Heartbeat',
        prompt: 'Send a daemon heartbeat',
      }),
    });
    expect(create.status, create.status === 201 ? undefined : (await create.clone().text()).slice(0, 500)).toBe(201);
    const created = await create.json() as { id: string; name: string };
    expect(created.name).toBe('API Heartbeat');

    const automation = await fetch(`http://127.0.0.1:${boundPort}/api/automation`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(automation.status, automation.status === 200 ? undefined : (await automation.clone().text()).slice(0, 500)).toBe(200);
    const body = await automation.json() as { totals: { jobs: number }; jobs: Array<{ name: string }> };
    expect(body.totals.jobs).toBeGreaterThanOrEqual(1);
    expect(body.jobs.some((job) => job.name === 'API Heartbeat')).toBe(true);
  });

  // Original server case 25, source line 1147.
  test('automation control-plane API can create and run jobs', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch(`http://127.0.0.1:${boundPort}/api/automation/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'every',
        every: '30m',
        name: 'API Created Job',
        prompt: 'Run API-created automation',
      }),
    });
    expect(create.status, create.status === 201 ? undefined : (await create.clone().text()).slice(0, 500)).toBe(201);
    const created = await create.json() as { id: string; name: string };
    expect(created.name).toBe('API Created Job');

    const run = await fetch(`http://127.0.0.1:${boundPort}/api/automation/jobs/${created.id}/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(run.status, run.status === 200 ? undefined : (await run.clone().text()).slice(0, 500)).toBe(200);
    const runBody = await run.json() as { jobId: string; runId: string };
    expect(runBody.jobId).toBe(created.id);
    expect(typeof runBody.runId).toBe('string');
  });

  // Original server case 26, source line 1178.
  test('automation API accepts cron stagger, main target, and upstream-compatible execution metadata', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch(`http://127.0.0.1:${boundPort}/api/automation/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'cron',
        cron: '0 * * * *',
        timezone: 'UTC',
        staggerMs: 0,
        name: 'API Metadata Job',
        prompt: 'Run metadata automation',
        target: { kind: 'main', createIfMissing: true },
        wakeMode: 'now',
        fallbackModels: ['openrouter:gpt-4.1-mini'],
        reasoningEffort: 'high',
        thinking: 'high',
        externalContentSource: 'webhook',
        allowUnsafeExternalContent: false,
        lightContext: true,
      }),
    });

    expect(create.status, create.status === 201 ? undefined : (await create.clone().text()).slice(0, 500)).toBe(201);
    const created = await create.json() as {
      schedule: { kind: string; staggerMs?: number };
      execution: {
        target: { kind: string };
        wakeMode?: string;
        fallbackModels?: string[];
        reasoningEffort?: string;
        thinking?: string;
        externalContentSource?: string;
        allowUnsafeExternalContent?: boolean;
        lightContext?: boolean;
      };
    };
    expect(created.schedule.staggerMs).toBe(0);
    expect(created.execution.target.kind).toBe('main');
    expect(created.execution.wakeMode).toBe('now');
    expect(created.execution.fallbackModels).toEqual(['openrouter:gpt-4.1-mini']);
    expect(created.execution.reasoningEffort).toBe('high');
    expect(created.execution.thinking).toBe('high');
    expect(created.execution.externalContentSource).toBe('webhook');
    expect(created.execution.allowUnsafeExternalContent).toBe(false);
    expect(created.execution.lightContext).toBe(true);
  });

  // Original server case 27, source line 1231.
  test('automation API can update execution and delivery policy', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch(`http://127.0.0.1:${boundPort}/api/automation/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'every',
        every: '45m',
        name: 'Patchable Job',
        prompt: 'Ship the morning report',
      }),
    });
    const created = await create.json() as { id: string };

    const patch = await fetch(`http://127.0.0.1:${boundPort}/api/automation/jobs/${created.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        target: {
          kind: 'route',
          routeId: 'route-1',
          preserveThread: true,
        },
        delivery: {
          mode: 'webhook',
          targets: [{ kind: 'webhook', address: 'https://example.invalid/automation' }],
          fallbackTargets: [],
          includeSummary: true,
          includeTranscript: false,
          includeLinks: true,
        },
        failure: {
          action: 'dead_letter',
          maxConsecutiveFailures: 5,
          cooldownMs: 60_000,
          retryPolicy: {
            maxAttempts: 4,
            delayMs: 1_000,
            strategy: 'linear',
          },
        },
        deleteAfterRun: true,
      }),
    });
    expect(patch.status, patch.status === 200 ? undefined : (await patch.clone().text()).slice(0, 500)).toBe(200);
    const updated = await patch.json() as {
      execution: { target: { kind: string; routeId: string } };
      delivery: { mode: string; targets: Array<{ address: string }> };
      failure: { action: string; retryPolicy: { maxAttempts: number } };
      deleteAfterRun: boolean;
    };
    expect(updated.execution.target.kind).toBe('route');
    expect(updated.execution.target.routeId).toBe('route-1');
    expect(updated.delivery.mode).toBe('webhook');
    expect(updated.delivery.targets[0]?.address).toContain('example.invalid');
    expect(updated.failure.action).toBe('dead_letter');
    expect(updated.failure.retryPolicy.maxAttempts).toBe(4);
    expect(updated.deleteAfterRun).toBe(true);
  });

  // Original server case 28, source line 1299.
  test('control-plane gateway exposes snapshot, web shell, and event stream', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const stream = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/events?domains=control-plane`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(stream.status, stream.status === 200 ? undefined : (await stream.clone().text()).slice(0, 500)).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader!.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain('event: ready');

    const snapshot = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(snapshot.status, snapshot.status === 200 ? undefined : (await snapshot.clone().text()).slice(0, 500)).toBe(200);
    const snapshotBody = await snapshot.json() as { totals: { clients: number } };
    expect(snapshotBody.totals.clients).toBeGreaterThanOrEqual(1);

    const clients = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/clients`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(clients.status, clients.status === 200 ? undefined : (await clients.clone().text()).slice(0, 500)).toBe(200);
    const clientsBody = await clients.json() as { clients: Array<{ surface: string }> };
    expect(clientsBody.clients.some((client) => client.surface === 'web')).toBe(true);

    const web = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/web`);
    expect(web.status, web.status === 200 ? undefined : (await web.clone().text()).slice(0, 500)).toBe(200);
    expect(web.headers.get('content-type')).toContain('text/html');
    const html = await web.text();
    expect(html).toContain('goodvibes control plane');
    expect(html).toContain('Approvals');
    expect(html).toContain('Sessions');
    expect(html).toContain('Deliveries');
    expect(html).not.toContain(TEST_TOKEN);

    await reader!.cancel();
  });

  // Original server case 29, source line 1340.
  test('control-plane gateway exposes websocket transport and method calls', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const AuthenticatedWebSocket = createAuthenticatedWebSocket(TEST_TOKEN);
    const socket = new AuthenticatedWebSocket(`ws://127.0.0.1:${boundPort}/api/control-plane/ws?clientKind=web&domains=control-plane,automation`);
    const ready = await waitForSocketFrame(socket, (frame) => frame.type === 'event' && frame.event === 'ready');
    expect(ready.type).toBe('event');

    socket.send(JSON.stringify({
      type: 'auth',
      token: TEST_TOKEN,
      domains: ['control-plane', 'automation'],
    }));
    const authenticated = await waitForSocketFrame(socket, (frame) => frame.type === 'auth' && frame.ok === true);
    expect(authenticated.ok).toBe(true);

    socket.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitForSocketFrame(socket, (frame) => frame.type === 'pong');
    expect(pong.type).toBe('pong');

    socket.send(JSON.stringify({
      type: 'call',
      id: 'snapshot-1',
      method: 'GET',
      path: '/api/control-plane',
    }));
    const snapshot = await waitForSocketFrame(socket, (frame) => frame.type === 'response' && frame.id === 'snapshot-1');
    expect(snapshot.ok).toBe(true);
    expect(((snapshot.body as { totals?: { clients?: number } }).totals?.clients ?? 0)).toBeGreaterThanOrEqual(1);

    socket.send(JSON.stringify({
      type: 'call',
      id: 'status-method-1',
      methodId: 'control.status',
    }));
    const methodStatus = await waitForSocketFrame(socket, (frame) => frame.type === 'response' && frame.id === 'status-method-1');
    expect(methodStatus.ok).toBe(true);
    expect((methodStatus.body as { status?: string }).status).toBe('running');

    socket.send(JSON.stringify({
      type: 'subscribe',
      domains: ['routes'],
    }));
    const subscribed = await waitForSocketFrame(socket, (frame) => frame.type === 'subscribed');
    expect(subscribed.type).toBe('subscribed');

    socket.close();
  });

  // Original server case 30, source line 1390.
  test('exposes gap-closure contracts for methods, voice, web search, artifacts, media, multimodal, memory, heartbeat, and node hosts', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
    const methods = runtimeServices.gatewayMethods.list();
    expect(methods.some((method) => method.id === 'control.contract')).toBe(true);
    expect(methods.some((method) => method.id === 'remote.node_host.contract')).toBe(true);

    const events = runtimeServices.gatewayMethods.listEvents();
    expect(events.some((event) => event.id === 'runtime.automation')).toBe(true);
    expect(events.some((event) => event.id === 'control.ready')).toBe(true);

    const operatorContract = buildOperatorContract(runtimeServices.gatewayMethods);
    expect(operatorContract.auth.login.path).toBe('/login');
    expect(operatorContract.auth.current.path).toBe('/api/control-plane/auth');
    expect(operatorContract.auth.current.aliasPaths).toContain('/api/control-plane/whoami');
    expect(operatorContract.auth.sessionCookie.name).toBe('goodvibes_session');
    expect(operatorContract.auth.bearer.queryParameters).toEqual([]);
    expect(operatorContract.transports.websocket.path).toBe('/api/control-plane/ws');
    expect(operatorContract.peer.contractPath).toBe('/api/remote/node-host/contract');
    expect(operatorContract.operator.methods.some((method) => method.id === 'control.contract')).toBe(true);
    expect(operatorContract.operator.methods.some((method) => method.id === 'telemetry.snapshot')).toBe(true);
    expect(operatorContract.operator.events.some((event) => event.id === 'runtime.automation')).toBe(true);

    const statusInvoke = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/methods/control.status/invoke`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: {} }),
    });
    expect(statusInvoke.status, statusInvoke.status === 200 ? undefined : (await statusInvoke.clone().text()).slice(0, 500)).toBe(200);
    expect((await statusInvoke.json() as { status?: string }).status).toBe('running');

    const voice = await fetch(`http://127.0.0.1:${boundPort}/api/voice`, { headers: auth });
    expect(voice.status, voice.status === 200 ? undefined : (await voice.clone().text()).slice(0, 500)).toBe(200);
    expect((await voice.json() as { note?: string }).note).toContain('Voice capture');

    const voiceProviders = await fetch(`http://127.0.0.1:${boundPort}/api/voice/providers`, { headers: auth });
    expect(voiceProviders.status, voiceProviders.status === 200 ? undefined : (await voiceProviders.clone().text()).slice(0, 500)).toBe(200);
    const voiceProvidersBody = await voiceProviders.json() as { providers: Array<{ id: string }> };
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'openai')).toBe(true);
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'deepgram')).toBe(true);
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'google')).toBe(true);
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'elevenlabs')).toBe(true);
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'microsoft')).toBe(true);
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'vydra')).toBe(true);

    const webSearch = await fetch(`http://127.0.0.1:${boundPort}/api/web-search/providers`, { headers: auth });
    expect(webSearch.status, webSearch.status === 200 ? undefined : (await webSearch.clone().text()).slice(0, 500)).toBe(200);
    const webSearchBody = await webSearch.json() as { providers: Array<{ id: string }> };
    expect(webSearchBody.providers.some((provider) => provider.id === 'duckduckgo')).toBe(true);
    expect(webSearchBody.providers.some((provider) => provider.id === 'perplexity')).toBe(true);

    const artifacts = await fetch(`http://127.0.0.1:${boundPort}/api/artifacts`, { headers: auth });
    expect(artifacts.status, artifacts.status === 200 ? undefined : (await artifacts.clone().text()).slice(0, 500)).toBe(200);
    expect(await artifacts.json()).toHaveProperty('artifacts');

    const media = await fetch(`http://127.0.0.1:${boundPort}/api/media/providers`, { headers: auth });
    expect(media.status, media.status === 200 ? undefined : (await media.clone().text()).slice(0, 500)).toBe(200);
    const mediaBody = await media.json() as { providers: Array<{ id: string }> };
    expect(mediaBody.providers.some((provider) => provider.id === 'builtin:image-understanding')).toBe(true);
    expect(mediaBody.providers.some((provider) => provider.id === 'fal')).toBe(true);
    expect(mediaBody.providers.some((provider) => provider.id === 'comfy')).toBe(true);
    expect(mediaBody.providers.some((provider) => provider.id === 'runway')).toBe(true);
    expect(mediaBody.providers.some((provider) => provider.id === 'alibaba')).toBe(true);
    expect(mediaBody.providers.some((provider) => provider.id === 'byteplus')).toBe(true);

    const multimodal = await fetch(`http://127.0.0.1:${boundPort}/api/multimodal`, { headers: auth });
    expect(multimodal.status, multimodal.status === 200 ? undefined : (await multimodal.clone().text()).slice(0, 500)).toBe(200);
    expect((await multimodal.json() as { note?: string }).note).toContain('Multimodal analysis');

    const multimodalProviders = await fetch(`http://127.0.0.1:${boundPort}/api/multimodal/providers`, { headers: auth });
    expect(multimodalProviders.status, multimodalProviders.status === 200 ? undefined : (await multimodalProviders.clone().text()).slice(0, 500)).toBe(200);
    const multimodalBody = await multimodalProviders.json() as { providers: Array<{ id: string }> };
    expect(multimodalBody.providers.some((provider) => provider.id === 'knowledge-extractors')).toBe(true);
    expect(multimodalBody.providers.some((provider) => provider.id === 'openai')).toBe(true);

    const memory = await fetch(`http://127.0.0.1:${boundPort}/api/memory/doctor`, { headers: auth });
    expect(memory.status, memory.status === 200 ? undefined : (await memory.clone().text()).slice(0, 500)).toBe(200);
    const memoryBody = await memory.json() as { embeddings: { activeProviderId: string } };
    expect(memoryBody.embeddings.activeProviderId).toBe('hashed-local');

    const heartbeat = await fetch(`http://127.0.0.1:${boundPort}/api/automation/heartbeat`, { headers: auth });
    expect(heartbeat.status, heartbeat.status === 200 ? undefined : (await heartbeat.clone().text()).slice(0, 500)).toBe(200);
    expect(await heartbeat.json()).toHaveProperty('pending');

    const contract = await fetch(`http://127.0.0.1:${boundPort}/api/remote/node-host/contract`, { headers: auth });
    expect(contract.status, contract.status === 200 ? undefined : (await contract.clone().text()).slice(0, 500)).toBe(200);
    const contractBody = await contract.json() as { contract: { scopes: string[]; endpoints: Array<{ id: string }> } };
    expect(contractBody.contract.scopes).toContain('remote:heartbeat');
    expect(contractBody.contract.endpoints.some((endpoint) => endpoint.id === 'work.pull')).toBe(true);
  });

  // Original server case 31, source line 1483.
  test('control-plane exposes the event catalog and resolves templated method routes through invoke', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const auth = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };
    const events = runtimeServices.gatewayMethods.listEvents();
    expect(events.some((event) => event.id === 'runtime.automation')).toBe(true);
    expect(events.some((event) => event.id === 'control.ready')).toBe(true);

    const method = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/methods/control.methods.get/invoke`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        query: { methodId: 'control.status' },
        body: {},
      }),
    });
    expect(method.status, method.status === 200 ? undefined : (await method.clone().text()).slice(0, 500)).toBe(200);
    const methodBody = await method.json() as { method: { id: string } };
    expect(methodBody.method.id).toBe('control.status');
  });

  // Original server case 32, source line 1505.
  test('gateway method invocation enforces scopes for local-auth sessions, including raw websocket route calls', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();

    const adminLogin = await fetch(`http://127.0.0.1:${boundPort}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    expect(adminLogin.status, adminLogin.status === 200 ? undefined : (await adminLogin.clone().text()).slice(0, 500)).toBe(200);
    const adminToken = (await adminLogin.json() as { token: string }).token;

    const createUser = await fetch(`http://127.0.0.1:${boundPort}/api/local-auth/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'operator', password: 'operator-pass', roles: ['operator'] }),
    });
    expect(createUser.status, createUser.status === 201 ? undefined : (await createUser.clone().text()).slice(0, 500)).toBe(201);

    const operatorLogin = await fetch(`http://127.0.0.1:${boundPort}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'operator-pass' }),
    });
    expect(operatorLogin.status, operatorLogin.status === 200 ? undefined : (await operatorLogin.clone().text()).slice(0, 500)).toBe(200);
    const operatorToken = (await operatorLogin.json() as { token: string }).token;

    const readInvoke = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/methods/control.status/invoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: {} }),
    });
    expect(readInvoke.status, readInvoke.status === 200 ? undefined : (await readInvoke.clone().text()).slice(0, 500)).toBe(200);

    const writeInvoke = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/methods/automation.heartbeat.run/invoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: { source: 'scope-test' } }),
    });
    expect(writeInvoke.status, writeInvoke.status === 403 ? undefined : (await writeInvoke.clone().text()).slice(0, 500)).toBe(403);
    const writeInvokeBody = await writeInvoke.json() as { error: string; missingScopes?: string[] };
    expect(writeInvokeBody.error).toContain('Missing required scope');
    expect(writeInvokeBody.missingScopes).toContain('write:automation');

    const AuthenticatedWebSocket = createAuthenticatedWebSocket(operatorToken);
    const socket = new AuthenticatedWebSocket(`ws://127.0.0.1:${boundPort}/api/control-plane/ws?clientKind=web&domains=control-plane`);
    const ready = await waitForSocketFrame(socket, (frame) => frame.type === 'event' && frame.event === 'ready');
    expect(ready.type).toBe('event');

    socket.send(JSON.stringify({
      type: 'auth',
      token: operatorToken,
      domains: ['control-plane'],
    }));
    const authenticated = await waitForSocketFrame(socket, (frame) => frame.type === 'auth' && frame.ok === true);
    expect(authenticated.ok).toBe(true);

    socket.send(JSON.stringify({
      type: 'call',
      id: 'raw-write-1',
      method: 'POST',
      path: '/api/automation/heartbeat',
      body: { source: 'raw-ws-scope-test' },
    }));
    const denied = await waitForSocketFrame(socket, (frame) => frame.type === 'response' && frame.id === 'raw-write-1');
    expect(denied.status).toBe(403);
    expect((denied.body as { error?: string }).error).toContain('Missing required scope');
    socket.close();
  });

  // Original server case 33, source line 1584.
  test('shared session APIs can create, inspect, and continue sessions', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch(`http://127.0.0.1:${boundPort}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Ops session',
        surfaceKind: 'web',
        surfaceId: 'surface:web',
      }),
    });
    expect(create.status, create.status === 201 ? undefined : (await create.clone().text()).slice(0, 500)).toBe(201);
    const created = await create.json() as { session: { id: string } };
    expect(typeof created.session.id).toBe('string');

    const send = await fetch(`http://127.0.0.1:${boundPort}/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: 'Summarize the session state',
        surfaceKind: 'web',
        surfaceId: 'surface:web',
      }),
    });
    expect(send.status, send.status === 202 ? undefined : (await send.clone().text()).slice(0, 500)).toBe(202);
    const sendBody = await send.json() as { messageId: string; routedTo: string; sessionId: string };
    expect(sendBody.sessionId).toBe(created.session.id);
    expect(sendBody.routedTo).toBe('conversation');
    expect(typeof sendBody.messageId).toBe('string');

    const task = await fetch(`http://127.0.0.1:${boundPort}/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'task',
        body: 'Continue this as agent work',
        surfaceKind: 'web',
        surfaceId: 'surface:web',
      }),
    });
    expect(task.status, task.status === 202 ? undefined : (await task.clone().text()).slice(0, 500)).toBe(202);
    const taskBody = await task.json() as { session: { id: string }; agentId: string };
    expect(taskBody.session.id).toBe(created.session.id);
    expect(typeof taskBody.agentId).toBe('string');

    const inspect = await fetch(`http://127.0.0.1:${boundPort}/api/sessions/${created.session.id}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(inspect.status, inspect.status === 200 ? undefined : (await inspect.clone().text()).slice(0, 500)).toBe(200);
    const inspectBody = await inspect.json() as { messages: Array<{ role: string }> };
    expect(inspectBody.messages.some((message) => message.role === 'user')).toBe(true);
  });

  // Original server case 34, source line 1648.
  test('approval APIs retain explicit owner asks while autonomous tools finish without a human wait', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN); await daemon.start();
    await proveAutonomousRead();
    const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
    const empty = await fetch(`http://127.0.0.1:${boundPort}/api/approvals`, { headers: auth });
    expect(empty.status).toBe(200); expect(await empty.json()).toMatchObject({ approvals: [] });
    // This is an explicit host-owned disclosure ask, not an autonomous tool permission.
    const broker = runtimeServices.approvalBroker;
    const exact = await broker.raiseOwnerApproval({
      request: { callId: 'server-parity-owner-ask', tool: 'delegated.message.intake', args: { sourceRef: 'synthetic-owner-source' }, category: 'delegate',
        analysis: { classification: 'delegated-message', riskLevel: 'high', summary: 'Review the synthetic source reference', reasons: ['Exact owner decision required'] } },
      requireOwnerDecision: { assertCurrent() {} },
    });
    const listed = await fetch(`http://127.0.0.1:${boundPort}/api/approvals`, { headers: auth });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { approvals: { id: string; status: string }[] }).approvals).toContainEqual(expect.objectContaining({ id: exact.approval.id, status: 'pending' }));
    const forged = await fetch(`http://127.0.0.1:${boundPort}/api/approvals/${exact.approval.id}/approve`, { method: 'POST', headers: auth });
    expect(forged.status).toBe(400); expect(broker.getApproval(exact.approval.id)?.status).toBe('pending');
    await exact.resolveOwnerDecision({ decision: { approved: true }, actor: 'paired-owner', actorSurface: 'paired-gateway', assertCurrent() {} });
    expect(await exact.decision).toMatchObject({ approved: true });
    const settled = await fetch(`http://127.0.0.1:${boundPort}/api/approvals`, { headers: auth });
    expect((await settled.json() as { approvals: { id: string; status: string }[] }).approvals).toContainEqual(expect.objectContaining({ id: exact.approval.id, status: 'approved' }));
  });

  // Original server case 35, source line 1694.
  test('route bindings API can upsert and delete bindings', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch(`http://127.0.0.1:${boundPort}/api/routes/bindings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'thread',
        surfaceKind: 'webhook',
        surfaceId: 'test-surface',
        externalId: 'external-1',
        threadId: 'thread-1',
        sessionId: 'session-1',
      }),
    });
    expect(create.status, create.status === 201 ? undefined : (await create.clone().text()).slice(0, 500)).toBe(201);
    const created = await create.json() as { id: string };
    expect(created.id).toMatch(/^route-/);

    const duplicate = await fetch(`http://127.0.0.1:${boundPort}/api/routes/bindings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'thread',
        surfaceKind: 'webhook',
        surfaceId: 'test-surface',
        externalId: 'external-1',
        threadId: 'thread-1',
        sessionId: 'session-2',
      }),
    });
    expect(duplicate.status, duplicate.status === 201 ? undefined : (await duplicate.clone().text()).slice(0, 500)).toBe(201);
    const duplicated = await duplicate.json() as { id: string };
    expect(duplicated.id).toBe(created.id);

    const list = await fetch(`http://127.0.0.1:${boundPort}/api/routes/bindings`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(list.status, list.status === 200 ? undefined : (await list.clone().text()).slice(0, 500)).toBe(200);
    const listBody = await list.json() as { bindings: Array<{ id: string; surfaceKind: string }> };
    expect(listBody.bindings.some((binding) => binding.id === created.id && binding.surfaceKind === 'webhook')).toBe(true);
    expect(listBody.bindings.filter((binding) => binding.id === created.id)).toHaveLength(1);

    const remove = await fetch(`http://127.0.0.1:${boundPort}/api/routes/bindings/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(remove.status, remove.status === 200 ? undefined : (await remove.clone().text()).slice(0, 500)).toBe(200);
  });

  // Original server case 36, source line 1751.
  test('channel policy APIs expose group-aware policy state, status, directory, and block webhook ingress', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const policyUpdate = await fetch(`http://127.0.0.1:${boundPort}/api/channels/policies/webhook`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        allowlistUserIds: ['alice'],
        allowDirectMessages: false,
        allowlistGroupIds: ['policy-channel'],
        groupPolicies: [{
          id: 'policy-group',
          groupId: 'policy-channel',
          requireMention: true,
          allowedCommands: ['/run'],
        }],
      }),
    });
    expect(policyUpdate.status, policyUpdate.status === 200 ? undefined : (await policyUpdate.clone().text()).slice(0, 500)).toBe(200);
    const updatedPolicy = await policyUpdate.json() as { allowDirectMessages: boolean; groupPolicies: Array<{ id: string }> };
    expect(updatedPolicy.allowDirectMessages).toBe(false);
    expect(updatedPolicy.groupPolicies[0]?.id).toBe('policy-group');

    const policies = await fetch(`http://127.0.0.1:${boundPort}/api/channels/policies`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(policies.status, policies.status === 200 ? undefined : (await policies.clone().text()).slice(0, 500)).toBe(200);
    const policyBody = await policies.json() as { policies: Array<{ surface: string }> };
    expect(policyBody.policies.some((policy) => policy.surface === 'webhook')).toBe(true);

    const blocked = await fetch(`http://127.0.0.1:${boundPort}/webhook/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        userId: 'bob',
        externalId: 'policy-blocked',
        conversationKind: 'direct',
        message: 'blocked by policy',
      }),
    });
    expect(blocked.status, blocked.status === 403 ? undefined : (await blocked.clone().text()).slice(0, 500)).toBe(403);

    const blockedCommand = await fetch(`http://127.0.0.1:${boundPort}/webhook/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        userId: 'alice',
        externalId: 'policy-blocked-command',
        channelId: 'policy-channel',
        groupId: 'policy-channel',
        conversationKind: 'channel',
        message: '/status',
      }),
    });
    expect(blockedCommand.status, blockedCommand.status === 403 ? undefined : (await blockedCommand.clone().text()).slice(0, 500)).toBe(403);

    const allowed = await fetch(`http://127.0.0.1:${boundPort}/webhook/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        userId: 'alice',
        externalId: 'policy-allowed',
        channelId: 'policy-channel',
        groupId: 'policy-channel',
        conversationKind: 'channel',
        message: '/run policy',
        title: 'Policy Allowed',
        mentioned: true,
        members: [
          { id: 'alice', label: 'Alice Example', handle: '@alice' },
          { id: 'ops-bot', label: 'Ops Bot', handle: '@ops-bot' },
        ],
      }),
    });
    expect(allowed.status, allowed.status === 200 ? undefined : (await allowed.clone().text()).slice(0, 500)).toBe(200);

    const directory = await fetch(`http://127.0.0.1:${boundPort}/api/channels/directory/webhook?q=policy&scope=groups&groupId=policy-channel&limit=1`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(directory.status, directory.status === 200 ? undefined : (await directory.clone().text()).slice(0, 500)).toBe(200);
    const directoryBody = await directory.json() as { entries: Array<{ id: string; groupId?: string; isGroupConversation?: boolean }> };
    expect(directoryBody.entries).toHaveLength(1);
    expect(directoryBody.entries[0]?.groupId).toBe('policy-channel');
    expect(directoryBody.entries[0]?.isGroupConversation).toBe(true);

    const members = await fetch(`http://127.0.0.1:${boundPort}/api/channels/directory/webhook?scope=members&groupId=policy-channel`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(members.status, members.status === 200 ? undefined : (await members.clone().text()).slice(0, 500)).toBe(200);
    const membersBody = await members.json() as { entries: Array<{ kind: string; label: string }> };
    expect(membersBody.entries.some((entry) => entry.kind === 'member' && entry.label === 'Alice Example')).toBe(true);

    const status = await fetch(`http://127.0.0.1:${boundPort}/api/channels/status`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(status.status, status.status === 200 ? undefined : (await status.clone().text()).slice(0, 500)).toBe(200);
    const statusBody = await status.json() as { channels: Array<{ surface: string }> };
    expect(statusBody.channels.some((channel) => channel.surface === 'webhook')).toBe(true);

    const audit = await fetch(`http://127.0.0.1:${boundPort}/api/channels/policies/audit`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(audit.status, audit.status === 200 ? undefined : (await audit.clone().text()).slice(0, 500)).toBe(200);
    const auditBody = await audit.json() as { audit: Array<{ surface: string; allowed: boolean; reason: string; conversationKind?: string; matchedGroupPolicyId?: string }> };
    expect(auditBody.audit.some((entry) => entry.surface === 'webhook' && entry.allowed === false && entry.reason === 'direct-messages-disabled')).toBe(true);
    expect(auditBody.audit.some((entry) => entry.matchedGroupPolicyId === 'policy-group' && entry.conversationKind === 'channel')).toBe(true);
  });

  // Original server case 37, source line 1876.
  test('channel policy APIs allow authorized control commands to bypass mention gating when configured', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const policyUpdate = await fetch(`http://127.0.0.1:${boundPort}/api/channels/policies/webhook`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requireMention: true,
        allowTextCommandsWithoutMention: true,
        allowedCommands: ['status'],
      }),
    });
    expect(policyUpdate.status, policyUpdate.status === 200 ? undefined : (await policyUpdate.clone().text()).slice(0, 500)).toBe(200);

    const allowed = await fetch(`http://127.0.0.1:${boundPort}/webhook/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        externalId: 'policy-bypass-allowed',
        channelId: 'ops-room',
        groupId: 'ops-room',
        conversationKind: 'channel',
        mentioned: false,
        hasAnyMention: false,
        controlCommand: 'status',
        message: 'status run-123',
      }),
    });
    expect(allowed.status, allowed.status === 200 ? undefined : (await allowed.clone().text()).slice(0, 500)).toBe(200);

    const blocked = await fetch(`http://127.0.0.1:${boundPort}/webhook/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        externalId: 'policy-bypass-blocked',
        channelId: 'ops-room',
        groupId: 'ops-room',
        conversationKind: 'channel',
        mentioned: false,
        hasAnyMention: false,
        controlCommand: 'retry',
        message: 'retry run-123',
      }),
    });
    expect(blocked.status, blocked.status === 403 ? undefined : (await blocked.clone().text()).slice(0, 500)).toBe(403);
  });

  // Original server case 38, source line 1937.
  test('channel account APIs expose surface auth and secret posture', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.slack.enabled', true);
    config.setDynamic('surfaces.slack.workspaceId', 'workspace-1');
    config.setDynamic('surfaces.slack.botToken', 'xoxb-local');
    config.setDynamic('surfaces.slack.signingSecret', 'signing-secret');
    config.setDynamic('surfaces.slack.defaultChannel', 'ops-alerts');
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.defaultTarget', 'https://example.com/hook');
    config.setDynamic('surfaces.webhook.secret', 'shared-secret');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const accounts = await fetch(`http://127.0.0.1:${boundPort}/api/channels/accounts`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(accounts.status, accounts.status === 200 ? undefined : (await accounts.clone().text()).slice(0, 500)).toBe(200);
    const accountsBody = await accounts.json() as {
      accounts: Array<{ surface: string; configured: boolean; linked: boolean; authState: string; secrets: Array<{ field: string; source: string }> }>;
    };
    const slackAccount = accountsBody.accounts.find((entry) => entry.surface === 'slack');
    expect(slackAccount?.configured).toBe(true);
    expect(slackAccount?.linked).toBe(true);
    expect(slackAccount?.authState).toBe('linked');
    expect(slackAccount?.secrets.some((entry) => entry.field === 'primary' && entry.source === 'config')).toBe(true);

    const slackAccounts = await fetch(`http://127.0.0.1:${boundPort}/api/channels/accounts/slack`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(slackAccounts.status, slackAccounts.status === 200 ? undefined : (await slackAccounts.clone().text()).slice(0, 500)).toBe(200);
    const slackAccountsBody = await slackAccounts.json() as { accounts: Array<{ accountId?: string }> };
    expect(slackAccountsBody.accounts[0]?.accountId).toBe('workspace-1');

    const slackSingle = await fetch(`http://127.0.0.1:${boundPort}/api/channels/accounts/slack/workspace-1`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(slackSingle.status, slackSingle.status === 200 ? undefined : (await slackSingle.clone().text()).slice(0, 500)).toBe(200);
    const slackSingleBody = await slackSingle.json() as {
      surface: string;
      state: string;
      actions: Array<{ id: string; available: boolean }>;
      metadata: { defaultChannel?: string };
    };
    expect(slackSingleBody.surface).toBe('slack');
    expect(slackSingleBody.state).toBe('healthy');
    expect(slackSingleBody.actions.some((action) => action.id === 'inspect' && action.available)).toBe(true);
    expect(slackSingleBody.metadata.defaultChannel).toBe('ops-alerts');

    const capabilities = await fetch(`http://127.0.0.1:${boundPort}/api/channels/capabilities/slack`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(capabilities.status, capabilities.status === 200 ? undefined : (await capabilities.clone().text()).slice(0, 500)).toBe(200);
    const capabilitiesBody = await capabilities.json() as { capabilities: Array<{ id: string; supported: boolean }> };
    expect(capabilitiesBody.capabilities.some((entry) => entry.id === 'tooling' && entry.supported)).toBe(true);

    const tools = await fetch(`http://127.0.0.1:${boundPort}/api/channels/tools/slack`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(tools.status, tools.status === 200 ? undefined : (await tools.clone().text()).slice(0, 500)).toBe(200);
    const toolsBody = await tools.json() as { tools: Array<{ name: string; id: string }> };
    expect(toolsBody.tools.some((entry) => entry.name === 'slack_account' && entry.id === 'slack:account')).toBe(true);

    const toolRun = await fetch(`http://127.0.0.1:${boundPort}/api/channels/tools/slack/slack%3Aaccount`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId: 'workspace-1' }),
    });
    expect(toolRun.status, toolRun.status === 200 ? undefined : (await toolRun.clone().text()).slice(0, 500)).toBe(200);
    const toolRunBody = await toolRun.json() as { result: { accountId?: string } };
    expect(toolRunBody.result.accountId).toBe('workspace-1');

    const actions = await fetch(`http://127.0.0.1:${boundPort}/api/channels/actions/slack`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(actions.status, actions.status === 200 ? undefined : (await actions.clone().text()).slice(0, 500)).toBe(200);
    const actionsBody = await actions.json() as { actions: Array<{ id: string }> };
    expect(actionsBody.actions.some((entry) => entry.id === 'inspect-account')).toBe(true);

    const actionRun = await fetch(`http://127.0.0.1:${boundPort}/api/channels/actions/slack/inspect-account`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId: 'workspace-1' }),
    });
    expect(actionRun.status, actionRun.status === 200 ? undefined : (await actionRun.clone().text()).slice(0, 500)).toBe(200);
    const actionRunBody = await actionRun.json() as { result: { accountId?: string } };
    expect(actionRunBody.result.accountId).toBe('workspace-1');

    const accountAction = await fetch(`http://127.0.0.1:${boundPort}/api/channels/accounts/slack/workspace-1/actions/retest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(accountAction.status, accountAction.status === 200 ? undefined : (await accountAction.clone().text()).slice(0, 500)).toBe(200);
    const accountActionBody = await accountAction.json() as { result: { action: string; ok: boolean } };
    expect(accountActionBody.result.action).toBe('retest');
    expect(accountActionBody.result.ok).toBe(true);

    const setupAction = await fetch(`http://127.0.0.1:${boundPort}/api/channels/accounts/slack/workspace-1/actions/login`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ clientId: 'C123', redirectUri: 'https://goodvibes.local/oauth/slack' }),
    });
    expect(setupAction.status, setupAction.status === 200 ? undefined : (await setupAction.clone().text()).slice(0, 500)).toBe(200);
    const setupActionBody = await setupAction.json() as { result: { login?: { kind: string; url?: string }; ok: boolean } };
    expect(setupActionBody.result.ok).toBe(true);
    expect(setupActionBody.result.login?.kind).toBe('browser');
    expect(setupActionBody.result.login?.url).toContain('slack.com/oauth/v2/authorize');

    const targetResolve = await fetch(`http://127.0.0.1:${boundPort}/api/channels/targets/slack/resolve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ target: '#ops-alerts', createIfMissing: true }),
    });
    expect(targetResolve.status, targetResolve.status === 200 ? undefined : (await targetResolve.clone().text()).slice(0, 500)).toBe(200);
    const targetResolveBody = await targetResolve.json() as { target: { kind: string; to: string; sessionTarget: string; source: string } };
    expect(targetResolveBody.target.kind).toBe('channel');
    expect(targetResolveBody.target.to).toBe('ops-alerts');
    expect(targetResolveBody.target.sessionTarget).toBe('channel:slack:ops-alerts');

    const agentTools = await fetch(`http://127.0.0.1:${boundPort}/api/channels/agent-tools/slack`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(agentTools.status, agentTools.status === 200 ? undefined : (await agentTools.clone().text()).slice(0, 500)).toBe(200);
    const agentToolsBody = await agentTools.json() as { tools: Array<{ name: string }> };
    expect(agentToolsBody.tools.some((entry) => entry.name === 'slack_target')).toBe(true);

    const authorize = await fetch(`http://127.0.0.1:${boundPort}/api/channels/authorize/slack`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ actionId: 'inspect', accountId: 'workspace-1', target: '#ops-alerts' }),
    });
    expect(authorize.status, authorize.status === 200 ? undefined : (await authorize.clone().text()).slice(0, 500)).toBe(200);
    const authorizeBody = await authorize.json() as { result: { allowed: boolean; actionAvailable: boolean } };
    expect(authorizeBody.result.allowed).toBe(true);
    expect(authorizeBody.result.actionAvailable).toBe(true);

    const providerApi = await fetch(`http://127.0.0.1:${boundPort}/api/channels/actions/slack/provider-api`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operation: 'oauth_url', clientId: 'C123' }),
    });
    expect(providerApi.status, providerApi.status === 200 ? undefined : (await providerApi.clone().text()).slice(0, 500)).toBe(200);
    const providerApiBody = await providerApi.json() as { result: { ok: boolean; url?: string } };
    expect(providerApiBody.result.ok).toBe(true);
    expect(providerApiBody.result.url).toContain('slack.com/oauth/v2/authorize');

    const integratedAccounts = await fetch(`http://127.0.0.1:${boundPort}/api/accounts`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(integratedAccounts.status, integratedAccounts.status === 200 ? undefined : (await integratedAccounts.clone().text()).slice(0, 500)).toBe(200);
    const integratedBody = await integratedAccounts.json() as {
      providers: Array<{
        providerId: string;
        availableRoutes: string[];
        notes: string[];
        routeRecords: Array<{ route: string; usable: boolean; detail: string }>;
      }>;
      configuredCount: number;
      issueCount: number;
    };
    expect(Array.isArray(integratedBody.providers)).toBe(true);
    expect(typeof integratedBody.configuredCount).toBe('number');
    expect(typeof integratedBody.issueCount).toBe('number');
    const openaiAccount = integratedBody.providers.find((entry) => entry.providerId === 'openai');
    expect(openaiAccount).toBeDefined();
    expect(Array.isArray(openaiAccount?.availableRoutes)).toBe(true);
    expect(Array.isArray(openaiAccount?.notes)).toBe(true);
    expect(Array.isArray(openaiAccount?.routeRecords)).toBe(true);
    expect(openaiAccount?.routeRecords.every((entry) => typeof entry.route === 'string' && typeof entry.detail === 'string')).toBe(true);

    const providers = await fetch(`http://127.0.0.1:${boundPort}/api/providers`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(providers.status, providers.status === 200 ? undefined : (await providers.clone().text()).slice(0, 500)).toBe(200);
    const providersBody = await providers.json() as {
      providers: Array<{ id: string }>;
    };
    expect(Array.isArray(providersBody.providers)).toBe(true);

    const provider = await fetch(`http://127.0.0.1:${boundPort}/api/providers/openai`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(provider.status, provider.status === 200 ? undefined : (await provider.clone().text()).slice(0, 500)).toBe(200);
    const providerBody = await provider.json() as { providerId: string; models: Array<{ id: string }> };
    expect(providerBody.providerId).toBe('openai');
    expect(Array.isArray(providerBody.models)).toBe(true);

    const usage = await fetch(`http://127.0.0.1:${boundPort}/api/providers/openai/usage`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(usage.status, usage.status === 200 ? undefined : (await usage.clone().text()).slice(0, 500)).toBe(200);
    const usageBody = await usage.json() as { providerId: string; usage: { streaming: boolean } };
    expect(usageBody.providerId).toBe('openai');
    expect(usageBody.usage.streaming).toBe(true);
  });

  // Original server case 39, source line 2155.
  test('surface, watcher, and service APIs expose control-plane support state', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const surfaces = await fetch(`http://127.0.0.1:${boundPort}/api/surfaces`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(surfaces.status, surfaces.status === 200 ? undefined : (await surfaces.clone().text()).slice(0, 500)).toBe(200);
    const surfacesBody = await surfaces.json() as { surfaces: Array<{ kind: string }> };
    expect(surfacesBody.surfaces.some((surface) => surface.kind === 'tui')).toBe(true);
    expect(surfacesBody.surfaces.some((surface) => surface.kind === 'web')).toBe(true);

    const watchers = await fetch(`http://127.0.0.1:${boundPort}/api/watchers`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(watchers.status, watchers.status === 200 ? undefined : (await watchers.clone().text()).slice(0, 500)).toBe(200);
    const watchersBody = await watchers.json() as { watchers: unknown[] };
    expect(Array.isArray(watchersBody.watchers)).toBe(true);

    const service = await fetch(`http://127.0.0.1:${boundPort}/api/service/status`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(service.status, service.status === 200 ? undefined : (await service.clone().text()).slice(0, 500)).toBe(200);
    const serviceBody = await service.json() as { platform: string; suggestedCommands: string[] };
    expect(typeof serviceBody.platform).toBe('string');
    expect(Array.isArray(serviceBody.suggestedCommands)).toBe(true);
  });

  // Original server case 40, source line 2183.
  test('channel setup, doctor, lifecycle, and allowlist APIs expose expanded surface contracts', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.telegram.enabled', true);
    config.setDynamic('surfaces.telegram.botToken', 'telegram-token');
    config.setDynamic('surfaces.telegram.botUsername', 'goodvibes_bot');
    config.setDynamic('surfaces.telegram.defaultChatId', '-100200300');
    config.setDynamic('surfaces.signal.enabled', true);
    config.setDynamic('surfaces.signal.bridgeUrl', 'https://signal-bridge.example.test');
    config.setDynamic('surfaces.signal.account', '+15551234567');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const auth = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

    const setup = await fetch(`http://127.0.0.1:${boundPort}/api/channels/setup/telegram`, { headers: auth });
    expect(setup.status, setup.status === 200 ? undefined : (await setup.clone().text()).slice(0, 500)).toBe(200);
    const setupBody = await setup.json() as {
      surface: string;
      version: number;
      fields: Array<{ id: string }>;
      secretTargets: Array<{ id: string; required: boolean }>;
    };
    expect(setupBody.surface).toBe('telegram');
    expect(setupBody.version).toBe(1);
    expect(setupBody.fields.some((field) => field.id === 'mode')).toBe(true);
    expect(setupBody.secretTargets.some((target) => target.id === 'primary' && target.required)).toBe(true);

    const doctor = await fetch(`http://127.0.0.1:${boundPort}/api/channels/doctor/signal`, { headers: auth });
    expect(doctor.status, doctor.status === 200 ? undefined : (await doctor.clone().text()).slice(0, 500)).toBe(200);
    const doctorBody = await doctor.json() as {
      surface: string;
      checks: Array<{ id: string; status: string }>;
      repairActions: Array<{ id: string }>;
    };
    expect(doctorBody.surface).toBe('signal');
    expect(doctorBody.checks.some((check) => check.id === 'configured')).toBe(true);
    expect(doctorBody.repairActions.some((action) => action.id === 'inspect')).toBe(true);

    const repairs = await fetch(`http://127.0.0.1:${boundPort}/api/channels/repair-actions/telegram`, { headers: auth });
    expect(repairs.status, repairs.status === 200 ? undefined : (await repairs.clone().text()).slice(0, 500)).toBe(200);
    const repairsBody = await repairs.json() as { actions: Array<{ id: string }> };
    expect(repairsBody.actions.some((action) => action.id === 'inspect')).toBe(true);

    const lifecycleBefore = await fetch(`http://127.0.0.1:${boundPort}/api/channels/lifecycle/telegram`, { headers: auth });
    expect(lifecycleBefore.status, lifecycleBefore.status === 200 ? undefined : (await lifecycleBefore.clone().text()).slice(0, 500)).toBe(200);
    const lifecycleBeforeBody = await lifecycleBefore.json() as { currentVersion: number; targetVersion: number };
    expect(lifecycleBeforeBody.currentVersion).toBe(0);
    expect(lifecycleBeforeBody.targetVersion).toBe(1);

    const inspectAction = await fetch(`http://127.0.0.1:${boundPort}/api/channels/accounts/telegram/actions/inspect`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(inspectAction.status, inspectAction.status === 200 ? undefined : (await inspectAction.clone().text()).slice(0, 500)).toBe(200);
    const inspectActionBody = await inspectAction.json() as { action: string; result: { action: string } };
    expect(inspectActionBody.action).toBe('inspect');
    expect(inspectActionBody.result.action).toBe('inspect');

    const allowlistResolve = await fetch(`http://127.0.0.1:${boundPort}/api/channels/allowlist/telegram/resolve`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ add: ['@alice', '#ops-room'] }),
    });
    expect(allowlistResolve.status, allowlistResolve.status === 200 ? undefined : (await allowlistResolve.clone().text()).slice(0, 500)).toBe(200);
    const allowlistResolveBody = await allowlistResolve.json() as { resolved: Array<{ kind: string; id: string }> };
    expect(allowlistResolveBody.resolved.some((entry) => entry.kind === 'user' && entry.id === 'alice')).toBe(true);
    expect(allowlistResolveBody.resolved.some((entry) => entry.kind === 'channel' && entry.id === 'ops-room')).toBe(true);

    const allowlistEdit = await fetch(`http://127.0.0.1:${boundPort}/api/channels/allowlist/telegram/edit`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ add: ['@alice', '#ops-room'] }),
    });
    expect(allowlistEdit.status, allowlistEdit.status === 200 ? undefined : (await allowlistEdit.clone().text()).slice(0, 500)).toBe(200);
    const allowlistEditBody = await allowlistEdit.json() as {
      updatedPolicy: { surface: string; allowlistUserIds: string[]; allowlistChannelIds: string[] };
    };
    expect(allowlistEditBody.updatedPolicy.surface).toBe('telegram');
    expect(allowlistEditBody.updatedPolicy.allowlistUserIds).toContain('alice');
    expect(allowlistEditBody.updatedPolicy.allowlistChannelIds).toContain('ops-room');
  });

  // Original server case 41, source line 2267.
  test('watcher control APIs can register, run, stop, and delete watchers', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch(`http://127.0.0.1:${boundPort}/api/watchers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        id: 'watcher-api-test',
        label: 'API watcher',
        intervalMs: 50,
      }),
    });
    expect(create.status, create.status === 201 ? undefined : (await create.clone().text()).slice(0, 500)).toBe(201);

    const update = await fetch(`http://127.0.0.1:${boundPort}/api/watchers/watcher-api-test`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        label: 'API watcher updated',
        kind: 'integration',
        sourceKind: 'api',
      }),
    });
    expect(update.status, update.status === 200 ? undefined : (await update.clone().text()).slice(0, 500)).toBe(200);
    const updated = await update.json() as { label?: string; kind?: string };
    expect(updated.label).toBe('API watcher updated');
    expect(updated.kind).toBe('integration');

    const start = await fetch(`http://127.0.0.1:${boundPort}/api/watchers/watcher-api-test/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(start.status, start.status === 200 ? undefined : (await start.clone().text()).slice(0, 500)).toBe(200);
    const started = await start.json() as { state: string };
    expect(started.state).toBe('running');

    const run = await fetch(`http://127.0.0.1:${boundPort}/api/watchers/watcher-api-test/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(run.status, run.status === 200 ? undefined : (await run.clone().text()).slice(0, 500)).toBe(200);
    const ran = await run.json() as { lastCheckpoint?: string };
    expect(typeof ran.lastCheckpoint).toBe('string');

    const stop = await fetch(`http://127.0.0.1:${boundPort}/api/watchers/watcher-api-test/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(stop.status, stop.status === 200 ? undefined : (await stop.clone().text()).slice(0, 500)).toBe(200);

    const remove = await fetch(`http://127.0.0.1:${boundPort}/api/watchers/watcher-api-test`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(remove.status, remove.status === 200 ? undefined : (await remove.clone().text()).slice(0, 500)).toBe(200);
  });

  // Original server case 42, source line 2331.
  test('generic webhook can create bindings and queue callback-based replies', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    await fetch(`http://127.0.0.1:${boundPort}/api/channels/policies/webhook`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ allowlistUserIds: [] }),
    });

    const generic = await fetch(`http://127.0.0.1:${boundPort}/webhook/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        surfaceId: 'ci-gateway',
        externalId: 'build-123',
        callbackUrl: 'https://example.com/callback',
        message: 'summarize the current build failure',
        title: 'CI gateway',
      }),
    });
    expect(generic.status, generic.status === 200 ? undefined : (await generic.clone().text()).slice(0, 500)).toBe(200);
    const genericBody = await generic.json() as { acknowledged: boolean; queued: boolean; bindingId: string; agentId: string };
    expect(genericBody.acknowledged).toBe(true);
    expect(genericBody.queued).toBe(true);
    expect(typeof genericBody.bindingId).toBe('string');
    expect(typeof genericBody.agentId).toBe('string');

    const list = await fetch(`http://127.0.0.1:${boundPort}/api/routes/bindings`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const listBody = await list.json() as { bindings: Array<{ id: string; surfaceKind: string; externalId: string }> };
    expect(listBody.bindings.some((binding) => binding.id === genericBody.bindingId && binding.surfaceKind === 'webhook' && binding.externalId === 'build-123')).toBe(true);
  });

  // Original server case 43, source line 2375.
  test('generic webhook requires explicit ingress configuration', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', false);
    config.setDynamic('surfaces.webhook.secret', '');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const generic = await fetch(`http://127.0.0.1:${boundPort}/webhook/generic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        surfaceId: 'ci-gateway',
        externalId: 'build-unconfigured',
        message: 'this should not spawn without configuration',
      }),
    });
    expect(generic.status, generic.status === 503 ? undefined : (await generic.clone().text()).slice(0, 500)).toBe(503);
  });

  // Original server case 44, source line 2395.
  test('generic webhook rejects unsafe callback URLs', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const generic = await fetch(`http://127.0.0.1:${boundPort}/webhook/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        surfaceId: 'ci-gateway',
        externalId: 'build-unsafe',
        callbackUrl: 'https://127.0.0.1/callback',
        message: 'attempt callback SSRF',
      }),
    });
    expect(generic.status, generic.status === 400 ? undefined : (await generic.clone().text()).slice(0, 500)).toBe(400);
  });

  // Original server case 45, source line 2419.
  test('generic webhook accepts HMAC signature and preserves correlation metadata', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-hmac-secret');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    await fetch(`http://127.0.0.1:${boundPort}/api/channels/policies/webhook`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ allowlistUserIds: [] }),
    });

    const payload = JSON.stringify({
      surfaceId: 'ci-gateway',
      externalId: 'build-124',
      message: 'summarize build 124',
      callbackUrl: 'https://example.com/callback',
      callbackSignature: 'hmac-sha256',
      correlationId: 'corr-124',
    });
    const signature = `sha256=${createHmac('sha256', 'webhook-hmac-secret').update(payload).digest('hex')}`;

    const res = await fetch(`http://127.0.0.1:${boundPort}/webhook/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Signature': signature,
      },
      body: payload,
    });
    expect(res.status, res.status === 200 ? undefined : (await res.clone().text()).slice(0, 500)).toBe(200);
    const body = await res.json() as { correlationId: string | null; bindingId: string; acknowledged: boolean };
    expect(body.acknowledged).toBe(true);
    expect(body.correlationId).toBe('corr-124');
    expect(typeof body.bindingId).toBe('string');
  });

  // Original server case 46, source line 2462.
  test('generic webhook rejects invalid HMAC signatures when configured', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-hmac-secret');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const res = await fetch(`http://127.0.0.1:${boundPort}/webhook/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Signature': 'invalid-signature',
      },
      body: JSON.stringify({
        surfaceId: 'ci-gateway',
        externalId: 'build-125',
        message: 'summarize build 125',
      }),
    });
    expect(res.status, res.status === 401 ? undefined : (await res.clone().text()).slice(0, 500)).toBe(401);
  });

  // Original server case 47, source line 2485.
  test('control-plane message API exposes published web-surface messages', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const messages = await fetch(`http://127.0.0.1:${boundPort}/api/control-plane/messages`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(messages.status, messages.status === 200 ? undefined : (await messages.clone().text()).slice(0, 500)).toBe(200);
    const body = await messages.json() as { messages: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
  });

  // Original server case 48, source line 2497.
  test('artifact APIs can create metadata records and stream stored content', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch(`http://127.0.0.1:${boundPort}/api/artifacts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'attachment', mimeType: 'text/markdown', filename: 'notes.md',
        text: '# shipped\n',
        metadata: { ticket: 'GV-1' },
      }),
    });
    expect(create.status, create.status === 201 ? undefined : (await create.clone().text()).slice(0, 500)).toBe(201);
    const createBody = await create.json() as { artifact: { id: string; filename?: string } };
    expect(createBody.artifact.filename).toBe('notes.md');

    const inspect = await fetch(`http://127.0.0.1:${boundPort}/api/artifacts/${createBody.artifact.id}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(inspect.status, inspect.status === 200 ? undefined : (await inspect.clone().text()).slice(0, 500)).toBe(200);
    expect((await inspect.json() as { artifact: { metadata: { ticket: string } } }).artifact.metadata.ticket).toBe('GV-1');

    const content = await fetch(`http://127.0.0.1:${boundPort}/api/artifacts/${createBody.artifact.id}/content?download=0`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(content.status, content.status === 200 ? undefined : (await content.clone().text()).slice(0, 500)).toBe(200);
    expect(content.headers.get('content-type')).toContain('text/markdown');
    expect(await content.text()).toBe('# shipped\n');

    const rawCreate = await fetch(`http://127.0.0.1:${boundPort}/api/artifacts?filename=raw-notes.txt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'text/plain',
        'X-GoodVibes-Filename': 'raw-notes.txt',
      },
      body: new Blob(['raw upload\n'], { type: 'text/plain' }),
    });
    expect(rawCreate.status, rawCreate.status === 201 ? undefined : (await rawCreate.clone().text()).slice(0, 500)).toBe(201);
    const rawCreateBody = await rawCreate.json() as { artifact: { id: string; filename?: string } };
    expect(rawCreateBody.artifact.filename).toBe('raw-notes.txt');

    const rawContent = await fetch(`http://127.0.0.1:${boundPort}/api/artifacts/${rawCreateBody.artifact.id}/content?download=0`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(rawContent.status, rawContent.status === 200 ? undefined : (await rawContent.clone().text()).slice(0, 500)).toBe(200);
    expect(rawContent.headers.get('content-type')).toContain('text/plain');
    expect(await rawContent.text()).toBe('raw upload\n');
  });

  // Original server case 49, source line 2551.
  test('home graph artifact ingest accepts multipart uploads without JSON encoding', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const form = new FormData();
    form.append('file', new Blob(['# Dishwasher\n\nReplace the filter monthly.\n'], { type: 'text/markdown' }), 'dishwasher.md');
    form.append('installationId', 'ha-test');
    form.append('title', 'Dishwasher manual');
    form.append('tags', 'manual,appliance');

    const response = await fetch(`http://127.0.0.1:${boundPort}/api/homeassistant/home-graph/ingest/artifact`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: form,
    });
    expect(response.status, response.status === 200 ? undefined : (await response.clone().text()).slice(0, 500)).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      spaceId: string;
      artifactId: string;
      source: { id: string; title?: string; artifactId?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.spaceId).toBe('homeassistant:ha-test');
    expect(body.artifactId).toBeTruthy();
    expect(body.source.artifactId).toBe(body.artifactId);
    expect(body.source.title).toBe('Dishwasher manual');
  });

  // Original server case 50, source line 2580.
  test('ntfy webhook creates route bindings and can spawn agents', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.ntfy.enabled', true);
    config.setDynamic('surfaces.ntfy.token', 'ntfy-test-token');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const ntfy = await fetch(`http://127.0.0.1:${boundPort}/webhook/ntfy?topic=${GOODVIBES_NTFY_AGENT_TOPIC}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Ntfy-Token': 'ntfy-test-token',
      },
      body: JSON.stringify({
        topic: GOODVIBES_NTFY_AGENT_TOPIC,
        message: 'summarize the latest deployment status',
        title: 'Ops alerts',
      }),
    });
    expect(ntfy.status, ntfy.status === 200 ? undefined : (await ntfy.clone().text()).slice(0, 500)).toBe(200);
    const ntfyBody = await ntfy.json() as { acknowledged: boolean; queued: boolean; bindingId: string };
    expect(ntfyBody.acknowledged).toBe(true);
    expect(ntfyBody.queued).toBe(true);
    expect(typeof ntfyBody.bindingId).toBe('string');

    const list = await fetch(`http://127.0.0.1:${boundPort}/api/routes/bindings`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const listBody = await list.json() as { bindings: Array<{ id: string; surfaceKind: string; externalId: string }> };
    expect(listBody.bindings.some((binding) => binding.id === ntfyBody.bindingId && binding.surfaceKind === 'ntfy' && binding.externalId === GOODVIBES_NTFY_AGENT_TOPIC)).toBe(true);
  });

  // Original server case 51, source line 2613.
  test('ntfy webhook rejects invalid ingress tokens', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.ntfy.enabled', true);
    config.setDynamic('surfaces.ntfy.token', 'ntfy-test-token');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const ntfy = await fetch(`http://127.0.0.1:${boundPort}/webhook/ntfy?topic=ops-alerts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Ntfy-Token': 'wrong-token',
      },
      body: JSON.stringify({
        topic: 'ops-alerts',
        message: 'this should not spawn',
        title: 'Ops alerts',
      }),
    });
    expect(ntfy.status, ntfy.status === 401 ? undefined : (await ntfy.clone().text()).slice(0, 500)).toBe(401);
  });

  // Original server case 52, source line 2636.
  test('telegram and Google Chat webhook ingress create route bindings and queue agents', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.telegram.enabled', true);
    config.setDynamic('surfaces.telegram.botUsername', 'goodvibes_bot');
    config.setDynamic('surfaces.googleChat.enabled', true);
    config.setDynamic('surfaces.googleChat.verificationToken', 'google-chat-token');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const telegram = await fetch(`http://127.0.0.1:${boundPort}/webhook/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 10,
        message: {
          message_id: 44,
          text: '/goodvibes summarize the deploy status',
          message_thread_id: 99,
          chat: { id: -100777, type: 'supergroup', title: 'Ops' },
          from: { id: 42, username: 'alice' },
        },
      }),
    });
    expect(telegram.status, telegram.status === 200 ? undefined : (await telegram.clone().text()).slice(0, 500)).toBe(200);
    const telegramBody = await telegram.json() as { queued: boolean; bindingId: string };
    expect(telegramBody.queued).toBe(true);

    const googleChat = await fetch(`http://127.0.0.1:${boundPort}/webhook/google-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'MESSAGE',
        token: 'google-chat-token',
        message: {
          text: 'summarize the release notes',
          argumentText: 'summarize the release notes',
          thread: { name: 'spaces/AAA/threads/BBB' },
        },
        space: { name: 'spaces/AAA', displayName: 'Ops Space' },
        user: { name: 'users/123', displayName: 'Alice' },
      }),
    });
    expect(googleChat.status, googleChat.status === 200 ? undefined : (await googleChat.clone().text()).slice(0, 500)).toBe(200);
    const googleChatBody = await googleChat.json() as { text: string };
    expect(googleChatBody.text).toContain('Running');

    const list = await fetch(`http://127.0.0.1:${boundPort}/api/routes/bindings`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const listBody = await list.json() as {
      bindings: Array<{ id: string; surfaceKind: string; externalId: string; channelId?: string }>;
    };
    expect(listBody.bindings.some((binding) => binding.id === telegramBody.bindingId && binding.surfaceKind === 'telegram' && binding.externalId === '99')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.surfaceKind === 'google-chat' && binding.externalId === 'spaces/AAA/threads/BBB')).toBe(true);
  });

  // Original server case 53, source line 2693.
  test('signal, WhatsApp, and iMessage ingress paths queue work and expose verification flows', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.signal.enabled', true);
    config.setDynamic('surfaces.signal.token', 'signal-bridge-token');
    config.setDynamic('surfaces.signal.account', '+15550001111');
    config.setDynamic('surfaces.whatsapp.enabled', true);
    config.setDynamic('surfaces.whatsapp.verifyToken', 'whatsapp-verify-token');
    config.setDynamic('surfaces.whatsapp.signingSecret', 'whatsapp-signing-secret');
    config.setDynamic('surfaces.whatsapp.phoneNumberId', '106540352242922');
    config.setDynamic('surfaces.imessage.enabled', true);
    config.setDynamic('surfaces.imessage.token', 'imessage-bridge-token');
    config.setDynamic('surfaces.imessage.account', 'me@icloud.test');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const challenge = await fetch(`http://127.0.0.1:${boundPort}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=whatsapp-verify-token&hub.challenge=abc123`);
    expect(challenge.status, challenge.status === 200 ? undefined : (await challenge.clone().text()).slice(0, 500)).toBe(200);
    expect(await challenge.text()).toBe('abc123');

    const signal = await fetch(`http://127.0.0.1:${boundPort}/webhook/signal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer signal-bridge-token',
      },
      body: JSON.stringify({
        recipient: '+15551212',
        message: 'signal deploy summary',
      }),
    });
    expect(signal.status, signal.status === 200 ? undefined : (await signal.clone().text()).slice(0, 500)).toBe(200);
    const signalBody = await signal.json() as { queued: boolean; bindingId: string };
    expect(signalBody.queued).toBe(true);

    const whatsappPayload = {
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: '106540352242922' },
            contacts: [{ profile: { name: 'Alice' } }],
            messages: [{
              id: 'wamid-123',
              from: '+15552323',
              text: { body: 'whatsapp deploy summary' },
            }],
          },
        }],
      }],
    };
    const whatsappBodyRaw = JSON.stringify(whatsappPayload);
    const whatsapp = await fetch(`http://127.0.0.1:${boundPort}/webhook/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'whatsapp-signing-secret').update(whatsappBodyRaw).digest('hex')}`,
      },
      body: whatsappBodyRaw,
    });
    expect(whatsapp.status, whatsapp.status === 200 ? undefined : (await whatsapp.clone().text()).slice(0, 500)).toBe(200);
    const whatsappBody = await whatsapp.json() as { queued: boolean; bindingId: string };
    expect(whatsappBody.queued).toBe(true);

    const imessage = await fetch(`http://127.0.0.1:${boundPort}/webhook/imessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer imessage-bridge-token',
      },
      body: JSON.stringify({
        chatId: 'chat-123',
        message: 'imessage deploy summary',
      }),
    });
    expect(imessage.status, imessage.status === 200 ? undefined : (await imessage.clone().text()).slice(0, 500)).toBe(200);
    const imessageBody = await imessage.json() as { queued: boolean; bindingId: string };
    expect(imessageBody.queued).toBe(true);

    const list = await fetch(`http://127.0.0.1:${boundPort}/api/routes/bindings`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const listBody = await list.json() as {
      bindings: Array<{ id: string; surfaceKind: string; externalId: string }>;
    };
    expect(listBody.bindings.some((binding) => binding.id === signalBody.bindingId && binding.surfaceKind === 'signal' && binding.externalId === '+15551212')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.id === whatsappBody.bindingId && binding.surfaceKind === 'whatsapp' && binding.externalId === '+15552323')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.id === imessageBody.bindingId && binding.surfaceKind === 'imessage' && binding.externalId === 'chat-123')).toBe(true);
  });

  // Original server case 54, source line 2782.
  test('msteams, BlueBubbles, Mattermost, and Matrix ingress paths queue work and persist route bindings', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.msteams.enabled', true);
    config.setDynamic('surfaces.msteams.appId', 'teams-app-id');
    config.setDynamic('surfaces.msteams.appPassword', 'teams-app-password');
    config.setDynamic('surfaces.bluebubbles.enabled', true);
    config.setDynamic('surfaces.bluebubbles.password', 'bb-pass');
    config.setDynamic('surfaces.bluebubbles.account', 'me@icloud.test');
    config.setDynamic('surfaces.mattermost.enabled', true);
    config.setDynamic('surfaces.mattermost.botToken', 'mattermost-bot-token');
    config.setDynamic('surfaces.mattermost.baseUrl', 'https://mattermost.example.test');
    config.setDynamic('surfaces.matrix.enabled', true);
    config.setDynamic('surfaces.matrix.accessToken', 'matrix-access-token');
    config.setDynamic('surfaces.matrix.homeserverUrl', 'https://matrix.example.test');
    daemon = await createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const teams = await fetch(`http://127.0.0.1:${boundPort}/webhook/msteams`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer teams-app-password',
      },
      body: JSON.stringify({
        type: 'message',
        serviceUrl: 'https://smba.trafficmanager.net/teams',
        conversation: { id: 'a:conversation-1', conversationType: 'personal' },
        from: { id: '29:user-1', name: 'Alice' },
        text: 'teams deployment summary',
      }),
    });
    expect(teams.status, teams.status === 200 ? undefined : (await teams.clone().text()).slice(0, 500)).toBe(200);
    const teamsBody = await teams.json() as { queued: boolean; bindingId: string };
    expect(teamsBody.queued).toBe(true);

    const bluebubbles = await fetch(`http://127.0.0.1:${boundPort}/webhook/bluebubbles?password=bb-pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'bluebubbles deployment summary',
        chatGuid: 'iMessage;-;+15551234567',
        senderId: '+15551234567',
      }),
    });
    expect(bluebubbles.status, bluebubbles.status === 200 ? undefined : (await bluebubbles.clone().text()).slice(0, 500)).toBe(200);
    const bluebubblesBody = await bluebubbles.json() as { queued: boolean; bindingId: string };
    expect(bluebubblesBody.queued).toBe(true);

    const mattermost = await fetch(`http://127.0.0.1:${boundPort}/webhook/mattermost`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer mattermost-bot-token',
      },
      body: JSON.stringify({
        channel_id: 'channel-123',
        team_id: 'team-ops',
        user_id: 'user-123',
        text: 'mattermost deployment summary',
      }),
    });
    expect(mattermost.status, mattermost.status === 200 ? undefined : (await mattermost.clone().text()).slice(0, 500)).toBe(200);
    const mattermostBody = await mattermost.json() as { queued: boolean; bindingId: string };
    expect(mattermostBody.queued).toBe(true);

    const matrix = await fetch(`http://127.0.0.1:${boundPort}/webhook/matrix`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer matrix-access-token',
      },
      body: JSON.stringify({
        room_id: '!room:example.test',
        sender: '@alice:example.test',
        content: {
          body: 'matrix deployment summary',
          msgtype: 'm.text',
        },
      }),
    });
    expect(matrix.status, matrix.status === 200 ? undefined : (await matrix.clone().text()).slice(0, 500)).toBe(200);
    const matrixBody = await matrix.json() as { queued: boolean; bindingId: string };
    expect(matrixBody.queued).toBe(true);

    const list = await fetch(`http://127.0.0.1:${boundPort}/api/routes/bindings`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const listBody = await list.json() as {
      bindings: Array<{ id: string; surfaceKind: string; externalId: string }>;
    };
    expect(listBody.bindings.some((binding) => binding.id === teamsBody.bindingId && binding.surfaceKind === 'msteams' && binding.externalId === 'a:conversation-1')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.id === bluebubblesBody.bindingId && binding.surfaceKind === 'bluebubbles' && binding.externalId === 'iMessage;-;+15551234567')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.id === mattermostBody.bindingId && binding.surfaceKind === 'mattermost' && binding.externalId === 'channel-123')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.id === matrixBody.bindingId && binding.surfaceKind === 'matrix' && binding.externalId === '!room:example.test')).toBe(true);
  });

  // Original server case 55, source line 2879.
  test('signed Slack approval callbacks cannot replace exact owner authority or stall autonomous tools', async () => {
    const previousSecret = process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_SIGNING_SECRET = 'slack-signing-secret-test';
    try {
      daemon.enable({ daemon: true }, TEST_TOKEN); await daemon.start();
      await proveAutonomousRead();
      const broker = runtimeServices.approvalBroker;
      const exact = await broker.raiseOwnerApproval({
        request: { callId: 'server-parity-slack-ask', tool: 'delegated.message.intake', args: { sourceRef: 'synthetic-owner-source' }, category: 'delegate',
          analysis: { classification: 'delegated-message', riskLevel: 'high', summary: 'Review the synthetic source reference', reasons: ['Exact owner decision required'] } },
        requireOwnerDecision: { assertCurrent() {} },
      });
      const body = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', user: { id: 'U123' }, channel: { id: 'C123' },
        actions: [{ action_id: `gv:approval:approve:${exact.approval.id}` }] }) }).toString();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac('sha256', 'slack-signing-secret-test').update(`v0:${timestamp}:${body}`).digest('hex')}`;
      const send = (signature: string) => fetch(`http://127.0.0.1:${boundPort}/webhook/slack`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': signature }, body });
      expect((await send('v0=invalid')).status).toBe(401);
      const response = await send(signature);
      expect(response.status, (await response.clone().text()).slice(0, 500)).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ code: 'INVALID_ARGUMENT', status: 400,
        error: 'This approval requires its exact current owner decision.' });
      expect(broker.getApproval(exact.approval.id)?.status).toBe('pending');
      await exact.resolveOwnerDecision({ decision: { approved: false }, actor: 'paired-owner', actorSurface: 'paired-gateway', assertCurrent() {} });
      expect(await exact.decision).toMatchObject({ approved: false });
      expect(broker.listApprovals().some(approval => approval.status === 'pending')).toBe(false);
    } finally {
      if (previousSecret === undefined) delete process.env.SLACK_SIGNING_SECRET; else process.env.SLACK_SIGNING_SECRET = previousSecret;
    }
  });

  // Original server case 56, source line 2952.
  test('POST /task returns 401 without token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'do something' }),
    });
    expect(res.status, res.status === 401 ? undefined : (await res.clone().text()).slice(0, 500)).toBe(401);
  });

  // Original server case 57, source line 2963.
  test('POST /task returns 202 acknowledgement with valid token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ task: 'do something' }),
    });
    expect(res.status, res.status === 202 ? undefined : (await res.clone().text()).slice(0, 500)).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(body.acknowledged).toBe(true);
  });

  // Original server case 58, source line 2979.
  test('daemon-spawned agents are visible through runtime task APIs', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const submit = await fetch(`http://127.0.0.1:${boundPort}/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ task: 'inspect daemon runtime task visibility' }),
    });
    expect(submit.status, submit.status === 202 ? undefined : (await submit.clone().text()).slice(0, 500)).toBe(202);
    const submitBody = await submit.json() as { agentId: string };
    expect(typeof submitBody.agentId).toBe('string');

    const detail = await fetch(`http://127.0.0.1:${boundPort}/api/tasks/${submitBody.agentId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(detail.status, detail.status === 200 ? undefined : (await detail.clone().text()).slice(0, 500)).toBe(200);
    const detailBody = await detail.json() as { task: { id: string; kind: string } };
    expect(detailBody.task.id).toBe(submitBody.agentId);
    expect(detailBody.task.kind).toBe('agent');
    const owner = runtimeServices.agentManager.getStatus(submitBody.agentId);
    expect(owner?.contractRole).toBe('owner');
    expect(typeof owner?.contractId).toBe('string');
    const contract = runtimeServices.contractRunner.get(owner!.contractId!);
    expect(contract?.ask).toBe('inspect daemon runtime task visibility');
    await waitFor(() => rootSignals.length > 0 ? true : null);
    expect(rootSignals.every(signal => !signal.aborted)).toBe(true);
    expect(runtimeServices.contractRunner.get(owner!.contractId!)?.status).not.toBe('awaiting-owner');
    expect(runtimeServices.approvalBroker.listApprovals().filter(approval => approval.status === 'pending')).toEqual([]);
    // Observe the real owner cancellation, rather than abandon its held reading.
    const cancelled = await fetch(`http://127.0.0.1:${boundPort}/api/tasks/${submitBody.agentId}/cancel`, {
      method: 'POST', headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(cancelled.status).toBe(200);
    await waitFor(() => rootSignals.every(signal => signal.aborted) ? true : null);
  });

  // Original server case 59, source line 3004.
  test('unknown route returns 404 with valid token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/does-not-exist`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

});
describe('HttpListener', () => {
  let listener: HttpListener;
  let userAuth: UserAuthManager;
  let tempRoot: string;
  let workingDir: string;
  let homeDir: string;
  let configDir: string;
  const makeConfig = () => new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir, homeDir });
  // Ephemeral-port harness (see the DaemonServer describe for rationale): bind
  // on port 0, capture the OS-assigned port, and skip HttpListener's pre-bind
  // OS port probe by injecting a serveFactory.
  let boundPort = 0;
  const capturingServe = ((options) => {
    const server = Bun.serve(options);
    if (server.port !== undefined) boundPort = server.port;
    return server;
  }) as typeof Bun.serve;
  const createTestListener = (options: {
    readonly configManager?: ConfigManager;
    readonly userAuth?: UserAuthManager;
    readonly serveFactory?: typeof Bun.serve;
    readonly port?: number;
    readonly host?: string;
  } = {}): HttpListener => new HttpListener({
    port: options.port ?? 0,
    host: options.host ?? '127.0.0.1',
    configManager: options.configManager ?? makeConfig(),
    userAuth: options.userAuth ?? userAuth,
    serveFactory: options.serveFactory ?? capturingServe,
  });

  beforeEach(() => {
    tempRoot = makeOwnedTempDir('gv-listener-config');
    workingDir = join(tempRoot, 'workspace');
    homeDir = join(tempRoot, 'home');
    configDir = join(homeDir, '.goodvibes', 'tui');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    userAuth = new UserAuthManager({
      bootstrapFilePath: join(configDir, 'auth-users.json'),
      bootstrapCredentialPath: join(configDir, 'auth-bootstrap.txt'),
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
    });
    listener = createTestListener();
  });

  afterEach(async () => {
    await listener.stop();
    // The official runner removes the owned tree after child exit.
  });

  test('isRunning is false before start', () => {
    expect(listener.isRunning).toBe(false);
  });

  test('refuses to start when disabled (default state)', async () => {
    await listener.start();
    expect(listener.isRunning).toBe(false);
  });

  test('enable returns false when danger.httpListener is false', () => {
    const result = listener.enable({ httpListener: false }, TEST_TOKEN);
    expect(result).toBe(false);
  });

  test('enable returns true when danger.httpListener is true', () => {
    const result = listener.enable({ httpListener: true }, TEST_TOKEN);
    expect(result).toBe(true);
  });

  test('starts when enabled', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    expect(listener.isRunning).toBe(true);
  });

  test('passes TLS options to Bun.serve when direct listener TLS is enabled', async () => {
    const certDir = join(homeDir, '.goodvibes', 'tui', 'certs');
    mkdirSync(certDir, { recursive: true });
    const certFile = join(certDir, 'fullchain.pem');
    const keyFile = join(certDir, 'privkey.pem');
    writeFileSync(certFile, 'CERT\n', 'utf-8');
    writeFileSync(keyFile, 'KEY\n', 'utf-8');
    const config = makeConfig();
    config.set('httpListener.tls.mode', 'direct');
    let capturedOptions: Record<string, unknown> | null = null;
    const serveFactory = mock((options: unknown) => {
      capturedOptions = options as Record<string, unknown>;
      return {
      stop: mock(() => {}),
      port: (capturedOptions as Record<string, unknown>).port,
      hostname: (capturedOptions as Record<string, unknown>).hostname,
    };
    });
    listener = createTestListener({
      configManager: config,
      serveFactory: serveFactory as unknown as typeof Bun.serve,
    });

    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();

    expect(serveFactory).toHaveBeenCalledTimes(1);
    expect(capturedOptions).toMatchObject({
      port: 0,
      hostname: '127.0.0.1',
      tls: {
        cert: Bun.file(certFile),
        key: Bun.file(keyFile),
      },
    });
  });

  test('stop works when running', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    await listener.stop();
    expect(listener.isRunning).toBe(false);
  });

  test('stop is safe when not running', async () => {
    await expect(listener.stop()).resolves.toBeUndefined();
    expect(listener.isRunning).toBe(false);
  });

  test('POST /webhook returns 401 without token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'push' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /login returns session token for valid credentials', async () => {
    listener.enable({ httpListener: true });
    await listener.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(typeof body.token).toBe('string');
    expect(res.headers.get('set-cookie')).toContain('goodvibes_session=');
  });

  test('POST /webhook returns 401 with wrong token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ event: 'push' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /webhook returns 202 acknowledgement with valid token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ event: 'push' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(body.acknowledged).toBe(true);
  });

  test('GET /health returns 200 with valid token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/health`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  test('GET /health returns 401 without token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/health`);
    expect(res.status).toBe(401);
  });

  test('unknown route returns 404 with valid token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch(`http://127.0.0.1:${boundPort}/unknown-path`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('rate limit: 61st request within window returns 429', async () => {
    // Use a fresh instance to get a clean rate-limit counter. Ephemeral bind
    // via the capturing factory (port 0) so concurrent runs never collide.
    const rl = new HttpListener({
      port: 0,
      host: '127.0.0.1',
      configManager: makeConfig(),
      userAuth: new UserAuthManager({
        bootstrapFilePath: join(configDir, 'auth-users.json'),
        bootstrapCredentialPath: join(configDir, 'auth-bootstrap.txt'),
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
      serveFactory: capturingServe,
    });
    rl.enable({ httpListener: true }, TEST_TOKEN);
    await rl.start();
    try {
      // Send 60 requests, all should succeed (or 404, not 429)
      for (let i = 0; i < 60; i++) {
        const accepted = await fetch(`http://127.0.0.1:${boundPort}/health`, {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(accepted.status).toBe(200);
      }
      // 61st request should be throttled
      const res = await fetch(`http://127.0.0.1:${boundPort}/health`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(429);
    } finally {
      await rl.stop();
    }
  });
});
