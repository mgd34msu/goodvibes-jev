import { JudgmentError } from './errors.ts';
import type { ChoiceQuestion, Question, Questions, ScoreQuestion } from './types.ts';

/** An answer as it arrives on the wire, before it is trusted. */
type RawAnswer = Readonly<Record<string, unknown>>;

/** Throws the invalid-response error for one malformed answer. */
type Fail = (message: string) => never;

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const probabilitiesOf = (answer: RawAnswer): Readonly<Record<string, unknown>> =>
  (answer['probabilities'] as Readonly<Record<string, unknown>> | undefined) ?? {};

/** Every expected key of a distribution must carry a probability. */
function requireDistribution(answer: RawAnswer, keys: readonly string[], describe: (key: string) => string, fail: Fail): void {
  const probabilities = probabilitiesOf(answer);
  const missing = keys.find((key) => !isProbability(probabilities[key]));
  if (missing !== undefined) fail(`no probability for ${describe(missing)}`);
}

function requireConfidence(answer: RawAnswer, fail: Fail): void {
  if (!isProbability(answer['confidence'])) fail('no valid confidence');
}

function checkNoul(answer: RawAnswer, fail: Fail): void {
  if (!isProbability(answer['noul'])) fail('no valid noul');
}

function checkChoice(question: ChoiceQuestion, answer: RawAnswer, fail: Fail): void {
  const chosen = answer['choice'];
  const chosenIsOffered = typeof chosen === 'string' && chosen in question.criteria;
  if (!chosenIsOffered) fail('a choice outside its criteria');
  requireConfidence(answer, fail);
  requireDistribution(answer, Object.keys(question.criteria), (option) => `option "${option}"`, fail);
}

function checkScore(question: ScoreQuestion, answer: RawAnswer, fail: Fail): void {
  const top = question.criteria.length - 1;
  const value = answer['score'];
  const onTheRubric = typeof value === 'number' && value >= 0 && value <= top;
  if (!onTheRubric) fail(`a score outside 0 to ${top}`);
  requireConfidence(answer, fail);
  const levels = Array.from({ length: top + 1 }, (_, level) => String(level));
  requireDistribution(answer, levels, (level) => `level ${level}`, fail);
}

function checkOne(question: Question, answer: RawAnswer, fail: Fail): void {
  if (answer['type'] !== question.type) fail(`type ${String(answer['type'])}, expected ${question.type}`);
  if (question.type === 'noul') checkNoul(answer, fail);
  else if (question.type === 'choice') checkChoice(question, answer, fail);
  else checkScore(question, answer, fail);
}

/**
 * Checks that the endpoint answered every question with the matching answer
 * type and sane numbers. A malformed answer is a failed judgment, never a
 * guessed one.
 */
export function checkAnswers(questions: Questions, answers: unknown, requestId?: string): void {
  const failWith = (message: string): never => {
    throw new JudgmentError('invalid-response', message, requestId === undefined ? {} : { requestId });
  };
  if (typeof answers !== 'object' || answers === null) failWith('response has no answers object');
  const byName = answers as Readonly<Record<string, unknown>>;
  for (const [name, question] of Object.entries(questions)) {
    const answer = byName[name];
    if (typeof answer !== 'object' || answer === null) failWith(`no answer for question "${name}"`);
    checkOne(question, answer as RawAnswer, (message) => failWith(`answer "${name}" has ${message}`));
  }
}
