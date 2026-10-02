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

import { createRemoteConversationRouter } from '../runtime/client/remote-conversation.ts';
import { mirrorHostedSessionToStore, recoverUnmirroredHostedSessions } from '../runtime/client/hosted-session-mirror.ts';
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

/** A turn the daemon accepted, and the way to wait for how it ended. */
export interface RoutedTurnHandle {
  readonly hostedSessionId: string | null;
  readonly completion: Promise<HostedTurnCompletion>;
}

export function installRemoteConversationRouting(
  ctx: BootstrapContext,
  options: RemoteConversationWiringOptions,
): RemoteConversationWiring {
  const conversation = ctx.conversation;
  let routeSequence = 0;
  let disposed = false;
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
  const mirrorHostedSession = async (hostedSessionId: string): Promise<void> => {
    const outcome = await mirrorHostedSessionToStore(hostedSessionId, {
      verbs: ctx.services.daemonVerbs,
      clientId,
      persist: (sessionId, snapshot, model, provider, title) => {
        persistConversation(sessionId, snapshot, model, provider, title, { surface: ctx.services.surface }, 'auto');
      },
      fallbackModel: ctx.runtime.model,
      fallbackProvider: ctx.runtime.provider,
    });
    if (!outcome.mirrored) {
      logger.warn('[remote-conversation] a hosted conversation was not mirrored into the session store', {
        hostedSessionId,
        reason: outcome.reason,
      });
    }
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

  return {
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
    cancelHostedTurn: () => router.cancelTurn() || activity.isActive(),
    hostedToolPreview: () => activity.toolPreview(),
    dispose: () => {
      disposed = true;
      routeSequence += 1;
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
