/**
 * occasions-nudge-surface.ts, the Agent as one of the two channels a proactive
 * occasion nudge is delivered on.
 *
 * The owner's ruling (docs/occasions.md §4.2) names Telegram AND the agent, and
 * excludes the TUI in his own words: *"that's more of a 'get work done' kind of
 * interface."* The SDK enforces the exclusion structurally rather than by
 * convention, `resolveNudgeDestinations` drops a `tui` entry outright, keeping
 * the rest of the list, so this file is not free to reach the owner by pushing
 * at the terminal surface, and it does not try to.
 *
 * ## This is the PULL half. The push half is a peer, not a replacement
 *
 * The agent is both a push destination (runtime/agent-conversation-sender.ts,
 * registered on the router at bootstrap) and the surface that pulls. Both exist,
 * and the pull is not made redundant by the push: an item no push has ever landed
 * here is exactly what this path is for.
 *
 * The two cannot say the same thing twice, and the guard is not in this file. It
 * is in the daemon, over the ONE open item both paths read: a push that LANDS on
 * the agent stamps the item with the day it landed, and while the agent is a
 * configured push destination `occasions.pending` leaves stamped items out. The
 * condition is the push that landed, not the one that was configured, so `agent`
 * configured with no sender registered, and a send that failed, both leave the
 * item unstamped and still raised here. Neither may cost him the nudge.
 *
 * Nothing here coordinates with the sender, and there is deliberately no local
 * record of what was pushed: a second ledger would be a second answer to "has he
 * already been told", and the two would disagree the first time one missed a
 * write.
 *
 * ## How the pull works
 *
 * `occasions.pending` exists for this, and the SDK's own docstring on it says
 * what this module is: *"This is how a surface that is not a push destination
 * receives a nudge: it pulls what is open at the top of a turn rather than being
 * pushed at. A stored date is the prior scheduling that permits raising something
 * unprompted, which is what keeps this consistent with the agent being
 * conversation-first."*
 *
 * So there is no timer here, and that is deliberate. A wall-clock poll would
 * need a cadence, and a cadence here would be a second one competing with the
 * two settings §4.6 already gives the daemon for exactly that. Tying the pull to
 * a turn boundary instead means the daemon keeps every decision about WHEN
 * something may be raised, and this file only decides whether to say what the
 * daemon already decided is outstanding.
 *
 * Those two setting keys are deliberately not spelled out above. This repo has
 * no consumer for either, and naming them would put two permanently unverifiable
 * rows into the verification ledger's settings denominator, the decay
 * src/verification/settings-consumed-keys.ts exists to stop. `occasions.enabled`
 * below IS named, because the one line that reads it is right here.
 *
 * It also settles quiet hours (§4.7) without a local copy of them: the pull only
 * happens on a turn the owner himself just took, so there is no path by which
 * this speaks into a silent room at 3am. The push half is what reaches him during
 * the hours he is not here, and the daemon applies §4.7 to it before it ever
 * calls a sender.
 *
 * ## Why the end of the turn and not the start
 *
 * The pull is per turn either way. Saying it at the END is a rendering choice:
 * appending an assistant message while a response is still streaming interleaves
 * two voices in one transcript. This is the same placement the SDK's own
 * follow-up acknowledgements use, an assistant message after the turn settles.
 *
 * ## Why the daemon's words go in verbatim
 *
 * The nudge arrives already composed, and it is put in the transcript unchanged
 * rather than handed to the model to re-word. Two reasons, both structural:
 *
 *  - §4.3's rule is that a nudge never carries the date IN ANY FORM, "in 10
 *    days" is the date with arithmetic applied. The daemon chooses a proximity
 *    word from a day count that never leaves its own module, and the pending
 *    payload carries no date at all. Passing the sentence through cannot
 *    reintroduce one.
 *  - a gift-giving batch ASKS ("Do you want to sort something for it?") and a
 *    remember-only batch does not. That distinction is the daemon's
 *    (`composeNudge`'s `answerable`), and it is the difference between a question
 *    he can act on and a statement he cannot.
 *
 * The SDK's `OrchestratorFollowUpRuntime` was the other candidate, and it is the
 * right mechanism for what it does, turning a background milestone into a
 * model-written acknowledgement. It is the wrong one here: the prompt it builds
 * instructs the model "Do not ask questions" and "Do not call tools", which
 * would strip the ask out of every gift-giving nudge and block the interview the
 * answer opens. Suppressing the question while keeping the notification is half
 * a fix, so the composed message goes in as it is.
 *
 * ## What happens next is an ordinary conversation
 *
 * His reply is a normal turn. The `occasions` tool relays it, `answer` for
 * yes/no/later, the interview verbs for the short gift interview, and
 * `conflict.resolve` for a date conflict he has settled. Nothing in this file
 * interprets his words.
 */

