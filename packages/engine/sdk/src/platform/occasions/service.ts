/** One service sequences occasion capture, acknowledgements, interviews and
 * sweeps over the shared profile and machine state. Delivery records belong to
 * each configured destination, so a failed push remains available to pull.
 * Admitted operations retain source and effect restrictions across every await.
 */
import type { OccasionMutationOptions } from './operation.js';
import { captureOccasionOperation, retainOccasionStateReceipts } from './operation.js';
import { OccasionReadingWork, OccasionReadingHeldError } from './readings.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { AuthoritySurface } from '../security/untrusted-content.js';
import type { ProfileSurface, ProfileWriteResult } from '../owner-profile/types.js';
import { daysBetween, nextOccurrence, todayInZone, minutesOfDayInZone, type IsoDate } from './dates.js';
import { conflictItemId, interviewItemId, laterReturnDate, nudgeItemId } from './cadence.js';
import {
  answerStep,
  completeInterview,
  giftRecordFor,
  interviewIdFor,
  nextStep,
  prepareInterview,
} from './interview.js';
import {
  acknowledgeOccurrence,
  acknowledgementReply,
  type OccasionAckSource,
} from './acknowledge.js';
import {
  NUDGE_AGENT_SURFACE,
  nudgeDestinationSurface,
  resolveNudgeDestinations,
} from './destinations.js';
import { composeConflictMessage, prepareNudge, subjectFor } from './nudge.js';
import {
  pushNudge,
  type OccasionNudgeDeliverer,
} from './push.js';
import { storedGiftEvidence } from './stored-reading-evidence.js';
import { preparePending } from './pending.js';
import { readOccasionsPolicy, readOccasionsTimezone, type OccasionsConfigAccess } from './policy.js';
import { readOccasions, readOccasionDeclarations, readPlans, type OccasionProfileSource } from './reader.js';
import type { OccasionStateStore } from './state-store.js';
import { decideSweep, effectiveLead, type OccasionsPolicy } from './sweep.js';
import {
  confirmOccasion,
  confirmPlan,
  proposeOccasion,
  proposePlan,
  removeOccasion,
  type ConfirmOccasionInput,
  type ConfirmPlanInput,
  type OccasionProfileWriter,
  type OccasionProposal,
  type OccasionWriteOutcome,
  type ProposeOccasionInput,
  type ProposePlanInput,
} from './capture.js';
import { OCCASIONS_CONFIG_KEYS } from './types.js';
import type {
  GiftRecord,
  OccasionAcknowledgement,
  Interview,
  Occasion,
  OccasionAnswer,
  OccasionStateDisclosure,
  OpenItem,
  Plan,
} from './types.js';

/**
 * The delivery seam and its per-destination result, re-exported at the seam
 * every consumer already imports from. They live in push.ts; a caller wiring up
 * a deliverer should not have to know which file the sweep was split into.
 */
export type { NudgeDelivery, OccasionNudgeDeliverer } from './push.js';

/**
 * Writing an occasion out to a calendar. Optional, and one-directional.
 *
 * There is no read counterpart and there never will be: a calendar entry is a
 * single occurrence of an ephemeral thing, and feed content from outside the
 * owner is untrusted content. Sourcing a durable fact about their life from one
 * would be wrong twice over.
 *
 * Implementations must be idempotent for a given `(occasionId, occurrence)`.
 * This service also remembers the external id it was handed, so the ordinary
 * path does not call the implementation twice for the same occurrence at all.
 */
export interface OccasionCalendarMirror {
  mirror(input: {
    readonly occasion: Occasion;
    readonly occurrence: IsoDate;
    /** The id previously returned for this occurrence, when there is one. */
    readonly existingExternalId?: string | undefined;
  }): Promise<string | null>;
}

export interface OccasionsServiceDeps {
  readonly signal?: AbortSignal | undefined;
  readonly profile: OccasionProfileSource;
  readonly writer: OccasionProfileWriter;
  readonly state: OccasionStateStore;
  readonly config: OccasionsConfigAccess;
  readonly deliverer?: OccasionNudgeDeliverer | undefined;
  readonly calendar?: OccasionCalendarMirror | undefined;
  readonly now?: (() => number) | undefined;
}

