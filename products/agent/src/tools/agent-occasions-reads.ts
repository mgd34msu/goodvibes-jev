/**
 * agent-occasions-reads.ts, the `occasions` tool's five reads, and the one
 * renderer the interview shares with them.
 *
 * Split from agent-occasions-tool.ts at this repo's 800-line file cap. The cut is
 * along the grain: everything here only LOOKS, so nothing here takes an authority
 * and nothing here can refuse a write. The interview renderer sits with them
 * because `pending` is one of its two callers, an interview left mid-thread is
 * part of what is outstanding, and a second copy beside the answer handlers
 * would be a second wording for the same question.
 *
 * Two of these reads are the only place in this surface a DATE appears at all:
 * `list` and `plans`. That is docs/occasions.md §4.3's explicit exception, him
 * asking his own system over an authenticated verb, and `list`'s output says in
 * so many words that those dates do not go into anything outbound. `pending`, the
 * read a nudge actually comes from, carries no date to print.
 */

import {
  narrowOccasionsGifts,
  narrowOccasionsList,
  narrowOccasionsPending,
  narrowOccasionsPlans,
  narrowOccasionsState,
  OCCASIONS_ANSWER_WORDS,
  OCCASIONS_METHOD_IDS,
  OCCASIONS_RESPONSE_UNREADABLE,
  type OccasionsInterviewResponse,
} from './agent-occasions-types.ts';
import {
  fail,
  ok,
  type AgentOccasionsToolDeps,
  type ToolOutcome,
} from './agent-occasions-outcome.ts';

// ── The interview renderer, shared with the answer handlers ────────────────

export function renderInterviewLines(
  interviewId: string,
  nextStep: { readonly id: string; readonly prompt: string; readonly opensFrom: string } | null,
  complete: boolean,
  landedOn: string | null,
): readonly string[] {
  if (complete) {
    return [
      `Interview ${interviewId} is finished. He landed on: ${landedOn ?? '(nothing recorded)'}.`,
      'It is written to his gift history. Nothing more to ask.',
    ];
  }
  if (nextStep === null) {
    return [
      `Interview ${interviewId} has no question left to ask, and nothing recorded as landed on.`,
      'Ask him what he settled on and close it with action:"interview_record".',
    ];
  }
  const lines = [
    `Interview ${interviewId}, ask him this, as written: ${nextStep.prompt}`,
    `  Record his answer with action:"interview_answer", stepId:"${nextStep.id}".`,
  ];
  if (nextStep.opensFrom) {
    lines.push(`  This question was opened from his own profile: ${nextStep.opensFrom}`);
  }
  lines.push('You are not making the recommendation. Guide him to his own answer, then record it.');
  return lines;
}

export function renderInterviewResponse(response: OccasionsInterviewResponse, missing: string): ToolOutcome {
  if (!response.present || response.interview === null) return ok([missing]);
  const interview = response.interview;
  return ok(renderInterviewLines(
    interview.interviewId,
    interview.nextStep,
    interview.complete,
    interview.landedOn,
  ));
}


// ── Reads ──────────────────────────────────────────────────────────────────

