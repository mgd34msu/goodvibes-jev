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
 *     rendering is refused instead of ending the turn that is. A daemon that
 *     sends no `turnId` yet makes the gate inert rather than wrong, no turn id
 *     reads as "not a turn frame", which is accepted.
 */

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
  let hostedId: string | null = null;
  let closeStream: (() => void) | null = null;
  let renderer: ReturnType<typeof createHostedFrameRenderer> | null = null;
  /**
   * The `id:` of the last frame this router was given, per stream URL, across
   * every stream it has opened. Held here rather than inside `watch` because
   * that is the whole point: the next turn's stream resumes where the closed
   * one stopped. Keyed by URL, the same key the SDK's connector uses, so a
   * router rebound to a different hosted session starts that session's stream
   * from nothing rather than from another session's position.
   */
  const streamPositions = new Map<string, string>();

  const refuse = (reason: string, chosen = false): RemoteTurnOutcome => ({
    routed: false,
    reason,
    chosen,
  });

  const stopWatching = (): void => {
    if (!closeStream) return;
    try {
      closeStream();
    } catch (error) {
      logger.debug('[remote-conversation] closing the hosted event stream raised', { error: String(error) });
    }
    closeStream = null;
  };

  /**
   * A stream that stopped delivering frames before the turn ended.
   *
   * Not necessarily a failure of the turn: the daemon may still be running it.
   * What is certain is that no further frame reaches THIS process, so the
   * renderer is closed out with what it has and the reason is stated.
   */
  const endWatch = (turnRenderer: HostedFrameRenderer, error: unknown): void => {
    if (turnRenderer.isTurnFinished()) return;
    turnRenderer.abandon(
      'The connection to the hosting daemon ended before this turn finished'
      + `${error ? `: ${String(error)}` : '.'} `
      + 'Anything above this line is what the daemon had already sent. The turn may still be '
      + 'running there, reopen this conversation to see how it ended.',
    );
  };

  /**
   * Open the hosted session's event stream and point a fresh renderer at it.
   *
   * A NEW renderer per turn: its state is the turn's, and a frame arriving late
   * from a finished turn must not land in the next one's message.
   */
  const watch = async (baseUrl: string, token: string, sessionId: string): Promise<HostedFrameRenderer> => {
    stopWatching();
    const turnRenderer = createHostedFrameRenderer(options.conversation, options.requestRender);
    renderer = turnRenderer;
    // A gate per RENDERER, not per router.
    //
    // The SDK's connector keeps one gate for its whole life, which is right for
    // its consumer: a long-lived store that renders every turn in turn. This
    // router's consumer is a new renderer per turn, and a gate carried across
    // turns would still be bound to the PREVIOUS one, so a replayed terminal
    // frame for that turn would match the binding and finish a renderer that
    // has not yet seen its own turn start. Starting unbound is what puts the
    // replayed tail under the gate's third rule: a terminal frame for a turn
    // this renderer never saw run is refused outright rather than allowed to
    // bind.
    const gate = createTurnLifecycleGate();
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const streamUrl = hostedSessionEventStreamUrl(baseUrl, sessionId);
    closeStream = await transport.openServerSentEventStream(
      fetchImpl,
      streamUrl,
      {
        // Every id, as it is read. This is what the NEXT stream presents.
        onEventId: (id: string) => { streamPositions.set(streamUrl, id); },
        onEvent: (_domain: string, payload: unknown) => {
          if (!payload || typeof payload !== 'object') return;
          const frame = payload as HostedSessionFrame;
          if (typeof frame.type !== 'string') return;
          // The route scopes delivery to this session already; this is the
          // client half of the same guarantee, so a daemon that has not been
          // updated yet cannot bleed another session into this transcript.
          if (frame.sessionId !== undefined && frame.sessionId !== sessionId) return;
          // The turn identity lives on the envelope's payload, the same place
          // the SDK's own connector reads it, and a frame carrying none is
          // never withheld.
          const lifecycle = readTurnLifecycleFrame(frame.sessionId, frame.payload);
          if (lifecycle && !gate.accepts(lifecycle)) {
            logger.debug('[remote-conversation] a frame for another turn was not applied', {
              type: frame.type,
              turnId: lifecycle.turnId ?? '(none)',
              rendering: gate.boundTurnId(frame.sessionId) ?? '(unbound)',
            });
            return;
          }
          try {
            options.onFrame?.(frame);
          } catch (error) {
            // An observer that throws is the observer's problem, not the
            // stream's: the turn is still arriving and still worth rendering.
            logger.debug('[remote-conversation] a hosted-frame observer threw', {
              type: frame.type,
              error: String(error),
            });
          }
          try {
            turnRenderer.apply(frame);
          } catch (error) {
            // A mapping failure must not tear down the stream: the rest of the
            // turn is still coming and is still worth rendering.
            logger.debug('[remote-conversation] rendering a hosted frame raised', {
              type: frame.type,
              error: String(error),
            });
          }
        },
        // BOTH endings, deliberately. `onTerminate` fires when reconnection has
        // given up; `onClose` fires when the stream closed cleanly and no
        // reconnect was attempted. Either way the turn has no more frames
        // coming here, and a caller awaiting its completion, a headless run
        // choosing an exit code, would otherwise wait forever.
        onTerminate: ({ error }: { readonly error: unknown }) => endWatch(turnRenderer, error),
        onClose: () => endWatch(turnRenderer, null),
      },
      {
        getAuthToken: () => token,
        // Null on the first stream of a session, there is nothing to resume
        // past, and the daemon's catch-up window is what a client attaching to
        // a session already in flight legitimately wants.
        lastEventId: streamPositions.get(streamUrl) ?? null,
        ...(options.reconnect ? { reconnect: options.reconnect } : {}),
      },
    );
    return turnRenderer;
  };

  const createHosted = async (
    text: string,
    baseUrl: string,
    token: string,
    action: 'created' | 'recreated',
  ): Promise<RemoteTurnOutcome> => {
    // Create WITHOUT `initialPrompt`, then open the stream, then steer the
    // message in.
    //
    // `initialPrompt` starts the turn inside the create call, and the session
    // id it returns is the only way to address the stream, so a create that
    // carries the prompt necessarily emits the start of the turn (and, for a
    // fast one, all of it) before anything is listening. Those frames are gone:
    // the stream is live traffic, not a replayable log. That is one round trip
    // traded for never losing the beginning of an answer, and it makes the
    // first message take the same create-then-steer path every later one does.
    let reply: HostedCreateReply;
    try {
      reply = await options.verbs.invoke<HostedCreateReply>('sessions.hosted.create', {
        originSurface: 'agent',
        workspaceRoot: options.workspaceRoot,
        clientId: options.clientId,
      });
    } catch (error) {
      return refuse(
        `the connected host could not open a hosted conversation, so this turn ran here, ${describeConnectedHostVerbError(error)}`,
      );
    }
    const id = reply.session?.id;
    if (typeof id !== 'string' || id.length === 0) {
      return refuse(
        'the connected host accepted the request to open a hosted conversation but returned no session id '
        + 'this build could read, so this turn ran here.',
      );
    }
    hostedId = id;
    let turnRenderer: HostedFrameRenderer;
    try {
      turnRenderer = await watch(baseUrl, token, id);
    } catch (error) {
      // The session EXISTS and its turn is running on the daemon. Refusing here
      // and re-running locally would run the same message twice, on two
      // machines. Report honestly instead and keep the binding.
      return refuse(
        `the hosted conversation opened on the connected host, but this surface could not watch its output, `
        + `${String(error)}. The turn is running there; reopen this conversation to see it.`,
      );
    }
    // The stream is open now, so the turn's first frame has somewhere to land.
    try {
      await options.verbs.invoke<unknown>('sessions.steer', { sessionId: id, body: text });
    } catch (error) {
      stopWatching();
      hostedId = null;
      return refuse(
        `the connected host opened a hosted conversation but would not take the message into it, `
        + `so this turn ran here, ${describeConnectedHostVerbError(error)}`,
      );
    }
    return { routed: true, hostedSessionId: id, action, completion: turnRenderer.completion() };
  };

  const submit = async (text: string, context?: RemoteTurnContext): Promise<RemoteTurnOutcome> => {
    if (options.configManager.get('hostedSessions.routeConversationTurns') === false) {
      return refuse(ROUTING_DISABLED_REASON, true);
    }
    if (context?.hasAttachments) {
      return refuse(
        'this turn ran in this process because it carries attachments, and a daemon-hosted '
        + 'conversation takes text only, routing it would have dropped them.',
      );
    }
    const connection = options.resolveConnection();
    if ('reason' in connection) {
      return refuse(`this turn ran in this process because ${connection.reason}`);
    }
    if (!options.workspaceRoot.startsWith('/')) {
      return refuse(
        'a hosted conversation needs an absolute workspace path and this process resolved '
        + `'${options.workspaceRoot}', so this turn ran here.`,
      );
    }

    if (!hostedId) {
      return createHosted(text, connection.baseUrl, connection.token, 'created');
    }

    const existing = hostedId;
    try {
      // The stream is re-opened per turn with a fresh renderer before the steer
      // lands, so the first delta has somewhere to go.
      const turnRenderer = await watch(connection.baseUrl, connection.token, existing);
      await options.verbs.invoke<unknown>('sessions.steer', {
        sessionId: existing,
        body: text,
      });
      return {
        routed: true,
        hostedSessionId: existing,
        action: 'steered',
        completion: turnRenderer.completion(),
      };
    } catch (error) {
      if (!isStaleHostedSession(error)) {
        stopWatching();
        return refuse(
          `the connected host would not take this message into the hosted conversation, so it ran here, ${describeConnectedHostVerbError(error)}`,
        );
      }
      // The remembered session is gone. Open a fresh one and carry the message
      // into it, rather than reporting a failure for a recoverable state.
      logger.info('[remote-conversation] the hosted conversation was gone; opening a new one', {
        previous: existing,
      });
      hostedId = null;
      stopWatching();
      return createHosted(text, connection.baseUrl, connection.token, 'recreated');
    }
  };

  return {
    submit,
    hostedSessionId: () => hostedId,
    dispose: (): void => {
      stopWatching();
      renderer = null;
    },
  };
}
