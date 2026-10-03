import type { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChatResponse, LLMProvider } from '@goodvibes-jev/engine/sdk/platform/providers';

export interface AgentModelCompareToolArgs {
  readonly mode?: unknown;
  readonly prompt?: unknown;
  readonly modelRefs?: unknown;
  readonly candidateCount?: unknown;
  readonly rubric?: unknown;
  readonly systemPrompt?: unknown;
  readonly maxTokens?: unknown;
  readonly reveal?: unknown;
  readonly saveArtifact?: unknown;
  readonly benchmarkKind?: unknown;
  readonly comparisonId?: unknown;
  readonly artifactId?: unknown;
  readonly leftArtifactId?: unknown;
  readonly rightArtifactId?: unknown;
  readonly sectionId?: unknown;
  readonly winner?: unknown;
  readonly winnerBlindId?: unknown;
  readonly reasons?: unknown;
  readonly notes?: unknown;
  readonly decision?: unknown;
  readonly limit?: unknown;
  readonly includeReasons?: unknown;
  readonly taskType?: unknown;
  readonly documentId?: unknown;
  readonly relatedArtifactIds?: unknown;
  readonly previewBytes?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export interface AgentModelCompareRouteUpdateResult {
  readonly previousModel?: string;
  readonly selectedModel: string;
}

export interface AgentModelCompareCatalogModel {
  readonly id?: string;
  readonly modelId?: string;
  readonly provider?: string;
  readonly providerId?: string;
  readonly registryKey?: string;
  readonly displayName?: string;
  readonly selectable?: boolean;
  readonly current?: boolean;
  readonly contextWindow?: number;
}

export interface AgentModelCompareModelCatalog {
  readonly listModels: (query?: { readonly selectableOnly?: boolean }) => readonly AgentModelCompareCatalogModel[] | Promise<readonly AgentModelCompareCatalogModel[]>;
  readonly getCurrentModel?: () => AgentModelCompareCatalogModel | Promise<AgentModelCompareCatalogModel>;
  readonly recordModelUsage?: (registryKey: string) => Promise<unknown>;
}

export interface AgentModelCompareProviderRegistry {
  readonly getForModel: (modelId: string, provider?: string) => LLMProvider;
}

export type AgentModelCompareArtifactStore = Pick<ArtifactStore, 'create'> & Partial<Pick<ArtifactStore, 'list' | 'readContent'>>;

export interface AgentModelCompareToolDeps {
  readonly modelCatalog: AgentModelCompareModelCatalog;
  readonly providerRegistry: AgentModelCompareProviderRegistry;
  readonly artifactStore?: AgentModelCompareArtifactStore;
  readonly applyModelRoute?: (registryKey: string) => AgentModelCompareRouteUpdateResult | Promise<AgentModelCompareRouteUpdateResult>;
}

export interface ResolvedCompareModel {
  readonly registryKey: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly current: boolean;
}

export type CompareCandidateStatus = 'completed' | 'failed';

export interface CompareCandidateResult {
  readonly blindId: string;
  readonly model: ResolvedCompareModel;
  readonly status: CompareCandidateStatus;
  readonly content: string;
  readonly stopReason?: string;
  readonly usage?: ChatResponse['usage'];
  readonly latencyMs: number;
  readonly toolCallCount?: number;
  readonly error?: string;
}

export interface StoredComparison {
  readonly comparisonId: string;
  readonly createdAt: string;
  readonly promptPreview: string;
  readonly rubric: string;
  readonly sourceArtifact?: SavedComparisonArtifact;
  readonly benchmarkKind?: string;
  readonly taskType?: string;
  readonly documentId?: string;
  readonly candidates: readonly CompareCandidateResult[];
  readonly artifact?: SavedComparisonArtifact;
  readonly artifactStatus?: ComparisonArtifactStatus;
}

export interface LoadedComparisonJudgment {
  readonly artifact: SavedComparisonArtifact;
  readonly judgmentId: string;
  readonly comparisonId: string;
  readonly winnerBlindId: string;
  readonly reasons: string;
  readonly notes: string;
  readonly revealIncludedInJudgment: boolean;
  readonly sourceArtifactId?: string;
  readonly benchmarkKind?: string;
  readonly taskType?: string;
  readonly documentId?: string;
  readonly winnerModel?: {
    readonly registryKey: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly displayName: string;
  };
}

export interface LoadedComparisonHandoff {
  readonly artifact: SavedComparisonArtifact;
  readonly handoffId: string;
  readonly sourceArtifactId: string;
  readonly sourceKind: 'comparison' | 'judgment';
  readonly comparisonId: string;
  readonly relatedArtifactIds: readonly string[];
  readonly revealIncludedInHandoff: boolean;
}

export interface SavedComparisonArtifact {
  readonly artifactId: string;
  readonly filename?: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly documentId?: string;
}

export interface ComparisonArtifactStatus {
  readonly state: 'saved' | 'disabled' | 'unavailable' | 'failed';
  readonly message: string;
}

export const MODE_RUN = 'run';
export const MODE_REVEAL = 'reveal';
export const MODE_REVIEW = 'review';
export const MODE_SIDE_BY_SIDE = 'sideBySide';
export const MODE_JUDGE = 'judge';
export const MODE_APPLY = 'apply';
export const MODE_ROUTE_DECISION = 'routeDecision';
export const MODE_EXPORT = 'export';
export const MODE_HANDOFF = 'handoff';
export const MODE_HANDOFF_ARCHIVE = 'handoffArchive';
export const MODE_HANDOFF_DIFF = 'handoffDiff';
export const MODE_ANALYTICS = 'analytics';
export const MODE_SYNTHESIS = 'synthesis';
export const MAX_PROMPT_CHARS = 24_000;
export const MIN_CANDIDATES = 2;
export const MAX_CANDIDATES = 4;
export const DEFAULT_CANDIDATE_COUNT = 2;
export const DEFAULT_MAX_TOKENS = 2_048;
export const MAX_COMPLETION_TOKENS = 8_192;
export const DEFAULT_CANDIDATE_OUTPUT_CHARS = 12_000;
export const MAX_SOURCE_ARTIFACT_BYTES = 18_000;
export const MAX_HANDOFF_ARTIFACT_BYTES = 40_000;
export const MAX_HANDOFF_ARCHIVE_ARTIFACTS = 100;
export const MAX_HANDOFF_DIFF_INPUT_LINES = 360;
export const MAX_HANDOFF_DIFF_ROWS = 120;
export const MAX_HANDOFF_DIFF_SECTION_PREVIEW_CHARS = 180;
export const DEFAULT_SIDE_BY_SIDE_PREVIEW_BYTES = 2_000;
export const MAX_SIDE_BY_SIDE_PREVIEW_BYTES = 10_000;
export const COMPARISON_STORE_LIMIT = 25;
export const BLIND_LABELS = ['A', 'B', 'C', 'D'] as const;

export const SYNTHESIS_THEMES: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = [
  { label: 'Concrete/actionable output', pattern: /\b(concrete|actionable|specific|steps?|route|command|practical)\b/i },
  { label: 'Clear/scannable communication', pattern: /\b(clear|clarity|concise|scan|scannable|readable|structured|tone)\b/i },
  { label: 'Accuracy and faithfulness', pattern: /\b(accurate|accuracy|faithful|correct|factual|hallucinat|source|evidence)\b/i },
  { label: 'Context fit', pattern: /\b(context|project|user|goal|fit|rubric|instruction)\b/i },
  { label: 'Safety and risk handling', pattern: /\b(safe|safety|risk|guard|permission|confirm|policy)\b/i },
  { label: 'Speed and efficiency', pattern: /\b(fast|speed|latency|efficient|short|token)\b/i },
];
