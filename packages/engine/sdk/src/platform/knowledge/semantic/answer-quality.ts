import type { KnowledgeAnswerQuality } from './answer-verification/types.js';

/** Composition of settled readings, never a keyword/fact-count confidence proxy. */
export function answerNeedsEvidenceGap(quality: KnowledgeAnswerQuality | undefined): boolean {
  return quality?.evidenceSufficient?.outcome === 'act' && quality.evidenceSufficient.verdict === 'no';
}
export function answerHasCompleteVerification(quality: KnowledgeAnswerQuality | undefined): boolean {
  return quality?.status === 'verified' && quality.fidelity?.outcome === 'act' && quality.fidelity.verdict === 'supported'
    && quality.evidenceSufficient?.verdict === 'yes' && quality.answerComplete?.verdict === 'yes';
}
/** Public display scale is0–100; its sole source is measured supported fidelity. */
export function answerConfidence(quality: KnowledgeAnswerQuality | null | undefined): number {
  const reading = quality?.fidelity;
  if (!reading || reading.outcome !== 'act' || reading.verdict !== 'supported'
    || !Number.isFinite(reading.probability) || reading.probability < 0 || reading.probability > 1) return 0;
  return Math.round(reading.probability * 100);
}
