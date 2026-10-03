/**
 * The Agent as a nudge channel: what actually reaches the transcript.
 *
 * docs/occasions.md §4.2 names Telegram AND the agent, and excludes the TUI in
 * the owner's own words. The agent's half of that is a PULL, the SDK's own
 * docstring on `occasions.pending` says so, and this suite pins the properties
 * that make the pull safe to run on every turn:
 *
 *  - the daemon's composed sentence lands in the transcript unaltered, so §4.3's
 *    never-the-date rule cannot be undone here;
 *  - a failure of any kind is silent and harmless, because this rides a real turn
 *    and must never disturb it;
 *  - `occasions.enabled` is honoured LIVE, so turning the feature off stops the
 *    surface without a restart. That last one is this key's behaviour-coverage
 *    row (src/verification/settings-behavior-coverage.ts): both values are driven
 *    through the real consumer, and the observable difference is whether the verb
 *    is called at all.
 */

import { describe, expect, test } from 'bun:test';
import { createOccasionsNudgeSurface } from '../../runtime/occasions-nudge-surface.ts';
import type { OccasionsGatewayInvoke, OccasionsGatewayResult } from '../../agent/occasions-gateway.ts';

const NUDGE_MESSAGE = "Sarah's birthday is coming up. Do you want to sort something for it?";

function pendingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    today: '2026-03-01',
    nudge: {
      id: 'occasions-pending-2026-03-01',
      raisedAt: 1_772_000_000_000,
      subjects: [{
        occasionId: 'sarahs-birthday',
        title: "Sarah's birthday",
        person: 'Sarah',
        kind: 'gift-giving',
        proximity: 'approaching',
      }],
      message: NUDGE_MESSAGE,
      answerable: true,
    },
    conflicts: [],
    interviews: [],
    ...overrides,
  };
}

interface Harness {
  readonly said: string[];
  readonly calls: string[];
  readonly renders: { count: number };
}

function harness(
  respond: (methodId: string) => OccasionsGatewayResult,
  isEnabled: () => boolean = () => true,
): { readonly surface: ReturnType<typeof createOccasionsNudgeSurface>; readonly seen: Harness } {
  const seen: Harness = { said: [], calls: [], renders: { count: 0 } };
  const invoke = ((methodId: string) => {
    seen.calls.push(methodId);
    return Promise.resolve(respond(methodId));
  }) as unknown as OccasionsGatewayInvoke;
  const surface = createOccasionsNudgeSurface({
    invoke,
    conversation: { addAssistantMessage: (content: string) => { seen.said.push(content); } },
    requestRender: () => { seen.renders.count += 1; },
    isEnabled,
  });
  return { surface, seen };
}

describe('occasions nudge surface', () => {
  test("the daemon's message becomes the agent's own words, unaltered", async () => {
    const { surface, seen } = harness(() => ({ ok: true, data: pendingPayload(), route: 'in-process' }));
    expect(await surface.raiseNow()).toBe(1);
    // Equality, not containment: a prefix like "Reminder:" would be this surface
    // adding a voice to a sentence the daemon already composed.
    expect(seen.said).toEqual([NUDGE_MESSAGE]);
    expect(seen.calls).toEqual(['occasions.pending']);
    expect(seen.renders.count).toBe(1);
  });

  test('the same open nudge is said once per session, not once per turn', async () => {
    const { surface, seen } = harness(() => ({ ok: true, data: pendingPayload(), route: 'in-process' }));
    expect(await surface.raiseNow()).toBe(1);
    expect(await surface.raiseNow()).toBe(0);
    expect(await surface.raiseNow()).toBe(0);
    expect(seen.said).toEqual([NUDGE_MESSAGE]);
    // The verb was still called every time, nothing here caches the daemon's
    // answer, so an occasion he answers elsewhere disappears on the next turn.
    expect(seen.calls).toHaveLength(3);
    // One render, for the one thing that was actually said.
    expect(seen.renders.count).toBe(1);
  });

  test('nothing outstanding says nothing and does not touch the transcript', async () => {
    const { surface, seen } = harness(() => ({
      ok: true,
      data: { today: '2026-03-01', nudge: null, conflicts: [], interviews: [] },
      route: 'in-process',
    }));
    expect(await surface.raiseNow()).toBe(0);
    expect(seen.said).toEqual([]);
    expect(seen.renders.count).toBe(0);
  });

  test('occasions.enabled false stops the pull entirely, and true resumes it: read live', async () => {
    let enabled = false;
    const { surface, seen } = harness(
      () => ({ ok: true, data: pendingPayload(), route: 'in-process' }),
      () => enabled,
    );

    // Off: the verb is not even called, so a leftover open item from before he
    // turned it off is not raised by a surface that had not noticed.
    expect(await surface.raiseNow()).toBe(0);
    expect(seen.calls).toEqual([]);
    expect(seen.said).toEqual([]);

    // On, with no restart in between.
    enabled = true;
    expect(await surface.raiseNow()).toBe(1);
    expect(seen.calls).toEqual(['occasions.pending']);
    expect(seen.said).toEqual([NUDGE_MESSAGE]);

    // Off again, mid-session.
    enabled = false;
    expect(await surface.raiseNow()).toBe(0);
    expect(seen.calls).toHaveLength(1);
  });

  test('an unreachable daemon is silent, not an error in his transcript', async () => {
    const { surface, seen } = harness(() => ({
      ok: false,
      data: null,
      error: 'connection refused',
      route: 'connected-host',
    }));
    expect(await surface.raiseNow()).toBe(0);
    expect(seen.said).toEqual([]);
    expect(seen.renders.count).toBe(0);
  });

  test('a payload this build cannot read raises nothing rather than guessing', async () => {
    const { surface, seen } = harness(() => ({
      ok: true,
      data: { unexpected: true },
      route: 'in-process',
    }));
    expect(await surface.raiseNow()).toBe(0);
    expect(seen.said).toEqual([]);
  });

  test('a thrown invoke never escapes into the turn that called it', async () => {
    const invoke = (() => Promise.reject(new Error('boom'))) as unknown as OccasionsGatewayInvoke;
    const said: string[] = [];
    const surface = createOccasionsNudgeSurface({
      invoke,
      conversation: { addAssistantMessage: (content: string) => { said.push(content); } },
      requestRender: () => undefined,
      isEnabled: () => true,
    });
    expect(await surface.raiseNow()).toBe(0);
    expect(said).toEqual([]);
  });

  test('several outstanding things arrive as separate messages, not one paragraph', async () => {
    const { surface, seen } = harness(() => ({
      ok: true,
      data: pendingPayload({
        conflicts: [{ occasionId: 'our-anniversary', message: 'Which one is right?' }],
        interviews: [{
          interviewId: 'interview-1',
          occasionId: 'sarahs-birthday',
          occurrence: '2026-03-14',
          steps: [],
          nextStep: { id: 'step-1', prompt: 'Has she mentioned wanting anything lately?', opensFrom: '' },
          complete: false,
          landedOn: null,
        }],
      }),
      route: 'in-process',
    }));
    expect(await surface.raiseNow()).toBe(3);
    // Three subjects to answer, three messages. The daemon already batched
    // several occasions inside the ONE nudge line; joining again here would put
    // an unrelated conflict and an interview question in the same breath.
    expect(seen.said).toEqual([
      NUDGE_MESSAGE,
      'Which one is right?',
      'Has she mentioned wanting anything lately?',
    ]);
    // One render for the batch, not one per line.
    expect(seen.renders.count).toBe(1);
  });
});
