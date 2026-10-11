import type { KnowledgeIngestOwnership } from './ingest-context.js';
import { randomUUID } from 'node:crypto';
import { snapshotNodeInput } from './activation/projection.js';
import { knowledgeRecordVersion } from './store-record-representation.js';
import {
  type AutomationScheduleDefinition,
} from '../automation/schedules.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { ArtifactStore } from '../artifacts/index.js';
import type { MemoryRegistry } from '../state/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { createDefaultKnowledgeConnectorRegistry, KnowledgeConnectorRegistry } from './connectors.js';
import { renderKnowledgeMap, type KnowledgeMapRenderOptions } from './map.js';
import { normalizeKnowledgeMapFilters } from './map-filters.js';
import { KnowledgeProjectionService } from './projections.js';
import { KnowledgeSemanticService } from './semantic/index.js';
import { KnowledgeStore } from './store.js';
import {
  reviewKnowledgeNodeRecord,
  queryKnowledgeIssues,
  queryKnowledgeNodes,
  type KnowledgeIssueQueryInput,
  type KnowledgeNodeQueryInput,
  type KnowledgeNodeReviewDecisionInput,
} from './service-node-admin.js';
import { ingestBrowserKnowledge } from './browser-history/index.js';
import type { BrowserKnowledgeIngestOptions, BrowserKnowledgeIngestResult } from './browser-history/index.js';
import type {
  KnowledgeBatchIngestResult,
  KnowledgeBookmarkSeed,
  KnowledgeConnector,
  KnowledgeConnectorDoctorReport,
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationReportRecord,
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeJobMode,
  KnowledgeJobRecord,
  KnowledgeJobRunRecord,
  KnowledgeMaterializedProjection,
  KnowledgeItemView,
  KnowledgeMapResult,
  KnowledgeNodeRecord,
  KnowledgeNodeRevisionRecord,
  KnowledgePacket,
  KnowledgeProjectionBundle,
  KnowledgeProjectionTarget,
  KnowledgeProjectionTargetKind,
  KnowledgeRefinementTaskRecord,
  KnowledgeRefinementTaskState,
  KnowledgeScheduleRecord,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
  KnowledgeStatus,
  KnowledgeUsageRecord,
} from './types.js';
import {
  buildKnowledgePacket,
  buildKnowledgePromptPacket,
  prepareKnowledgePromptPacket,
  type PreparedKnowledgePromptPacket,
  searchKnowledge,
} from './packet.js';
import {
  ingestKnowledgeArtifact,
  ingestKnowledgeBookmarkSeeds,
  ingestKnowledgeConnectorInput,
  ingestKnowledgeUrl,
  ingestKnowledgeWithConnector,
  importKnowledgeBookmarksFromFile,
  importKnowledgeUrlsFromFile,
  refreshKnowledgeSources,
  pickKnowledgeRefreshCandidates,
  recompileKnowledgeSource,
} from './ingest.js';
import {
  decideKnowledgeConsolidationCandidate,
  runKnowledgeConsolidation,
} from './consolidation.js';
import {
  reviewKnowledgeIssue,
  type KnowledgeIssueReviewInput,
  type KnowledgeIssueReviewResult,
} from './review.js';
import { KnowledgeScheduleService } from './scheduling.js';
import { runKnowledgeServiceJobByKind } from './service-jobs.js';
import { lintKnowledgeStore } from './lint.js';
import { syncKnowledgeMemoryNodes } from './memory-sync.js';
import {
  emitKnowledgeExtractionCompleted,
  emitKnowledgeExtractionFailed,
  emitKnowledgeIngestCompleted,
  emitKnowledgeIngestFailed,
  emitKnowledgeIngestStarted,
  emitKnowledgePacketBuilt,
  emitKnowledgeProjectionMaterialized,
  emitKnowledgeProjectionRendered,
} from '../runtime/emitters/index.js';
import { extractKnowledgeArtifact } from './extractors.js';
import {
  DEFAULT_PACKET_BUDGET,
  DEFAULT_PACKET_LIMIT,
  tokenize,
} from './shared.js';
import { isGeneratedKnowledgeSource } from './generated-projections.js';
import {
  prepareKnowledgeScopeSelection,
  KnowledgeScopeSelectionHeldError,
  type KnowledgeScopeSelection,
  type KnowledgeScopeSelectionOptions,
} from './scope-selection.js';
import {
  resolveKnowledgeSpaceScope,
  type KnowledgeSpaceScopeInput,
} from './spaces.js';

export interface KnowledgeServiceConfig {
  readonly configManager?: {
    getControlPlaneConfigDir?: (() => string) | undefined;
  };
  readonly memoryRegistry: Pick<MemoryRegistry, 'add' | 'getAll' | 'getStore'>;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  readonly semanticService?: KnowledgeSemanticService | undefined;
  /**
   * MemoryGovernor admission gate for the expensive entry points (job runs,
   * url/artifact ingestion). At the critical memory tier new expensive work is
   * refused with an honest structured error instead of piling on allocation.
   */
  readonly admitExpensiveWork?: ((label: string) => { allowed: boolean; reason?: string | undefined }) | undefined;
}

