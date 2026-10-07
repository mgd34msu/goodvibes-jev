import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

/** Exact authored public-retrieval fixtures; never a production classifier. */
export async function withPublicKnowledgeReadings<T>(
  titles: readonly string[],
  excerpts: readonly string[],
  action: () => T | Promise<T>,
): Promise<T> {
  const fake = fakePort((name, _question, state) => {
    const candidate = (state as { candidate?: { title?: string; text?: string } }).candidate;
    if (name === 'useful') return noulAnswer(titles.includes(candidate?.title ?? '') ? 0.99 : 0.01);
    if (name === 'excerptUseful') return noulAnswer(excerpts.includes(candidate?.text ?? '') ? 0.99 : 0.01);
    throw new Error(`Unexpected public knowledge fixture reading: ${name}`);
  });
  const previous = installJudgmentPort(fake.port);
  try { return await action(); }
  finally { installJudgmentPort(previous); }
}
