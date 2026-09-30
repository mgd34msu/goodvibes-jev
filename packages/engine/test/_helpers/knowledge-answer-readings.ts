/** Explicit plumbing readings for synthetic answer fixtures, not a semantic evaluator. */
import { afterEach, beforeEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
export interface AnswerFixtureReadings {
  sources?: ReadonlyArray<readonly [string, number]>;
  facts?: ReadonlyArray<readonly [string, number]>;
  features?: number;
  quality?: ReadonlyArray<readonly [string, number]>;
  authorities?: ReadonlyArray<readonly [string, 'official-vendor' | 'vendor' | 'secondary' | 'unverified']>;
}
export function useKnowledgeAnswerReadings() {
  let previous: JudgmentPort | undefined;
  let table: AnswerFixtureReadings = {};
  let fake = makePort();
  function makePort() {
    return fakePort((name, question, state) => {
      if (name === 'authority') {
        const text = JSON.stringify(state);
        return choiceAnswer(question, table.authorities?.find(([snippet]) => text.includes(snippet))?.[1] ?? 'secondary', 0.97);
      }
      if (question.type !== 'noul') throw new Error(`Unexpected answer fixture question: ${name}`);
      if (name === 'useful') {
        const text = JSON.stringify(state);
        return noulAnswer(table.quality?.find(([snippet]) => text.includes(snippet))?.[1] ?? 0.97);
      }
      if (name === 'supported' || name === 'attached') return noulAnswer(0.99); // Explicit synthetic support fixtures; not a semantic evaluator.
      if (name === 'readable') return noulAnswer(0.99); // The suite supplies readable synthetic documents.
      if (name === 'features') return noulAnswer(table.features ?? 0.97);
      if (name !== 'match') throw new Error(`Unexpected answer fixture question: ${name}`);
      const candidate = (state as { candidate: Record<string, unknown> }).candidate;
      const readings = 'sourceType' in candidate ? table.sources : table.facts;
      const text = JSON.stringify(candidate);
      return noulAnswer(readings?.find(([snippet]) => text.includes(snippet))?.[1] ?? 0.97);
    });
  }
  beforeEach(() => { table = {}; fake = makePort(); previous = installJudgmentPort(fake.port); });
  afterEach(() => { installJudgmentPort(previous); });
  return { set(readings: AnswerFixtureReadings) { table = readings; }, get requests() { return fake.requests; } };
}
