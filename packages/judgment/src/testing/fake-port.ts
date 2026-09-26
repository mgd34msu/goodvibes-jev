import type { EntryType, JudgmentPort, JudgmentRequest, Question, Questions } from '../index.ts';

export type Answerer = (name: string, question: Question, state: EntryType) => unknown;

/** A port that answers each question through `answer` and remembers every request. */
export function fakePort(answer: Answerer) {
  const requests: JudgmentRequest<Questions>[] = [];
  const port: JudgmentPort = {
    model: 'jev-1.13.0',
    async ask(request) {
      requests.push(request as JudgmentRequest<Questions>);
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([name, question]) => [name, answer(name, question, request.state)]),
      );
      return {
        answers: answers as never,
        requestedModel: request.model ?? 'jev-1.13.0',
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
  const probabilities = Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === chosen ? confidence : 0]));
  const rest = Object.keys(question.criteria).filter((option) => option !== chosen);
  if (rest.length > 0) probabilities[rest[0]!] = 1 - confidence;
  return { type: 'choice', choice: chosen, confidence, probabilities };
}

export function scoreAnswer(question: Question, value: number, confidence = 0.9) {
  if (question.type !== 'score') throw new Error('not a score');
  const probabilities = Object.fromEntries(question.criteria.map((_, level) => [String(level), level === Math.round(value) ? 1 : 0]));
  return { type: 'score', score: value, confidence, legend: {}, probabilities };
}
