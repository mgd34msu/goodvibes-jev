import { validateJevDecision, type JevDecision, type JevDecisionContext } from '@goodvibes-jev/judgment/decisions';
import type { WorkExecution } from './execution-types.js';

/** Construct from independently recorded, live host facts, never the offered decision. */
export type NativeExecutionDecisionContext = (execution: Readonly<WorkExecution>) => JevDecisionContext;

export function validateNativeExecutionDecision(execution: WorkExecution, decision: JevDecision, current: NativeExecutionDecisionContext): void {
  const context = current(structuredClone(execution));
  const binding = context.binding;
  if (binding.sourceId !== execution.target.workId || binding.inputRevision !== execution.inputDigest
    || binding.actionId !== execution.id || binding.actionRevision !== execution.inputDigest
    || binding.authorityId !== execution.actorId || binding.scopeId !== execution.projectId) throw new Error('Native admission context mismatch');
  validateJevDecision(decision, context);
}
