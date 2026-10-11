/**
 * interview.ts, a few questions that guide the owner to a good idea.
 *
 * *"if yes, ask me a few questions to guide me into a good gift idea. i feel
 * like a short interview section would be very useful here."*
 *
 * Three properties, each of which is a decision rather than a detail:
 *
 *  1. **It does not recommend.** The original framing was *"it doesn't need to
 *     make a recommendation"*, and nothing here proposes a gift. It asks
 *     questions. Judgement stays with the owner, which is also why the outcome
 *     is recorded as what THEY landed on rather than what was suggested.
 *  2. **It opens from what the profile already knows.** People and Notes are
 *     prose preserved verbatim; if the owner has mentioned she is into
 *     something, the first question starts there. That is the difference
 *     between useful and generic, and it is why {@link openInterview} takes
 *     profile lines rather than a name.
 *  3. **It is genuinely short.** The question count is a setting with a default
 *     of three. A long one is a form, and the owner will stop answering it.
 *
 * A thread the owner walks away from is a DROPPED thread, not a completion. The steps
 * and the answers so far persist, so resuming picks up at the next unanswered
 * question rather than starting again, that is what makes the open-item loop's
 * third case work.
 */
import { occasionInterest, occasionEntry, OccasionReadingHeldError, OccasionReadingWork } from './readings.js';
import type { ProfileLine } from '../owner-profile/types.js';
import type { IsoDate } from './dates.js';
import type { GiftRecord, Interview, InterviewStep, Occasion } from './types.js';

/** Choose from every supplied line; none is a settled reading, never a keyword fallback. */
export async function interestLine(lines: readonly ProfileLine[], context: { readonly title?: string; readonly person?: string } = {}, work = new OccasionReadingWork()): Promise<string> {
  const source = work.snapshot({ lines, context });
  if (source.lines.length === 0) return '';
  const candidates = source.lines.map((line, index) => ({ id: `line_${index}`, content: occasionEntry(line) }));
  const result = await work.wait(() => occasionInterest.select(work.port, occasionEntry(source.context), candidates, { ...(work.signal ? { signal: work.signal } : {}), site: 'engine.occasions.interest-line' }));
  if (result.outcome !== 'act') throw new OccasionReadingHeldError();
  const index = candidates.findIndex(candidate => candidate.id === result.chosen);
  if (result.chosen !== undefined && index < 0) throw new OccasionReadingHeldError();
  result.recordAction(index < 0 ? 'no grounded interest line' : 'selected an offered interest line');
  work.assertCurrent();
  return index < 0 ? '' : source.lines[index]!.text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
}

export interface OpenInterviewInput {
  readonly occasion: Occasion;
  readonly occurrence: IsoDate;
  readonly now: number;
  /** Profile lines mentioning the person, from `profile.person`. */
  readonly personLines: readonly ProfileLine[];
  /** What the owner landed on in previous years, newest first. */
  readonly history: readonly GiftRecord[];
  /** How many questions to ask. Clamped to at least one. */
  readonly maxQuestions: number;
}

/** Internal content preparation has no newly generated clock or stored clock metadata. */
export type InterviewContentInput = Omit<OpenInterviewInput, 'now' | 'history'> & {
  readonly history: readonly Omit<GiftRecord, 'recordedAt'>[];
};

/** Who the questions are about: the person label, or the occasion's title. */
function subjectOf(occasion: Occasion): string {
  const person = occasion.person.trim();
  return person.length > 0 ? person : occasion.title;
}

/**
 * Build the questions.
 *
 * Order matters: the one grounded in something the owner already told the system comes
 * first, because it is the question that proves the thing was listening. A blank
 * opening question is what makes an interview feel like a form.
 */
