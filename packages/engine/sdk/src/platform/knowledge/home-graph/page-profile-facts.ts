import { GoodVibesSdkError } from '@goodvibes-jev/engine/errors';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { deriveRepairProfileFacts } from '../semantic/repair-profile.js';
import { semanticFactId, semanticSlug } from '../semantic/utils.js';
import type { SourceLinkedRepairProfileFactInput } from '../semantic/self-improvement-promotion.js';
import { buildHomeGraphMetadata, readRecord } from './helpers.js';
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
  readonly title: string;
  readonly summary: string;
  readonly evidence: string;
  readonly classification: ReturnType<typeof deriveRepairProfileFacts>[number];
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
  const sources = input.sources.slice(0, MAX_PROFILE_SOURCES_PER_DEVICE_PAGE);
  for (const source of sources) {
    throwIfAborted(input.signal);
    const extraction = input.extractionsBySourceId?.get(source.id) ?? input.store.getExtractionBySourceId(source.id);
    const sourceText = extractedPageSourceText(extraction);
    if (!sourceText.trim()) continue;
    const { authority } = await input.sourceReader.read(source);
    if (authority === 'unverified') continue;
    const profileFacts = deriveRepairProfileFacts({
      query: `complete features specifications ${input.device.title}`,
      source,
      text: sourceText,
    });
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

function extractedPageSourceText(extraction: ReturnType<KnowledgeStore['getExtractionBySourceId']>): string {
  if (!extraction) return '';
  const structure = readRecord(extraction.structure);
  const nestedStructure = readRecord(structure.structure);
  const metadata = readRecord(extraction.metadata);
  const nestedMetadata = readRecord(structure.metadata);
  return [
    extraction.excerpt,
    ...extraction.sections,
    typeof structure.searchText === 'string' ? structure.searchText : undefined,
    typeof structure.text === 'string' ? structure.text : undefined,
    typeof structure.content === 'string' ? structure.content : undefined,
    typeof nestedStructure.searchText === 'string' ? nestedStructure.searchText : undefined,
    typeof nestedStructure.text === 'string' ? nestedStructure.text : undefined,
    typeof nestedStructure.content === 'string' ? nestedStructure.content : undefined,
    typeof metadata.searchText === 'string' ? metadata.searchText : undefined,
    typeof metadata.text === 'string' ? metadata.text : undefined,
    typeof nestedMetadata.searchText === 'string' ? nestedMetadata.searchText : undefined,
    typeof nestedMetadata.text === 'string' ? nestedMetadata.text : undefined,
  ].filter(Boolean).join('\n\n');
}
