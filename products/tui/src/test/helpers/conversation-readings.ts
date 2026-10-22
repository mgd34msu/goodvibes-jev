import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';

/** Explicit conversation-turn readings; unknown decisions fail instead of receiving a generic answer. */
export function conversationReadingsPort(completion: { readonly request: string; readonly response: string }) {
  const fixture = fakePort((name, question, state) => {
    if (name === 'intent') return choiceAnswer(question, 'chat', 0.97);
    if (name === 'needs_plan') return noulAnswer(0.03);
    if (name === 'risk') return scoreAnswer(question, 0, 0.97);
    if (name === 'strategy') return choiceAnswer(question, 'single', 0.97);
    if (question.type === 'noul' && state !== null && typeof state === 'object' && !Array.isArray(state)
      && state.request === completion.request && state.response === completion.response
      && ['false_blocker', 'unfinished', 'unsupported', 'unanswered', 'unnecessary_permission',
        'implementation_presented', 'verification_claimed', 'criteria_altered', 'ineffective_fix',
        'irrelevant_verification', 'weakened_criteria'].includes(name)) return noulAnswer(0.01);
    throw new Error(`Unexpected conversation fixture question: ${name}`);
  });
  const ask = fixture.port.ask.bind(fixture.port);
  fixture.port.ask = request => {
    if (!['engine.core.turn-shape', 'engine.core.execution-strategy', 'engine.core.response-completion', 'engine.core.execution-assurance'].includes(request.context?.battery ?? '')) {
      throw new Error(`Unexpected conversation fixture battery: ${request.context?.battery}`);
    }
    return ask(request);
  };
  return fixture;
}
