/**
 * Adapted from daemon 254699b with fixture metadata/intake and Jev readings.
 * The daemon over its real wire: a running DaemonServer on an ephemeral port
 * (src/testing/daemon-fixture.ts), driven only through HTTP, SSE and
 * WebSocket, the way every client reaches it. Nothing here calls
 * gatewayMethods.invoke in process.
 *
 *   - a WebSocket upgrade with a bad token is refused before it is upgraded
 *   - an SSE client that reconnects with Last-Event-ID receives exactly the
 *     events it missed
 *   - a hosted session is created, runs a turn against a scripted model,
 *     detaches, and reattaches with its transcript
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { connect } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

/** Only the two readings this synthetic text-only turn requires are supplied. */
function installWireReadings() {
  const core = fakePort((name, question) => {
    if (name === 'intent') return choiceAnswer(question, 'chat', 0.97);
    if (name === 'needs_plan') return noulAnswer(0.03);
    if (name === 'risk') return scoreAnswer(question, 0, 0.97);
    throw new Error(`Unexpected wire core fixture question: ${name}`);
  });
  const intake = fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, 'converse', 0.97);
    throw new Error(`Unexpected wire intake fixture question: ${name}`);
  });
  const port: JudgmentPort = {
    model: core.port.model,
    ask(request) {
      const battery = request.context?.battery;
      if (battery === 'engine.core.turn-shape') return core.port.ask(request);
      if (battery === 'contract.request-route') return intake.port.ask(request);
      return Promise.reject(new Error(`Unexpected wire fixture battery: ${battery ?? '(unnamed)'}`));
    },
  };
  const previous = installJudgmentPort(port);
  return { restore: () => { installJudgmentPort(previous); } };
}

let fixture: DaemonFixture;
let discovery: ReturnType<typeof spyOn> | undefined;

// ── the scripted model a hosted turn calls ────────────────────────────────────
const REPLY_MARKER = `wire-reply-${Math.random().toString(36).slice(2)}`;
const modelRequests: { messages: string; stream: boolean; model: string | undefined }[] = [];
let modelServer: ReturnType<typeof Bun.serve> | null = null;

function startScriptedModel(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'wire-model' }] });
      if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') return new Response('Unexpected fixture request', { status: 404 });
      const body = await request.json() as { messages?: unknown[]; stream?: boolean; model?: string };
      modelRequests.push({ messages: JSON.stringify(body.messages ?? []), stream: body.stream === true, model: body.model });
      const content = `${REPLY_MARKER} answered`;
      if (body.stream === true) {
        const chunk = (delta: Record<string, unknown>, finish: string | null): string => `data: ${JSON.stringify({
          id: 'chatcmpl-wire',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'wire-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
        return new Response(
          chunk({ role: 'assistant', content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return Response.json({
        id: 'chatcmpl-wire',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'wire-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    },
  });
}

beforeAll(async () => {
  const root = makeOwnedTempDir('gv-daemon-wire');
  const cache = join(root, 'home', '.goodvibes', 'tui');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'benchmarks.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
  discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  fixture = await startDaemonFixture({ root,
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
  });
  modelServer = startScriptedModel();
  // The seam boot uses for the persisted discovery cache: the daemon's own
  // registry learns the server, and every hosted floor copies it from there.
  fixture.services.providerRegistry.registerDiscoveredProviders([{
    name: 'wire-stub',
    host: '127.0.0.1',
    port: modelServer.port!,
    baseURL: `http://127.0.0.1:${modelServer.port}/v1`,
    models: ['wire-model'],
    serverType: 'vllm',
  }]);
});

afterAll(async () => {
  try { await fixture?.stop(); }
  finally { modelServer?.stop(true); discovery?.mockRestore(); }
});

/** Invoke a gateway verb through the HTTP control plane. */
async function invokeOverHttp<T>(methodId: string, body: Record<string, unknown>): Promise<T> {
  const response = await fixture.fetch(`/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  const payload = await response.json() as unknown;
  if (!response.ok) throw new Error(`${methodId} -> ${response.status} ${JSON.stringify(payload)}`);
  return payload as T;
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── (a) WebSocket authentication ─────────────────────────────────────────────

/** Send a raw WebSocket upgrade request and return the HTTP status line the server answers. */
function rawUpgradeStatusLine(authorization: string | null): Promise<string> {
  const { hostname, port } = new URL(fixture.baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write([
        'GET /api/control-plane/ws?clientKind=web HTTP/1.1',
        `Host: ${hostname}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...(authorization ? [`Authorization: ${authorization}`] : []),
        '',
        '',
      ].join('\r\n'));
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      const end = received.indexOf('\r\n');
      if (end >= 0) {
        socket.destroy();
        resolve(received.slice(0, end));
      }
    });
    socket.on('error', reject);
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error('no answer to the upgrade request')); });
  });
}

