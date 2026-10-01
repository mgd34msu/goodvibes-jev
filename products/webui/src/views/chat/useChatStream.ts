import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState, RefObject } from 'react';
import { sdk, DEFAULT_SSE_RECONNECT } from '../../lib/goodvibes';
import { asRecord, firstString } from '../../lib/object';
import { RELAY_OVERFLOW_EVENT, noteRelayOverflow, readDroppedCount } from '../../lib/relay-stream-overflow';
import { isSessionNotFoundError, isAuthExpiredError, isMethodUnavailableError, isNoActiveTurnError } from '../../lib/errors';
import { LocalCompanionMessage } from '../../lib/companion-chat';
import {
  ACTIVE_TURN_STATES,
  assistantContentFromCompletedTurn,
  companionEventType,
  type CompletedToolCall,
} from './message-utils';

/**
 * Cap on how many completed turns' tool activity are retained in
 * toolActivityByMessageId at once, an insertion-ordered Map, oldest evicted
 * first. Purely a memory ceiling for a very long-lived tab; unrelated to any
 * server-side retention (this state never touches the daemon).
 */
const MAX_TOOL_ACTIVITY_ENTRIES = 200;

function withToolActivity(
  current: ReadonlyMap<string, readonly CompletedToolCall[]>,
  messageId: string,
  calls: readonly CompletedToolCall[],
): ReadonlyMap<string, readonly CompletedToolCall[]> {
  if (!messageId || calls.length === 0) return current;
  const next = new Map(current);
  next.set(messageId, calls);
  while (next.size > MAX_TOOL_ACTIVITY_ENTRIES) {
    const oldestKey = next.keys().next().value;
    if (oldestKey === undefined) break;
    next.delete(oldestKey);
  }
  return next;
}

interface UseChatStreamOptions {
  activeSessionId: string;
  liveTextRef: RefObject<string>;
  onSessionMissing: (sessionId: string) => void;
  setTurnState: Dispatch<SetStateAction<string>>;
  setTurnError: Dispatch<SetStateAction<string>>;
  setLiveText: Dispatch<SetStateAction<string>>;
  setLocalMessages: Dispatch<SetStateAction<LocalCompanionMessage[]>>;
  setPendingUserMessageId: Dispatch<SetStateAction<string>>;
  invalidateChatState: (sessionId: string) => Promise<void>;
  /**
   * Called once when the stream (or a send) discovers the token has expired mid-
   * session (401 / category:'authentication'). The caller re-probes auth.current,
   * which, for a genuinely dead token, flips the app into the signed-out gate. This
   * hook never retries a dead token itself; it hands off and stops.
   */
  onAuthExpired: () => void;
  /**
   * The AUTHORITATIVE turn state managed by the caller (e.g. ChatView).
   * When provided, `isStreaming` derives from this value instead of a
   * private shadow copy. Pass the same state variable that is fed to
   * `setTurnState` so the streaming indicator is correct during the
   * sending/submitted window (before the first SSE token arrives).
   *
   * Integration note: ChatView must pass `turnState` here once it
   * destructures the value from its own useState.
   */
  turnState?: string;
}

/**
 * One tool call currently in flight for the active turn (turn.tool_call ->
 * turn.tool_result). `cancelled` is set OPTIMISTICALLY the instant
 * sessions.toolCalls.cancel resolves `cancelled: true`, the entry is not
 * removed until the matching turn.tool_result (or a terminal turn event)
 * actually arrives, so "Cancelled" renders honestly for exactly as long as the
 * daemon is still winding the call down, never flashing to nothing early.
 */
export interface ActiveToolCall {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly cancelled: boolean;
}

