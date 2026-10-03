/**
 * remote-conversation.ts, running this surface's own conversation turns inside
 * the connected daemon.
 *
 * ── What this changes ─────────────────────────────────────────────────────
 *
 * A turn used to run here: the composer handed text to the in-process
 * Orchestrator, which called a provider over HTTPS from this process. The
 * daemon already hosts complete conversation loops for other callers, so the
 * loop host and the surface were two different things depending on who asked.
 *
 * With routing on, the first message of a conversation creates a daemon-hosted
 * session rooted at this surface's working directory, every later message is
 * steered into it, and this surface renders the turn from the hosted session's
 * event stream. The turn no longer depends on this process staying open, and
 * every surface attached to that session sees one conversation.
 *
 * ── Transcript authority ──────────────────────────────────────────────────
 *
 * The daemon holds the authoritative transcript: it ran the loop, and its
 * ConversationManager is the one that saw every message. What this surface
 * writes locally is a MIRROR of what the stream delivered, kept, because it is
 * the offline record a person still has when the daemon is not running, and
 * because the existing local persistence path is what makes a session
 * resumable here. It is deliberately not treated as the source of truth: on
 * any disagreement the daemon's transcript is the one that ran.
 *
 * ── Fallback is stated, never silent ──────────────────────────────────────
 *
 * Every path that cannot route says so, in one line, in the transcript, naming
 * the reason. A turn that quietly ran somewhere other than where the settings
 * say it should is the failure this contract exists to prevent, the person
 * needs to know which machine just read their files. The `promote()` seam in
 * hosted-handoff.ts already established this shape for inbound channel
 * conversations; this is the same contract for the composer.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 *
 * No second SSE implementation. `openServerSentEventStream` is the SDK's, with
 * its reconnect policy and auth handling already proven by the approvals
 * stream, and it is what this opens.
 *
 * ── Why this file states a position and a turn ────────────────────────────
 *
 * This router opens a FRESH stream per turn (see `watch`), which is exactly the
 * client shape the daemon's catch-up replay hurts: a stream that claims no
 * position is handed the tail of the previous turn, that turn's
 * `TURN_COMPLETED` included, and the renderer, new, and therefore having never
 * seen that turn run, finishes on it. Every real frame of the turn actually
 * running is then dropped as post-terminal noise, on a turn that has already
 * been billed for.
 *
 * The SDK ships both halves of the answer, but they live on
 * `createEventSourceConnector`, the runtime-event connector, which addresses
 * `/api/control-plane/events` and hands typed envelopes to a store. This router
 * addresses one session's own stream and renders it into a conversation, so it
 * opens the raw stream directly and states the same two things itself:
 *
 *  1. POSITION. Every `id:` this router reads is remembered for the life of the
 *     ROUTER, not the life of one stream, and presented as `Last-Event-ID` when
 *     the next turn's stream opens. The daemon then replays only what this
 *     router has not already been given.
 *  2. TURN IDENTITY. `createTurnLifecycleGate` is the second line, for the
 *     replays position cannot prevent, a daemon that predates the resume, a
 *     position that has aged out of the ring, a frame that genuinely arrives
 *     twice. A terminal frame addressed to a turn this renderer is not
 *     rendering is refused instead of ending the turn that is.
 *  3. SUBMISSION CORRELATION. The fresh correlation id sent with sessions.steer
 *     must be echoed in TURN_SUBMITTED.origin.metadata. A replayed or queued
 *     turn is not this submission merely because it is the first stream frame.
 *     Older hosts without this echo remain unconfirmed rather than granting
 *     this surface ownership of somebody else's execution.
 */

import { randomUUID } from 'node:crypto';
import { createOperatorSdk, type OperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import { transport } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { createTurnLifecycleGate, readTurnLifecycleFrame } from '@goodvibes-jev/engine/sdk/transport-realtime';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ConnectedHostVerbError, describeConnectedHostVerbError } from './daemon-verbs.ts';
import {
  createHostedFrameRenderer,
  type HostedFrameConversation,
  type HostedFrameRenderer,
  type HostedSessionFrame,
  type HostedTurnCompletion,
} from './hosted-frame-render.ts';

