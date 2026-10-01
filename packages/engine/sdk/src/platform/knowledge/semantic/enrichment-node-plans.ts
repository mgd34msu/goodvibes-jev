import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeNodeUpsertInput, KnowledgeSourceRecord } from '../types.js';
import type { prepareEnrichmentFactDrafts } from './enrichment-fact-drafts.js';
import type { KnowledgeSemanticExtraction, KnowledgeSemanticGapInput } from './types.js';
import { readString, semanticHash, semanticMetadata, semanticSlug } from './utils.js';

type EnrichmentFactPlan = ReturnType<typeof prepareEnrichmentFactDrafts>[number] & {
  readonly primarySourceId: string; readonly supportMetadata: unknown;
};
export function enrichmentFactNodeInput(plan: EnrichmentFactPlan, spaceId: string,
  extraction: KnowledgeExtractionRecord | null, semantic: KnowledgeSemanticExtraction, textHash: string,
): KnowledgeNodeUpsertInput {
  const { fact, factId, factLinkedObjects, sourceLinkedObjectIds, targetHints, sourceIds, primarySourceId, supportMetadata } = plan;
  return {
      id: factId,
      kind: 'fact',
      slug: semanticSlug(`${spaceId}-${fact.kind}-${fact.title}-${fact.value ?? ''}`),
      title: fact.title,
      summary: fact.summary ?? fact.value ?? fact.evidence,
      aliases: fact.labels,
      confidence: fact.confidence ?? 70,
      sourceId: primarySourceId,
      metadata: semanticMetadata(spaceId, {
        generatedFactSupport: supportMetadata,
        semanticKind: 'fact',
        factKind: fact.kind,
        value: fact.value,
        evidence: fact.evidence,
        labels: fact.labels ?? [],
        targetHints,
        ...(sourceLinkedObjectIds.length > 0 ? {
          subject: factLinkedObjects[0]?.title,
          subjectIds: sourceLinkedObjectIds,
          linkedObjectIds: sourceLinkedObjectIds,
        } : {}),
        sourceId: primarySourceId,
        sourceIds,
        extractionId: extraction?.id,
        extractor: semantic.extractor,
        textHash,
      }),
    };
}

export function enrichmentGapNodeInput(gap: KnowledgeSemanticGapInput, source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null, semantic: KnowledgeSemanticExtraction, spaceId: string,
  textHash: string, existing: KnowledgeNodeRecord | null,
): KnowledgeNodeUpsertInput {
  const id = `sem-gap-${semanticHash(spaceId, source.id, gap.question)}`;
  return {
      id,
      kind: 'knowledge_gap',
      slug: semanticSlug(`${spaceId}-gap-${gap.question}`),
      title: gap.question,
      summary: gap.reason,
      confidence: gap.severity === 'error' ? 85 : gap.severity === 'warning' ? 70 : 50,
      sourceId: source.id,
      metadata: semanticMetadata(spaceId, {
        semanticKind: 'gap',
        subject: gap.subject,
        severity: gap.severity ?? 'info',
        sourceId: source.id,
        extractionId: extraction?.id,
        extractor: semantic.extractor,
        textHash,
        repairStatus: readString(existing?.metadata.repairStatus) ?? 'open',
        visibility: 'refinement',
        displayRole: 'knowledge-gap',
      }),
    };
}
