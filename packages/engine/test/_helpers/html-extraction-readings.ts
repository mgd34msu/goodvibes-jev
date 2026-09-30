import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

/** Fixed answers for synthetic HTML fixtures, never a content classifier. */
export function htmlExtractionPort(options: { readonly rejectedBlocks?: readonly string[]; readonly title?: string } = {}) {
  return fakePort((name, question) => {
    if (question.type === 'choice') return choiceAnswer(question, options.title ?? 'title-1', 0.99);
    if (name.startsWith('main_') || name.startsWith('fits_')) return noulAnswer(options.rejectedBlocks?.includes(name) ? 0.01 : 0.99);
    throw new Error(`Unexpected synthetic HTML judgment: ${name}`);
  });
}

export async function withHtmlExtractionReadings<T>(options: Parameters<typeof htmlExtractionPort>[0], body: () => Promise<T>): Promise<T> {
  const previous = installJudgmentPort(htmlExtractionPort(options).port);
  try { return await body(); }
  finally { installJudgmentPort(previous); }
}
