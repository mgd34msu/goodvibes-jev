/**
 * The `occasions` tool: the conversational loop the sixteen verbs support.
 *
 * The tool is a relay, so what is worth testing is not that it forwards, it is
 * the set of things it must NOT do, each of which is an owner ruling in
 * docs/occasions.md:
 *
 *  §4.3 a nudge never carries the date, so `pending` renders the daemon's line
 *       and adds nothing to it.
 *  §4.4 the kind is his, never inferred, so `confirm` refuses without one and no
 *       default is supplied anywhere in the file.
 *  §4.5 a captured date is confirmed once, at the time, so `propose` writes
 *       nothing and relays the daemon's own one-liner, which already asks for
 *       the kind, making it one interaction rather than two.
 *  §4.9 `later` is a distinct answer and is never folded into `no`.
 *  §4.10 a yes opens the interview; the agent does not recommend, and a dropped
 *       thread resumes at the unanswered question.
 *  §4.11 removal takes one confirmation.
 *
 * Plus the write gate: `confirm`, `plan_confirm` and `remove` require an
 * authority, it is forwarded unchanged, and a refusal is never retried.
 */

import { describe, expect, test } from 'bun:test';
import { createAgentOccasionsTool } from '../../tools/agent-occasions-tool.ts';
import type { OccasionsGatewayInvoke, OccasionsGatewayResult } from '../../agent/occasions-gateway.ts';

interface Recorded {
  readonly methodId: string;
  readonly body: Record<string, unknown>;
}

function toolWith(
  respond: (methodId: string, body: Record<string, unknown>) => OccasionsGatewayResult,
): { readonly run: (args: Record<string, unknown>) => Promise<{ success: boolean; output: string }>; readonly calls: Recorded[] } {
  const calls: Recorded[] = [];
  const invoke = ((methodId: string, body: Record<string, unknown>) => {
    calls.push({ methodId, body });
    return Promise.resolve(respond(methodId, body));
  }) as unknown as OccasionsGatewayInvoke;
  const tool = createAgentOccasionsTool({ invoke });
  return {
    run: async (args) => {
      const result = await tool.execute(args) as { success: boolean; output: string };
      return result;
    },
    calls,
  };
}

function answers(data: unknown): OccasionsGatewayResult {
  return { ok: true, data, route: 'in-process' };
}

describe('occasions tool: shape', () => {
  test('an unknown action is refused rather than defaulted to a read', async () => {
    const { run, calls } = toolWith(() => answers({}));
    const result = await run({ action: 'sing' });
    expect(result.success).toBe(false);
    expect(calls).toEqual([]);
  });

  test('the tool declares no default for kind anywhere in its parameters', () => {
    const tool = createAgentOccasionsTool({ invoke: (() => Promise.resolve(answers({}))) as unknown as OccasionsGatewayInvoke });
    const params = tool.definition.parameters as { properties: Record<string, Record<string, unknown>> };
    // §4.4: offering the three is the point; defaulting one is the defect.
    expect(params.properties.kind?.enum).toEqual(['gift-giving', 'remember-only', 'neither']);
    expect(params.properties.kind).not.toHaveProperty('default');
    expect(params.properties.answer?.enum).toEqual(['yes', 'no', 'later']);
    expect(params.properties.answer).not.toHaveProperty('default');
  });
});

