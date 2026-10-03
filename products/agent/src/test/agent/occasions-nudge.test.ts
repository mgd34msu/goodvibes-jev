/**
 * occasions-nudge.ts, the one thing this surface decides, and the one thing it
 * must never do.
 *
 * The decision is small on purpose: which outstanding items have not already been
 * said, and in what order. Every rule about whether something MAY be raised
 * (lead window, cadence, quiet hours, an answer that expires with its occurrence)
 * lives in the daemon and reaches this module only as the contents of
 * `occasions.pending`. So these tests are about two properties:
 *
 *  1. the daemon's wording survives unaltered, no date can appear because none
 *     is in the payload, and the ask in a gift-giving nudge is not stripped;
 *  2. the ledger de-duplicates a RENDER without becoming a suppression rule,
 *     keyed by the daemon's own ids, and pruned so it cannot grow without bound.
 */

import { describe, expect, test } from 'bun:test';
import {
  decideOccasionsRaises,
  occasionsRaiseLines,
  type OccasionsRaiseLedger,
} from '../../agent/occasions-nudge.ts';
import type { OccasionsPendingResponse } from '../../tools/agent-occasions-types.ts';

const EMPTY_LEDGER: OccasionsRaiseLedger = new Map<string, string>();

function pending(overrides: Partial<OccasionsPendingResponse> = {}): OccasionsPendingResponse {
  return {
    today: '2026-03-01',
    nudge: null,
    conflicts: [],
    interviews: [],
    ...overrides,
  } as OccasionsPendingResponse;
}

function nudge(overrides: Record<string, unknown> = {}): OccasionsPendingResponse['nudge'] {
  return {
    id: 'occasions-pending-2026-03-01',
    raisedAt: 1_772_000_000_000,
    subjects: [{
      occasionId: 'sarahs-birthday',
      title: "Sarah's birthday",
      person: 'Sarah',
      kind: 'gift-giving',
      proximity: 'approaching',
      // Platform runtime 2.0.9: subject attribution and acknowledgment state
      // ride every nudge subject.
      subject: 'other',
      acknowledged: false,
    }],
    message: "Sarah's birthday is coming up. Do you want to sort something for it?",
    answerable: true,
    ...overrides,
  } as OccasionsPendingResponse['nudge'];
}

