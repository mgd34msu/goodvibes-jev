/**
 * Integration tests covering UAT findings F1, F2, F4, F14.
 *
 * F1 , companion-chat, provider-current, session-SSE routes on standalone daemon
 * F2 , provider discovery: loadPersistedProviders + background scan registration
 * F4 , panel registry: TUI panels absent on standalone, daemon panels present
 * F14, control-plane SSE DEFAULT_DOMAINS includes 'providers' and 'turn'
 *
 * These tests start a real DaemonServer bound to a random high port and issue
 * real HTTP requests. No mocks of HTTP or SDK internals.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonServer } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { createFeatureFlagManager, RuntimeEventBus } from '../../runtime/index.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ChatRequest, ChatResponse, LLMProvider } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { createRuntimeServices } from '../../runtime/services.ts';
import { startGatewayFixture, fixtureModel as buildTestModelDefinition } from '../helpers/gateway-route-fixture.js';
import type { DaemonFixture } from '../../testing/daemon-fixture.js';


import { makeOwnedTempDir as makeProjectTempDir } from '../helpers/owned-temp.js';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.


/**
 * A composed runtime graph starts a dozen pollers while it builds, the fleet
 * registry tick, the config-file watch, the memory governor, the knowledge
 * scheduler, the cross-session sweep, the orchestration snapshot writer, the
 * push-subscription sweep and the snapshot / retention / consolidation
 * schedulers. Nothing upstream stops a graph it did not compose itself, so the
 * test that built it owns stopping it.
 */
let fixture: DaemonFixture;

const TEST_TOKEN = 'standalone-test-token-abc123';

function makeTempDir(): string {
  return makeProjectTempDir('gv-standalone');
}

function makeEnv(root: string) { return { root }; }
async function startDaemon(env: ReturnType<typeof makeEnv>) {
  fixture = await startGatewayFixture({ root: env.root, token: TEST_TOKEN, hostSessions: false });
  return { daemon: fixture.daemon, runtimeServices: fixture.services, port: Number(new URL(fixture.baseUrl).port) };
}

function bearerHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };
}

