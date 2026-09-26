import { noul, score, type EntryType, type JudgmentResult, type NoulResponse, type Question, type Questions, type ScoreCriteria, type ScoreResponse } from '../port/types.ts';

/** What a screening asks: one yes/no per hazard, each naming the action it triggers, and one score on severity. */
export interface PolicyQuestionsSpec<H extends string, A extends string> {
  readonly hazards: Readonly<
    Record<H, { readonly instructions: EntryType; readonly yes: EntryType; readonly no: EntryType; readonly action: A }>
  >;
  readonly severity: { readonly instructions: EntryType; readonly levels: ScoreCriteria };
}

/** What one screening reads: each hazard's probability, and the expected severity level with the model's confidence in it. */
export interface Screening<H extends string> {
  readonly probabilities: Readonly<Record<H, number>>;
  readonly severity: { readonly score: number; readonly confidence: number };
}

type HazardKey = `hazard_${string}`;
/** The answers a screening request returns: the severity score and one yes/no per hazard. */
type PolicyAnswers = { readonly severity: ScoreResponse } & { readonly [hazard: HazardKey]: NoulResponse };
/** The question name a hazard's yes/no is asked under. */
const hazardKey = (hazard: string): HazardKey => `hazard_${hazard}`;

/** Every question a screening asks, in one request. */
export function policyQuestions<H extends string, A extends string>(spec: PolicyQuestionsSpec<H, A>, hazards: readonly H[]): Record<string, Question> {
  const questions: Record<string, Question> = { severity: score(spec.severity.instructions, spec.severity.levels) };
  for (const hazard of hazards) {
    const { instructions, yes, no } = spec.hazards[hazard];
    questions[hazardKey(hazard)] = noul(instructions, { true: yes, false: no });
  }
  return questions;
}

/** The hazard probabilities and severity a screening's answers carry. */
export function readScreening<H extends string>(answers: JudgmentResult<Questions>['answers'], hazards: readonly H[]): Screening<H> {
  const typed = answers as PolicyAnswers;
  const probabilities = Object.fromEntries(hazards.map((hazard) => [hazard, typed[hazardKey(hazard)]!.noul])) as Record<H, number>;
  const { score: level, confidence } = typed.severity;
  return { probabilities, severity: { score: level, confidence } };
}
