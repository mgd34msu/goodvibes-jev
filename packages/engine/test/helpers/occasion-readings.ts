/** Recorded synthetic answers for existing occasion fixtures, not a semantic oracle. */
import { beforeEach, afterEach } from 'bun:test';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { securityPort } from './security-readings.ts';

export function useOccasionReadings() {
  let previous: ReturnType<typeof installJudgmentPort>;
  const fixture = fakePort((name, question, raw) => {
    const state = raw as { title?: string; person?: string; declaredNames?: string[] };
    if (name === 'subject') {
      const owner = state.title === "Avery's birthday" && (state.declaredNames ?? []).includes('Avery Chen');
      const unknown = ['Our anniversary', 'Dad'].includes(state.title ?? '');
      return choiceAnswer(question, owner ? 'owner' : unknown ? 'unknown' : 'other', 0.99);
    }
    if (name === 'names') return noulAnswer(["Sarah's birthday", "Natalie Sons's birthday"].includes(state.title ?? '') ? 0.99 : 0.01);
    if (name === 'pick') return choiceAnswer(question, 'line_0', 0.99);
    return noulAnswer(name === 'fits_0' ? 0.99 : 0.01);
  });
  beforeEach(() => {
    const security = securityPort();
    previous = installJudgmentPort({ model: fixture.port.model, ask: request => request.context?.battery?.startsWith('engine.occasions.') ? fixture.port.ask(request) : security.port.ask(request) });
  });
  afterEach(() => { installJudgmentPort(previous); });
  return fixture;
}
