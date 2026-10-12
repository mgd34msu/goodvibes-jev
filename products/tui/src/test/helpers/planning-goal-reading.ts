import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

export function recordedPlanningGoalPort(texts: ReadonlyMap<string, number>) {
  return fakePort((name, question, state) => {
    if (name !== 'goal' || question.type !== 'noul' || !state || typeof state !== 'object' || Array.isArray(state)
      || !('text' in state) || typeof state.text !== 'string') throw new Error('Unexpected planning goal fixture request.');
    const probability = texts.get(state.text);
    if (probability === undefined) throw new Error('Unrecorded planning goal fixture text.');
    return noulAnswer(probability);
  });
}
