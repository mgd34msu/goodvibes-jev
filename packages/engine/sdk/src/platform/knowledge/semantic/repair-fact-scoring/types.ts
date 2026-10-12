import type { RepairFactUsefulnessInput } from '../repair-usefulness/types.js';

export type RepairFactScoringInput = RepairFactUsefulnessInput & {
  /** The actual resolved primary reference, distinct from this support edge's source. */
  readonly trustEvidence: RepairFactUsefulnessInput['evidence'][number];
};
export interface RepairFactScoringReading {
  readonly reference: string;
  /** Descriptive scores on 0-1 scales; none grants fact-serving authority. */
  readonly trust: number;
  readonly sourceSupport: number;
  readonly subjectSupport: number;
  readonly model: string;
  readonly requestedModel: string;
}
export interface RepairFactScoringOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export class KnowledgeRepairFactScoringHeldError extends Error {
  override readonly name = 'KnowledgeRepairFactScoringHeldError';
  constructor(readonly reason: 'unconfigured' | 'unavailable' | 'uncertain' | 'malformed' | 'aborted' | 'budget' | 'stale') {
    super(`Knowledge repair fact scoring held (${reason}); no scored publication was authorized.`);
  }
}
