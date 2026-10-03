/**
 * hosted-session-mirror.ts, putting a daemon-hosted conversation into the
 * agent's own session store.
 *
 * The gap this closes: an evening's conversation ran as a hosted session and
 * NEVER landed in `sessions/`. It existed only as a preview-grade recovery
 * journal (tool results truncated to ~100 characters) plus the daemon-side
 * record, and `sessions/last-session.json` still pointed at an OLDER local
 * session, so resuming would have opened the wrong conversation and the real
 * one was unreachable from the surface that started it.
 *
 * Why it was missing: a local turn is persisted off `TURN_COMPLETED`
 * (shell/startup-wiring.ts), and a hosted turn emits no local `TURN_COMPLETED`
 *, its turn runs daemon-side. Every durable-write path hung off an event that
 * hosted conversations never fire.
 *
 * Where the content comes from: the DAEMON's record is authoritative, not this
 * process's screen mirror. `sessions.hosted.attach` returns the transcript the
 * daemon actually holds, which is also the only source that still exists after
 * this process has crashed, which is exactly when the mirror matters most.
 * That makes one function serve both moments the brief names: completion (the
 * conversation is finished and belongs in the store) and reconnect (this
 * process died mid-turn and is now catching up on what happened without it).
 */
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

/** The daemon's history row shape (platform/hosted-sessions HostedSessionHistoryMessage). */
export interface HostedHistoryMessage {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly at?: number;
}

/** The subset of the daemon's hosted record this mirror reads. */
export interface HostedAttachedSession {
  readonly id: string;
  readonly title?: string | undefined;
  readonly modelId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly messageCount?: number | undefined;
}

/** `sessions.hosted.attach` reply. */
export interface HostedAttachReply {
  readonly session: HostedAttachedSession;
  readonly history: readonly HostedHistoryMessage[];
}

export interface HostedSessionMirrorDeps {
  readonly verbs: { invoke<T>(method: string, input?: unknown): Promise<T> };
  /** Identifies this surface to the daemon on attach. */
  readonly clientId: string;
  /**
   * Writes the conversation to the agent's session store AND moves
   * last-session.json onto it, the SDK's `persistConversation`.
   */
  readonly persist: (
    sessionId: string,
    snapshot: { messages: Array<Record<string, unknown>>; timestamp?: number; title?: string },
    model: string,
    provider: string,
    title?: string,
  ) => void;
  readonly fallbackModel: string;
  readonly fallbackProvider: string;
  readonly now?: () => number;
}

export type HostedMirrorOutcome =
  | { readonly mirrored: true; readonly sessionId: string; readonly messageCount: number }
  | { readonly mirrored: false; readonly reason: string };

/**
 * Convert the daemon's history into the store's message shape.
 *
 * Tool rows are kept rather than dropped, but the daemon's history does not
 * carry the tool-call id that a locally-recorded tool result has, so the mirror
 * synthesizes a positional one. That is stated here rather than hidden: the
 * content is faithful, the correlation id is not the original.
 */
