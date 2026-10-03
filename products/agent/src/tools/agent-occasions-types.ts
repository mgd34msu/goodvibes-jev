/**
 * agent-occasions-types.ts, the occasions control-plane payloads, as this
 * surface handles them.
 *
 * The sixteen `occasions.*` verbs (docs/occasions.md §7) are in the platform
 * runtime's generated operator contract, so every request and response type here
 * is the CONTRACT'S type, `OperatorMethodInput` / `OperatorMethodOutput`,
 * rather than a hand-written copy that could drift from it.
 *
 * What the contract types do not do is check anything at runtime. Both routes a
 * call can take hand back `unknown`: the in-process gateway catalog's `invoke`
 * is typed `Promise<unknown>`, and the connected-host route returns a decoded
 * wire payload. So each verb gets one narrower that checks the fields the
 * response is discriminated on and then makes the cast explicit, returning null
 * when the payload is not that shape. A daemon that answers something
 * unexpected, an older build, a proxy, a truncated body, makes the verb say it
 * could not read the answer instead of throwing part-way through a turn.
 *
 * ## What this module deliberately does not hold
 *
 * No proximity thresholds, no lead-window arithmetic, no cadence, no quiet
 * hours, no kind inference, and no message wording for a nudge. Every one of
 * those lives in the daemon (docs/occasions.md §7: a consumer that computed
 * anything beyond calling these verbs and rendering the answers would be a
 * second implementation of a rule that lives there). The one piece of wording
 * this file owns is the unreadable-payload sentence, which is about the
 * TRANSPORT rather than about an occasion.
 */

import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';
import type { AuthoritySurface } from '../trust/untrusted-content.ts';

/**
 * Every write takes one, and the daemon requires it, an absent authority on
 * `occasions.remove` would be a deletion with no gate, exactly as it would be on
 * `profile.forget`. Only `owner-direct` carries write authority; the other
 * members exist so a fact arriving from an untrusted surface names that surface
 * and is refused by the daemon rather than laundered into a spoken one.
 */
export type OccasionsAuthority = AuthoritySurface;

/**
 * The surface name written into a line's provenance suffix. Distinct from the
 * authority: the authority says whether the fact came from HIM, this says which
 * of his surfaces recorded it. The daemon accepts tui, agent, webui, voice and
 * hand-edit; this build is the agent.
 */
export const OCCASIONS_RECORDING_SURFACE = 'agent';

/** The sixteen control-plane verbs, by the ids the daemon registers them under. */
export const OCCASIONS_METHOD_IDS = {
  list: 'occasions.list',
  pending: 'occasions.pending',
  state: 'occasions.state',
  sweep: 'occasions.sweep',
  propose: 'occasions.propose',
  confirm: 'occasions.confirm',
  remove: 'occasions.remove',
  answer: 'occasions.answer',
  interviewGet: 'occasions.interview.get',
  interviewAnswer: 'occasions.interview.answer',
  interviewRecord: 'occasions.interview.record',
  gifts: 'occasions.gifts',
  conflictResolve: 'occasions.conflict.resolve',
  plansList: 'occasions.plans.list',
  plansPropose: 'occasions.plans.propose',
  plansConfirm: 'occasions.plans.confirm',
} as const;

export type OccasionsMethodId = (typeof OCCASIONS_METHOD_IDS)[keyof typeof OCCASIONS_METHOD_IDS];

// ── Actions ────────────────────────────────────────────────────────────────

export type OccasionsAction =
  | 'list' | 'pending' | 'state' | 'gifts' | 'plans'
  | 'answer' | 'interview' | 'interview_answer' | 'interview_record'
  | 'propose' | 'confirm' | 'remove' | 'resolve_conflict'
  | 'plan_propose' | 'plan_confirm' | 'sweep';

export const OCCASIONS_ACTIONS: readonly OccasionsAction[] = [
  'list', 'pending', 'state', 'gifts', 'plans',
  'answer', 'interview', 'interview_answer', 'interview_record',
  'propose', 'confirm', 'remove', 'resolve_conflict',
  'plan_propose', 'plan_confirm', 'sweep',
];

/**
 * The actions that change durable state. Everything else only looks.
 *
 * `answer`, `interview_answer`, `interview_record` and `resolve_conflict` write
 * to the machine-owned acknowledgement store; `confirm`, `plan_confirm` and
 * `remove` write to the owner's own profile file and additionally require an
 * authority. `sweep` is here because a pass reaps, mirrors and delivers.
 */
export const OCCASIONS_WRITE_ACTIONS: ReadonlySet<OccasionsAction> = new Set<OccasionsAction>([
  'answer', 'interview_answer', 'interview_record', 'resolve_conflict',
  'confirm', 'remove', 'plan_confirm', 'sweep',
]);

/** The three that touch the owner's file, and therefore require an authority. */
export const OCCASIONS_PROFILE_WRITE_ACTIONS: ReadonlySet<OccasionsAction> = new Set<OccasionsAction>([
  'confirm', 'remove', 'plan_confirm',
]);

