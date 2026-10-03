import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';

export interface AgentHarnessModelRoutingArgs {
  readonly modelRouteId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly fields?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly timeoutMs?: unknown;
}

export type ModelRouteResolution =
  | { readonly status: 'found'; readonly route: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

export type ModelRouteLookupSource = 'modelRouteId' | 'target' | 'query';

export interface ModelCandidate {
  readonly kind: 'model';
  readonly id: string;
  readonly registryKey: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly current: boolean;
  readonly contextWindow: number | null;
  readonly reasoningEffort: readonly string[];
  readonly capabilities: unknown;
  readonly tier?: string;
  readonly benchmarkCompositeScore?: number | null;
  readonly benchmarkQualityTier?: string;
  readonly localBenchmarkLatency?: LocalModelBenchmarkRouteLatency | null;
  readonly pinned: boolean;
}

export interface RouteCandidate {
  readonly kind: 'route';
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly currentValue: unknown;
  readonly settingKeys: readonly string[];
  readonly commands: readonly string[];
  readonly uiSurfaces: readonly string[];
}

export interface LocalModelDetection {
  readonly providerIds: readonly string[];
  readonly modelRoutes: readonly string[];
  readonly stacks: readonly string[];
}

export interface LocalModelHardwareProfile {
  readonly platform: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuThreads: number;
  readonly ramGb: number;
  readonly freeRamGb: number;
  readonly memoryTier: 'constrained' | 'starter' | 'comfortable' | 'large';
  readonly acceleratorHint: 'apple-silicon' | 'cuda-env' | 'none-detected';
  readonly privacy: 'local-only';
  readonly caveat: string;
}

export interface LocalModelRecipe {
  readonly id: string;
  readonly label: string;
  readonly fit: string;
  readonly bestFor: string;
  readonly hardware: string;
  readonly setup: readonly string[];
  readonly modelExamples: readonly string[];
  readonly cautions: readonly string[];
}

export interface LocalModelRecipeFit {
  readonly score: number;
  readonly level: 'weak' | 'usable' | 'good' | 'strong';
  readonly reasons: readonly string[];
}

export interface ModelReadinessDimension {
  readonly id: 'latency' | 'context-window' | 'tool-support' | 'vision' | 'cost' | 'privacy';
  readonly label: string;
  readonly score: number;
  readonly weight: number;
  readonly summary: string;
}

export interface ModelProviderHealthSignal {
  readonly status: 'not-reachable-in-command-context' | 'read-model-empty' | 'read-model-error' | 'record-found';
  readonly providerId: string;
  readonly modelRouteId?: string;
  readonly sourceRecordId?: string;
  readonly sdkContract: {
    readonly providerHealthTypes: 'available';
    readonly importSurface: string;
    readonly note: string;
  };
  readonly daemonPublication: {
    readonly status: 'not-published' | 'published-read-model';
    readonly requiredPath: string;
    readonly evidence: string;
  };
  readonly agentConsumption: {
    readonly status: 'waiting-for-published-feed' | 'consumed';
    readonly readModelPath: string | null;
    readonly evidence: string;
  };
  readonly healthStatus?: string;
  readonly isConfigured?: boolean;
  readonly isActive?: boolean;
  readonly avgLatencyMs?: number;
  readonly minLatencyMs?: number;
  readonly maxLatencyMs?: number;
  readonly lastSuccessAt?: string | null;
  readonly lastErrorAt?: string | null;
  readonly lastErrorMessage?: string;
  readonly errorRate?: number;
  readonly consecutiveErrors?: number;
  readonly lastCheckedAt?: string | null;
  readonly rateLimitResetAt?: string | null;
  readonly rateLimitRemaining?: number;
  readonly rateLimitLimit?: number;
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

export interface ModelReadinessScore {
  readonly score: number;
  readonly level: 'risky' | 'usable' | 'good' | 'excellent';
  readonly confidence: 'estimated' | 'metadata-backed' | 'provider-health-backed' | 'measured';
  readonly dimensions: readonly ModelReadinessDimension[];
  readonly missingSignals: readonly string[];
  readonly providerHealth?: ModelProviderHealthSignal;
  readonly nextStep: string;
}

export interface ModelRouteReadinessScore extends ModelReadinessScore {
  readonly providerHealth: ModelProviderHealthSignal;
}

export interface LocalModelBenchmarkPlan {
  readonly status: 'plan-ready';
  readonly prompt: string;
  readonly measurements: readonly string[];
  readonly workspaceActionRoute: string;
  readonly compareRoute: string;
  readonly refreshRoute: string;
  readonly notes: readonly string[];
}

export interface LocalModelBenchmarkWinner {
  readonly judgmentArtifactId: string;
  readonly sourceArtifactId: string | null;
  readonly registryKey: string;
  readonly stack: string | null;
  readonly promptPreview: string;
  readonly reviewRoute: string;
  readonly exportRoute: string;
  readonly applyRoute: string;
}

export interface LocalModelBenchmarkRouteLatency {
  readonly registryKey: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly blindId: string;
  readonly latencyMs: number;
  readonly status: string;
  readonly artifactId: string;
  readonly comparisonId: string | null;
  readonly createdAt: string | null;
  readonly reviewRoute: string;
}

export interface LocalModelBenchmarkEvidence {
  readonly status: 'unavailable' | 'unmeasured' | 'comparison-saved' | 'reviewed-winner';
  readonly comparisonCount: number;
  readonly completedCandidateCount: number;
  readonly revealedJudgmentCount: number;
  readonly hiddenJudgmentCount: number;
  readonly winnerStacks: readonly string[];
  readonly winnerModels: readonly LocalModelBenchmarkWinner[];
  readonly routeLatencies: readonly LocalModelBenchmarkRouteLatency[];
  readonly summary: string;
  readonly confidence: 'estimated' | 'measured';
}

export type LocalModelEndpointSource = 'provider-registry' | 'model-registry' | 'environment';

export interface LocalModelServerEndpoint {
  readonly kind: 'local-server-endpoint';
  readonly id: string;
  readonly providerId: string | null;
  readonly stack: string | null;
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly diagnosticStatus: 'registered-route-needs-smoke' | 'needs-provider-after-smoke';
  readonly inspectRoute: string;
  readonly sources: readonly LocalModelEndpointSource[];
  readonly sourceDetails: readonly string[];
  readonly modelRoutes: readonly string[];
  readonly smokeCommand: string;
  readonly smokeRoute: string;
  readonly refreshRoute: string;
  readonly addProviderRoute: string | null;
  readonly notes: readonly string[];
  readonly servingDiagnostics?: LocalModelServerServingDiagnostics;
  readonly diagnostics?: {
    readonly liveProbe: 'not-run';
    readonly successCriteria: readonly string[];
    readonly failureTriage: readonly string[];
    readonly afterSmoke: readonly string[];
    readonly policy: string;
  };
}

export interface LocalModelServerServingDiagnostics {
  readonly status: 'ready' | 'attention' | 'blocked' | 'unknown';
  readonly source: string;
  readonly summary: string;
  readonly schemaStatus?: 'certified' | 'legacy';
  readonly schemaVersion?: string;
  readonly provenance?: readonly string[];
  readonly publicationGuarantee?: string;
  readonly publisher?: string;
  readonly serverVersion?: string;
  readonly loadedModelCount?: number;
  readonly loadedModels: readonly string[];
  readonly contextWindowTokens?: number;
  readonly toolSupport?: boolean;
  readonly resourcePressure: 'low' | 'moderate' | 'high' | 'unknown';
  readonly resourceSummary?: string;
  readonly lastCheckedAt?: string | null;
  readonly startReceiptId?: string;
  readonly repairReceiptId?: string;
  readonly receiptStatus?: string;
  readonly startRoute?: string;
  readonly repairRoute?: string;
  readonly inspectRoute: string;
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

export interface LocalModelServerDiagnosticsPublication {
  readonly status: 'not-published' | 'published-read-model' | 'read-model-empty' | 'read-model-error';
  readonly requiredPaths: readonly string[];
  readonly sourcePaths: readonly string[];
  readonly recordCount: number;
  readonly matchedEndpointCount: number;
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

export interface LocalModelServerDefaultEndpoint {
  readonly id: string;
  readonly label: string;
  readonly stack: string;
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly smokeCommand: string;
  readonly addProviderRoute: string;
  readonly startHint: string;
}

export interface LocalModelServerHealthMap {
  readonly status: 'candidate-endpoints' | 'no-local-endpoints';
  readonly liveProbe: 'not-run';
  readonly endpointCount: number;
  readonly returnedEndpoints: number;
  readonly endpoints: readonly LocalModelServerEndpoint[];
  readonly suggestedDefaults: readonly LocalModelServerDefaultEndpoint[];
  readonly daemonDiagnostics: LocalModelServerDiagnosticsPublication;
  readonly nextActions: readonly string[];
  readonly policy: string;
}

export interface LocalModelSmokeTarget {
  readonly kind: 'local-server-endpoint' | 'suggested-local-server';
  readonly id: string;
  readonly label: string;
  readonly providerId: string | null;
  readonly stack: string | null;
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly smokeCommand: string;
  readonly smokeRoute: string;
  readonly refreshRoute: string;
  readonly addProviderRoute: string | null;
  readonly source: string;
  readonly notes: readonly string[];
}

export interface MutableLocalModelServerEndpoint {
  providerId: string | null;
  stack: string | null;
  readonly baseUrl: string;
  readonly sources: Set<LocalModelEndpointSource>;
  readonly sourceDetails: Set<string>;
  readonly modelRoutes: Set<string>;
  readonly notes: Set<string>;
}

export interface LocalModelSetupPlan {
  readonly status: 'detected' | 'ready-to-try' | 'needs-hardware-review';
  readonly priority: number;
  readonly downloadGuidance: readonly string[];
  readonly providerRoutes: readonly string[];
  readonly benchmarkPlan: LocalModelBenchmarkPlan;
  readonly confirmationBoundary: string;
}

export interface ArtifactListLike {
  readonly list?: (limit?: number) => readonly ArtifactDescriptor[];
}

export interface ProviderApiLike {
  readonly getFavorites: () => Promise<unknown>;
  readonly getCurrentModel: () => Promise<unknown>;
  readonly listModels: (options?: { readonly selectableOnly?: boolean }) => Promise<readonly unknown[]>;
  readonly listProviderIds: () => readonly string[];
}
