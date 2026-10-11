import type { KnowledgeService } from './service.js';
import type { KnowledgeScopeSelectionOptions } from './scope-selection.js';
import type { KnowledgeSpaceScopeInput } from './spaces.js';
import type { ArtifactFetchMode } from '../artifacts/types.js';
import {
  buildKnowledgeInjectionPrompt,
  selectKnowledgeForTask,
  type KnowledgeInjection,
} from '../state/knowledge-injection.js';
import type {
  MemoryAddOptions,
  MemoryBundle,
  MemoryDoctorReport,
  MemoryImportResult,
  MemoryLink,
  MemoryRecord,
  MemoryReviewPatch,
  MemoryScope,
  MemorySearchFilter,
  MemorySemanticSearchResult,
} from '../state/memory-store.js';
import type { MemoryVectorStats } from '../state/memory-vector-store.js';
import type { MemoryRegistry } from '../state/memory-registry.js';
import type { CodeChunkMode, CodeContextResult, CodeIndexBuildStats, CodeIndexStats, CodeIndexStore } from '../state/code-index-store.js';
export type { ArtifactFetchMode } from '../artifacts/types.js';
export type {
  KnowledgeInjection,
} from '../state/knowledge-injection.js';
export type {
  KnowledgeInjectionIngestMode,
  KnowledgeInjectionProvenance,
  KnowledgeInjectionRetention,
  KnowledgeInjectionTrustTier,
  KnowledgeInjectionUseAs,
} from './shared.js';

type UsageListInput = Parameters<KnowledgeService['listUsageRecords']>[1];
type SourceQueryInput = Parameters<KnowledgeService['querySources']>[0];
type NodeQueryInput = Parameters<KnowledgeService['queryNodes']>[0];
type IssueQueryInput = Parameters<KnowledgeService['queryIssues']>[0];
type IssueReviewInput = Parameters<KnowledgeService['reviewIssue']>[0];
type NodeReviewInput = Parameters<KnowledgeService['reviewNode']>[0];
type NeighborInput = Parameters<KnowledgeService['getNeighbors']>[2];
type RecordUsageInput = Parameters<KnowledgeService['recordUsage']>[0];
type IngestUrlInput = Parameters<KnowledgeService['ingestUrl']>[0];
type IngestArtifactInput = Parameters<KnowledgeService['ingestArtifact']>[0];
type ImportBookmarksInput = Parameters<KnowledgeService['importBookmarksFromFile']>[0];
type ImportUrlsInput = Parameters<KnowledgeService['importUrlsFromFile']>[0];
type BrowserHistoryInput = Parameters<KnowledgeService['syncBrowserHistory']>[0];
type BookmarkSeedsInput = Parameters<KnowledgeService['ingestBookmarkSeeds']>[0];
type ConnectorInput = Parameters<KnowledgeService['ingestConnectorInput']>[0];
type KnowledgeMapInput = Parameters<KnowledgeService['map']>[0];
type ProjectionRenderInput = Parameters<KnowledgeService['renderProjection']>[0];
type ProjectionMaterializeInput = Parameters<KnowledgeService['materializeProjection']>[0];
type PacketTask = Parameters<KnowledgeService['buildPacket']>[0];
type PacketWriteScope = Parameters<KnowledgeService['buildPacket']>[1];
type PacketLimit = Parameters<KnowledgeService['buildPacket']>[2];
type PacketOptions = Parameters<KnowledgeService['buildPacket']>[3];
type ScheduleSaveInput = Parameters<KnowledgeService['saveSchedule']>[0];
type ConsolidationDecision = Parameters<KnowledgeService['decideConsolidationCandidate']>[1];
type ConsolidationDecisionInput = Parameters<KnowledgeService['decideConsolidationCandidate']>[2];
type RunJobInput = Parameters<KnowledgeService['runJob']>[1];
type CandidateListInput = Parameters<KnowledgeService['listConsolidationCandidates']>[1];
type RemoteKnowledgeFetchMode = Extract<ArtifactFetchMode, 'public-only' | 'allow-private-hosts'>;

