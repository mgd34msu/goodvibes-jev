import { afterEach, beforeEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

/** Recorded synthetic rankings for exact command fixtures; never a production heuristic. */
export function useMemoryRankingPort(fixtures: {
  readonly review: Readonly<Record<string, number>>;
  readonly search?: { readonly query: string; readonly candidates: Readonly<Record<string, number>> };
}): void {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    previous = installJudgmentPort(fakePort((name, _question, state) => {
      const input = state as { record?: { summary?: string }; candidate?: { summary?: string }; query?: unknown };
      const summary = name === 'needs_review' ? input.record?.summary : input.candidate?.summary;
      const readings = name === 'needs_review' ? fixtures.review
        : name === 'match' && input.query === fixtures.search?.query ? fixtures.search?.candidates : undefined;
      const probability = summary === undefined ? undefined : readings?.[summary];
      if (probability === undefined) throw new Error(`Unexpected memory ranking fixture: ${name} / ${summary}`);
      return noulAnswer(probability);
    }).port);
  });
  afterEach(() => { installJudgmentPort(previous); });
}