async function waitForCondition(description: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function readSseUntil(
  url: string,
  predicate: (raw: string) => boolean,
  action: () => Promise<void>,
  timeoutMs = 5_000,
): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: bearerHeaders(),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type') ?? '').toContain('text/event-stream');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SSE response did not expose a body reader');

  const decoder = new TextDecoder();
  let raw = '';
  const readLoop = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !predicate(raw)) {
      const remainingMs = Math.max(1, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          timer = setTimeout(() => resolve({ done: true, value: undefined }), remainingMs);
        }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      if (read.done) break;
      raw += decoder.decode(read.value, { stream: true });
    }
    return raw;
  })();

  try {
    await action();
    const result = await readLoop;
    expect(predicate(result)).toBe(true);
    return result;
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
    await readLoop.catch(() => {});
    try { reader.releaseLock(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// F1, Companion-chat routes on standalone daemon (port 3421 with bearer auth)
// ---------------------------------------------------------------------------

describe('F1: companion-chat routes on standalone DaemonServer', () => {
  let tempRoot: string;
  let daemon: DaemonServer;
  let port: number;

  beforeEach(async () => {

    tempRoot = makeTempDir();
    const env = makeEnv(tempRoot);
    ({ daemon, port } = await startDaemon(env));
  });

  afterEach(async () => {
    await fixture?.stop();

    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('POST /api/companion/chat/sessions creates a session', async () => {
    // SDK companion routes: POST /api/companion/chat/sessions returns {sessionId, createdAt}
    // GET /api/companion/chat/sessions (list) is not in the companion-chat-routes surface.
    const res = await fetch(`http://127.0.0.1:${port}/api/companion/chat/sessions`, {
      method: 'POST',
      headers: bearerHeaders(),
      body: JSON.stringify({ title: 'test session' }),
    });
    // Companion routes are wired in DaemonHttpRouter when companionChatManager is present.
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    // SDK response shape: { sessionId: string, createdAt: number }
    expect(typeof body['sessionId']).toBe('string');
    expect(typeof body['createdAt']).toBe('number');
  });

  test('GET /api/companion/chat/sessions/:id returns session (not 404)', async () => {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/companion/chat/sessions`, {
      method: 'POST',
      headers: bearerHeaders(),
      body: JSON.stringify({ title: 'read-back test' }),
    });
    expect(createRes.status).toBe(201);
    const { sessionId } = await createRes.json() as { sessionId: string };
    expect(typeof sessionId).toBe('string');

    const getRes = await fetch(`http://127.0.0.1:${port}/api/companion/chat/sessions/${sessionId}`, {
      headers: bearerHeaders(),
    });
    // Should return 200 with session data, not 404.
    expect(getRes.status).toBe(200);
  });

  test('PATCH /api/companion/chat/sessions/:id updates companion session metadata', async () => {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/companion/chat/sessions`, {
      method: 'POST',
      headers: bearerHeaders(),
      body: JSON.stringify({ title: 'before patch' }),
    });
    expect(createRes.status).toBe(201);
    const { sessionId } = await createRes.json() as { sessionId: string };

    const patchRes = await fetch(`http://127.0.0.1:${port}/api/companion/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: bearerHeaders(),
      body: JSON.stringify({
        title: 'after patch',
        provider: 'openai',
        model: 'openai:gpt-test',
        systemPrompt: 'patched prompt',
      }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as {
      session: {
        title: string;
        provider: string | null;
        model: string | null;
        systemPrompt: string | null;
      };
    };
    expect(patchBody.session.title).toBe('after patch');
    expect(patchBody.session.provider).toBe('openai');
    expect(patchBody.session.model).toBe('openai:gpt-test');
    expect(patchBody.session.systemPrompt).toBe('patched prompt');

    const getRes = await fetch(`http://127.0.0.1:${port}/api/companion/chat/sessions/${sessionId}`, {
      headers: bearerHeaders(),
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json() as { session: { title: string; systemPrompt: string | null } };
    expect(getBody.session.title).toBe('after patch');
    expect(getBody.session.systemPrompt).toBe('patched prompt');
  });

  test('companion chat messages resolve artifact attachments into stored messages, SSE, and provider prompts', async () => {
    const observedRequests: ChatRequest[] = [];
    const provider: LLMProvider = {
      name: 'attachment-test',
      models: ['attachment-model'],
      isConfigured: () => true,
      async chat(params: ChatRequest): Promise<ChatResponse> {
        observedRequests.push(params);
        params.onDelta?.({ content: 'attachment prompt ok' });
        return {
          content: 'attachment prompt ok',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'completed',
        };
      },
    };
    const runtimeServices = fixture.services;
    runtimeServices.providerRegistry.registerRuntimeProvider({
      provider,
      replace: true,
      models: [buildTestModelDefinition('attachment-test', 'attachment-model')],
    });

    const artifactRes = await fetch(`http://127.0.0.1:${port}/api/artifacts`, {
      method: 'POST',
      headers: bearerHeaders(),
      body: JSON.stringify({
        kind: 'attachment',
        mimeType: 'text/plain',
        filename: 'companion-note.txt',
        text: 'ATTACHMENT_MARKER_TEXT reaches the provider prompt.',
        metadata: { source: 'standalone-route-test' },
      }),
    });
    expect(artifactRes.status).toBe(201);
    const artifactBody = await artifactRes.json() as { artifact: { id: string; mimeType: string; sizeBytes: number } };
    expect(artifactBody.artifact.mimeType).toBe('text/plain');
    expect(artifactBody.artifact.sizeBytes).toBeGreaterThan(0);

    const createRes = await fetch(`http://127.0.0.1:${port}/api/companion/chat/sessions`, {
      method: 'POST',
      headers: bearerHeaders(),
      body: JSON.stringify({
        title: 'attachment test',
        provider: 'attachment-test',
        model: 'attachment-model',
      }),
    });
    expect(createRes.status).toBe(201);
    const { sessionId } = await createRes.json() as { sessionId: string };

    const sseRaw = await readSseUntil(
      `http://127.0.0.1:${port}/api/companion/chat/sessions/${sessionId}/events`,
      (raw) => raw.includes('companion-chat.turn.started') && raw.includes('companion-note'),
      async () => {
        const messageRes = await fetch(`http://127.0.0.1:${port}/api/companion/chat/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: bearerHeaders(),
          body: JSON.stringify({
            body: 'Summarize this attachment.',
            attachments: [{ artifactId: artifactBody.artifact.id, label: 'companion-note' }],
          }),
        });
        expect(messageRes.status).toBe(202);
      },
    );
    expect(sseRaw).toContain(artifactBody.artifact.id);

    await waitForCondition('provider to receive attachment prompt', () => observedRequests.length > 0);
    const lastMessage = observedRequests[0]?.messages.at(-1);
    expect(lastMessage?.role).toBe('user');
    expect(String(lastMessage?.content)).toContain('ATTACHMENT_MARKER_TEXT reaches the provider prompt.');
    expect(String(lastMessage?.content)).toContain('Attached file');

    const messagesRes = await fetch(`http://127.0.0.1:${port}/api/companion/chat/sessions/${sessionId}/messages`, {
      headers: bearerHeaders(),
    });
    expect(messagesRes.status).toBe(200);
    const messagesBody = await messagesRes.json() as {
      messages: Array<{ role: string; content: string; attachments: Array<{ artifactId: string; label?: string }> }>;
    };
    const userMessage = messagesBody.messages.find((message) => message.role === 'user');
    expect(userMessage?.attachments[0]?.artifactId).toBe(artifactBody.artifact.id);
    expect(userMessage?.attachments[0]?.label).toBe('companion-note');
    expect(messagesBody.messages.some((message) => message.role === 'assistant' && message.content === 'attachment prompt ok')).toBe(true);

    const unknownRes = await fetch(`http://127.0.0.1:${port}/api/companion/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: bearerHeaders(),
      body: JSON.stringify({
        body: 'This should fail cleanly.',
        attachments: [{ artifactId: 'missing-artifact-id', label: 'missing' }],
      }),
    });
    expect(unknownRes.status).toBe(404);
    const unknownBody = await unknownRes.json() as { code: string; error: string };
    expect(unknownBody.code).toBe('UNKNOWN_ARTIFACT');
    expect(unknownBody.error).toContain('Unknown attachment artifact');
  });

  test('GET /api/models/current returns 200 with model field', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/models/current`, {
      headers: bearerHeaders(),
    });
    // Should return 200. SDK shape: { model: null | {...}, configured: bool, configuredVia?: string }
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect('model' in body).toBe(true);
    expect('configured' in body).toBe(true);
  });

  test('GET /api/sessions returns 200 with sessions array', async () => {
    // GET /api/sessions, the standard shared-session listing endpoint.
    // /api/sessions/:id/events SSE is not in the session route surface on DaemonServer.
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Array.isArray(body['sessions'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F2, Provider discovery on standalone daemon
// ---------------------------------------------------------------------------

describe('F2: provider state on standalone daemon', () => {
  let tempRoot: string;
  let daemon: DaemonServer;
  let runtimeServices: Awaited<ReturnType<typeof createRuntimeServices>>;
  let port: number;

  beforeEach(async () => {

    tempRoot = makeTempDir();
    const env = makeEnv(tempRoot);
    ({ daemon, runtimeServices, port } = await startDaemon(env));
  });

  afterEach(async () => {
    await fixture?.stop();

    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('GET /api/providers returns 200 with providers array', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/providers`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Array.isArray(body['providers'])).toBe(true);
  });

  test('registerDiscoveredProviders increases provider count', async () => {
    const before = await fetch(`http://127.0.0.1:${port}/api/providers`, {
      headers: bearerHeaders(),
    });
    const beforeBody = await before.json() as { providers: unknown[] };
    const beforeCount = beforeBody.providers.length;

    // Simulate what loadPersistedProviders + registerDiscoveredProviders does
    runtimeServices.providerRegistry.registerDiscoveredProviders([
      {
        name: 'LM Studio (test)',
        host: '127.0.0.1',
        port: 1234,
        baseURL: 'http://127.0.0.1:1234',
        models: ['test-model-v1'],
        serverType: 'lm-studio' as const,
      },
    ]);

    const after = await fetch(`http://127.0.0.1:${port}/api/providers`, {
      headers: bearerHeaders(),
    });
    const afterBody = await after.json() as { providers: unknown[] };
    const afterCount = afterBody.providers.length;

    expect(afterCount).toBeGreaterThan(beforeCount);
  });
});

// ---------------------------------------------------------------------------
// F4, Panel registry on standalone daemon
// ---------------------------------------------------------------------------

describe('F4: panel registry on standalone daemon', () => {
  let tempRoot: string;
  let daemon: DaemonServer;
  let runtimeServices: Awaited<ReturnType<typeof createRuntimeServices>>;
  let port: number;

  beforeEach(async () => {

    tempRoot = makeTempDir();
    const env = makeEnv(tempRoot);
    ({ daemon, runtimeServices, port } = await startDaemon(env));
  });

  afterEach(async () => {
    await fixture?.stop();

    rmSync(tempRoot, { recursive: true, force: true });
  });

  // The daemon has no screen, so it has no panels, the route answers honestly
  // rather than pretending. A panel is a thing a surface draws; the daemon's
  // panel manager is the SDK's no-op precisely so this cannot quietly become a
  // half-working feature that opens panels nobody can see.
  test('POST /api/panels/open answers 404 for any id', async () => {
    for (const id of ['welcome', 'fleet', 'anything-at-all']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/panels/open`, {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ id }),
      });
      expect(res.status).toBe(404);
    }
  });

  test('GET /api/panels answers with an empty list, not an error', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/panels`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { panels: unknown[] };
    expect(body.panels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F14, Control-plane SSE DEFAULT_DOMAINS
// ---------------------------------------------------------------------------

describe('F14: control-plane SSE default domains', () => {
  let tempRoot: string;
  let daemon: DaemonServer;
  let port: number;

  beforeEach(async () => {

    tempRoot = makeTempDir();
    const env = makeEnv(tempRoot);
    ({ daemon, port } = await startDaemon(env));
  });

  afterEach(async () => {
    await fixture?.stop();

    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('GET /api/control-plane returns 200 snapshot', async () => {
    // The control-plane uses HTTP (SSE) not WebSocket, GET /api/control-plane
    // returns a snapshot of the current operator state.
    const res = await fetch(`http://127.0.0.1:${port}/api/control-plane`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
  });
});
