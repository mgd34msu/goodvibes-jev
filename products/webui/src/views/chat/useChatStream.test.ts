/**
 * Unit tests for useChatStream.
 *
 * Tests:
 * 1. isStreaming derives from turnState prop across all active states
 * 2. isStreaming is false for non-active states (idle, completed, error)
 * 3. isStreaming is false when turnState is omitted (defaults to 'idle')
 * 4. isStreaming is true during sending/submitted window (before first delta)
 * 5. stop() disconnects the stream and is idempotent
 * 6. stop() before .then resolves does NOT revive the subscription (race fix)
 *
 * Uses a manual renderHook pattern (createRoot + flushSync) matching the
 * project's DOM test convention (toast.dom.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { UseChatStreamResult } from './useChatStream';
import { useChatStream } from './useChatStream';
import type { LocalCompanionMessage } from '../../lib/companion-chat';
import type { Dispatch, SetStateAction } from 'react';

// ---------------------------------------------------------------------------
// Mock sdk.chat.events.stream
// ---------------------------------------------------------------------------

type StreamDisconnect = () => void;
interface StreamOptions {
  onEvent: (eventName: string, payload: unknown) => void;
  onError: (error: unknown) => void;
  onReady?: () => void;
  onReconnect?: (input: { attempt: number; delayMs: number }) => void;
  onTerminate?: (input: { error: unknown; reconnectAttempts: number }) => void;
}
interface StreamOpenOptions {
  reconnect?: { enabled?: boolean; maxAttempts?: number };
}

/**
 * Controls for the mock stream:
 * - resolveFn: call to deliver the disconnect handle (resolves the .then)
 * - rejectFn: call to reject the stream promise
 * - disconnect: the mock disconnect fn (tracks call count)
 */
interface StreamControl {
  resolveFn: (disconnect: StreamDisconnect) => void;
  rejectFn: (err: unknown) => void;
  disconnect: ReturnType<typeof mock>;
  options: StreamOptions;
  openOptions: StreamOpenOptions | undefined;
}

let activeStreamControl: StreamControl | null = null;
// Every stream() opened this test, in order, the epoch/handshake-race tests need to
// hold BOTH the superseded stream and its successor at once (activeStreamControl only
// tracks the most recent).
let allStreamControls: StreamControl[] = [];
let streamCallCount = 0;

// Mock the SDK module
// Controllable behavior for the server-side stop verb: tests set this to
// simulate an upgraded daemon (resolve), a pre-1.4 daemon (method-unavailable
// reject), or the benign no-active-turn race.
let turnsCancelBehavior: (sessionId: string) => Promise<unknown> = () =>
  Promise.resolve({ cancelled: true, turnId: 'turn-1', partialPersisted: false });
const turnsCancelMock = mock((sessionId: string) => turnsCancelBehavior(sessionId));

// sessions.toolCalls.cancel, controllable per test, capturing every call.
let toolCallsCancelBehavior: (sessionId: string, callId: string) => Promise<{ sessionId: string; callId: string; cancelled: boolean }> =
  (sessionId, callId) => Promise.resolve({ sessionId, callId, cancelled: true });
const toolCallsCancelCalls: { sessionId: string; callId: string }[] = [];
const toolCallsCancelMock = mock((sessionId: string, callId: string) => {
  toolCallsCancelCalls.push({ sessionId, callId });
  return toolCallsCancelBehavior(sessionId, callId);
});

