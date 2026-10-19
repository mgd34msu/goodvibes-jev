import type { VerificationWriter } from '../../sdk/src/platform/core/verification/types.js';

/** A predictable proposal producer for exercising native qualification and
 * lifetime behavior. Semantic correctness is tested separately with live Jev. */
export const verificationWriter: VerificationWriter = async request => {
  const context = request.context as { sources?: { id: string; text?: string; reference?: string; summary?: unknown }[]; checks?: string[] };
  if (request.operation === 'requirements') return JSON.stringify({ requirements: [{ text: 'Complete the original requested review and deliver its report.', sources: [context.sources![0]!.id] }] });
  if (request.operation === 'findings') return JSON.stringify({ findings: context.checks!.map(check => ({ check,
    issue: 'The requested integration is unresolved.', repair: 'Connect the producer and consumer required by the original task.',
    resolvedWhen: 'The observed producer output is accepted by its intended consumer.', passage: { reference: 'original requirement', quote: 'Complete the original requested review and deliver its report.' } })) });
  return JSON.stringify({ facts: [{ text: JSON.stringify(context.sources).includes('HIDDEN-MIDDLE-DEFECT') ? 'HIDDEN-MIDDLE-DEFECT remains observed.' : 'Source observations are retained with their roles and boundaries.', sources: context.sources!.slice(0, 5).map(source => source.id) }], concerns: [] });
};
