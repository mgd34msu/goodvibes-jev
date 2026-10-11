import { createAskPageRecovery } from './ask-page-recovery.js';
import { snapshotNodeInput } from '../activation/projection.js';
import { KnowledgeGeneratedFactSupportHeldError } from '../semantic/verification/types.js';
import { restoreKnowledgeSourceAnswerAliases } from '../source-structural-references.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import { logger } from '../../utils/logger.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeEdgeUpsertInput, KnowledgeNodeRecord, KnowledgeNodeUpsertInput, KnowledgeSourceRecord } from '../types.js';
import {
  buildHomeGraphMetadata,
  isGeneratedPageSource,
  mergeSourceStatus,
  readHomeAssistantMetadataString,
  readStringArray,
  uniqueStrings,
} from './helpers.js';
import { refreshHomeGraphDevicePassport } from './generated-pages.js';
import {
  createHomeGraphPageSourceReader,
  createHomeGraphPageFactReader,
} from './page-quality.js';
import { isKnowledgeSourceQualityFailure } from '../source-quality.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { createSemanticWriteGuard } from '../semantic/primary-source-plan.js';
import type { HomeGraphAskResult } from './types.js';

const MAX_ASK_REFRESH_DEVICES = 2;
const MAX_ASK_PAGE_SOURCES_TO_CONSIDER = 16;
const MAX_ASK_PAGE_SOURCES_TO_LINK = 8;
const ASK_FACT_SOURCE_WEIGHT = 0.82;
const ASK_FACT_DESCRIBES_WEIGHT = 0.8;

