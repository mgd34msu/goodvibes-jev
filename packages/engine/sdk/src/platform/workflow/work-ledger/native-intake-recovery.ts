/** Reconcile a final semantic reading across the decision-log/capture publication boundary. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson, type DecisionLog, type EntryType } from '@goodvibes-jev/judgment';
import { captureJevDecisionContext, validateJevDecision, type JevDecision } from '@goodvibes-jev/judgment/decisions';
import type { AutonomousContinuation } from '../../gate/autonomous-decision.js';
import { nativeConversationDecisionBinding, NATIVE_CONVERSATION_MAX_PROPOSALS, type NativeConversationCapture, type NativeConversationDecision } from './native-intake-types.js';
import { NATIVE_INTAKE_DECISION_SITE } from './native-intake-decisions.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function nativeIntakeContinuationCatalog(record: NativeConversationCapture) {
  const repair: AutonomousContinuation = { ref: { kind: 'revise-action', id: hash({ sourceId: record.sourceId, operation: 'propose-requirements' }), revision: hash({ generation: record.generation, spent: record.proposalsSpent }) },
    description: 'Repair the proposed original requirement ranges within the remaining bounded proposal budget; never change the source.',
    input: { proposalsSpent: record.proposalsSpent, limit: NATIVE_CONVERSATION_MAX_PROPOSALS } };
  const resolve: AutonomousContinuation = { ref: { kind: 'gather-evidence', id: hash({ sourceId: record.sourceId, operation: 'resolve-original-source' }), revision: record.sourceRevision },
    description: 'Inspect the registered original-source resolver. If required context is absent or unsupported, hold this input without inventing requirements or asking for approval.',
    input: { unsupportedSources: record.unsupportedSources.map(source => ({ kind: source.kind, label: source.label })), supportedSource: 'Complete immutable text in the input part only' } };
  const continuations = [resolve, ...(record.route === 'contract' && record.unsupportedSources.length === 0 && record.proposalsSpent < NATIVE_CONVERSATION_MAX_PROPOSALS ? [repair] : [])];
  return { repair, resolve, continuations };
}
export function nativeIntakeFinalBinding(record: NativeConversationCapture) {
  return nativeConversationDecisionBinding(record, record.route === 'contract' ? 'publish-work' : 'ordinary-turn');
}
/** Deterministic attribution permits bounded lookup without scanning unrelated source histories. */
export function nativeIntakeDecisionSite(record: NativeConversationCapture): string {
  return `${NATIVE_INTAKE_DECISION_SITE}:${hash(nativeIntakeFinalBinding(record))}`;
}
export type NativeIntakeDecisionRecovery = { readonly kind: 'none' } | { readonly kind: 'partial' } | { readonly kind: 'recorded'; readonly entry: NativeConversationDecision };
export function recoverNativeIntakeDecision(record: NativeConversationCapture, log: Pick<DecisionLog, 'get' | 'query'>): NativeIntakeDecisionRecovery {
  const entries = log.query({ site: nativeIntakeDecisionSite(record), status: 'answered', limit: 3 });
  if (entries.length === 0) return { kind: 'none' };
  if (entries.length > 2) return { kind: 'partial' }; // Shared evaluator permits at most two final readings.
  const candidates = new Map<string, NativeConversationDecision>();
  for (const entry of entries) {
    if (entry.status !== 'answered') return { kind: 'partial' };
    for (const note of entry.notes) {
      if (note.kind !== 'readings' || note.readings === null || typeof note.readings !== 'object' || Array.isArray(note.readings)) continue;
      const value = note.readings['autonomousDecision'];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      try {
        const raw = value as unknown as JevDecision;
        const context = captureJevDecisionContext({ decisionId: raw.decisionId, binding: nativeIntakeFinalBinding(record),
          judgmentDecisionIds: raw.judgmentDecisionIds, evidence: raw.evidence,
          continuations: nativeIntakeContinuationCatalog(record).continuations.map(item => item.ref), resumeConditions: [] });
        const decision = validateJevDecision(raw, context);
        if (!isDeepStrictEqual(decision.binding, nativeIntakeFinalBinding(record)) || !decision.judgmentDecisionIds.includes(entry.id)
          || !decision.evidence.some(ref => ref.id === 'native-intake-source' && ref.revision === record.sourceRevision)) return { kind: 'partial' };
        for (const id of decision.judgmentDecisionIds) {
          const supporting = log.get(id);
          if (!supporting || supporting.status !== 'answered' || !supporting.notes.some(item => item.kind === 'readings'
            && item.readings !== null && typeof item.readings === 'object' && !Array.isArray(item.readings)
            && canonicalJson(item.readings['autonomousDecision']) === canonicalJson(decision as unknown as EntryType))) return { kind: 'partial' };
        }
        candidates.set(decision.decisionId, { decision, context });
      } catch { return { kind: 'partial' }; }
    }
  }
  if (candidates.size !== 1) return { kind: 'partial' };
  return { kind: 'recorded', entry: [...candidates.values()][0]! };
}
