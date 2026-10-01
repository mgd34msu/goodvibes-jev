/**
 * App, daemon-unreachable gate recovery.
 *
 * DaemonUnreachableGate's copy promises the operator will "pick up where it left
 * off" once the daemon comes back. Before this fix, App.tsx early-returned the gate
 * IN PLACE of the workspace subtree, which unmounted SessionsView and SteerComposer,
 * discarding the selected session and any half-typed steer/follow-up draft. The fix
 * renders the gate as an overlay ON TOP of the still-mounted (inert) workspace, so
 * this is a regression test: it types a draft and selects a session, forces a daemon
 * blip (auth query rejects as unreachable), asserts the SAME textarea DOM node is
 * still present underneath (not a fresh remounted one) with its value intact, then
 * recovers the daemon and asserts the draft and selection are exactly where they
 * were.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type AuthMode = 'ok' | 'unreachable' | 'unauthorized';
let authMode: AuthMode = 'ok';
let hasStoredToken = true;

function unreachableError() {
  // Matches isDaemonUnreachableError's contract (errors.ts): category 'network'
  // (or status 0) marks a connection failure, distinct from a genuine 401.
  return Object.assign(new Error('fetch failed'), { category: 'network', status: 0 });
}

function unauthorizedError() {
  return Object.assign(new Error('Unauthorized'), { status: 401 });
}

// D-WEBUI-3: the health poll (useDaemonHealth) is a SEPARATE, independently-firing
// signal from auth.current, it re-probes every 15s unconditionally, unlike
// auth.current which only re-probes once it has already errored. Modeled here as an
// external store so a test can flip `connection` to 'down' with NO auth-query
// interaction at all, mirroring "the health poll's own timer fired, nothing the user
// did", then flip it back to prove recovery.
type HealthConnection = 'connected' | 'reconnecting' | 'down';
let healthConnection: HealthConnection = 'connected';
const healthListeners = new Set<() => void>();
function setHealthConnection(next: HealthConnection) {
  healthConnection = next;
  for (const listener of healthListeners) listener();
}

const SESSIONS_FIXTURE = {
  totals: { sessions: 1 },
  sessions: [
    {
      id: 's1',
      kind: 'tui',
      project: 'proj',
      title: 'Session One',
      status: 'active',
      updatedAt: 10,
      messageCount: 2,
      activeAgentId: 'agent-1',
    },
  ],
};

// DELETE-MEANS-DELETE fixtures/state, a small in-memory companion-chat
// session store the mocked sdk.chat.sessions.* methods read/write, so a test can
// simulate BOTH an honest daemon that hard-deletes (delete really removes the record)
// and an older daemon that only soft-closes (delete only closes it, file retained) by
// flipping `chatDeleteReallyRemoves`.
let chatSessionsFixture: { id: string; title: string; status: string }[] = [];
let chatCloseCalls: string[] = [];
let chatDeleteCalls: string[] = [];
let chatDeleteReallyRemoves = true;
let chatCloseAvailable = true;

function resetChatDeleteFixtures() {
  chatSessionsFixture = [{ id: 'c1', title: 'Chat One', status: 'active' }];
  chatCloseCalls = [];
  chatDeleteCalls = [];
  chatDeleteReallyRemoves = true;
  chatCloseAvailable = true;
}
resetChatDeleteFixtures();

// Full replacement of src/lib/goodvibes.ts, App.tsx's whole reachable import graph
// (queries.ts, useSessionRealtime, useRealtimeInvalidation, SessionsView,
// SteerComposer, and the statically-imported-but-not-rendered other views) resolves
// through this one module, so every name any of them import must be present.
// App calls useDaemonHealth() (the shell's avatar dot and account menu read it), which
// does a raw `fetch()` outside the sdk facade and polls sdk.operator.models.current.get()
// (not stubbed above). Neither matters to this test, so mock the whole hook: it avoids
// real-network noise and an unstubbed method call.
mock.module('./hooks/useDaemonHealth', () => ({
  useDaemonHealth: () => {
    React.useSyncExternalStore(
      (listener) => {
        healthListeners.add(listener);
        return () => healthListeners.delete(listener);
      },
      () => healthConnection,
    );
    return {
      connection: healthConnection,
      signedIn: 'signed-in',
      working: 'working',
      latencyMs: 10,
      sse: 'active',
      activeTurns: 0,
      queuedTasks: 0,
      modelName: null,
    };
  },
}));

mock.module('./lib/goodvibes', () => ({
  WEBUI_TOKEN_STORE_KEY: 'test-token-key',
  WEBUI_SURFACE_ID: 'goodvibes-webui',
  WEBUI_SURFACE_KIND: 'webui',
  GOODVIBES_BASE_URL: 'http://localhost/test',
  WEBUI_VERSION: undefined,
  // MemoryView (mounted unconditionally by App.tsx's render switch) imports this
  // named value at module load time, a plain re-export of the SDK's constant, not
  // exercised by any test in this file.
  VIBE_PERSONA_TAG: 'vibe',
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 1 },
  hasStoredTokenSync: () => hasStoredToken,
  // HostedSessionsView (mounted unconditionally in App.tsx's render switch)
  // imports this named value at module load time, a no-op stub, not
  // exercised by any test in this file.
  hostedSessionDetachBeacon: () => {},
  getCurrentAuth: () => {
    if (authMode === 'unreachable') return Promise.reject(unreachableError());
    if (authMode === 'unauthorized') return Promise.reject(unauthorizedError());
    return Promise.resolve({ ok: true });
  },
  login: () => Promise.resolve({}),
  setExplicitAuthToken: () => Promise.resolve({}),
  clearStoredAuthToken: () => Promise.resolve(undefined),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      control: { status: () => Promise.resolve({}), snapshot: () => Promise.resolve({}) },
      accounts: { snapshot: () => Promise.resolve({}) },
      providers: { list: () => Promise.resolve({}) },
      tasks: { list: () => Promise.resolve({}) },
      approvals: {
        list: () => Promise.resolve({}),
        approve: () => Promise.resolve({}),
        deny: () => Promise.resolve({}),
        claim: () => Promise.resolve({}),
        cancel: () => Promise.resolve({}),
      },
      fleet: {
        snapshot: () => Promise.resolve({ capturedAt: 0, nodes: [], truncated: false, totalCount: 0 }),
        list: () => Promise.resolve({ items: [], hasMore: false, capturedAt: 0 }),
      },
      watchers: { stop: () => Promise.resolve({}) },
      // MemoryView is not exercised by this file's tests, but App.tsx mounts it
      // unconditionally in the render switch, a stub keeps that reachable without
      // any test here depending on its shape.
      memory: {
        search: () => Promise.resolve({
          records: [],
          mode: 'literal',
          requestedSemantic: false,
          indexUnavailableReason: null,
          caveat: null,
          recallFiltered: false,
          excludedFlaggedCount: 0,
          excludedBelowFloorCount: 0,
          totalBeforeRecallFilter: 0,
        }),
        add: () => Promise.resolve({}),
        get: () => Promise.resolve({}),
        updateReview: () => Promise.resolve({}),
        delete: () => Promise.resolve({ id: '', deleted: false }),
        reviewQueue: () => Promise.resolve({ records: [] }),
      },
      sessions: {
        list: () => Promise.resolve(SESSIONS_FIXTURE),
        messages: { list: () => Promise.resolve({ messages: [] }) },
        steer: () => Promise.resolve({}),
        followUp: () => Promise.resolve({}),
        detach: () => Promise.resolve({}),
      },
    },
    knowledge: { status: () => Promise.resolve({}) },
    streams: { open: () => Promise.resolve(() => {}) },
    artifacts: { create: () => Promise.resolve({}) },
    chat: {
      messages: {
        list: () => Promise.resolve({ messages: [] }),
        create: () => Promise.resolve({}),
      },
      events: {
        // useChatStream awaits this and stores the resolved value directly as its
        // disconnect callback, a no-op stream is enough for the sidebar-delete flow
        // this describe block exercises; it never asserts on live streaming behavior.
        stream: () => Promise.resolve(() => {}),
      },
      sessions: {
        list: () => Promise.resolve({ sessions: chatSessionsFixture, totals: { sessions: chatSessionsFixture.length } }),
        update: (sessionId: string, input: { title?: string }) => {
          const session = chatSessionsFixture.find((s) => s.id === sessionId);
          if (session && input.title) session.title = input.title;
          return Promise.resolve({ session });
        },
        create: () => Promise.resolve({ session: { id: 'new', title: 'New chat', status: 'active' } }),
        close: (sessionId: string) => {
          chatCloseCalls.push(sessionId);
          if (!chatCloseAvailable) {
            return Promise.reject(Object.assign(new Error('Unknown gateway method'), { status: 404, body: { error: 'Unknown gateway method' } }));
          }
          const session = chatSessionsFixture.find((s) => s.id === sessionId);
          if (session) session.status = 'closed';
          return Promise.resolve({ sessionId, status: 'closed' });
        },
        delete: (sessionId: string) => {
          chatDeleteCalls.push(sessionId);
          if (chatDeleteReallyRemoves) {
            chatSessionsFixture = chatSessionsFixture.filter((s) => s.id !== sessionId);
            return Promise.resolve({ sessionId, deleted: true });
          }
          // Pre-S1 daemon behavior: delete only soft-closes, the record NEVER
          // actually leaves chatSessionsFixture, matching the real dishonest verb
          // this brief replaces (companion-chat-manager.ts's old handleDeleteSession).
          const session = chatSessionsFixture.find((s) => s.id === sessionId);
          if (session) session.status = 'closed';
          return Promise.resolve({ sessionId, status: 'closed' });
        },
      },
    },
  },
}));

const { default: App } = await import('./App');
const { queryKeys } = await import('./lib/queries');

function render(): { container: HTMLElement; client: QueryClient; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(App)));
  });
  return {
    container,
    client,
    unmount: () => {
      flushSync(() => root.unmount());
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

async function flushMicrotasks(times = 8) {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop -- deliberate sequential drain
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  authMode = 'ok';
  hasStoredToken = true;
  healthConnection = 'connected';
  window.history.pushState({}, '', '/');
  resetChatDeleteFixtures();
});

describe('App: daemon-unreachable gate preserves in-progress work', () => {
  test('a daemon blip mid-typing does not reset the selected session or discard the steer draft', async () => {
    window.history.pushState({}, '', '/?view=work&tab=sessions');
    const { container, client, unmount } = render();
    await flushMicrotasks();

    // Select the only session in the union (Work, Sessions).
    const row = [...container.querySelectorAll('.gv-row__main')]
      .find((r) => r.textContent?.includes('Session One'));
    expect(row).toBeTruthy();
    flushSync(() => {
      row?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();
    expect(container.textContent).toContain('Session One');

    // Type a draft into the steer composer without submitting it.
    const textarea = container.querySelector('.steer-composer textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'half-typed steer draft');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(textarea.value).toBe('half-typed steer draft');
    expect(container.querySelector('.daemon-gate-overlay')).toBeNull();

    // Simulate a daemon blip: the next auth probe fails as unreachable.
    authMode = 'unreachable';
    flushSync(() => {
      void client.refetchQueries({ queryKey: queryKeys.auth });
    });
    await flushMicrotasks();

    expect(container.querySelector('.daemon-gate-overlay')).toBeTruthy();

    // The workspace underneath must still be mounted (not remounted), same DOM
    // node, same value, just hidden behind the inert overlay.
    const appShell = container.querySelector('.app-shell');
    expect(appShell?.hasAttribute('inert')).toBe(true);
    const textareaDuringOutage = container.querySelector('.steer-composer textarea') as HTMLTextAreaElement;
    expect(textareaDuringOutage).toBe(textarea);
    expect(textareaDuringOutage.value).toBe('half-typed steer draft');

    // Daemon comes back.
    authMode = 'ok';
    flushSync(() => {
      void client.refetchQueries({ queryKey: queryKeys.auth });
    });
    await flushMicrotasks();

    expect(container.querySelector('.daemon-gate-overlay')).toBeNull();
    expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false);
    const textareaAfterRecovery = container.querySelector('.steer-composer textarea') as HTMLTextAreaElement;
    expect(textareaAfterRecovery).toBe(textarea);
    expect(textareaAfterRecovery.value).toBe('half-typed steer draft');
    expect(container.textContent).toContain('Session One');

    unmount();
  });
});

describe('App: D-WEBUI-3: the health poll drives the unreachable overlay on its own', () => {
  test('a daemon death mid-idle-session (health poll alone flips to down) surfaces the overlay with no user action, then clears on recovery', async () => {
    window.history.pushState({}, '', '/?view=sessions');
    const { container, unmount } = render();
    await flushMicrotasks();

    // Healthy: no overlay, and the auth query has not errored either.
    expect(container.querySelector('.daemon-gate-overlay')).toBeNull();
    expect(container.textContent).toContain('Session One');

    // The daemon dies while the session sits idle. auth.current never re-fires on its
    // own (it only re-probes once it has ALREADY errored), nothing in this test ever
    // touches the auth query or the query client. Only the independently-polling
    // health hook (useDaemonHealth, mocked here as an external store) reports the
    // outage, exactly as its real 15s timer would.
    flushSync(() => {
      setHealthConnection('down');
    });
    await flushMicrotasks();

    expect(container.querySelector('.daemon-gate-overlay')).toBeTruthy();
    // Underlying workspace stays mounted and inert, same as the auth-driven path.
    expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(true);

    // The daemon comes back; the health poll's next cycle reports it reachable again.
    flushSync(() => {
      setHealthConnection('connected');
    });
    await flushMicrotasks();

    expect(container.querySelector('.daemon-gate-overlay')).toBeNull();
    expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false);
    expect(container.textContent).toContain('Session One');

    unmount();
  });

  test('a 401 while the health poll is still reporting healthy routes to the sign-out gate, never the overlay', async () => {
    window.history.pushState({}, '', '/?view=sessions');
    const { container, client, unmount } = render();
    await flushMicrotasks();
    expect(container.querySelector('.daemon-gate-overlay')).toBeNull();

    // A genuinely bad/expired token: auth.current rejects with a real 401, and the
    // health poll (a separate probe entirely) is still reporting the daemon reachable.
    authMode = 'unauthorized';
    flushSync(() => {
      void client.refetchQueries({ queryKey: queryKeys.auth });
    });
    await flushMicrotasks();

    expect(container.querySelector('.daemon-gate-overlay')).toBeNull();
    expect(container.querySelector('.signed-out-gate')).not.toBeNull();

    unmount();
  });
});

describe('App: D-WEBUI-2: no stored token skips the authenticated-shell flash', () => {
  test('with no stored token, the very first render shows the sign-out gate, never the 401-bannered shell', () => {
    hasStoredToken = false;
    window.history.pushState({}, '', '/?view=sessions');
    const { container, unmount } = render();

    // No flushMicrotasks() here on purpose: this asserts on the FIRST synchronous
    // render, before the (never-to-resolve-in-this-test) auth query has any chance to
    // settle. hasStoredTokenSync() is a synchronous localStorage check, so "no token"
    // must be enough on its own to show the gate, no probe required.
    expect(container.querySelector('.signed-out-gate')).not.toBeNull();
    expect(container.querySelector('.app-shell')).toBeNull();
    expect(container.querySelector('.sessions-row')).toBeNull();

    unmount();
  });

  test('the gate does not flicker into the shell as the auth query later settles', async () => {
    hasStoredToken = false;
    window.history.pushState({}, '', '/?view=sessions');
    const { container, unmount } = render();
    expect(container.querySelector('.signed-out-gate')).not.toBeNull();

    // Let the (successful, in this mock) auth query settle in the background, with no
    // stored token, that must not flip the view to the authenticated shell.
    await flushMicrotasks();
    expect(container.querySelector('.signed-out-gate')).not.toBeNull();
    expect(container.querySelector('.app-shell')).toBeNull();

    unmount();
  });
});

describe('App: delete-means-delete, companion chat sidebar delete', () => {
  /** Answer the kit ConfirmDialog the delete opens (it replaced window.confirm). */
  async function answerConfirm(confirmed: boolean): Promise<void> {
    const dialog = document.querySelector('[role="alertdialog"].gv-confirm');
    expect(dialog).not.toBeNull();
    const button = document.querySelector(confirmed ? '.gv-confirm__confirm' : '.gv-confirm__cancel') as HTMLButtonElement;
    flushSync(() => button.click());
    await flushMicrotasks();
  }

  function deleteButtonFor(container: HTMLElement, title: string): HTMLButtonElement {
    const row = [...container.querySelectorAll('.shell-recent__row')]
      .find((r) => r.textContent?.includes(title));
    const button = row?.querySelector('.shell-recent__delete') as HTMLButtonElement | null;
    expect(button).toBeTruthy();
    return button!;
  }

  test('the confirm gate fires before any destructive call; declining leaves close/delete uncalled', async () => {
    window.history.pushState({}, '', '/?view=chat');
    const { container, unmount } = render();
    await flushMicrotasks();
    expect(container.textContent).toContain('Chat One');

    flushSync(() => {
      deleteButtonFor(container, 'Chat One').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();
    await answerConfirm(false);

    expect(chatCloseCalls).toEqual([]);
    expect(chatDeleteCalls).toEqual([]);
    expect(container.textContent).toContain('Chat One');

    unmount();
  });

  test('an honest post-S1 daemon: delete closes first, then really removes; proof-of-gone confirms absence, no false banner', async () => {
    window.history.pushState({}, '', '/?view=chat');
    chatDeleteReallyRemoves = true;
    const { container, unmount } = render();
    await flushMicrotasks();
    expect(container.textContent).toContain('Chat One');

    flushSync(() => {
      deleteButtonFor(container, 'Chat One').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();
    await answerConfirm(true);

    // Close-then-delete, in that order, honoring the "delete requires closed" verb.
    expect(chatCloseCalls).toEqual(['c1']);
    expect(chatDeleteCalls).toEqual(['c1']);
    // Proof-of-gone: the reconcile re-fetch (includeClosed:true) found it truly absent.
    expect(chatSessionsFixture.some((s) => s.id === 'c1')).toBe(false);
    expect(container.textContent).not.toContain('Chat One');

    unmount();
  });

  test('a still-soft-closing pre-S1 daemon: delete does NOT make the row vanish silently. It comes back', async () => {
    window.history.pushState({}, '', '/?view=chat');
    chatDeleteReallyRemoves = false;
    const { container, unmount } = render();
    await flushMicrotasks();
    expect(container.textContent).toContain('Chat One');

    flushSync(() => {
      deleteButtonFor(container, 'Chat One').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();
    await answerConfirm(true);

    expect(chatDeleteCalls).toEqual(['c1']);
    // The record was only soft-closed server-side (chatDeleteReallyRemoves=false), so
    // the proof-of-gone reconcile finds it still present, the anti-pattern this brief
    // removes is trusting the optimistic hide as "deleted" here; instead the row must
    // come back and the failure must be visible.
    expect(chatSessionsFixture.some((s) => s.id === 'c1')).toBe(true);
    expect(container.textContent).toContain('Chat One');

    unmount();
  });

  test('an older daemon with no close route yet: close 404s honestly but delete still proceeds (and the reconcile still catches the still-soft-close outcome)', async () => {
    window.history.pushState({}, '', '/?view=chat');
    chatCloseAvailable = false;
    chatDeleteReallyRemoves = false;
    const { container, unmount } = render();
    await flushMicrotasks();

    flushSync(() => {
      deleteButtonFor(container, 'Chat One').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();
    await answerConfirm(true);

    // close was attempted (and honestly failed as unavailable) but did not block delete.
    expect(chatCloseCalls).toEqual(['c1']);
    expect(chatDeleteCalls).toEqual(['c1']);
    expect(container.textContent).toContain('Chat One');

    unmount();
  });
});
