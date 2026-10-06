import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { KnowledgeAnswerQualityHeldError } from './answer-verification/types.js';

/** Preserve earlier answer configuration through the later gap judgment awaits. */
const ANSWER_READING_SITES = ['engine.knowledge.answer-evidence-relevance', 'engine.knowledge.answer-excerpt-selection',
    'engine.knowledge.answer-fact-rank', 'engine.knowledge.answer-query-intent', 'engine.knowledge.answer-integration-intent',
    'engine.knowledge.answer-object-alignment', 'engine.knowledge.answer-source-rank', 'engine.knowledge.answer-quality'];
export function captureAnswerReadingPorts(sites: readonly string[] = ANSWER_READING_SITES): () => void {
  const current = (site: string) => { try { return judgmentPort(site); } catch { return undefined; } };
  const configured = sites.map((site) => { const port = current(site); return { site, port, model: port?.model }; });
  return () => { for (const { site, port, model } of configured) if (current(site) !== port || port?.model !== model) throw new KnowledgeAnswerQualityHeldError('stale'); };
}
