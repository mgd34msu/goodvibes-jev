import { afterEach, beforeEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

/**
 * Plumbing fixture: these suites supply readable synthetic documents except
 * explicitly labelled samples. This never estimates real text's readability.
 * Register at the calling file's top level so Bun scopes hooks to that file.
 */
export function useExtractionReadings(rejectedSamples: readonly string[] = []): void {
  let previous: JudgmentPort | undefined;
  beforeEach(() => {
    const rejected = new Set(rejectedSamples);
    previous = installJudgmentPort(fakePort((name, question, state) => {
      if (name !== 'readable' || question.type !== 'noul') throw new Error(`Unexpected fixture judgment: ${name}`);
      const sample = (state as { readonly sample: string }).sample;
      return noulAnswer(rejected.has(sample) ? 0.01 : 0.99);
    }).port);
  });
  afterEach(() => { installJudgmentPort(previous); });
}
