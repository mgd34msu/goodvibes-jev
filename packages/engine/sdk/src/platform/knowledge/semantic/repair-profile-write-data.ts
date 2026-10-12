import { knowledgeClockIso } from '../store-record-representation.js';
import type { KnowledgeEdgeUpsertInput, KnowledgeNodeUpsertInput } from '../types.js';
import { semanticSlug } from './utils.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import type { SourceLinkedRepairProfileFactInput } from './self-improvement-promotion.js';
import type { RepairFactScoringReading } from './repair-fact-scoring/types.js';
import { generatedFactSupportMetadata } from './fact-support-write-plan.js';
import { repairSubjectHints } from './repair-subjects.js';
import { semanticMetadata } from './utils.js';
import { KnowledgeGeneratedFactSupportHeldError, type GeneratedFactSupportPlan } from './verification/types.js';

/** Resolve producer metadata callbacks before any affected persistence mutation. */
export function prepareRepairProfileWriteData(
  input: SourceLinkedRepairProfileFactInput, primarySourceId: string, sourceIds: readonly string[],
  plans: readonly GeneratedFactSupportPlan[], previousSupport: unknown, scoring: RepairFactScoringReading,
) {
  const builder = input.metadataBuilder ?? ((metadata: Record<string, unknown>) => semanticMetadata(input.spaceId, metadata));
  const build = (metadata: Record<string, unknown>): Record<string, unknown> => {
    try {
      const result = structuredClone(builder(metadata));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
      if (getKnowledgeSpaceId({ metadata: result }) !== input.spaceId) throw new KnowledgeGeneratedFactSupportHeldError('foreign-space');
      if (JSON.stringify(result.generatedFactSupport) !== JSON.stringify(metadata.generatedFactSupport)) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
      return result;
    } catch (error) {
      if (error instanceof KnowledgeGeneratedFactSupportHeldError) throw error;
      throw new KnowledgeGeneratedFactSupportHeldError('malformed');
    }
  };
  const subjectIds = input.subjects.map((subject) => subject.id);
  const attested = {
    semanticKind: 'fact', factKind: input.classification.kind, value: input.classification.value,
    evidence: input.evidence, labels: input.classification.labels, sourceId: primarySourceId,
    sourceIds, subject: input.subjects[0]?.title, subjectIds,
    targetHints: repairSubjectHints(input.subjects), linkedObjectIds: subjectIds,
  };
  const generatedFactSupport = generatedFactSupportMetadata(plans, previousSupport);
  const factScoring = { ...scoring, sourceId: input.source.id, trustSourceId: primarySourceId };
  const factMetadata = build({
    ...(input.factMetadata ?? {}), ...attested,
    extractor: input.extractor, sourceAuthority: input.authority, generatedFactSupport, factScoring,
  });
  // A metadata adapter may add namespace/display fields, never change the claim
  // or overwrite its new receipts after it has been verified.
  for (const key of Object.keys(attested) as Array<keyof typeof attested>) {
    if (JSON.stringify(factMetadata[key]) !== JSON.stringify(attested[key])) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
  }
  if (JSON.stringify(factMetadata.factScoring) !== JSON.stringify(factScoring)) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
  if (JSON.stringify(factMetadata.generatedFactSupport) !== JSON.stringify(generatedFactSupport)) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
  const supportMetadata = build({
    ...(input.edgeMetadata ?? {}),
    generatedFactSupport: generatedFactSupportMetadata(plans.filter((plan) => plan.sourceId === input.source.id), undefined),
  });
  const describesMetadata = build({
    ...(input.edgeMetadata ?? {}), repairedAt: knowledgeClockIso(Date.now()), sourceId: input.source.id,
    generatedFactSupport: generatedFactSupportMetadata(plans, undefined),
  });
  return { factMetadata, supportMetadata, describesMetadata };
}

/** The exact ordinary node input used by both preflight and persistence. */
export function repairProfileNodeInput(plan: {
  readonly input: SourceLinkedRepairProfileFactInput; readonly factId: string;
  readonly primarySourceId: string; readonly scoring: RepairFactScoringReading; readonly writeData: ReturnType<typeof prepareRepairProfileWriteData>;
}): KnowledgeNodeUpsertInput {
  const { input, factId, primarySourceId, writeData } = plan;
  return {
    id: factId, kind: 'fact', slug: semanticSlug(`${input.spaceId}-${input.title}-${input.summary}-${input.source.id}`),
    title: input.title, summary: input.summary, aliases: input.classification.aliases, status: 'active',
    confidence: plan.scoring.trust * 100,
    sourceId: primarySourceId, metadata: writeData.factMetadata,
  };
}

/** The same settled support and attachment edges used by atomic page publication. */
export function repairProfileEdgeInputs(plan: {
  readonly input: SourceLinkedRepairProfileFactInput; readonly factId: string;
  readonly writeData: ReturnType<typeof prepareRepairProfileWriteData>; readonly scoring: RepairFactScoringReading;
}): readonly KnowledgeEdgeUpsertInput[] {
  const { input, factId, writeData } = plan;
  return [
    { fromKind: 'source', fromId: input.source.id, toKind: 'node', toId: factId,
      relation: 'supports_fact', weight: plan.scoring.sourceSupport,
      metadata: writeData.supportMetadata },
    ...input.subjects.map(subject => ({ fromKind: 'node' as const, fromId: factId, toKind: 'node' as const, toId: subject.id,
      relation: 'describes', weight: plan.scoring.subjectSupport,
      metadata: writeData.describesMetadata })),
  ];
}