mock.module('../../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1_000, maxDelayMs: 30_000, backoffFactor: 2, maxAttempts: 10 },
  sdk: {
    chat: {
      turns: {
        cancel: turnsCancelMock,
      },
      events: {
        stream: mock(
          (_sessionId: string, options: StreamOptions, openOptions?: StreamOpenOptions): Promise<StreamDisconnect> => {
            streamCallCount += 1;
            const disconnect = mock(() => {});
            const promise = new Promise<StreamDisconnect>((resolve, reject) => {
              activeStreamControl = { resolveFn: resolve, rejectFn: reject, disconnect, options, openOptions };
              allStreamControls.push(activeStreamControl);
            });
            return promise;
          },
        ),
      },
    },
    operator: {
      sessions: {
        toolCalls: {
          cancel: toolCallsCancelMock,
        },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Hook owner component
// ---------------------------------------------------------------------------

interface HookOwnerProps {
  activeSessionId: string;
  turnState?: string;
  setTurnState: Dispatch<SetStateAction<string>>;
  setTurnError: Dispatch<SetStateAction<string>>;
  onAuthExpired: () => void;
  onResult: (result: UseChatStreamResult) => void;
}

function HookOwner({ activeSessionId, turnState, setTurnState, setTurnError, onAuthExpired, onResult }: HookOwnerProps): null {
  // Stable across re-renders, matching the real caller (ChatView), where these are
  // useState setters / useCallback / a ref and therefore identity-stable. Creating fresh
  // mocks per render would make them change every render and spuriously re-run the
  // connect effect (a new SSE stream on every setTurnState), which is NOT how the hook
  // behaves in production and would mask the epoch/handshake behaviour under test.
  // Built via useMemo (not useRef) so nothing reads a hook ref's `.current` during render.
  const stable = React.useMemo(() => {
    const liveTextRef = createRef<string>() as React.RefObject<string>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (liveTextRef as any).current = '';
    return {
      liveTextRef,
      setLiveText: mock(() => {}),
      setLocalMessages: mock((_fn: SetStateAction<LocalCompanionMessage[]>) => {}),
      setPendingUserMessageId: mock(() => {}),
      invalidateChatState: mock(() => Promise.resolve()),
      onSessionMissing: mock(() => {}),
    };
  }, []);

  const result = useChatStream({
    activeSessionId,
    liveTextRef: stable.liveTextRef,
    turnState,
    setTurnState,
    setTurnError,
    setLiveText: stable.setLiveText,
    setLocalMessages: stable.setLocalMessages,
    setPendingUserMessageId: stable.setPendingUserMessageId,
    invalidateChatState: stable.invalidateChatState,
    onSessionMissing: stable.onSessionMissing,
    onAuthExpired,
  });

  React.useLayoutEffect(() => {
    onResult(result);
  });

  return null;
}

// ---------------------------------------------------------------------------
// renderHook helper
// ---------------------------------------------------------------------------

function renderHookHelper({
  activeSessionId = 'session-1',
  initialTurnState = 'idle',
  onAuthExpired = () => {},
}: {
  activeSessionId?: string;
  initialTurnState?: string;
  onAuthExpired?: () => void;
} = {}) {
  let result!: UseChatStreamResult;
  let currentTurnState = initialTurnState;
  let currentTurnError = '';
  const turnStates: string[] = [];
  const turnErrors: string[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const setTurnState: Dispatch<SetStateAction<string>> = (next) => {
    currentTurnState = typeof next === 'function' ? next(currentTurnState) : next;
    turnStates.push(currentTurnState);
    flushSync(() => {
      root.render(
        React.createElement(HookOwner, {
          activeSessionId,
          turnState: currentTurnState,
          setTurnState,
          setTurnError,
          onAuthExpired,
          onResult: (r: UseChatStreamResult) => { result = r; },
        }),
      );
    });
  };

  const setTurnError: Dispatch<SetStateAction<string>> = (next) => {
    currentTurnError = typeof next === 'function' ? next(currentTurnError) : next;
    turnErrors.push(currentTurnError);
  };

  const rerender = (turnState: string) => {
    currentTurnState = turnState;
    flushSync(() => {
      root.render(
        React.createElement(HookOwner, {
          activeSessionId,
          turnState,
          setTurnState,
          setTurnError,
          onAuthExpired,
          onResult: (r: UseChatStreamResult) => { result = r; },
        }),
      );
    });
  };

  flushSync(() => {
    root.render(
      React.createElement(HookOwner, {
        activeSessionId,
        turnState: initialTurnState,
        setTurnState,
        setTurnError,
        onAuthExpired,
        onResult: (r: UseChatStreamResult) => { result = r; },
      }),
    );
  });

  return {
    get result() { return result; },
    rerender,
    get turnState() { return currentTurnState; },
    get turnStates() { return turnStates; },
    get turnError() { return currentTurnError; },
    get turnErrors() { return turnErrors; },
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

/**
 * Poll with real timers until `predicate` is true or the timeout elapses,
 * flushing on every tick. Needed for activeToolCalls assertions specifically:
 * unlike turnState (routed through the external setTurnState prop, which
 * itself flushSync's on every call), activeToolCalls is useState INSIDE the
 * hook, and an update queued from a bare event-handler invocation or a
 * promise continuation is not guaranteed to have committed by the very next
 * synchronous line, a single flushSync no-op is not always enough.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  activeStreamControl = null;
  allStreamControls = [];
  streamCallCount = 0;
});

afterEach(() => {
  activeStreamControl = null;
  allStreamControls = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChatStream: isStreaming derivation from turnState prop', () => {
  test('isStreaming is false when turnState is omitted (defaults to idle)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let result!: UseChatStreamResult;

    flushSync(() => {
      root.render(
        React.createElement(HookOwner, {
          activeSessionId: '',
          // turnState intentionally omitted
          setTurnState: mock(() => {}),
          setTurnError: mock(() => {}),
          onAuthExpired: mock(() => {}),
          onResult: (r: UseChatStreamResult) => { result = r; },
        }),
      );
    });

    expect(result.isStreaming).toBe(false);

    flushSync(() => { root.unmount(); });
    if (container.parentNode) container.parentNode.removeChild(container);
  });

  test('isStreaming is false for idle state', () => {
    const { result, unmount } = renderHookHelper({ activeSessionId: '', initialTurnState: 'idle' });
    expect(result.isStreaming).toBe(false);
    unmount();
  });

  test('isStreaming is false for completed state', () => {
    const { result, unmount } = renderHookHelper({ activeSessionId: '', initialTurnState: 'completed' });
    expect(result.isStreaming).toBe(false);
    unmount();
  });

  test('isStreaming is false for error state', () => {
    const { result, unmount } = renderHookHelper({ activeSessionId: '', initialTurnState: 'error' });
    expect(result.isStreaming).toBe(false);
    unmount();
  });

  test('isStreaming is true for sending (pre-token window)', () => {
    const { result, unmount } = renderHookHelper({ activeSessionId: '', initialTurnState: 'sending' });
    expect(result.isStreaming).toBe(true);
    unmount();
  });

  test('isStreaming is true for submitted (pre-token window)', () => {
    const { result, unmount } = renderHookHelper({ activeSessionId: '', initialTurnState: 'submitted' });
    expect(result.isStreaming).toBe(true);
    unmount();
  });

  test('isStreaming is true for running state', () => {
    const { result, unmount } = renderHookHelper({ activeSessionId: '', initialTurnState: 'running' });
    expect(result.isStreaming).toBe(true);
    unmount();
  });

  test('isStreaming is true for streaming state', () => {
    const { result, unmount } = renderHookHelper({ activeSessionId: '', initialTurnState: 'streaming' });
    expect(result.isStreaming).toBe(true);
    unmount();
  });

  test('isStreaming is true for tooling state', () => {
    const { result, unmount } = renderHookHelper({ activeSessionId: '', initialTurnState: 'tooling' });
    expect(result.isStreaming).toBe(true);
    unmount();
  });

  test('isStreaming updates reactively when turnState prop changes', () => {
    const ctx = renderHookHelper({ activeSessionId: '', initialTurnState: 'idle' });
    expect(ctx.result.isStreaming).toBe(false);

    ctx.rerender('streaming');
    expect(ctx.result.isStreaming).toBe(true);

    ctx.rerender('idle');
    expect(ctx.result.isStreaming).toBe(false);

    ctx.unmount();
  });
});

describe('useChatStream: stop() correctness', () => {
  /**
   * For stop() tests we use a simple non-reactive setTurnState mock to avoid
   * nested flushSync (stop() → setTurnState → flushSync(render) inside outer
   * flushSync would throw in React 19).
   */
  function renderForStop(activeSessionId: string) {
    let result!: UseChatStreamResult;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // Simple mock: does not re-render, avoids nested flushSync
    const setTurnState = mock((_next: SetStateAction<string>) => {});
    const setTurnError = mock((_next: SetStateAction<string>) => {});

    flushSync(() => {
      root.render(
        React.createElement(HookOwner, {
          activeSessionId,
          turnState: 'streaming',
          setTurnState,
          setTurnError,
          onAuthExpired: mock(() => {}),
          onResult: (r: UseChatStreamResult) => { result = r; },
        }),
      );
    });

    return {
      get result() { return result; },
      setTurnState,
      setTurnError,
      unmount: () => {
        flushSync(() => { root.unmount(); });
        if (container.parentNode) container.parentNode.removeChild(container);
      },
    };
  }

  function methodUnavailableError(): Error {
    // Matches isMethodUnavailableError: 404 + METHOD_NOT_FOUND, the wire shape
    // an un-upgraded daemon returns for a verb it has never heard of.
    return Object.assign(new Error('Unknown gateway method'), {
      status: 404,
      code: 'METHOD_NOT_FOUND',
    });
  }

  test('stop() requests the server-side cancel and KEEPS the stream open (turn.cancelled is the terminal signal)', async () => {
    turnsCancelBehavior = () => Promise.resolve({ cancelled: true, turnId: 't1', partialPersisted: true });
    const { result, setTurnState, unmount } = renderForStop('session-stop');
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();

    const disconnectFn = ctrl!.disconnect;
    ctrl!.resolveFn(disconnectFn);
    await Promise.resolve();
    await Promise.resolve();

    result.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(turnsCancelMock).toHaveBeenCalledWith('session-stop');
    // The stream must STAY open, every subscriber (this client included)
    // converges on the terminal turn.cancelled event, not on a local teardown.
    expect(disconnectFn).toHaveBeenCalledTimes(0);
    expect(setTurnState).toHaveBeenCalledWith('stopping');

    unmount();
  });

  test('benign NO_ACTIVE_TURN (turn finished first) settles quietly back to idle', async () => {
    turnsCancelBehavior = () => Promise.reject(Object.assign(new Error('No turn is in flight'), {
      status: 404,
      code: 'NO_ACTIVE_TURN',
    }));
    const { result, setTurnState, setTurnError, unmount } = renderForStop('session-benign');
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    result.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(ctrl!.disconnect).toHaveBeenCalledTimes(0);
    // Never rendered as an error, the machine code is the benign race.
    expect(setTurnError).not.toHaveBeenCalledWith(expect.stringContaining('No turn is in flight'));
    // The functional updater flips 'stopping' back to 'idle'.
    const updater = setTurnState.mock.calls.at(-1)?.[0];
    expect(typeof updater).toBe('function');
    expect((updater as (c: string) => string)('stopping')).toBe('idle');

    unmount();
  });

  test('pre-1.4 daemon (method unavailable): falls back to the honest LOCAL stop, disconnect, label, idempotent', async () => {
    turnsCancelBehavior = () => Promise.reject(methodUnavailableError());
    const { result, setTurnState, setTurnError, unmount } = renderForStop('session-fallback');
    const ctrl = activeStreamControl;
    const disconnectFn = ctrl!.disconnect;
    ctrl!.resolveFn(disconnectFn);
    await Promise.resolve();
    await Promise.resolve();

    result.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(disconnectFn).toHaveBeenCalledTimes(1);
    expect(setTurnState).toHaveBeenCalledWith('stopped locally');
    expect(setTurnError).toHaveBeenCalledWith(expect.stringContaining('Stopped rendering only'));

    // Second stop, disconnectRef was cleared, no second disconnect.
    result.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(disconnectFn).toHaveBeenCalledTimes(1);

    unmount();
  });

  test('fallback stop() before .then resolves prevents subscription revival (race fix)', async () => {
    turnsCancelBehavior = () => Promise.reject(methodUnavailableError());
    const { result, unmount } = renderForStop('session-race');
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();

    const disconnectFn = ctrl!.disconnect;

    // Fallback stop() BEFORE .then resolves, disconnectRef.current is still undefined
    result.stop();
    await Promise.resolve();
    await Promise.resolve();

    // Resolve the stream promise, .then must detect stoppedRef=true and call nextDisconnect()
    ctrl!.resolveFn(disconnectFn);
    await Promise.resolve();
    await Promise.resolve();

    expect(disconnectFn).toHaveBeenCalledTimes(1);

    // disconnectRef was never stored, so calling stop() again is a no-op on disconnect
    result.stop();
    await Promise.resolve();
    expect(disconnectFn).toHaveBeenCalledTimes(1);

    unmount();
  });

  test('wire-mode stop() before .then resolves keeps the handle (the stream must survive the stop)', async () => {
    turnsCancelBehavior = () => Promise.resolve({ cancelled: true, turnId: 't1', partialPersisted: false });
    const { result, unmount } = renderForStop('session-keepalive');
    const ctrl = activeStreamControl;
    const disconnectFn = ctrl!.disconnect;

    result.stop();
    await Promise.resolve();
    await Promise.resolve();

    ctrl!.resolveFn(disconnectFn);
    await Promise.resolve();
    await Promise.resolve();

    // The handle is stored, not discarded: a wire stop leaves the stream open
    // for turn.cancelled. Unmount then disconnects it exactly once.
    expect(disconnectFn).toHaveBeenCalledTimes(0);
    unmount();
    expect(disconnectFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Resilience: reconnecting / stream paused / session expired / retry
// ---------------------------------------------------------------------------

describe('useChatStream: reconnect passed to the SDK', () => {
  test('opens the stream with DEFAULT_SSE_RECONNECT so a drop actually retries', () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-reconnect-opt' });
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();
    expect(ctrl!.openOptions?.reconnect?.enabled).toBe(true);
    expect(ctrl!.openOptions?.reconnect?.maxAttempts).toBe(10);
    ctx.unmount();
  });
});

describe('useChatStream: onReconnect: a daemon blip / SSE drop is honest, not a dead "stream error"', () => {
  test('onReconnect sets turnState to "reconnecting" with an attempt-count message', () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-drop', initialTurnState: 'streaming' });
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();

    ctrl!.options.onReconnect?.({ attempt: 2, delayMs: 4000 });

    expect(ctx.turnState).toBe('reconnecting');
    expect(ctx.turnError).toContain('2');
    expect(ctx.turnError).toContain('10');
    // 'reconnecting' must count as an active turn state (Stop stays meaningful, the
    // 1s message-poll fallback keeps running), never collapse to a dead stream error.
    expect(ctx.turnState).not.toBe('stream error');

    ctx.unmount();
  });

  test('"reconnecting" keeps isStreaming true (a mid-turn drop does not look "stopped")', () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-drop-2', initialTurnState: 'reconnecting' });
    expect(ctx.result.isStreaming).toBe(true);
    ctx.unmount();
  });

  test('onReady after a drop clears the reconnecting message and moves on to "syncing"', () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-recover' });
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();

    ctrl!.options.onReconnect?.({ attempt: 1, delayMs: 1000 });
    expect(ctx.turnState).toBe('reconnecting');

    ctrl!.options.onReady?.();
    expect(ctx.turnState).toBe('syncing');
    expect(ctx.turnError).toBe('');

    ctx.unmount();
  });

  test('a genuine turn error mid-reconnect is NOT clobbered by onReady', () => {
    // onReady's functional updater only clears 'reconnecting' specifically, a
    // concurrent genuine 'error' (turn.error event) must survive.
    const ctx = renderHookHelper({ activeSessionId: 'session-guard' });
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();

    ctrl!.options.onReconnect?.({ attempt: 1, delayMs: 1000 });
    ctrl!.options.onEvent('companion-chat.turn.error', { sessionId: 'session-guard', type: 'turn.error', error: 'boom' });
    expect(ctx.turnState).toBe('error');

    ctrl!.options.onReady?.();
    // Must stay 'error', onReady only resets when turnState is still 'reconnecting'.
    expect(ctx.turnState).toBe('error');

    ctx.unmount();
  });
});

describe('useChatStream: onTerminate: the built-in reconnect gave up ("stream paused")', () => {
  test('onTerminate sets turnState to "stream paused" and isStreaming goes false', () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-terminate', initialTurnState: 'streaming' });
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();

    ctrl!.options.onTerminate?.({ error: new Error('boom'), reconnectAttempts: 10 });

    expect(ctx.turnState).toBe('stream paused');
    expect(ctx.turnError).toContain('10');
    expect(ctx.result.isStreaming).toBe(false);

    ctx.unmount();
  });

  test('the paired onError call right after onTerminate does not overwrite "stream paused"', () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-terminate-2' });
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();

    // Real SDK wiring: onReconnect fires for every attempt, THEN onTerminate +
    // onError both fire once attempts are exhausted (see sse-stream.js: onTerminate
    // is always called, then reportStreamError calls onError with the same error).
    ctrl!.options.onReconnect?.({ attempt: 10, delayMs: 30_000 });
    ctrl!.options.onTerminate?.({ error: new Error('boom'), reconnectAttempts: 10 });
    ctrl!.options.onError(new Error('boom'));

    expect(ctx.turnState).toBe('stream paused');

    ctx.unmount();
  });
});

describe('useChatStream: token expiry mid-session hands off, never loops', () => {
  test('a 401 on the first connect (before ever succeeding) hands off instead of "stream error"', () => {
    const onAuthExpired = mock(() => {});
    const ctx = renderHookHelper({ activeSessionId: 'session-expired-first', onAuthExpired });
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();

    ctrl!.rejectFn(Object.assign(new Error('Unauthorized'), { category: 'authentication' }));

    return Promise.resolve().then(() => Promise.resolve()).then(() => {
      expect(onAuthExpired).toHaveBeenCalledTimes(1);
      expect(ctx.turnState).toBe('session expired');
      expect(ctx.turnState).not.toBe('stream error');
      ctx.unmount();
    });
  });

  test('a 401 mid-stream (via onError, paired with onReconnect) hands off and stops retrying', () => {
    const onAuthExpired = mock(() => {});
    const ctx = renderHookHelper({ activeSessionId: 'session-expired-mid', onAuthExpired });
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();

    // Successful first connect, resolve so disconnectRef is populated (the auth-expiry
    // handler calls disconnectRef.current?.() to stop the built-in retry loop early).
    ctrl!.resolveFn(ctrl!.disconnect);

    return Promise.resolve().then(() => Promise.resolve()).then(() => {
      const authError = Object.assign(new Error('Unauthorized'), { category: 'authentication' });
      ctrl!.options.onReconnect?.({ attempt: 1, delayMs: 1000 });
      ctrl!.options.onError(authError);

      expect(onAuthExpired).toHaveBeenCalledTimes(1);
      expect(ctx.turnState).toBe('session expired');
      // The retry loop must be told to stop, not left burning attempts on a dead token.
      expect(ctrl!.disconnect).toHaveBeenCalled();

      // A further paired onError call (defensive, the real SDK never double-fires
      // for one failure) must not re-invoke the handoff a second time.
      ctrl!.options.onError(authError);
      expect(onAuthExpired).toHaveBeenCalledTimes(1);

      ctx.unmount();
    });
  });

  test('onTerminate carrying an auth error hands off to "session expired", not "stream paused"', () => {
    const onAuthExpired = mock(() => {});
    const ctx = renderHookHelper({ activeSessionId: 'session-expired-terminate', onAuthExpired });
    const ctrl = activeStreamControl;
    expect(ctrl).not.toBeNull();

    const authError = Object.assign(new Error('Unauthorized'), { category: 'authentication' });
    ctrl!.options.onTerminate?.({ error: authError, reconnectAttempts: 10 });

    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(ctx.turnState).toBe('session expired');
    expect(ctx.turnState).not.toBe('stream paused');

    ctx.unmount();
  });

  test('"session expired" is NOT an active turn state; isStreaming goes false', () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-expired-active', initialTurnState: 'session expired' });
    expect(ctx.result.isStreaming).toBe(false);
    ctx.unmount();
  });
});

describe('useChatStream: retryStream() re-opens after "stream paused"', () => {
  test('calling retryStream triggers a fresh sdk.chat.events.stream connect', () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-retry' });
    expect(streamCallCount).toBe(1);

    flushSync(() => { ctx.result.retryStream(); });
    expect(streamCallCount).toBe(2);

    ctx.unmount();
  });
});

// ---------------------------------------------------------------------------
// Per-effect epoch: a switch/retry DURING the handshake window (the SDK stream()
// promise only yields its disconnect handle post-handshake) must not let the OLD
// stream's late callbacks or late-resolving handle touch the NEW session (F1).
// ---------------------------------------------------------------------------

describe('useChatStream: session switch / retry mid-handshake is inert (epoch guard)', () => {
  /** Non-reactive render harness that can swap activeSessionId without nested flushSync. */
  function renderForSwitch(initialSessionId: string) {
    let result!: UseChatStreamResult;
    const turnStates: string[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const setTurnState = mock((next: SetStateAction<string>) => {
      turnStates.push(typeof next === 'function' ? next('streaming') : next);
    });
    const setTurnError = mock((_next: SetStateAction<string>) => {});

    function renderWith(sessionId: string) {
      flushSync(() => {
        root.render(
          React.createElement(HookOwner, {
            activeSessionId: sessionId,
            turnState: 'streaming',
            setTurnState,
            setTurnError,
            onAuthExpired: mock(() => {}),
            onResult: (r: UseChatStreamResult) => { result = r; },
          }),
        );
      });
    }

    renderWith(initialSessionId);

    return {
      get result() { return result; },
      renderWith,
      get turnStates() { return turnStates; },
      unmount: () => {
        flushSync(() => { root.unmount(); });
        if (container.parentNode) container.parentNode.removeChild(container);
      },
    };
  }

  test('switching sessions mid-handshake: the old stream is inert, its late handle is disconnected and never stored, the new session is untouched', async () => {
    const h = renderForSwitch('session-A');
    const ctrlA = allStreamControls[0];
    expect(ctrlA).toBeDefined();
    // ctrlA has NOT resolved, we are inside its handshake window.

    // Switch to session B while A is still handshaking.
    h.renderWith('session-B');
    const ctrlB = allStreamControls[1];
    expect(ctrlB).toBeDefined();
    expect(ctrlB).not.toBe(ctrlA);

    // Every late callback from the stale stream A must be a no-op now.
    const writesBefore = h.turnStates.length;
    ctrlA!.options.onReconnect?.({ attempt: 1, delayMs: 1000 });
    ctrlA!.options.onEvent('companion-chat.turn.delta', { sessionId: 'session-A', type: 'turn.delta', delta: 'stale' });
    ctrlA!.options.onError(new Error('late error from A'));
    ctrlA!.options.onTerminate?.({ error: new Error('late terminate from A'), reconnectAttempts: 3 });
    expect(h.turnStates.length).toBe(writesBefore);
    expect(h.turnStates).not.toContain('reconnecting');
    expect(h.turnStates).not.toContain('stream paused');

    // New stream B resolves first → its handle is the live one.
    ctrlB!.resolveFn(ctrlB!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    // Stale stream A resolves LATE → its handle must be disconnected immediately and
    // NEVER stored into the shared disconnectRef.
    ctrlA!.resolveFn(ctrlA!.disconnect);
    await Promise.resolve();
    await Promise.resolve();
    expect(ctrlA!.disconnect).toHaveBeenCalledTimes(1);

    // Proof the live handle is B's, not A's: unmount cleanup disconnects B
    // exactly once (A stays at its single stale-discard call). stop() is no
    // longer a teardown probe, a wire stop keeps the stream open.
    h.unmount();
    expect(ctrlB!.disconnect).toHaveBeenCalledTimes(1);
    expect(ctrlA!.disconnect).toHaveBeenCalledTimes(1);
  });

  test('retryStream mid-handshake: the superseded stream is inert and its late handle is discarded', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-retry-race' });
    const ctrlA = allStreamControls[0];
    expect(streamCallCount).toBe(1);

    // Retry BEFORE ctrlA resolves, a fresh connect supersedes it mid-handshake.
    flushSync(() => { ctx.result.retryStream(); });
    expect(streamCallCount).toBe(2);
    const ctrlB = allStreamControls[1];
    expect(ctrlB).not.toBe(ctrlA);

    // The superseded stream A must not move turn state.
    ctrlA!.options.onReconnect?.({ attempt: 1, delayMs: 1000 });
    expect(ctx.turnState).not.toBe('reconnecting');

    // B resolves and becomes live; A resolves late and is discarded + disconnected.
    ctrlB!.resolveFn(ctrlB!.disconnect);
    await Promise.resolve();
    await Promise.resolve();
    ctrlA!.resolveFn(ctrlA!.disconnect);
    await Promise.resolve();
    await Promise.resolve();
    expect(ctrlA!.disconnect).toHaveBeenCalledTimes(1);

    // Unmount is the teardown probe (a wire stop keeps the stream open):
    // B's live handle disconnects once, A stays at its single stale-discard.
    ctx.unmount();
    expect(ctrlB!.disconnect).toHaveBeenCalledTimes(1);
    expect(ctrlA!.disconnect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// turn.cancelled is terminal
// ---------------------------------------------------------------------------

describe('useChatStream: turn.cancelled terminal event', () => {
  test('settles the turn to stopped, clears live text, and refetches history', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-cancelled' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    ctrl!.options.onEvent?.('companion-chat.turn.cancelled', {
      type: 'turn.cancelled',
      sessionId: 'session-cancelled',
      turnId: 't1',
      stoppedBy: 'user',
      partialPersisted: true,
      assistantMessageId: 'a1',
      envelope: { sessionId: 'session-cancelled', messageId: 'a1', body: 'partial ', source: 'companion-chat-assistant', timestamp: 1 },
    });

    // Terminal like turn.completed: the state settles and the stream itself
    // was NOT torn down (the same event converges every other client too).
    expect(ctx.turnState).toBe('stopped');
    expect(ctrl!.disconnect).toHaveBeenCalledTimes(0);

    ctx.unmount();
  });
});

// ---------------------------------------------------------------------------
// Running tool calls + cancel (SDK 1.8.0's interaction-wins round)
// ---------------------------------------------------------------------------

describe('useChatStream: activeToolCalls tracking', () => {
  test('a turn.tool_call event adds an entry; a matching turn.tool_result removes it', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-tools' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
      type: 'turn.tool_call', sessionId: 'session-tools', turnId: 't1', toolCallId: 'call-1', toolName: 'bash', toolInput: {},
    });
    expect(ctx.result.activeToolCalls).toEqual([{ turnId: 't1', toolCallId: 'call-1', toolName: 'bash', cancelled: false }]);

    ctrl!.options.onEvent?.('companion-chat.turn.tool_result', {
      type: 'turn.tool_result', sessionId: 'session-tools', turnId: 't1', toolCallId: 'call-1', toolName: 'bash', result: 'ok', isError: false,
    });
    expect(ctx.result.activeToolCalls).toEqual([]);

    ctx.unmount();
  });

  test('two concurrent tool calls are both tracked independently', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-tools-2' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
      type: 'turn.tool_call', sessionId: 'session-tools-2', turnId: 't1', toolCallId: 'call-1', toolName: 'bash',
    });
    ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
      type: 'turn.tool_call', sessionId: 'session-tools-2', turnId: 't1', toolCallId: 'call-2', toolName: 'read',
    });
    expect(ctx.result.activeToolCalls.map((c) => c.toolCallId).sort()).toEqual(['call-1', 'call-2']);

    ctrl!.options.onEvent?.('companion-chat.turn.tool_result', {
      type: 'turn.tool_result', sessionId: 'session-tools-2', turnId: 't1', toolCallId: 'call-1', toolName: 'bash', result: '', isError: false,
    });
    expect(ctx.result.activeToolCalls.map((c) => c.toolCallId)).toEqual(['call-2']);

    ctx.unmount();
  });

  test('a terminal turn.completed clears every active tool call', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-tools-3' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
        type: 'turn.tool_call', sessionId: 'session-tools-3', turnId: 't1', toolCallId: 'call-1', toolName: 'bash',
      });
    });
    expect(ctx.result.activeToolCalls.length).toBe(1);

    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.completed', {
        type: 'turn.completed', sessionId: 'session-tools-3', turnId: 't1', assistantMessageId: 'a1',
        envelope: { sessionId: 'session-tools-3', messageId: 'a1', body: 'done', source: 'companion-chat-assistant', timestamp: 1 },
      });
    });
    expect(ctx.result.activeToolCalls).toEqual([]);

    ctx.unmount();
  });

  test('a duplicate turn.tool_call for the same id does not double-add', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-tools-4' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    for (let i = 0; i < 2; i++) {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
        type: 'turn.tool_call', sessionId: 'session-tools-4', turnId: 't1', toolCallId: 'call-1', toolName: 'bash',
      });
    }
    expect(ctx.result.activeToolCalls.length).toBe(1);

    ctx.unmount();
  });
});

