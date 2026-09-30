import { randomUUID } from 'node:crypto';
import { snapshotNodeInput } from './activation/projection.js';
import { knowledgeIngestGuard } from './ingest-preparation.js';
import { KnowledgeExtractionJudgmentHoldError } from './extraction-policy.js';
import { stableText } from './store-schema.js';
import { prepareStagedObservedKnowledgeNodeInput, upsertObservedKnowledgeNode } from './store-node-observation.js';
import {
  emitKnowledgeCompileCompleted,
  emitKnowledgeExtractionCompleted,
  emitKnowledgeExtractionFailed,
} from '../runtime/emitters/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { extractKnowledgeArtifact } from './extractors.js';
import { prepareKnowledgeExtraction, consumeKnowledgeExtraction, type PreparedKnowledgeExtraction } from './prepared-extraction.js';
import { knowledgeExtractionNeedsRefresh } from './extraction-policy.js';
import {
  canonicalizeUri,
  extractTaggedValues,
  mergeTags,
  readMetadataStrings,
  slugify,
} from './shared.js';
import type { KnowledgeIngestContext } from './ingest-context.js';
import { readKnowledgeEntityAliases } from './entity-aliases.js';
import type {
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
  KnowledgeNodeUpsertInput,
  KnowledgeEdgeUpsertInput,
} from './types.js';
import { getKnowledgeSpaceId, knowledgeSpaceMetadata } from './spaces.js';

const MAX_EXTRACTION_SECTION_NODES = 12;
const MAX_EXTRACTION_LINK_EDGES = 24;
const MAX_ENTITY_HINT_VALUES_PER_KIND = 8;

