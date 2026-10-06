/**
 * remote-conversation-wiring.ts, the composer's one decision about WHERE a
 * turn runs.
 *
 * The router itself (runtime/client/remote-conversation.ts) knows how to open
 * and steer a daemon-hosted session and how to render it. This is the surface
 * half: what the composer does with the answer, mirror the user's message when
 * the daemon took the turn, and say one honest line when it did not.
 *
 * It lives beside main.ts rather than inside it so the composer keeps one call
 * where it used to have one call.
 */

import type { NativeConversationInput } from '../runtime/native-conversation-input.ts';
import { nativeConversationIntakeLines, type NativeConversationIntakeActions, type NativeConversationIntakeState } from '../runtime/native-conversation-intake.ts';
import { createRemoteConversationRouter, sameNativeRemoteConnection, type ConnectedHostResolution } from '../runtime/client/remote-conversation.ts';
import { mirrorHostedSessionToStore, recoverUnmirroredHostedSessions, type HostedAttachReply } from '../runtime/client/hosted-session-mirror.ts';
import { persistConversation } from '@/runtime/index.ts';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { BootstrapContext } from '../runtime/bootstrap.ts';
import type { HostedSessionFrame, HostedTurnCompletion } from '../runtime/client/hosted-frame-render.ts';
import { bridgeHostedFrameOntoRuntimeBus } from '../runtime/client/hosted-turn-bus-bridge.ts';
import { createHostedTurnActivity, type HostedTurnActivity } from './hosted-turn-activity.ts';

export interface RemoteConversationWiringOptions {
  readonly render: () => void;
  /** Passed through to the router, see its `onFrame`. */
  readonly onFrame?: ((frame: HostedSessionFrame) => void) | undefined;
  /**
   * How a one-line notice reaches the person. The same channel the surface
   * already uses for the lines it must not bury.
   */
  readonly notify: (message: string) => void;
}

export interface RemoteConversationWiring {
  /**
   * Decide where this turn runs and act on it.
   *
   * Returns a HANDLE when the connected daemon has the turn: an interactive
   * caller can discard it, because the turn renders itself from the hosted
   * session's event stream as frames arrive. A caller that has to WAIT for one
   * answer, a headless `run` choosing an exit code, awaits `completion`.
   *
   * Returns `null` when the caller should run the turn locally, having already
   * been told why. Both shapes stay truthy/falsy, so `if (await …) return;`
   * reads the same as it did when this returned a boolean.
   */
  routeOrExplain(text: string, hasAttachments: boolean): Promise<RoutedTurnHandle | null>;
  /** Request cancellation while retaining observation until terminal settlement. */
  cancelHostedTurn(): boolean;
  /**
   * The tool a hosted turn is running right now, for the shell's tool preview
   * and Activity modal, both of which otherwise read a local snapshot that
   * a daemon-hosted turn never fills in.
   */
  hostedToolPreview(): string | undefined;
  dispose(): void;
}

export interface NativeRemoteConversationWiring extends RemoteConversationWiring {
  /** Native admission always precedes delivery; null only when local routing was chosen. */
  routeNativeOrExplain(source: NativeConversationInput, intake: NativeConversationIntakeActions | undefined): Promise<RoutedTurnHandle | null>;
  /** Explicit recovery observes the exact saved original without submitting it again. */
  observeNative(state: NativeConversationIntakeState, intake: NativeConversationIntakeActions): Promise<RoutedTurnHandle>;
}

/** A turn the daemon accepted, and the way to wait for how it ended. */
export interface RoutedTurnHandle {
  readonly hostedSessionId: string | null;
  readonly completion: Promise<HostedTurnCompletion>;
}

