import type { IsoDate } from './dates.js';
import type { SweepHold } from './sweep.js';
import type { NudgeDelivery } from './push.js';
import type { PendingResult as ComposedPending } from './pending.js';
import type { Occasion, OccasionAnswer, OccasionConflict, OccasionNudge, OccasionSweepReport, Plan, InterviewStep, UnparsedOccasionLine, UnparsedPlanLine } from './types.js';

/** One occasion with everything a surface needs to render it. */
export interface OccasionView {
  readonly occasion: Occasion;
  readonly nextOccurrence: IsoDate | null;
  /** Whole days away. Present for a surface that IS the owner, never in a nudge. */
  readonly daysUntil: number | null;
  readonly leadDays: number;
  readonly inLeadWindow: boolean;
  readonly answer: OccasionAnswer | null;
  readonly mirrored: boolean;
}

/** What `occasions.list` answers. */
export interface OccasionListResult {
  readonly today: IsoDate;
  readonly timezone: string;
  readonly occasions: readonly OccasionView[];
  readonly unparsed: readonly UnparsedOccasionLine[];
  readonly conflicts: readonly OccasionConflict[];
}

/** What `occasions.plans.list` answers. */
export interface PlanListResult {
  readonly today: IsoDate;
  readonly plans: readonly Plan[];
  readonly unparsed: readonly UnparsedPlanLine[];
  /** The plan that has the owner away today, if there is one. */
  readonly awayNow: Plan | null;
}

/** What one sweep did. */
export interface SweepOutcome {
  readonly ranAt: number;
  readonly today: IsoDate;
  readonly hold: SweepHold;
  readonly nudge: OccasionNudge | null;
  readonly conflictMessages: readonly string[];
  readonly resumedInterviews: readonly string[];
  /** True when at least one destination accepted the nudge. */
  readonly delivered: boolean;
  /** Every destination it was addressed to, as configured. Empty ⇒ pull-only. */
  readonly deliveryChannel: string;
  /** The id from the first destination that accepted it. */
  readonly deliveryId: string | null;
  /** One entry per destination attempted, in configured order. */
  readonly deliveries: readonly NudgeDelivery[];
  readonly mirrored: number;
  readonly housekeeping: OccasionSweepReport | null;
}

/** What the interview verbs answer. */
export interface InterviewProgress {
  readonly interviewId: string;
  readonly occasionId: string;
  readonly occurrence: IsoDate;
  readonly steps: readonly InterviewStep[];
  readonly nextStep: InterviewStep | null;
  readonly complete: boolean;
  readonly landedOn: string | null;
}

/**
 * Everything outstanding, for a surface that pulls rather than receives.
 *
 * The occasion half is composed by `pending.ts`; the interviews are added here
 * because an interview's progress is this service's shape.
 */
export interface PendingResult extends ComposedPending {
  readonly interviews: readonly InterviewProgress[];
}

