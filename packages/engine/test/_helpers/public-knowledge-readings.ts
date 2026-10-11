import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

/** Exact authored public-retrieval fixtures; never a production classifier. */
export async function withPublicKnowledgeReadings<T>(
  titles: readonly string[],
  excerpts: readonly string[],
  action: () => T | Promise<T>,
): Promise<T> {
  const fake = fakePort((name, _question, state) => {
    if (name === 'included') {
      if (!state || typeof state !== 'object' || !('candidate' in state)) throw new Error('Missing public scope candidate.');
      const candidate = state.candidate;
      if (!candidate || typeof candidate !== 'object' || !('kind' in candidate)
        || (candidate.kind !== 'source' && candidate.kind !== 'node') || !('content' in candidate)) {
        throw new Error('Malformed public scope candidate.');
      }
      const content = candidate.content;
      if (!content || typeof content !== 'object' || !('title' in content) || typeof content.title !== 'string'
        || !titles.includes(content.title)) throw new Error('Unscripted public scope title.');
      return noulAnswer(0.99);
    }
    const candidate = (state as { candidate?: { title?: string; text?: string } }).candidate;
    if (name === 'useful') return noulAnswer(titles.includes(candidate?.title ?? '') ? 0.99 : 0.01);
    if (name === 'excerptUseful') return noulAnswer(excerpts.includes(candidate?.text ?? '') ? 0.99 : 0.01);
    throw new Error(`Unexpected public knowledge fixture reading: ${name}`);
  });
  const previous = installJudgmentPort(fake.port);
  try { return await action(); }
  finally { installJudgmentPort(previous); }
}
