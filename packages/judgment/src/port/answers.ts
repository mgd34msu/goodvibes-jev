import { JudgmentError } from './errors.ts';
import type { ChoiceQuestion, Question, Questions, ScoreQuestion } from './types.ts';

/** An answer as it arrives on the wire, before it is trusted: every field unchecked. */
interface RawAnswer {
  readonly type?: unknown;
  readonly noul?: unknown;
  readonly choice?: unknown;
  readonly score?: unknown;
  readonly confidence?: unknown;
  readonly probabilities?: Readonly<Record<string, unknown>>;
}

/** Throws the invalid-response error for one malformed answer. */
type Fail = (message: string) => never;

const isNumberWithin = (value: unknown, low: number, high: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

const isProbability = (value: unknown): value is number => isNumberWithin(value, 0, 1);

/**
 * A choice or score answer carries a confidence and a probability for every
 * option or level it could have given; `label` names a key in the message.
 */
function checkDistribution(answer: RawAnswer, keys: readonly string[], label: (key: string) => string, fail: Fail): void {
  if (!isProbability(answer.confidence)) fail('no valid confidence');
  const probabilities = answer.probabilities ?? {};
  const missing = keys.find((key) => !isProbability(probabilities[key]));
  if (missing !== undefined) fail(`no probability for ${label(missing)}`);
}

function checkNoul(answer: RawAnswer, fail: Fail): void {
  if (!isProbability(answer.noul)) fail('no valid noul');
}

function checkChoice(question: ChoiceQuestion, answer: RawAnswer, fail: Fail): void {
  const options = Object.keys(question.criteria);
  if (!options.includes(answer.choice as string)) fail('a choice outside its criteria');
  checkDistribution(answer, options, (option) => `option "${option}"`, fail);
}

function checkScore(question: ScoreQuestion, answer: RawAnswer, fail: Fail): void {
  const top = question.criteria.length - 1;
  if (!isNumberWithin(answer.score, 0, top)) fail(`a score outside 0 to ${top}`);
  const levels = Array.from({ length: top + 1 }, (_, level) => String(level));
  checkDistribution(answer, levels, (level) => `level ${level}`, fail);
}

function checkOne(question: Question, answer: RawAnswer, fail: Fail): void {
  if (answer.type !== question.type) fail(`type ${String(answer.type)}, expected ${question.type}`);
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
