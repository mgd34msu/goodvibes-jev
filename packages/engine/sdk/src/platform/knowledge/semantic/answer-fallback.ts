import type { KnowledgeNodeRecord } from '../types.js';
import { readString } from './utils.js';
export interface AnswerFallbackEvidence { readonly title: string; readonly excerpt?: string | undefined; }
export interface FallbackAnswer { readonly text: string; readonly synthesized: boolean; }
export interface AnswerFallbackPolicy {
  readonly renderInsufficientFacts?: (input: { readonly query: string; readonly sourceTitles: readonly string[] }) => FallbackAnswer;
  readonly renderNoMatch?: ((query: string) => FallbackAnswer) | undefined;
}
/**
 * Literal content rendering only. No feature extraction, synonym expansion,
 * topic exclusion or quality decision. Callers must verify this candidate.
 */
export function renderFallbackAnswer(query: string, mode: string, evidence: readonly AnswerFallbackEvidence[],
  facts: readonly KnowledgeNodeRecord[], policy: AnswerFallbackPolicy = {},
): FallbackAnswer {
  const count = mode === 'detailed' ? 12 : mode === 'concise' ? 3 : 8;
  const phrases = facts.slice(0, count).map((fact) => {
    const content = readString(fact.metadata.value) ?? fact.summary ?? readString(fact.metadata.evidence);
    return content ? `${fact.title}: ${content}` : fact.title;
  }).filter((text) => text.trim());
  const excerpts = evidence.slice(0, count).map((item) => item.excerpt?.trim()).filter((text): text is string => Boolean(text));
  const content = [...phrases, ...excerpts].join('\n\n');
  if (content.trim()) {
    // Display budget only. Full extraction remains in the fidelity/sufficiency
    // input; cutting a qualifier cannot independently authorize this candidate.
    const text = content.length <= 14_000 ? content
      : `${content.slice(0, 14_000)}\n[Literal excerpt truncated for display; additional source text was supplied to verification.]`;
    return { text, synthesized: true };
  }
  const sourceTitles = evidence.map((item) => item.title);
  if (sourceTitles.length) return policy.renderInsufficientFacts?.({ query, sourceTitles })
    ?? { text: 'Matching sources have no extracted evidence available for a verified answer.', synthesized: false };
  return policy.renderNoMatch?.(query) ?? { text: `No knowledge matched "${query}".`, synthesized: false };
}
