import type { KnowledgeNodeRecord, KnowledgeNodeUpsertInput } from './types.js';
import type { KnowledgeStore } from './store.js';
import { snapshotNodeInput } from './activation/projection.js';
import { getKnowledgeSpaceId } from './spaces.js';
import { supportHash } from './semantic/verification/projection.js';
import { KnowledgeNodeActivationHeldError } from './activation/types.js';

export type KnowledgeObservationOrigin = 'catalog-structure' | 'memory-mirror' | 'home-assistant-snapshot' | 'browser-profile' | 'generated-page-index' | 'research-task';
interface Observation { readonly inputHash: string; readonly existingHash: string; readonly origin: KnowledgeObservationOrigin; readonly check: () => void; readonly checkEvidence: () => void; }
export interface ObservedEvidence { readonly record: KnowledgeNodeRecord; readonly origin: KnowledgeObservationOrigin; readonly assertCurrent: () => void; }
const observedRecords = new WeakMap<KnowledgeNodeRecord, ObservedEvidence>();
export function getKnowledgeNodeObservation(existing: KnowledgeNodeRecord | undefined, candidate: KnowledgeNodeRecord): ObservedEvidence | undefined {
  if (!existing || existing.id !== candidate.id || existing.kind !== candidate.kind || existing.slug !== candidate.slug
    || existing.sourceId !== candidate.sourceId || getKnowledgeSpaceId(existing) !== getKnowledgeSpaceId(candidate)) return undefined;
  const observation = observedRecords.get(existing);
  return observation && !['research-task', 'generated-page-index'].includes(observation.origin) ? observation : undefined;
}
/** Prepare all fallible snapshot work before the store's synchronous commit. */
export function prepareKnowledgeNodeObservation(candidate: KnowledgeNodeRecord,
  mapped: { readonly origin: KnowledgeObservationOrigin; readonly input: KnowledgeNodeUpsertInput; readonly checkEvidence: () => void }): ObservedEvidence {
  const record = snapshotNodeInput({ ...candidate, metadata: mapped.input.metadata ?? {}, aliases: mapped.input.aliases ?? [],
    summary: mapped.input.summary, sourceId: mapped.input.sourceId });
  return Object.freeze({ record, origin: mapped.origin, assertCurrent: mapped.checkEvidence });
}
export function retainKnowledgeNodeObservation(existing: KnowledgeNodeRecord | undefined, candidate: KnowledgeNodeRecord,
  mapped?: ObservedEvidence): void {
  const observation = mapped ?? getKnowledgeNodeObservation(existing, candidate);
  if (observation) observedRecords.set(candidate, observation);
}
const observations = new WeakMap<KnowledgeNodeUpsertInput, Observation>();
/** Internal producer seam: only code/source projections call it. Never exported through a tool or the public knowledge index. */
export function prepareObservedKnowledgeNodeInput(store: KnowledgeStore, input: KnowledgeNodeUpsertInput, origin: KnowledgeObservationOrigin,
  evidence: unknown, readEvidence: () => unknown): KnowledgeNodeUpsertInput {
  const kinds: Readonly<Record<KnowledgeObservationOrigin, readonly KnowledgeNodeRecord['kind'][]>> = {
    'catalog-structure': ['domain', 'bookmark_folder', 'topic'], 'memory-mirror': ['memory'],
    'home-assistant-snapshot': ['ha_home', 'ha_entity', 'ha_device', 'ha_area', 'ha_automation', 'ha_script', 'ha_scene', 'ha_label', 'ha_integration'],
    'browser-profile': ['source_group'], 'generated-page-index': ['ha_device_passport'], 'research-task': ['knowledge_gap'],
  };
  if (!kinds[origin]?.includes(input.kind)) throw new KnowledgeNodeActivationHeldError('malformed');
  const frozen = snapshotNodeInput(input);
  const expected = supportHash(evidence ?? null);
  const existing = input.id ? store.getNode(input.id) : store.getNodeByKindAndSlug(input.kind, input.slug);
  const checkEvidence = () => { if (supportHash(readEvidence() ?? null) !== expected) throw new KnowledgeNodeActivationHeldError('stale'); };
  const observation = Object.freeze({ inputHash: supportHash(frozen), existingHash: supportHash(existing), origin,
    check: checkEvidence, checkEvidence });
  observations.set(frozen, observation);
  return frozen;
}
export async function upsertObservedKnowledgeNode(store: KnowledgeStore, input: KnowledgeNodeUpsertInput, origin: KnowledgeObservationOrigin,
  evidence: unknown, readEvidence: () => unknown): Promise<KnowledgeNodeRecord> {
  return store.upsertNode(prepareObservedKnowledgeNodeInput(store, input, origin, evidence, readEvidence));
}
export function resolveKnowledgeNodeObservation(input: KnowledgeNodeUpsertInput, existing: KnowledgeNodeRecord | undefined): { readonly origin: KnowledgeObservationOrigin; readonly input: KnowledgeNodeUpsertInput; readonly assertCurrent: () => void; readonly checkEvidence: () => void } | undefined {
  const observation = observations.get(input);
  if (!observation) return undefined;
  const assertCurrent = () => {
    if (supportHash(input) !== observation.inputHash || supportHash(existing ?? null) !== observation.existingHash) throw new KnowledgeNodeActivationHeldError('stale');
    observation.check();
  };
  assertCurrent(); return { origin: observation.origin, input, assertCurrent, checkEvidence: observation.checkEvidence };
}

/** Staged catalog evidence is guarded before commit and read from the live store thereafter. */
export function prepareStagedObservedKnowledgeNodeInput(store: KnowledgeStore, input: KnowledgeNodeUpsertInput,
  evidence: unknown, readEvidence: () => unknown, assertCurrent: () => void): KnowledgeNodeUpsertInput {
  const frozen = prepareObservedKnowledgeNodeInput(store, input, 'catalog-structure', evidence, readEvidence);
  const observation = observations.get(frozen)!;
  observations.set(frozen, Object.freeze({ ...observation, check: assertCurrent }));
  return frozen;
}
