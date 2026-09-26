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

/** Whether a yes/no probability leans yes: yes is the likelier side. Ties lean yes. */
export const leansYes = (p: number): boolean => p >= 0.5;

/** How strongly a yes/no probability backs its likelier side, from 0.5 to 1. */
export const likelierSide = (p: number): number => Math.max(p, 1 - p);

type YesNoConclusion = Pick<YesNoReading, 'verdict' | 'outcome'>;

/** Where a probability falls in a yes/no band: each side acts or confirms on its own confidence, and the middle escalates. */
function concludeYesNo(p: number, band: YesNoBand): YesNoConclusion {
  const onYes = outcomeForConfidence(p, band.yes);
  if (onYes !== 'escalate') return { verdict: 'yes', outcome: onYes };
  const onNo = outcomeForConfidence(1 - p, band.no);
  if (onNo !== 'escalate') return { verdict: 'no', outcome: onNo };
  return { verdict: 'uncertain', outcome: 'escalate' };
}

/** A choice or score answer's confidence and what code may do with it under `band`. */
function confident(confidence: number, band: ConfidenceBand): Pick<ScoreReading, 'confidence' | 'outcome'> {
  assertConfidenceBand(band);
  return { confidence, outcome: outcomeForConfidence(confidence, band) };
}

/** Reads a noul through a yes/no band. */
export function readYesNo(answer: NoulResponse, band: YesNoBand): YesNoReading {
  assertYesNoBand(band);
  return { kind: 'yes-no', probability: answer.noul, ...concludeYesNo(answer.noul, band) };
}

/** Reads a choice through its band, using the chosen option's stricter band when it has one. */
export function readChoice<T extends ChoiceCriteria>(
  answer: ChoiceResponse<T>,
  band: ChoiceBand<keyof T & string>,
): ChoiceReading<keyof T & string> {
  assertConfidenceBand(band);
  return {
    kind: 'choice',
    choice: answer.choice,
    probabilities: answer.probabilities as Readonly<Record<keyof T & string, number>>,
    ...confident(answer.confidence, band.perOption?.[answer.choice] ?? band),
  };
}

/** Reads a score through a confidence band. */
export function readScore<T extends ScoreCriteria>(answer: ScoreResponse<T>, band: ConfidenceBand): ScoreReading {
  const probabilities: Readonly<Record<string, number>> = answer.probabilities;
  const top = Object.keys(probabilities).length - 1;
  const levels = Array.from({ length: top + 1 }, (_, level) => probabilities[String(level)] ?? 0);
  return {
    kind: 'score',
    score: answer.score,
    level: Math.min(top, Math.max(0, Math.round(answer.score))),
    normalized: top > 0 ? answer.score / top : 0,
    probabilities: levels,
    ...confident(answer.confidence, band),
  };
}