import type { OccasionView, OccasionListResult, PlanListResult, SweepOutcome, InterviewProgress, PendingResult } from './service-views.js';
export type { OccasionView, OccasionListResult, PlanListResult, SweepOutcome, InterviewProgress, PendingResult } from './service-views.js';

export class OccasionsService {
  private readonly answerOwners = new Map<string, AbortController>();
  constructor(private readonly deps: OccasionsServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private timezone(): string {
    return readOccasionsTimezone(this.deps.config);
  }

  private today(): IsoDate {
    return todayInZone(this.now(), this.timezone());
  }

  /** The effective policy, read live on every call. */
  policy(): OccasionsPolicy {
    return readOccasionsPolicy(this.deps.config);
  }

  /** Capture live source/config/function ownership before any asynchronous boundary. */
  private reading(options: OccasionMutationOptions = {}, request: unknown = {}): OccasionReadingWork {
    const profile = this.deps.profile, config = this.deps.config;
    const sourceLease = profile.captureRead?.();
    const configIncarnation = config.getConfigurationIncarnation?.();
    const signal = AbortSignal.any([...(this.deps.signal ? [this.deps.signal] : []), ...(options.signal ? [options.signal] : [])]);
    const functions = [profile.importantDates, profile.plans, profile.ownerNames, profile.person, profile.captureRead, config.get, config.getConfigurationIncarnation];
    const source = () => ({ dates: profile.importantDates(), plans: profile.plans(), names: profile.ownerNames?.() ?? [], config: Object.fromEntries([...Object.values(OCCASIONS_CONFIG_KEYS), 'daemon.timezone'].map(key => [key, config.get(key)])), policy: this.policy(), timezone: this.timezone() });
    const captured = JSON.stringify(snapshotJudgmentInput(source()));
    const work = new OccasionReadingWork({ signal, assertCurrent: () => {
      const checked: unknown = options.assertCurrent?.();
      if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); throw new OccasionReadingHeldError(); }
      sourceLease?.assertCurrent();
      if (config.getConfigurationIncarnation?.() !== configIncarnation) throw new OccasionReadingHeldError();
      const currentFunctions = [profile.importantDates, profile.plans, profile.ownerNames, profile.person, profile.captureRead, config.get, config.getConfigurationIncarnation];
      if (this.deps.profile !== profile || this.deps.config !== config || functions.some((fn, index) => fn !== currentFunctions[index]) || JSON.stringify(snapshotJudgmentInput(source())) !== captured) throw new OccasionReadingHeldError();
    } });
    retainOccasionStateReceipts(work.assertCurrent, options);
    work.snapshot(request);
    return work;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Every declared occasion, with what the machine knows about each.
   *
   * This is the answer a surface renders. It DOES carry the date and the day
   * count, and that is not a contradiction of the never-the-date rule: this is
   * the owner asking their own system what it holds, over an authenticated verb,
   * which is exactly the explicit ask that unlocks a closed-tier read. The rule
   * is about what an unprompted message pushes onto a channel.
   */
  async list(options: OccasionMutationOptions = {}): Promise<OccasionListResult> {
    const work = this.reading(options);
    await this.deps.state.prepareRead(options);
    const today = this.today();
    const policy = this.policy();
    const { occasions, unparsed, conflicts } = await readOccasions(this.deps.profile, work);
    const acknowledgements = await this.deps.state.acknowledgements();
    const views: OccasionView[] = occasions.map((occasion) => {
      const occurrence = nextOccurrence(occasion.date, occasion.recurrence, today);
      const daysUntil = occurrence === null ? null : daysBetween(today, occurrence);
      const lead = effectiveLead(occasion, policy);
      const answer = occurrence === null
        ? null
        : acknowledgements.find(
          (entry) => entry.occasionId === occasion.id && entry.occurrence === occurrence,
        )?.answer ?? null;
      return {
        occasion,
        nextOccurrence: occurrence,
        daysUntil,
        leadDays: lead,
        inLeadWindow: daysUntil !== null && Number.isFinite(daysUntil) && daysUntil <= lead,
        answer,
        mirrored: occasion.mirrored,
      };
    });
    work.assertCurrent();
    return { today, timezone: this.timezone(), occasions: views, unparsed, conflicts };
  }