describe('occasions tool: pending', () => {
  const PENDING = {
    today: '2026-03-01',
    nudge: {
      id: 'occasions-pending-2026-03-01',
      raisedAt: 1,
      subjects: [{ occasionId: 'sarahs-birthday', title: "Sarah's birthday", person: 'Sarah', kind: 'gift-giving', proximity: 'approaching' }],
      message: "Sarah's birthday is coming up. Do you want to sort something for it?",
      answerable: true,
    },
    conflicts: [],
    interviews: [],
  };

  test("the daemon's nudge line is relayed as written and the three answers are offered", async () => {
    const { run } = toolWith(() => answers(PENDING));
    const result = await run({ action: 'pending' });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Sarah's birthday is coming up. Do you want to sort something for it?");
    expect(result.output).toContain('yes / no / later');
    // §4.9 stated where the model will read it.
    expect(result.output).toContain('"later" is not a no');
    expect(result.output).toContain('occasionId sarahs-birthday');
  });

  test('a remember-only batch is not offered a yes/no', async () => {
    const { run } = toolWith(() => answers({
      ...PENDING,
      nudge: { ...PENDING.nudge, message: 'Dad is coming up.', answerable: false },
    }));
    const result = await run({ action: 'pending' });
    expect(result.output).toContain('Do not offer him a yes/no');
    expect(result.output).not.toContain('yes / no / later');
  });

  test('nothing outstanding says so, and tells the model not to raise a date unasked', async () => {
    const { run } = toolWith(() => answers({ today: '2026-03-01', nudge: null, conflicts: [], interviews: [] }));
    const result = await run({ action: 'pending' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Nothing is outstanding');
    expect(result.output).toContain('Do not raise a date he has not asked about');
  });

  test('an unreadable payload says so rather than reporting an empty profile', async () => {
    const { run } = toolWith(() => answers({ nope: 1 }));
    const result = await run({ action: 'pending' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('shape this build does not recognise');
  });
});

describe('occasions tool: answers', () => {
  test('later is sent as later, never folded into no', async () => {
    const { run, calls } = toolWith(() => answers({ ok: true, reason: null, interview: null }));
    const result = await run({ action: 'answer', occasionId: 'sarahs-birthday', answer: 'later' });
    expect(result.success).toBe(true);
    expect(calls[0]?.body.answer).toBe('later');
    expect(result.output).toContain('not a no');
  });

  test('a word that is not one of the three is refused, not read as a refusal', async () => {
    const { run, calls } = toolWith(() => answers({ ok: true, reason: null, interview: null }));
    const result = await run({ action: 'answer', occasionId: 'sarahs-birthday', answer: 'maybe' });
    expect(result.success).toBe(false);
    expect(calls).toEqual([]);
  });

  test('no says the record expires with the occurrence, so next year asks fresh', async () => {
    const { run } = toolWith(() => answers({ ok: true, reason: null, interview: null }));
    const result = await run({ action: 'answer', occasionId: 'sarahs-birthday', answer: 'no' });
    expect(result.output).toContain('next year');
    expect(result.output).toContain('no memory of the refusal');
  });

  test('yes relays the interview the daemon opened, and does not recommend anything', async () => {
    const { run } = toolWith(() => answers({
      ok: true,
      reason: null,
      interview: {
        interviewId: 'interview-1',
        occasionId: 'sarahs-birthday',
        occurrence: '2026-03-14',
        steps: [],
        nextStep: { id: 'step-1', prompt: 'Has she mentioned wanting anything lately?', opensFrom: 'She has been talking about pottery.' },
        complete: false,
        landedOn: null,
      },
    }));
    const result = await run({ action: 'answer', occasionId: 'sarahs-birthday', answer: 'yes' });
    expect(result.output).toContain('a few questions, not a shopping trip');
    expect(result.output).toContain('Has she mentioned wanting anything lately?');
    // §4.10: opened from what the profile already knows, verbatim.
    expect(result.output).toContain('She has been talking about pottery.');
    expect(result.output).toContain('You are not making the recommendation');
  });

  test('a refused answer is reported as refused, with the reason and no retry advice', async () => {
    const { run } = toolWith(() => answers({ ok: false, reason: 'There is no occasion by that name.', interview: null }));
    const result = await run({ action: 'answer', occasionId: 'nope', answer: 'yes' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('There is no occasion by that name.');
    expect(result.output).toContain('Do not try again with different values');
  });
});

describe('occasions tool: the interview', () => {
  test('an answer is recorded verbatim and the next question comes back', async () => {
    const { run, calls } = toolWith(() => answers({
      present: true,
      interview: {
        interviewId: 'interview-1',
        occasionId: 'sarahs-birthday',
        occurrence: '2026-03-14',
        steps: [],
        nextStep: { id: 'step-2', prompt: 'Roughly what did you want to spend?', opensFrom: '' },
        complete: false,
        landedOn: null,
      },
    }));
    const result = await run({
      action: 'interview_answer',
      interviewId: 'interview-1',
      stepId: 'step-1',
      text: 'she keeps mentioning that pottery class',
    });
    expect(result.success).toBe(true);
    expect(calls[0]?.body.text).toBe('she keeps mentioning that pottery class');
    expect(result.output).toContain('Roughly what did you want to spend?');
  });

  test('resuming reads back the question he did not answer, not the first one', async () => {
    const { run } = toolWith(() => answers({
      present: true,
      interview: {
        interviewId: 'interview-1',
        occasionId: 'sarahs-birthday',
        occurrence: '2026-03-14',
        steps: [],
        nextStep: { id: 'step-3', prompt: 'Anything she already has that this would duplicate?', opensFrom: '' },
        complete: false,
        landedOn: null,
      },
    }));
    const result = await run({ action: 'interview', interviewId: 'interview-1' });
    expect(result.output).toContain('Anything she already has that this would duplicate?');
    expect(result.output).toContain('stepId:"step-3"');
  });

  test('closing requires what he landed on, not merely that he said yes', async () => {
    const { run, calls } = toolWith(() => answers({ present: true, interview: null }));
    const result = await run({ action: 'interview_record', interviewId: 'interview-1' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('what he actually settled on');
    expect(calls).toEqual([]);
  });

  test('a recorded outcome is reported in his own words', async () => {
    const { run } = toolWith(() => answers({
      present: true,
      interview: {
        interviewId: 'interview-1',
        occasionId: 'sarahs-birthday',
        occurrence: '2026-03-14',
        steps: [],
        nextStep: null,
        complete: true,
        landedOn: 'the pottery class she keeps mentioning',
      },
    }));
    const result = await run({ action: 'interview_record', interviewId: 'interview-1', landedOn: 'the pottery class she keeps mentioning' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('the pottery class she keeps mentioning');
    expect(result.output).toContain('gift history');
  });

  test('an interview that no longer exists records nothing and says so', async () => {
    const { run } = toolWith(() => answers({ present: false, interview: null }));
    const result = await run({ action: 'interview_answer', interviewId: 'gone', stepId: 'step-1', text: 'anything' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('nothing was recorded');
  });
});

describe('occasions tool: capture', () => {
  test('propose writes nothing and relays the confirmation, kind question included', async () => {
    const confirmation = 'Noted Our anniversary as 2015-09-12, right? And is that one you\'ll want to sort something for, one to just remember, or neither?';
    const { run, calls } = toolWith((methodId) => {
      expect(methodId).toBe('occasions.propose');
      return answers({
        ok: true,
        reason: null,
        line: 'Our anniversary · 2015-09-12 · annual · remember-only',
        confirmation,
        needsKind: true,
        conflictsWith: [],
      });
    });
    const result = await run({ action: 'propose', title: 'Our anniversary', date: '2015-09-12' });
    expect(result.success).toBe(true);
    // §4.5: ONE line, at the moment he can catch a mishearing, and it already
    // asks the kind question, so this is one interaction rather than two.
    expect(result.output).toContain(confirmation);
    expect(result.output).toContain('Nothing is written yet');
    expect(result.output).toContain('He has to pick the kind himself');
    // No write verb was touched.
    expect(calls.map((call) => call.methodId)).toEqual(['occasions.propose']);
  });

  test('a conflicting existing date is reported, never resolved here', async () => {
    const { run } = toolWith(() => answers({
      ok: true,
      reason: null,
      line: 'Our anniversary · 2015-09-12 · annual · gift-giving',
      confirmation: 'Noted Our anniversary as 2015-09-12, right?',
      needsKind: false,
      conflictsWith: ['2015-09-14'],
    }));
    const result = await run({ action: 'propose', title: 'Our anniversary', date: '2015-09-12', kind: 'gift-giving' });
    expect(result.output).toContain('already recorded a different date');
    expect(result.output).toContain('Ask which is right');
  });

  test('confirm refuses without a kind and never reaches the daemon', async () => {
    const { run, calls } = toolWith(() => answers({ ok: true, reason: null, occasionId: 'x', disclosure: '', droppedRecords: 0 }));
    const result = await run({
      action: 'confirm',
      title: 'Our anniversary',
      date: '2015-09-12',
      said: 'our anniversary is the twelfth of September',
      authority: 'owner-direct',
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Ask him which');
    expect(calls).toEqual([]);
  });

  test('confirm forwards the authority and the recording surface unchanged', async () => {
    const { run, calls } = toolWith(() => answers({
      ok: true,
      reason: null,
      occasionId: 'our-anniversary',
      disclosure: 'Recorded your anniversary.',
      droppedRecords: 0,
    }));
    const result = await run({
      action: 'confirm',
      title: 'Our anniversary',
      date: '2015-09-12',
      kind: 'gift-giving',
      person: 'Jane',
      said: 'our anniversary is the twelfth of September',
      authority: 'owner-direct',
    });
    expect(result.success).toBe(true);
    expect(calls[0]?.body).toMatchObject({
      title: 'Our anniversary',
      date: '2015-09-12',
      kind: 'gift-giving',
      person: 'Jane',
      surface: 'agent',
      said: 'our anniversary is the twelfth of September',
      authority: 'owner-direct',
    });
    expect(result.output).toContain('Recorded your anniversary.');
  });

  test('a write with no authority is refused before any call', async () => {
    const { run, calls } = toolWith(() => answers({}));
    const result = await run({ action: 'confirm', title: 'x', date: '01-01', kind: 'neither', said: 'x' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('`authority` is required');
    expect(calls).toEqual([]);
  });

  test('an untrusted authority is forwarded as-is so the daemon refuses it, not laundered', async () => {
    const { run, calls } = toolWith(() => answers({
      ok: false,
      reason: 'A fact from a web page cannot be written to your profile.',
      occasionId: 'x',
      disclosure: '',
      droppedRecords: 0,
    }));
    const result = await run({
      action: 'confirm',
      title: 'Somebody birthday',
      date: '04-04',
      kind: 'gift-giving',
      said: 'the page said so',
      authority: 'web-page',
    });
    expect(calls[0]?.body.authority).toBe('web-page');
    expect(result.success).toBe(false);
    expect(result.output).toContain('cannot be written');
    expect(result.output).toContain('Do not try again with different values');
  });

  test('a recurrence word that is neither once nor annual is refused, not dropped', async () => {
    const { run, calls } = toolWith(() => answers({}));
    const result = await run({ action: 'propose', title: 'x', date: '01-01', recurrence: 'monthly' });
    expect(result.success).toBe(false);
    expect(calls).toEqual([]);
  });

  test('an omitted recurrence is not sent, so the date shape decides', async () => {
    const { run, calls } = toolWith(() => answers({
      ok: true, reason: null, line: 'x', confirmation: 'x', needsKind: false, conflictsWith: [],
    }));
    await run({ action: 'propose', title: 'Dad', date: '11-02', kind: 'remember-only' });
    expect(calls[0]?.body).not.toHaveProperty('recurrence');
  });
});

describe('occasions tool: removal and conflicts', () => {
  test('removal asks once before it happens, and asks nothing else', async () => {
    const { run, calls } = toolWith(() => answers({}));
    const result = await run({ action: 'remove', occasionId: 'sarahs-birthday', authority: 'owner-direct' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('confirmed:true');
    expect(result.output).toContain('Do not ask why, and do not ask twice');
    expect(calls).toEqual([]);
  });

  test('a confirmed removal reports the orphaned records that went with it', async () => {
    const { run, calls } = toolWith(() => answers({
      ok: true,
      reason: null,
      occasionId: 'sarahs-birthday',
      disclosure: 'Removed that date from your profile.',
      droppedRecords: 3,
    }));
    const result = await run({ action: 'remove', occasionId: 'sarahs-birthday', confirmed: true, authority: 'owner-direct' });
    expect(result.success).toBe(true);
    expect(calls[0]?.body).toMatchObject({ occasionId: 'sarahs-birthday', confirmed: true, authority: 'owner-direct' });
    expect(result.output).toContain('3 records');
  });

  test('settling a conflict that was not open says so rather than reporting a fix', async () => {
    const { run } = toolWith(() => answers({ occasionId: 'our-anniversary', resolved: false }));
    const result = await run({ action: 'resolve_conflict', occasionId: 'our-anniversary' });
    expect(result.output).toContain('no open conflict');
    expect(result.output).toContain('rather than reporting it fixed');
  });

  test('a settled conflict changes nothing in his own file', async () => {
    const { run } = toolWith(() => answers({ occasionId: 'our-anniversary', resolved: true }));
    const result = await run({ action: 'resolve_conflict', occasionId: 'our-anniversary' });
    expect(result.output).toContain('stops being raised');
    expect(result.output).toContain('Nothing was changed for him');
  });
});

describe('occasions tool: reads that do carry dates', () => {
  test('list returns dates and says plainly they must not go into anything outbound', async () => {
    const { run } = toolWith(() => answers({
      today: '2026-03-01',
      timezone: 'America/Detroit',
      occasions: [{
        occasion: {
          id: 'sarahs-birthday', title: "Sarah's birthday",
          date: { kind: 'annual', month: 3, day: 14 }, recurrence: 'annual',
          kind: 'gift-giving', person: 'Sarah', leadDays: 21, mirrored: false,
          extras: [], lineIndex: 4, text: '',
        },
        nextOccurrence: '2026-03-14',
        daysUntil: 13,
        leadDays: 21,
        inLeadWindow: true,
        answer: null,
        mirrored: false,
      }],
      unparsed: [],
      conflicts: [],
    }));
    const result = await run({ action: 'list' });
    expect(result.success).toBe(true);
    // §4.3: this IS the explicit ask that unlocks a closed-tier read.
    expect(result.output).toContain('2026-03-14');
    expect(result.output).toContain('Do not put a date from this list into a message');
  });

  test('a line the parser could not read is reported, never rewritten', async () => {
    const { run } = toolWith(() => answers({
      today: '2026-03-01',
      timezone: 'UTC',
      occasions: [],
      unparsed: [{ lineIndex: 7, text: 'Grandma sometime in spring', reason: 'no date I can read' }],
      conflicts: [],
    }));
    const result = await run({ action: 'list' });
    expect(result.output).toContain('Grandma sometime in spring');
    expect(result.output).toContain('never rewrite it silently');
  });

  test('state discloses counts and a corruption reason, never a value', async () => {
    const { run } = toolWith(() => answers({
      path: '/tmp/occasions-state.json',
      acknowledgements: 2,
      giftRecords: 1,
      openItems: 1,
      interviews: 0,
      mirrors: 0,
      lastSweep: null,
      corruption: 'unexpected end of JSON input',
    }));
    const result = await run({ action: 'state' });
    expect(result.output).toContain('unexpected end of JSON input');
    expect(result.output).toContain('It is not an empty store');
  });

  test('gift history is offered as history, not as a recommendation', async () => {
    const { run } = toolWith(() => answers({
      occasionId: 'sarahs-birthday',
      gifts: [{ occasionId: 'sarahs-birthday', occurrence: '2025-03-14', recordedAt: 1, landedOn: 'a pottery class' }],
    }));
    const result = await run({ action: 'gifts', occasionId: 'sarahs-birthday' });
    expect(result.output).toContain('a pottery class');
    expect(result.output).toContain('Do not recommend a repeat');
  });

  test('plans say whether he is away today, and that a plan never prompts', async () => {
    const { run } = toolWith(() => answers({
      today: '2026-09-14',
      plans: [{ id: 'lisbon', title: 'Lisbon', from: '2026-09-12', to: '2026-09-19', away: true, destination: 'Lisbon', extras: [], lineIndex: 2, text: '' }],
      unparsed: [],
      awayNow: { id: 'lisbon', title: 'Lisbon', from: '2026-09-12', to: '2026-09-19', away: true, destination: 'Lisbon', extras: [], lineIndex: 2, text: '' },
    }));
    const result = await run({ action: 'plans' });
    expect(result.output).toContain('He is away today: Lisbon.');
  });
});

describe('occasions tool: sweep', () => {
  test('quiet hours are reported as a hold, and nothing is described as dropped', async () => {
    const { run } = toolWith(() => answers({
      ranAt: 1, today: '2026-03-01', hold: 'quiet-hours', nudge: null,
      conflictMessages: [], resumedInterviews: [], delivered: false,
      deliveryChannel: '', deliveryId: null, deliveries: [], mirrored: 0, housekeeping: null,
    }));
    const result = await run({ action: 'sweep' });
    expect(result.output).toContain('outside his active hours');
    expect(result.output).toContain('Nothing was dropped, it waits');
  });

  test('a disabled feature still ran housekeeping, and says so', async () => {
    const { run } = toolWith(() => answers({
      ranAt: 1, today: '2026-03-01', hold: 'disabled', nudge: null,
      conflictMessages: [], resumedInterviews: [], delivered: false,
      deliveryChannel: '', deliveryId: null, deliveries: [], mirrored: 0, housekeeping: null,
    }));
    const result = await run({ action: 'sweep' });
    expect(result.output).toContain('turned off');
    expect(result.output).toContain('Housekeeping still ran');
  });
});

describe('occasions tool: sweep reports every destination, not an aggregate', () => {
  const base = {
    ranAt: 1, today: '2026-03-01', hold: null,
    nudge: {
      id: 'occasions-1', raisedAt: 1,
      subjects: [{ occasionId: 'sarahs-birthday', title: "Sarah's birthday", person: 'Sarah', kind: 'gift-giving', proximity: 'approaching' }],
      message: "Sarah's birthday is coming up. Do you want to sort something for it?",
      answerable: true,
    },
    conflictMessages: [], resumedInterviews: [], mirrored: 0, housekeeping: null,
  };

  test('a partial failure is reported per channel, never hidden behind delivered:true', async () => {
    // `occasions.nudgeChannel` is a list and each destination is pushed on its
    // own, so the aggregate reads true while Telegram was refused. Reporting only
    // the aggregate is how the one thing he needs to hear disappears.
    const { run } = toolWith(() => answers({
      ...base,
      delivered: true,
      deliveryChannel: 'telegram,agent',
      deliveryId: 'agent-1',
      deliveries: [
        { channel: 'telegram', delivered: false, deliveryId: null, failure: 'bot token rejected' },
        { channel: 'agent', delivered: true, deliveryId: 'agent-1', failure: null },
      ],
    }));
    const result = await run({ action: 'sweep' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('NOT delivered on telegram: bot token rejected');
    expect(result.output).toContain('Delivered on agent.');
    expect(result.output).toContain('A push that did not land is not a delivery');
  });

  test('every destination landing says so, with no failure line', async () => {
    const { run } = toolWith(() => answers({
      ...base,
      delivered: true,
      deliveryChannel: 'telegram,agent',
      deliveryId: 'tg-1',
      deliveries: [
        { channel: 'telegram', delivered: true, deliveryId: 'tg-1', failure: null },
        { channel: 'agent', delivered: true, deliveryId: 'agent-1', failure: null },
      ],
    }));
    const result = await run({ action: 'sweep' });
    expect(result.output).toContain('Delivered on telegram.');
    expect(result.output).toContain('Delivered on agent.');
    expect(result.output).not.toContain('NOT delivered');
    expect(result.output).not.toContain('is not a delivery');
  });

  test('a sweep payload with no deliveries array is refused, not read as zero destinations', async () => {
    // An older daemon that predates the multi-destination outcome would otherwise
    // have every partial failure render as a clean pass.
    const { run } = toolWith(() => answers({
      ...base, delivered: true, deliveryChannel: 'telegram', deliveryId: 'tg-1',
    }));
    const result = await run({ action: 'sweep' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('shape this build does not recognise');
  });
});