export async function finalizeKnowledgeIngestedSource(
  context: KnowledgeIngestContext,
  input: {
    readonly sourceId: string;
    readonly artifactId: string;
    readonly inputTitle?: string | undefined;
    readonly preparedExtraction?: PreparedKnowledgeExtraction | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly sourceType: KnowledgeSourceType;
    readonly connectorId: string;
    readonly tags: readonly string[];
    readonly folderPath?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly metadata: Record<string, unknown>;
  },
): Promise<{ source: KnowledgeSourceRecord; artifactId: string; extraction: KnowledgeExtractionRecord }> {
  const { preparedExtraction, signal, ...values } = input;
  input = { ...snapshotNodeInput(values), preparedExtraction, signal };
  await context.store.init();
  const assertCurrent = knowledgeIngestGuard(context, input.sourceId, canonicalizeUri(context.artifactStore.getRecord(input.artifactId)?.sourceUri ?? '') ?? undefined, signal);
  assertCurrent();
  try {
    const token = input.preparedExtraction ?? await prepareKnowledgeExtraction(context, input.sourceId, input.artifactId);
    const { record, extracted, assertCurrent: assertExtractionCurrent } = consumeKnowledgeExtraction(context, token, input.sourceId, input.artifactId);
    const canonicalUri = canonicalizeUri(record.sourceUri ?? '');
    const previousExtraction = context.store.getExtractionBySourceId(input.sourceId);
    const extractionEvidence = {
      title: stableText(extracted.title) ?? previousExtraction?.title,
      summary: stableText(extracted.summary) ?? previousExtraction?.summary,
    };
    const extractionId = previousExtraction?.id ?? `extract-${randomUUID().slice(0, 8)}`;
    const initialStatus = context.store.status();
    let committed: { source: KnowledgeSourceRecord; extraction: KnowledgeExtractionRecord } | undefined;
    let assertAliasesCurrent = () => {};
    const assertPrepared = () => {
      assertCurrent();
      assertExtractionCurrent();
      assertAliasesCurrent();
      if (context.artifactStore.getRecord(input.artifactId)?.sha256 !== token.contentHash) throw new KnowledgeExtractionJudgmentHoldError();
    };
    await context.store.applyPreparedIngest({
      sources: [{
        id: input.sourceId, connectorId: input.connectorId, sourceType: input.sourceType,
        title: input.inputTitle?.trim() || extractionEvidence.title || record.filename,
        sourceUri: record.sourceUri, canonicalUri: canonicalUri ?? undefined,
        summary: extractionEvidence.summary, description: stableText(extracted.excerpt) ?? previousExtraction?.excerpt,
        tags: input.tags, folderPath: input.folderPath, status: 'indexed', artifactId: input.artifactId,
        contentHash: record.sha256, lastCrawledAt: Date.now(), sessionId: input.sessionId,
        metadata: { ...input.metadata, contentType: record.mimeType, extractionId,
          extractionFormat: extracted.format, outboundLinks: extracted.links },
      }],
      extractions: [{ id: extractionId, sourceId: input.sourceId, artifactId: input.artifactId,
        extractorId: extracted.extractorId, format: extracted.format, title: extracted.title,
        summary: extracted.summary, excerpt: extracted.excerpt, sections: extracted.sections,
        links: extracted.links, estimatedTokens: extracted.estimatedTokens, structure: extracted.structure, metadata: extracted.metadata }],
      nodes: [], edges: [], issues: [],
    }, async (stage) => {
      assertPrepared();
      const source = stage.sources[0]!;
      const extraction = stage.extractions[0]!;
      committed = { source, extraction };
      const entityHints = await prepareKnowledgeStructuredEntityHints(source, extraction, signal, (guard) => { assertAliasesCurrent = guard; });
      const check = () => { assertPrepared(); stage.assertCurrent(); };
      const draft = stagedCompileWriter(context, check);
      await compileKnowledgeSourceRecords(context, source, extraction, entityHints, draft.writer);
      check();
      return { nodes: [...draft.nodes.values()], edges: draft.edges, issues: [], assertCurrent: assertPrepared };
    }, { signal });
    const { source, extraction } = committed!;
    context.emitIfReady((bus, ctx) => emitKnowledgeExtractionCompleted(bus, ctx, {
      sourceId: input.sourceId, extractionId: extraction.id, format: extraction.format, estimatedTokens: extraction.estimatedTokens,
    }), input.sessionId);
    const finalStatus = context.store.status();
    context.emitIfReady((bus, ctx) => emitKnowledgeCompileCompleted(bus, ctx, {
      sourceId: source.id, nodeCount: Math.max(0, finalStatus.nodeCount - initialStatus.nodeCount),
      edgeCount: Math.max(0, finalStatus.edgeCount - initialStatus.edgeCount),
    }), source.sessionId);
    void Promise.resolve(context.semanticEnrichSource?.(source.id, readKnowledgeSpaceId(source.metadata))).catch((error: unknown) => {
      logger.warn('Knowledge semantic enrichment after ingest failed', {
        sourceId: source.id,
        error: summarizeError(error),
      });
    });
    await context.syncReviewedMemory();
    return { source, artifactId: input.artifactId, extraction };
  } catch (error) {
    context.emitIfReady((bus, ctx) => emitKnowledgeExtractionFailed(bus, ctx, {
      sourceId: input.sourceId,
      error: summarizeError(error),
    }), input.sessionId);
    throw error;
  }
}