export async function interviewSteps(input: InterviewContentInput, work = new OccasionReadingWork()): Promise<readonly InterviewStep[]> {
  input = work.snapshot(input);
  const subject = subjectOf(input.occasion);
  const opener = await interestLine(input.personLines, { title: input.occasion.title, person: subject }, work);
  const previous = input.history[0];
  const steps: InterviewStep[] = [];

  steps.push(opener.length > 0
    ? {
      id: 'direction',
      prompt: `You've mentioned: "${opener}". Is that still a good direction, or has that moved on?`,
      opensFrom: opener,
    }
    : {
      id: 'direction',
      prompt: `What has ${subject} been into lately?`,
      opensFrom: '',
    });

  steps.push(previous !== undefined
    ? {
      id: 'contrast',
      prompt: `Last time you went with ${previous.landedOn}. Something in the same vein, or somewhere different this year?`,
      opensFrom: previous.landedOn,
    }
    : {
      id: 'contrast',
      prompt: 'Something to keep, or something to do together?',
      opensFrom: '',
    });

  steps.push({
    id: 'budget',
    prompt: 'Roughly what are you looking to spend?',
    opensFrom: '',
  });

  return steps.slice(0, Math.max(1, Math.round(input.maxQuestions)));
}

export function interviewIdFor(occasionId: string, occurrence: IsoDate): string {
  return `interview:${occasionId}@${occurrence}`;
}

/** Start an interview. Nothing is asked until a surface renders the first step. */
export async function openInterview(input: OpenInterviewInput, work = new OccasionReadingWork()): Promise<Interview> {
  input = work.snapshot(input);
  const prepared = await prepareInterview(input, work);
  work.assertCurrent();
  return { ...prepared, startedAt: input.now };
}

/** Internal service preparation; owned publication metadata is attached afterward. */
export async function prepareInterview(input: InterviewContentInput, work: OccasionReadingWork): Promise<Omit<Interview, 'startedAt'>> {
  input = work.snapshot(input);
  const steps = await interviewSteps(input, work);
  work.assertCurrent();
  return {
    id: interviewIdFor(input.occasion.id, input.occurrence),
    occasionId: input.occasion.id,
    occurrence: input.occurrence,
    steps,
    answers: [],
  };
}

/**
 * The next unanswered question, or `undefined` when they are all answered.
 *
 * Resumption is exactly this call: an interview reloaded from disk after the
 * owner went quiet mid-thread returns the question they did not get to, not
 * the first one. Re-asking answered questions is how a resumed thread turns
 * into a restarted one.
 */
export function nextStep(interview: Interview): InterviewStep | undefined {
  const answered = new Set(interview.answers.map((answer) => answer.stepId));
  return interview.steps.find((step) => !answered.has(step.id));
}

/** Record one answer. Re-answering a step replaces the earlier answer. */
export function answerStep(
  interview: Interview,
  stepId: string,
  text: string,
  now: number,
): Interview {
  if (!interview.steps.some((step) => step.id === stepId)) return interview;
  const answers = interview.answers.filter((answer) => answer.stepId !== stepId);
  answers.push({ stepId, text, answeredAt: now });
  return { ...interview, answers };
}

/**
 * Close the interview with what the owner landed on.
 *
 * Recording the OUTCOME rather than merely that the owner said yes is the
 * whole point of the history: year three should not steer where year one
 * did, and "the owner said yes in 2026" cannot tell it anything.
 */
export function completeInterview(interview: Interview, landedOn: string, now: number): Interview {
  return { ...interview, landedOn, completedAt: now };
}

/** True when the interview has an outcome. */
export function isComplete(interview: Interview): boolean {
  return interview.completedAt !== undefined;
}

/** The gift record a completed interview produces. */
export function giftRecordFor(interview: Interview): GiftRecord | null {
  if (interview.landedOn === undefined || interview.completedAt === undefined) return null;
  const notes = interview.answers.map((answer) => answer.text).filter((text) => text.length > 0).join(' · ');
  return {
    occasionId: interview.occasionId,
    occurrence: interview.occurrence,
    recordedAt: interview.completedAt,
    landedOn: interview.landedOn,
    ...(notes.length === 0 ? {} : { notes }),
  };
}
