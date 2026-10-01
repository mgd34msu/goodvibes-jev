/** Explicit deterministic core readings; no text heuristic stands in for Jev. */
import { afterEach, beforeEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import type { Intent } from '../../sdk/src/platform/core/intent-classifier.ts';
import type { ExecutionStrategy } from '../../sdk/src/platform/core/adaptive-planner.ts';

export interface CoreReadings {
  intent?: Intent;
  needsPlan?: boolean | 'uncertain';
  risk?: number;
  strategy?: Exclude<ExecutionStrategy, 'auto'>;
  confidence?: number;
}

export function coreReadingsPort(readings: CoreReadings = {}) {
  return fakePort((name, question) => {
    const confidence = readings.confidence ?? 0.97;
    if (name === 'intent') return choiceAnswer(question, readings.intent ?? 'task', confidence);
    if (name === 'needs_plan') return noulAnswer(readings.needsPlan === 'uncertain' ? 0.5 : readings.needsPlan ? 0.97 : 0.03);
    if (name === 'risk') return scoreAnswer(question, readings.risk ?? 0, confidence);
    if (name === 'strategy') return choiceAnswer(question, readings.strategy ?? 'cohort', confidence);
    throw new Error(`core fixture: unexpected question ${name}`);
  });
}

export function useCoreReadings(defaults: CoreReadings = {}) {
  let previous: ReturnType<typeof installJudgmentPort>;
  let fake = coreReadingsPort(defaults);
  beforeEach(() => {
    fake = coreReadingsPort(defaults);
    previous = installJudgmentPort(fake.port);
  });
  afterEach(() => { installJudgmentPort(previous); });
  return {
    set(readings: CoreReadings): void {
      fake = coreReadingsPort({ ...defaults, ...readings });
      installJudgmentPort(fake.port);
    },
    get requests() { return fake.requests; },
  };
}
