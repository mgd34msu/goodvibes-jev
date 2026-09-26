import { JudgmentError } from './errors.ts';
import type { EntryType, Questions } from './types.ts';

/** Documented request limits for System One (docs.typesafe.ai/api). */
export const LIMITS = {
  /** A Choice accepts at most 255 options. */
  maxChoiceOptions: 255,
  /** A Choice with one option decides nothing; two is the smallest real choice. */
  minChoiceOptions: 2,
  /** A Score needs at least two levels and accepts up to ten. */
  minScoreLevels: 2,
  maxScoreLevels: 10,
  /** Jev 1.13: 64k tokens for the state plus all questions. */
  maxRequestTokens: 64_000,
  /** Jev 1.13: 32k tokens for the state plus the single longest question. */
  maxStateWithQuestionTokens: 32_000,
} as const;

/**
 * A conservative token estimate for a JSON value: its serialized length over
 * three. Real tokenization averages closer to four characters per token for
 * English, so this overestimates and refuses before the endpoint would.
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil((text?.length ?? 0) / 3);
}

/** Rejects a request whose state and questions would not fit the model's context. */
export function validateContextBudget(state: EntryType, questions: Questions): void {
  const stateTokens = estimateTokens(state);
  const questionTokens = Object.values(questions).map((question) => estimateTokens(question));
  const total = stateTokens + questionTokens.reduce((sum, tokens) => sum + tokens, 0);
  const longest = stateTokens + Math.max(0, ...questionTokens);
  if (total > LIMITS.maxRequestTokens) {
    throw new JudgmentError(
      'invalid-request',
      `request is about ${total} tokens; the limit is ${LIMITS.maxRequestTokens}. Filter the state or split the questions.`,
    );
  }
  if (longest > LIMITS.maxStateWithQuestionTokens) {
    throw new JudgmentError(
      'invalid-request',
      `state plus the longest question is about ${longest} tokens; the limit is ${LIMITS.maxStateWithQuestionTokens}. Filter the state to what the questions need.`,
    );
  }
}

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
