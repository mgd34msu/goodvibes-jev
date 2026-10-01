/**
 * Unit tests for useChatSend branch-tracking logic.
 *
 * Tests use a lightweight React DOM harness (createRoot + flushSync) with
 * a real QueryClientProvider. The sdk module is mocked to prevent HTTP calls.
 * The mutation's network path is exercised only as a no-op stub, branch state
 * changes (the focus of these tests) are synchronous and testable in isolation.
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

// ---------------------------------------------------------------------------
// Mock sdk, prevents real HTTP calls from the mutation function
// ---------------------------------------------------------------------------
// `createMessageImpl` is reassignable per-test (e.g. to reject with a 401) since
// mock.module locks in the module shape once, but not what the inner fn does.
let createMessageImpl: () => Promise<unknown> = async () => ({ messageId: 'msg-test' });

// Spies for the honest-lineage verbs, reset in afterEach.
const retryCalls: { sessionId: string; input?: { messageId?: string } }[] = [];
const editCalls: { sessionId: string; messageId: string; input: { content: string } }[] = [];

mock.module('../../lib/goodvibes', () => ({
  sdk: {
    chat: {
      sessions: { create: async () => ({ sessionId: 'sess-test' }) },
      messages: {
        create: async () => createMessageImpl(),
        retry: async (sessionId: string, input?: { messageId?: string }) => {
          retryCalls.push({ sessionId, input });
          return { sessionId, regeneratedFrom: input?.messageId ?? 'latest', supersededMessageIds: [], turnStarted: true };
        },
        edit: async (sessionId: string, messageId: string, input: { content: string }) => {
          editCalls.push({ sessionId, messageId, input });
          return { sessionId, editedFrom: messageId, messageId: `${messageId}-rev`, supersededMessageIds: [messageId], turnStarted: true };
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
  unmount: () => void;
  queryClient: QueryClient;
}

function renderHook(opts: HarnessOptions = {}): HarnessResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const localMessages: LocalCompanionMessage[] = opts.localMessages
    ? [...opts.localMessages]
    : [];
  const turnStates: string[] = [];
  const turnErrors: string[] = [];

  let returnValue!: UseChatSendReturn;

  function HookOwner(): null {
    const result = useChatSend({
      activeSessionId: opts.activeSessionId ?? 'sess-1',
      onActiveSessionChange: () => undefined,
      onDraftSessionRequestedChange: () => undefined,
      onLocalSessionCreated: () => undefined,
      onSessionMissing: () => undefined,
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
      setPendingUserMessageId: () => undefined,
      invalidateChatState: async () => undefined,
      turnState: opts.turnState ?? 'idle',
      onAuthExpired: opts.onAuthExpired ?? (() => undefined),
    });
    React.useLayoutEffect(() => { returnValue = result; });
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(HookOwner),
      ),
    );
  });

  return {
    getReturn: () => returnValue,
    getLocalMessages: () => localMessages,
    getTurnStates: () => turnStates,
    getTurnErrors: () => turnErrors,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
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

afterEach(() => {
  if (harness) {
    harness.unmount();
    harness = null;
  }
  createMessageImpl = async () => ({ messageId: 'msg-test' });
  retryCalls.length = 0;
  editCalls.length = 0;
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
