/**
 * installChatMockDaemon, a STATEFUL hermetic mock for the companion-chat journey.
 *
 * Unlike the baseline installMockDaemon (which answers companion chat with an empty,
 * stateless success), this keeps an in-memory chat store in the Node route handler so a
 * full modern-chat-app journey can be exercised end to end without any real daemon:
 * create a session, send a message and get a reply, regenerate a response, and edit a
 * message and branch, with the daemon's HONEST LINEAGE preserved (superseded messages
 * are retained in the list, flagged with supersededAt/supersededReason, never deleted).
 *
 * The app's 1s message-poll fallback (ChatView refetches messages.list while a turn is
 * active) is what advances each turn here, SSE streams are left pending, exactly as the
 * baseline mock does, so no event stream implementation is needed. NO real daemon, no
 * 3421/4444, no network beyond the local dev server.
 */

import type { Page, Route } from '@playwright/test';
import { describeOriginPostureForMock } from './mock-daemon';

const TOKEN_KEY = 'goodvibes.webui.token';

type Role = 'user' | 'assistant';

interface StoredMessage {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  attachments: { artifactId: string; label?: string }[];
  createdAt: number;
  supersededAt?: number;
  supersededReason?: 'regenerate' | 'edit';
  revisionOf?: string;
  deliveryState?: 'cancelled' | 'queued';
  inReplyTo?: string;
  /** Open metadata bag, same shape as the real wire (companion-chat-types.ts). Used by
   *  the memory-provenance chip proof: `{ memory: { recordIds: string[] } }`. */
  metadata?: Record<string, unknown>;
}

interface StoredSession {
  id: string;
  title: string;
  status: 'active' | 'closed';
  createdAt: number;
  updatedAt: number;
}

export interface ChatMockDaemon {
  /** Every session title update captured, in order. */
  titleUpdates: { sessionId: string; title: string }[];
  /** Snapshot the current stored messages for a session (active + retained). */
  messagesOf: (sessionId: string) => StoredMessage[];
  /** Every server-side turn cancel captured (companion.chat.turns.cancel). */
  cancelCalls: { sessionId: string; turnId?: string }[];
  /** Every steer captured (companion.chat.messages.steer). */
  steerCalls: { sessionId: string; body: string }[];
  /** Every sessions.toolCalls.cancel POST captured. */
  toolCallCancelCalls: { sessionId: string; callId: string }[];
  /** The current queued-messages store for a session (sessions.queuedMessages.*). */
  queuedMessagesOf: (sessionId: string) => { id: string; queuedAt: number; text: string }[];
  /** Every session the app has created, oldest first. */
  sessionIds: () => string[];
}