/** Open a WebSocket with the given bearer token; report whether it opened and its first message. */
function openSocket(token: string): Promise<{ opened: boolean; firstMessage: string | null }> {
  const url = `${fixture.baseUrl.replace(/^http/, 'ws')}/api/control-plane/ws?clientKind=web`;
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[]);
  return new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const finish = (firstMessage: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ opened, firstMessage });
      // close() can dispatch onclose synchronously; the result is already settled.
      socket.close();
    };
    const timer = setTimeout(() => finish(null), 10_000);
    socket.onopen = () => { opened = true; };
    socket.onmessage = (message) => finish(String(message.data));
    socket.onerror = () => finish(null);
    socket.onclose = () => finish(null);
  });
}

describe('WebSocket upgrade authentication', () => {
  test('an upgrade carrying a wrong bearer token is refused with 401 and never opens', async () => {
    expect(await rawUpgradeStatusLine('Bearer not-the-daemon-token')).toMatch(/^HTTP\/1\.1 401\b/);
    const attempt = await openSocket('not-the-daemon-token');
    expect(attempt.opened).toBe(false);
    expect(attempt.firstMessage).toBeNull();
  });

  test('an upgrade with no credential at all is refused with 401', async () => {
    expect(await rawUpgradeStatusLine(null)).toMatch(/^HTTP\/1\.1 401\b/);
  });

  test('the daemon token upgrades, and the socket is served the ready frame', async () => {
    const attempt = await openSocket(fixture.token);
    expect(attempt.opened).toBe(true);
    expect(JSON.parse(attempt.firstMessage ?? '{}')).toMatchObject({ type: 'event', event: 'ready' });
    expect(await rawUpgradeStatusLine(`Bearer ${fixture.token}`)).toMatch(/^HTTP\/1\.1 101\b/);
  });
});

// ── (b) SSE replay after reconnect ───────────────────────────────────────────

