/** Explicit plumbing readings for synthetic answer fixtures, not a semantic evaluator. */
import { afterEach, beforeEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
export interface AnswerFixtureReadings {
  sources?: ReadonlyArray<readonly [string, number]>;
  facts?: ReadonlyArray<readonly [string, number]>;
  features?: number;
}
export function useKnowledgeAnswerReadings() {
  let previous: JudgmentPort | undefined;
  let table: AnswerFixtureReadings = {};
  let fake = makePort();
  function makePort() {
    return fakePort((name, question, state) => {
      if (question.type !== 'noul') throw new Error(`Unexpected answer fixture question: ${name}`);
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