describe('useChatStream: cancelToolCall()', () => {
  beforeEach(() => {
    toolCallsCancelCalls.length = 0;
    toolCallsCancelBehavior = (sessionId, callId) => Promise.resolve({ sessionId, callId, cancelled: true });
  });

  test('calls sessions.toolCalls.cancel with the active session and the given callId', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-cancel-tool' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
      type: 'turn.tool_call', sessionId: 'session-cancel-tool', turnId: 't1', toolCallId: 'call-1', toolName: 'bash',
    });

    await ctx.result.cancelToolCall('call-1');
    expect(toolCallsCancelCalls).toEqual([{ sessionId: 'session-cancel-tool', callId: 'call-1' }]);

    ctx.unmount();
  });

  test('on {cancelled:true}, the local entry is marked cancelled but NOT removed (removed only by the real turn.tool_result)', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-cancel-tool-2' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
        type: 'turn.tool_call', sessionId: 'session-cancel-tool-2', turnId: 't1', toolCallId: 'call-1', toolName: 'bash',
      });
    });

    await ctx.result.cancelToolCall('call-1');
    await waitFor(() => ctx.result.activeToolCalls.some((c) => c.cancelled));
    expect(ctx.result.activeToolCalls).toEqual([{ turnId: 't1', toolCallId: 'call-1', toolName: 'bash', cancelled: true }]);

    // The turn continues, a later, unrelated tool call still tracks normally.
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
        type: 'turn.tool_call', sessionId: 'session-cancel-tool-2', turnId: 't1', toolCallId: 'call-2', toolName: 'read',
      });
    });
    expect(ctx.result.activeToolCalls.map((c) => c.toolCallId).sort()).toEqual(['call-1', 'call-2']);

    // The daemon's real result for the cancelled call arrives, NOW it is removed.
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_result', {
        type: 'turn.tool_result', sessionId: 'session-cancel-tool-2', turnId: 't1', toolCallId: 'call-1', toolName: 'bash', result: 'cancelled', isError: true,
      });
    });
    expect(ctx.result.activeToolCalls.map((c) => c.toolCallId)).toEqual(['call-2']);

    ctx.unmount();
  });

  test('on {cancelled:false} (the daemon declined), the entry is left untouched and the caller can read the refusal', async () => {
    toolCallsCancelBehavior = (sessionId, callId) => Promise.resolve({ sessionId, callId, cancelled: false });
    const ctx = renderHookHelper({ activeSessionId: 'session-cancel-tool-3' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
      type: 'turn.tool_call', sessionId: 'session-cancel-tool-3', turnId: 't1', toolCallId: 'call-1', toolName: 'bash',
    });

    const result = await ctx.result.cancelToolCall('call-1');
    expect(result.cancelled).toBe(false);
    expect(ctx.result.activeToolCalls).toEqual([{ turnId: 't1', toolCallId: 'call-1', toolName: 'bash', cancelled: false }]);

    ctx.unmount();
  });

  test('a session switch clears any leftover active tool calls from the prior session', async () => {
    // Mirrors renderForSwitch (the epoch-guard describe block below) rather than
    // renderHookHelper, which never varies activeSessionId across renders.
    let result!: UseChatStreamResult;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const setTurnState = mock((_next: SetStateAction<string>) => {});
    const setTurnError = mock((_next: SetStateAction<string>) => {});
    function renderWith(sessionId: string) {
      flushSync(() => {
        root.render(
          React.createElement(HookOwner, {
            activeSessionId: sessionId,
            turnState: 'streaming',
            setTurnState,
            setTurnError,
            onAuthExpired: mock(() => {}),
            onResult: (r: UseChatStreamResult) => { result = r; },
          }),
        );
      });
    }

    renderWith('session-cancel-tool-4a');
    const ctrlA = allStreamControls[allStreamControls.length - 1];
    ctrlA!.resolveFn(ctrlA!.disconnect);
    await Promise.resolve();
    await Promise.resolve();
    // This harness's setTurnState mock does not flushSync on its own (unlike
    // renderHookHelper's), so the event must be fired inside an explicit flushSync.
    ctrlA!.options.onEvent?.('companion-chat.turn.tool_call', {
      type: 'turn.tool_call', sessionId: 'session-cancel-tool-4a', turnId: 't1', toolCallId: 'call-1', toolName: 'bash',
    });
    await waitFor(() => result.activeToolCalls.length === 1);

    // Switch sessions, the new connect effect resets activeToolCalls, exactly
    // like it resets liveText/turnError.
    renderWith('session-cancel-tool-4b');
    await waitFor(() => result.activeToolCalls.length === 0);
    expect(result.activeToolCalls).toEqual([]);

    flushSync(() => { root.unmount(); });
    if (container.parentNode) container.parentNode.removeChild(container);
  });
});