interface SseFrame {
  readonly id: string | null;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** An open control-plane SSE stream, parsed frame by frame as it arrives. */
interface SseStream {
  readonly frames: SseFrame[];
  close(): void;
}

async function openEventStream(lastEventId?: string): Promise<SseStream> {
  const abort = new AbortController();
  const response = await fixture.fetch('/api/control-plane/events', {
    signal: abort.signal,
    headers: { Accept: 'text/event-stream', ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
  });
  expect(response.status).toBe(200);
  const frames: SseFrame[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          let id: string | null = null;
          let event = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          frames.push({ id, event, data: JSON.parse(data.join('\n') || '{}') as Record<string, unknown> });
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return { frames, close: () => abort.abort() };
}

function hostedSessionCreatedIn(frames: readonly SseFrame[], sessionId: string): SseFrame | undefined {
  return frames.find((frame) => frame.event === 'hosted-session-update'
    && frame.data['event'] === 'hosted-session-created'
    && (frame.data['session'] as { id?: string } | undefined)?.id === sessionId);
}

interface HostedSession {
  readonly id: string;
  readonly status: string;
  readonly attachedClients: readonly string[];
  readonly messageCount: number;
  readonly terminatedReason?: string;
}

describe('SSE replay after a reconnect with Last-Event-ID', () => {
  test('the reconnecting client receives the events it missed, and nothing it already had', async () => {
    const first = await openEventStream();
    const before = await invokeOverHttp<{ session: HostedSession }>('sessions.hosted.create', {
      workspaceRoot: fixture.workingDirectory, clientId: 'sse-before', detachPolicy: 'survive',
    });
    await waitFor('the first stream to carry the first session', () => hostedSessionCreatedIn(first.frames, before.session.id) !== undefined);
    first.close();
    const seenIds = new Set(first.frames.map((frame) => frame.id).filter((id): id is string => id !== null));
    const checkpoint = [...first.frames].reverse().find((frame) => frame.id !== null)!.id!;

    // Both happen while no stream is open; awaiting the calls establishes
    // their order independently of any wall-clock delay.
    const missed = [];
    for (const clientId of ['sse-missed-one', 'sse-missed-two']) {
      missed.push(await invokeOverHttp<{ session: HostedSession }>('sessions.hosted.create', {
        workspaceRoot: fixture.workingDirectory, clientId, detachPolicy: 'survive',
      }));
    }

    const second = await openEventStream(checkpoint);
    try {
      // The server emits ready, synchronous replay, then its first heartbeat.
      // Observe that actual completion boundary before checking cardinality.
      await waitFor('the resumed replay completion heartbeat', () => second.frames.some((frame) => frame.event === 'heartbeat'), 10_000);
      const readyIndex = second.frames.findIndex((frame) => frame.event === 'ready');
      const heartbeatIndex = second.frames.findIndex((frame) => frame.event === 'heartbeat');
      expect(readyIndex).toBeGreaterThanOrEqual(0);
      expect(heartbeatIndex).toBeGreaterThan(readyIndex);
      const ready = second.frames[readyIndex]!;
      expect(ready.data['resume']).toMatchObject({ resume: 'resumed', sinceId: checkpoint });
      const replay = second.frames.slice(readyIndex + 1, heartbeatIndex);
      const replayIds = replay.flatMap((frame) => frame.id === null ? [] : [frame.id]);
      expect(new Set(replayIds).size).toBe(replayIds.length);
      const createdIds = replay.filter((frame) => frame.event === 'hosted-session-update'
        && frame.data['event'] === 'hosted-session-created')
        .map((frame) => (frame.data['session'] as { id: string }).id);
      expect(createdIds).toEqual(missed.map((result) => result.session.id));
      const redelivered = second.frames.filter((frame) => frame.id !== null && seenIds.has(frame.id));
      expect(redelivered.map((frame) => `${frame.event} ${frame.id}`)).toEqual([]);
    } finally {
      second.close();
      await invokeOverHttp('sessions.hosted.kill', { sessionId: before.session.id });
      for (const result of missed) await invokeOverHttp('sessions.hosted.kill', { sessionId: result.session.id });
    }
  });
});

// ── (c) a hosted session end to end ──────────────────────────────────────────

describe('a hosted session over the HTTP control plane', () => {
  test('create, one turn on the scripted model, detach, reattach with the transcript', async () => {
    const created = await invokeOverHttp<{ session: HostedSession }>('sessions.hosted.create', {
      workspaceRoot: fixture.workingDirectory,
      clientId: 'wire-client',
      modelId: 'wire-stub:wire-model',
      detachPolicy: 'survive',
      title: 'daemon wire test',
    });
    const sessionId = created.session.id;
    expect(created.session.status).toBe('idle');

    // The floor installs its settings port while the session is created. Supply
    // deterministic readings after that point, and retire them before the floor.
    const readings = installWireReadings();
    let restored = false;
    try {
      await invokeOverHttp('sessions.steer', { sessionId, body: 'say hello from the wire test' });
      await waitFor('the scripted model to be called', () => modelRequests.some((request) => request.messages.includes('say hello from the wire test')));
      await waitFor('the reply to land in the session', async () => {
        const { sessions } = await invokeOverHttp<{ sessions: HostedSession[] }>('sessions.hosted.list', {});
        return (sessions.find((session) => session.id === sessionId)?.messageCount ?? 0) >= 2;
      });

      expect(modelRequests.some((request) => request.stream && request.model === 'wire-model')).toBe(true);

      const detached = await invokeOverHttp<{ session: HostedSession }>('sessions.hosted.detach', { sessionId, clientId: 'wire-client' });
      expect(detached.session.status).toBe('idle');
      expect(detached.session.attachedClients).toEqual([]);

      const reattached = await invokeOverHttp<{ session: HostedSession; history: { role: string; content: string }[] }>(
        'sessions.hosted.attach', { sessionId, clientId: 'wire-client-2' },
      );
      expect(reattached.session.id).toBe(sessionId);
      expect(reattached.session.status).not.toBe('terminated');
      expect(reattached.session.attachedClients).toContain('wire-client-2');
      expect(reattached.history.some((message) => message.role === 'user' && message.content.includes('say hello from the wire test'))).toBe(true);
      expect(reattached.history.some((message) => message.role === 'assistant' && message.content.includes(REPLY_MARKER))).toBe(true);

      readings.restore(); restored = true;
      const killed = await invokeOverHttp<{ session: HostedSession }>('sessions.hosted.kill', { sessionId });
      expect(killed.session.terminatedReason).toBe('killed');
    } finally { if (!restored) readings.restore(); }
  });
});