export async function handleList(deps: AgentOccasionsToolDeps): Promise<ToolOutcome> {
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.list, {});
  if (!result.ok) return fail(['Could not read your dates.', `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsList(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);

  const lines: string[] = [`Your dates (today is ${response.today}, ${response.timezone}):`];
  if (response.occasions.length === 0) lines.push('  (none recorded)');
  for (const view of response.occasions) {
    const occasion = view.occasion;
    const person = occasion.person ? ` · for ${occasion.person}` : '';
    const window = view.inLeadWindow ? ' · inside its lead window' : '';
    const answered = view.answer ? ` · you already said ${view.answer}` : '';
    const away = view.nextOccurrence ?? 'no upcoming date';
    lines.push(
      `  ${occasion.title} · ${away} · ${occasion.recurrence} · ${occasion.kind}${person}`
      + `${window}${answered}${occasion.mirrored ? ' · mirrored to your calendar' : ''}`,
    );
  }
  for (const unparsed of response.unparsed) {
    lines.push(`  [line ${unparsed.lineIndex} could not be read: ${unparsed.reason}] ${unparsed.text}`);
    lines.push('   That line is kept exactly as he wrote it. Offer to fix it; never rewrite it silently.');
  }
  for (const conflict of response.conflicts) {
    lines.push(`  [conflict] ${conflict.title} has ${conflict.dates.length} different dates recorded.`);
    lines.push('   Nothing has been changed. Ask which is right; the newer value is never taken silently.');
  }
  // §4.3: the dates above are a closed-tier read, unlocked because he asked his
  // own system. They answer HIM. They do not go into anything outbound.
  lines.push(
    'These dates are for answering him directly. Do not put a date from this list into a message,'
    + ' an email, a channel reply or any other outbound text.',
  );
  return ok(lines);
}

export async function handlePending(deps: AgentOccasionsToolDeps): Promise<ToolOutcome> {
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.pending, {});
  if (!result.ok) return fail(['Could not read what is outstanding.', `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsPending(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);

  const lines: string[] = [];
  const nudge = response.nudge;
  if (nudge !== null) {
    // Verbatim. The proximity is already a word rather than a count of days, and
    // there is no date in this payload to add even by accident.
    lines.push(`Outstanding, say it as written: ${nudge.message}`);
    if (nudge.answerable) {
      lines.push(`  He can answer ${OCCASIONS_ANSWER_WORDS.join(' / ')}. Relay it with action:"answer".`);
      lines.push('  "later" is not a no, it comes back on its own, roughly halfway to the date.');
    } else {
      lines.push('  This one is a statement, not a question. Do not offer him a yes/no.');
    }
    for (const subject of nudge.subjects) {
      lines.push(`  occasionId ${subject.occasionId} · ${subject.title}${subject.person ? ` · ${subject.person}` : ''} · ${subject.kind}`);
    }
  }
  for (const conflict of response.conflicts) {
    lines.push(`Conflict, say it as written: ${conflict.message}`);
    lines.push(`  When he settles it, call action:"resolve_conflict" with occasionId:"${conflict.occasionId}".`);
  }
  for (const interview of response.interviews) {
    lines.push(renderInterviewLines(interview.interviewId, interview.nextStep, interview.complete, interview.landedOn).join('\n'));
  }
  if (lines.length === 0) {
    return ok(['Nothing is outstanding. Do not raise a date he has not asked about.']);
  }
  return ok(lines);
}

export async function handlePlans(deps: AgentOccasionsToolDeps): Promise<ToolOutcome> {
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.plansList, {});
  if (!result.ok) return fail(['Could not read your plans.', `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsPlans(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);

  const lines: string[] = [`Your plans (today is ${response.today}):`];
  if (response.plans.length === 0) lines.push('  (none recorded)');
  for (const plan of response.plans) {
    const where = plan.destination ? ` · in ${plan.destination}` : '';
    lines.push(`  ${plan.title} · ${plan.from}..${plan.to}${plan.away ? ' · away' : ''}${where}`);
  }
  for (const unparsed of response.unparsed) {
    lines.push(`  [line ${unparsed.lineIndex} could not be read: ${unparsed.reason}] ${unparsed.text}`);
  }
  lines.push(response.awayNow === null
    ? '  He is not away today.'
    : `  He is away today: ${response.awayNow.title}.`);
  return ok(lines);
}

export async function handleState(deps: AgentOccasionsToolDeps): Promise<ToolOutcome> {
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.state, {});
  if (!result.ok) return fail(['Could not read the occasions store.', `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsState(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  const lines = [
    `Occasions store: ${response.path}`,
    `  ${response.acknowledgements} recorded answers, ${response.openItems} still open,`
    + ` ${response.interviews} interviews, ${response.giftRecords} gift records, ${response.mirrors} calendar mirrors.`,
  ];
  if (response.corruption !== null) {
    lines.push(`  The file existed and could not be read: ${response.corruption}`);
    lines.push('  Say that. It is not an empty store.');
  }
  const swept = response.lastSweep;
  if (swept) {
    lines.push(
      `  Last housekeeping pass dropped: ${swept.expiredAcknowledgements} expired answers,`
      + ` ${swept.orphanedRecords} orphaned records, ${swept.expiredOpenItems} expired open items,`
      + ` ${swept.agedGiftRecords} aged gift records, ${swept.droppedInterviews} interviews,`
      + ` ${swept.staleMirrors} stale mirrors.`,
    );
  }
  // Counts and reasons only, by design, this verb discloses what the machine
  // holds, not what it holds ABOUT anyone.
  return ok(lines);
}

export async function handleGifts(deps: AgentOccasionsToolDeps, occasionId: string): Promise<ToolOutcome> {
  if (!occasionId) return fail(['`occasionId` is required: which occasion\'s history to read.']);
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.gifts, { occasionId });
  if (!result.ok) return fail([`Could not read gift history for ${occasionId}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsGifts(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  if (response.gifts.length === 0) {
    return ok([`No gift history recorded for ${response.occasionId} yet.`]);
  }
  const lines = [`What he landed on before, for ${response.occasionId}:`];
  for (const gift of response.gifts) {
    lines.push(`  ${gift.occurrence}: ${gift.landedOn}${gift.notes ? ` (${gift.notes})` : ''}`);
  }
  lines.push('This is here so a later year is not steered by an earlier one. Do not recommend a repeat.');
  return ok(lines);
}