  /** Every declared plan, and whether one has the owner away right now. */
  listPlans(): PlanListResult {
    const today = this.today();
    const { plans, unparsed } = readPlans(this.deps.profile);
    const awayNow = plans.find((plan) => plan.away && plan.from <= today && today <= plan.to) ?? null;
    return { today, plans, unparsed, awayNow };
  }

  /** What the machine-owned store is holding, and what the last sweep removed. */
  async disclose(options: OccasionMutationOptions = {}): Promise<OccasionStateDisclosure> {
    const owned = captureOccasionOperation(this.deps, options, () => this.deps);
    await this.deps.state.prepareRead(options);
    const result = await this.deps.state.disclose(); owned.assertCurrent?.(); return result;
  }

  /** What the owner landed on before, for one occasion. */
  async giftHistory(occasionId: string, options: OccasionMutationOptions = {}): Promise<readonly GiftRecord[]> {
    const owned = captureOccasionOperation(this.deps, options, () => this.deps);
    await this.deps.state.prepareRead(options);
    const result = await this.deps.state.giftHistory(occasionId); owned.assertCurrent?.(); return result;
  }

  // -------------------------------------------------------------------------
  // Capture, proposed, confirmed once, then silent (see capture.ts)
  // -------------------------------------------------------------------------

  /** What would be written, and the one line to put to the owner. Writes nothing. */
  proposeOccasion(input: ProposeOccasionInput): OccasionProposal {
    return proposeOccasion(this.deps.profile, input);
  }

  /** Write the confirmed occasion. Refuses without a kind rather than guessing. */
  async confirmOccasion(input: ConfirmOccasionInput, options: OccasionMutationOptions = {}): Promise<OccasionWriteOutcome> {
    const owned = captureOccasionOperation(this.deps, options, () => this.deps);
    return confirmOccasion(this.deps.profile, this.deps.writer, input, owned);
  }

  /** The same two-step capture, for a plan. */
  proposePlan(input: ProposePlanInput): OccasionProposal {
    return proposePlan(input);
  }

  async confirmPlan(input: ConfirmPlanInput, options: OccasionMutationOptions = {}): Promise<OccasionWriteOutcome> {
    const owned = captureOccasionOperation(this.deps, options, () => this.deps);
    return confirmPlan(this.deps.writer, input, owned);
  }

  /** Remove an occasion and everything the machine remembered about it. */
  async removeOccasion(input: {
    readonly occasionId: string;
    readonly confirmed: boolean;
    readonly authority: AuthoritySurface | 'autonomous';
  }, options: OccasionMutationOptions = {}): Promise<OccasionWriteOutcome> {
    const owned = captureOccasionOperation(this.deps, options, () => this.deps);
    await this.deps.state.prepareRead(options);
    return removeOccasion(
      this.deps.profile,
      this.deps.writer,
      (id) => this.deps.state.dropOccasion(id, owned.assertCurrent),
      input, owned,
    );
  }

  // -------------------------------------------------------------------------
  // Answers
  // -------------------------------------------------------------------------

