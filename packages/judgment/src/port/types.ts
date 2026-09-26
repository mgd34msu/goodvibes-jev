import type {
  ChoiceCriteria,
  ChoiceQuestion,
  EntryType,
  NoulQuestion,
  Questions,
  ResultFor,
  ScoreCriteria,
  ScoreQuestion,
} from '@typesafe-ai/sdk';

export type {
  ChoiceCriteria,
  ChoiceQuestion,
  ChoiceResponse,
  EntryType,
  JsonValue,
  NoulQuestion,
  NoulResponse,
  Question,
  Questions,
  ResultFor,
  ScoreCriteria,
  ScoreQuestion,
  ScoreResponse,
} from '@typesafe-ai/sdk';

/**
 * Who is asking and why. The port does not send this to the model; the
 * decision log records it so every reading can be traced to its decision.
 */
export interface DecisionContext {
  /** The battery the questions come from. */
  readonly battery?: string;
  readonly batteryVersion?: number;
  /** The pattern or compound that issued the call. */
  readonly pattern?: string;
  /** The decision site in the product or engine. */
  readonly site?: string;
}

/** One call: a state and the named questions to ask about it. */
export interface JudgmentRequest<Q extends Questions> {
  /** Text, a JSON object or an array to evaluate. */
  readonly state: EntryType;
  /** Nonempty questions keyed by the names that identify their answers. */
  readonly questions: Q;
  /** Model override; omitted uses the port's pinned model. */
  readonly model?: string;
  /** Cancels the call and any pending retries. */
  readonly signal?: AbortSignal;
  /** Attribution for the decision log; never sent to the model. */
  readonly context?: DecisionContext;
}

/** Typed answers for one call, with what answered and what it cost. */
export interface JudgmentResult<Q extends Questions> {
  readonly answers: { readonly [K in keyof Q]: ResultFor<Q[K]> };
  /** The model id the request named (an alias or a pinned version). */
  readonly requestedModel: string;
  /** The versioned model id that answered. */
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly latencyMs: number;
  /** The endpoint's request id, when it sent one. */
  readonly requestId: string | undefined;
  /** The decision log entry for this call, when the port records decisions. */
  readonly decisionId?: string;
}

/**
 * Attaches what happened after a call to its decision log entry: the banded
 * readings a battery drew from the answers, and the action code took.
 */
export interface DecisionRecorder {
  recordReadings(decisionId: string, readings: Readonly<Record<string, unknown>>): void;
  recordAction(decisionId: string, action: string): void;
}

/**
 * The one door every decision site uses. Implementations talk to a System
 * One endpoint; decorators add the decision log and other cross-cutting
 * behaviour without changing the contract.
 */
export interface JudgmentPort {
  /** The model this port asks when a request names none. */
  readonly model: string;
  ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>>;
  /** Present when the port records decisions. */
  readonly recorder?: DecisionRecorder;
}

/** Question builders with the same shapes the wire expects. */
export const noul = (
  instructions: EntryType,
  criteria?: { readonly true?: EntryType; readonly false?: EntryType },
): NoulQuestion =>
  criteria === undefined
    ? { type: 'noul', instructions }
    : { type: 'noul', instructions, criteria: { ...criteria } };

export const choice = <const T extends ChoiceCriteria>(
  instructions: EntryType,
  criteria: T,
): ChoiceQuestion<T> => ({ type: 'choice', instructions, criteria });

export const score = <const T extends ScoreCriteria>(
  instructions: EntryType,
  criteria: T,
): ScoreQuestion<T> => ({ type: 'score', instructions, criteria });
