/**
 * occasions-nudge.ts, which outstanding occasions have not yet been put to him
 * in this session, and the exact words to say.
 *
 * Pure by construction: it is handed one `occasions.pending` answer and what has
 * already been raised, and it decides only WHICH items to say and in what order.
 * It reads no clock, performs no IO, and computes nothing about a date.
 *
 * ## Every string here came from the daemon
 *
 * `nudge.message`, a conflict's `message` and an interview step's `prompt` are
 * carried through VERBATIM. Nothing in this file composes, paraphrases,
 * summarises or re-orders the words inside a message.
 *
 * That is not stylistic. docs/occasions.md §4.3 is stronger than "do not print
 * the date": *"in 10 days" is the date with arithmetic applied*, so the daemon
 * chooses a proximity WORD from a day count that never leaves `occasions/nudge.ts`
 * and there is no code path from an occurrence date to a rendered nudge. The
 * pending payload deliberately carries no date at all, so a surface that passes
 * the composed message through unchanged cannot reintroduce one, and a surface
 * that rewrote it would be re-implementing §4.3's decision with worse
 * information. §7 says the same thing about the whole feature: a consumer that
 * computed anything beyond calling these verbs and rendering the answers is a
 * second implementation of a rule that lives in the daemon.
 *
 * The same passthrough is why a gift-giving nudge still ASKS. The daemon appends
 * "Do you want to sort something for it?" only for a batch containing a
 * gift-giving occasion (`composeNudge`'s `answerable`), and a remember-only batch
 * is a statement. Offering an answer to a statement invites an answer that means
 * nothing, and dropping the ask from a question leaves him a notification he
 * cannot act on. Neither happens if the message is not touched.
 *
 * ## What "already raised" is, and what it is not
 *
 * It is NOT suppression policy. Whether an occasion may be raised at all, how
 * often, whether the hour is a quiet one, when a `later` comes back, and when a
 * declined occasion asks fresh next year are all decided by the daemon
 * (occasions/sweep.ts, occasions/cadence.ts) and reached only through
 * `occasions.pending`, which returns what is outstanding and nothing else.
 *
 * This is de-duplication of a RENDER: `occasions.pending` keeps answering with
 * the same open item until it is resolved, so a surface that re-read it would
 * repeat itself within one session. Each stream is therefore keyed by the
 * daemon's OWN id for what is outstanding, the nudge's id, the conflict's
 * occasion id, the interview's step id, so "has this already been said" is
 * answered by the daemon's identity for the thing, never by a timer of ours. The
 * ledger is pruned to the streams still present in the answer, so it is bounded
 * by the number of occasions declared rather than by how long the session runs.
 */

import type {
  OccasionsPendingResponse,
} from '../tools/agent-occasions-types.ts';

/**
 * One thing to say, and the ledger entry that records having said it.
 *
 * `text` is the daemon's own wording. `stream`/`token` are the daemon's own ids
 * for what is outstanding, see the note above on why identity comes from there.
 */
export interface OccasionsRaise {
  readonly kind: 'nudge' | 'conflict' | 'interview';
  /** Stable per outstanding thing: `nudge`, `conflict:<occasionId>`, `interview:<id>`. */
  readonly stream: string;
  /** The daemon's id for THIS state of that thing. A new token means new words. */
  readonly token: string;
  /** Exactly what the daemon said. Never rewritten here. */
  readonly text: string;
  /** True when a yes/no/later answer is invited. From the daemon, never inferred. */
  readonly answerable: boolean;
  /** The occasion this concerns, for the tool call his answer turns into. */
  readonly occasionId: string;
  /** Set for an interview raise, so the answer can be recorded against the step. */
  readonly interviewId?: string;
  readonly stepId?: string;
}

/** What has already been put to him, by stream. Bounded by the occasions declared. */
export type OccasionsRaiseLedger = ReadonlyMap<string, string>;

export interface OccasionsRaiseDecision {
  /** In the order they should be said. Empty when there is nothing new. */
  readonly raises: readonly OccasionsRaise[];
  /**
   * The ledger to keep. Already pruned to the streams this answer still carries,
   * so a resolved occasion's entry is dropped rather than remembered forever.
   */
  readonly ledger: OccasionsRaiseLedger;
}

const EMPTY_DECISION: OccasionsRaiseDecision = { raises: [], ledger: new Map() };

/**
 * Everything outstanding that has not already been said, in the order to say it.
 *
 * Order: the batched nudge first, then conflicts, then interviews. A conflict is
 * a fact about the record he can fix in one sentence, and an interview is a
 * thread he is already inside, putting the interview question before the nudge
 * that opened it would read backwards.
 */
export function decideOccasionsRaises(
  pending: OccasionsPendingResponse,
  ledger: OccasionsRaiseLedger,
): OccasionsRaiseDecision {
  const candidates: OccasionsRaise[] = [];

  const nudge = pending.nudge;
  if (nudge !== null && nudge.message.trim().length > 0) {
    candidates.push({
      kind: 'nudge',
      stream: 'nudge',
      // The daemon ids a pending batch per day, so the same open batch read
      // twice in one day is one raise and tomorrow's is another. That cadence
      // belongs to the daemon; this only reads the id it chose.
      token: nudge.id,
      text: nudge.message,
      answerable: nudge.answerable,
      // A batch can name several occasions. The first subject is the one an
      // unqualified "yes" is about; the model has the whole batch in the message
      // and asks him which when there is more than one.
      occasionId: nudge.subjects[0]?.occasionId ?? '',
    });
  }

  for (const conflict of pending.conflicts) {
    if (conflict.message.trim().length === 0) continue;
    candidates.push({
      kind: 'conflict',
      stream: `conflict:${conflict.occasionId}`,
      // A conflict's words do not change while it is open, so its own id is the
      // token: re-raising is the daemon's decision (it keeps the open item due),
      // and within one session saying it twice is repetition.
      token: conflict.occasionId,
      text: conflict.message,
      // Two dates are not a yes/no question. He answers by saying which is right.
      answerable: false,
      occasionId: conflict.occasionId,
    });
  }

  for (const interview of pending.interviews) {
    const step = interview.nextStep;
    if (interview.complete || step === null) continue;
    if (step.prompt.trim().length === 0) continue;
    candidates.push({
      kind: 'interview',
      stream: `interview:${interview.interviewId}`,
      // The STEP id, not the interview id: answering one question and being
      // handed the next has to read as progress, while the same unanswered
      // question is the thread he already walked away from. That is what makes
      // this resume at the question he did not answer rather than at the start.
      token: step.id,
      text: step.prompt,
      answerable: false,
      occasionId: interview.occasionId,
      interviewId: interview.interviewId,
      stepId: step.id,
    });
  }

  if (candidates.length === 0) return EMPTY_DECISION;

  const next = new Map<string, string>();
  const raises: OccasionsRaise[] = [];
  for (const candidate of candidates) {
    next.set(candidate.stream, candidate.token);
    if (ledger.get(candidate.stream) === candidate.token) continue;
    raises.push(candidate);
  }
  // `next` holds only the streams this answer carried, so an occasion he has
  // answered, or one he removed, leaves the ledger on the next read.
  return { raises, ledger: next };
}

/**
 * The lines to put in the transcript for one decision.
 *
 * Separate from the decision so the wording passthrough is testable without a
 * conversation, and so there is exactly one place that turns raises into text,
 * a second one would be a second chance to decorate a message that must not be
 * decorated.
 */
export function occasionsRaiseLines(raises: readonly OccasionsRaise[]): readonly string[] {
  return raises.map((raise) => raise.text);
}