export interface KnowledgeServiceStatus extends KnowledgeStatus {
  readonly note: string;
}

export class KnowledgeService {
  private readonly projectionService: KnowledgeProjectionService;
  private readonly scheduleService: KnowledgeScheduleService;
  private readonly semanticService: KnowledgeSemanticService;
  private runtimeBus: RuntimeEventBus | null;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly artifactStore: ArtifactStore,
    private readonly connectorRegistry = createDefaultKnowledgeConnectorRegistry(),
    private readonly options: KnowledgeServiceConfig,
  ) {
    this.runtimeBus = options.runtimeBus ?? null;
    void this.store.init().catch((error: unknown) => {
      logger.error('[knowledge] store initialization failed', { error: summarizeError(error) });
    });
    this.projectionService = new KnowledgeProjectionService(this.store, this.artifactStore, {
      connectors: () => this.listConnectors(),
    });
    this.semanticService = options.semanticService ?? new KnowledgeSemanticService(this.store);
    this.scheduleService = new KnowledgeScheduleService({
      store: this.store,
      emitIfReady: this.emitIfReady.bind(this),
      runJobByKind: this.runJobByKind.bind(this),
    });
  }

  private getIngestContext() {
    return {
      store: this.store,
      artifactStore: this.artifactStore,
      connectorRegistry: this.connectorRegistry,
      emitIfReady: this.emitIfReady.bind(this),
      syncReviewedMemory: this.syncReviewedMemory.bind(this),
      semanticEnrichSource: async (sourceId: string, knowledgeSpaceId?: string) => {
        await this.semanticService.enrichSource(sourceId, { knowledgeSpaceId });
        // Self-improvement rides the governed background scheduler (floor,
        // coalescing, zero-gap backoff, governor pause), a per-ingest direct
        // run would bypass every one of those guards.
        this.semanticService.queueBackgroundSelfImprove({
          knowledgeSpaceId,
          sourceIds: [sourceId],
          reason: 'ingest',
          limit: 8,
        });
      },
      lint: this.lint.bind(this),
      listConnectors: () => this.listConnectors(),
    };
  }

  private getPacketContext() {
    return {
      store: this.store,
      deferUsage: this.deferUsage.bind(this),
      emitIfReady: this.emitIfReady.bind(this),
    };
  }

  private getConsolidationContext() {
    return {
      store: this.store,
      memoryRegistry: this.options.memoryRegistry,
      syncReviewedMemory: this.syncReviewedMemory.bind(this),
    };
  }

  /** Await this owner's finite startup writes; failures remain observable. */
  whenReady(): Promise<void> { return this.scheduleService.whenReady(); }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null | undefined): void {
    if (runtimeBus) this.runtimeBus = runtimeBus;
  }

  async getStatus(scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeServiceStatus> {
    const selection = await prepareKnowledgeScopeSelection(this.store, scope, options);
    const allStatus = this.store.status();
    const spaceId = resolveKnowledgeSpaceScope(scope);
    const extractionCount = this.selectedExtractions(selection, Number.MAX_SAFE_INTEGER).length;
    const refinementTaskCount = spaceId === null ? allStatus.refinementTaskCount
      : this.store.listRefinementTasks(Number.MAX_SAFE_INTEGER, { spaceId }).length;
    const edgeCount = selection.edges.filter((edge) => this.edgeInKnowledgeSpaceScope(edge, selection)).length;
    const assertEdges = selection.retainEdges(selection.edges);
    const nodeCount = queryKnowledgeNodes(selection, { limit: Number.MAX_SAFE_INTEGER }).total;
    selection.assertCurrent();
    assertEdges();
    return {
      ...allStatus,
      sourceCount: selection.sources.length,
      nodeCount,
      edgeCount,
      issueCount: selection.issues.length,
      extractionCount,
      refinementTaskCount,
      note: 'Structured knowledge uses SQL-backed sources, nodes, edges, issues, extractions, and job runs. Markdown is an optional projection, not the source of truth.',
    };
  }

  listUsageRecords(
    limit = 100,
    input: {
      readonly targetKind?: KnowledgeUsageRecord['targetKind'] | undefined;
      readonly targetId?: string | undefined;
      readonly usageKind?: KnowledgeUsageRecord['usageKind'] | undefined;
    } = {},
  ): readonly KnowledgeUsageRecord[] {
    return this.store.listUsageRecords(limit, input);
  }

  listConsolidationCandidates(
    limit = 100,
    input: {
      readonly status?: KnowledgeConsolidationCandidateRecord['status'] | undefined;
      readonly subjectKind?: KnowledgeConsolidationCandidateRecord['subjectKind'] | undefined;
      readonly subjectId?: string | undefined;
    } = {},
  ): readonly KnowledgeConsolidationCandidateRecord[] {
    return this.store.listConsolidationCandidates(limit, input);
  }

  getConsolidationCandidate(id: string): KnowledgeConsolidationCandidateRecord | null {
    return this.store.getConsolidationCandidate(id);
  }

  listConsolidationReports(limit = 100): readonly KnowledgeConsolidationReportRecord[] {
    return this.store.listConsolidationReports(limit);
  }

  getConsolidationReport(id: string): KnowledgeConsolidationReportRecord | null {
    return this.store.getConsolidationReport(id);
  }

  listSchedules(limit = 100): readonly KnowledgeScheduleRecord[] {
    return this.store.listSchedules(limit);
  }

  getSchedule(id: string): KnowledgeScheduleRecord | null {
    return this.store.getSchedule(id);
  }

  async listSources(limit = 100, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeSourceRecord[]> {
    return (await this.querySources({ limit }, options)).items;
  }

  async querySources(input: {
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
    readonly knowledgeSpaceId?: string | undefined;
    readonly includeAllSpaces?: boolean | undefined;
    readonly status?: string | undefined;
    readonly connectorId?: string | undefined;
    readonly sourceType?: string | undefined;
    readonly tag?: string | undefined;
    readonly query?: string | undefined;
  } = {}, options: KnowledgeScopeSelectionOptions = {}): Promise<{ total: number; items: KnowledgeSourceRecord[] }> {
    const request = snapshotNodeInput(input);
    const selection = await prepareKnowledgeScopeSelection(this.store, input, options);
    const limit = Math.max(1, request.limit ?? 100);
    const offset = Math.max(0, request.offset ?? 0);
    const queryTokens = tokenize(request.query ?? '');
    const items = selection.sources.filter((source) => {
      if (!selection.source(source)) return false;
      if (request.status && source.status !== request.status) return false;
      if (request.connectorId && source.connectorId !== request.connectorId) return false;
      if (request.sourceType && source.sourceType !== request.sourceType) return false;
      if (request.tag && !source.tags.includes(request.tag)) return false;
      if (queryTokens.length === 0) return true;
      const extraction = this.store.getExtractionBySourceId(source.id);
      const haystack = [
        source.title ?? '',
        source.summary ?? '',
        source.description ?? '',
        source.sourceUri ?? '',
        source.canonicalUri ?? '',
        source.folderPath ?? '',
        source.tags.join(' '),
        extraction?.summary ?? '',
        extraction?.excerpt ?? '',
        extraction?.sections.join(' ') ?? '',
      ].join(' ').toLowerCase();
      return queryTokens.every((token) => haystack.includes(token));
    });
    selection.assertCurrent();
    return {
      total: items.length,
      items: items.slice(offset, offset + limit),
    };
  }

  async listNodes(limit = 100, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeNodeRecord[]> {
    return (await this.queryNodes({ limit }, options)).items;
  }

  /** The append-only revision history of a node, oldest first. (Defect 1.) */
  listNodeRevisions(nodeId: string): KnowledgeNodeRevisionRecord[] {
    return this.store.listNodeRevisions(nodeId);
  }

  /** Honest hard delete of a single node, removes the row and its history. (Defect 6.) */
  async deleteNode(id: string): Promise<{ deleted: boolean }> {
    return { deleted: await this.store.deleteNode(id) };
  }

  /** Honest hard delete of a single source and its derived records. (Defect 6.) */
  async deleteSource(id: string): Promise<{ deleted: boolean }> {
    return { deleted: await this.store.deleteSource(id) };
  }

  /** Merge one node into another, re-pointing cross-reference edges. (Defect 5.) */
  async mergeNodes(loserId: string, winnerId: string): Promise<{ merged: boolean; repointedEdges: number }> {
    return this.store.mergeNodes(loserId, winnerId);
  }

  /** Accept/reject a pending node, the decide step that governs activation. (Defect 2.) */
  async reviewNode(input: KnowledgeNodeReviewDecisionInput): Promise<{ ok: boolean; node?: KnowledgeNodeRecord | undefined }> {
    return reviewKnowledgeNodeRecord(this.store, input);
  }

  async queryNodes(input: KnowledgeNodeQueryInput = {}, options: KnowledgeScopeSelectionOptions = {}): Promise<{ total: number; items: KnowledgeNodeRecord[] }> {
    const request = snapshotNodeInput(input);
    const selection = await prepareKnowledgeScopeSelection(this.store, input, options);
    return queryKnowledgeNodes(selection, request);
  }

  async listIssues(limit = 100, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeIssueRecord[]> {
    return (await this.queryIssues({ limit }, options)).items;
  }

  async queryIssues(input: KnowledgeIssueQueryInput = {}, options: KnowledgeScopeSelectionOptions = {}): Promise<{ total: number; items: KnowledgeIssueRecord[] }> {
    const request = snapshotNodeInput(input);
    const selection = await prepareKnowledgeScopeSelection(this.store, input, options);
    return queryKnowledgeIssues(selection, request);
  }

  async reviewIssue(input: KnowledgeIssueReviewInput): Promise<KnowledgeIssueReviewResult> {
    return reviewKnowledgeIssue(this.store, input);
  }

  async listExtractions(limit = 100, sourceId?: string, scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeExtractionRecord[]> {
    const selection = await prepareKnowledgeScopeSelection(this.store, scope, options);
    return this.selectedExtractions(selection, limit, sourceId);
  }

  private selectedExtractions(selection: KnowledgeScopeSelection, limit: number, sourceId?: string): KnowledgeExtractionRecord[] {
    const records = this.store.listExtractions(Number.MAX_SAFE_INTEGER)
      .filter((entry) => !sourceId || entry.sourceId === sourceId)
      .filter((entry) => {
        const source = this.store.getSource(entry.sourceId);
        return Boolean(source && selection.source(source));
      })
      .slice(0, Math.max(1, limit));
    selection.assertCurrent();
    return records;
  }

  getExtraction(id: string): KnowledgeExtractionRecord | null {
    return this.store.getExtraction(id);
  }

  getSourceExtraction(sourceId: string): KnowledgeExtractionRecord | null {
    return this.store.getExtractionBySourceId(sourceId);
  }

  listConnectors(): readonly KnowledgeConnector[] {
    return this.connectorRegistry.list();
  }

  getConnector(id: string): KnowledgeConnector | null {
    return this.connectorRegistry.get(id) ?? null;
  }

  async doctorConnector(id: string): Promise<KnowledgeConnectorDoctorReport | null> {
    return this.connectorRegistry.doctor(id);
  }

  registerConnector(connector: KnowledgeConnector, options: { replace?: boolean } = {}): void {
    this.connectorRegistry.register(connector, options);
  }

  getItem(id: string): KnowledgeItemView | null {
    const item = this.store.getItem(id);
    if (item?.source) this.deferUsage({ targetKind: 'source', targetId: item.source.id, usageKind: 'item-open' });
    if (item?.node) this.deferUsage({ targetKind: 'node', targetId: item.node.id, usageKind: 'item-open' });
    if (item?.issue) this.deferUsage({ targetKind: 'issue', targetId: item.issue.id, usageKind: 'item-open' });
    return item;
  }

  async getItemScoped(id: string, scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeItemView | null> {
    const selection = await prepareKnowledgeScopeSelection(this.store, scope, options);
    return this.getSelectedItem(id, selection);
  }

  private getSelectedItem(id: string, selection: KnowledgeScopeSelection, recordUsage = true): KnowledgeItemView | null {
    const item = this.store.getItem(id);
    const primary = item?.source ?? item?.node ?? item?.issue;
    if (!item || !primary || !this.recordMatchesKnowledgeSpaceScope(primary, selection)) {
      selection.assertCurrent();
      return null;
    }
    const primaryKind = item.source ? 'source' : item.node ? 'node' : undefined;
    const incidentEdges = primaryKind ? selection.edges.filter((edge) => (edge.fromKind === primaryKind && edge.fromId === primary.id)
      || (edge.toKind === primaryKind && edge.toId === primary.id)) : [];
    const assertEdges = selection.retainEdges(incidentEdges, {
      incidentTo: item.source ? [{ kind: 'source', id: item.source.id }] : item.node ? [{ kind: 'node', id: item.node.id }] : [],
    });
    const assertCurrent = () => { selection.assertCurrent(); assertEdges(); };
    const scoped: KnowledgeItemView = {
      ...item,
      linkedSources: item.linkedSources.filter((source) => selection.source(source)),
      linkedNodes: item.linkedNodes.filter((node) => selection.node(node)),
      relatedEdges: selection.edges.filter((edge) => item.relatedEdges.some((related) => related.id === edge.id)
        && this.edgeInKnowledgeSpaceScope(edge, selection)),
    };
    assertCurrent();
    if (recordUsage) {
      if (scoped.source) this.deferUsage({ targetKind: 'source', targetId: scoped.source.id, usageKind: 'item-open' }, assertCurrent);
      if (scoped.node) this.deferUsage({ targetKind: 'node', targetId: scoped.node.id, usageKind: 'item-open' }, assertCurrent);
      if (scoped.issue) this.deferUsage({ targetKind: 'issue', targetId: scoped.issue.id, usageKind: 'item-open' }, assertCurrent);
    }
    assertCurrent();
    return scoped;
  }

  async getItems(ids: readonly string[], scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeItemView[]> {
    const request = snapshotNodeInput(ids);
    const version = knowledgeRecordVersion(request);
    const callerCurrent = options.assertCurrent;
    const signal = options.signal;
    const shouldStop = options.shouldStop;
    const preparedCurrent = options.assertPreparedInputCurrent;
    const bounds = () => knowledgeRecordVersion(snapshotNodeInput({ kinds: options.kinds, sourceIds: options.sourceIds, nodeIds: options.nodeIds, issueIds: options.issueIds }));
    const boundsVersion = bounds();
    const assertRequestCurrent = () => {
      if (knowledgeRecordVersion(snapshotNodeInput(ids)) !== version || options.assertCurrent !== callerCurrent
        || options.signal !== signal || options.shouldStop !== shouldStop
        || options.assertPreparedInputCurrent !== preparedCurrent || bounds() !== boundsVersion) throw new KnowledgeScopeSelectionHeldError('stale');
    };
    const selection = await prepareKnowledgeScopeSelection(this.store, scope, {
      ...options, signal, shouldStop, assertCurrent: () => {
        assertRequestCurrent();
        const current: unknown = callerCurrent?.();
        if (current !== undefined) {
          void Promise.resolve(current).catch(() => {});
          throw new KnowledgeScopeSelectionHeldError('stale');
        }
        assertRequestCurrent();
      },
    });
    const items = request.map((id) => this.getSelectedItem(id, selection, false)).filter((item): item is KnowledgeItemView => Boolean(item));
    const incidentTo: { kind: 'source' | 'node'; id: string }[] = [];
    for (const item of items) {
      if (item.source) incidentTo.push({ kind: 'source', id: item.source.id });
      else if (item.node) incidentTo.push({ kind: 'node', id: item.node.id });
    }
    const edges = selection.edges.filter(edge => incidentTo.some(item => (edge.fromKind === item.kind && edge.fromId === item.id)
      || (edge.toKind === item.kind && edge.toId === item.id)));
    const assertEdges = selection.retainEdges(edges, { incidentTo });
    const assertCurrent = () => { selection.assertCurrent(); assertEdges(); };
    assertCurrent();
    for (const item of items) {
      if (item.source) this.deferUsage({ targetKind: 'source', targetId: item.source.id, usageKind: 'item-open' }, assertCurrent);
      if (item.node) this.deferUsage({ targetKind: 'node', targetId: item.node.id, usageKind: 'item-open' }, assertCurrent);
      if (item.issue) this.deferUsage({ targetKind: 'issue', targetId: item.issue.id, usageKind: 'item-open' }, assertCurrent);
    }
    assertCurrent();
    return items;
  }

  private edgeInKnowledgeSpaceScope(edge: { readonly fromKind: string; readonly fromId: string; readonly toKind: string; readonly toId: string }, selection: KnowledgeScopeSelection): boolean {
    return this.recordReferenceInKnowledgeSpaceScope(edge.fromKind, edge.fromId, selection)
      && this.recordReferenceInKnowledgeSpaceScope(edge.toKind, edge.toId, selection);
  }

  private recordReferenceInKnowledgeSpaceScope(kind: string, id: string, selection: KnowledgeScopeSelection): boolean {
    if (kind === 'source') {
      const source = this.store.getSource(id);
      return Boolean(source && selection.source(source));
    }
    if (kind === 'node') {
      const node = this.store.getNode(id);
      return Boolean(node && selection.node(node));
    }
    if (kind === 'issue') {
      const issue = this.store.getIssue(id);
      return Boolean(issue && selection.issue(issue));
    }
    return true;
  }

  private recordMatchesKnowledgeSpaceScope(
    record: KnowledgeSourceRecord | KnowledgeNodeRecord | KnowledgeIssueRecord,
    selection: KnowledgeScopeSelection,
  ): boolean {
    if ('sourceType' in record) return selection.source(record);
    if ('kind' in record) return selection.node(record);
    return selection.issue(record);
  }

  async recordUsage(input: {
    readonly targetKind: KnowledgeUsageRecord['targetKind'];
    readonly targetId: string;
    readonly usageKind: KnowledgeUsageRecord['usageKind'];
    readonly task?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly score?: number | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }, assertCurrent?: () => void): Promise<KnowledgeUsageRecord> {
    await this.store.init();
    assertCurrent?.();
    return this.store.upsertUsageRecord(input, assertCurrent);
  }

  async getNeighbors(
    kind: 'source' | 'node',
    id: string,
    input: KnowledgeSpaceScopeInput & { readonly relation?: string | undefined; readonly limit?: number | undefined } = {},
    options: KnowledgeScopeSelectionOptions = {},
  ): Promise<{
    readonly edges: readonly KnowledgeEdgeRecord[];
    readonly sources: readonly KnowledgeSourceRecord[];
    readonly nodes: readonly KnowledgeNodeRecord[];
  }> {
    const request = snapshotNodeInput(input);
    const selection = await prepareKnowledgeScopeSelection(this.store, input, options);
    const primary = kind === 'source' ? this.store.getSource(id) : this.store.getNode(id);
    if (!primary || !this.recordMatchesKnowledgeSpaceScope(primary, selection)) {
      selection.assertCurrent();
      return { edges: [], sources: [], nodes: [] };
    }
    const limit = Math.max(1, request.limit ?? 20);
    const incidentEdges = selection.edges
      .filter((edge) => (edge.fromKind === kind && edge.fromId === id) || (edge.toKind === kind && edge.toId === id));
    const assertEdges = selection.retainEdges(incidentEdges, { incidentTo: [{ kind, id }] });
    const assertCurrent = () => { selection.assertCurrent(); assertEdges(); };
    const edges = incidentEdges
      .filter((edge) => this.edgeInKnowledgeSpaceScope(edge, selection))
      .filter((edge) => !request.relation || edge.relation === request.relation)
      .slice(0, limit);
    assertCurrent();
    this.deferUsage({
      targetKind: kind,
      targetId: id,
      usageKind: 'neighbor-open',
      metadata: request.relation ? { relation: request.relation } : {},
    }, assertCurrent);
    const sources: KnowledgeSourceRecord[] = [];
    const nodes: KnowledgeNodeRecord[] = [];
    for (const edge of edges) {
      const otherKind = edge.fromKind === kind && edge.fromId === id ? edge.toKind : edge.fromKind;
      const otherId = edge.fromKind === kind && edge.fromId === id ? edge.toId : edge.fromId;
      if (otherKind === 'source') {
        const source = this.store.getSource(otherId);
        if (source && selection.source(source)) sources.push(source);
      } else if (otherKind === 'node') {
        const node = this.store.getNode(otherId);
        if (node && selection.node(node)) nodes.push(node);
      }
    }
    assertCurrent();
    return { edges, sources, nodes };
  }

  async ingestUrl(input: {
    readonly url: string;
    readonly title?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly folderPath?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly sourceType?: KnowledgeSourceType | undefined;
    readonly connectorId?: string | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }, ownership: KnowledgeIngestOwnership = {}): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
    this.requireAdmission('knowledge url ingestion');
    return ingestKnowledgeUrl(this.getIngestContext(), input, ownership);
  }

  /**
   * Consult the MemoryGovernor before expensive work: at the critical tier the
   * governor refuses with an honest reason, which surfaces as a structured
   * error instead of the daemon allocating toward OOM.
   */
  private requireAdmission(label: string): void {
    const decision = this.options.admitExpensiveWork?.(label);
    if (decision && !decision.allowed) {
      throw new Error(decision.reason ?? `${label} refused: daemon is under critical memory pressure.`);
    }
  }

  async ingestArtifact(input: {
    readonly artifactId?: string | undefined;
    readonly path?: string | undefined;
    readonly uri?: string | undefined;
    readonly title?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly folderPath?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly sourceType?: KnowledgeSourceType | undefined;
    readonly connectorId?: string | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }, ownership: KnowledgeIngestOwnership = {}): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
    this.requireAdmission('knowledge artifact ingestion');
    return ingestKnowledgeArtifact(this.getIngestContext(), input, ownership);
  }

  async importBookmarksFromFile(input: {
    readonly path: string;
    readonly sessionId?: string | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
  }): Promise<KnowledgeBatchIngestResult> {
    return importKnowledgeBookmarksFromFile(this.getIngestContext(), input);
  }

  async importUrlsFromFile(input: {
    readonly path: string;
    readonly sessionId?: string | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
  }): Promise<KnowledgeBatchIngestResult> {
    return importKnowledgeUrlsFromFile(this.getIngestContext(), input);
  }

  async ingestBookmarkSeeds(
    seeds: readonly KnowledgeBookmarkSeed[],
    sessionId?: string,
    sourceType: KnowledgeSourceType = 'bookmark',
    connectorId = 'bookmark',
    allowPrivateHosts?: boolean,
  ): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeBookmarkSeeds(this.getIngestContext(), seeds, sessionId, sourceType, connectorId, allowPrivateHosts);
  }

  async ingestWithConnector(
    connectorId: string,
    input: unknown,
    sessionId?: string,
    allowPrivateHosts?: boolean,
  ): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeWithConnector(this.getIngestContext(), connectorId, input, sessionId, allowPrivateHosts);
  }

  async ingestConnectorInput(input: {
    readonly connectorId: string;
    readonly input?: unknown | undefined;
    readonly content?: string | undefined;
    readonly path?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
  }): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeConnectorInput(this.getIngestContext(), input);
  }

  async syncBrowserHistory(
    input: BrowserKnowledgeIngestOptions = {},
  ): Promise<BrowserKnowledgeIngestResult> {
    return ingestBrowserKnowledge(this.getIngestContext(), input);
  }

  async listProjectionTargets(limit = 25, scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeProjectionTarget[]> {
    return this.projectionService.listTargets(limit, scope, options);
  }

  async renderProjection(input: {
    readonly kind: KnowledgeProjectionTargetKind;
    readonly id?: string | undefined;
    readonly limit?: number | undefined;
    readonly knowledgeSpaceId?: string | undefined;
    readonly includeAllSpaces?: boolean | undefined;
  }, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeProjectionBundle> {
    const bundle = await this.projectionService.render(input, options);
    options.assertCurrent?.();
    this.emitIfReady((bus, ctx) => emitKnowledgeProjectionRendered(bus, ctx, {
      targetId: bundle.target.targetId,
      pageCount: bundle.pageCount,
    }));
    return bundle;
  }

  async materializeProjection(input: {
    readonly kind: KnowledgeProjectionTargetKind;
    readonly id?: string | undefined;
    readonly limit?: number | undefined;
    readonly filename?: string | undefined;
    readonly knowledgeSpaceId?: string | undefined;
    readonly includeAllSpaces?: boolean | undefined;
  }, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeMaterializedProjection> {
    const materialized = await this.projectionService.materialize(input, options);
    options.assertCurrent?.();
    this.emitIfReady((bus, ctx) => emitKnowledgeProjectionMaterialized(bus, ctx, {
      targetId: materialized.bundle.target.targetId,
      artifactId: materialized.artifact.id,
      pageCount: materialized.bundle.pageCount,
    }));
    return materialized;
  }

  async map(input: KnowledgeMapRenderOptions = {}, options: KnowledgeScopeSelectionOptions = {}): Promise<KnowledgeMapResult> {
    const request = snapshotNodeInput(input);
    const version = knowledgeRecordVersion(request);
    const filters = normalizeKnowledgeMapFilters(request);
    const callerCurrent = options.assertCurrent;
    const signal = options.signal;
    const shouldStop = options.shouldStop;
    const preparedCurrent = options.assertPreparedInputCurrent;
    const bounds = () => knowledgeRecordVersion(snapshotNodeInput({ kinds: options.kinds, sourceIds: options.sourceIds, nodeIds: options.nodeIds, issueIds: options.issueIds }));
    const boundsVersion = bounds();
    const assertRequestCurrent = () => {
      if (knowledgeRecordVersion(snapshotNodeInput(input)) !== version || options.assertCurrent !== callerCurrent
        || options.signal !== signal || options.shouldStop !== shouldStop
        || options.assertPreparedInputCurrent !== preparedCurrent || bounds() !== boundsVersion) throw new KnowledgeScopeSelectionHeldError('stale');
    };
    const selection = await prepareKnowledgeScopeSelection(this.store, {
      knowledgeSpaceId: filters.knowledgeSpaceId,
      includeAllSpaces: filters.includeAllSpaces,
    }, { ...options, signal, shouldStop, assertCurrent: () => {
      assertRequestCurrent();
      const current: unknown = callerCurrent?.();
      if (current !== undefined) {
        void Promise.resolve(current).catch(() => {});
        throw new KnowledgeScopeSelectionHeldError('stale');
      }
      assertRequestCurrent();
    } });
    return renderKnowledgeMap({
      title: 'Knowledge Map',
      sources: selection.sources,
      nodes: selection.nodes,
      edges: selection.edges,
      issues: selection.issues,
    }, selection, request);
  }

  async reindex(): Promise<{ status: KnowledgeStatus; issues: readonly KnowledgeIssueRecord[] }> {
    await this.store.init();
    for (const source of this.store.listSources(Number.MAX_SAFE_INTEGER)) {
      if (isGeneratedKnowledgeSource(source)) continue;
      await recompileKnowledgeSource(this.getIngestContext(), source);
    }
    await this.semanticService.reindex({ force: false });
    await this.syncReviewedMemory();
    const issues = await lintKnowledgeStore({ store: this.store, emitIfReady: this.emitIfReady.bind(this) });
    return { status: this.store.status(), issues };
  }

  async search(query: string, limit = 10): Promise<KnowledgeSearchResult[]> {
    return searchKnowledge(this.getPacketContext(), query, limit);
  }

  async searchScoped(input: {
    readonly query: string;
    readonly limit?: number | undefined;
    readonly knowledgeSpaceId?: string | undefined;
    readonly includeAllSpaces?: boolean | undefined;
  }, scopeOptions: Parameters<typeof searchKnowledge>[4] = {}): Promise<KnowledgeSearchResult[]> {
    const request = snapshotNodeInput(input);
    return searchKnowledge(this.getPacketContext(), request.query, request.limit ?? 10, input, scopeOptions);
  }

  async ask(input: {
    readonly query: string;
    readonly limit?: number | undefined;
    readonly mode?: 'concise' | 'standard' | 'detailed' | undefined;
    readonly knowledgeSpaceId?: string | undefined;
    readonly includeSources?: boolean | undefined;
    readonly includeConfidence?: boolean | undefined;
    readonly includeLinkedObjects?: boolean | undefined;
  }) {
    return this.semanticService.answer(input);
  }

  async buildPacket(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: Parameters<typeof buildKnowledgePacket>[4] = {},
  ): Promise<KnowledgePacket> {
    return buildKnowledgePacket(this.getPacketContext(), task, writeScope, limit, options);
  }

  async preparePromptPacket(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: Parameters<typeof prepareKnowledgePromptPacket>[4] = {},
  ): Promise<PreparedKnowledgePromptPacket> {
    return prepareKnowledgePromptPacket(this.getPacketContext(), task, writeScope, limit, options);
  }

  async buildPromptPacket(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: Parameters<typeof buildKnowledgePromptPacket>[4] = {},
  ): Promise<string | null> {
    return buildKnowledgePromptPacket(this.getPacketContext(), task, writeScope, limit, options);
  }

  listJobs(): readonly KnowledgeJobRecord[] {
    return this.scheduleService.listJobs();
  }

  getJob(id: string): KnowledgeJobRecord | null {
    return this.scheduleService.getJob(id);
  }

  async saveSchedule(input: {
    readonly id?: string | undefined;
    readonly jobId: string;
    readonly label?: string | undefined;
    readonly enabled?: boolean | undefined;
    readonly schedule: AutomationScheduleDefinition;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<KnowledgeScheduleRecord> {
    return this.scheduleService.saveSchedule(input);
  }

  async deleteSchedule(id: string): Promise<boolean> {
    return this.scheduleService.deleteSchedule(id);
  }

  async setScheduleEnabled(id: string, enabled: boolean): Promise<KnowledgeScheduleRecord | null> {
    return this.scheduleService.setScheduleEnabled(id, enabled);
  }

  async decideConsolidationCandidate(
    id: string,
    decision: 'accept' | 'reject' | 'supersede',
    input: {
      readonly decidedBy?: string | undefined;
      readonly memoryClass?: string | undefined;
      readonly scope?: string | undefined;
      readonly detail?: string | undefined;
    } = {},
  ): Promise<KnowledgeConsolidationCandidateRecord> {
    return decideKnowledgeConsolidationCandidate(this.getConsolidationContext(), id, decision, input);
  }

  listJobRuns(limit = 100, jobId?: string): readonly KnowledgeJobRunRecord[] {
    return this.scheduleService.listJobRuns(limit, jobId);
  }

  listRefinementTasks(limit = 100, input: {
    readonly spaceId?: string | undefined;
    readonly state?: KnowledgeRefinementTaskState | string | undefined;
    readonly subjectKind?: string | undefined;
    readonly subjectId?: string | undefined;
    readonly gapId?: string | undefined;
  } = {}): readonly KnowledgeRefinementTaskRecord[] {
    return this.store.listRefinementTasks(limit, input);
  }

  getRefinementTask(id: string): KnowledgeRefinementTaskRecord | null {
    return this.store.getRefinementTask(id);
  }

  async cancelRefinementTask(id: string): Promise<KnowledgeRefinementTaskRecord | null> {
    const task = this.store.getRefinementTask(id);
    if (!task) return null;
    return this.store.upsertRefinementTask({
      id: task.id,
      spaceId: task.spaceId,
      subjectKind: task.subjectKind,
      subjectId: task.subjectId,
      subjectTitle: task.subjectTitle,
      subjectType: task.subjectType,
      gapId: task.gapId,
      issueId: task.issueId,
      state: 'cancelled',
      priority: task.priority,
      trigger: task.trigger,
      budget: task.budget,
      attemptCount: task.attemptCount,
      appendTrace: [{
        at: Date.now(),
        state: 'cancelled',
        message: 'Refinement task was cancelled by request.',
      }],
      metadata: task.metadata,
    });
  }

  async runRefinement(input: {
    readonly knowledgeSpaceId?: string | undefined;
    readonly gapIds?: readonly string[] | undefined;
    readonly sourceIds?: readonly string[] | undefined;
    readonly limit?: number | undefined;
    readonly maxRunMs?: number | undefined;
    readonly force?: boolean | undefined;
  } = {}) {
    return this.semanticService.selfImprove({
      knowledgeSpaceId: input.knowledgeSpaceId,
      gapIds: input.gapIds,
      sourceIds: input.sourceIds,
      limit: input.limit,
      maxRunMs: input.maxRunMs,
      force: input.force,
      reason: 'manual',
    });
  }

  async runJob(
    id: string,
    input: {
      readonly mode?: KnowledgeJobMode | undefined;
      readonly sourceIds?: readonly string[] | undefined;
      readonly limit?: number | undefined;
    } = {},
  ): Promise<KnowledgeJobRunRecord> {
    this.requireAdmission('knowledge job run');
    return this.scheduleService.runJob(id, input);
  }

  private async runJobByKind(
    kind: KnowledgeJobRecord['kind'],
    input: { readonly sourceIds?: readonly string[] | undefined; readonly limit?: number | undefined },
  ): Promise<Record<string, unknown>> {
    return runKnowledgeServiceJobByKind(kind, input, {
      lint: () => lintKnowledgeStore({ store: this.store, emitIfReady: this.emitIfReady.bind(this) }),
      reindex: () => this.reindex(),
      refreshSources: async (refreshKind, sourceIds, limit) =>
        refreshKnowledgeSources(
          this.getIngestContext(),
          pickKnowledgeRefreshCandidates({ store: this.store }, refreshKind, sourceIds, limit),
        ),
      syncBrowserHistory: (options) => this.syncBrowserHistory(options),
      materializeProjection: (options) => this.materializeProjection(options),
      semanticService: this.semanticService,
      runConsolidation: (jobKind, options) =>
        runKnowledgeConsolidation(this.getConsolidationContext(), jobKind, options),
    });
  }

  private deferUsage(input: {
    readonly targetKind: KnowledgeUsageRecord['targetKind'];
    readonly targetId: string;
    readonly usageKind: KnowledgeUsageRecord['usageKind'];
    readonly task?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly score?: number | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }, assertCurrent?: () => void): void {
    queueMicrotask(() => {
      void this.recordUsage(input, assertCurrent).catch((error: unknown) => {
        logger.warn('Knowledge usage recording failed', {
          targetKind: input.targetKind,
          targetId: input.targetId,
          usageKind: input.usageKind,
          error: summarizeError(error),
        });
      });
    });
  }

  private async syncReviewedMemory(): Promise<void> {
    await syncKnowledgeMemoryNodes(this.store, this.options.memoryRegistry);
  }

  /**
   * Release the knowledge scheduler's pending timers. Was `private` with no
   * caller, so every graph left six `reconcileSchedules` timers pending out to
   * a 24h horizon; runtime/services.ts registers it for teardown. Idempotent.
   */
  dispose(): void {
    this.scheduleService.dispose();
  }

  async lint(): Promise<readonly KnowledgeIssueRecord[]> {
    return lintKnowledgeStore({ store: this.store, emitIfReady: this.emitIfReady.bind(this) });
  }

  private emitIfReady(
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ): void {
    if (!this.runtimeBus) return;
    fn(this.runtimeBus, {
      traceId: randomUUID(),
      sessionId: sessionId ?? 'knowledge-runtime',
      source: 'knowledge.service',
    });
  }
}