export interface UseChatStreamResult {
  /** Whether a turn is actively in-flight (running, streaming, tooling, or reconnecting). */
  isStreaming: boolean;
  /**
   * Stop the in-flight turn, a TRUE server-side stop: calls
   * companion.chat.turns.cancel and keeps the stream open awaiting the
   * terminal turn.cancelled event (which also converges every other
   * connected client). Falls back to the old local-render stop, honestly
   * labeled, only on a pre-1.4 daemon that doesn't serve the verb.
   */
  stop: () => void;
  /**
   * Force a fresh connection attempt after the stream gave up ('stream paused').
   * The built-in reconnect only retries up to DEFAULT_SSE_RECONNECT.maxAttempts with
   * backoff; once exhausted the SDK stops entirely on its own, so recovery needs an
   * explicit re-open. Safe to call any time, it just re-runs the connect effect.
   */
  retryStream: () => void;
  /** Tool calls currently running for this turn (see ActiveToolCall). Empty outside
   *  a 'tooling' window and cleared on every terminal turn event. */
  activeToolCalls: readonly ActiveToolCall[];
  /**
   * Completed tool calls (name, input, result) for every turn this browser tab has
   * watched finish live, keyed by the assistant message id the turn produced,
   * ChatView attaches these onto the matching rendered message (whether it came
   * from local optimistic state or the server-fetched history) so the fold
   * renders regardless of which source produced that message object. Built
   * purely from turn.tool_call/turn.tool_result/turn.completed stream events;
   * never present for a turn this tab did not watch live (server history has no
   * tool data, see CompletedToolCall's doc comment).
   */
  toolActivityByMessageId: ReadonlyMap<string, readonly CompletedToolCall[]>;
  /**
   * Cancel ONE running tool call (sessions.toolCalls.cancel), the turn itself
   * continues; only this one call is stopped. Marks the local entry
   * `cancelled: true` on a `{cancelled: true}` response; a `{cancelled: false}`
   * response (the daemon declined, e.g. the call already finished) surfaces via
   * the returned promise so the caller can toast the honest reason.
   */
  cancelToolCall: (callId: string) => Promise<{ cancelled: boolean }>;
}

