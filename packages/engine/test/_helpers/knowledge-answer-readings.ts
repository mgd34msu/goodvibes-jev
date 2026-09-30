/** Explicit plumbing readings for synthetic answer fixtures, not a semantic evaluator. */
import { afterEach, beforeEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
export interface AnswerFixtureReadings {
  /** Authored fixture expectations keyed by exact device title, never a keyword classifier. */
  homeGraph?: ReadonlyArray<readonly [string, Readonly<Partial<Record<'batteryApplicable' | 'manualApplicable' | 'manufacturerPresent' | 'modelPresent' | 'batteryTypePresent', number>>>]>;
  fidelity?: 'supported' | 'contradicted' | 'unsupported';
  fidelityByCandidate?: ReadonlyArray<readonly [string, 'supported' | 'contradicted' | 'unsupported']>;
  fidelityProbability?: number;
  enough?: number;
  complete?: number;
  completeByCandidate?: ReadonlyArray<readonly [string, number]>;
  preferred?: 'generated' | 'rendered';
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
      if (['batteryApplicable', 'manualApplicable', 'manufacturerPresent', 'modelPresent', 'batteryTypePresent'].includes(name)) {
        const subject = (state as { subject?: { title?: string } }).subject;
        const scripted = table.homeGraph?.find(([title]) => title === subject?.title)?.[1];
        const defaults: Record<string, number> = { batteryApplicable: 0.01, manualApplicable: 0.99, manufacturerPresent: 0.01, modelPresent: 0.01, batteryTypePresent: 0.01 };
        return noulAnswer((scripted as Record<string, number> | undefined)?.[name] ?? defaults[name]!);
      }
      if (name === 'fidelity') {
        const text = JSON.stringify((state as { candidate?: unknown }).candidate);
        return choiceAnswer(question, table.fidelityByCandidate?.find(([snippet]) => text.includes(snippet))?.[1] ?? table.fidelity ?? 'supported', table.fidelityProbability ?? 0.97);
      }
      if (name === 'preferred') return choiceAnswer(question, table.preferred ?? 'generated', 0.97);
      if (name === 'enough') return noulAnswer(table.enough ?? 0.97);
      if (name === 'complete') {
        const text = JSON.stringify((state as { candidate?: unknown }).candidate);
        return noulAnswer(table.completeByCandidate?.find(([snippet]) => text.includes(snippet))?.[1] ?? table.complete ?? 0.97);
      }
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