export function installRemoteConversationRouting(
  ctx: BootstrapContext,
  options: RemoteConversationWiringOptions,
): NativeRemoteConversationWiring {
  const conversation = ctx.conversation;
  let routeSequence = 0;
  let disposed = false;
  type PendingNativeAdmission = { readonly intake: NativeConversationIntakeActions; readonly sequence: number; request?: { readonly requestId: string; readonly inputId: string } };
  let nativePending: PendingNativeAdmission | undefined;
  const nativeMirrored = new Set<string>();
  // The waiting state a hosted turn shows is the orchestrator's own, driven on
  // the orchestrator's own cadence, see hosted-turn-activity.ts. Nothing in
  // the render loop has to know that hosted turns exist.
  const activity: HostedTurnActivity = createHostedTurnActivity({
    turnState: ctx.orchestrator,
    requestRender: options.render,
  });
  const clientId = `goodvibes-agent:${ctx.runtime.sessionId}`;
  /**
   * Put the daemon's authoritative transcript into this agent's session store
   * and move last-session.json onto it, so the conversation is resumable from
   * the surface that started it. Failures are reported, never thrown: a turn
   * that answered the person correctly must not look failed because the mirror
   * could not be written.
   */
  const mirrorHostedSession = async (
    hostedSessionId: string, current: () => boolean = () => !disposed,
    connection?: Extract<ConnectedHostResolution, { readonly baseUrl: string }>,
  ): Promise<void> => {
    if (!current()) return;
    const outcome = await mirrorHostedSessionToStore(hostedSessionId, {
      // A native completion never re-resolves a different host or token while
      // its asynchronous attachment is in flight.
      verbs: connection ? { async invoke<T>(method: string): Promise<T> {
        if (!current() || method !== 'sessions.hosted.attach') throw new Error('Native mirror selection changed');
        const response = await fetch(`${connection.baseUrl}/api/control-plane/methods/sessions.hosted.attach/invoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: { sessionId: hostedSessionId, clientId } }),
        });
        if (!current() || !response.ok) throw new Error('Native mirror attachment was not confirmed');
        const reply = await response.json() as HostedAttachReply;
        if (!current() || reply.session.id !== hostedSessionId) throw new Error('Native mirror identity changed');
        return reply as T;
      } } : ctx.services.daemonVerbs,
      clientId,
      persist: (sessionId, snapshot, model, provider, title) => {
        if (!current()) throw new Error('Hosted mirror selection changed');
        persistConversation(sessionId, snapshot, model, provider, title, { surface: ctx.services.surface }, 'auto');
      },
      fallbackModel: ctx.runtime.model,
      fallbackProvider: ctx.runtime.provider,
    });
    if (!outcome.mirrored && current()) logger.warn('[remote-conversation] a hosted conversation was not mirrored into the session store', {
      hostedSessionId, reason: outcome.reason,
    });
  };

  // The crash path, run once at install: a surface that died mid-turn was never
  // handed a completion, so nothing mirrored at turn end. The daemon still has
  // those transcripts. Fire-and-forget, a daemon that is slow or absent at
  // boot must not delay the shell coming up.
  void recoverUnmirroredHostedSessions({
    verbs: ctx.services.daemonVerbs,
    clientId,
    persist: (sessionId, snapshot, model, provider, title) => {
      persistConversation(sessionId, snapshot, model, provider, title, { surface: ctx.services.surface }, 'auto');
    },
    fallbackModel: ctx.runtime.model,
    fallbackProvider: ctx.runtime.provider,
    workspaceRoot: ctx.services.workingDirectory,
    knownSessionIds: () => {
      try {
        return ctx.services.sessionManager.list().map((info) => info.name);
      } catch {
        // An unreadable store means "nothing known", which is the safe answer:
        // it can only cause a re-mirror, never a lost conversation.
        return [];
      }
    },
  }).catch(() => undefined);

  const router = createRemoteConversationRouter({
    verbs: ctx.services.daemonVerbs,
    configManager: ctx.services.configManager,
    // The SAME resolution the verb caller uses, so this surface never calls one
    // daemon and streams from another.
    resolveConnection: () => ctx.services.resolveConnectedHost(),
    conversation,
    requestRender: options.render,
    // The hosted session's tools operate where this surface is working.
    workspaceRoot: ctx.services.workingDirectory,
    clientId,
    onCancellationNotice: (message) => { options.notify(message); options.render(); },
    onFrame: (frame: HostedSessionFrame) => {
      // Real counts only, and only once the daemon has sent any.
      if (frame.type === 'LLM_RESPONSE_RECEIVED') {
        const input = frame.payload?.['inputTokens'];
        const output = frame.payload?.['outputTokens'];
        activity.noteUsage(
          typeof input === 'number' ? input : 0,
          typeof output === 'number' ? output : 0,
        );
      }
      if (frame.type === 'TOOL_RECEIVED' || frame.type === 'TOOL_EXECUTING') {
        const tool = frame.payload?.['tool'];
        if (typeof tool === 'string') activity.noteTool(tool);
      } else if (frame.type === 'TOOL_SUCCEEDED' || frame.type === 'TOOL_FAILED') {
        activity.noteTool(null);
      }
      // Republish onto this process's own runtime bus, see
      // hosted-turn-bus-bridge.ts. Without this, a daemon-hosted turn never
      // fires TURN_SUBMITTED/STREAM_DELTA/TURN_COMPLETED locally, so anything
      // that only watches events.turns (spoken output today) stays silent for
      // it.
      bridgeHostedFrameOntoRuntimeBus(frame, {
        runtimeBus: ctx.runtimeBus,
        sessionId: ctx.runtime.sessionId,
        source: 'goodvibes-agent',
      });
      options.onFrame?.(frame);
    },
  });

  const detachedHandle = (): RoutedTurnHandle => ({
    hostedSessionId: router.hostedSessionId(),
    completion: Promise.resolve({ status: 'abandoned', response: '',
      error: 'This surface stopped observing the submission; its remote outcome is unconfirmed.', stopReason: 'observer_detached' }),
  });

  const report = (state: NativeConversationIntakeState | undefined): void => {
    for (const line of nativeConversationIntakeLines(state)) options.notify(line);
    options.render();
  };
  const observeNative = async (state: NativeConversationIntakeState, intake: NativeConversationIntakeActions): Promise<RoutedTurnHandle> => {
    const snapshot = state.hostedTurn;
    if (disposed || !state.hostedCurrent?.() || !snapshot || 'kind' in snapshot || !snapshot.sessionId
      || !snapshot.correlationId || !snapshot.brokerInputId || snapshot.state === 'preparing' || snapshot.state === 'recovery-required'
      || state.result?.kind !== 'turn' || !state.request) { activity.end(); return detachedHandle(); }
    const connection = ctx.services.resolveConnectedHost();
    if ('reason' in connection) { activity.end(); return detachedHandle(); }
    const current = () => !disposed && state.hostedCurrent?.() === true
      && sameNativeRemoteConnection(connection, ctx.services.resolveConnectedHost());
    const sequence = ++routeSequence;
    const request = { ...state.request };
    const key = JSON.stringify([connection, ctx.services.workingDirectory, snapshot.projectId, request.requestId, request.inputId, snapshot.sourceRevision]);
    // Render the original before opening catch-up. A complete fast reply can
    // arrive synchronously while the stream opens; it must follow its user.
    if (!nativeMirrored.has(key)) {
      nativeMirrored.add(key);
      conversation.addUserMessage(state.result.text);
    }
    activity.begin();
    if (disposed || sequence !== routeSequence || !current()) { if (sequence === routeSequence) activity.end(); return detachedHandle(); }
    const outcome = await router.observeNative(snapshot, async () => {
      if (!current()) throw new Error('Native selection changed');
      const result = await intake.cancel(request);
      if (!current() || !result || result.status === 'unknown' || result.status === 'unavailable'
        || !result.hostedTurn || 'kind' in result.hostedTurn) throw new Error('Native cancellation is unconfirmed');
      report(result);
    }, current);
    if (!outcome.routed) {
      if (sequence === routeSequence) activity.end();
      options.notify(outcome.reason); options.render();
      return detachedHandle();
    }
    const finish = (): void => {
      if (!current()) return;
      if (sequence === routeSequence) activity.end();
      if (current()) void mirrorHostedSession(outcome.hostedSessionId, current, connection);
    };
    void outcome.completion.then(finish, finish);
    return { hostedSessionId: outcome.hostedSessionId, completion: outcome.completion };
  };

  return {
    observeNative,
    routeNativeOrExplain: async (source, intake) => {
      if (disposed) return detachedHandle();
      if (ctx.services.configManager.get('hostedSessions.routeConversationTurns') === false) return null;
      if (nativePending) {
        options.notify('A native input is already pending. No second submission was created.');
        return detachedHandle();
      }
      if (!intake) {
        options.notify('Native conversation intake is unavailable. No legacy turn was started.');
        return detachedHandle();
      }
      const sequence = ++routeSequence;
      const pending: PendingNativeAdmission = { intake, sequence };
      nativePending = pending;
      try {
        // Own the operation before rendering: render callbacks may reenter
        // submission, Stop, or disposal synchronously.
        activity.begin();
        if (disposed || sequence !== routeSequence || nativePending !== pending) return detachedHandle();
        // Source was captured before model directives, shell context or file
        // expansion. The host alone captures a continuation's actual history.
        const state = await intake.submit(source, { delivery: 'hosted' });
        if (disposed || sequence !== routeSequence) return detachedHandle();
        if (state?.request) pending.request = { ...state.request };
        report(state);
        if (disposed || sequence !== routeSequence) return detachedHandle();
        if (state?.hostedTurn) return await observeNative(state, intake);
        activity.end();
        return detachedHandle();
      } catch {
        if (!disposed && sequence === routeSequence) {
          activity.end(); options.notify('Native delivery is unconfirmed. Inspect /work intake-status. No legacy turn was started.'); options.render();
        }
        return detachedHandle();
      } finally { if (nativePending === pending) nativePending = undefined; }
    },
    routeOrExplain: async (text: string, hasAttachments: boolean): Promise<RoutedTurnHandle | null> => {
      // Before the round trip, not after: the waiting state has to appear on
      // the keystroke. Opening or steering a hosted session is a network call,
      // and a shell that shows nothing until it returns reads as frozen.
      if (disposed) return detachedHandle();
      const sequence = ++routeSequence;
      activity.begin();
      const outcome = await router.submit(text, { hasAttachments });
      if (outcome.routed) {
        // Keep the original terminal mirror for superseded replies while the
        // surface is alive. Only the current generation may end its indicator.
        if (!disposed) {
          const finish = (): void => {
            if (disposed) return;
            if (sequence === routeSequence) activity.end();
            void mirrorHostedSession(outcome.hostedSessionId);
          };
          void outcome.completion.then(finish, finish);
        }
        if (disposed || sequence !== routeSequence) {
          return { hostedSessionId: outcome.hostedSessionId, completion: outcome.completion };
        }
        // The daemon's transcript is authoritative; this is the local mirror,
        // and the user's own message is the one part of it the stream does not
        // send back (the daemon received it directly).
        conversation.addUserMessage(text);
        options.render();
        return { hostedSessionId: outcome.hostedSessionId, completion: outcome.completion };
      }
      if (disposed || sequence !== routeSequence) return detachedHandle();
      // Not routed: the local turn owns the indicator from here.
      if (sequence === routeSequence) activity.end();
      if (outcome.cancelled) {
        options.notify(`[Stop] ${outcome.reason}`);
        options.render();
        return {
          hostedSessionId: router.hostedSessionId(),
          completion: Promise.resolve({ status: 'cancelled', response: '', error: outcome.reason, stopReason: 'cancelled_before_submission' }),
        };
      }
      // Never silent. A turn that ran somewhere other than where the settings
      // say it should is exactly what the person needs told, unless running
      // here is what they asked for, in which case there is nothing to report.
      if (!outcome.chosen) {
        options.notify(`[Turn] ${outcome.reason}`);
        options.render();
      }
      return null;
    },
    // A terminal can arrive before the submission HTTP reply. The router has
    // settled observation, but this controller still owns the shared indicator
    // until routeOrExplain receives that reply. Never abort the local runtime
    // merely because the hosted observer has already reached its terminal.
    cancelHostedTurn: () => {
      const pending = nativePending;
      const intake = pending?.intake;
      if (intake) {
        const sequence = ++routeSequence;
        nativePending = undefined;
        const cancellation = pending?.request ? intake.cancel(pending.request) : intake.stop ? intake.stop() : (intake.close(), Promise.resolve(undefined));
        void cancellation.then(async state => {
          if (disposed || sequence !== routeSequence) return;
          report(state);
          if (disposed || sequence !== routeSequence) return;
          if (state?.hostedTurn) await observeNative(state, intake);
          else activity.end();
        }, () => { if (!disposed) { activity.end(); options.notify('Native cancellation is unconfirmed. Inspect /work intake-status.'); options.render(); } });
        return true;
      }
      return router.cancelTurn() || activity.isActive();
    },
    hostedToolPreview: () => activity.toolPreview(),
    dispose: () => {
      disposed = true;
      routeSequence += 1;
      nativePending?.intake.close(); nativePending = undefined;
      activity.dispose();
      router.dispose();
    },
  };
}

/** Stop belongs to the hosted owner while it is admitting or observing a turn. */
export function cancelConversationGeneration(
  local: { readonly isThinking: boolean; abort(): void },
  remote: Pick<RemoteConversationWiring, 'cancelHostedTurn'>,
): void {
  if (remote.cancelHostedTurn()) return;
  if (local.isThinking) local.abort();
}