/** The reason given when the person has turned routing off themselves. */
export const ROUTING_DISABLED_REASON =
  'hostedSessions.routeConversationTurns is off, so this turn ran in this process.';

/** What happened to one submitted message. */
export type RemoteTurnOutcome =
  | {
    readonly routed: true;
    readonly hostedSessionId: string;
    /** Whether this message opened the session, steered it, or reopened it. */
    readonly action: 'created' | 'steered' | 'recreated';
    /**
     * Resolves when the hosted turn ENDS, with its final text and stop reason.
     *
     * `submit` deliberately resolves as soon as the daemon has the turn, so an
     * interactive composer is not blocked on a whole turn. A headless run needs
     * the other thing, one final answer and an exit code, and this is where
     * it waits, since a hosted turn emits no local turn events for it to watch.
     *
     * Ignoring it is fine and is what the composer does.
     */
    readonly completion: Promise<HostedTurnCompletion>;
  }
  | {
    readonly routed: false;
    /**
     * Why the turn is running here instead. Always a complete sentence, it is
     * shown to the person, not only logged.
     */
    readonly reason: string;
    /** True when the person chose local, so nothing is wrong and nothing warns. */
    readonly chosen: boolean;
    /** Stop won before submission; the caller must not fall back locally. */
    readonly cancelled?: boolean;
  };

/** The connected host's address and token, or the honest reason there is none. */
export type ConnectedHostResolution =
  | { readonly baseUrl: string; readonly token: string }
  | { readonly reason: string };

export interface RemoteConversationRouterOptions {
  readonly verbs: DaemonVerbCaller;
  readonly configManager: Pick<ConfigManager, 'get'>;
  /** The same resolution the verb caller uses, so calls and the stream agree. */
  readonly resolveConnection: () => ConnectedHostResolution;
  readonly conversation: HostedFrameConversation;
  readonly requestRender: () => void;
  /**
   * The workspace the hosted session's tools operate in, this surface's own
   * working directory. Must be absolute; the daemon refuses a relative path
   * rather than resolving it against its own directory, and it is right to.
   */
  readonly workspaceRoot: string;
  /** Identifies this surface's attachment to the hosted session. */
  readonly clientId: string;
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * Every frame this router applies, before it is rendered.
   *
   * For callers that need the raw stream as well as the rendered conversation
   *, `run --output-format stream-json` re-emits deltas, and counts frames the
   * way the local path counts turn events. Rendering does not depend on it.
   */
  readonly onFrame?: ((frame: HostedSessionFrame) => void) | undefined;
  readonly onCancellationNotice?: ((message: string) => void) | undefined;
  /**
   * Reconnect policy for the hosted event stream. Defaults to the SDK's, which
   * retries with backoff, the right behaviour, because the turn is still
   * running on the daemon and a reconnect recovers the rest of it rather than
   * abandoning work that is still happening.
   *
   * Exposed so a caller can disable it: a test needs the stream's close to
   * become a termination immediately instead of waiting out ten attempts.
   */
  readonly reconnect?: { readonly enabled: boolean } | undefined;
}

/** What else the caller knows about this submission. */
export interface RemoteTurnContext {
  /**
   * Whether the person attached files to this message. `sessions.hosted.create`
   * carries text only, so a message with attachments runs locally and says so
   *, dropping a file someone attached would be worse than not routing.
   */
  readonly hasAttachments?: boolean | undefined;
}

export interface RemoteConversationRouter {
  /**
   * Route one submitted message.
   *
   * Resolves when the turn has been HANDED to the daemon and its stream is
   * open, not when the turn finishes. A routed turn then renders itself
   * through the frame renderer as frames arrive, exactly as a local turn
   * renders itself as the provider streams.
   *
   * Never throws: a failure is an outcome with a reason, because the caller is
   * a keystroke path and a thrown error there loses the person's message.
   */
  submit(text: string, context?: RemoteTurnContext): Promise<RemoteTurnOutcome>;
  /** The hosted session this conversation is bound to, if any. */
  hostedSessionId(): string | null;
  /** Request Stop for this submission only; true means the hosted path owns it. */
  cancelTurn(): boolean;
  /** Stop watching. Leaves the hosted session alone, detaching is separate. */
  dispose(): void;
}

