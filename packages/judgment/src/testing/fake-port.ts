import { DEFAULT_MODEL } from '../port/config.ts';
import type { EntryType, JudgmentPort, JudgmentRequest, Question, Questions } from '../index.ts';

export type Answerer = (name: string, question: Question, state: EntryType) => unknown;

/** A port that answers each question through `answer` and remembers every request. */
export function fakePort(answer: Answerer) {
  const requests: JudgmentRequest<Questions>[] = [];
  const port: JudgmentPort = {
    model: DEFAULT_MODEL,
    async ask(request) {
      requests.push(request as JudgmentRequest<Questions>);
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([name, question]) => [name, answer(name, question, request.state)]),
      );
      return {
        answers: answers as never,
        requestedModel: request.model ?? DEFAULT_MODEL,
        model: 'jev-1.13.0',
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        requestId: undefined,
      };
    },
  };
  return { port, requests };
}

export const noulAnswer = (p: number) => ({ type: 'noul', noul: p });

export function choiceAnswer(question: Question, chosen: string, confidence = 0.9) {
  if (question.type !== 'choice') throw new Error('not a choice');
  // Synthetic confidence is independent of probability. Preserve prior valid
  // distributions, but keep the selected option maximal for weak-confidence
  // fixtures too; those must exercise uncertainty, not malformed responses.
  const probability = Object.keys(question.criteria).length === 1 ? 1 : Math.max(confidence, 1 - confidence);
  const probabilities = Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === chosen ? probability : 0]));
  const rest = Object.keys(question.criteria).filter((option) => option !== chosen);
  if (rest.length > 0) probabilities[rest[0]!] = 1 - probability;
  return { type: 'choice', choice: chosen, confidence, probabilities };
}

export function scoreAnswer(question: Question, value: number, confidence = 0.9) {
  if (question.type !== 'score') throw new Error('not a score');
  if (!Number.isFinite(value) || value < 0 || value > question.criteria.length - 1) throw new RangeError('score outside the rubric');
  const lower = Math.floor(value), upper = Math.ceil(value);
  const probabilities = Object.fromEntries(question.criteria.map((_, level) => [String(level),
    lower === upper ? Number(level === lower) : level === lower ? upper - value : level === upper ? value - lower : 0]));
  return { type: 'score', score: value, confidence, legend: {}, probabilities };
}