function readKnowledgeSpaceId(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.knowledgeSpaceId ?? metadata.spaceId ?? metadata.namespace;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function recompileKnowledgeSource(context: KnowledgeIngestContext, source: KnowledgeSourceRecord): Promise<void> {
  const extraction = source.id ? context.store.getExtractionBySourceId(source.id) : null;
  if (source.artifactId && await knowledgeExtractionNeedsRefresh(extraction)) {
    const content = await context.artifactStore.readContent(source.artifactId);
    const extracted = await extractKnowledgeArtifact(content.record, content.buffer);
    await context.store.upsertExtraction({
      sourceId: source.id,
      artifactId: source.artifactId,
      extractorId: extracted.extractorId,
      format: extracted.format,
      title: extracted.title,
      summary: extracted.summary,
      excerpt: extracted.excerpt,
      sections: extracted.sections,
      links: extracted.links,
      estimatedTokens: extracted.estimatedTokens,
      structure: extracted.structure,
      metadata: extracted.metadata,
    });
  }
  await compileKnowledgeSource(context, context.store.getSource(source.id) ?? source, context.store.getExtractionBySourceId(source.id));
}

export async function compileKnowledgeSource(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction?: KnowledgeExtractionRecord | null,
): Promise<void> {
  const entityHints = await prepareKnowledgeStructuredEntityHints(source, extraction);
  await compileKnowledgeSourceWithHints(context, source, extraction, entityHints);
}

async function compileKnowledgeSourceWithHints(context: KnowledgeIngestContext, source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined, entityHints: readonly CompiledEntityHint[]): Promise<void> {
  const initialNodeCount = context.store.status().nodeCount;
  const initialEdgeCount = context.store.status().edgeCount;
  await context.store.batch(async () => {
    await compileKnowledgeSourceRecords(context, source, extraction, entityHints);
  });

  const finalStatus = context.store.status();
  context.emitIfReady((bus, ctx) => emitKnowledgeCompileCompleted(bus, ctx, {
    sourceId: source.id,
    nodeCount: Math.max(0, finalStatus.nodeCount - initialNodeCount),
    edgeCount: Math.max(0, finalStatus.edgeCount - initialEdgeCount),
  }), source.sessionId);
}

interface KnowledgeCompileWriter {
  node(input: KnowledgeNodeUpsertInput): Promise<{ readonly id: string }>;
  observed(input: KnowledgeNodeUpsertInput, evidence: unknown, readEvidence: () => unknown): Promise<{ readonly id: string }>;
  edge(input: KnowledgeEdgeUpsertInput): Promise<unknown>;
}
function retainedCompileWriter(context: KnowledgeIngestContext): KnowledgeCompileWriter {
  return {
    node: (input) => context.store.upsertNode(input),
    observed: (input, evidence, readEvidence) => upsertObservedKnowledgeNode(context.store, input, 'catalog-structure', evidence, readEvidence),
    edge: (input) => context.store.upsertEdge(input),
  };
}

function stagedCompileWriter(context: KnowledgeIngestContext, assertCurrent: () => void) {
  const nodes = new Map<string, KnowledgeNodeUpsertInput>();
  const edges: KnowledgeEdgeUpsertInput[] = [];
  function stageNode(input: KnowledgeNodeUpsertInput, observed?: { evidence: unknown; readEvidence: () => unknown }) {
    const key = JSON.stringify([input.kind, input.slug]);
    const prior = nodes.get(key);
    const id = prior?.id ?? context.store.getNodeByKindAndSlug(input.kind, input.slug)?.id ?? `node-${randomUUID().slice(0, 8)}`;
    const candidate = { ...prior, ...input, id, metadata: { ...prior?.metadata, ...input.metadata } };
    nodes.set(key, observed ? prepareStagedObservedKnowledgeNodeInput(context.store, candidate,
      observed.evidence, observed.readEvidence, assertCurrent) : snapshotNodeInput(candidate));
    return { id };
  }
  const writer: KnowledgeCompileWriter = {
    node: async (input) => stageNode(input),
    observed: async (input, evidence, readEvidence) => stageNode(input, { evidence, readEvidence }),
    edge: async (input) => { edges.push(snapshotNodeInput(input)); },
  };
  return { writer, nodes, edges };
}

async function compileKnowledgeSourceRecords(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined,
  entityHints: readonly CompiledEntityHint[],
  writer: KnowledgeCompileWriter = retainedCompileWriter(context),
): Promise<void> {
  const spaceId = getKnowledgeSpaceId(source);
  if (source.artifactId) {
    await writer.edge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'artifact',
      toId: source.artifactId,
      relation: 'snapshotted_as',
      metadata: knowledgeSpaceMetadata(spaceId),
    });
  }

  const domain = source.canonicalUri ?? source.sourceUri;
  if (domain) {
    let hostname: string | undefined;
    try { hostname = new URL(domain).hostname.toLowerCase(); }
    catch (error) {
      logger.debug('Knowledge ingest: source URL could not be canonicalized for domain node', {
        sourceId: source.id, uri: domain, error: summarizeError(error),
      });
    }
    if (hostname !== undefined) {
      const domainNode = await writer.observed({
        kind: 'domain',
        slug: slugify(`${spaceId}-${hostname}`),
        title: hostname,
        summary: `Knowledge sources cataloged under ${hostname}.`,
        aliases: [hostname],
        metadata: knowledgeSpaceMetadata(spaceId, { hostname }),
      }, source, () => context.store.getSource(source.id));
      await writer.edge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: domainNode.id,
        relation: 'belongs_to_domain',
        metadata: knowledgeSpaceMetadata(spaceId),
      });
    }
  }

  if (source.folderPath) {
    const segments = source.folderPath.split('/').map((entry) => entry.trim()).filter(Boolean);
    let previousNode: { readonly id: string } | null = null;
    let accumulated = '';
    for (const segment of segments) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const folderNode = await writer.observed({
        kind: 'bookmark_folder',
        slug: slugify(`${spaceId}-${accumulated}`),
        title: segment,
        summary: `Bookmark folder ${accumulated}.`,
        aliases: [accumulated],
        metadata: knowledgeSpaceMetadata(spaceId, { folderPath: accumulated }),
      }, source, () => context.store.getSource(source.id));
      if (previousNode) {
        await writer.edge({
          fromKind: 'node',
          fromId: previousNode.id,
          toKind: 'node',
          toId: folderNode.id,
          relation: 'contains_folder',
          metadata: knowledgeSpaceMetadata(spaceId),
        });
      }
      previousNode = folderNode;
    }
    if (previousNode) {
      await writer.edge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: previousNode.id,
        relation: 'cataloged_in_folder',
        metadata: knowledgeSpaceMetadata(spaceId),
      });
    }
  }

  for (const tag of source.tags) {
    const topicNode = await writer.observed({
      kind: 'topic',
      slug: slugify(`${spaceId}-${tag}`),
      title: tag,
      summary: `Topic tag ${tag}.`,
      aliases: [tag],
      metadata: knowledgeSpaceMetadata(spaceId, { tag }),
    }, source, () => context.store.getSource(source.id));
    await writer.edge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: topicNode.id,
      relation: 'tagged_with',
      metadata: knowledgeSpaceMetadata(spaceId),
    });
  }

  await writeKnowledgeStructuredEntityHints(context, source, entityHints, writer);

  if (extraction) {
    const tagSlugs = new Set(source.tags.map((tag) => slugify(tag)));
    const sectionTitles: string[] = [];
    const seenSectionSlugs = new Set<string>();
    for (const section of extraction.sections.map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
      const sectionSlug = slugify(section);
      if (!sectionSlug || seenSectionSlugs.has(sectionSlug)) continue;
      seenSectionSlugs.add(sectionSlug);
      sectionTitles.push(section);
      if (sectionTitles.length >= MAX_EXTRACTION_SECTION_NODES) break;
    }
    for (const section of sectionTitles) {
      if (tagSlugs.has(slugify(section))) continue;
      const topicNode = await writer.observed({
        kind: 'topic',
        slug: slugify(`${spaceId}-${section}`),
        title: section,
        summary: `Compiled section or concept from source ${source.id}.`,
        aliases: [section],
        metadata: knowledgeSpaceMetadata(spaceId, {
          sourceId: source.id,
          extractionId: extraction.id,
        }),
      }, { source, extraction }, () => ({ source: context.store.getSource(source.id), extraction: context.store.getExtractionBySourceId(source.id) }));
      await writer.edge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: topicNode.id,
        relation: 'mentions_section',
        metadata: knowledgeSpaceMetadata(spaceId),
      });
    }
    const outboundUris = [...new Set(extraction.links
      .map((link) => canonicalizeUri(link))
      .filter((link): link is string => link !== null))]
      .slice(0, MAX_EXTRACTION_LINK_EDGES);
    for (const canonicalOutbound of outboundUris) {
      const linked = context.store.getSourceByCanonicalUri(canonicalOutbound);
      if (!linked) continue;
      await writer.edge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'source',
        toId: linked.id,
        relation: 'links_to_source',
        metadata: knowledgeSpaceMetadata(spaceId),
      });
    }
  }

  if (source.sessionId) {
    await writer.edge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'session',
      toId: source.sessionId,
      relation: 'ingested_during',
      metadata: knowledgeSpaceMetadata(spaceId),
    });
  }
}

