import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';

/** Explicit conversation-turn readings; unknown decisions fail instead of receiving a generic answer. */
export function conversationReadingsPort() {
  const fixture = fakePort((name, question) => {
    if (name === 'intent') return choiceAnswer(question, 'chat', 0.97);
    if (name === 'needs_plan') return noulAnswer(0.03);
    if (name === 'risk') return scoreAnswer(question, 0, 0.97);
    if (name === 'strategy') return choiceAnswer(question, 'single', 0.97);
    throw new Error(`Unexpected conversation fixture question: ${name}`);
  });
  const ask = fixture.port.ask.bind(fixture.port);
  fixture.port.ask = request => {
    if (!['engine.core.turn-shape', 'engine.core.execution-strategy'].includes(request.context?.battery ?? '')) {
      throw new Error(`Unexpected conversation fixture battery: ${request.context?.battery}`);
    }
    return ask(request);
  };
  return fixture;
}
