/**
 * Tests for useChatSend lineage and selection lifetime.
 *
 * Tests use a lightweight React DOM harness (createRoot + flushSync) with
 * a real QueryClientProvider. The sdk module is mocked to prevent HTTP calls.
 * Finite synthetic SDK replies include deferred success and failure. The real
 * hook and QueryClient own each mutation and its completion callbacks.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChatSend } from './useChatSend';
import type { UseChatSendReturn } from './useChatSend';
import type { ChatMessage } from './types';
import type { LocalCompanionMessage } from '../../lib/companion-chat';
import { createChatSelectionTracker } from '../../lib/chat-selection';
import { invalidateClientLifetime } from '../../lib/client-lifetime';

// ---------------------------------------------------------------------------
// Mock sdk, prevents real HTTP calls from the mutation function
// ---------------------------------------------------------------------------
// `createMessageImpl` is reassignable per-test (e.g. to reject with a 401) since
// mock.module locks in the module shape once, but not what the inner fn does.
let createMessageImpl: (sessionId: string, input: { body: string }) => Promise<unknown> = async () => ({ messageId: 'msg-test' });
let createSessionImpl: () => Promise<unknown> = async () => ({ sessionId: 'sess-test' });
let retryImpl: () => Promise<unknown> = async () => ({});
let editImpl: () => Promise<unknown> = async () => ({});
const createSessionCalls: string[] = [];
const createMessageCalls: { sessionId: string; body: string }[] = [];
const fixtureClients = new Set<QueryClient>();
const fixtureUnmounts = new Set<() => void>();
const deferredRejections = new Set<() => void>();
const fixtureSettlements = new Set<Promise<void>>();

// Spies for the honest-lineage verbs, reset in afterEach.
const retryCalls: { sessionId: string; input?: { messageId?: string } }[] = [];
const editCalls: { sessionId: string; messageId: string; input: { content: string } }[] = [];

mock.module('../../lib/goodvibes', () => ({
  sdk: {
    chat: {
      sessions: { create: async () => { createSessionCalls.push('create'); return createSessionImpl(); } },
      messages: {
        create: async (sessionId: string, input: { body: string }) => {
          createMessageCalls.push({ sessionId, body: input.body });
          return createMessageImpl(sessionId, input);
        },
        retry: async (sessionId: string, input?: { messageId?: string }) => {
          retryCalls.push({ sessionId, input });
          return await retryImpl();
        },
        edit: async (sessionId: string, messageId: string, input: { content: string }) => {
          editCalls.push({ sessionId, messageId, input });
          return await editImpl();
        },
      },
    },
    artifacts: { create: async () => ({ artifactId: 'art-test' }) },
  },
}));

/** Let queued microtasks (the fire-and-forget lineage mutations) settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Hook harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  localMessages?: LocalCompanionMessage[];
  activeSessionId?: string;
  turnState?: string;
  onAuthExpired?: () => void;
}

interface HarnessResult {
  getReturn: () => UseChatSendReturn;
  getLocalMessages: () => LocalCompanionMessage[];
  getTurnStates: () => string[];
  getTurnErrors: () => string[];
  getSelections: () => string[];
  getCreatedSessions: () => unknown[];
  getMissingSessions: () => string[];
  getPendingMessages: () => string[];
  getInvalidations: () => string[];
  select: (sessionId: string) => void;
  selectTogether: (sessionIds: readonly string[]) => void;
  rerender: () => void;
  unmount: () => void;
  queryClient: QueryClient;
}

function renderHook(opts: HarnessOptions = {}): HarnessResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  fixtureClients.add(queryClient);

  const localMessages: LocalCompanionMessage[] = opts.localMessages
    ? [...opts.localMessages]
    : [];
  const turnStates: string[] = [];
  const turnErrors: string[] = [];

  let returnValue!: UseChatSendReturn;
  let activeSessionId = opts.activeSessionId ?? 'sess-1';
  const chatSelection = createChatSelectionTracker('chat', activeSessionId);
  const selections: string[] = [];
  const createdSessions: unknown[] = [];
  const missingSessions: string[] = [];
  const pendingMessages: string[] = [];
  const invalidations: string[] = [];

  function HookOwner(): null {
    const result = useChatSend({
      activeSessionId,
      chatSelection,
      onActiveSessionChange: (id) => { selections.push(id); activeSessionId = id; chatSelection.update('chat', id, true); },
      onDraftSessionRequestedChange: () => undefined,
      onLocalSessionCreated: (session) => { createdSessions.push(session); },
      onSessionMissing: (id) => { missingSessions.push(id); },
      setTurnState: (next) => {
        turnStates.push(typeof next === 'function' ? next(turnStates.at(-1) ?? 'idle') : next);
      },
      setTurnError: (next) => {
        turnErrors.push(typeof next === 'function' ? next(turnErrors.at(-1) ?? '') : next);
      },
      setLiveText: () => undefined,
      setLocalMessages: (updater) => {
        if (typeof updater === 'function') {
          const next = updater(localMessages);
          // Mutate the array in-place so callers see the update
          localMessages.splice(0, localMessages.length, ...next);
        } else {
          localMessages.splice(0, localMessages.length, ...updater);
        }
      },
      setPendingUserMessageId: (value) => { pendingMessages.push(typeof value === 'function' ? value(pendingMessages.at(-1) ?? '') : value); },
      invalidateChatState: async (id) => { invalidations.push(id); },
      turnState: opts.turnState ?? 'idle',
      onAuthExpired: opts.onAuthExpired ?? (() => undefined),
    });
    React.useLayoutEffect(() => { returnValue = result; });
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = () => flushSync(() => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(HookOwner)),
    );
  });
  render();
  let isMounted = true;
  const unmount = () => {
    if (!isMounted) return;
    isMounted = false;
    try {
      flushSync(() => { root.unmount(); });
    } finally {
      if (container.parentNode) container.parentNode.removeChild(container);
      fixtureUnmounts.delete(unmount);
    }
  };
  fixtureUnmounts.add(unmount);

  return {
    getReturn: () => returnValue,
    getLocalMessages: () => localMessages,
    getTurnStates: () => turnStates,
    getTurnErrors: () => turnErrors,
    getSelections: () => selections,
    getCreatedSessions: () => createdSessions,
    getMissingSessions: () => missingSessions,
    getPendingMessages: () => pendingMessages,
    getInvalidations: () => invalidations,
    select: (id) => { activeSessionId = id; chatSelection.update('chat', id, true); render(); },
    selectTogether: (ids) => {
      for (const id of ids) {
        activeSessionId = id;
        chatSelection.update('chat', id, true);
      }
      render();
    },
    rerender: render,
    unmount,
    queryClient,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(id: string, content: string): LocalCompanionMessage {
  return {
    id,
    sessionId: 'sess-1',
    role: 'user',
    content,
    createdAt: Date.now(),
    deliveryState: 'sent',
  };
}

function makeChatMessage(id: string, role: string, content: string): ChatMessage {
  return { id, role, content, sessionId: 'sess-1' };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let harness: HarnessResult | null = null;

afterEach(async () => {
  harness = null;
  try {
    for (const unmount of fixtureUnmounts) unmount();
  } finally {
    try {
      // Retire mounted callbacks before settling responses, including when a
      // test failed before it could release or await its deferred request.
      for (const reject of deferredRejections) reject();
      await Promise.all(fixtureSettlements);
      await waitFor(() => [...fixtureClients].every((client) => client.isMutating() === 0));
    } finally {
      for (const client of fixtureClients) client.clear();
      fixtureClients.clear();
      fixtureUnmounts.clear();
      deferredRejections.clear();
      fixtureSettlements.clear();
      createMessageImpl = async () => ({ messageId: 'msg-test' });
      createSessionImpl = async () => ({ sessionId: 'sess-test' });
      retryImpl = async () => ({});
      editImpl = async () => ({});
      createSessionCalls.length = 0;
      createMessageCalls.length = 0;
      retryCalls.length = 0;
      editCalls.length = 0;
    }
  }
});

// ---------------------------------------------------------------------------
// editAndResend, the honest server edit-and-branch verb
// ---------------------------------------------------------------------------

describe('editAndResend', () => {
  test('edits via the server edit verb when the message has a server id', async () => {
    harness = renderHook({ localMessages: [makeUserMessage('u1', 'Original text')] });
    const { editAndResend } = harness.getReturn();

    flushSync(() => {
      editAndResend('u1', 'Edited text');
    });
    await flushMicrotasks();

    expect(editCalls.length).toBe(1);
    expect(editCalls[0].sessionId).toBe('sess-1');
    expect(editCalls[0].messageId).toBe('u1');
    expect(editCalls[0].input.content).toBe('Edited text');
  });

  test('does nothing when newText is empty or whitespace', async () => {
    harness = renderHook({ localMessages: [makeUserMessage('u1', 'Hello')] });
    const { editAndResend } = harness.getReturn();

    flushSync(() => {
      editAndResend('u1', '   ');
    });
    await flushMicrotasks();

    expect(editCalls.length).toBe(0);
  });

  test('falls back to a plain send for a client-only optimistic id (nothing to branch)', async () => {
    harness = renderHook({ localMessages: [], activeSessionId: 'sess-1' });
    const { editAndResend } = harness.getReturn();

    flushSync(() => {
      editAndResend('local-abc', 'Edited text');
    });
    await flushMicrotasks();

    // No branch verb (there is no persisted message to fork), but the edit is not
    // dropped, it goes out as a fresh send.
    expect(editCalls.length).toBe(0);
    expect(harness.getTurnStates()).toContain('sending');
  });
});

// ---------------------------------------------------------------------------
// regenerateFrom, the honest server regenerate verb
// ---------------------------------------------------------------------------

describe('regenerateFrom', () => {
  test('regenerates via the server retry verb, targeting the assistant server id', async () => {
    const messages: ChatMessage[] = [
      makeChatMessage('u1', 'user', 'Tell me a joke'),
      makeChatMessage('a1', 'assistant', 'Why did the chicken cross the road?'),
    ];
    harness = renderHook({});
    const { regenerateFrom } = harness.getReturn();

    flushSync(() => {
      regenerateFrom('a1', messages);
    });
    await flushMicrotasks();

    expect(retryCalls.length).toBe(1);
    expect(retryCalls[0].sessionId).toBe('sess-1');
    expect(retryCalls[0].input?.messageId).toBe('a1');
  });

  test('omits the message id for a client-only optimistic assistant id (regenerate latest)', async () => {
    const messages: ChatMessage[] = [
      makeChatMessage('u1', 'user', 'Tell me a joke'),
      makeChatMessage('assistant-xyz', 'assistant', 'streamed placeholder'),
    ];
    harness = renderHook({});
    const { regenerateFrom } = harness.getReturn();

    flushSync(() => {
      regenerateFrom('assistant-xyz', messages);
    });
    await flushMicrotasks();

    expect(retryCalls.length).toBe(1);
    // Undefined input → the daemon regenerates the latest assistant response.
    expect(retryCalls[0].input).toBeUndefined();
  });

  test('does nothing without an active session', async () => {
    harness = renderHook({ activeSessionId: '' });
    const { regenerateFrom } = harness.getReturn();

    flushSync(() => {
      regenerateFrom('a1', [makeChatMessage('a1', 'assistant', 'alone')]);
    });
    await flushMicrotasks();

    expect(retryCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Send-while-reconnecting honesty
// ---------------------------------------------------------------------------

describe('send while the stream is degraded', () => {
  test('sending while turnState is "reconnecting" is labeled honestly, not silently sent', async () => {
    harness = renderHook({ turnState: 'reconnecting' });
    const { sendMutation } = harness.getReturn();

    await sendMutation.mutateAsync({ body: 'hello', files: [] });

    const states = harness.getTurnStates();
    // The very first state set must be the honest label, not the ordinary 'sending'.
    expect(states[0]).toBe('sending while reconnecting');
    expect(states).not.toContain('sending');
    expect(states).toContain('sending while reconnecting');
    const errors = harness.getTurnErrors();
    expect(errors.some((e) => e.toLowerCase().includes('reconnecting'))).toBe(true);
  });

  test('sending while turnState is "stream paused" is also labeled honestly', async () => {
    harness = renderHook({ turnState: 'stream paused' });
    const { sendMutation } = harness.getReturn();

    await sendMutation.mutateAsync({ body: 'hello', files: [] });

    expect(harness.getTurnStates()[0]).toBe('sending while reconnecting');
  });

  test('sending while turnState is "idle" uses the ordinary sending/submitted labels (no regression)', async () => {
    harness = renderHook({ turnState: 'idle' });
    const { sendMutation } = harness.getReturn();

    await sendMutation.mutateAsync({ body: 'hello', files: [] });

    const states = harness.getTurnStates();
    expect(states[0]).toBe('sending');
    expect(states).not.toContain('sending while reconnecting');
    // The turnError set alongside ordinary sending must be empty (no false notice).
    expect(harness.getTurnErrors()[0]).toBe('');
  });

  test('the message actually sends during a reconnecting stream: it is not dropped', async () => {
    harness = renderHook({ turnState: 'reconnecting', localMessages: [] });
    const { sendMutation } = harness.getReturn();

    await sendMutation.mutateAsync({ body: 'hello', files: [] });

    // The local message must resolve to 'sent' (the REST call went through), never
    // silently vanish because the SSE stream happened to be down at send time.
    const local = harness.getLocalMessages();
    expect(local.length).toBe(1);
    expect(local[0].deliveryState).toBe('sent');
  });
});

// ---------------------------------------------------------------------------
// Auth-expiry handoff on send
// ---------------------------------------------------------------------------

describe('a 401 mid-send hands off to sign-in, not a dead-end error', () => {
  test('category:"authentication" calls onAuthExpired and sets turnState to "session expired"', async () => {
    createMessageImpl = async () => {
      throw Object.assign(new Error('Unauthorized'), { category: 'authentication' });
    };
    const onAuthExpired = mock(() => undefined);
    harness = renderHook({ onAuthExpired });

    await expect(harness.getReturn().sendMutation.mutateAsync({ body: 'hello', files: [] })).rejects.toThrow();

    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(harness.getTurnStates().at(-1)).toBe('session expired');
  });

  test('a plain 500 does NOT trigger the auth handoff, falls back to "send failed"', async () => {
    createMessageImpl = async () => {
      throw Object.assign(new Error('Internal error'), { status: 500 });
    };
    const onAuthExpired = mock(() => undefined);
    harness = renderHook({ onAuthExpired });

    await expect(harness.getReturn().sendMutation.mutateAsync({ body: 'hello', files: [] })).rejects.toThrow();

    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(harness.getTurnStates().at(-1)).toBe('send failed');
  });

  test('the failed local message is marked deliveryState "failed", never silently lost', async () => {
    createMessageImpl = async () => {
      throw Object.assign(new Error('Unauthorized'), { category: 'authentication' });
    };
    harness = renderHook({ localMessages: [] });

    await expect(harness.getReturn().sendMutation.mutateAsync({ body: 'hello', files: [] })).rejects.toThrow();

    const local = harness.getLocalMessages();
    expect(local.length).toBe(1);
    expect(local[0].deliveryState).toBe('failed');
  });
});

function deferred<T>() {
  let resolveRequest!: (value: T) => void;
  let rejectRequest!: (reason: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((yes, no) => { resolveRequest = yes; rejectRequest = no; });
  const resolve = (value: T) => {
    if (settled) return;
    settled = true;
    resolveRequest(value);
  };
  const reject = (reason: unknown) => {
    if (settled) return;
    settled = true;
    rejectRequest(reason);
  };
  deferredRejections.add(() => reject(new Error('Deferred chat fixture was retired during teardown.')));
  observeSettlement(promise);
  return { promise, resolve, reject };
}

/** Observe teardown settlement without changing the promise asserted by a test. */
function observeSettlement<T>(promise: Promise<T>): Promise<T> {
  fixtureSettlements.add(promise.then(() => undefined, () => undefined));
  return promise;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Deferred chat fixture did not reach its request.');
    await flushMicrotasks();
    flushSync(() => {});
  }
}

