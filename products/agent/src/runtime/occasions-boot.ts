/**
 * occasions-boot.ts, both halves of the agent's occasion-nudge wiring, in one
 * call.
 *
 * Split out of bootstrap.ts at this repo's 800-line file cap, and the cut is a
 * good one independently: the two halves belong together and are only correct
 * together. The owner's ruling is Telegram AND the agent (docs/occasions.md
 * §4.2), which for this product means it is BOTH a push destination and the
 * surface that pulls, and a reader who found one without the other would
 * reasonably conclude the other was missing.
 *
 * ## The two halves, and why neither replaces the other
 *
 * **Push**, the daemon addresses a message to `agent` and the router calls this
 * product's sender, which lands it in the conversation. This is what reaches him
 * during the hours he is not sitting at the terminal.
 *
 * **Pull**, at a turn boundary the surface asks `occasions.pending` what is
 * outstanding and raises it. This is what covers everything the push could not:
 * `agent` configured with no sender registered, a send that failed, a nudge
 * raised while the process was not running.
 *
 * They cannot say the same thing twice, and the guard is neither half's: it is
 * the daemon's, over the ONE open item both read. A push that LANDS on the agent
 * stamps the item, and while the agent is a configured push destination the pull
 * leaves stamped items out. The condition is the push that LANDED rather than the
 * one that was configured, which is exactly why the pull is not redundant, and
 * why nothing in this file coordinates the two or keeps a local record of what
 * was pushed. A second ledger here would be a second answer to "has he already
 * been told", and the two would disagree the first time one missed a write.
 */

import type { ConfigManager } from '../config/index.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createOccasionsGatewayInvoke } from '../agent/occasions-gateway.ts';
import {
  installAgentConversationSender,
  type AgentDeliveryHost,
} from './agent-conversation-sender.ts';
import {
  createOccasionsNudgeSurface,
  type OccasionsNudgeSurface,
} from './occasions-nudge-surface.ts';

export interface OccasionsBootDeps {
  /** Owns the `agent` delivery destination the push half registers on. */
  readonly router: AgentDeliveryHost;
  /** This process's own verb catalog, when it carries the occasions handlers. */
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  /** The live transcript both halves land in. */
  readonly conversation: ConversationManager;
  readonly requestRender: () => void;
  /** Where the push registration's undo is filed, for shutdown. */
  readonly disposals: { push(undo: () => void): void };
}

/**
 * Wire the push destination and build the pull surface.
 *
 * Returns the pull surface because its caller owns WHEN it runs, bootstrap fires
 * it on the turn's completion, which is a decision about the transcript rather
 * than about occasions (see occasions-nudge-surface.ts on why the end of a turn
 * and not the start).
 */
export function installOccasionsNudging(deps: OccasionsBootDeps): OccasionsNudgeSurface {
  // The push half. Unconditional and NOT gated on `occasions.enabled`: this is a
  // general destination for anything the daemon addresses to `agent`, and the
  // occasions feature is one caller of it. Whether an occasion may be raised at
  // all is the daemon's decision, made before it ever reaches a sender.
  installAgentConversationSender({
    router: deps.router,
    disposals: deps.disposals,
    // Read per call, not captured: this runs before the session id is final, and
    // a captured reference would pin the conversation the process started with.
    primaryConversation: () => deps.conversation,
    requestRender: deps.requestRender,
  });

  // The pull half.
  return createOccasionsNudgeSurface({
    invoke: createOccasionsGatewayInvoke({
      gatewayMethods: deps.gatewayMethods,
      configManager: deps.configManager,
      homeDirectory: deps.homeDirectory,
    }),
    conversation: deps.conversation,
    requestRender: deps.requestRender,
    // The feature's own switch, read live so it is a real toggle. Not a rule:
    // every decision about whether an occasion may be raised stays in the daemon
    // and arrives only as the contents of `occasions.pending`.
    isEnabled: () => deps.configManager.get('occasions.enabled'),
  });
}
