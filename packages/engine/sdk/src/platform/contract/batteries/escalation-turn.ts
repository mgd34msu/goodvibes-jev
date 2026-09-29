/**
 * `contract.escalation-turn` (docs/design/contract-runner.md 10.3): whether a
 * person's turn, in a session with an open escalation, responds to that
 * escalation's question or asks for something unrelated to it. One yes/no
 * question over `{ question, turn }`: the open escalation's question as it was
 * put, and the turn's text verbatim.
 *
 * Composition (intake-route.ts): a no at act routes the turn like any other
 * turn (the request route) and leaves the escalation open; every other reading,
 * a yes at any outcome or a no below act, sends the turn to `runner.reply`,
 * where `contract.owner-reply` reads it and an unclear reply asks again.
 *
 * Band: a false no routes a real reply elsewhere, where it can start work the
 * owner did not ask for while the escalation stays unanswered, so the no side
 * reads at high stakes. A false yes costs one question asked again, so the yes
 * side reads at medium.
 */
import { defineBattery, STAKES_BANDS, yesNo, type YesNoBand, type YesNoReading } from '@goodvibes-jev/judgment';
import { SAMPLE_ESCALATIONS } from './owner-reply.js';

export const ESCALATION_TURN_SITE = 'contract.escalation-turn';

/** Yes at medium stakes, no at high: a false "unrelated" can start unwanted work. */
export const ESCALATION_TURN_BAND: YesNoBand = { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence };

const { unsettled, stalled, 'plan-unresolved': plan, 'writing-unclear': writing, 'attempts-undecided': attempts } = SAMPLE_ESCALATIONS;

export const escalationTurn = defineBattery({
  name: ESCALATION_TURN_SITE,
  version: 1,
  description: "Whether a person's turn answers the open escalation's question (approves, changes what is required, stops, or picks a choice) or asks for something unrelated.",
  accuracyFloor: 0.9,
  items: {
    responds: yesNo(
      'Does `turn` respond to `question`, by approving, asking to change what is required, asking to stop, or naming one of the choices it offers, rather than asking for something unrelated to it?',
      ESCALATION_TURN_BAND,
      {
        true: '`turn` answers `question`: it approves, changes what is required, stops the work, or picks one of the choices offered',
        false: '`turn` asks for or talks about something that `question` is not about',
      },
    ),
  },
  fixtures: [
    { name: 'approve unshown criteria', state: { question: unsettled.question, turn: "Yes, that's fine, accept them as met." }, expect: { responds: 'yes' } },
    { name: 'amend the plan', state: { question: plan.question, turn: 'Drop the XML writer from the plan; CSV and JSON are enough.' }, expect: { responds: 'yes' } },
    { name: 'stop the stalled work', state: { question: stalled.question, turn: 'Stop this contract, I will sort out the refunds myself.' }, expect: { responds: 'yes' } },
    { name: 'relax a stalled criterion', state: { question: stalled.question, turn: 'Skip the sandbox test; checking that refund() calls the endpoint is enough.' }, expect: { responds: 'yes' } },
    { name: 'pick an attempt by id', state: { question: attempts.question, turn: 'Take u1#a0.' }, expect: { responds: 'yes' } },
    { name: 'approve the proposed attempt', state: { question: attempts.question, turn: 'Go with the proposed one.' }, expect: { responds: 'yes' } },
    { name: 'files may change', state: { question: writing.question, turn: 'Yes, you can edit whatever files you need.' }, expect: { responds: 'yes' } },
    { name: 'nothing may change', state: { question: writing.question, turn: "Don't change anything, just tell me what you find." }, expect: { responds: 'yes' } },
    { name: 'weather question during an unsettled escalation', state: { question: unsettled.question, turn: "What's the weather going to be like in Berlin tomorrow?" }, expect: { responds: 'no' } },
    { name: 'new work request during an unsettled escalation', state: { question: unsettled.question, turn: 'Rename the user service to account service everywhere and update the imports.' }, expect: { responds: 'no' } },
    { name: 'unrelated feature during a plan escalation', state: { question: plan.question, turn: 'Can you add a --verbose flag to the deploy script?' }, expect: { responds: 'no' } },
    { name: 'a poem during a stalled escalation', state: { question: stalled.question, turn: 'Write me a short poem about autumn.' }, expect: { responds: 'no' } },
    { name: 'git help during an attempts escalation', state: { question: attempts.question, turn: 'How do I undo my last git commit without losing the changes?' }, expect: { responds: 'no' } },
    { name: 'knowledge question during a writing escalation', state: { question: writing.question, turn: 'What is the difference between a mutex and a semaphore?' }, expect: { responds: 'no' } },
    { name: 'unrelated bug fix during a stalled escalation', state: { question: stalled.question, turn: 'The date parser test is failing on leap years, fix it.' }, expect: { responds: 'no' } },
  ],
});

/**
 * Whether a turn leaves the open escalation for the request route: only a no
 * at act. Every other reading goes to the escalation as the owner's reply.
 */
export function turnIsUnrelated(reading: YesNoReading): boolean {
  return reading.verdict === 'no' && reading.outcome === 'act';
}