  /**
   * Record yes, no or later for one occurrence.
   *
   *  - **no**, silent for the rest of this cycle. The record expires with the
   *    occurrence, so next year asks fresh carrying no memory of the refusal.
   *  - **later**, not a decline. It comes back roughly halfway to the date.
   *  - **yes**, opens the interview, and the answer is what stops the nudging.
   *
   * A one-off carries no expiry: "handled" is permanent for something that
   * happens once.
   */
  async answer(input: {
    readonly occasionId: string;
    readonly answer: OccasionAnswer;
    readonly occurrence?: string | undefined;
  }, options: OccasionMutationOptions = {}): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly interview: InterviewProgress | null }> {
    return this.withAnswerOwnership(input.occasionId, options, owned => this.answerOwned(input, owned));
  }

  /** A later response for this occasion retires earlier work, including an unfinished gift reading. */
  private async withAnswerOwnership<T>(key: string, options: OccasionMutationOptions, run: (owned: OccasionMutationOptions) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.answerOwners.get(key)?.abort();
    this.answerOwners.set(key, controller);
    const signal = AbortSignal.any([controller.signal, ...(this.deps.signal ? [this.deps.signal] : []), ...(options.signal ? [options.signal] : [])]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.answerOwners.get(key) !== controller) throw new OccasionReadingHeldError();
      const checked: unknown = options.assertCurrent?.();
      if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); throw new OccasionReadingHeldError(); }
    };
    retainOccasionStateReceipts(assertCurrent, options);
    try {
      assertCurrent();
      return await run({ ...options, signal, assertCurrent });
    } finally { if (this.answerOwners.get(key) === controller) this.answerOwners.delete(key); }
  }

  private async answerOwned(input: {
    readonly occasionId: string;
    readonly answer: OccasionAnswer;
    readonly occurrence?: string | undefined;
  }, options: OccasionMutationOptions = {}): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly interview: InterviewProgress | null }> {
    const work = this.reading(options, input);
    await this.deps.state.prepareRead(options);
    input = work.snapshot(input);
    const today = this.today();
    const now = this.now();
    const occasion = readOccasionDeclarations(this.deps.profile).occasions.find(
      (entry) => entry.id === input.occasionId,
    );
    if (occasion === undefined) {
      return { ok: false, reason: 'There is no occasion by that name.', interview: null };
    }
    const occurrence = input.occurrence ?? nextOccurrence(occasion.date, occasion.recurrence, today);
    if (occurrence === null) {
      return { ok: false, reason: 'That occasion has no upcoming date.', interview: null };
    }

    const answer: OccasionAcknowledgement = {
      id: `${occasion.id}@${occurrence}`,
      occasionId: occasion.id,
      occurrence,
      answer: input.answer,
      answeredAt: now,
      ...(occasion.recurrence === 'annual' ? { expiresAfter: occurrence } : {}),
      ...(input.answer === 'later' ? { returnOn: laterReturnDate(today, occurrence) } : {}),
    };

    if (input.answer === 'yes' && occasion.kind === 'gift-giving') {
      await this.deps.state.disclose(); work.assertCurrent();
      this.deps.state.assertGiftReadingAdmission(occasion.id);
      let historyCurrent = this.deps.state.captureGiftRead(occasion.id).assertCurrent;
      work.retain(() => historyCurrent());
      const published = () => { historyCurrent = this.deps.state.captureGiftRead(occasion.id).assertCurrent; };
      const interview = await this.startInterview(occasion, occurrence, now, work);
      work.assertCurrent();
      await this.deps.state.recordInterviewAnswer(answer, interview, nudgeItemId(occasion.id, occurrence), work.assertCurrent, published);
      work.assertCurrent();
      return { ok: true, reason: null, interview: progressOf(interview) };
    }
    await this.deps.state.recordAnswer(answer, work.assertCurrent);
    work.assertCurrent();

    if (input.answer === 'later') {
      // The open item stays OPEN and moves; "later" is an answer to this
      // moment, not to the question.
      //
      // It also RETURNS THE LEAD BOUNDARY, and that is not a hole in the
      // two-raise ceiling. The ceiling exists to stop an item the owner has ignored
      // from repeating at them; "come back nearer the time" is the opposite of
      // ignoring it, it is an instruction, and a system that took the
      // instruction and then stayed silent because it had used up its two
      // turns would be worse than one that never offered "later" at all.
      const item = await this.deps.state.openItem(nudgeItemId(occasion.id, occurrence));
      if (item !== undefined) {
        await this.deps.state.putOpenItem({
          ...item,
          servedBoundaries: [],
          dueOn: laterReturnDate(today, occurrence),
        }, work.assertCurrent);
      }
      return { ok: true, reason: null, interview: null };
    }

    await this.deps.state.resolveOpenItem(nudgeItemId(occasion.id, occurrence), work.assertCurrent);
    work.assertCurrent();
    return { ok: true, reason: null, interview: null };
  }

  // -------------------------------------------------------------------------
  // The interview
  // -------------------------------------------------------------------------

  private async startInterview(
    occasion: Occasion,
    occurrence: IsoDate,
    now: number,
    work: OccasionReadingWork,
  ): Promise<Interview> {
    const existing = await this.deps.state.activeInterview(occasion.id, occurrence);
    work.assertCurrent();
    if (existing !== undefined) return existing;
    this.deps.state.assertGiftReadingAdmission(occasion.id);
    const policy = this.policy();
    const subject = occasion.person.trim().length > 0 ? occasion.person : occasion.title;
    const personLines = await work.wait(async () => this.deps.profile.person(subject, { signal: work.signal, assertCurrent: work.assertCurrent, retain: check => work.retain(check) }));
    const history = await work.wait(() => this.deps.state.giftHistory(occasion.id));
    const interview = await prepareInterview({
      occasion,
      occurrence,
      personLines,
      history: storedGiftEvidence(history, work),
      maxQuestions: policy.interviewQuestions,
    }, work);
    work.assertCurrent();
    return { ...interview, startedAt: now };
  }

  /** The interview for one occasion, resumed at the question the owner did not answer. */
  async interview(interviewId: string, options: OccasionMutationOptions = {}): Promise<InterviewProgress | null> {
    const owned = captureOccasionOperation(this.deps, options, () => this.deps);
    await this.deps.state.prepareRead(options);
    const found = await this.deps.state.interview(interviewId);
    owned.assertCurrent?.();
    return found === undefined ? null : progressOf(found);
  }

  /** Record one answer and hand back the next question, if there is one. */
  async answerInterview(input: {
    readonly interviewId: string;
    readonly stepId: string;
    readonly text: string;
  }, options: OccasionMutationOptions = {}): Promise<InterviewProgress | null> {
    const owned = captureOccasionOperation(this.deps, options, () => this.deps);
    await this.deps.state.prepareRead(options);
    const found = await this.deps.state.interview(input.interviewId);
    owned.assertCurrent?.();
    if (found === undefined) return null;
    const updated = answerStep(found, input.stepId, input.text, this.now());
    await this.deps.state.putInterview(updated, owned.assertCurrent);
    // Working on the gift IS acknowledging the occasion. Being asked whether the
    // owner has thought about a birthday while they are in the middle of answering
    // questions about what to buy for it would be the feature interrupting its
    // own interview, so engagement here mutes the push by itself, no verb, no
    // extra sentence from them, nothing to remember to do.
    await this.autoAcknowledgeFromGiftFlow(updated.occasionId, updated.occurrence, owned);
    owned.assertCurrent?.(); return progressOf(updated);
  }

  /** Mute the push for an occurrence the owner is actively choosing a gift for. */
  private async autoAcknowledgeFromGiftFlow(
    occasionId: string,
    occurrence: IsoDate,
    options: OccasionMutationOptions = {},
  ): Promise<void> {
    const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
    retainOccasionStateReceipts(assertCurrent, options);
    assertCurrent();
    const occasion = readOccasionDeclarations(this.deps.profile).occasions.find(
      (entry) => entry.id === occasionId,
    );
    if (occasion === undefined) return;
    // A `yes` or a `no` already settled this occurrence, and both say MORE than
    // an acknowledgement does, a `yes` is what opened this interview in the
    // first place, and overwriting it would erase the record the interview
    // machinery reads to know the thread is live. Only an unanswered or
    // deferred occurrence needs the mute.
    const existing = await this.deps.state.answerFor(occasionId, occurrence);
    assertCurrent();
    if (existing?.answer === 'yes' || existing?.answer === 'no') return;
    await acknowledgeOccurrence({
      recordAnswer: entry => this.deps.state.recordAnswer(entry, assertCurrent),
      openItem: async id => { const result = await this.deps.state.openItem(id); assertCurrent(); return result; },
      putOpenItem: item => this.deps.state.putOpenItem(item, assertCurrent),
    }, {
      occasion,
      occurrence,
      now: this.now(),
      source: 'gift-flow',
    });
    assertCurrent();
  }

  /**
   * Close the interview with what the owner landed on, and write the gift history.
   *
   * Recording the OUTCOME is the point: "the owner said yes in 2026" cannot stop year
   * three steering where year one did, and a history that only holds answers is
   * a history of questions.
   */
  async recordGiftOutcome(input: {
    readonly interviewId: string;
    readonly landedOn: string;
  }, options: OccasionMutationOptions = {}): Promise<InterviewProgress | null> {
    const owned = captureOccasionOperation(this.deps, options, () => this.deps);
    await this.deps.state.prepareRead(options);
    const found = await this.deps.state.interview(input.interviewId);
    owned.assertCurrent?.();
    if (found === undefined) return null;
    const completed = completeInterview(found, input.landedOn.trim(), this.now());
    await this.deps.state.putInterview(completed, owned.assertCurrent);
    const record = giftRecordFor(completed);
    if (record !== null) await this.deps.state.recordGift(record, owned.assertCurrent);
    await this.deps.state.resolveOpenItem(interviewItemId(completed.occasionId, completed.occurrence), owned.assertCurrent);
    owned.assertCurrent?.(); return progressOf(completed);
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * One pass: reap, decide, mirror, deliver, remember.
   *
   * Housekeeping runs FIRST and unconditionally, before the enabled check and
   * before quiet hours, because a store that only reaps when the feature is
   * allowed to speak is a store that never reaps on a machine where the owner turned
   * nudging off.
   */
  async sweep(options: OccasionMutationOptions = {}): Promise<SweepOutcome> {
    const work = this.reading(options);
    await this.deps.state.prepareRead(options);
    const now = this.now();
    const today = todayInZone(now, this.timezone());
    const policy = this.policy();
    let { occasions, conflicts } = readOccasionDeclarations(this.deps.profile);
    const { plans } = readPlans(this.deps.profile);

    const housekeeping = await this.deps.state.sweep({
      today,
      now,
      declaredOccasionIds: new Set(occasions.map((entry) => entry.id)),
      giftHistoryYears: policy.giftHistoryYears,
    }, work.assertCurrent);

    ({ occasions, conflicts } = await readOccasions(this.deps.profile, work));
    const mirrored = policy.calendarMirror ? await this.runMirror(occasions, today, now, work) : 0;
    let stateCurrent = this.deps.state.captureRead().assertCurrent;
    work.retain(() => stateCurrent());
    const published = () => { stateCurrent = this.deps.state.captureRead().assertCurrent; };
    const decision = decideSweep({
      now,
      today,
      minutesOfDay: minutesOfDayInZone(now, this.timezone()),
      occasions,
      conflicts,
      plans,
      acknowledgements: await this.deps.state.acknowledgements(),
      openItems: await this.deps.state.openItems(),
      interviews: await this.interviewsInFlight(),
      policy,
    });

    work.assertCurrent();
    if (decision.hold !== null) {
      return {
        ranAt: now,
        today,
        hold: decision.hold,
        nudge: null,
        conflictMessages: [],
        resumedInterviews: [],
        delivered: false,
        deliveryChannel: '',
        deliveryId: null,
        deliveries: [],
        mirrored,
        housekeeping,
      };
    }


    const preparedNudge = decision.due.length === 0
      ? null
      : await prepareNudge(decision.due.map((entry) => subjectFor(entry.occasion, entry.daysUntil)), work);
    work.assertCurrent();
    const nudge = preparedNudge === null ? null : { ...preparedNudge, id: `occasions-${now}`, raisedAt: now };
    await this.deps.state.putOpenItems(decision.openItemWrites, work.assertCurrent, published);

    const conflictMessages = decision.conflicts.map(
      (conflict) => composeConflictMessage(conflict.title, conflict.dates),
    );

    const destinations = resolveNudgeDestinations(policy.nudgeChannel);
    const deliveries = nudge === null
      ? []
      : await pushNudge(this.deps.deliverer, nudge, destinations, work.assertCurrent, options.withNudgeDelivery);
    work.assertCurrent();
    const landed = deliveries.filter((entry) => entry.delivered);
    // Only a push that ACTUALLY landed on the agent stamps the items. A stamp
    // written on an attempt would silence the pull for a nudge that never
    // arrived anywhere, which is the one outcome this feature cannot have.
    if (landed.some((entry) => nudgeDestinationSurface(entry.channel) === NUDGE_AGENT_SURFACE)) {
      await this.deps.state.putOpenItems(
        decision.openItemWrites.filter(item => item.kind === 'nudge').map(item => ({ ...item, agentPushedOn: today })),
        work.assertCurrent, published,
      );
    }

    work.assertCurrent();
    return {
      ranAt: now,
      today,
      hold: null,
      nudge,
      conflictMessages,
      resumedInterviews: decision.resumeInterviews.map((entry) => entry.id),
      delivered: landed.length > 0,
      deliveryChannel: destinations.join(', '),
      deliveryId: landed[0]?.deliveryId ?? null,
      deliveries,
      mirrored,
      housekeeping,
    };
  }

  /** Unfinished interviews, for the resume case. */
  private async interviewsInFlight(): Promise<readonly Interview[]> {
    const items = await this.deps.state.openItems();
    const found: Interview[] = [];
    for (const item of items) {
      if (item.kind !== 'interview') continue;
      const interview = await this.deps.state.interview(
        interviewIdFor(item.occasionId, item.occurrence),
      );
      if (interview !== undefined && interview.completedAt === undefined) found.push(interview);
    }
    // An interview that has no open item yet, one just started by a `yes`,
    // is also in flight, and is what creates the item on the next sweep.
    const started = await this.deps.state.acknowledgements();
    for (const ack of started) {
      if (ack.answer !== 'yes') continue;
      const id = interviewIdFor(ack.occasionId, ack.occurrence);
      if (found.some((entry) => entry.id === id)) continue;
      const interview = await this.deps.state.interview(id);
      if (interview !== undefined && interview.completedAt === undefined) found.push(interview);
    }
    return found;
  }

  /**
   * Write occasions out to the calendar, once each.
   *
   * A previously recorded external id is passed back to the implementation so
   * the mirror is idempotent even where the calendar itself has no natural key,
   * and an occurrence already mirrored is not offered again at all.
   */
  private async runMirror(
    occasions: readonly Occasion[],
    today: IsoDate,
    now: number,
    work: OccasionReadingWork,
  ): Promise<number> {
    const mirror = this.deps.calendar;
    if (mirror === undefined) return 0;
    let count = 0;
    for (const occasion of occasions) {
      if (occasion.kind === 'neither') continue;
      const occurrence = nextOccurrence(occasion.date, occasion.recurrence, today);
      if (occurrence === null) continue;
      const existing = await this.deps.state.mirrorFor(occasion.id, occurrence);
      if (existing !== undefined) continue;
      work.assertCurrent();
      const externalId = await mirror.mirror({ occasion, occurrence });
      work.assertCurrent();
      if (externalId === null) continue;
      await this.deps.state.recordMirror({
        occasionId: occasion.id,
        occurrence,
        externalId,
        mirroredAt: now,
      }, work.assertCurrent);
      count += 1;
    }
    return count;
  }

  /**
   * Everything outstanding, without delivering anything.
   *
   * This is how a surface that is not a push destination receives a nudge: it
   * pulls what is open at the top of a turn rather than being pushed at. A
   * stored date is the prior scheduling that permits raising something
   * unprompted, which is what keeps this consistent with the agent being
   * conversation-first.
   *
   * When the agent IS a configured push destination, an item a push has already
   * landed there is left out. The push and the pull are two ways of getting the
   * same thing to the same conversation, and doing both would have the agent
   * raise one birthday twice. The condition is the LANDED push rather than the
   * configuration: an item no push has ever landed on the agent, because the
   * sender is not registered, or because the send failed, carries no stamp and
   * still comes back here, so the guard cannot turn into a way of dropping a
   * nudge.
   */
  async pending(options: OccasionMutationOptions = {}): Promise<PendingResult> {
    const work = this.reading(options);
    await this.deps.state.prepareRead(options);
    await this.deps.state.disclose();
    this.deps.state.assertPendingReadingAdmission();
    work.assertCurrent();
    work.retain(this.deps.state.captureRead().assertCurrent);
    const policy = this.policy();
    const { occasions, conflicts } = await readOccasions(this.deps.profile, work);
    const now = this.now();
    const composed = await preparePending({
      today: this.today(),
      leadDays: policy.leadDays,
      occasions,
      conflicts,
      openItems: await this.deps.state.openItems(),
      acknowledgements: await this.deps.state.acknowledgements(),
      agentIsPushed: resolveNudgeDestinations(policy.nudgeChannel).some(
        (destination) => nudgeDestinationSurface(destination) === NUDGE_AGENT_SURFACE,
      ),
    }, work);
    const interviews = (await this.interviewsInFlight()).map(progressOf);
    work.assertCurrent();
    return { ...composed, nudge: composed.nudge === null ? null : { ...composed.nudge, id: `occasions-pending-${composed.today}`, raisedAt: now }, interviews };
  }

  /**
   * Record that the owner has one occurrence in hand. See acknowledge.ts.
   *
   * Deliberately NOT a fourth value routed through {@link answer}: a `yes` or a
   * `no` resolves the open item and removes it, and this one must leave it
   * standing. Same store, different promise.
   */
  async acknowledge(input: {
    readonly occasionId: string;
    readonly source: OccasionAckSource;
    readonly occurrence?: string | undefined;
  }, options: OccasionMutationOptions = {}): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly reply: string }> {
    return this.withAnswerOwnership(input.occasionId, options, owned => this.acknowledgeOwned(input, owned));
  }

  private async acknowledgeOwned(input: {
    readonly occasionId: string;
    readonly source: OccasionAckSource;
    readonly occurrence?: string | undefined;
  }, options: OccasionMutationOptions = {}): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly reply: string }> {
    input = snapshotJudgmentInput(input) as typeof input;
    const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
    retainOccasionStateReceipts(assertCurrent, options);
    assertCurrent();
    const today = this.today();
    const occasion = readOccasionDeclarations(this.deps.profile).occasions.find(
      (entry) => entry.id === input.occasionId,
    );
    if (occasion === undefined) {
      return { ok: false, reason: 'There is no occasion by that name.', reply: '' };
    }
    const occurrence = input.occurrence
      ?? nextOccurrence(occasion.date, occasion.recurrence, today);
    if (occurrence === null) {
      return { ok: false, reason: 'That occasion has no upcoming date.', reply: '' };
    }
    await acknowledgeOccurrence({
      recordAnswer: entry => this.deps.state.recordAnswer(entry, assertCurrent),
      openItem: async id => { const item = await this.deps.state.openItem(id); assertCurrent(); return item; },
      putOpenItem: item => this.deps.state.putOpenItem(item, assertCurrent),
    }, {
      occasion,
      occurrence,
      now: this.now(),
      source: input.source,
    });
    assertCurrent();
    return { ok: true, reason: null, reply: acknowledgementReply(occasion.title) };
  }

  /** Mark a conflict as dealt with, so it stops being re-raised. */
  async resolveConflict(occasionId: string, options: OccasionMutationOptions = {}): Promise<boolean> {
    const owned = captureOccasionOperation(this.deps, options, () => this.deps);
    await this.deps.state.prepareRead(options);
    const result = await this.deps.state.resolveOpenItem(conflictItemId(occasionId), owned.assertCurrent); owned.assertCurrent?.(); return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function progressOf(interview: Interview): InterviewProgress {
  const step = nextStep(interview);
  return {
    interviewId: interview.id,
    occasionId: interview.occasionId,
    occurrence: interview.occurrence,
    steps: interview.steps,
    nextStep: step ?? null,
    complete: interview.completedAt !== undefined,
    landedOn: interview.landedOn ?? null,
  };
}

