import type { JudgmentErrorKind } from './errors.ts';
import type {
  JsonValue,
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
  ModelCard,
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
  /** The calibration fixture a calibration call runs. */
  readonly fixture?: string;
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
  /** Synchronous current-authority check before every wire attempt, including retries. */
  readonly beforeAttempt?: () => void;
  /** Optional asynchronous admission before every wire attempt; the synchronous guard runs afterward. */
  readonly beforeAsyncAttempt?: () => void | Promise<void>;
  /**
   * Synchronous permission to hash and retain this call. The recording port
   * checks before capture/hash and every answered or failed entry. A throw or
   * non-undefined return refuses retention without writing a failure entry.
   * Omitted preserves normal recording, including cancelled-call failures.
   */
  readonly assertLogCurrent?: () => void;
  /** Observes temporary unavailability without settling the reading. Observer errors are ignored. */
  readonly onRetry?: (progress: JudgmentRetryProgress) => void;
  /** Attribution for the decision log; never sent to the model. */
  readonly context?: DecisionContext;
}

/** Credential-free evidence of one actual wire attempt in a logical reading. */
export interface JudgmentAttempt {
  readonly attempt: number;
  /** Zero is the primary, then the configured fallback order. No addresses are stored. */
  readonly endpointIndex: number;
  readonly endpointKind: 'hosted' | 'local';
  readonly requestedModel: string;
  readonly latencyMs: number;
  readonly outcome: 'answered' | JudgmentErrorKind;
  readonly requestId?: string;
  readonly status?: number;
}

/** Credential-free waiting state for one failed wire attempt, never permission to act. */
export interface JudgmentRetryProgress {
  readonly logicalRequestId: string;
  readonly attempt: JudgmentAttempt;
  readonly elapsedMs: number;
  readonly nextDelayMs: number;
}

export interface JudgmentLineage {
  readonly logicalRequestId: string;
  /** Most recent attempts; earlier detail is bounded during an arbitrarily long outage. */
  readonly attempts: readonly JudgmentAttempt[];
  readonly omittedAttempts?: number;
}

/** Observed health only; it never authorizes an unconfigured target or changes order. */
export interface JudgmentEndpointHealth {
  readonly endpointIndex: number;
  readonly endpointKind: 'hosted' | 'local';
  readonly model: string;
  readonly attempts: number;
  readonly consecutiveFailures: number;
  readonly lastOutcome?: JudgmentAttempt['outcome'];
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
  readonly lineage?: JudgmentLineage;
}

/**
 * Attaches what happened after a call to its decision log entry: the banded
 * readings a battery drew from the answers, and the action code took.
 */
export interface DecisionRecorder {
  recordReadings(decisionId: string, readings: JsonValue): void;
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
  /** A credential-free snapshot of the currently configured targets. */
  readonly health?: () => readonly JudgmentEndpointHealth[];
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

/** A JSON snapshot of a value, as the decision log stores questions, answers and readings. */
export function toJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
