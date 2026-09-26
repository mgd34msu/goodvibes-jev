import { JudgmentError } from './errors.ts';
import type { Questions } from './types.ts';

/** Documented request limits for System One (docs.typesafe.ai/api). */
export const LIMITS = {
  /** A Choice accepts at most 255 options. */
  maxChoiceOptions: 255,
  /** A Choice with one option decides nothing; two is the smallest real choice. */
  minChoiceOptions: 2,
  /** A Score needs at least two levels and accepts up to ten. */
  minScoreLevels: 2,
  maxScoreLevels: 10,
} as const;

/** Rejects a request that breaks a documented limit, before anything is sent. */
export function validateQuestions(questions: Questions): void {
  const names = Object.keys(questions);
  if (names.length === 0) {
    throw new JudgmentError('invalid-request', 'a judgment request needs at least one question');
  }
  for (const name of names) {
    if (name.trim().length === 0) {
      throw new JudgmentError('invalid-request', 'question names must be nonempty');
    }
    const question = questions[name]!;
    switch (question.type) {
      case 'noul':
        break;
      case 'choice': {
        const count = Object.keys(question.criteria).length;
        if (count < LIMITS.minChoiceOptions || count > LIMITS.maxChoiceOptions) {
          throw new JudgmentError(
            'invalid-request',
            `choice "${name}" has ${count} options; allowed ${LIMITS.minChoiceOptions} to ${LIMITS.maxChoiceOptions}`,
          );
        }
        break;
      }
      case 'score': {
        const count = question.criteria.length;
        if (count < LIMITS.minScoreLevels || count > LIMITS.maxScoreLevels) {
          throw new JudgmentError(
            'invalid-request',
            `score "${name}" has ${count} levels; allowed ${LIMITS.minScoreLevels} to ${LIMITS.maxScoreLevels}`,
          );
        }
        break;
      }
    }
  }
}
