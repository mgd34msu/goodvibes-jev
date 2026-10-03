/**
 * agent-conversational-capture.ts, what an Agent conversational turn is told
 * about recording, and what it is allowed to record with.
 *
 * ## The defect this closes
 *
 * The SDK shipped `platform/personal-capture` and the daemon wired it into the
 * shared-session continuation runner, so a channel turn records what the owner
 * tells it. The Agent product answers on a DIFFERENT path, its own
 * `Orchestrator.handleUserInput` turn (runtime/bootstrap.ts), with its own tool
 * registry and its own operator policy, and that path never got the contract.
 *
 * The result, in his own live session: it searched his mail, found his flight
 * itinerary, answered "plan to be at the airport by 5:55 AM", and stored
 * nothing. The next session's plans query answered "(none recorded)". Both
 * halves were available the whole time, `occasions` and `profile` were
 * registered and reachable, and nothing in the prompt said that using them was
 * part of answering.
 *
 * ## Why the text is here and not imported verbatim from the SDK
 *
 * The doctrine is the SDK's and is imported where it is executable:
 * `resolveCaptureAuthority` decides this turn's write authority, and
 * `CONVERSATIONAL_TURN_TOOLS` names the capability set a conversational turn
 * needs. The INSTRUCTION text cannot be imported verbatim, because the SDK's
 * copy names the SDK's own capture tool and its actions (`profile` action
 * `record_trip`). This product's capture surface is two different tools with
 * different verbs, `occasions` for anything dated, `profile` for fields and
 * prose, reaching the daemon through the operator gateway. Injecting the SDK's
 * wording here would instruct the model to call actions this build's tools do
 * not have, which is a tool error per turn rather than a capture.
 *
 * So the rules are restated against THIS product's verbs, in the same order and
 * with the same force as the SDK contract, and
 * `src/test/runtime/conversational-capture-contract.test.ts` pins each rule so
 * neither copy can lose one quietly.
 *
 * ## Authority
 *
 * The Agent's surface is local: the owner is sitting at it, typing. That is the
 * `local-surface` case in the SDK's authority module, and it resolves to
 * `owner-direct`, the only authority the profile write gate accepts. It is
 * derived here through `resolveCaptureAuthority` rather than written as a
 * literal so that the one place deciding "may this turn write" stays the SDK's.
 */

import {
  CONVERSATIONAL_TURN_TOOLS,
  resolveCaptureAuthority,
  type CaptureAuthorityDecision,
} from '@goodvibes-jev/engine/sdk/platform/personal-capture';

/**
 * The capture-capable tools a conversational Agent turn needs registered.
 *
 * COMPOSED with the SDK's list, never substituted for the Agent's own. The
 * Agent's main conversation is a full operator session, it keeps `exec`,
 * `write`, `edit`, `browser` and the rest, because that is the product. What
 * the SDK list contributes is the floor: whatever else a turn can do, it must
 * be able to look things up AND record what it learned. `occasions` is this
 * product's half of the capture surface (anything dated, plans included), which
 * the SDK's single `profile` tool covers on its own side.
 */
export const AGENT_CONVERSATIONAL_CAPTURE_TOOLS: readonly string[] = [
  ...CONVERSATIONAL_TURN_TOOLS,
  'occasions',
];

/**
 * Which capture tools the registry is missing, given the names it has.
 *
 * Pure and name-only so the composition root can ask the question and a test
 * can ask it without building a live registry. An empty array means a
 * conversational turn can actually do what the instruction block tells it to;
 * a non-empty one is the instruction promising something the tools cannot
 * deliver, which is the shape of the original defect.
 */
export function missingConversationalCaptureTools(
  registeredToolNames: readonly string[],
): readonly string[] {
  const present = new Set(registeredToolNames);
  return AGENT_CONVERSATIONAL_CAPTURE_TOOLS.filter((name) => !present.has(name));
}

/**
 * This turn's write authority.
 *
 * No channel identity: an Agent turn is the owner at his own keyboard. The SDK
 * resolves that to `owner-direct` via `local-surface`, and a turn arriving any
 * other way would be resolved by the caller that knows where it came from.
 */
export function resolveAgentTurnCaptureAuthority(): CaptureAuthorityDecision {
  return resolveCaptureAuthority({ channel: undefined, ownerChannels: '', nudgeChannels: '' });
}