import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { ConversationManager } from '../core/conversation.ts';
import {
  decideOccasionsRaises,
  occasionsRaiseLines,
  type OccasionsRaiseLedger,
} from '../agent/occasions-nudge.ts';
import type { OccasionsGatewayInvoke } from '../agent/occasions-gateway.ts';
import {
  OCCASIONS_METHOD_IDS,
  narrowOccasionsPending,
} from '../tools/agent-occasions-types.ts';

export interface OccasionsNudgeSurfaceDeps {
  /** The relay to the sixteen verbs. In-process when this build carries them. */
  readonly invoke: OccasionsGatewayInvoke;
  /** Where the raise lands: the live transcript, as the agent's own words. */
  readonly conversation: Pick<ConversationManager, 'addAssistantMessage'>;
  readonly requestRender: () => void;
  /**
   * The feature's own on/off switch (`occasions.enabled`), read LIVE on every
   * pull so it is a real toggle rather than a restart-only one.
   *
   * This is the switch, not a rule: no lead window, cadence, quiet-hour or
   * answer-expiry decision is made here or anywhere else in this repo. It is
   * read because the daemon's own enabled check governs whether NEW items are
   * raised, so an item opened before he turned the feature off would otherwise
   * keep being said by a surface that had not noticed.
   */
  readonly isEnabled: () => boolean;
}

export interface OccasionsNudgeSurface {
  /**
   * Pull what is outstanding and say anything not already said this session.
   *
   * Resolves to how many things were raised, so a caller can log or test it
   * without reading the transcript. Never throws: a daemon that is down, a verb
   * that is not invokable, or a payload this build cannot read must not break
   * the turn it rode in on.
   */
  readonly raiseNow: () => Promise<number>;
}

export function createOccasionsNudgeSurface(
  deps: OccasionsNudgeSurfaceDeps,
): OccasionsNudgeSurface {
  // Bounded by the occasions declared, and pruned to what the last answer
  // carried, see occasions-nudge.ts on why this is render de-duplication and
  // not suppression policy.
  let ledger: OccasionsRaiseLedger = new Map<string, string>();

  const raiseNow = async (): Promise<number> => {
    if (!deps.isEnabled()) return 0;

    const result = await deps.invoke(OCCASIONS_METHOD_IDS.pending, {});
    if (!result.ok) {
      // Debug, not warn: with no daemon reachable this is the ordinary state of
      // a surface that has nothing to pull from, and a per-turn warn would be
      // noise. Nothing about an occasion is logged at any level either way,
      // this whole subject is closed tier.
      logger.debug('occasions: pending pull failed', {
        route: result.route,
        error: result.error ?? 'no reason given',
      });
      return 0;
    }

    const pending = narrowOccasionsPending(result.data);
    if (pending === null) {
      logger.debug('occasions: pending answer was not a shape this build reads');
      return 0;
    }

    const decision = decideOccasionsRaises(pending, ledger);
    ledger = decision.ledger;
    const lines = occasionsRaiseLines(decision.raises);
    if (lines.length === 0) return 0;

    // One message per outstanding thing rather than one joined blob: the daemon
    // has already batched several occasions inside ONE nudge message (§6), so a
    // second level of joining here would glue that batch to an unrelated
    // conflict and to an interview question, and he would have three subjects in
    // one paragraph to answer at once.
    for (const line of lines) deps.conversation.addAssistantMessage(line);
    deps.requestRender();
    return lines.length;
  };

  return {
    raiseNow: async (): Promise<number> => {
      try {
        return await raiseNow();
      } catch (error) {
        logger.debug('occasions: raise failed', { error: summarizeError(error) });
        return 0;
      }
    },
  };
}