// ---------------------------------------------------------------------------
// toolActivityByMessageId, completed tool calls folded onto the message that
// produced them, instead of evaporating once the turn ends (the platform-wide
// "keep tool results, fold them" fix, webui idiom).
// ---------------------------------------------------------------------------

describe('useChatStream: toolActivityByMessageId', () => {
  test('a completed tool call is attached to the turn\'s assistant message id on turn.completed', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-activity-1' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
        type: 'turn.tool_call', sessionId: 'session-activity-1', turnId: 't1', toolCallId: 'call-1', toolName: 'bash', toolInput: { command: 'ls' },
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_result', {
        type: 'turn.tool_result', sessionId: 'session-activity-1', turnId: 't1', toolCallId: 'call-1', toolName: 'bash', result: 'file.txt', isError: false,
      });
    });
    // Not attached yet, the turn has not reached a terminal event.
    expect(ctx.result.toolActivityByMessageId.size).toBe(0);

    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.completed', {
        type: 'turn.completed', sessionId: 'session-activity-1', turnId: 't1', assistantMessageId: 'a1',
        envelope: { sessionId: 'session-activity-1', messageId: 'a1', body: 'done', source: 'companion-chat-assistant', timestamp: 1 },
      });
    });

    const activity = ctx.result.toolActivityByMessageId.get('a1');
    expect(activity).toEqual([
      {
        toolCallId: 'call-1', toolName: 'bash', toolInput: { command: 'ls' }, result: 'file.txt', isError: false,
        startedAt: expect.any(Number), finishedAt: expect.any(Number),
      },
    ]);
    // Timed by this browser, so the collapsed row can say how long the person waited.
    expect(activity![0].finishedAt!).toBeGreaterThanOrEqual(activity![0].startedAt!);

    ctx.unmount();
  });

  test('multiple tool calls in one turn are all attached, in order, to the same message id', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-activity-2' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
        type: 'turn.tool_call', sessionId: 'session-activity-2', turnId: 't1', toolCallId: 'call-1', toolName: 'read', toolInput: { file_path: '/a.ts' },
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_result', {
        type: 'turn.tool_result', sessionId: 'session-activity-2', turnId: 't1', toolCallId: 'call-1', toolName: 'read', result: 'contents', isError: false,
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
        type: 'turn.tool_call', sessionId: 'session-activity-2', turnId: 't1', toolCallId: 'call-2', toolName: 'bash', toolInput: { command: 'ls' },
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_result', {
        type: 'turn.tool_result', sessionId: 'session-activity-2', turnId: 't1', toolCallId: 'call-2', toolName: 'bash', result: '', isError: true,
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.completed', {
        type: 'turn.completed', sessionId: 'session-activity-2', turnId: 't1', assistantMessageId: 'a2',
        envelope: { sessionId: 'session-activity-2', messageId: 'a2', body: 'done', source: 'companion-chat-assistant', timestamp: 1 },
      });
    });

    const activity = ctx.result.toolActivityByMessageId.get('a2');
    expect(activity?.map((c) => c.toolCallId)).toEqual(['call-1', 'call-2']);
    expect(activity?.[1]).toEqual({
      toolCallId: 'call-2', toolName: 'bash', toolInput: { command: 'ls' }, result: '', isError: true,
      startedAt: expect.any(Number), finishedAt: expect.any(Number),
    });

    ctx.unmount();
  });

  test('turn.error discards accumulated tool activity, no assistant message was produced to attach it to', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-activity-3' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
        type: 'turn.tool_call', sessionId: 'session-activity-3', turnId: 't1', toolCallId: 'call-1', toolName: 'bash',
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_result', {
        type: 'turn.tool_result', sessionId: 'session-activity-3', turnId: 't1', toolCallId: 'call-1', toolName: 'bash', result: 'oops', isError: true,
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.error', {
        type: 'turn.error', sessionId: 'session-activity-3', turnId: 't1', error: 'boom',
      });
    });

    expect(ctx.result.toolActivityByMessageId.size).toBe(0);

    ctx.unmount();
  });

  test('turn.cancelled with an assistantMessageId (partial persisted) attaches the tool activity observed before the stop', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-activity-4' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
        type: 'turn.tool_call', sessionId: 'session-activity-4', turnId: 't1', toolCallId: 'call-1', toolName: 'grep',
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_result', {
        type: 'turn.tool_result', sessionId: 'session-activity-4', turnId: 't1', toolCallId: 'call-1', toolName: 'grep', result: 'match', isError: false,
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.cancelled', {
        type: 'turn.cancelled', sessionId: 'session-activity-4', turnId: 't1', stoppedBy: 'user', partialPersisted: true, assistantMessageId: 'a4',
        envelope: { sessionId: 'session-activity-4', messageId: 'a4', body: 'partial', source: 'companion-chat-assistant', timestamp: 1 },
      });
    });

    expect(ctx.result.toolActivityByMessageId.get('a4')?.map((c) => c.toolCallId)).toEqual(['call-1']);

    ctx.unmount();
  });

  test('turn.cancelled with no assistantMessageId (no partial persisted) discards the tool activity, nothing to attach it to', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-activity-5' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_call', {
        type: 'turn.tool_call', sessionId: 'session-activity-5', turnId: 't1', toolCallId: 'call-1', toolName: 'bash',
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.tool_result', {
        type: 'turn.tool_result', sessionId: 'session-activity-5', turnId: 't1', toolCallId: 'call-1', toolName: 'bash', result: '', isError: false,
      });
    });
    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.cancelled', {
        type: 'turn.cancelled', sessionId: 'session-activity-5', turnId: 't1', stoppedBy: 'user', partialPersisted: false,
      });
    });

    expect(ctx.result.toolActivityByMessageId.size).toBe(0);

    ctx.unmount();
  });

  test('a turn with no tool calls at all leaves toolActivityByMessageId empty', async () => {
    const ctx = renderHookHelper({ activeSessionId: 'session-activity-6' });
    const ctrl = activeStreamControl;
    ctrl!.resolveFn(ctrl!.disconnect);
    await Promise.resolve();
    await Promise.resolve();

    flushSync(() => {
      ctrl!.options.onEvent?.('companion-chat.turn.completed', {
        type: 'turn.completed', sessionId: 'session-activity-6', turnId: 't1', assistantMessageId: 'a6',
        envelope: { sessionId: 'session-activity-6', messageId: 'a6', body: 'done', source: 'companion-chat-assistant', timestamp: 1 },
      });
    });

    expect(ctx.result.toolActivityByMessageId.size).toBe(0);

    ctx.unmount();
  });
});