export interface ChatMockOptions {
  /**
   * Hold assistant replies instead of appending them instantly: the turn
   * stays visibly active so specs can exercise Stop, steering, and the
   * queued-send marker. A cancel or steer resolves the held turn (cancelled
   * partial persisted); nothing else does.
   */
  holdReplies?: boolean;
  /**
   * When set, every appended assistant reply carries
   * `metadata: { memory: { recordIds: [...] } }`, the memory-provenance chip proof
   * (MemoryProvenanceChip.tsx / lib/memory-provenance.ts's read convention). Default
   * unset (no metadata at all, matching a daemon that never stamps this).
   */
  assistantReplyMemoryRecordIds?: readonly string[];
  /**
   * Seed for sessions.queuedMessages.list/edit/delete (SDK 1.8.0's
   * interaction-wins round), keyed by sessionId. Default {} (no session has any
   * queued messages).
   */
  queuedMessages?: Readonly<Record<string, readonly { id: string; queuedAt: number; text: string }[]>>;
  /**
   * The source of the code block every assistant reply ends with. Default a
   * one-line console.log; the design proof passes a long line to prove code
   * scrolls inside its frame on a phone.
   */
  replyCode?: string;
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

export async function installChatMockDaemon(page: Page, options: ChatMockOptions = {}): Promise<ChatMockDaemon> {
  const sessions = new Map<string, StoredSession>();
  const messages = new Map<string, StoredMessage[]>();
  const titleUpdates: { sessionId: string; title: string }[] = [];
  const cancelCalls: { sessionId: string; turnId?: string }[] = [];
  const steerCalls: { sessionId: string; body: string }[] = [];
  const toolCallCancelCalls: { sessionId: string; callId: string }[] = [];
  // sessions.queuedMessages.* in-memory store, keyed by sessionId.
  const queuedMessagesBySession = new Map<string, { id: string; queuedAt: number; text: string }[]>();
  for (const [sessionId, seeded] of Object.entries(options.queuedMessages ?? {})) {
    queuedMessagesBySession.set(sessionId, seeded.map((m) => ({ ...m })));
  }
  // sessionId -> the user message whose reply is being held (an "active turn").
  const heldTurns = new Map<string, string>();
  let clock = 1_000;
  let seq = 0;
  const nextTime = () => (clock += 1);
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

  await page.addInitScript(([key, token]) => {
    try {
      window.localStorage.setItem(key, token);
    } catch {
      /* ignore */
    }
  }, [TOKEN_KEY, 'e2e-operator-token'] as const);

  function sessionDto(session: StoredSession) {
    const list = messages.get(session.id) ?? [];
    return {
      id: session.id,
      sessionId: session.id,
      kind: 'companion-chat',
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: list.length,
    };
  }

  function appendAssistantReply(sessionId: string, label: string) {
    const list = messages.get(sessionId) ?? [];
    const reply: StoredMessage = {
      id: nextId('a'),
      sessionId,
      role: 'assistant',
      content: `${label}\n\n\`\`\`js\n${options.replyCode ?? `console.log('reply ${seq}');`}\n\`\`\``,
      attachments: [],
      createdAt: nextTime(),
      ...(options.assistantReplyMemoryRecordIds?.length
        ? { metadata: { memory: { recordIds: options.assistantReplyMemoryRecordIds } } }
        : {}),
    };
    list.push(reply);
    messages.set(sessionId, list);
    return reply;
  }

  // The SDK's control.status helper and the settings modal use the direct
  // GET /status and /config routes (not the invoke gateway), register them
  // here too or they escape to the proxy target.
  await page.route('**/status', async (route) => json(route, { ok: true, status: 'running' }));
  await page.route('**/config', async (route) => json(route, {}));

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;
    const accept = request.headers()['accept'] ?? '';
    const body = (() => {
      try {
        return request.postDataJSON?.() as Record<string, unknown> | undefined;
      } catch {
        return undefined;
      }
    })();

    // SSE streams: leave pending (the poll fallback advances turns).
    if (accept.includes('text/event-stream') || path.includes('/events')) return;

    // Auth / health.
    if (path === '/api/control-plane/auth') {
      return json(route, { authenticated: true, username: 'operator', identity: { subject: 'operator' } });
    }
    if (path === '/api/local-auth') return json(route, { ok: true, mode: 'local', authenticated: true });

    // Capability probe.
    if (method === 'GET' && /\/api\/control-plane\/methods\/[^/]+$/.test(path)) {
      const methodId = decodeURIComponent(path.split('/').pop() ?? '');
      return json(route, { method: { id: methodId, title: methodId, transport: ['http'], scopes: [] } });
    }

    // Operator sessions union, empty is fine for the chat journey.
    if (method === 'GET' && path === '/api/sessions') {
      return json(route, { sessions: [], totals: { sessions: 0 } });
    }

    // memory.records.get, backs the memory-provenance chip's drill-in (a real record
    // per requested id, so the chip has something honest to show once expanded).
    const memoryRecordMatch = path.match(/^\/api\/memory\/records\/([^/]+)$/);
    if (method === 'GET' && memoryRecordMatch) {
      const id = decodeURIComponent(memoryRecordMatch[1]);
      return json(route, {
        record: {
          id, scope: 'project', cls: 'preference', summary: `Memory record ${id}`, tags: [], provenance: [],
          reviewState: 'fresh', confidence: 80, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
        },
      });
    }

    // ── Companion chat sessions ────────────────────────────────────────────
    if (method === 'GET' && path === '/api/companion/chat/sessions') {
      const list = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(sessionDto);
      return json(route, {
        sessions: list,
        totals: { sessions: list.length, active: list.length, closed: 0 },
      });
    }
    if (method === 'POST' && path === '/api/companion/chat/sessions') {
      const id = nextId('sess');
      const now = nextTime();
      const title = typeof body?.title === 'string' && body.title.trim() ? String(body.title) : 'New Chat';
      const session: StoredSession = { id, title, status: 'active', createdAt: now, updatedAt: now };
      sessions.set(id, session);
      messages.set(id, []);
      return json(route, { sessionId: id, createdAt: now, session: sessionDto(session) });
    }

    const detailMatch = path.match(/^\/api\/companion\/chat\/sessions\/([^/]+)$/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      const session = sessions.get(id);
      if (method === 'PATCH') {
        if (!session) return json(route, { error: 'Session not found', code: 'SESSION_NOT_FOUND' }, 404);
        if (typeof body?.title === 'string') {
          session.title = String(body.title);
          session.updatedAt = nextTime();
          titleUpdates.push({ sessionId: id, title: session.title });
        }
        return json(route, { session: sessionDto(session) });
      }
      if (method === 'DELETE') {
        sessions.delete(id);
        messages.delete(id);
        return json(route, { sessionId: id, deleted: true });
      }
      // GET detail.
      if (!session) return json(route, { error: 'Session not found', code: 'SESSION_NOT_FOUND' }, 404);
      return json(route, { session: sessionDto(session), messages: messages.get(id) ?? [] });
    }

    // messages list.
    const listMatch = path.match(/^\/api\/companion\/chat\/sessions\/([^/]+)\/messages$/);
    if (method === 'GET' && listMatch) {
      const id = decodeURIComponent(listMatch[1]);
      return json(route, { messages: messages.get(id) ?? [] });
    }
    // messages create.
    if (method === 'POST' && listMatch) {
      const id = decodeURIComponent(listMatch[1]);
      if (!sessions.has(id)) return json(route, { error: 'Session not found', code: 'SESSION_NOT_FOUND' }, 404);
      const list = messages.get(id) ?? [];
      const content = typeof body?.body === 'string' ? body.body : (typeof body?.content === 'string' ? body.content : '');
      const attachments = Array.isArray(body?.attachments) ? (body.attachments as StoredMessage['attachments']) : [];
      const turnActive = heldTurns.has(id);
      const userMsg: StoredMessage = {
        id: nextId('u'), sessionId: id, role: 'user', content, attachments, createdAt: nextTime(),
        ...(turnActive ? { deliveryState: 'queued' as const } : {}),
      };
      list.push(userMsg);
      messages.set(id, list);
      if (options.holdReplies) {
        if (!turnActive) heldTurns.set(id, userMsg.id);
        // Queued sends stay queued until the held turn resolves (cancel/steer).
      } else {
        appendAssistantReply(id, 'Assistant reply');
      }
      return json(route, { messageId: userMsg.id });
    }

    // sessions.toolCalls.cancel (SDK 1.8.0's interaction-wins round), stop one
    // running tool call mid-flight; the turn continues (this mock never ends it).
    const toolCallCancelMatch = path.match(/^\/api\/sessions\/([^/]+)\/tool-calls\/([^/]+)\/cancel$/);
    if (method === 'POST' && toolCallCancelMatch) {
      const sessionId = decodeURIComponent(toolCallCancelMatch[1]);
      const callId = decodeURIComponent(toolCallCancelMatch[2]);
      toolCallCancelCalls.push({ sessionId, callId });
      return json(route, { sessionId, callId, cancelled: true });
    }

    // sessions.queuedMessages.list/edit/delete (SDK 1.8.0's interaction-wins round).
    const queuedMessageItemMatch = path.match(/^\/api\/sessions\/([^/]+)\/queued-messages\/([^/]+)$/);
    if (queuedMessageItemMatch) {
      const sessionId = decodeURIComponent(queuedMessageItemMatch[1]);
      const messageId = decodeURIComponent(queuedMessageItemMatch[2]);
      const queued = queuedMessagesBySession.get(sessionId) ?? [];
      if (method === 'POST') {
        const editBody = (body ?? {}) as { text?: string };
        const existing = queued.find((m) => m.id === messageId);
        if (existing) existing.text = editBody.text ?? existing.text;
        return json(route, { sessionId, id: messageId, text: existing?.text ?? editBody.text ?? '' });
      }
      if (method === 'DELETE') {
        const index = queued.findIndex((m) => m.id === messageId);
        const deleted = index >= 0;
        if (deleted) queued.splice(index, 1);
        queuedMessagesBySession.set(sessionId, queued);
        return json(route, { sessionId, id: messageId, deleted });
      }
    }
    const queuedMessagesListMatch = path.match(/^\/api\/sessions\/([^/]+)\/queued-messages$/);
    if (method === 'GET' && queuedMessagesListMatch) {
      const sessionId = decodeURIComponent(queuedMessagesListMatch[1]);
      return json(route, { sessionId, messages: queuedMessagesBySession.get(sessionId) ?? [] });
    }

    // POST /turns/cancel, resolve the held turn as a cancelled partial.
    const cancelMatch = path.match(/^\/api\/companion\/chat\/sessions\/([^/]+)\/turns\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]);
      const turnUserId = heldTurns.get(id);
      cancelCalls.push({ sessionId: id, ...(typeof body?.turnId === 'string' ? { turnId: body.turnId } : {}) });
      if (!sessions.has(id)) return json(route, { error: 'Session not found', code: 'SESSION_NOT_FOUND' }, 404);
      if (!turnUserId) return json(route, { error: 'No turn in flight', code: 'NO_ACTIVE_TURN' }, 404);
      heldTurns.delete(id);
      const list = messages.get(id) ?? [];
      list.push({
        id: nextId('a'), sessionId: id, role: 'assistant',
        content: 'This partial reply was being generated when',
        attachments: [], createdAt: nextTime(),
        deliveryState: 'cancelled', inReplyTo: turnUserId,
      });
      messages.set(id, list);
      return json(route, { sessionId: id, turnId: 'e2e-turn-1', cancelled: true, partialPersisted: true });
    }

    // POST /messages/steer, cancel the held turn (partial) and answer NOW.
    const steerMatch = path.match(/^\/api\/companion\/chat\/sessions\/([^/]+)\/messages\/steer$/);
    if (method === 'POST' && steerMatch) {
      const id = decodeURIComponent(steerMatch[1]);
      if (!sessions.has(id)) return json(route, { error: 'Session not found', code: 'SESSION_NOT_FOUND' }, 404);
      const content = typeof body?.body === 'string' ? body.body : (typeof body?.content === 'string' ? body.content : '');
      steerCalls.push({ sessionId: id, body: content });
      const list = messages.get(id) ?? [];
      const interrupted = heldTurns.get(id);
      let cancelledTurnId: string | undefined;
      if (interrupted) {
        heldTurns.delete(id);
        cancelledTurnId = 'e2e-turn-1';
        list.push({
          id: nextId('a'), sessionId: id, role: 'assistant',
          content: 'This partial reply was being generated when',
          attachments: [], createdAt: nextTime(),
          deliveryState: 'cancelled', inReplyTo: interrupted,
        });
      }
      const userMsg: StoredMessage = {
        id: nextId('u'), sessionId: id, role: 'user', content, attachments: [], createdAt: nextTime(),
      };
      list.push(userMsg);
      messages.set(id, list);
      list.push({
        id: nextId('a'), sessionId: id, role: 'assistant',
        content: `Steered reply`, attachments: [], createdAt: nextTime(), inReplyTo: userMsg.id,
      });
      return json(route, {
        sessionId: id, messageId: userMsg.id, steered: true, turnStarted: true,
        ...(cancelledTurnId ? { cancelledTurnId } : {}),
      }, 202);
    }

    // regenerate (retry): supersede the last active assistant + anything after, append fresh.
    const retryMatch = path.match(/^\/api\/companion\/chat\/sessions\/([^/]+)\/messages\/retry$/);
    if (method === 'POST' && retryMatch) {
      const id = decodeURIComponent(retryMatch[1]);
      const list = messages.get(id) ?? [];
      const active = list.filter((m) => !m.supersededAt);
      const targetId = typeof body?.messageId === 'string'
        ? body.messageId
        : [...active].reverse().find((m) => m.role === 'assistant')?.id;
      const target = list.find((m) => m.id === targetId && m.role === 'assistant' && !m.supersededAt);
      if (!target) return json(route, { error: 'No assistant message to regenerate', code: 'NO_ASSISTANT_MESSAGE' }, 409);
      const now = nextTime();
      const superseded: string[] = [];
      for (const m of list) {
        if (!m.supersededAt && m.createdAt >= target.createdAt) {
          m.supersededAt = now;
          m.supersededReason = 'regenerate';
          superseded.push(m.id);
        }
      }
      appendAssistantReply(id, 'Regenerated reply');
      return json(route, { sessionId: id, regeneratedFrom: target.id, supersededMessageIds: superseded, turnStarted: true }, 202);
    }

    // edit-and-branch: supersede the target user message + everything after, append a new
    // user message carrying revisionOf, then a fresh reply.
    const editMatch = path.match(/^\/api\/companion\/chat\/sessions\/([^/]+)\/messages\/edit$/);
    if (method === 'POST' && editMatch) {
      const id = decodeURIComponent(editMatch[1]);
      const list = messages.get(id) ?? [];
      const targetId = typeof body?.messageId === 'string' ? body.messageId : '';
      const content = typeof body?.content === 'string' ? body.content : (typeof body?.body === 'string' ? body.body : '');
      const target = list.find((m) => m.id === targetId && m.role === 'user' && !m.supersededAt);
      if (!target) return json(route, { error: 'messageId is required', code: 'INVALID_INPUT' }, 400);
      const now = nextTime();
      const superseded: string[] = [];
      for (const m of list) {
        if (!m.supersededAt && m.createdAt >= target.createdAt) {
          m.supersededAt = now;
          m.supersededReason = 'edit';
          superseded.push(m.id);
        }
      }
      const newUser: StoredMessage = {
        id: nextId('u'), sessionId: id, role: 'user', content, attachments: [], createdAt: nextTime(), revisionOf: target.id,
      };
      list.push(newUser);
      messages.set(id, list);
      appendAssistantReply(id, 'Answer to the edited question');
      return json(route, { sessionId: id, editedFrom: target.id, messageId: newUser.id, supersededMessageIds: superseded, turnStarted: true }, 202);
    }

    // Artifacts upload (composer attachments).
    if (method === 'POST' && (path === '/api/artifacts' || /artifacts\.create/.test(path))) {
      return json(route, { artifact: { id: nextId('art'), artifactId: nextId('art') }, artifactId: nextId('art') });
    }

    // Models / providers, minimal so the composer's picker renders without error.
    if (path.startsWith('/api/models') || path.startsWith('/api/providers')) {
      if (path.endsWith('/current')) return json(route, { model: {} });
      return json(route, { providers: [], models: [] });
    }

    // Generic invoke + fallback.
    const invokeMatch = path.match(/^\/api\/control-plane\/methods\/([^/]+)\/invoke$/);
    if (method === 'POST' && invokeMatch) {
      const methodId = decodeURIComponent(invokeMatch[1]);
      // pairing.posture.get (SDK 1.8.0), computed from the SAME algorithm the real
      // daemon runs, keyed off the caller's own origin (useOriginPosture/
      // usePairingHandoff always pass window.location.origin), so a spec served from a
      // real private-network address (lan-origin-posture.e2e.ts) gets the exact daemon
      // wording here too, not just from the baseline installMockDaemon.
      if (methodId === 'pairing.posture.get') {
        const invokeBody = (body as { body?: { origin?: string } } | undefined)?.body;
        const origin = invokeBody?.origin ?? 'http://127.0.0.1:4318';
        return json(route, { posture: describeOriginPostureForMock(origin) });
      }
      return json(route, {});
    }
    return json(route, {});
  });

  return {
    titleUpdates,
    messagesOf: (sessionId: string) => messages.get(sessionId) ?? [],
    cancelCalls,
    steerCalls,
    toolCallCancelCalls,
    queuedMessagesOf: (sessionId: string) => queuedMessagesBySession.get(sessionId) ?? [],
    sessionIds: () => [...sessions.keys()],
  };
}