describe('occasions raise decision', () => {
  test('nothing outstanding raises nothing and keeps an empty ledger', () => {
    const decision = decideOccasionsRaises(pending(), EMPTY_LEDGER);
    expect(decision.raises).toEqual([]);
    expect(decision.ledger.size).toBe(0);
  });

  test("the daemon's composed message is carried through verbatim, ask included", () => {
    const composed = "Sarah's birthday is coming up. Do you want to sort something for it?";
    const decision = decideOccasionsRaises(pending({ nudge: nudge({ message: composed }) }), EMPTY_LEDGER);
    expect(occasionsRaiseLines(decision.raises)).toEqual([composed]);
    // Not merely "contains the text": equality is the assertion, because any
    // prefix, suffix or rewording here would be this surface re-deciding §4.3.
    expect(decision.raises[0]?.text).toBe(composed);
    // The ask is what makes a gift-giving nudge answerable at all, and dropping
    // it would leave him a notification he cannot act on.
    expect(decision.raises[0]?.answerable).toBe(true);
  });

  test('a remember-only batch is a statement, and answerable comes from the daemon', () => {
    const decision = decideOccasionsRaises(
      pending({
        nudge: nudge({
          message: 'Dad is coming up.',
          answerable: false,
          subjects: [{
            occasionId: 'dad',
            title: 'Dad',
            person: '',
            kind: 'remember-only',
            proximity: 'soon',
          }],
        }),
      }),
      EMPTY_LEDGER,
    );
    expect(decision.raises[0]?.answerable).toBe(false);
    // No yes/no was invented for a statement, and nothing was appended to it.
    expect(decision.raises[0]?.text).toBe('Dad is coming up.');
  });

  test('no digit from a date can appear, because the payload carries none', () => {
    const decision = decideOccasionsRaises(pending({ nudge: nudge() }), EMPTY_LEDGER);
    const text = occasionsRaiseLines(decision.raises).join('\n');
    // The proximity is a WORD. "in 10 days" is the date with arithmetic applied
    // (§4.3), so a day count in the rendered line is the same defect as a date.
    expect(/\d/.test(text)).toBe(false);
    expect(text).toContain('coming up');
  });

  test('the same open batch is said once, and the ledger remembers by the daemon id', () => {
    const answer = pending({ nudge: nudge() });
    const first = decideOccasionsRaises(answer, EMPTY_LEDGER);
    expect(first.raises).toHaveLength(1);
    expect(first.ledger.get('nudge')).toBe('occasions-pending-2026-03-01');

    const second = decideOccasionsRaises(answer, first.ledger);
    expect(second.raises).toEqual([]);
    // Still tracked, so a third read is silent too.
    expect(second.ledger.get('nudge')).toBe('occasions-pending-2026-03-01');
  });

  test("a new day is a new id, so the daemon's own cadence decides the repeat", () => {
    const first = decideOccasionsRaises(pending({ nudge: nudge() }), EMPTY_LEDGER);
    const tomorrow = decideOccasionsRaises(
      pending({ today: '2026-03-02', nudge: nudge({ id: 'occasions-pending-2026-03-02' }) }),
      first.ledger,
    );
    expect(tomorrow.raises).toHaveLength(1);
    expect(tomorrow.ledger.get('nudge')).toBe('occasions-pending-2026-03-02');
  });

  test('a resolved stream leaves the ledger rather than being remembered forever', () => {
    const first = decideOccasionsRaises(
      pending({
        nudge: nudge(),
        conflicts: [{ occasionId: 'anniversary', message: 'Your profile has 2 different dates recorded for Our anniversary. Nothing has been changed, which one is right?' }],
      } as Partial<OccasionsPendingResponse>),
      EMPTY_LEDGER,
    );
    expect(first.raises).toHaveLength(2);
    expect(first.ledger.size).toBe(2);

    // He answered the nudge; only the conflict is still open.
    const second = decideOccasionsRaises(
      pending({
        conflicts: [{ occasionId: 'anniversary', message: 'Your profile has 2 different dates recorded for Our anniversary. Nothing has been changed, which one is right?' }],
      } as Partial<OccasionsPendingResponse>),
      first.ledger,
    );
    expect(second.raises).toEqual([]);
    // Bounded by what is declared, not by how long the session has run.
    expect(second.ledger.size).toBe(1);
    expect(second.ledger.has('nudge')).toBe(false);
  });

  test('a conflict is raised as written and is never offered a yes/no', () => {
    const message = 'Your profile has 2 different dates recorded for Our anniversary. Nothing has been changed, which one is right?';
    const decision = decideOccasionsRaises(
      pending({ conflicts: [{ occasionId: 'our-anniversary', message }] } as Partial<OccasionsPendingResponse>),
      EMPTY_LEDGER,
    );
    expect(decision.raises).toHaveLength(1);
    expect(decision.raises[0]?.text).toBe(message);
    expect(decision.raises[0]?.answerable).toBe(false);
    expect(decision.raises[0]?.occasionId).toBe('our-anniversary');
  });

  test('an interview resumes at the question he did not answer, keyed by the step', () => {
    const step = { id: 'step-2', prompt: 'Has she mentioned wanting anything lately?', opensFrom: '' };
    const answer = pending({
      interviews: [{
        interviewId: 'interview-sarahs-birthday-2026-03-14',
        occasionId: 'sarahs-birthday',
        occurrence: '2026-03-14',
        steps: [],
        nextStep: step,
        complete: false,
        landedOn: null,
      }],
    } as Partial<OccasionsPendingResponse>);

    const first = decideOccasionsRaises(answer, EMPTY_LEDGER);
    expect(first.raises[0]?.text).toBe(step.prompt);
    expect(first.raises[0]?.stepId).toBe('step-2');
    expect(first.raises[0]?.interviewId).toBe('interview-sarahs-birthday-2026-03-14');

    // The same unanswered question is the thread he already walked away from.
    expect(decideOccasionsRaises(answer, first.ledger).raises).toEqual([]);

    // Answering it and being handed the next one has to read as progress.
    const advanced = decideOccasionsRaises(
      pending({
        interviews: [{
          interviewId: 'interview-sarahs-birthday-2026-03-14',
          occasionId: 'sarahs-birthday',
          occurrence: '2026-03-14',
          steps: [],
          nextStep: { id: 'step-3', prompt: 'Roughly what did you want to spend?', opensFrom: '' },
          complete: false,
          landedOn: null,
        }],
      } as Partial<OccasionsPendingResponse>),
      first.ledger,
    );
    expect(advanced.raises).toHaveLength(1);
    expect(advanced.raises[0]?.stepId).toBe('step-3');
  });

  test('a finished interview is not raised again', () => {
    const decision = decideOccasionsRaises(
      pending({
        interviews: [{
          interviewId: 'interview-done',
          occasionId: 'sarahs-birthday',
          occurrence: '2026-03-14',
          steps: [],
          nextStep: null,
          complete: true,
          landedOn: 'the pottery class she mentioned',
        }],
      } as Partial<OccasionsPendingResponse>),
      EMPTY_LEDGER,
    );
    expect(decision.raises).toEqual([]);
  });

  test('the nudge comes before a conflict, and a conflict before an interview question', () => {
    const decision = decideOccasionsRaises(
      pending({
        nudge: nudge(),
        conflicts: [{ occasionId: 'our-anniversary', message: 'conflict line' }],
        interviews: [{
          interviewId: 'interview-1',
          occasionId: 'sarahs-birthday',
          occurrence: '2026-03-14',
          steps: [],
          nextStep: { id: 'step-1', prompt: 'interview line', opensFrom: '' },
          complete: false,
          landedOn: null,
        }],
      } as Partial<OccasionsPendingResponse>),
      EMPTY_LEDGER,
    );
    expect(decision.raises.map((raise) => raise.kind)).toEqual(['nudge', 'conflict', 'interview']);
  });

  test('an empty message is not raised as a blank line', () => {
    const decision = decideOccasionsRaises(
      pending({ nudge: nudge({ message: '   ' }) }),
      EMPTY_LEDGER,
    );
    expect(decision.raises).toEqual([]);
  });
});
