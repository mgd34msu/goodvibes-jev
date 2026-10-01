import { JudgmentError } from './errors.ts';
import type { JudgmentResult, Question, Questions } from './types.ts';

/**
 * An answer as it arrives on the wire. The shape is what the endpoint
 * promises; every value is still checked here before anything trusts it.
 */
interface RawAnswer {
  readonly type?: Question['type'];
  readonly noul?: number;
  readonly choice?: string;
  readonly score?: number;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
}

/** The answers map as it arrives on the wire, keyed by question name. */
type WireAnswers = Readonly<Record<string, RawAnswer | null | undefined>>;

/** One number an answer must carry as a probability, with the name the failure message uses. */
interface ProbabilityField {
  readonly what: string;
  readonly value: number | undefined;
}

/** The options of a choice or the levels of a score, as the keys of its distribution. */
function distributionKeys(question: Exclude<Question, { type: 'noul' }>): string[] {
  if (question.type === 'choice') return Object.keys(question.criteria);
  return question.criteria.map((_, level) => String(level));
}

/** Every number the answer to `question` must carry as a probability from 0 to 1. */
function probabilityFields(question: Question, answer: RawAnswer): ProbabilityField[] {
  if (question.type === 'noul') return [{ what: 'noul', value: answer.noul }];
  const probabilities = answer.probabilities ?? {};
  return [
    { what: 'confidence', value: answer.confidence },
    ...distributionKeys(question).map((key) => ({ what: `probability for "${key}"`, value: probabilities[key] })),
  ];
}

const isNumberWithin = (value: number | undefined, low: number, high: number): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

/** The headline answer must be one the question offered: an offered option, or a score on the rubric. */
function headlineProblem(question: Question, answer: RawAnswer): string | undefined {
  if (question.type === 'choice') return distributionKeys(question).includes(answer.choice ?? '') ? undefined : 'a choice outside its criteria';
  if (question.type === 'score') {
    const top = question.criteria.length - 1;
    return isNumberWithin(answer.score, 0, top) ? undefined : `a score outside 0 to ${top}`;
  }
  return undefined;
}

/** Why an answer cannot be trusted for its question, or undefined when it can. */
function answerProblem(question: Question, answer: RawAnswer): string | undefined {
  if (answer.type !== question.type) return `type ${String(answer.type)}, expected ${question.type}`;
  const invalid = probabilityFields(question, answer).find(({ value }) => !isNumberWithin(value, 0, 1));
  return headlineProblem(question, answer) ?? (invalid === undefined ? undefined : `no valid ${invalid.what}`);
}

const isPresentObject = <T extends object>(value: T | null | undefined): value is T => typeof value === 'object' && value !== null;

/**
 * Checks that the endpoint answered every question with the matching answer
 * type and sane numbers. A malformed answer is a failed judgment, never a
 * guessed one.
 */
export function checkAnswers(questions: Questions, answers: WireAnswers | null | undefined, requestId?: string): void {
  const failWith = (message: string): never => {
    throw new JudgmentError('invalid-response', message, requestId === undefined ? {} : { requestId });
  };
  if (!isPresentObject(answers)) return failWith('response has no answers object');
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    if (!isPresentObject(answer)) return failWith(`no answer for question "${name}"`);
    const problem = answerProblem(question, answer);
    if (problem !== undefined) failWith(`answer "${name}" has ${problem}`);
  }
}

/** Keep only documented answer fields; extensions must not smuggle response bodies into the log. */
export function projectAnswers<Q extends Questions>(questions: Q, answers: WireAnswers): JudgmentResult<Q>['answers'] {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    // checkAnswers has already validated these fields against the frozen questions.
    const answer = answers[name]!;
    if (question.type === 'noul') return [name, { type: 'noul', noul: answer.noul! }];
    const probabilities = Object.fromEntries(distributionKeys(question).map((key) => [key, answer.probabilities![key]!]));
    if (question.type === 'choice') return [name, { type: 'choice', choice: answer.choice!, confidence: answer.confidence!, probabilities }];
    // The legend is the request's own rubric, not arbitrary metadata from the endpoint.
    const legend = Object.fromEntries(question.criteria.map((description, index) => [String(index), description]));
    return [name, { type: 'score', score: answer.score!, confidence: answer.confidence!, probabilities, legend }];
  })) as JudgmentResult<Q>['answers'];
}
