import type { ChoiceCriteria, ChoiceResponse, NoulResponse, ScoreCriteria, ScoreResponse } from '../port/types.ts';
import {
  assertConfidenceBand,
  assertYesNoBand,
  outcomeForConfidence,
  type ChoiceBand,
  type ConfidenceBand,
  type Outcome,
  type YesNoBand,
} from './bands.ts';

/** A yes/no reading: the probability, what it says, and what code may do with it. */
export interface YesNoReading {
  readonly kind: 'yes-no';
  readonly probability: number;
  readonly verdict: 'yes' | 'no' | 'uncertain';
  readonly outcome: Outcome;
}

/** A choice reading over a fixed set of options. */
export interface ChoiceReading<O extends string = string> {
  readonly kind: 'choice';
  readonly choice: O;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<O, number>>;
  readonly outcome: Outcome;
}

/** A score reading on an ordered rubric. */
export interface ScoreReading {
  readonly kind: 'score';
  /** Probability-weighted position on the levels; may fall between two levels. */
  readonly score: number;
  /** The nearest level, for code that needs one outcome. */
  readonly level: number;
  /** Score divided by the top level, for weighting across rubrics of different lengths. */
  readonly normalized: number;
  readonly confidence: number;
  readonly probabilities: readonly number[];
  readonly outcome: Outcome;
}

export type Reading = YesNoReading | ChoiceReading | ScoreReading;

/** Reads a noul through a yes/no band. */
export function readYesNo(answer: NoulResponse, band: YesNoBand): YesNoReading {
  assertYesNoBand(band);
  const p = answer.noul;
  if (band.act !== null && p >= band.act.yes) return { kind: 'yes-no', probability: p, verdict: 'yes', outcome: 'act' };
  if (band.act !== null && p <= band.act.no) return { kind: 'yes-no', probability: p, verdict: 'no', outcome: 'act' };
  if (p >= band.confirm.yes) return { kind: 'yes-no', probability: p, verdict: 'yes', outcome: 'confirm' };
  if (p <= band.confirm.no) return { kind: 'yes-no', probability: p, verdict: 'no', outcome: 'confirm' };
  return { kind: 'yes-no', probability: p, verdict: 'uncertain', outcome: 'escalate' };
}

/** Reads a choice through its band, using the chosen option's stricter band when it has one. */
export function readChoice<T extends ChoiceCriteria>(
  answer: ChoiceResponse<T>,
  band: ChoiceBand<keyof T & string>,
): ChoiceReading<keyof T & string> {
  assertConfidenceBand(band);
  const optionBand: ConfidenceBand = band.perOption?.[answer.choice] ?? band;
  assertConfidenceBand(optionBand);
  return {
    kind: 'choice',
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities as Readonly<Record<keyof T & string, number>>,
    outcome: outcomeForConfidence(answer.confidence, optionBand),
  };
}

/** Reads a score through a confidence band. */
export function readScore<T extends ScoreCriteria>(answer: ScoreResponse<T>, band: ConfidenceBand): ScoreReading {
  assertConfidenceBand(band);
  const probabilities = answer.probabilities as Readonly<Record<string, number>>;
  const top = Object.keys(probabilities).length - 1;
  const levels = Array.from({ length: top + 1 }, (_, level) => probabilities[String(level)] ?? 0);
  return {
    kind: 'score',
    score: answer.score,
    level: Math.min(top, Math.max(0, Math.round(answer.score))),
    normalized: top > 0 ? answer.score / top : 0,
    confidence: answer.confidence,
    probabilities: levels,
    outcome: outcomeForConfidence(answer.confidence, band),
  };
}
