import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ErrorClass } from '@goodvibes-jev/engine/sdk/platform/routing';

export function installUserErrorReading(kind: ErrorClass = 'generic', sessionEnded = false) {
  const { port } = fakePort((name, question) => {
    if (question.type === 'choice') return choiceAnswer(question,
      name === 'failure__category' ? kind === 'auth' ? 'authentication' : kind === 'network' ? 'network' : 'unknown' : 'none', 0.99);
    const yes = (name === 'failure__rate_limited' && kind === 'rate-limit')
      || (name === 'failure__context_exceeded' && kind === 'context-overflow')
      || (name === 'failure__transient_network' && kind === 'network')
      || (name === 'user__session_ended' && sessionEnded);
    return noulAnswer(yes ? 0.99 : 0.01);
  });
  const previous = installJudgmentPort(port);
  return () => { installJudgmentPort(previous); };
}
export const flushErrorNotices = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