export function hostedHistoryToStoreMessages(
  history: readonly HostedHistoryMessage[],
): Array<Record<string, unknown>> {
  return history.map((message, index) => {
    if (message.role === 'tool') {
      return { role: 'tool', callId: `hosted-${index}`, content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * Pull a hosted session's authoritative transcript and write it into the
 * agent's session store, moving the last-session pointer onto it.
 *
 * Never throws: this runs from a turn-completion callback and from boot, and
 * neither is a place where a mirroring failure may take down the surface. A
 * failure is logged and reported in the outcome so a caller can say so.
 */
export async function mirrorHostedSessionToStore(
  sessionId: string,
  deps: HostedSessionMirrorDeps,
): Promise<HostedMirrorOutcome> {
  let reply: HostedAttachReply;
  try {
    reply = await deps.verbs.invoke<HostedAttachReply>('sessions.hosted.attach', {
      sessionId,
      clientId: deps.clientId,
    });
  } catch (error) {
    const reason = `the connected host would not hand back hosted session ${sessionId}, ${summarizeError(error)}`;
    logger.warn('[hosted-mirror] could not read the hosted transcript to mirror it', { sessionId, error: summarizeError(error) });
    return { mirrored: false, reason };
  }

  const history = reply?.history ?? [];
  if (history.length === 0) {
    // Writing an empty conversation over the store would be worse than not
    // writing: it would move the last-session pointer onto nothing.
    return { mirrored: false, reason: `hosted session ${sessionId} has no transcript to mirror` };
  }

  const messages = hostedHistoryToStoreMessages(history);
  const title = reply.session?.title ?? '';
  try {
    deps.persist(
      sessionId,
      { messages, timestamp: (deps.now ?? Date.now)(), ...(title ? { title } : {}) },
      reply.session?.modelId ?? deps.fallbackModel,
      reply.session?.providerId ?? deps.fallbackProvider,
      title,
    );
  } catch (error) {
    const reason = `writing hosted session ${sessionId} to the session store failed, ${summarizeError(error)}`;
    logger.warn('[hosted-mirror] persisting the mirrored hosted session failed', { sessionId, error: summarizeError(error) });
    return { mirrored: false, reason };
  }

  logger.info('[hosted-mirror] mirrored a hosted conversation into the session store', {
    sessionId,
    messageCount: messages.length,
  });
  return { mirrored: true, sessionId, messageCount: messages.length };
}

/** `sessions.hosted.list` reply. */
export interface HostedListReply {
  readonly sessions: readonly (HostedAttachedSession & { readonly workspaceRoot?: string | undefined })[];
}

export interface HostedRecoveryDeps extends HostedSessionMirrorDeps {
  /** Only sessions for the workspace this surface is working in are recovered. */
  readonly workspaceRoot: string;
  /** Session ids the agent's own store already holds. */
  readonly knownSessionIds: () => readonly string[];
  /** Bound on how many orphans one boot will pull back. */
  readonly maxRecovered?: number;
}

/** Default bound on a single boot's recovery pass. */
export const DEFAULT_MAX_RECOVERED_HOSTED_SESSIONS = 5;

/**
 * Boot-time recovery for the CRASH path.
 *
 * Completion-time mirroring cannot cover the case that actually lost the
 * conversation: the surface died mid-turn, so no completion was ever delivered
 * to it and no callback ran. On the next start the daemon still holds the
 * transcript, and this pass is what goes and gets it, any hosted session for
 * this workspace that the agent's own store has never heard of is pulled in and
 * becomes resumable, newest last so the last-session pointer ends up on the
 * most recent conversation.
 *
 * Bounded and quiet: at most `maxRecovered` sessions per boot, sessions with no
 * transcript skipped, and every failure logged rather than thrown, a daemon
 * that is not reachable at boot must not stop the agent from starting.
 */
export async function recoverUnmirroredHostedSessions(
  deps: HostedRecoveryDeps,
): Promise<readonly HostedMirrorOutcome[]> {
  let reply: HostedListReply;
  try {
    reply = await deps.verbs.invoke<HostedListReply>('sessions.hosted.list', {});
  } catch (error) {
    logger.debug('[hosted-mirror] could not list hosted sessions at boot', { error: summarizeError(error) });
    return [];
  }

  const known = new Set(deps.knownSessionIds());
  const candidates = (reply?.sessions ?? []).filter((session) =>
    session.workspaceRoot === deps.workspaceRoot
    && !known.has(session.id)
    && (session.messageCount ?? 0) > 0);
  if (candidates.length === 0) return [];

  const limit = deps.maxRecovered ?? DEFAULT_MAX_RECOVERED_HOSTED_SESSIONS;
  // Oldest first, so the newest mirrored session is the one the last-session
  // pointer is left on.
  const selected = candidates.slice(-limit);
  const outcomes: HostedMirrorOutcome[] = [];
  for (const session of selected) {
    outcomes.push(await mirrorHostedSessionToStore(session.id, deps));
  }
  const recovered = outcomes.filter((outcome) => outcome.mirrored).length;
  if (recovered > 0) {
    // Disclose, never silent: these conversations appeared without the user
    // doing anything, and the reason is that a previous run did not survive.
    logger.info('[hosted-mirror] recovered hosted conversations a previous run never stored', {
      recovered,
      considered: candidates.length,
    });
  }
  return outcomes;
}