export async function compileKnowledgeStructuredEntityHints(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction?: KnowledgeExtractionRecord | null,
): Promise<void> {
  const entityHints = await prepareKnowledgeStructuredEntityHints(source, extraction);
  await writeKnowledgeStructuredEntityHints(context, source, entityHints);
}

interface CompiledEntityHint {
  readonly kind: KnowledgeNodeRecord['kind'];
  readonly title: string;
  readonly relation: string;
  readonly summaryPrefix: string;
  readonly aliases: readonly string[];
}

async function prepareKnowledgeStructuredEntityHints(
  source: Pick<KnowledgeSourceRecord, 'id' | 'sourceType' | 'sourceUri' | 'title' | 'summary' | 'tags' | 'metadata'>,
  extraction: Pick<KnowledgeExtractionRecord, 'summary' | 'sections'> | null | undefined,
  signal?: AbortSignal,
  retainGuard?: (assertCurrent: () => void) => void,
): Promise<readonly CompiledEntityHint[]> {
  const metadata = source.metadata ?? {};
  const entitySpecs: Array<{
    kind: KnowledgeNodeRecord['kind'];
    values: readonly string[];
    relation: string;
    summaryPrefix: string;
  }> = [
    {
      kind: 'project',
      values: mergeTags(
        extractTaggedValues(source.tags, ['project', 'proj']),
        readMetadataStrings(metadata, ['project', 'projects']),
      ),
      relation: 'belongs_to_project',
      summaryPrefix: 'Project',
    },
    {
      kind: 'capability',
      values: mergeTags(
        extractTaggedValues(source.tags, ['capability', 'feature']),
        readMetadataStrings(metadata, ['capability', 'capabilities', 'feature', 'features']),
      ),
      relation: 'documents_capability',
      summaryPrefix: 'Capability',
    },
    {
      kind: 'repo',
      values: mergeTags(
        extractTaggedValues(source.tags, ['repo', 'repository']),
        readMetadataStrings(metadata, ['repo', 'repository', 'repositories']),
        source.sourceType === 'repo' ? [source.title ?? source.sourceUri ?? source.id] : [],
      ),
      relation: 'references_repo',
      summaryPrefix: 'Repository',
    },
    {
      kind: 'provider',
      values: mergeTags(
        extractTaggedValues(source.tags, ['provider']),
        readMetadataStrings(metadata, ['provider', 'providers']),
      ),
      relation: 'references_provider',
      summaryPrefix: 'Provider',
    },
    {
      kind: 'service',
      values: mergeTags(
        extractTaggedValues(source.tags, ['service']),
        readMetadataStrings(metadata, ['service', 'services']),
      ),
      relation: 'references_service',
      summaryPrefix: 'Service',
    },
    {
      kind: 'environment',
      values: mergeTags(
        extractTaggedValues(source.tags, ['env', 'environment']),
        readMetadataStrings(metadata, ['env', 'environment', 'environments']),
      ),
      relation: 'references_environment',
      summaryPrefix: 'Environment',
    },
    {
      kind: 'user',
      values: mergeTags(
        extractTaggedValues(source.tags, ['user', 'owner']),
        readMetadataStrings(metadata, ['user', 'users', 'owner', 'owners']),
      ),
      relation: 'references_user',
      summaryPrefix: 'User',
    },
  ];

  const entities = entitySpecs.flatMap((spec) => spec.values.slice(0, MAX_ENTITY_HINT_VALUES_PER_KIND)
    .map((value) => ({ kind: spec.kind, title: value.trim(), relation: spec.relation, summaryPrefix: spec.summaryPrefix }))
    .filter((entity) => entity.title.length > 0));
  const aliases = await readKnowledgeEntityAliases(entities, {
    title: source.title ?? '', summary: source.summary ?? '',
    extractionSummary: extraction?.summary ?? '', sections: extraction?.sections ?? [],
  }, signal, retainGuard);
  return entities.map((entity, index) => ({ ...entity, aliases: aliases[index]! }));
}

async function writeKnowledgeStructuredEntityHints(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  entities: readonly CompiledEntityHint[],
  writer: KnowledgeCompileWriter = retainedCompileWriter(context),
): Promise<void> {
  const spaceId = getKnowledgeSpaceId(source);
  for (const entity of entities) {
    const { kind, title, summaryPrefix, aliases, relation } = entity;
    const node = await writer.node({
      kind,
      slug: slugify(`${spaceId}-${title}`),
      title,
      summary: `${summaryPrefix} entity compiled from structured knowledge sources.`,
      aliases,
      metadata: knowledgeSpaceMetadata(spaceId, {
        compiledFrom: source.id,
        tags: [...source.tags],
      }),
    });
    await writer.edge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: node.id,
      relation,
      metadata: knowledgeSpaceMetadata(spaceId),
    });
  }
}