export async function refreshDevicePagesForHomeGraphAsk(input: {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly answer: HomeGraphAskResult;
  readonly signal?: AbortSignal | undefined;
}): Promise<{ readonly requested: boolean; readonly refreshed: number }> {
  if ((input.answer.answer.facts?.length ?? 0) === 0 && input.answer.answer.sources.length === 0) return { requested: false, refreshed: 0 };
  const devices = input.answer.answer.linkedObjects.filter((node) => node.kind === 'ha_device' && getKnowledgeSpaceId(node) === input.spaceId).slice(0, MAX_ASK_REFRESH_DEVICES);
  // The answer selected these exact rows. A fresh current-row baseline cannot
  // silently rebind that selection to a different device or installation.
  const selectedDevices = createSemanticWriteGuard(input.store);
  for (const device of devices) selectedDevices.watch(`selected-device:${device.id}`,
    () => input.store.getNode(device.id), snapshotNodeInput(device));
  selectedDevices.assertCurrent();
  const store = input.store, artifactStore = input.artifactStore, signal = input.signal;
  const request = JSON.stringify({ spaceId: input.spaceId, installationId: input.installationId, answer: input.answer });
  const selected = devices.map((device) => ({ device, current: store.getNode(device.id) }));
  const recovery = createAskPageRecovery(store, input.spaceId, () => {
    selectedDevices.assertCurrent();
    if (input.store !== store || input.artifactStore !== artifactStore || input.signal !== signal
      || JSON.stringify({ spaceId: input.spaceId, installationId: input.installationId, answer: input.answer }) !== request
      || selected.some(({ device, current }) => store.getNode(device.id) !== current)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  }, signal);
  try {
    await persistAnswerFactSubjectLinks({
      store: input.store,
      spaceId: input.spaceId,
      installationId: input.installationId,
      devices,
      assertSelectedDevicesCurrent: recovery.assertCurrent,
      sourceWritten: recovery.acknowledgeSourceWritten,
      facts: input.answer.answer.facts ?? [],
      sources: input.answer.answer.sources ?? [],
    });
  } catch (error) {
    if (isKnowledgeSourceQualityFailure(error)) throw error;
    logger.warn('Home Graph Ask page enrichment bookkeeping failed', {
      spaceId: input.spaceId,
      installationId: input.installationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let refreshed = 0;
  for (const device of devices) {
    selectedDevices.assertCurrent();
    const deviceId = readHomeAssistantMetadataString(device, 'objectId', 'deviceId') ?? device.id;
    try {
      await recovery.run(() => refreshHomeGraphDevicePassport({
        store: input.store,
        artifactStore: input.artifactStore,
        spaceId: input.spaceId,
        installationId: input.installationId,
        signal,
        assertCurrent: recovery.assertCurrent,
        input: {
          knowledgeSpaceId: input.spaceId,
          deviceId,
          metadata: { automation: 'ask-refresh' },
        },
      }));
      selectedDevices.assertCurrent();
      refreshed += 1;
    } catch (error) {
      if (isKnowledgeSourceQualityFailure(error)) throw error;
      logger.warn('Home Graph Ask generated page refresh failed', {
        spaceId: input.spaceId,
        installationId: input.installationId,
        deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  selectedDevices.assertCurrent();
  return { requested: devices.length > 0, refreshed };
}

async function persistAnswerFactSubjectLinks(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly devices: readonly KnowledgeNodeRecord[];
  readonly assertSelectedDevicesCurrent: () => void;
  readonly sourceWritten: (source: KnowledgeSourceRecord) => void;
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
}): Promise<void> {
  if (input.devices.length === 0) return;
  input.assertSelectedDevicesCurrent();
  const reader = createHomeGraphPageSourceReader();
  const guard = createSemanticWriteGuard(input.store);
  for (const device of input.devices) guard.node(device.id);
  const facts = input.facts.filter((fact) => getKnowledgeSpaceId(fact) === input.spaceId);
  for (const fact of facts) guard.node(fact.id);
  const restoredSources = new Set<KnowledgeSourceRecord>();
  const restoredAliases = new Set<KnowledgeSourceRecord>();
  const candidates = input.sources.filter((source) => getKnowledgeSpaceId(source) === input.spaceId)
    .filter((source) => {
      const existing = guard.source(source.id);
      return !existing || getKnowledgeSpaceId(existing) === input.spaceId;
    }).slice(0, MAX_ASK_PAGE_SOURCES_TO_CONSIDER).map((responseSource) => {
    const source = restoreKnowledgeSourceAnswerAliases(input.store, responseSource);
    if (source !== responseSource) {
      restoredSources.add(source);
      restoredAliases.add(responseSource);
    }
    const existing = input.store.getSource(source.id) ?? undefined;
    return { source, existing, status: mergeSourceStatus(source.status, existing?.status) };
  });
  const readings = await reader.readCandidates(candidates);
  const pageSources = readings.filter((reading) => reading.useful)
    .sort((a, b) => b.probability! - a.probability! || a.source.id.localeCompare(b.source.id))
    .slice(0, MAX_ASK_PAGE_SOURCES_TO_LINK);
  const acceptedSourceIds = new Set(pageSources.map((reading) => reading.source.id));
  const factReader = createHomeGraphPageFactReader(input.store, {
    spaceId: input.spaceId, query: 'Useful device reference facts selected by a Home Graph answer', subjects: input.devices,
  });
  const selectedFacts = facts.filter((fact) => Boolean(fact.sourceId && acceptedSourceIds.has(fact.sourceId)));
  const responsesById = new Map(selectedFacts.map((fact) => [fact.id, fact]));
  const canonicalFacts = selectedFacts.map((fact) => {
    const current = input.store.getNode(fact.id);
    // Answer-only subject projections may add top-level associations. Bind the
    // complete persisted claim before using those associations for graph links.
    const claimMetadata = (metadata: Record<string, unknown>) => Object.fromEntries(Object.entries(metadata)
      .filter(([key]) => !['subject', 'subjectIds', 'linkedObjectIds', 'targetHints'].includes(key)));
    if (!current || Object.keys(current).some((key) => JSON.stringify(key === 'metadata' ? claimMetadata(current.metadata) : current[key as keyof KnowledgeNodeRecord])
      !== JSON.stringify(key === 'metadata' ? claimMetadata(fact.metadata) : fact[key as keyof KnowledgeNodeRecord]))) throw new KnowledgeGeneratedFactSupportHeldError('stale');
    return current;
  });
  const factPlan = await factReader.prepare(canonicalFacts);
  const factSourceIds = new Set(canonicalFacts.flatMap((fact) => [fact.sourceId, ...readStringArray(fact.metadata.sourceIds),
    ...input.store.edgesFor('node', fact.id).filter((edge) => edge.fromKind === 'source' && edge.toKind === 'node'
      && edge.toId === fact.id && edge.relation === 'supports_fact').map((edge) => edge.fromId),
  ]).filter(Boolean));
  const assertRestoredAliasesCurrent = () => {
    input.assertSelectedDevicesCurrent();
    factPlan.assertCurrent();
    for (const alias of restoredAliases) restoreKnowledgeSourceAnswerAliases(input.store, alias);
  };
  // The store methods await initialization/activation before committing. Keep
  // ownership in the prepared graph's final synchronous write guard as well.
  const writeGraph = (nodes: readonly KnowledgeNodeUpsertInput[], edges: readonly KnowledgeEdgeUpsertInput[]) =>
    input.store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
      nodes, edges, issues: [], assertCurrent: assertRestoredAliasesCurrent,
    }));
  const writeEdge = async (edge: KnowledgeEdgeUpsertInput) => {
    const receipt = await writeGraph([], [edge]);
    if (edge.relation === 'supports_fact' || edge.relation === 'describes') {
      const written = receipt.edges.find((candidate) => candidate.fromKind === edge.fromKind && candidate.fromId === edge.fromId && candidate.toKind === edge.toKind
        && candidate.toId === edge.toId && candidate.relation === edge.relation);
      if (!written || !input.store.edgesFor(edge.fromKind, edge.fromId).includes(written)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
      factPlan.acknowledgeEdgeWritten(written);
    }
  };
  await input.store.batch(async () => {
    // No source/link mutation follows a stale model await.
    guard.assertCurrent();
    // A ledger commit can rebuild byte-identical records during quality reads.
    // Recheck every object-bound alias before any write; batch flushes even on a hold.
    assertRestoredAliasesCurrent();
    const devicesById = new Map(input.devices.map((device) => [device.id, device]));
    for (const reading of pageSources) {
      // Keep evidence rows selected by fact quality byte-for-byte intact. Other
      // response sources retain the existing metadata/URI enrichment behavior.
      const storedSource = factSourceIds.has(reading.source.id)
        ? input.store.getSource(reading.source.id)!
        : await upsertAnswerPageSource(input, reading.source, restoredSources.has(reading.source), assertRestoredAliasesCurrent);
      input.sourceWritten(storedSource);
      assertRestoredAliasesCurrent();
      for (const device of input.devices) {
        await writeEdge({
          fromKind: 'source',
          fromId: storedSource.id,
          toKind: 'node',
          toId: device.id,
          relation: 'source_for',
          weight: reading.probability!,
          metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
            linkedBy: 'homegraph-ask-page-refresh',
          }),
        });
        assertRestoredAliasesCurrent();
      }
    }
    for (const fact of factPlan.facts) {
      if (!factPlan.accepts(fact) || !fact.sourceId || !acceptedSourceIds.has(fact.sourceId)) continue;
      const source = input.store.getSource(fact.sourceId);
      if (!source || source.status === 'stale' || isGeneratedPageSource(source)) continue;
      const targets = answerFactTargetDevices(responsesById.get(fact.id) ?? fact, devicesById);
      if (targets.length === 0) continue;
      // Exact accepted facts already identify their target devices. Preserve the
      // selected row and add graph relationships without rewriting its claim.
      const updatedFact = fact;
      await writeEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: updatedFact.id,
        relation: 'supports_fact',
        weight: ASK_FACT_SOURCE_WEIGHT,
        metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
          linkedBy: 'homegraph-ask-page-refresh',
        }),
      });
      assertRestoredAliasesCurrent();
      for (const device of targets) {
        await writeEdge({
          fromKind: 'node',
          fromId: updatedFact.id,
          toKind: 'node',
          toId: device.id,
          relation: 'describes',
          weight: ASK_FACT_DESCRIBES_WEIGHT,
          metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
            linkedBy: 'homegraph-ask-page-refresh',
            sourceId: source.id,
          }),
        });
        assertRestoredAliasesCurrent();
      }
    }
  });
  // Batch may publish earlier valid writes; a late loss of ownership still
  // cannot return a successful stale result or authorize passport refresh.
  assertRestoredAliasesCurrent();
}

