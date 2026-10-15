export type WebGapRepairHoldReason = 'unconfigured' | 'unavailable' | 'uncertain' | 'malformed' | 'aborted' | 'budget' | 'stale' | 'foreign-space';
export class KnowledgeWebGapRepairHeldError extends Error {
  override readonly name = 'KnowledgeWebGapRepairHeldError';
  constructor(readonly reason: WebGapRepairHoldReason) { super(`Knowledge web gap repair held (${reason}); no further discovery or ingestion was authorized.`); }
}
export const WEB_GAP_REPAIR_LIMITS = Object.freeze({ characters: Number.POSITIVE_INFINITY, candidates: Number.POSITIVE_INFINITY, requests: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY, timeoutMs: 2_147_483_647 });
