import { JudgmentError } from './errors.ts';
import type { Questions } from './types.ts';

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Checks that the endpoint answered every question with the matching answer
 * type and sane numbers. A malformed answer is a failed judgment, never a
 * guessed one.
 */
export function checkAnswers(questions: Questions, answers: unknown, requestId?: string): void {
  const fail = (message: string): never => {
    throw new JudgmentError('invalid-response', message, requestId === undefined ? {} : { requestId });
  };
  if (typeof answers !== 'object' || answers === null) fail('response has no answers object');
  const byName = answers as Record<string, unknown>;
  for (const [name, question] of Object.entries(questions)) {
    const answer = byName[name] as Record<string, unknown> | undefined;
    if (answer === undefined || answer === null || typeof answer !== 'object') {
      fail(`no answer for question "${name}"`);
    }
    const got = answer as Record<string, unknown>;
    if (got['type'] !== question.type) {
      fail(`answer "${name}" has type ${String(got['type'])}, expected ${question.type}`);
    }
    switch (question.type) {
      case 'noul':
        if (!isProbability(got['noul'])) fail(`answer "${name}" has no valid noul`);
        break;
      case 'choice': {
        const probabilities = got['probabilities'] as Record<string, unknown> | undefined;
        if (!isProbability(got['confidence'])) fail(`answer "${name}" has no valid confidence`);
        if (typeof got['choice'] !== 'string' || !(got['choice'] in question.criteria)) {
          fail(`answer "${name}" chose an option outside its criteria`);
        }
        for (const option of Object.keys(question.criteria)) {
          if (!isProbability(probabilities?.[option])) {
            fail(`answer "${name}" has no probability for option "${option}"`);
          }
        }
        break;
      }
      case 'score': {
        const probabilities = got['probabilities'] as Record<string, unknown> | undefined;
        const top = question.criteria.length - 1;
        if (typeof got['score'] !== 'number' || got['score'] < 0 || got['score'] > top) {
          fail(`answer "${name}" has a score outside 0 to ${top}`);
        }
        if (!isProbability(got['confidence'])) fail(`answer "${name}" has no valid confidence`);
        for (let level = 0; level <= top; level++) {
          if (!isProbability(probabilities?.[String(level)])) {
            fail(`answer "${name}" has no probability for level ${level}`);
          }
        }
        break;
      }
    }
  }
}