async function upsertAnswerPageSource(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly installationId: string;
}, source: KnowledgeSourceRecord, preserveOwnedSource = false, assertCurrent: () => void): Promise<KnowledgeSourceRecord> {
  const existing = input.store.getSource(source.id);
  // A restored answer projection already names this exact current record. Do not
  // rewrite its minted URI as an external sourceUri or invalidate its provenance.
  if (preserveOwnedSource) {
    if (source !== existing) throw new KnowledgeGeneratedFactSupportHeldError('stale');
    return source;
  }
  const sourceInput = {
    id: source.id,
    connectorId: source.connectorId,
    sourceType: source.sourceType,
    title: source.title ?? existing?.title,
    sourceUri: source.sourceUri ?? source.url ?? existing?.sourceUri ?? existing?.url,
    canonicalUri: source.canonicalUri ?? existing?.canonicalUri,
    summary: source.summary ?? existing?.summary,
    description: source.description ?? existing?.description,
    tags: source.tags.length > 0 ? source.tags : existing?.tags,
    folderPath: source.folderPath ?? existing?.folderPath,
    status: mergeSourceStatus(source.status, existing?.status),
    artifactId: source.artifactId ?? existing?.artifactId,
    contentHash: source.contentHash ?? existing?.contentHash,
    lastCrawledAt: source.lastCrawledAt ?? existing?.lastCrawledAt,
    crawlError: source.crawlError ?? existing?.crawlError,
    sessionId: source.sessionId ?? existing?.sessionId,
    metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
      ...(existing?.metadata ?? {}),
      ...source.metadata,
    }),
  };
  const receipt = await input.store.applyPreparedIngest({ sources: [sourceInput], extractions: [], nodes: [], edges: [], issues: [] },
    async () => ({ nodes: [], edges: [], issues: [], assertCurrent }));
  const written = receipt.sources[0];
  if (!written || input.store.getSource(written.id) !== written) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  return written;
}

function answerFactTargetDevices(
  fact: KnowledgeNodeRecord,
  devicesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): readonly KnowledgeNodeRecord[] {
  const ids = uniqueStrings([
    ...readStringArray(fact.linkedObjectIds),
    ...readStringArray(fact.subjectIds),
    ...readStringArray(fact.metadata.linkedObjectIds),
    ...readStringArray(fact.metadata.subjectIds),
  ]);
  const explicit = ids.map((id) => devicesById.get(id)).filter((device): device is KnowledgeNodeRecord => Boolean(device));
  return explicit;
}