/** The daemon's reply to `sessions.hosted.create`. Only the id is read. */
interface HostedCreateReply {
  readonly session?: { readonly id?: unknown } | undefined;
}

/**
 * A 404 or 409 from a steer means the hosted session this surface remembers is
 * gone or no longer accepts work, the daemon restarted, it was killed, its
 * retention lapsed. That is recoverable by opening a new one. Anything else
 * (a session cap, a 5xx) is a real refusal and must not trigger a second
 * create; retrying into a cap is how one failure becomes two.
 */
function isStaleHostedSession(error: unknown): boolean {
  return error instanceof ConnectedHostVerbError && (error.status === 404 || error.status === 409);
}

/** Build the hosted session's event-stream URL. */
export function hostedSessionEventStreamUrl(baseUrl: string, hostedSessionId: string): string {
  return new URL(`/api/sessions/${encodeURIComponent(hostedSessionId)}/events`, baseUrl).toString();
}

export function createRemoteConversationRouter(
  options: RemoteConversationRouterOptions,
): RemoteConversationRouter {
  interface WatchedTurn {
    readonly operator: OperatorSdk;
    readonly correlationId: string;
    sessionId: string | null;
    turnId: string | null;
    renderer: HostedFrameRenderer | null;
    closeStream: (() => void) | null;
    finished: boolean;
    submissionPending: boolean;
    settledByHost: boolean;
    steerAttempted: boolean;
    cancelRequested: boolean;
    cancelQueued: boolean;
    cancellationAcknowledged: boolean;
    identityNoticeShown: boolean;
    cancelRequest: Promise<void> | null;
    cancelController: AbortController | null;
  }
  let hostedId: string | null = null;
  let active: WatchedTurn | null = null;
  let disposed = false;
  let submissionGeneration = 0;
  const streamPositions = new Map<string, string>();
  const refuse = (reason: string, chosen = false): RemoteTurnOutcome => ({ routed: false, reason, chosen });
  const stopped = (): RemoteTurnOutcome => ({
    routed: false, chosen: true, cancelled: true,
    reason: 'Stopped before this message was submitted; it was not run locally.',
  });
  const notice = (turn: WatchedTurn, message: string): void => {
    if (active !== turn || turn.finished || disposed) return;
    try { options.onCancellationNotice?.(message); } catch (error) {
      logger.debug('[remote-conversation] cancellation observer threw', { error: String(error) });
    }
  };
  const release = (turn: WatchedTurn): void => {
    if (turn.finished) return;
    turn.finished = true;
    if (active === turn) active = null;
    turn.cancelController?.abort();
    const close = turn.closeStream;
    turn.closeStream = null;
    try { close?.(); } catch (error) {
      logger.debug('[remote-conversation] closing the hosted event stream raised', { error: String(error) });
    }
    turn.operator.dispose();
  };
  const abandon = (turn: WatchedTurn, reason: string): void => {
    turn.renderer?.abandon(reason);
    if (!turn.submissionPending) release(turn);
  };
  const isCurrent = (turn: WatchedTurn): boolean => active === turn && !turn.finished && !disposed;

  const sendCancellation = (turn: WatchedTurn): void => {
    if (!isCurrent(turn) || !turn.cancelQueued || turn.cancelRequest || turn.cancellationAcknowledged
      || !turn.sessionId || !turn.turnId) return;
    const sessionId = turn.sessionId;
    const expectedTurnId = turn.turnId;
    const controller = new AbortController();
    turn.cancelController = controller;
    turn.cancelQueued = false;
    // Set ownership before invoking the client, including an observer that
    // re-enters Stop synchronously. POST retries remain explicit and same-ID.
    turn.cancelRequest = Promise.resolve().then(async () => {
      if (!isCurrent(turn)) return;
      notice(turn, '[Stop] Requesting cancellation of the hosted turn; waiting for the host.');
      if (!isCurrent(turn)) return;
      try {
        const receipt: OperatorMethodOutput<'sessions.turns.cancel'> = await turn.operator.sessions.turns.cancel(
          { sessionId, expectedTurnId }, { signal: controller.signal },
        );
        if (!isCurrent(turn) || turn.turnId !== expectedTurnId) return;
        if (receipt.sessionId !== sessionId || receipt.expectedTurnId !== expectedTurnId) {
          throw new Error('The cancellation response did not match the requested hosted turn.');
        }
        switch (receipt.status) {
          case 'cancellation-requested':
            turn.cancellationAcknowledged = true;
            notice(turn, '[Stop] The host accepted cancellation; waiting for this turn to finish.');
            break;
          case 'already-ended':
            notice(turn, '[Stop] The host reports this turn already ended; waiting for its terminal event.');
            break;
          case 'stale-turn':
            notice(turn, '[Stop] This request refers to an older turn. No different turn was cancelled; watching for the original outcome.');
            break;
          case 'turn-not-found':
            notice(turn, '[Stop] The host could not find this turn. Cancellation is unconfirmed; the stream remains attached.');
            break;
        }
      } catch (error) {
        if (isCurrent(turn) && turn.turnId === expectedTurnId) {
          notice(turn, `[Stop] Cancellation could not be confirmed: ${describeConnectedHostVerbError(error)} `
            + 'The stream remains attached. Press Stop again to retry this same turn.');
        }
      } finally {
        turn.cancelController = null;
        turn.cancelRequest = null;
      }
    });
  };

  const watch = async (turn: WatchedTurn, baseUrl: string, token: string, sessionId: string): Promise<HostedFrameRenderer> => {
    turn.sessionId = sessionId;
    const renderer = createHostedFrameRenderer(options.conversation, options.requestRender);
    turn.renderer = renderer;
    const isCurrentWatch = (): boolean => isCurrent(turn) && turn.renderer === renderer;
    const gate = createTurnLifecycleGate();
    const streamUrl = hostedSessionEventStreamUrl(baseUrl, sessionId);
    const terminalTypes = new Set(['TURN_CANCEL', 'TURN_COMPLETED', 'TURN_ERROR', 'PREFLIGHT_FAIL']);
    const close = await transport.openServerSentEventStream(options.fetchImpl ?? globalThis.fetch, streamUrl, {
      // The SDK parses id: before dispatching its event. After terminal release
      // or replacement, buffered frames no longer advance this watch's cursor.
      onEventId: (id: string) => { if (isCurrentWatch()) streamPositions.set(streamUrl, id); },
      onEvent: (_domain: string, payload: unknown) => {
        if (!isCurrentWatch() || !payload || typeof payload !== 'object') return;
        const frame = payload as HostedSessionFrame;
        if (typeof frame.type !== 'string') return;
        if (frame.sessionId !== undefined && frame.sessionId !== sessionId) return;
        const frameTurnId = frame.payload?.['turnId'];
        // A session stream may replay prior work or carry somebody else's
        // queued turn. Only the server's echo of this submission can confer
        // ownership. Prompt text, timing and first-frame order are not ids.
        if (frame.type === 'TURN_SUBMITTED') {
          const origin = frame.payload?.['origin'];
          const metadata = origin && typeof origin === 'object' ? (origin as Record<string, unknown>)['metadata'] : undefined;
          const correlationId = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)['correlationId'] : undefined;
          if (frame.sessionId !== sessionId || correlationId !== turn.correlationId
            || typeof frameTurnId !== 'string' || frameTurnId.length === 0) {
            if (correlationId === undefined && !turn.identityNoticeShown) {
              turn.identityNoticeShown = true;
              notice(turn, '[Turn] The host has not identified this submission. Waiting for its correlated start; Stop will not cancel an unidentified turn.');
            }
            return;
          }
          if (turn.turnId !== null && turn.turnId !== frameTurnId) return;
          turn.turnId = frameTurnId;
        }
        // Neither rendering nor terminal settlement can use unrelated work
        // while this submission is still queued. Non-turn session notices may
        // still reach observers, but have no rendering or lifecycle authority.
        if (turn.turnId === null && (typeof frameTurnId === 'string'
          || terminalTypes.has(frame.type) || frame.type.startsWith('STREAM_')
          || frame.type.startsWith('TOOL_') || frame.type.startsWith('LLM_')
          || frame.type.startsWith('PREFLIGHT_'))) return;
        if (turn.turnId !== null && typeof frameTurnId === 'string' && frameTurnId !== turn.turnId) return;
        if (terminalTypes.has(frame.type)
          && (frame.sessionId !== sessionId || frameTurnId !== turn.turnId)) return;
        // The public gate retains duplicate/stale lifecycle protection within
        // the positively correlated execution.
        const lifecycle = readTurnLifecycleFrame(frame.sessionId, frame.payload);
        if (lifecycle && !gate.accepts(lifecycle)) return;
        try { options.onFrame?.(frame); } catch (error) {
          logger.debug('[remote-conversation] a hosted-frame observer threw', { error: String(error) });
        }
        if (!isCurrentWatch()) return;
        try { renderer.apply(frame); } catch (error) {
          logger.debug('[remote-conversation] rendering a hosted frame raised', { error: String(error) });
        }
        if (renderer.isTurnFinished()) { turn.settledByHost = true; release(turn); }
        else sendCancellation(turn);
      },
      onTerminate: ({ error }: { readonly error: unknown }) => {
        if (isCurrentWatch()) abandon(turn, 'The connection to the hosting daemon ended before this turn finished. '
          + `Cancellation and completion are unconfirmed${error ? `: ${String(error)}` : '.'} `
          + 'The turn may still be running there; reopen this conversation to see how it ended.');
      },
      onClose: () => {
        if (isCurrentWatch()) abandon(turn, 'The connection to the hosting daemon ended before this turn finished. '
          + 'The turn may still be running there; reopen this conversation to see how it ended.');
      },
    }, {
      getAuthToken: () => token,
      lastEventId: streamPositions.get(streamUrl) ?? null,
      ...(options.reconnect ? { reconnect: options.reconnect } : {}),
    });
    if (!isCurrentWatch()) close();
    else turn.closeStream = close;
    return renderer;
  };

  const submit = async (text: string, context?: RemoteTurnContext): Promise<RemoteTurnOutcome> => {
    if (disposed) return stopped();
    const generation = ++submissionGeneration;
    if (active) { active.submissionPending = false; abandon(active, 'This surface switched to a newer submission before the previous turn settled. '
      + 'Its remote outcome is unconfirmed; switching did not cancel it.'); }
    if (options.configManager.get('hostedSessions.routeConversationTurns') === false) return refuse(ROUTING_DISABLED_REASON, true);
    if (context?.hasAttachments) return refuse('this turn ran in this process because it carries attachments, and a daemon-hosted '
      + 'conversation takes text only, routing it would have dropped them.');
    const connection = options.resolveConnection();
    if ('reason' in connection) return refuse(`this turn ran in this process because ${connection.reason}`);
    if (!options.workspaceRoot.startsWith('/')) return refuse('a hosted conversation needs an absolute workspace path and this process resolved '
      + `'${options.workspaceRoot}', so this turn ran here.`);
    let operator: OperatorSdk;
    try {
      operator = createOperatorSdk({ baseUrl: connection.baseUrl, authToken: connection.token, fetchImpl: options.fetchImpl ?? globalThis.fetch });
    } catch (error) {
      return refuse(`the connected host client could not be opened, so this turn ran here, ${describeConnectedHostVerbError(error)}`);
    }
    const turn: WatchedTurn = {
      operator,
      correlationId: randomUUID(),
      sessionId: null, turnId: null, renderer: null, closeStream: null, finished: false, submissionPending: true, settledByHost: false, steerAttempted: false,
      cancelRequested: false, cancelQueued: false, cancellationAcknowledged: false, identityNoticeShown: false, cancelRequest: null, cancelController: null,
    };
    active = turn;
    let action: 'created' | 'steered' | 'recreated' = hostedId ? 'steered' : 'created';
    const create = async (): Promise<string> => {
      const reply = await options.verbs.invoke<HostedCreateReply>('sessions.hosted.create', {
        originSurface: 'agent', workspaceRoot: options.workspaceRoot, clientId: options.clientId,
      });
      const id = reply.session?.id;
      if (typeof id !== 'string' || id.length === 0) throw new Error('the connected host returned no session id this build could read');
      if (isCurrent(turn)) hostedId = id;
      return id;
    };
    const stopBeforeSteer = (): RemoteTurnOutcome | null => {
      // A synchronous catch-up may have rendered its terminal frame while the
      // stream was opening. Preserve submission unless Stop/dispose/replacement won.
      if (turn.settledByHost && !turn.cancelRequested && !disposed
        && active === null && generation === submissionGeneration) return null;
      if (turn.cancelRequested || !isCurrent(turn)) { turn.submissionPending = false; release(turn); return stopped(); }
      return null;
    };
    try {
      let id = hostedId ?? await create();
      let cancelled = stopBeforeSteer();
      if (cancelled) return cancelled;
      let renderer = await watch(turn, connection.baseUrl, connection.token, id);
      cancelled = stopBeforeSteer();
      if (cancelled) return cancelled;
      try {
        turn.steerAttempted = true;
        await options.verbs.invoke<unknown>('sessions.steer', { sessionId: id, body: text, metadata: { correlationId: turn.correlationId } });
      } catch (error) {
        if (turn.cancelRequested) {
          turn.submissionPending = false;
          abandon(turn, 'Stop was requested while submission was awaiting the host. The submission response failed; '
            + 'whether the host admitted or cancelled this turn is unconfirmed. It was not run locally.');
          return { routed: true, hostedSessionId: id, action, completion: renderer.completion() };
        }
        if (action !== 'steered' || !isStaleHostedSession(error) || !isCurrent(turn)) throw error;
        // Only a stale existing session can recreate. Stop arriving during any
        // of these waits still prevents the next admission/fallback.
        const close = turn.closeStream;
        turn.closeStream = null;
        turn.renderer = null;
        turn.turnId = null;
        turn.steerAttempted = false;
        close?.();
        if (!isCurrent(turn)) return stopped();
        hostedId = null;
        id = await create();
        action = 'recreated';
        cancelled = stopBeforeSteer();
        if (cancelled) return cancelled;
        renderer = await watch(turn, connection.baseUrl, connection.token, id);
        cancelled = stopBeforeSteer();
        if (cancelled) return cancelled;
        turn.steerAttempted = true;
        await options.verbs.invoke<unknown>('sessions.steer', { sessionId: id, body: text, metadata: { correlationId: turn.correlationId } });
      }
      turn.submissionPending = false;
      if (renderer.isTurnFinished()) release(turn);
      return { routed: true, hostedSessionId: id, action, completion: renderer.completion() };
    } catch (error) {
      turn.submissionPending = false;
      if (turn.cancelRequested && turn.steerAttempted && turn.sessionId && turn.renderer && !turn.settledByHost) {
        abandon(turn, 'The submission response failed after Stop; remote admission and cancellation are unconfirmed. The message was not run locally.');
        return { routed: true, hostedSessionId: turn.sessionId, action, completion: turn.renderer.completion() };
      }
      if (turn.sessionId && turn.settledByHost && turn.renderer) {
        return { routed: true, hostedSessionId: turn.sessionId, action, completion: turn.renderer.completion() };
      }
      if (turn.cancelRequested || !isCurrent(turn)) {
        release(turn);
        return stopped();
      }
      release(turn);
      return refuse(`the connected host would not take this message into the hosted conversation, so it ran here, ${describeConnectedHostVerbError(error)}`);
    }
  };

  return {
    submit,
    hostedSessionId: () => hostedId,
    cancelTurn: () => {
      const turn = active;
      if (!turn || !isCurrent(turn) || (!turn.submissionPending && turn.renderer?.isTurnFinished())) return false;
      if (!turn.cancelRequested) {
        turn.cancelRequested = true;
        if (!turn.turnId) notice(turn, '[Stop] Waiting for hosted submission identity; cancellation is pending.');
      }
      if (!turn.cancelRequest && !turn.cancellationAcknowledged) turn.cancelQueued = true;
      sendCancellation(turn);
      return true;
    },
    dispose: () => {
      disposed = true;
      if (active) { active.submissionPending = false; abandon(active, 'This surface detached before the hosted turn settled. Detaching does not cancel the remote turn.'); }
    },
  };
}