export interface KnowledgeApiUrlIngestInput extends Omit<IngestUrlInput, 'allowPrivateHosts' | 'metadata'> {
  readonly fetchMode?: RemoteKnowledgeFetchMode | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeApiArtifactIngestInput extends Omit<IngestArtifactInput, 'allowPrivateHosts' | 'metadata'> {
  readonly fetchMode?: RemoteKnowledgeFetchMode | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MemoryExplainResult {
  readonly injections: readonly KnowledgeInjection[];
  readonly prompt: string | null;
}

export interface MemoryApi {
  add(input: MemoryAddOptions): Promise<MemoryRecord>;
  search(filter?: MemorySearchFilter): Promise<readonly MemoryRecord[]>;
  searchSemantic(filter?: MemorySearchFilter): Promise<readonly MemorySemanticSearchResult[]>;
  vectorStats(): MemoryVectorStats;
  rebuildVectors(): MemoryVectorStats;
  rebuildVectorsAsync(): Promise<MemoryVectorStats>;
  doctor(): Promise<MemoryDoctorReport>;
  reviewQueue(limit?: number, scope?: MemoryScope): Promise<readonly MemoryRecord[]>;
  exportBundle(filter?: MemorySearchFilter): MemoryBundle;
  importBundle(bundle: MemoryBundle): Promise<MemoryImportResult>;
  get(id: string): MemoryRecord | null;
  getAll(): readonly MemoryRecord[];
  link(fromId: string, toId: string, relation: string): Promise<MemoryLink | null>;
  linksFor(id: string): readonly MemoryLink[];
  update(id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null;
  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null;
  delete(id: string): boolean;
  explain(task: string, writeScope?: readonly string[], limit?: number): Promise<MemoryExplainResult>;
}

export type MemoryApiRegistry = Pick<
  MemoryRegistry,
  | 'add'
  | 'doctor'
  | 'delete'
  | 'exportBundle'
  | 'get'
  | 'getAll'
  | 'importBundle'
  | 'link'
  | 'linksFor'
  | 'rebuildVectors'
  | 'rebuildVectorsAsync'
  | 'review'
  | 'reviewQueue'
  | 'search'
  | 'searchSemantic'
  | 'update'
  | 'vectorStats'
>;

/**
 * memory-api-parallel query surface for the repo source-tree code index
 * (see CHANGELOG 0.38.0). Deliberately NOT folded into MemoryApi:
 * CodeContextResult/CodeIndexStats are a different record shape than
 * MemoryRecord, and code-index retrieval carries no cls/reviewState/trustTier
 * provenance semantics, see createCodeIndexApi / createMemoryApi below.
 */
export interface CodeIndexApi {
  search(query: string, opts?: { limit?: number }): Promise<readonly CodeContextResult[]>;
  stats(): CodeIndexStats;
  reindex(): Promise<CodeIndexBuildStats>;
  scheduleReindex(): void;
  reindexFile(absPath: string): Promise<{ indexed: boolean; mode: CodeChunkMode }>;
  /** Stated once, honest: why auto-retrieval would be absent right now (no semantic embedding provider). Null when available. */
  describeDegradation(): string | null;
}

export type CodeIndexApiRegistry = Pick<
  CodeIndexStore,
  'search' | 'stats' | 'buildFull' | 'scheduleBuild' | 'reindexFile' | 'describeDegradation'
>;

export interface CreateKnowledgeApiOptions {
  readonly memoryRegistry?: MemoryApiRegistry | undefined;
  readonly codeIndexStore?: CodeIndexApiRegistry | undefined;
}

export interface KnowledgeApi {
  readonly status: {
    get(scope?: KnowledgeSpaceScopeInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['getStatus']>;
    lint(): ReturnType<KnowledgeService['lint']>;
    reindex(): ReturnType<KnowledgeService['reindex']>;
  };
  readonly sources: {
    list(limit?: number, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['listSources']>;
    query(input?: SourceQueryInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['querySources']>;
    delete(id: string): ReturnType<KnowledgeService['deleteSource']>;
  };
  readonly graph: {
    nodes: {
      list(limit?: number, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['listNodes']>;
      query(input?: NodeQueryInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['queryNodes']>;
      history(id: string): ReturnType<KnowledgeService['listNodeRevisions']>;
      delete(id: string): ReturnType<KnowledgeService['deleteNode']>;
      merge(loserId: string, winnerId: string): ReturnType<KnowledgeService['mergeNodes']>;
      review(input: NodeReviewInput): ReturnType<KnowledgeService['reviewNode']>;
    };
    issues: {
      list(limit?: number, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['listIssues']>;
      query(input?: IssueQueryInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['queryIssues']>;
      review(input: IssueReviewInput): ReturnType<KnowledgeService['reviewIssue']>;
    };
    extractions: {
      list(limit?: number, sourceId?: string, scope?: KnowledgeSpaceScopeInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['listExtractions']>;
      get(id: string, scope?: KnowledgeSpaceScopeInput, options?: KnowledgeScopeSelectionOptions): Promise<ReturnType<KnowledgeService['getExtraction']>>;
      getBySourceId(sourceId: string, scope?: KnowledgeSpaceScopeInput, options?: KnowledgeScopeSelectionOptions): Promise<ReturnType<KnowledgeService['getSourceExtraction']>>;
    };
    items: {
      get(id: string, scope?: KnowledgeSpaceScopeInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['getItemScoped']>;
      getMany(ids: readonly string[], scope?: KnowledgeSpaceScopeInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['getItems']>;
      neighbors(
        kind: Parameters<KnowledgeService['getNeighbors']>[0],
        id: string,
        input?: NeighborInput,
        options?: KnowledgeScopeSelectionOptions,
      ): ReturnType<KnowledgeService['getNeighbors']>;
      search(query: string, limit?: number, options?: Parameters<KnowledgeService['searchScoped']>[1]): ReturnType<KnowledgeService['searchScoped']>;
    };
    map(input?: KnowledgeMapInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['map']>;
  };
  readonly usage: {
    list(limit?: number, input?: UsageListInput): ReturnType<KnowledgeService['listUsageRecords']>;
    record(input: RecordUsageInput): ReturnType<KnowledgeService['recordUsage']>;
  };
  readonly connectors: {
    list(): ReturnType<KnowledgeService['listConnectors']>;
    get(id: string): ReturnType<KnowledgeService['getConnector']>;
    doctor(id: string): ReturnType<KnowledgeService['doctorConnector']>;
    register(connector: Parameters<KnowledgeService['registerConnector']>[0], options?: Parameters<KnowledgeService['registerConnector']>[1]): void;
  };
  readonly ingest: {
    url(input: KnowledgeApiUrlIngestInput): ReturnType<KnowledgeService['ingestUrl']>;
    artifact(input: KnowledgeApiArtifactIngestInput): ReturnType<KnowledgeService['ingestArtifact']>;
    browserHistory(input?: BrowserHistoryInput): ReturnType<KnowledgeService['syncBrowserHistory']>;
    bookmarksFile(input: ImportBookmarksInput): ReturnType<KnowledgeService['importBookmarksFromFile']>;
    urlsFile(input: ImportUrlsInput): ReturnType<KnowledgeService['importUrlsFromFile']>;
    bookmarkSeeds(input: BookmarkSeedsInput): ReturnType<KnowledgeService['ingestBookmarkSeeds']>;
    withConnector(
      connectorId: Parameters<KnowledgeService['ingestWithConnector']>[0],
      input: Parameters<KnowledgeService['ingestWithConnector']>[1],
      sessionId?: Parameters<KnowledgeService['ingestWithConnector']>[2],
    ): ReturnType<KnowledgeService['ingestWithConnector']>;
    connectorInput(input: ConnectorInput): ReturnType<KnowledgeService['ingestConnectorInput']>;
  };
  readonly packets: {
    build(
      task: PacketTask,
      writeScope?: PacketWriteScope,
      limit?: PacketLimit,
      options?: PacketOptions,
    ): ReturnType<KnowledgeService['buildPacket']>;
    preparePrompt(
      task: PacketTask,
      writeScope?: PacketWriteScope,
      limit?: PacketLimit,
      options?: PacketOptions,
    ): ReturnType<KnowledgeService['preparePromptPacket']>;
    buildPrompt(
      task: PacketTask,
      writeScope?: PacketWriteScope,
      limit?: PacketLimit,
      options?: PacketOptions,
    ): ReturnType<KnowledgeService['buildPromptPacket']>;
  };
  readonly projections: {
    listTargets(limit?: number, scope?: KnowledgeSpaceScopeInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['listProjectionTargets']>;
    render(input: ProjectionRenderInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['renderProjection']>;
    materialize(input: ProjectionMaterializeInput, options?: KnowledgeScopeSelectionOptions): ReturnType<KnowledgeService['materializeProjection']>;
  };
  readonly jobs: {
    list(): ReturnType<KnowledgeService['listJobs']>;
    get(id: string): ReturnType<KnowledgeService['getJob']>;
    runs(limit?: number, jobId?: string): ReturnType<KnowledgeService['listJobRuns']>;
    run(id: string, input?: RunJobInput): ReturnType<KnowledgeService['runJob']>;
    schedules: {
      list(limit?: number): ReturnType<KnowledgeService['listSchedules']>;
      get(id: string): ReturnType<KnowledgeService['getSchedule']>;
      save(input: ScheduleSaveInput): ReturnType<KnowledgeService['saveSchedule']>;
      delete(id: string): ReturnType<KnowledgeService['deleteSchedule']>;
      setEnabled(id: string, enabled: boolean): ReturnType<KnowledgeService['setScheduleEnabled']>;
    };
  };
  readonly consolidation: {
    candidates(limit?: number, input?: CandidateListInput): ReturnType<KnowledgeService['listConsolidationCandidates']>;
    getCandidate(id: string): ReturnType<KnowledgeService['getConsolidationCandidate']>;
    reports(limit?: number): ReturnType<KnowledgeService['listConsolidationReports']>;
    getReport(id: string): ReturnType<KnowledgeService['getConsolidationReport']>;
    decide(
      candidateId: string,
      decision: ConsolidationDecision,
      input?: ConsolidationDecisionInput,
    ): ReturnType<KnowledgeService['decideConsolidationCandidate']>;
  };
  readonly memory?: MemoryApi | undefined;
  readonly codeIndex?: CodeIndexApi | undefined;
}

function normalizeKnowledgeFetchMode(fetchMode: RemoteKnowledgeFetchMode | undefined): {
  fetchMode?: RemoteKnowledgeFetchMode | undefined;
  allowPrivateHosts?: boolean | undefined;
} {
  if (!fetchMode) return {};
  return {
    fetchMode,
    allowPrivateHosts: fetchMode === 'allow-private-hosts',
  };
}

function appendKnowledgeIntentMetadata(
  metadata: Record<string, unknown> | undefined,
  fetchMode: RemoteKnowledgeFetchMode | undefined,
  ingestMode: 'url' | 'artifact',
): Record<string, unknown> | undefined {
  if (!metadata && !fetchMode) return {
    knowledgeIntent: {
      ingestMode,
    },
  };
  return {
    ...(metadata ?? {}),
    knowledgeIntent: {
      ingestMode,
      ...(fetchMode ? { remoteFetchMode: fetchMode } : {}),
    },
  };
}

export function createMemoryApi(memoryRegistry: MemoryApiRegistry): MemoryApi {
  return Object.freeze({
    add: (input: MemoryAddOptions) => memoryRegistry.add(input),
    search: (filter: MemorySearchFilter = {}) => memoryRegistry.search(filter),
    searchSemantic: (filter: MemorySearchFilter = {}) => memoryRegistry.searchSemantic(filter),
    vectorStats: () => memoryRegistry.vectorStats(),
    rebuildVectors: () => memoryRegistry.rebuildVectors(),
    rebuildVectorsAsync: () => memoryRegistry.rebuildVectorsAsync(),
    doctor: () => memoryRegistry.doctor(),
    reviewQueue: (limit = 10, scope?: MemoryScope) => memoryRegistry.reviewQueue(limit, scope),
    exportBundle: (filter: MemorySearchFilter = {}) => memoryRegistry.exportBundle(filter),
    importBundle: (bundle: MemoryBundle) => memoryRegistry.importBundle(bundle),
    get: (id: string) => memoryRegistry.get(id),
    getAll: () => memoryRegistry.getAll(),
    link: (fromId: string, toId: string, relation: string) => memoryRegistry.link(fromId, toId, relation),
    linksFor: (id: string) => memoryRegistry.linksFor(id),
    update: (id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }) => (
      memoryRegistry.update(id, patch)
    ),
    review: (id: string, patch: MemoryReviewPatch) => memoryRegistry.review(id, patch),
    delete: (id: string) => memoryRegistry.delete(id),
    explain: async (task: string, writeScope: readonly string[] = [], limit = 3): Promise<MemoryExplainResult> => {
      const injections = await selectKnowledgeForTask(memoryRegistry, task, writeScope, limit);
      return {
        injections,
        prompt: buildKnowledgeInjectionPrompt(injections),
      };
    },
  });
}

export function createCodeIndexApi(codeIndexStore: CodeIndexApiRegistry): CodeIndexApi {
  return Object.freeze({
    search: (query: string, opts: { limit?: number } = {}) => codeIndexStore.search(query, opts),
    stats: () => codeIndexStore.stats(),
    reindex: () => codeIndexStore.buildFull(),
    scheduleReindex: () => codeIndexStore.scheduleBuild(),
    reindexFile: (absPath: string) => codeIndexStore.reindexFile(absPath),
    describeDegradation: () => codeIndexStore.describeDegradation(),
  });
}

export function createKnowledgeApi(
  knowledgeService: KnowledgeService,
  options: CreateKnowledgeApiOptions = {},
): KnowledgeApi {
  return Object.freeze({
    status: Object.freeze({
      get: (scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.getStatus(scope, options),
      lint: () => knowledgeService.lint(),
      reindex: () => knowledgeService.reindex(),
    }),
    sources: Object.freeze({
      list: (limit = 100, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.listSources(limit, options),
      query: (input: SourceQueryInput = {}, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.querySources(input, options),
      delete: (id: string) => knowledgeService.deleteSource(id),
    }),
    graph: Object.freeze({
      nodes: Object.freeze({
        list: (limit = 100, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.listNodes(limit, options),
        query: (input: NodeQueryInput = {}, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.queryNodes(input, options),
        history: (id: string) => knowledgeService.listNodeRevisions(id),
        delete: (id: string) => knowledgeService.deleteNode(id),
        merge: (loserId: string, winnerId: string) => knowledgeService.mergeNodes(loserId, winnerId),
        review: (input: NodeReviewInput) => knowledgeService.reviewNode(input),
      }),
      issues: Object.freeze({
        list: (limit = 100, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.listIssues(limit, options),
        query: (input: IssueQueryInput = {}, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.queryIssues(input, options),
        review: (input: IssueReviewInput) => knowledgeService.reviewIssue(input),
      }),
      extractions: Object.freeze({
        list: (limit: number = 100, sourceId?: string, scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.listExtractions(limit, sourceId, scope, options),
        get: async (id: string, scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}) => (
          await knowledgeService.listExtractions(Number.MAX_SAFE_INTEGER, undefined, scope, options)
        ).find(extraction => extraction.id === id) ?? null,
        getBySourceId: async (sourceId: string, scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}) => (
          await knowledgeService.listExtractions(1, sourceId, scope, options)
        )[0] ?? null,
      }),
      items: Object.freeze({
        get: (id: string, scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.getItemScoped(id, scope, options),
        getMany: (ids: readonly string[], scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.getItems(ids, scope, options),
        neighbors: (
          kind: Parameters<KnowledgeService['getNeighbors']>[0],
          id: string,
          input: NeighborInput = {},
          options: KnowledgeScopeSelectionOptions = {},
        ) => knowledgeService.getNeighbors(kind, id, input, options),
        search: (query: string, limit = 10, options: Parameters<KnowledgeService['searchScoped']>[1] = {}) => knowledgeService.searchScoped({ query, limit }, options),
      }),
      map: (input: KnowledgeMapInput = {}, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.map(input, options),
    }),
    usage: Object.freeze({
      list: (limit = 100, input = {}) => knowledgeService.listUsageRecords(limit, input),
      record: (input: RecordUsageInput) => knowledgeService.recordUsage(input),
    }),
    connectors: Object.freeze({
      list: () => knowledgeService.listConnectors(),
      get: (id: string) => knowledgeService.getConnector(id),
      doctor: (id: string) => knowledgeService.doctorConnector(id),
      register: (
        connector: Parameters<KnowledgeService['registerConnector']>[0],
        options: Parameters<KnowledgeService['registerConnector']>[1] = {},
      ) => knowledgeService.registerConnector(connector, options),
    }),
    ingest: Object.freeze({
      url: (input: KnowledgeApiUrlIngestInput) => knowledgeService.ingestUrl({
        ...input,
        ...normalizeKnowledgeFetchMode(input.fetchMode),
        metadata: appendKnowledgeIntentMetadata(input.metadata, input.fetchMode, 'url'),
      }),
      artifact: (input: KnowledgeApiArtifactIngestInput) => knowledgeService.ingestArtifact({
        ...input,
        ...normalizeKnowledgeFetchMode(input.fetchMode),
        metadata: appendKnowledgeIntentMetadata(input.metadata, input.fetchMode, 'artifact'),
      }),
      browserHistory: (input: BrowserHistoryInput = {}) => knowledgeService.syncBrowserHistory(input),
      bookmarksFile: (input: ImportBookmarksInput) => knowledgeService.importBookmarksFromFile(input),
      urlsFile: (input: ImportUrlsInput) => knowledgeService.importUrlsFromFile(input),
      bookmarkSeeds: (
        seeds: Parameters<KnowledgeService['ingestBookmarkSeeds']>[0],
        sessionId?: Parameters<KnowledgeService['ingestBookmarkSeeds']>[1],
        sourceType?: Parameters<KnowledgeService['ingestBookmarkSeeds']>[2],
        connectorId?: Parameters<KnowledgeService['ingestBookmarkSeeds']>[3],
      ) => knowledgeService.ingestBookmarkSeeds(seeds, sessionId, sourceType, connectorId),
      withConnector: (
        connectorId: Parameters<KnowledgeService['ingestWithConnector']>[0],
        input: Parameters<KnowledgeService['ingestWithConnector']>[1],
        sessionId?: Parameters<KnowledgeService['ingestWithConnector']>[2],
      ) => knowledgeService.ingestWithConnector(connectorId, input, sessionId),
      connectorInput: (input: ConnectorInput) => knowledgeService.ingestConnectorInput(input),
    }),
    packets: Object.freeze({
      build: (
        task: PacketTask,
        writeScope: PacketWriteScope = [],
        limit: PacketLimit = 10,
        options: PacketOptions = {},
      ) => knowledgeService.buildPacket(task, writeScope, limit, options),
      preparePrompt: (
        task: PacketTask,
        writeScope: PacketWriteScope = [],
        limit: PacketLimit = 10,
        options: PacketOptions = {},
      ) => knowledgeService.preparePromptPacket(task, writeScope, limit, options),
      buildPrompt: (
        task: PacketTask,
        writeScope: PacketWriteScope = [],
        limit: PacketLimit = 10,
        options: PacketOptions = {},
      ) => knowledgeService.buildPromptPacket(task, writeScope, limit, options),
    }),
    projections: Object.freeze({
      listTargets: (limit = 25, scope: KnowledgeSpaceScopeInput = {}, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.listProjectionTargets(limit, scope, options),
      render: (input: ProjectionRenderInput, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.renderProjection(input, options),
      materialize: (input: ProjectionMaterializeInput, options: KnowledgeScopeSelectionOptions = {}) => knowledgeService.materializeProjection(input, options),
    }),
    jobs: Object.freeze({
      list: () => knowledgeService.listJobs(),
      get: (id: string) => knowledgeService.getJob(id),
      runs: (limit: number = 100, jobId?: string) => knowledgeService.listJobRuns(limit, jobId),
      run: (id: string, input: RunJobInput = {}) => knowledgeService.runJob(id, input),
      schedules: Object.freeze({
        list: (limit = 100) => knowledgeService.listSchedules(limit),
        get: (id: string) => knowledgeService.getSchedule(id),
        save: (input: ScheduleSaveInput) => knowledgeService.saveSchedule(input),
        delete: (id: string) => knowledgeService.deleteSchedule(id),
        setEnabled: (id: string, enabled: boolean) => knowledgeService.setScheduleEnabled(id, enabled),
      }),
    }),
    consolidation: Object.freeze({
      candidates: (limit = 100, input = {}) => knowledgeService.listConsolidationCandidates(limit, input),
      getCandidate: (id: string) => knowledgeService.getConsolidationCandidate(id),
      reports: (limit = 100) => knowledgeService.listConsolidationReports(limit),
      getReport: (id: string) => knowledgeService.getConsolidationReport(id),
      decide: (
        candidateId: string,
        decision: ConsolidationDecision,
        input: ConsolidationDecisionInput = {},
      ) => knowledgeService.decideConsolidationCandidate(candidateId, decision, input),
    }),
    ...(options.memoryRegistry ? { memory: createMemoryApi(options.memoryRegistry) } : {}),
    ...(options.codeIndexStore ? { codeIndex: createCodeIndexApi(options.codeIndexStore) } : {}),
  });
}
