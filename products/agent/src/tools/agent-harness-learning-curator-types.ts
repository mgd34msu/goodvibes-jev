export type LearningCandidateStatus =
  | 'needs-review'
  | 'needs-setup'
  | 'needs-consolidation'
  | 'low-confidence'
  | 'proposal-ready'
  | 'ready-to-promote'
  | 'ready';
export type LocalLearningCandidateDomain = 'memory' | 'note' | 'persona' | 'skill' | 'skill_bundle' | 'routine';
export type LearningCandidateDomain = LocalLearningCandidateDomain | 'work_plan' | 'research_run' | 'session' | 'capture' | 'vibe';
export type LearningProposalTarget = 'memory' | 'skill' | 'routine' | 'persona';
export type VibeCandidateKind = 'blocked' | 'truncated';

export interface SessionInfoLike {
  readonly name: string;
  readonly title?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly timestamp?: number;
  readonly messageCount?: number;
  readonly filePath?: string;
}

export interface SessionManagerLike {
  readonly list?: () => readonly SessionInfoLike[];
  readonly load?: (name: string) => { readonly meta?: { readonly title?: string }; readonly messages?: readonly unknown[] };
}

export interface AgentHarnessLearningCuratorArgs {
  readonly candidateId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

export interface LearningScores {
  readonly usefulness: number;
  readonly freshness: number;
  readonly sourceQuality: number;
  readonly risk: number;
}

export interface LearningConsolidationDiff {
  readonly field: string;
  readonly survivor: string;
  readonly duplicates: readonly string[];
  readonly merged: string;
}

export interface LearningConsolidationFields {
  readonly detail?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly triggers?: readonly string[];
}

export interface LearningConsolidationPlan {
  readonly survivorId: string;
  readonly duplicateIds: readonly string[];
  readonly sharedKey: string;
  readonly diffs: readonly LearningConsolidationDiff[];
  readonly updateFields?: LearningConsolidationFields;
  readonly rollbackFields: LearningConsolidationFields;
  readonly updateRoute?: string;
  readonly staleRoutes: readonly string[];
  readonly deleteRoutes: readonly string[];
  readonly rollbackRoutes: readonly string[];
}

export interface LearningCandidate {
  readonly id: string;
  readonly label: string;
  readonly domain: LearningCandidateDomain;
  readonly recordId: string | null;
  readonly status: LearningCandidateStatus;
  readonly priority: number;
  readonly reason: string;
  readonly next: string;
  readonly scores: LearningScores;
  readonly reviewState?: string;
  readonly enabled?: boolean;
  readonly active?: boolean;
  readonly confidence?: number;
  readonly proposalTarget?: LearningProposalTarget;
  readonly proposalFields?: Readonly<Record<string, string>>;
  readonly missingRequirements?: readonly string[];
  readonly inspectRoute: string;
  readonly modelRoute: string;
  readonly reviewRoute?: string;
  readonly staleRoute?: string;
  readonly updateRoute?: string;
  readonly createRoute?: string;
  readonly deleteRoute?: string;
  readonly cleanupRoutes?: readonly string[];
  readonly rollbackRoutes?: readonly string[];
  readonly consolidation?: LearningConsolidationPlan;
}

export interface LearningConsolidationBatchCandidate {
  readonly candidateId: string;
  readonly label: string;
  readonly domain: LearningCandidateDomain;
  readonly survivorId: string;
  readonly duplicateCount: number;
  readonly duplicateIds?: readonly string[];
  readonly diffFields: readonly string[];
  readonly detailRoute: string;
  readonly applyRoute: string;
  readonly mergeRoute: string;
  readonly stalePhaseRoute: string;
  readonly deletePhaseRoute: string;
  readonly updateRoute?: string;
  readonly staleRoute?: string;
  readonly deleteRoute?: string;
  readonly staleRoutes?: readonly string[];
  readonly deleteRoutes?: readonly string[];
  readonly rollbackRoutes?: readonly string[];
}

export interface LearningConsolidationBatchPlan {
  readonly status: 'ready';
  readonly candidates: number;
  readonly duplicateRecords: number;
  readonly domains: readonly Record<string, unknown>[];
  readonly routes: Record<string, string>;
  readonly phases: readonly Record<string, unknown>[];
  readonly topCandidates: readonly LearningConsolidationBatchCandidate[];
  readonly policy: string;
}

export interface LearningPromptPlan {
  readonly status: 'ready' | 'attention' | 'empty';
  readonly promptActiveCount: number;
  readonly suppressedCount: number;
  readonly proposalCount: number;
  readonly consolidationCount: number;
  readonly promptActiveRecords: readonly Record<string, unknown>[];
  readonly reviewFirst: readonly Record<string, unknown>[];
  readonly proposalQueue: readonly Record<string, unknown>[];
  readonly consolidationQueue: readonly Record<string, unknown>[];
  readonly suppressed: Record<string, number>;
  readonly orderingRules: readonly string[];
  readonly routes: Record<string, string>;
  readonly policy: string;
}

export type LearningCandidateResolution =
  | { readonly status: 'found'; readonly candidate: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };
