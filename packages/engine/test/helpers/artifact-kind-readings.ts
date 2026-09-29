/**
 * A fake judgment port for the artifact store's `engine.artifacts.kind`
 * reading, so tests that store artifacts run without a model. The default
 * answer is a stand-in for the model on plain media types, not the product's
 * rule; a test about a specific answer passes its own.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { JudgmentPort, JudgmentRequest, Question, Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';

export type FakeArtifactKind = 'document' | 'data' | 'archive' | 'file';

export function defaultArtifactKind(mimeType: string): FakeArtifactKind {
  if (/json|csv|xml|yaml|sheet|excel|parquet|sqlite/.test(mimeType)) return 'data';
  if (/zip|gzip|tar|7z/.test(mimeType)) return 'archive';
  if (mimeType.startsWith('text/') || /pdf|word|presentation|opendocument/.test(mimeType)) return 'document';
  return 'file';
}

export function artifactKindPort(kind: (state: { mimeType: string; filename: string }) => FakeArtifactKind = (state) => defaultArtifactKind(state.mimeType)) {
  return fakePort((name: string, question: Question, state: unknown) => {
    if (name !== 'kind') throw new Error(`artifactKindPort: no fake answer for question "${name}"`);
    return choiceAnswer(question, kind(state as { mimeType: string; filename: string }));
  });
}

/** Installs the artifact kind port around every test in the calling file. */
export function useArtifactKindReadings(): { readonly requests: JudgmentRequest<Questions>[] } {
  const holder: { requests: JudgmentRequest<Questions>[] } = { requests: [] };
  let previous: JudgmentPort | undefined;
  beforeEach(() => {
    const fake = artifactKindPort();
    holder.requests = fake.requests;
    previous = installJudgmentPort(fake.port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });
  return {
    get requests() {
      return holder.requests;
    },
  };
}
