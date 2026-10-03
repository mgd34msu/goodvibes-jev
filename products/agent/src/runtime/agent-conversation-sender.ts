/**
 * agent-conversation-sender.ts, this product as a PUSH destination for the
 * daemon.
 *
 * The SDK owns the destination and the contract: `agent` is a channel-delivery
 * surface kind, a strategy in the router claims targets addressed to it, and
 * `AgentConversationMessage` is the shape it hands over
 * (platform/channels/delivery/strategies-agent.ts). What it cannot own is the
 * landing, putting a message in an agent conversation means taking a turn inside
 * this process, so this file is the callable the router calls, registered
 * through `ChannelDeliveryRouter.agentDelivery`.
 *
 * ## Push AND pull, and one thing said once
 *
 * The owner's ruling is Telegram AND the agent (docs/occasions.md §4.2), so this
 * product is both a push destination and the surface that pulls
 * `occasions.pending` at a turn boundary (runtime/occasions-nudge-surface.ts).
 * Both paths exist and neither replaces the other.
 *
 * They cannot say the same thing twice, and the guard is not here: it is in the
 * daemon, over the one open item both paths read. A push that LANDS on the agent
 * stamps the item with the day it landed, and while the agent is a configured
 * push destination the pull leaves stamped items out. The condition is the push
 * that landed rather than the one that was configured, an item no push ever
 * landed here carries no stamp and still comes back through the pull, which is
 * what covers `agent` configured with no sender registered and a send that
 * failed. Neither of those may cost him the nudge.
 *
 * So there is nothing to coordinate in this file, and deliberately no local
 * record of what was pushed. A second ledger here would be a second answer to
 * "has he already been told", and the two would disagree the first time one of
 * them missed a write.
 *
 * ## The body goes in unaltered, and the title does not go in at all
 *
 * `addAssistantMessage(message.body)`, the same verbatim path the pull uses, for
 * the same reason. §4.3's rule is that a nudge never carries the date in any
 * form, the daemon composes the sentence from a day count that never leaves its
 * own module, and a surface that rewrote or decorated it would be re-deciding
 * that with worse information.
 *
 * The title is metadata and is NOT prepended. For an occasion push it is generic
 * scaffolding ("A date is coming up") while the body is the composed sentence
 * that already names the occasion and asks the question; prefixing it would put
 * words in the assistant's mouth that nothing composed. It is carried into the
 * debug line instead, which is where a caller looking for "what did the daemon
 * send" should find it.
 */

import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type {
  AgentConversationMessage,
  AgentConversationSender,
} from '@goodvibes-jev/engine/sdk/platform/channels';
import type { ConversationManager } from '../core/conversation.ts';
import { findSessionConversation } from './conversation-rewind-port.ts';

/** The landing surface: one conversation, and a render request after it. */
export type AgentSenderConversation = Pick<ConversationManager, 'addAssistantMessage'>;

export interface AgentConversationSenderDeps {
  /**
   * The conversation a message with no address lands in, this process's active
   * one. Read through a function rather than captured, because bootstrap wires
   * the sender before the session id is final and a captured reference would pin
   * the conversation this process started with.
   */
  readonly primaryConversation: () => AgentSenderConversation | null;
  /**
   * Resolve an addressed conversation. Defaults to the live per-session registry
   * the daemon's own rewind verbs resolve through, so a push and a rewind cannot
   * disagree about which conversation a session id means.
   */
  readonly resolveConversation?: ((id: string) => AgentSenderConversation | null) | undefined;
  readonly requestRender: () => void;
}

/** Names this implementation in the router's logs and in a takeover refusal. */
export const AGENT_CONVERSATION_SENDER_ID = 'goodvibes-agent:conversation';

export function createAgentConversationSender(
  deps: AgentConversationSenderDeps,
): AgentConversationSender {
  const resolve = deps.resolveConversation ?? findSessionConversation;

  /**
   * Which conversation this message is for.
   *
   * The same resolution order the SDK strategy already applied to build the
   * message: what the caller addressed, then the session it belongs to, then this
   * process's active conversation. An addressed id that resolves to nothing does
   * NOT silently fall back, see the throw below.
   */
  const conversationFor = (
    message: AgentConversationMessage,
  ): { readonly conversation: AgentSenderConversation; readonly addressed: string | null } | string => {
    for (const addressed of [message.conversationId, message.sessionId]) {
      const id = (addressed ?? '').trim();
      if (id.length === 0) continue;
      const found = resolve(id);
      if (found !== null) return { conversation: found, addressed: id };
      // Addressed somewhere this process does not have. Falling back to the
      // active conversation would put a message meant for one conversation into
      // another, and the daemon would record it as delivered, so this is a
      // failure, and the router reports it against the surface and strategy.
      return `This runtime has no live conversation "${id}" to land a message in.`;
    }
    const primary = deps.primaryConversation();
    if (primary === null) {
      return 'This runtime has no active conversation to land a message in yet.';
    }
    return { conversation: primary, addressed: null };
  };

  return {
    id: AGENT_CONVERSATION_SENDER_ID,
    send: async (message: AgentConversationMessage): Promise<string | undefined> => {
      const target = conversationFor(message);
      // Throwing is the contract's honest answer: the router logs the surface,
      // the strategy and the reason, and the caller is told rather than left with
      // a message that went nowhere. The occasions sweep additionally records the
      // failure per destination, and, because nothing landed, leaves the open
      // item unstamped so the pull still raises it.
      if (typeof target === 'string') throw new Error(target);

      target.conversation.addAssistantMessage(message.body);
      deps.requestRender();
      // Counts and ids only. The body is not logged at any level: a push
      // addressed here can carry closed-tier content (an occasion nudge names a
      // family member), and this is the one place it passes through.
      logger.debug('agent conversation: push landed', {
        title: message.title,
        jobId: message.jobId,
        runId: message.runId,
        addressed: target.addressed ?? 'primary',
      });
      // No id: this transcript has no stable per-message identifier to hand
      // back, and inventing one would make a delivery receipt point at nothing.
      // The SDK strategy falls back to the conversation id it resolved.
      return undefined;
    },
  };
}

/** Just enough of the router to own the destination. */
export interface AgentDeliveryHost {
  readonly agentDelivery: {
    register(sender: AgentConversationSender, options?: { readonly replace?: boolean }): () => void;
  };
}

export interface InstallAgentConversationSenderDeps extends AgentConversationSenderDeps {
  readonly router: AgentDeliveryHost;
  /** Where the undo is filed, so shutdown releases the destination. */
  readonly disposals: { push(undo: () => void): void };
}

/**
 * Register this product as the agent push destination, and file the undo.
 *
 * A named function rather than three lines inline in bootstrap, because bootstrap
 * itself cannot be driven from a test, it needs a terminal, and "the sender is
 * registered at startup, and released at shutdown" is exactly the property worth
 * pinning. Inline, the only available check would have been reading the source.
 */
export function installAgentConversationSender(
  deps: InstallAgentConversationSenderDeps,
): AgentConversationSender {
  const sender = createAgentConversationSender({
    primaryConversation: deps.primaryConversation,
    ...(deps.resolveConversation === undefined ? {} : { resolveConversation: deps.resolveConversation }),
    requestRender: deps.requestRender,
  });
  // A stale sender pointing at a torn-down conversation would accept a push and
  // drop it, so the undo is filed at the same moment the registration happens
  // rather than left to a shutdown path to remember.
  deps.disposals.push(deps.router.agentDelivery.register(sender));
  return sender;
}
