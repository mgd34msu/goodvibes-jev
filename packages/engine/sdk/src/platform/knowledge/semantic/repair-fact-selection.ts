import { sameKnowledgeRecord } from '../store-record-representation.js';
import { assertKnowledgeRecordContainers, KnowledgeRecordAdmissionHeldError, prepareKnowledgeRecordAdmission } from '../store-record-snapshot.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { captureKnowledgeSourceReferences, projectKnowledgeSourceReferences } from '../source-structural-references.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { repairProfileSubject } from './repair-profile.js';
import { createRepairSourceAuthorityReader, KnowledgeRepairSourceAuthorityHeldError as Held,
  type RepairSourceAuthorityInput } from './repair-source-authority/reader.js';
import { readRecord } from './utils.js';

export interface RepairFactClassification {
  readonly kind: 'feature' | 'capability' | 'specification' | 'compatibility' | 'configuration';
  readonly title: string;
  readonly value?: string | undefined;
  readonly summary: string;
  readonly labels: readonly string[];
  readonly aliases: readonly string[];
}

interface RepairAuthoritySource {
  readonly source: KnowledgeSourceRecord;
  readonly extraction: KnowledgeExtractionRecord;
  readonly text: string;
}
/** Keep the original full rows, request and caller configuration live through publication.
 * Role is a canonical semantic classification, not permission or fact support.
 * Discovery labels remain unverified claims and never establish ownership by themselves.
 */
export async function prepareRepairSourceAuthorities(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly gap: KnowledgeNodeRecord;
  readonly subjects: readonly KnowledgeNodeRecord[];
  readonly sources: readonly RepairAuthoritySource[];
  readonly signal?: AbortSignal | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}) {
  const { store, spaceId, signal, shouldStop, assertCurrent: ownerCurrent } = input;
  const originals = { gap: input.gap, subjects: input.subjects, sources: input.sources };
  // Capture structurally before property reads. This is local only: arbitrary
  // metadata is protected but is never included in the model projection.
  const snapshot = captureOwnedJson(originals) as typeof originals;

  const gapRecord = store.getNode(input.gap.id);
  const references = input.sources.map(({ source, extraction }) => captureKnowledgeSourceReferences(store, source, extraction));
  const structural = snapshot.sources.map(({ source, extraction }, index) => projectKnowledgeSourceReferences(source, extraction, references[index]));
  const admissions = [prepareKnowledgeRecordAdmission(store, 'node', input.gap),
    ...input.subjects.map(subject => prepareKnowledgeRecordAdmission(store, 'node', subject)),
    ...input.sources.flatMap(({ source, extraction }, index) => [
      prepareKnowledgeRecordAdmission(store, 'source', source, { source, extraction, proof: references[index] }),
      prepareKnowledgeRecordAdmission(store, 'extraction', extraction, { source, extraction, proof: references[index] }),
    ])];
  assertKnowledgeRecordContainers(originals, admissions);
  const sameSpace = (record: KnowledgeSourceRecord | KnowledgeExtractionRecord | KnowledgeNodeRecord) => {
    if (getKnowledgeSpaceId(record) !== spaceId) throw new Held('foreign-space');
    for (const key of ['knowledgeSpaceId', 'spaceId', 'namespace']) {
      const value = record.metadata[key];
      if (value !== undefined && (typeof value !== 'string' || value.trim() !== spaceId)) throw new Held('foreign-space');
    }
  };
  sameSpace(snapshot.gap);
  for (const subject of snapshot.subjects) sameSpace(subject);
  const assertOriginalCurrent = () => {
    if (signal?.aborted || shouldStop?.()) throw new Held('aborted');
    if (input.store !== store || input.spaceId !== spaceId || input.signal !== signal || input.shouldStop !== shouldStop
      || input.assertCurrent !== ownerCurrent || !sameKnowledgeRecord({ gap: input.gap, subjects: input.subjects, sources: input.sources }, snapshot)
      || store.getNode(input.gap.id) !== gapRecord) throw new Held('stale');
    ownerCurrent?.();
    for (const admission of admissions) {
      try { admission.assertCurrent(); } catch (error) {
        // Preserve the declared reader failure vocabulary without treating a
        // retired raw-record generation as an operational/model outage.
        if (error instanceof KnowledgeRecordAdmissionHeldError && error.reason === 'stale') throw new Held('stale');
        throw error;
      }
    }
    for (const subject of originals.subjects) if (store.getNode(subject.id) !== subject) throw new Held('stale');
    for (const { source, extraction } of originals.sources) {
      // Object identity detects delete/reinsert and ABA replacements even when
      // the restored row has identical values and timestamps.
      if (store.getSource(source.id) !== source || store.getExtractionBySourceId(source.id) !== extraction) throw new Held('stale');
    }
  };
  const selected: RepairSourceAuthorityInput[] = snapshot.sources.map(({ source, extraction, text }, index) => {
    sameSpace(source); sameSpace(extraction);
    if ((source.status !== 'indexed' && source.status !== 'pending') || extraction.sourceId !== source.id) throw new Held('stale');
    const proof = structural[index], discovery = readRecord(source.metadata.sourceDiscovery);
    return { reference: `source-${index + 1}`, query: [snapshot.gap.title, snapshot.gap.summary].filter((value) => value !== undefined).join('\n\n'),
      subjects: snapshot.subjects.map(repairProfileSubject), text,
      source: { sourceType: source.sourceType, title: source.title, summary: source.summary, description: source.description, url: source.url,
        sourceUri: proof?.omitSourceUri ? undefined : source.sourceUri, canonicalUri: proof?.omitCanonicalUri ? undefined : source.canonicalUri },
      extraction: { format: extraction.format, title: extraction.title, links: extraction.links },
      claimedProvenance: { trustReason: discovery.trustReason as string | undefined, sourceDomain: discovery.sourceDomain as string | undefined } };
  });
  const reader = createRepairSourceAuthorityReader({ signal, assertCurrent: assertOriginalCurrent });
  const readings = await reader.read(selected);
  assertOriginalCurrent(); reader.assertCurrent();
  return Object.freeze({
    sources: Object.freeze(readings.map((reading) => Object.freeze({ authority: reading.authority }))),
    assertCurrent: reader.assertCurrent,
  });
}
