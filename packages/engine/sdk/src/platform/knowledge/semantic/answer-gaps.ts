import type { KnowledgeNodeRecord } from '../types.js';
import { readString, readStringArray } from './utils.js';
export { prepareAnswerGapUniverse, type PreparedAnswerGapUniverse } from './answer-gap-plan/prepare.js';
export { isActionableAnswerGap } from './answer-gap-plan/write.js';
export { KnowledgeAnswerGapHeldError } from './answer-gap-plan/types.js';

/** Repair claims require retained real evidence, separately from lifecycle state. */
export function isRepairedAnswerGap(node: KnowledgeNodeRecord): boolean {
  if (readString(node.metadata.repairStatus) !== 'repaired') return false;
  const promotedFactCount = typeof node.metadata.promotedFactCount === 'number' ? node.metadata.promotedFactCount : 0;
  return promotedFactCount > 0 || readStringArray(node.metadata.acceptedSourceIds).length > 0;
}