/**
 * One action vocabulary, shared by the tool and by anything that classifies a
 * call as a read or a write. Two copies of this list would let an alias classify
 * as a read on one side and act as a write on the other, which is the wrong
 * direction for a mistake to point.
 *
 * Returns null for anything unrecognised; every caller treats that as a refusal,
 * never as a default action.
 */
export function normalizeOccasionsAction(value: unknown): OccasionsAction | null {
  const raw = (typeof value === 'string' ? value : '').trim().toLowerCase().replace(/[-.]/g, '_');
  if (!raw) return null;
  if (raw === 'list' || raw === 'dates' || raw === 'all') return 'list';
  if (raw === 'pending' || raw === 'outstanding' || raw === 'open') return 'pending';
  if (raw === 'state' || raw === 'status' || raw === 'diagnostics') return 'state';
  if (raw === 'gifts' || raw === 'gift_history' || raw === 'history') return 'gifts';
  if (raw === 'plans' || raw === 'plans_list' || raw === 'travel') return 'plans';
  if (raw === 'answer' || raw === 'reply' || raw === 'respond') return 'answer';
  if (raw === 'interview' || raw === 'interview_get' || raw === 'resume') return 'interview';
  if (raw === 'interview_answer' || raw === 'answer_question') return 'interview_answer';
  if (raw === 'interview_record' || raw === 'landed_on' || raw === 'record') return 'interview_record';
  if (raw === 'propose' || raw === 'draft') return 'propose';
  if (raw === 'confirm' || raw === 'save') return 'confirm';
  if (raw === 'remove' || raw === 'delete' || raw === 'forget') return 'remove';
  if (raw === 'resolve_conflict' || raw === 'conflict_resolve' || raw === 'resolve') return 'resolve_conflict';
  if (raw === 'plan_propose' || raw === 'plans_propose') return 'plan_propose';
  if (raw === 'plan_confirm' || raw === 'plans_confirm') return 'plan_confirm';
  if (raw === 'sweep' || raw === 'run_now') return 'sweep';
  return null;
}

/** The three answers the owner can give. `later` is not a decline (§4.9). */
export type OccasionsAnswerWord = 'yes' | 'no' | 'later';

export const OCCASIONS_ANSWER_WORDS: readonly OccasionsAnswerWord[] = ['yes', 'no', 'later'];

export function isOccasionsAnswerWord(value: unknown): value is OccasionsAnswerWord {
  return typeof value === 'string' && (OCCASIONS_ANSWER_WORDS as readonly string[]).includes(value);
}

/**
 * The three kinds, chosen by him at capture time and NEVER inferred (§4.4).
 *
 * The list is here so the tool can OFFER the three; it is not here so anything
 * can pick one. `occasions.confirm` refuses without a kind, and nothing in this
 * repo supplies a default.
 */
export type OccasionsKindWord = 'gift-giving' | 'remember-only' | 'neither';

export const OCCASIONS_KIND_WORDS: readonly OccasionsKindWord[] = [
  'gift-giving', 'remember-only', 'neither',
];

export function isOccasionsKindWord(value: unknown): value is OccasionsKindWord {
  return typeof value === 'string' && (OCCASIONS_KIND_WORDS as readonly string[]).includes(value);
}

/**
 * How often an occasion comes round. Only these two, and omitting it is normal:
 * the daemon reads a bare `MM-DD` as annual (a date with no year can only mean
 * every year) and a bare `YYYY-MM-DD` as a one-off. Sending a guess where the
 * shape already answers is how a one-off silently becomes annual, so nothing
 * here defaults it.
 */
export type OccasionsRecurrenceWord = 'once' | 'annual';

export const OCCASIONS_RECURRENCE_WORDS: readonly OccasionsRecurrenceWord[] = ['once', 'annual'];

export function isOccasionsRecurrenceWord(value: unknown): value is OccasionsRecurrenceWord {
  return typeof value === 'string' && (OCCASIONS_RECURRENCE_WORDS as readonly string[]).includes(value);
}

// ── Contract payloads ──────────────────────────────────────────────────────

export type OccasionsListResponse = OperatorMethodOutput<'occasions.list'>;
export type OccasionsPendingResponse = OperatorMethodOutput<'occasions.pending'>;
export type OccasionsStateResponse = OperatorMethodOutput<'occasions.state'>;
export type OccasionsSweepResponse = OperatorMethodOutput<'occasions.sweep'>;
/** `occasions.propose` and `occasions.plans.propose` both answer with this. */
export type OccasionsProposalResponse = OperatorMethodOutput<'occasions.propose'>;
/** `occasions.confirm`, `occasions.plans.confirm` and `occasions.remove` share it. */
export type OccasionsWriteResponse = OperatorMethodOutput<'occasions.confirm'>;
export type OccasionsAnswerResponse = OperatorMethodOutput<'occasions.answer'>;
/** The three interview verbs all answer `{ present, interview }`. */
export type OccasionsInterviewResponse = OperatorMethodOutput<'occasions.interview.get'>;
export type OccasionsGiftsResponse = OperatorMethodOutput<'occasions.gifts'>;
export type OccasionsConflictResolveResponse = OperatorMethodOutput<'occasions.conflict.resolve'>;
export type OccasionsPlansResponse = OperatorMethodOutput<'occasions.plans.list'>;

