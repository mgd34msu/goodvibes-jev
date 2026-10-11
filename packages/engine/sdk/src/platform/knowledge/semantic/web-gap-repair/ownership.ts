import { captureStrictRepairJson } from './admission.js';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { sameKnowledgeRecord } from '../../store-record-representation.js';
import { assertKnowledgeRecordContainers, prepareKnowledgeRecordAdmission } from '../../store-record-snapshot.js';
import { captureKnowledgeSourceReferences } from '../../source-structural-references.js';
import { getKnowledgeSpaceId } from '../../spaces.js';
import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeSemanticGapRepairRequest, KnowledgeSemanticGapRepairResult, KnowledgeSemanticGapRepairer } from '../types.js';
import { KnowledgeWebGapRepairHeldError as Held } from './types.js';
const repairers = new WeakSet<KnowledgeSemanticGapRepairer>();
export function registerWebGapRepairer(repairer: KnowledgeSemanticGapRepairer) { repairers.add(repairer); return repairer; }
export function bindWebGapRepairInvocation(store: KnowledgeStore, repairer: KnowledgeSemanticGapRepairer, request: KnowledgeSemanticGapRepairRequest, current: () => void) {
  return repairers.has(repairer) ? bindWebGapRepairRequest(store, request, current) : request;
}
const owners = new WeakMap<KnowledgeSemanticGapRepairRequest, () => void>();
const results = new WeakMap<KnowledgeSemanticGapRepairResult, () => void>();
/** Inspect descriptors before reading controls; unknown fields remain in full admission. */
function repairRequestFrame(request: KnowledgeSemanticGapRepairRequest) {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype || Object.getOwnPropertySymbols(request).length) throw new Held('malformed');
  const descriptors = Object.getOwnPropertyDescriptors(request);
  if (Object.values(descriptors).some(d => d.get || d.set || !d.enumerable)) throw new Held('malformed');
  const signal: unknown = descriptors.signal?.value, deadlineAt: unknown = descriptors.deadlineAt?.value;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Held('malformed');
  if (deadlineAt !== undefined && (typeof deadlineAt !== 'number' || !Number.isSafeInteger(deadlineAt) || deadlineAt < 0)) throw new Held('malformed');
  const data = Object.fromEntries(Object.entries(descriptors).filter(([key]) => key !== 'signal' && key !== 'deadlineAt').map(([key, descriptor]) => [key, descriptor.value])) as Omit<KnowledgeSemanticGapRepairRequest, 'signal' | 'deadlineAt'>;
  return { data, signal: signal as AbortSignal | undefined, deadlineAt: deadlineAt as number | undefined };
}
export function repairRequestData(request: KnowledgeSemanticGapRepairRequest) {
  return repairRequestFrame(request).data;
}
/** Host-only receipt: an arbitrary caller object cannot claim raw-row exemptions. */
export function bindWebGapRepairRequest(store: KnowledgeStore, request: KnowledgeSemanticGapRepairRequest, ownerCurrent: () => void): KnowledgeSemanticGapRepairRequest {
  const data = repairRequestData(request), snapshot = captureStrictRepairJson(data);
  const admissions = [
    ...[...request.gaps, ...request.linkedObjects, ...request.facts].map(row => prepareKnowledgeRecordAdmission(store, 'node', row)),
    ...request.sources.map(source => {
      const extraction = store.getExtractionBySourceId(source.id);
      const proof = captureKnowledgeSourceReferences(store, source, extraction);
      return prepareKnowledgeRecordAdmission(store, 'source', source, { source, extraction, proof });
    }),
  ];
  assertKnowledgeRecordContainers(data, admissions);
  const current = () => {
    ownerCurrent();
    if (!sameKnowledgeRecord(captureStrictRepairJson(repairRequestData(request)), snapshot)) throw new Held('stale');
    for (const admission of admissions) { try { admission.assertCurrent(); } catch { throw new Held('stale'); } }
  };
  current(); owners.set(request, current); return request;
}
export function captureWebGapRepairRequest(request: KnowledgeSemanticGapRepairRequest) {
  const { data, signal, deadlineAt } = repairRequestFrame(request), snapshot = captureStrictRepairJson(data);
  const owner = owners.get(request);
  if (owner) owner(); else assertJudgmentInput(data);
  if (typeof snapshot.spaceId !== 'string' || typeof snapshot.query !== 'string'
    || ![snapshot.gaps, snapshot.sources, snapshot.linkedObjects, snapshot.facts].every(value => Array.isArray(value) && Array.from(value).every(row => row && typeof row === 'object' && row.metadata && typeof row.metadata === 'object'))) throw new Held('malformed');
  for (const row of [...snapshot.gaps, ...snapshot.sources, ...snapshot.linkedObjects, ...snapshot.facts]) {
    if (getKnowledgeSpaceId(row) !== snapshot.spaceId) throw new Held('foreign-space');
    for (const key of ['knowledgeSpaceId', 'spaceId', 'namespace']) {
      const value = row.metadata[key];
      if (value !== undefined && value !== snapshot.spaceId) throw new Held('foreign-space');
    }
  }
  const assertCurrent = () => {
    const current = repairRequestFrame(request);
    if (signal?.aborted) throw new Held('aborted');
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new Held('budget');
    if (current.signal !== signal || current.deadlineAt !== deadlineAt || owners.get(request) !== owner
      || !sameKnowledgeRecord(captureStrictRepairJson(current.data), snapshot)) throw new Held('stale');
    try { owner?.(); } catch (error) { if (error instanceof Held) throw error; throw new Held('stale'); }
  };
  assertCurrent(); return { snapshot, signal, deadlineAt, assertCurrent };
}
export function ownWebGapRepairResult(result: KnowledgeSemanticGapRepairResult, current: () => void) {
  current(); results.set(result, current); return result;
}
export function assertWebGapRepairResultCurrent(result: KnowledgeSemanticGapRepairResult | void) { if (result) results.get(result)?.(); }