export function useChatStream({
  activeSessionId,
  liveTextRef,
  onSessionMissing,
  setTurnState,
  setTurnError,
  setLiveText,
  setLocalMessages,
  setPendingUserMessageId,
  invalidateChatState,
  onAuthExpired,
  turnState,
}: UseChatStreamOptions): UseChatStreamResult {
  // Ref to the SSE disconnect fn so stop() can call it at any time. Owned by the
  // CURRENT connection effect only, a stale effect never writes here (see the
  // per-effect `cancelled` flag in the connect effect below).
  const disconnectRef = useRef<(() => void) | undefined>(undefined);
  // Intra-turn stop signal for the CURRENT connection effect: set by stop() so the
  // live stream's callbacks and its (possibly still-pending) open promise both go
  // inert for the rest of this turn. Distinct from the per-effect `cancelled` flag,
  // which handles the CROSS-effect case (session switch / retry / unmount).
  const stoppedRef = useRef(false);
  // Bumped by retryStream() to force a fresh connect after the SDK's own
  // reconnect loop gives up (it never retries again on its own past onTerminate).
  const [retryNonce, setRetryNonce] = useState(0);
  // Tool calls currently in flight for this turn, see ActiveToolCall's own doc comment.
  const [activeToolCalls, setActiveToolCalls] = useState<readonly ActiveToolCall[]>([]);
  // Completed tool calls, keyed by the assistant message id of the turn that produced
  // them, see toolActivityByMessageId's own doc comment on UseChatStreamResult.
  const [toolActivityByMessageId, setToolActivityByMessageId] = useState<
    ReadonlyMap<string, readonly CompletedToolCall[]>
  >(new Map());
  // Accumulates completed tool calls for the turn CURRENTLY in flight, flushed into
  // toolActivityByMessageId (keyed by assistantMessageId) on turn.completed/
  // turn.cancelled, and discarded on turn.error (no assistant message to attach to).
  const turnToolActivityRef = useRef<CompletedToolCall[]>([]);
  // toolCallId -> {toolName, toolInput} captured at turn.tool_call time, so the
  // matching turn.tool_result can build a full CompletedToolCall without the daemon
  // having to repeat the input back on the result event.
  const pendingToolInputRef = useRef<Map<string, { toolName: string; toolInput: unknown; startedAt: number }>>(new Map());

  // Forward state updates to the caller's authoritative turnState.
  const syncedSetTurnState: Dispatch<SetStateAction<string>> = useCallback(
    (nextState) => {
      setTurnState(nextState);
    },
    [setTurnState],
  );

  // The pre-1.4 behavior, kept as the honest fallback: stops RENDERING only.
  const stopLocally = useCallback(() => {
    stoppedRef.current = true;
    disconnectRef.current?.();
    disconnectRef.current = undefined;
    liveTextRef.current = '';
    setLiveText('');
  }, [liveTextRef, setLiveText]);

  const stop = useCallback(() => {
    if (!activeSessionId) return;
    setTurnState('stopping');
    void sdk.chat.turns.cancel(activeSessionId).catch((error: unknown) => {
      if (isNoActiveTurnError(error)) {
        // Benign: the turn finished before the stop landed. The terminal
        // turn.completed already (or will) settle the state; just don't get
        // stuck in 'stopping' if it already did.
        setTurnState((current) => (current === 'stopping' ? 'idle' : current));
        return;
      }
      if (isMethodUnavailableError(error)) {
        // Pre-1.4 daemon: no server-side stop exists. Do the old local stop
        // and SAY exactly what that means, never pretend the turn is dead.
        stopLocally();
        setTurnState('stopped locally');
        setTurnError(
          'Stopped rendering only. This daemon does not support stopping a turn '
          + 'server-side (needs SDK 1.4+). The reply may still finish and will '
          + 'appear in the history.',
        );
        return;
      }
      setTurnState('error');
      setTurnError(error instanceof Error ? error.message : String(error));
    });
    // On success nothing else happens here: the terminal turn.cancelled event
    // on the open stream is the authoritative signal (for this client AND
    // every other subscriber).
  }, [activeSessionId, setTurnState, setTurnError, stopLocally]);

  const retryStream = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!activeSessionId) return undefined;
    // Per-effect cancellation flag, the "epoch" of THIS connection instance. Set to
    // true by this effect's own cleanup and nothing else; a superseding effect (a
    // session switch, a retryStream(), or unmount) runs this cleanup FIRST, so the
    // outgoing effect's `cancelled` is already true before the incoming effect touches
    // any shared ref. Every callback below, plus the stream-open .then/.catch, closes
    // over ITS OWN `cancelled`. That is what makes a late callback from the OLD stream
    // inert: it reads its own `cancelled` (true), never the shared stoppedRef the new
    // effect just reset to false. Without this, an SDK stream() whose disconnect handle
    // only resolves AFTER the switch would (a) let the old stream's onReconnect/onEvent
    // clobber the new session's state, and (b) store the OLD handle into the shared
    // disconnectRef, orphaning the new stream. See the "session switch mid-handshake"
    // tests.
    let cancelled = false;
    stoppedRef.current = false;
    disconnectRef.current = undefined;
    setLiveText('');
    liveTextRef.current = '';
    setTurnError('');
    setActiveToolCalls([]);
    turnToolActivityRef.current = [];
    pendingToolInputRef.current.clear();

    // True once a drop has been reported for THIS connection instance (an onReconnect
    // fired). Lets onReady tell "the very first connect" (say nothing, turnState is
    // already whatever the caller set) apart from "a reconnect after a drop succeeded"
    // (clear the reconnecting message). Also lets onError tell apart a transient error
    // it already saw via onReconnect (skip, avoid clobbering with a duplicate/contra-
    // dictory 'stream error') from a standalone failure (none observed via this SDK's
    // current wiring, but kept as a defensive fallback).
    let hadDrop = false;
    // Guards the auth-expiry handoff to fire exactly once per connection instance,
    // idempotent either way, but avoids redundant invalidateQueries churn if the dead
    // token keeps producing 401s across more than one handler callback.
    let handledAuthExpiry = false;

    const handleAuthExpiry = (error: unknown): boolean => {
      if (handledAuthExpiry) return true;
      if (!isAuthExpiredError(error)) return false;
      handledAuthExpiry = true;
      onAuthExpired();
      syncedSetTurnState('session expired');
      setTurnError('Your session expired: sign in again to continue.');
      // Stop relying on the built-in reconnect loop: a stale token will just keep
      // 401ing on every retry, burning the bounded attempt budget for nothing.
      disconnectRef.current?.();
      return true;
    };

    void sdk.chat.events.stream(activeSessionId, {
      onReady: () => {
        if (cancelled || stoppedRef.current) return;
        if (hadDrop) {
          hadDrop = false;
          // Functional updater: only clear the reconnecting label if nothing else
          // (a fresh send, a genuine turn error) has already moved turnState on.
          // Routed through syncedSetTurnState (already an effect dependency) rather
          // than the raw setter so this stays in the same forwarding path as every
          // other turnState write below.
          syncedSetTurnState((current) => (current === 'reconnecting' ? 'syncing' : current));
          setTurnError((current) => (current.startsWith('Reconnecting to the live stream') ? '' : current));
        }
      },
      onEvent: (eventName, payload) => {
        if (cancelled || stoppedRef.current) return;
        if (eventName === RELAY_OVERFLOW_EVENT) {
          // Turn frames were dropped over the relay tunnel. Record the honest notice and
          // resync this session's chat state, the missed frames may include turn deltas,
          // so a refetch of the authoritative message list restores the true transcript.
          noteRelayOverflow(readDroppedCount(payload));
          void invalidateChatState(activeSessionId);
          return;
        }
        if (!eventName.startsWith('companion-chat.')) return;
        if (firstString(payload, ['sessionId']) !== activeSessionId) return;
        const type = companionEventType(eventName, payload);

        if (type === 'turn.started') {
          // Fresh turn: drop any leftover tool-activity bookkeeping from a turn that
          // never reached a terminal event (should not happen, but never carry a
          // prior turn's tool calls into this one's fold).
          turnToolActivityRef.current = [];
          pendingToolInputRef.current.clear();
          syncedSetTurnState('running');
          void invalidateChatState(activeSessionId);
          return;
        }

        if (type === 'turn.delta') {
          const delta = firstString(payload, ['delta']);
          if (delta) {
            liveTextRef.current += delta;
            setLiveText((current) => current + delta);
          }
          syncedSetTurnState('streaming');
          return;
        }

        if (type === 'turn.tool_call') {
          const turnId = firstString(payload, ['turnId']);
          const toolCallId = firstString(payload, ['toolCallId']);
          const toolName = firstString(payload, ['toolName']);
          if (toolCallId) {
            setActiveToolCalls((current) => (
              current.some((c) => c.toolCallId === toolCallId)
                ? current
                : [...current, { turnId, toolCallId, toolName, cancelled: false }]
            ));
            // Captured so the matching turn.tool_result (which does not repeat the
            // input back) can still build a full CompletedToolCall for the fold.
            pendingToolInputRef.current.set(toolCallId, { toolName, toolInput: asRecord(payload).toolInput, startedAt: Date.now() });
          }
          syncedSetTurnState('tooling');
          return;
        }

        if (type === 'turn.tool_result') {
          // The tool call ended (normally OR because it was cancelled, either way
          // the daemon's own result arrived, so the honest thing is to drop the
          // entry rather than leave a stale "Cancelled" chip behind).
          const toolCallId = firstString(payload, ['toolCallId']);
          if (toolCallId) {
            setActiveToolCalls((current) => current.filter((c) => c.toolCallId !== toolCallId));
            const pending = pendingToolInputRef.current.get(toolCallId);
            pendingToolInputRef.current.delete(toolCallId);
            const resultRecord = asRecord(payload);
            turnToolActivityRef.current = [
              ...turnToolActivityRef.current,
              {
                toolCallId,
                toolName: pending?.toolName ?? firstString(payload, ['toolName']),
                toolInput: pending?.toolInput,
                result: resultRecord.result,
                isError: Boolean(resultRecord.isError),
                // Timed by this browser: the row's "· 4 s" is what the person waited.
                ...(pending ? { startedAt: pending.startedAt, finishedAt: Date.now() } : {}),
              },
            ];
          }
          syncedSetTurnState('tooling');
          return;
        }

        if (type === 'turn.completed') {
          const assistantMessageId = firstString(payload, ['assistantMessageId', 'messageId']);
          const assistantContent = assistantContentFromCompletedTurn(payload, liveTextRef.current);
          if (assistantContent) {
            setLocalMessages((current) => [
              ...current,
              {
                id: assistantMessageId || `assistant-${firstString(payload, ['turnId']) || Date.now()}`,
                sessionId: activeSessionId,
                role: 'assistant' as const,
                content: assistantContent,
                createdAt: Date.now(),
                deliveryState: 'sent' as const,
              },
            ]);
            setPendingUserMessageId('');
            syncedSetTurnState('completed');
          } else {
            syncedSetTurnState('syncing');
          }
          // Fold this turn's completed tool calls onto the message they produced,
          // matched by id whether the message renders from this optimistic local
          // copy or from the server-fetched history that invalidateChatState below
          // brings in (both end up with the same assistantMessageId).
          const completedCalls = turnToolActivityRef.current;
          if (completedCalls.length) {
            setToolActivityByMessageId((current) => withToolActivity(current, assistantMessageId, completedCalls));
          }
          turnToolActivityRef.current = [];
          pendingToolInputRef.current.clear();
          setLiveText('');
          liveTextRef.current = '';
          setActiveToolCalls([]);
          void invalidateChatState(activeSessionId);
          return;
        }

        if (type === 'turn.cancelled') {
          // Terminal, exactly like turn.completed/turn.error. The daemon has
          // already persisted the honest partial (deliveryState 'cancelled')
          // when partialPersisted is true; the refetch below renders it with
          // its badge, so no optimistic local copy is needed.
          const assistantMessageId = firstString(payload, ['assistantMessageId']);
          const completedCalls = turnToolActivityRef.current;
          if (assistantMessageId && completedCalls.length) {
            setToolActivityByMessageId((current) => withToolActivity(current, assistantMessageId, completedCalls));
          }
          turnToolActivityRef.current = [];
          pendingToolInputRef.current.clear();
          setPendingUserMessageId('');
          syncedSetTurnState('stopped');
          setLiveText('');
          liveTextRef.current = '';
          setActiveToolCalls([]);
          void invalidateChatState(activeSessionId);
          return;
        }

        if (type === 'turn.error') {
          // No assistant message was produced, the accumulated tool activity has
          // nothing to attach to and is honestly discarded, not held onto.
          turnToolActivityRef.current = [];
          pendingToolInputRef.current.clear();
          syncedSetTurnState('error');
          setTurnError(firstString(payload, ['error']) || 'Companion chat turn failed.');
          setActiveToolCalls([]);
          void invalidateChatState(activeSessionId);
        }
      },
      // Fires on every transient failure the built-in reconnect loop is about to
      // retry (paired with, and called right after, onReconnect below), and once
      // more on the terminal failure (paired with, and called right after,
      // onTerminate below). It never fires standalone against this SDK's current
      // wiring, so `hadDrop`, already true from the paired call, lets this handler
      // stay a no-op rather than overwrite the more specific 'reconnecting' /
      // 'stream paused' / 'session expired' state with a generic 'stream error'.
      onError: (error) => {
        if (cancelled || stoppedRef.current) return;
        if (isSessionNotFoundError(error)) {
          onSessionMissing(activeSessionId);
          return;
        }
        if (handleAuthExpiry(error)) return;
        if (!hadDrop) {
          syncedSetTurnState('stream error');
          setTurnError(error instanceof Error ? error.message : String(error));
        }
      },
      // A drop the built-in reconnect is about to retry (attempts remain and
      // reconnect is enabled), the daemon-blip / SSE-drop case. Honest, distinct
      // from a genuine unrecoverable 'stream error': the connection is expected back.
      onReconnect: ({ attempt, delayMs }) => {
        if (cancelled || stoppedRef.current) return;
        hadDrop = true;
        syncedSetTurnState('reconnecting');
        setTurnError(
          `Reconnecting to the live stream: attempt ${attempt} of ${DEFAULT_SSE_RECONNECT.maxAttempts} `
          + `(next try in ${Math.max(1, Math.round(delayMs / 1000))}s)…`,
        );
      },
      // The built-in reconnect exhausted DEFAULT_SSE_RECONNECT.maxAttempts and gave
      // up for good, it will not try again on its own. Falls back to the composer's
      // 1s message poll (ChatView keeps polling while turnState is a 'reconnecting'/
      // 'sending while reconnecting' ACTIVE_TURN_STATE, and ChatView also polls
      // explicitly while 'stream paused') until retryStream() re-opens the stream.
      onTerminate: ({ error, reconnectAttempts }) => {
        if (cancelled || stoppedRef.current) return;
        if (handleAuthExpiry(error)) return;
        syncedSetTurnState('stream paused');
        setTurnError(
          `Stream paused after ${reconnectAttempts} reconnect attempt${reconnectAttempts === 1 ? '' : 's'}. `
          + 'Live updates are off. Tap the status to retry, or send a message to try again.',
        );
      },
    }, { reconnect: DEFAULT_SSE_RECONNECT }).then((nextDisconnect) => {
      // The SDK only yields the disconnect handle AFTER the handshake. If this effect
      // was superseded (cancelled) or the turn was stopped while that promise was still
      // pending, the handle is already orphaned: disconnect it immediately and never
      // store it, storing a stale handle here is exactly what used to clobber the new
      // session's live disconnectRef.
      if (cancelled || stoppedRef.current) {
        nextDisconnect();
        return;
      }
      disconnectRef.current = nextDisconnect;
    }).catch((err: unknown) => {
      if (!cancelled && !stoppedRef.current) {
        if (isSessionNotFoundError(err)) {
          onSessionMissing(activeSessionId);
          return;
        }
        if (handleAuthExpiry(err)) return;
        syncedSetTurnState('stream error');
        setTurnError(err instanceof Error ? err.message : String(err));
      }
    });

    return () => {
      // Set ONLY this effect's own flag. Its late callbacks / late-resolving open
      // promise read this same closure variable and go inert; the incoming effect
      // (which has already run its predecessor's cleanup by the time it executes)
      // starts with a fresh `cancelled = false` of its own.
      cancelled = true;
      stoppedRef.current = true;
      disconnectRef.current?.();
      disconnectRef.current = undefined;
    };
  }, [
    activeSessionId,
    onSessionMissing,
    onAuthExpired,
    invalidateChatState,
    syncedSetTurnState,
    setLiveText,
    liveTextRef,
    setTurnError,
    setLocalMessages,
    setPendingUserMessageId,
    retryNonce,
  ]);

  const isStreaming = ACTIVE_TURN_STATES.includes(turnState ?? 'idle');

  // cancelToolCall: the turn ITSELF keeps running, only this one tool call is
  // stopped (unlike stop(), which ends the whole turn). Marks the local entry
  // cancelled:true on {cancelled:true}; the entry is removed for real once the
  // matching turn.tool_result (or a terminal turn event) arrives above.
  const cancelToolCall = useCallback(
    async (callId: string): Promise<{ cancelled: boolean }> => {
      const result = await sdk.operator.sessions.toolCalls.cancel(activeSessionId, callId);
      if (result.cancelled) {
        setActiveToolCalls((current) => current.map((c) => (c.toolCallId === callId ? { ...c, cancelled: true } : c)));
      }
      return result;
    },
    [activeSessionId],
  );

  return { isStreaming, stop, retryStream, activeToolCalls, toolActivityByMessageId, cancelToolCall };
}
