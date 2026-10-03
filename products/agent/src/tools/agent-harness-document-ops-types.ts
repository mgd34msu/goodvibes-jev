import type { AgentWorkspaceReviewPacketWizard } from '../input/agent-workspace-types.ts';

export type DocumentOpsLaneId =
  | 'documents'
  | 'uploads'
  | 'exports'
  | 'reviewer_readiness'
  | 'review_packet_timeline'
  | 'review_packet_wizard'
  | 'source_library'
  | 'media_artifacts'
  | 'artifact_browser'
  | 'model_compare';

export type DocumentOpsStatus = 'ready' | 'attention' | 'partial' | 'needs-setup' | 'gap';
export type ReviewerReadinessStatus = 'ready' | 'attention' | 'needs-setup';
export type ReviewerReadinessCheckStatus = 'pass' | 'attention' | 'needs-setup';

export interface AgentHarnessDocumentOpsArgs {
  readonly laneId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

export interface DocumentOpsLane {
  readonly id: DocumentOpsLaneId;
  readonly label: string;
  readonly status: DocumentOpsStatus;
  readonly outcome: string;
  readonly current: string;
  readonly next: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly signals: readonly string[];
  readonly actionIds: readonly string[];
  readonly reviewerReadiness?: ReviewerReadinessChecklist;
  readonly reviewPacketWizard?: AgentWorkspaceReviewPacketWizard;
}

export interface ReviewerReadinessChecklist {
  readonly status: ReviewerReadinessStatus;
  readonly next: string;
  readonly summary: {
    readonly documents: number;
    readonly openComments: number;
    readonly proposedSuggestions: number;
    readonly documentsMissingSourceArtifacts: number;
    readonly savedComparisons: number;
    readonly unrevealedComparisons: number;
    readonly hiddenJudgments: number;
    readonly revealedJudgments: number;
    readonly handoffsMissingRelatedArtifacts: number;
  };
  readonly checks: readonly ReviewerReadinessCheck[];
  readonly policy: string;
}

export interface ReviewerReadinessCheck {
  readonly id: string;
  readonly label: string;
  readonly status: ReviewerReadinessCheckStatus;
  readonly count: number;
  readonly detail: string;
  readonly inspectRoute: string;
  readonly repairRoute?: string;
}

export type DocumentOpsLaneResolution =
  | { readonly status: 'found'; readonly lane: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };
