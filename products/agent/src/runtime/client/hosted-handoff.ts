/**
 * hosted-handoff.ts, handing an inbound channel conversation to the daemon to
 * host, instead of answering it inside this process.
 *
 * ── What this changes ──────────────────────────────────────────────────────
 *
 * A message that arrives on Telegram, Slack, email or any other channel reaches
 * this process as a shared-session continuation (client/session-inputs.ts polls
 * `sessions.inputs.list`; the SDK's wire dispatch hands each one to the bound
 * continuation runner). The runner's answer has always been the same: spawn an
 * agent HERE. That answer ends when this process ends.
 *
 * The daemon can now host a full conversation loop, the same orchestrator,
 * tool registry and permission gate this process runs, composed on the other
 * side of the wire. So the runner gains a second answer: hand the conversation
 * over. The first message of a conversation creates the hosted session with the
 * owner's own words as its opening prompt; every later message for the same
 * conversation is steered into it with the ordinary `sessions.steer`, which
 * resolves a hosted session's id exactly as it resolves any other.
 *
 * ── Off by default, and it means it ────────────────────────────────────────
 *
 * `hostedSessions.promoteInboundConversations` is read on EVERY continuation,
 * never captured at construction: turning it on or off takes effect on the next
 * inbound message rather than the next restart. Off is the shipped default and
 * the behavior everyone already has, the message is answered by the process
 * that received it.
 *
 * ── What promotion does NOT change ────────────────────────────────────────
 *
 * The conversation-first gate governs whether a local spawn opens a
 * write-review-fix-confirm chain for an inbound message. A promoted
 * conversation opens no chain to gate: it is the ordinary conversation loop,
 * answering the owner. What its tools may do is decided by the daemon's own
 * permission manager, which raises asks the same way, onto the shared record
 * every surface reads, including this one's approvals list.
 *
 * So promotion moves where the conversation is answered. It does not move a
 * decision about whether work was authorized, because the thing that decision
 * gates does not happen on this path.
 *
 * ── A refusal is a value, and the fallback is always the local answer ──────
 *
 * Nothing here throws into the dispatch poller. Every reason a conversation
 * could not be handed over, the setting is off, no daemon is resolvable, the
 * workspace root is not absolute, the daemon refused with its cap reached, the
 * hosted session had been killed, comes back as a stated reason, and the
 * caller answers the message locally exactly as it did before. A promotion that
 * cannot happen must never cost the owner their message.
 *
 * The one case that gets a second try is a mapping that has gone stale: a
 * hosted session that was killed, retired or lost to a restart answers a steer
 * with 404/409, and this re-creates the conversation with the message in hand
 * as its opening prompt rather than reporting a failure for work that can still
 * be done.
 */
import { isAbsolute } from 'node:path';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import type { HostedSessionRecord } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ConnectedHostVerbError, describeConnectedHostVerbError } from './daemon-verbs.ts';

/** How many characters of the owner's message become the hosted session's title. */
const TITLE_LENGTH = 60;

/** The reason string a caller can recognise without string-matching prose. */
export const PROMOTION_DISABLED_REASON =
  'hostedSessions.promoteInboundConversations is off, so this conversation is answered in this process.';

/** What one attempt to hand a conversation over came to. */
export type HostedHandoffOutcome =
  | {
    readonly promoted: true;
    /** The daemon-hosted session now carrying the conversation. */
    readonly hostedSessionId: string;
    /** `created` for the first message of a conversation, `steered` for every later one. */
    readonly action: 'created' | 'steered' | 'recreated';
  }
  | {
    readonly promoted: false;
    /** Why, in the words of whatever refused, never a sentence invented here. */
    readonly reason: string;
    /** True only for the shipped-off setting, so a caller can stay quiet about it. */
    readonly disabled: boolean;
  };

/** One inbound continuation, as much of it as a handoff needs. */
export interface HostedHandoffRequest {
  /** The shared session the message arrived for. */
  readonly sessionId: string;
  /** The enriched continuation task the broker built. */
  readonly task: string;
  /** The owner's own words, which is what a hosted session should open with. */
  readonly body: string;
  /** The channel the message came from, carried through to the steer. */
  readonly surfaceKind?: string | undefined;
  readonly surfaceId?: string | undefined;
  /** A human label for the conversation, when the channel supplied one. */
  readonly displayName?: string | undefined;
}

export interface HostedConversationHandoff {
  /** Try to hand this continuation to a daemon-hosted session. Never throws. */
  promote(request: HostedHandoffRequest): Promise<HostedHandoffOutcome>;
  /** The hosted session a shared session was handed to, or null. */
  hostedIdFor(sessionId: string): string | null;
  /** Forget a mapping (the conversation ended, or the session was killed). */
  forget(sessionId: string): void;
  /** Every mapping this process holds, for disclosure and for tests. */
  entries(): readonly { readonly sessionId: string; readonly hostedSessionId: string }[];
}

export interface HostedConversationHandoffOptions {
  readonly verbs: DaemonVerbCaller;
  /**
   * Read fresh per continuation, `hostedSessions.promoteInboundConversations`.
   * A capture would make the setting a restart-only key, which it is not.
   */
  readonly isEnabled: () => boolean;
  /**
   * The absolute workspace root a promoted conversation's tools operate in.
   * A relative path is refused rather than sent: the daemon would resolve it
   * against its OWN directory, which is never what this process meant.
   */
  readonly workspaceRoot: () => string;
  /** This process's identity on the daemon, so the hosted session knows who attached. */
  readonly clientId: string;
  readonly log?: Pick<typeof logger, 'debug' | 'info' | 'warn'> | undefined;
}

/** The `sessions.hosted.create` reply, as much of it as this reads. */
interface HostedCreateReply {
  readonly session?: Partial<HostedSessionRecord> | undefined;
}

/** A short label from the owner's own words, so the session list reads like the conversation. */
export function hostedSessionTitle(request: HostedHandoffRequest): string {
  const source = request.body.trim().length > 0 ? request.body.trim() : request.task.trim();
  const oneLine = source.replace(/\s+/g, ' ').trim();
  const label = oneLine.length > TITLE_LENGTH ? `${oneLine.slice(0, TITLE_LENGTH - 1)}…` : oneLine;
  const channel = request.displayName?.trim() ?? request.surfaceKind?.trim() ?? '';
  if (label.length === 0) return channel.length > 0 ? `${channel} conversation` : 'Inbound conversation';
  return channel.length > 0 ? `${channel}: ${label}` : label;
}

/**
 * Whether a steer failure means "that hosted session is not there any more"
 * rather than "the daemon could not do this right now".
 *
 * 404 is the engine's own not-found; 409 is its "the session exists and here is
 * why it cannot serve you", which for a terminated session is permanent. Both
 * are answered by starting the conversation again; a 429 (the cap) or a 5xx is
 * not, and must not silently mint a second session.
 */
function isStaleHostedSession(error: unknown): boolean {
  return error instanceof ConnectedHostVerbError && (error.status === 404 || error.status === 409);
}

export function createHostedConversationHandoff(
  options: HostedConversationHandoffOptions,
): HostedConversationHandoff {
  const log = options.log ?? logger;
  /** shared session id -> the daemon-hosted session carrying that conversation. */
  const promoted = new Map<string, string>();

  const refuse = (reason: string): HostedHandoffOutcome => ({ promoted: false, reason, disabled: false });

  const createHosted = async (
    request: HostedHandoffRequest,
    workspaceRoot: string,
    action: 'created' | 'recreated',
  ): Promise<HostedHandoffOutcome> => {
    const reply = await options.verbs.invoke<HostedCreateReply>('sessions.hosted.create', {
      workspaceRoot,
      title: hostedSessionTitle(request),
      // The owner's words open the conversation, not the broker's enriched
      // continuation framing, a hosted session that opens with the framing
      // reads as a work order for a message that was a sentence.
      initialPrompt: request.body.trim().length > 0 ? request.body : request.task,
      clientId: options.clientId,
    });
    const hostedSessionId = reply?.session?.id;
    if (typeof hostedSessionId !== 'string' || hostedSessionId.length === 0) {
      // A reply this build cannot read is a real answer about the host, not a
      // promotion: say so and let the message be answered locally.
      return refuse('the connected host accepted sessions.hosted.create but returned no session id this build could read.');
    }
    promoted.set(request.sessionId, hostedSessionId);
    log.info('[hosted handoff] an inbound conversation is now hosted by the daemon', {
      sessionId: request.sessionId,
      hostedSessionId,
      action,
    });
    return { promoted: true, hostedSessionId, action };
  };

  return {
    hostedIdFor: (sessionId: string): string | null => promoted.get(sessionId) ?? null,

    forget: (sessionId: string): void => {
      promoted.delete(sessionId);
    },

    entries: () => [...promoted].map(([sessionId, hostedSessionId]) => ({ sessionId, hostedSessionId })),

    async promote(request: HostedHandoffRequest): Promise<HostedHandoffOutcome> {
      if (!options.isEnabled()) {
        return { promoted: false, reason: PROMOTION_DISABLED_REASON, disabled: true };
      }
      const reachability = options.verbs.probe();
      if (!reachability.available) {
        return refuse(reachability.reason ?? 'no connected host could be resolved.');
      }
      const workspaceRoot = options.workspaceRoot();
      if (!workspaceRoot || !isAbsolute(workspaceRoot)) {
        return refuse(
          `the workspace root for a hosted conversation must be an absolute path; this process resolved '${workspaceRoot}'.`,
        );
      }

      const existing = promoted.get(request.sessionId);
      if (existing === undefined) {
        try {
          return await createHosted(request, workspaceRoot, 'created');
        } catch (error) {
          return refuse(describeConnectedHostVerbError(error));
        }
      }

      try {
        await options.verbs.invoke<unknown>('sessions.steer', {
          sessionId: existing,
          body: request.body.trim().length > 0 ? request.body : request.task,
          ...(request.surfaceKind ? { surfaceKind: request.surfaceKind } : {}),
          ...(request.surfaceId ? { surfaceId: request.surfaceId } : {}),
        });
        return { promoted: true, hostedSessionId: existing, action: 'steered' };
      } catch (error) {
        if (!isStaleHostedSession(error)) {
          return refuse(describeConnectedHostVerbError(error));
        }
        // The conversation's hosted session is gone. Start it again with the
        // message in hand rather than losing the message to a dead mapping.
        promoted.delete(request.sessionId);
        log.info('[hosted handoff] the hosted session for this conversation is gone; starting a new one', {
          sessionId: request.sessionId,
          previousHostedSessionId: existing,
          reason: describeConnectedHostVerbError(error),
        });
        try {
          return await createHosted(request, workspaceRoot, 'recreated');
        } catch (recreateError) {
          return refuse(describeConnectedHostVerbError(recreateError));
        }
      }
    },
  };
}