export type OccasionsConfirmInput = OperatorMethodInput<'occasions.confirm'>;
export type OccasionsRemoveInput = OperatorMethodInput<'occasions.remove'>;
export type OccasionsPlansConfirmInput = OperatorMethodInput<'occasions.plans.confirm'>;

/** The batched nudge, exactly as the daemon composed it. Never carries a date. */
export type OccasionsNudgePayload = NonNullable<OccasionsPendingResponse['nudge']>;
export type OccasionsNudgeSubject = OccasionsNudgePayload['subjects'][number];
export type OccasionsPendingConflict = OccasionsPendingResponse['conflicts'][number];
export type OccasionsInterviewProgress = OccasionsPendingResponse['interviews'][number];

// ── Narrowing ──────────────────────────────────────────────────────────────

/** What a narrower's caller says when the payload is not the shape the verb promises. */
export const OCCASIONS_RESPONSE_UNREADABLE =
  'The daemon answered in a shape this build does not recognise. Nothing was read or changed by this call; report that rather than guessing at the answer.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function narrowOccasionsList(value: unknown): OccasionsListResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.today !== 'string' || typeof value.timezone !== 'string') return null;
  if (!Array.isArray(value.occasions) || !Array.isArray(value.conflicts)) return null;
  if (!Array.isArray(value.unparsed)) return null;
  return value as unknown as OccasionsListResponse;
}

/**
 * `nudge` is `null` or an object, both are valid, and the difference is the
 * whole answer, so the check accepts either rather than requiring a nudge.
 */
export function narrowOccasionsPending(value: unknown): OccasionsPendingResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.today !== 'string') return null;
  if (value.nudge !== null && !isRecord(value.nudge)) return null;
  if (!Array.isArray(value.conflicts) || !Array.isArray(value.interviews)) return null;
  return value as unknown as OccasionsPendingResponse;
}

export function narrowOccasionsState(value: unknown): OccasionsStateResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== 'string' || typeof value.acknowledgements !== 'number') return null;
  if (typeof value.openItems !== 'number' || typeof value.interviews !== 'number') return null;
  return value as unknown as OccasionsStateResponse;
}

export function narrowOccasionsSweep(value: unknown): OccasionsSweepResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.today !== 'string' || typeof value.delivered !== 'boolean') return null;
  if (!Array.isArray(value.conflictMessages)) return null;
  // `deliveries` is the per-destination outcome list. Checked here rather than
  // defaulted at the render site: `occasions.nudgeChannel` is a list and each
  // destination is pushed independently, so an aggregate `delivered` can read
  // true while one channel was refused. A build that could not see this array
  // would report a partial failure as a clean delivery.
  if (!Array.isArray(value.deliveries)) return null;
  return value as unknown as OccasionsSweepResponse;
}

export function narrowOccasionsProposal(value: unknown): OccasionsProposalResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.ok !== 'boolean' || typeof value.confirmation !== 'string') return null;
  if (typeof value.needsKind !== 'boolean' || !Array.isArray(value.conflictsWith)) return null;
  return value as unknown as OccasionsProposalResponse;
}

export function narrowOccasionsWrite(value: unknown): OccasionsWriteResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.ok !== 'boolean' || typeof value.occasionId !== 'string') return null;
  if (typeof value.disclosure !== 'string') return null;
  return value as unknown as OccasionsWriteResponse;
}

export function narrowOccasionsAnswer(value: unknown): OccasionsAnswerResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.ok !== 'boolean') return null;
  if (!('interview' in value)) return null;
  return value as unknown as OccasionsAnswerResponse;
}

export function narrowOccasionsInterview(value: unknown): OccasionsInterviewResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.present !== 'boolean') return null;
  if (!('interview' in value)) return null;
  return value as unknown as OccasionsInterviewResponse;
}

export function narrowOccasionsGifts(value: unknown): OccasionsGiftsResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.occasionId !== 'string' || !Array.isArray(value.gifts)) return null;
  return value as unknown as OccasionsGiftsResponse;
}

export function narrowOccasionsConflictResolve(
  value: unknown,
): OccasionsConflictResolveResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.occasionId !== 'string' || typeof value.resolved !== 'boolean') return null;
  return value as unknown as OccasionsConflictResolveResponse;
}

export function narrowOccasionsPlans(value: unknown): OccasionsPlansResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.today !== 'string' || !Array.isArray(value.plans)) return null;
  if (!Array.isArray(value.unparsed)) return null;
  if (value.awayNow !== null && !isRecord(value.awayNow)) return null;
  return value as unknown as OccasionsPlansResponse;
}
