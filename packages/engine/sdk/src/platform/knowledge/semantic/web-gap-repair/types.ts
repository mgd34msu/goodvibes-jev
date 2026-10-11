export type WebGapRepairHoldReason = 'unconfigured' | 'unavailable' | 'uncertain' | 'malformed' | 'aborted' | 'budget' | 'stale' | 'foreign-space';
export class KnowledgeWebGapRepairHeldError extends Error {
  override readonly name = 'KnowledgeWebGapRepairHeldError';
  constructor(readonly reason: WebGapRepairHoldReason) { super(`Knowledge web gap repair held (${reason}); no further discovery or ingestion was authorized.`); }
}
export const WEB_GAP_REPAIR_LIMITS = Object.freeze({ characters: 160_000, candidates: 50, requests: 110, bytes: 8_000_000, timeoutMs: 60_000 });