/**
 * The capture contract, as the operator policy carries it on every turn.
 *
 * The rules, in the order the SDK contract states them:
 *
 *  1. Recording what he states is part of answering, not something to offer.
 *  2. Recording what the turn FOUND while answering is part of that same
 *     answer, the itinerary case, which is the one that was silent, and a
 *     found fact carries the authority of the surface it came from, which is
 *     what stops the capture rule from being read as a way around the
 *     untrusted-source bar.
 *  3. Capture the inference, not only the statement, and then USE it.
 *  4. Say concretely what was stored. "Noted" is indistinguishable from
 *     nothing happening, which is exactly what he could not tell apart.
 *  5. A capture that did not complete is said plainly, in the same reply.
 *     Nothing unresolved drops silently.
 */
export const AGENT_CONVERSATIONAL_CAPTURE_POLICY: string = [
  '## Recording what you learn is part of answering',
  // Rule 1, the SDK contract's "recording it is part of answering, not
  // something to offer to do". The Agent's tools, not the SDK's.
  '- When he tells you something about himself, recording it is part of answering, not something to offer to do, and not something to ask permission for. A preference, an address, where he works, a person who matters to him: `profile action:"set"` for a keyed field, `profile action:"append"` for prose, in the same turn, then answer.',
  // Rule 2, capture-on-use. This is the itinerary defect stated as a rule: the
  // information did not arrive in his message, it arrived in a tool result the
  // turn went and fetched, and the turn treated "he did not say it to me" as
  // "there is nothing to record".
  '- The same applies to what you FIND while answering him. If you go looking, his mail, his calendar, a document, a booking, and what comes back is personal information about him (an itinerary, a date, an address, a flight, a reservation), recording it is part of THAT answer. Do not report the finding and store nothing: that is the failure this rule exists for. He asked you to look; the looking and the keeping are one job.',
  // The one place this could go wrong is the authority. A found fact is not
  // something he said, and the untrusted-source bar above is not negotiable,
  // so the rule has to name the authority explicitly, or a model that wants the
  // capture to succeed will reach for `owner-direct` to get past the refusal.
  '- Authority on a found fact is the surface it came from, `email` for something in his mailbox, `calendar-event` for something on his calendar, `document` for a file, `web-page` for a page, never `owner-direct`, which means he said it to you this turn. Attempt the capture with the true surface anyway. What you must never do is skip the attempt, and never restate the authority to make a refusal go away.',
  // The refusal is not the end of the road, and leaving it there is what makes
  // the bar feel like an obstruction. The two-step already exists and is
  // already sanctioned: put the exact thing in front of him, and his one word
  // finishes it under his own authority. That is one extra beat, not a dead
  // end, and it needs no new trust tier to work.
  '- A refusal there is not the end of it. Put the exact thing in front of him in the same reply so one word finishes it: for a trip or a dated plan call `occasions action:"plan_propose"` with the dates and details you found and say its confirmation line back to him as written; for a date, `action:"propose"`. When he answers, "yes", "that\'s right", anything of his own, THAT turn carries `owner-direct`, and you complete it immediately with `plan_confirm` (or `confirm`) using his words as `said`. Do not make him retype what you already found. Say where it came from, the sender and the subject, so he knows what he is confirming.',
  // Rule 3, inference and use. The SDK's "Recording is the floor, not the job",
  // with its named examples kept, because vague instructions to "infer" produce
  // nothing.
  '- Recording is the floor, not the job. Read what the thing MEANS and fold that into the same turn. An itinerary is not just two dates: it says he is away for that span, say the span back to him in plain words, the people travelling with him are people in his life, and the destination plus the reason are durable facts worth keeping in the same capture (visiting his parents in a town means his parents live there). Capture what it implies, not only what it states.',
  '- Then use it. What you just stored shapes the rest of the answer: name anything already on his calendar or in his plans that collides with the span, and offer the obviously useful next things once: a reminder before he leaves, weather where he is going. Offer is the word. Capturing and inferring are part of answering; anything beyond the conversation, booking something, standing monitoring, a scheduled job, is proposed in one line and waits for his yes.',
  // Rule 4, say what was stored, concretely.
  '- Then say concretely what you stored: what it was, the dates, and where it went. Never "noted" and never "I\'ll remember that", he cannot tell either of those apart from nothing happening, and that is exactly what went wrong.',
  // Rule 5, a failed capture is spoken. Occasions doctrine applied here.
  '- If a capture does not complete, a refused authority, an unreachable daemon, a value you could not resolve, say so plainly in the reply and say what stopped it. Never let a failed capture pass as a friendly acknowledgement, and never retry it with a different authority to get past the refusal. Nothing unresolved drops silently.',
].join('\n');