describe('chat mutations retain their originating selection', () => {
  test('a delayed create cannot select over a newer chat', async () => {
    const create = deferred<unknown>();
    createSessionImpl = () => create.promise;
    harness = renderHook({ activeSessionId: '' });
    const pending = observeSettlement(harness.getReturn().sendMutation.mutateAsync({ body: 'first prompt', files: [] }));
    await waitFor(() => createSessionCalls.length === 1);
    harness.select('sess-2');
    expect(harness.getReturn().isPending).toBe(false);
    create.resolve({ sessionId: 'sess-created' });
    await pending;
    expect(harness.getSelections()).toEqual([]);
    expect(harness.getCreatedSessions()).toEqual([]);
    expect(createMessageCalls).toEqual([]);
    expect(harness.getReturn().error).toBeNull();
  });

  test('an uninterrupted first send keeps its prompt and created-session transition', async () => {
    harness = renderHook({ activeSessionId: '' });
    await harness.getReturn().sendMutation.mutateAsync({ body: 'first prompt', files: [] });
    expect(harness.getSelections()).toEqual(['sess-test']);
    expect(harness.getCreatedSessions()).toHaveLength(1);
    expect(createMessageCalls).toEqual([{ sessionId: 'sess-test', body: 'first prompt' }]);
    expect(harness.getLocalMessages()[0]?.deliveryState).toBe('sent');
    expect(harness.getInvalidations()).toEqual(['sess-test']);
  });

  test('late success cannot overwrite the new chat and does not lock its send', async () => {
    const oldReply = deferred<unknown>();
    createMessageImpl = (id) => id === 'sess-1' ? oldReply.promise : Promise.resolve({ messageId: 'message-b' });
    harness = renderHook();
    const pending = observeSettlement(harness.getReturn().sendMutation.mutateAsync({ body: 'message a', files: [] }));
    await waitFor(() => createMessageCalls.length === 1);
    harness.select('sess-2');
    expect(harness.getReturn().isPending).toBe(false);
    await harness.getReturn().sendMutation.mutateAsync({ body: 'message b', files: [] });
    const pendingIds = [...harness.getPendingMessages()];
    const states = [...harness.getTurnStates()];
    oldReply.resolve({ messageId: 'message-a' });
    await pending;
    expect(createMessageCalls.map((call) => call.sessionId)).toEqual(['sess-1', 'sess-2']);
    expect(harness.getPendingMessages()).toEqual(pendingIds);
    expect(harness.getTurnStates()).toEqual(states);
    expect(harness.getInvalidations()).toEqual(['sess-2']);
    expect(harness.getReturn().error).toBeNull();
  });

  for (const failure of ['ordinary', 'missing', 'authentication'] as const) {
    test(`a late ${failure} failure cannot change or remove the new selected chat`, async () => {
      const response = deferred<unknown>();
      createMessageImpl = () => response.promise;
      const authExpired = mock(() => undefined);
      harness = renderHook({ onAuthExpired: authExpired });
      const pending = harness.getReturn().sendMutation.mutateAsync({ body: 'message a', files: [] })
        .then(() => null, (error: unknown) => error);
      await waitFor(() => createMessageCalls.length === 1);
      harness.select('sess-2');
      const errors = [...harness.getTurnErrors()];
      const states = [...harness.getTurnStates()];
      const error = Object.assign(new Error('Deferred fixture failure'), failure === 'missing'
        ? { code: 'SESSION_NOT_FOUND' } : failure === 'authentication' ? { category: 'authentication' } : { status: 500 });
      response.reject(error);
      expect(await pending).toBe(error);
      expect(harness.getTurnErrors()).toEqual(errors);
      expect(harness.getTurnStates()).toEqual(states);
      expect(harness.getMissingSessions()).toEqual([]);
      expect(authExpired).not.toHaveBeenCalled();
      expect(harness.getReturn().error).toBeNull();
    });
  }

  test('switching away and back to the same ID does not revive a pending failure', async () => {
    const response = deferred<unknown>();
    createMessageImpl = () => response.promise;
    harness = renderHook();
    const pending = harness.getReturn().sendMutation.mutateAsync({ body: 'old message', files: [] })
      .then(() => null, (error: unknown) => error);
    await waitFor(() => createMessageCalls.length === 1);
    harness.select('sess-2');
    harness.select('sess-1');
    const errors = [...harness.getTurnErrors()];
    response.reject(new Error('Retired fixture failure'));
    await pending;
    expect(harness.getReturn().isPending).toBe(false);
    expect(harness.getReturn().error).toBeNull();
    expect(harness.getTurnErrors()).toEqual(errors);
  });

  for (const verb of ['edit', 'retry'] as const) {
    test(`late ${verb} errors are retired after same-ID return`, async () => {
      const response = deferred<unknown>();
      if (verb === 'edit') editImpl = () => response.promise;
      else retryImpl = () => response.promise;
      harness = renderHook();
      if (verb === 'edit') harness.getReturn().editAndResend('u1', 'edited');
      else harness.getReturn().regenerateFrom('a1', [makeChatMessage('a1', 'assistant', 'answer')]);
      await waitFor(() => (verb === 'edit' ? editCalls : retryCalls).length === 1);
      harness.select('sess-2');
      harness.select('sess-1');
      const errors = [...harness.getTurnErrors()];
      response.reject(new Error('Retired lineage fixture failure'));
      await waitFor(() => harness?.queryClient.isMutating() === 0);
      expect(harness.getReturn().isLineagePending).toBe(false);
      expect(harness.getReturn().lineageError).toBeNull();
      expect(harness.getTurnErrors()).toEqual(errors);
      expect(harness.getInvalidations()).toEqual([]);
    });
  }

  test('an account-generation change retires a pending create', async () => {
    const response = deferred<unknown>();
    createSessionImpl = () => response.promise;
    harness = renderHook({ activeSessionId: '' });
    const pending = observeSettlement(harness.getReturn().sendMutation.mutateAsync({ body: 'first prompt', files: [] }));
    await waitFor(() => createSessionCalls.length === 1);
    invalidateClientLifetime();
    response.resolve({ sessionId: 'sess-created' });
    await pending;
    expect(harness.getSelections()).toEqual([]);
    expect(createMessageCalls).toEqual([]);
  });

  test('unmount retires a pending create without reporting a new selection', async () => {
    const response = deferred<unknown>();
    createSessionImpl = () => response.promise;
    harness = renderHook({ activeSessionId: '' });
    const pending = observeSettlement(harness.getReturn().sendMutation.mutateAsync({ body: 'first prompt', files: [] }));
    await waitFor(() => createSessionCalls.length === 1);
    const old = harness;
    old.unmount();
    harness = null;
    response.resolve({ sessionId: 'sess-created' });
    await pending;
    expect(old.getSelections()).toEqual([]);
    expect(createMessageCalls).toEqual([]);
  });

  test('stale returned handlers cannot recapture a same-ID selection or replace its live send', async () => {
    const response = deferred<unknown>();
    createMessageImpl = () => response.promise;
    harness = renderHook();
    const stale = harness.getReturn();
    harness.selectTogether(['sess-2', 'sess-1']);
    const current = harness.getReturn();
    const pending = observeSettlement(current.sendMutation.mutateAsync({ body: 'current prompt', files: [] }));
    await waitFor(() => createMessageCalls.length === 1 && harness?.getReturn().isPending === true);
    const states = [...harness.getTurnStates()];
    const success = mock(() => undefined);

    stale.mutate({ body: 'stale prompt', files: [] }, { onSuccess: success });
    await stale.sendMutation.mutateAsync({ body: 'stale awaited prompt', files: [] }, { onSuccess: success });
    stale.sendMutation.reset();
    stale.editAndResend('u1', 'stale edit');
    stale.editAndResend('local-u1', 'stale local edit');
    stale.regenerateFrom('a1', [makeChatMessage('a1', 'assistant', 'old answer')]);
    await flushMicrotasks();
    flushSync(() => {});

    expect(harness.queryClient.isMutating()).toBe(1);
    expect(harness.getReturn().isPending).toBe(true);
    expect(createMessageCalls).toEqual([{ sessionId: 'sess-1', body: 'current prompt' }]);
    expect(editCalls).toEqual([]);
    expect(retryCalls).toEqual([]);
    expect(harness.getTurnStates()).toEqual(states);
    expect(success).not.toHaveBeenCalled();

    response.resolve({ messageId: 'current-message' });
    await pending;
    expect(harness.getLocalMessages().at(-1)?.id).toBe('current-message');
    expect(harness.getLocalMessages().at(-1)?.deliveryState).toBe('sent');
    expect(harness.getInvalidations()).toEqual(['sess-1']);
  });

  for (const verb of ['edit', 'retry'] as const) {
    test(`the fresh ${verb} handler remains usable after retiring a returned handler`, async () => {
      harness = renderHook();
      const stale = harness.getReturn();
      harness.selectTogether(['sess-2', 'sess-1']);
      if (verb === 'edit') stale.editAndResend('u1', 'stale edit');
      else stale.regenerateFrom('a1', [makeChatMessage('a1', 'assistant', 'old answer')]);
      expect(harness.queryClient.isMutating()).toBe(0);
      const current = harness.getReturn();
      if (verb === 'edit') current.editAndResend('u1', 'current edit');
      else current.regenerateFrom('a1', [makeChatMessage('a1', 'assistant', 'current answer')]);
      await waitFor(() => (verb === 'edit' ? editCalls : retryCalls).length === 1
        && harness?.queryClient.isMutating() === 0);
      if (verb === 'edit') {
        expect(editCalls).toEqual([{ sessionId: 'sess-1', messageId: 'u1', input: { content: 'current edit' } }]);
      } else {
        expect(retryCalls).toEqual([{ sessionId: 'sess-1', input: { messageId: 'a1' } }]);
      }
      expect(harness.getInvalidations()).toEqual(['sess-1']);
    });
  }

  test('returned handlers retain their native account lifetime until a new render', async () => {
    harness = renderHook();
    const stale = harness.getReturn();
    invalidateClientLifetime();
    await stale.sendMutation.mutateAsync({ body: 'old account prompt', files: [] });
    stale.editAndResend('u1', 'old account edit');
    stale.regenerateFrom('a1', [makeChatMessage('a1', 'assistant', 'old account answer')]);
    expect(harness.queryClient.isMutating()).toBe(0);
    expect(createMessageCalls).toEqual([]);
    expect(editCalls).toEqual([]);
    expect(retryCalls).toEqual([]);
    harness.rerender();
    await harness.getReturn().sendMutation.mutateAsync({ body: 'current account prompt', files: [] });
    expect(createMessageCalls).toEqual([{ sessionId: 'sess-1', body: 'current account prompt' }]);
    expect(harness.getInvalidations()).toEqual(['sess-1']);
  });

  for (const verb of ['create', 'send', 'edit', 'retry'] as const) {
    test(`teardown drains an unresolved ${verb} response after an interrupted test body and manual unmount`, async () => {
      const response = deferred<unknown>();
      if (verb === 'create') createSessionImpl = () => response.promise;
      else if (verb === 'send') createMessageImpl = () => response.promise;
      else if (verb === 'edit') editImpl = () => response.promise;
      else retryImpl = () => response.promise;
      harness = renderHook({ activeSessionId: verb === 'create' ? '' : 'sess-1' });
      const owner = harness;
      const interrupted = async () => {
        if (verb === 'create' || verb === 'send') {
          observeSettlement(owner.getReturn().sendMutation.mutateAsync({ body: 'held prompt', files: [] }));
        } else if (verb === 'edit') owner.getReturn().editAndResend('u1', 'held edit');
        else owner.getReturn().regenerateFrom('a1', [makeChatMessage('a1', 'assistant', 'held answer')]);
        await waitFor(() => (verb === 'create' ? createSessionCalls : verb === 'send'
          ? createMessageCalls : verb === 'edit' ? editCalls : retryCalls).length === 1);
        throw new Error('Interrupted deferred chat test body.');
      };
      await expect(interrupted()).rejects.toThrow('Interrupted deferred chat test body.');
      expect(owner.queryClient.isMutating()).toBe(1);
      owner.unmount();
      harness = null;
      // Leave the request unresolved. The same afterEach path must retire and
      // drain it without a mounted harness or the test reaching its own await.
    });
  }
});
