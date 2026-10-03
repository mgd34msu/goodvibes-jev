import { beforeEach, afterEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, scoreAnswer, choiceAnswer } from '@goodvibes-jev/judgment/testing';

/** Explicit synthetic semantic readings; the production scorer and renderer stay real. */
export function compactionQualityPort() {
  return fakePort((name, question) => {
    if (name === 'substance') return scoreAnswer(question, 3, 0.95);
    if (name === 'relation') return choiceAnswer(question, 'supports', 0.95);
    throw new Error(`Unexpected compaction fixture question: ${name}`);
  });
}

export function useCompactionQualityPort(): void {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => { previous = installJudgmentPort(compactionQualityPort().port); });
  afterEach(() => { installJudgmentPort(previous); });
}
