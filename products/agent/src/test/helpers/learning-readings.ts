/** Plumbing fixture only. Semantic distinctions are calibrated in registered batteries. */
import { beforeEach, afterEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, scoreAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
export function useLearningReadings() {
  let previous: JudgmentPort | undefined;
  let survivor: 'left' | 'right' | 'separate' = 'left';
  const fake = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(1);
    if (question.type === 'score') return scoreAnswer(question, 4, 0.99);
    if (name === 'target') return choiceAnswer(question, 'none', 0.99);
    if (name === 'survivor') return choiceAnswer(question, survivor, 0.99);
    throw new Error(`Unexpected learning fixture question ${name}`);
  });
  beforeEach(() => { previous = installJudgmentPort(fake.port); fake.requests.length = 0; survivor = 'left'; });
  afterEach(() => { installJudgmentPort(previous); });
  return { fake, setSurvivor(value: typeof survivor) { survivor = value; } };
}
