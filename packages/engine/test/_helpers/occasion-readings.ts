import { beforeEach, afterEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
/** Select the authored first profile fixture; language accuracy lives in the battery. */
export function useOccasionReadings() {
  let previous: JudgmentPort | undefined;
  beforeEach(() => {
    previous = installJudgmentPort(fakePort((name, question) => question.type === 'noul'
      ? noulAnswer(1) : choiceAnswer(question, Object.keys(question.criteria).find((id) => id !== 'none')!, 0.99)).port);
  });
  afterEach(() => installJudgmentPort(previous));
}
