import { isNativeCompletedWorkReceipt } from './response-completion-contracts.js';
import { verificationHash, verificationSources, verificationWireSource } from './verification/source.js';

/** A bounded view of already approved work and this turn's exact observations.
 * Every original instruction and the full current draft remain present. All
 * omitted historical observations remain owned by the caller's source fence
 * and available to normal retrieval if ANY final check is not settled. */
export function nativeWorkCheckpoint(original: readonly unknown[], admitted: readonly unknown[], full: Record<string, unknown>) {
  if (!original.some((value, index) => isNativeCompletedWorkReceipt(value, admitted[index]))) return undefined;
  const initial = full.initial as { request?: unknown; transcript?: readonly Record<string, unknown>[] } | null;
  const transcript = full.transcript as readonly Record<string, unknown>[];
  if (!Array.isArray(initial?.transcript) || !Array.isArray(transcript)
    || !initial.transcript.every((message, index) => JSON.stringify(message) === JSON.stringify(transcript[index]))) return undefined;
  const completedWork = (full.completedWork as readonly Record<string, unknown>[]).map(work => {
    const { units: _units, ...result } = work;
    return result;
  });
  // A privacy projection which withholds the receipt cannot support this view.
  if (!completedWork.some(work => work.kind === 'host-completed-contract' && work.status === 'passed'
    && (work.contentReview as { matchesSavedAnswer?: unknown } | null)?.matchesSavedAnswer === true
    && (work.goalCoverage as { matchesOriginalScope?: unknown } | null)?.matchesOriginalScope === true)) return undefined;
  const instructions = verificationSources(full).filter(source => source.kind === 'instruction');
  const originalUsers = instructions.filter(source => source.messageRole === 'user').map(source => {
    if (source.completeMessage) {
      try {
        const message = JSON.parse(source.text) as Record<string, unknown>;
        if (message.role === 'user') return { ...message, sourceReference: source.reference, sourceId: source.id };
      } catch { /* Exact fragments remain attached below. */ }
    }
    return { role: 'user', content: { exactOriginalInstruction: verificationWireSource(source) } };
  });
  const state = {
    request: full.request, response: full.response, tools: full.tools,
    transcript: [...originalUsers, ...transcript.slice(initial.transcript.length).filter(message => message.role !== 'user')],
    completedWork, delegated: full.delegated, requirements: full.requirements, previousReview: full.previousReview,
    originalInstructions: instructions.map(verificationWireSource),
    initial: { request: initial.request, meaning: 'Earlier observations remain in the retained original source. Native work receipts establish only their exact approved scopes.' },
    nativeWorkCheckpoint: {
      sourceDigest: verificationHash(full),
      meaning: 'Actual native original-scope and saved-content approvals are supplied for the listed work, with the exact accepted answers and publication outcomes. This is a work checkpoint, NOT permission to publish this answer. Every original instruction is retained in original source order, including repeated requests and later corrections. The current turn observations and proposed response are exact. Do not infer that another obligation, unrecorded action or later change was fulfilled. An uncovered obligation, unsupported current claim, stale approval or invalidating observation requires original-source retrieval. Only fresh current final-response, consolidation and execution checks can allow publication.',
    },
  };
  // This is selection of a complete view, never clipping instructions or proof.
  return JSON.stringify(state).length <= 192_000 ? state : undefined;
}
