import { GoodVibesSdkError } from '@goodvibes-jev/engine/errors';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { deriveRepairProfileFactPass, repairProfileSourceText, repairProfileSubject, type RepairProfileFact } from '../semantic/repair-profile.js';
import { captureKnowledgeSourceReferences } from '../source-structural-references.js';
import { createSemanticWriteGuard } from '../semantic/primary-source-plan.js';
import { semanticFactId, semanticSlug } from '../semantic/utils.js';
import type { SourceLinkedRepairProfileFactInput } from '../semantic/self-improvement-promotion.js';
import { buildHomeGraphMetadata } from './helpers.js';
import type { HomeGraphPageSourceReader } from './page-quality.js';

type ExtractionBySourceId = ReadonlyMap<string, ReturnType<KnowledgeStore['getExtractionBySourceId']>>;
const MAX_PROFILE_SOURCES_PER_DEVICE_PAGE = 8;
const PAGE_PROFILE_SOURCE_WEIGHT = 0.78;
const PAGE_PROFILE_DESCRIBES_WEIGHT = 0.76;
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GoodVibesSdkError('Home Graph device passport refresh was cancelled.', {
    category: 'timeout', source: 'runtime', operation: 'homegraph.refreshDevicePassport',
  });
}

export interface DevicePageProfileFactPlan {
  readonly node: KnowledgeNodeRecord;
  readonly source: KnowledgeSourceRecord;
  readonly extraction: KnowledgeExtractionRecord;
  readonly title: string;
  readonly summary: string;
  readonly evidence: string;
  readonly classification: RepairProfileFact;
  readonly authority: 'official-vendor' | 'vendor' | 'secondary';
}

export async function buildDevicePageProfileFacts(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly device: KnowledgeNodeRecord;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly sourceReader: HomeGraphPageSourceReader;
  readonly extractionsBySourceId?: ExtractionBySourceId | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<DevicePageProfileFactPlan[]> {
  throwIfAborted(input.signal);
  const facts: DevicePageProfileFactPlan[] = [];
  const guard = createSemanticWriteGuard(input.store, input.signal);
  guard.watch(`node:${input.device.id}`, () => input.store.getNode(input.device.id), input.device);
  const sources = input.sources.slice(0, MAX_PROFILE_SOURCES_PER_DEVICE_PAGE);
  const entries = sources.flatMap((source) => {
    guard.watch(`source:${source.id}`, () => input.store.getSource(source.id), source);
    const extraction = input.extractionsBySourceId?.get(source.id) ?? input.store.getExtractionBySourceId(source.id);
    guard.watch(`extraction:${source.id}`, () => input.store.getExtractionBySourceId(source.id), extraction);
    const text = repairProfileSourceText(extraction);
    return extraction && text.trim() ? [{ source, extraction, text }] : [];
  });
  const profiles = await deriveRepairProfileFactPass(entries.map(({ source, extraction, text }) => ({
    query: `complete features specifications ${input.device.title}`, source, extraction, text,
    subjects: [repairProfileSubject(input.device)], structuralReferences: captureKnowledgeSourceReferences(input.store, source, extraction),
  })), { signal: input.signal });
  guard.assertCurrent();
  for (const [index, { source, extraction }] of entries.entries()) {
    throwIfAborted(input.signal);
    const { authority } = await input.sourceReader.read(source);
    guard.assertCurrent();
    if (authority === 'unverified') continue;
    const profileFacts = profiles[index]!;
    for (const profileFact of profileFacts) {
      throwIfAborted(input.signal);
      const subjectIds = [input.device.id];
      const sourceIds = [source.id];
      const now = Date.now();
      const factId = semanticFactId({
        spaceId: input.spaceId,
        kind: profileFact.kind,
        title: profileFact.title,
        value: profileFact.value,
        summary: profileFact.summary,
        subjectIds,
        fallbackScope: source.id,
      });
      facts.push({
        node: {
          id: factId,
          kind: 'fact',
          slug: semanticSlug(`${input.spaceId}-${profileFact.title}-${profileFact.summary}-${source.id}`),
          title: profileFact.title,
          summary: profileFact.summary,
          aliases: profileFact.aliases,
          status: 'active',
          confidence: 72,
          sourceId: source.id,
          metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
            semanticKind: 'fact',
            factKind: profileFact.kind,
            value: profileFact.value,
            evidence: profileFact.evidence,
            labels: profileFact.labels,
            sourceId: source.id,
            sourceIds,
            subject: input.device.title,
            subjectIds,
            targetHints: [{ id: input.device.id, title: input.device.title, kind: input.device.kind }],
            linkedObjectIds: subjectIds,
            extractor: 'page-profile',
            sourceAuthority: authority,
          }),
          createdAt: now,
          updatedAt: now,
        },
        source,
        extraction,
        title: profileFact.title,
        summary: profileFact.summary,
        evidence: profileFact.evidence,
        classification: profileFact,
        authority: authority,
      });
    }
  }
  return facts;
}

export function devicePageProfileFactInput(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  device: KnowledgeNodeRecord,
  fact: DevicePageProfileFactPlan,
): SourceLinkedRepairProfileFactInput {
  return {
    store,
    spaceId,
    source: fact.source,
    extraction: fact.extraction,
    subjects: [device],
    authority: fact.authority,
    title: fact.title,
    summary: fact.summary,
    evidence: fact.evidence,
    classification: fact.classification,
    extractor: 'page-profile',
    confidence: 72,
    supportWeight: PAGE_PROFILE_SOURCE_WEIGHT,
    describesWeight: PAGE_PROFILE_DESCRIBES_WEIGHT,
    edgeMetadata: {
      linkedBy: 'generated-page-profile',
    },
    metadataBuilder: (metadata) => buildHomeGraphMetadata(spaceId, installationId, metadata),
  };
}
