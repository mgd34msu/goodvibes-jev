import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { OwnedJudgmentWork } from '../owned-judgment-work.js';

export class CompactionReadingError extends Error {
  constructor(readonly reason: 'malformed' | 'unqualified' | 'budget' | 'unavailable' | 'unsupported-image') {
    super(`Compaction semantic selection ${reason}; original conversation must be retained.`);
    this.name = 'CompactionReadingError';
  }
}

/** Validate injected ports too; retain only the requested typed response fields. */
export function checkedCompactionPort(port: JudgmentPort, work: OwnedJudgmentWork): JudgmentPort {
  return { ...port, async ask(request) {
    const result = await work.wait(() => port.ask(request));
    if (typeof result?.model !== 'string' || !result.model.trim()
      || typeof result.requestedModel !== 'string' || !result.requestedModel.trim()
      || !result.answers || typeof result.answers !== 'object'
      || Object.keys(result.answers).length !== Object.keys(request.questions).length) throw new CompactionReadingError('malformed');
    const answers = Object.fromEntries(Object.keys(request.questions).map(key => {
      const answer: unknown = result.answers[key];
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)
        || !('type' in answer) || answer.type !== 'noul' || !('noul' in answer)
        || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)
        || answer.noul < 0 || answer.noul > 1) throw new CompactionReadingError('malformed');
      return [key, { type: 'noul' as const, noul: answer.noul }];
    }));
    return { ...result, answers } as typeof result;
  } };
}
