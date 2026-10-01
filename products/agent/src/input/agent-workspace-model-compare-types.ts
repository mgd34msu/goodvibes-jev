export type AgentWorkspaceFieldReader = (fieldId: string) => string;

export interface AgentModelCompareWorkspaceToolArgs {
  readonly mode: 'run';
  readonly prompt: string;
  readonly artifactId?: string;
  readonly modelRefs?: readonly string[];
  readonly candidateCount?: number;
  readonly rubric?: string;
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
  readonly benchmarkKind?: string;
  readonly taskType?: string;
  readonly documentId?: string;
  readonly reveal?: boolean;
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export interface AgentModelCompareReviewWorkspaceToolArgs {
  readonly mode: 'review' | 'sideBySide' | 'handoffDiff';
  readonly comparisonId?: string;
  readonly artifactId?: string;
  readonly leftArtifactId?: string;
  readonly rightArtifactId?: string;
  readonly sectionId?: string;
  readonly relatedArtifactIds?: readonly string[];
  readonly previewBytes?: number;
  readonly reveal?: boolean;
}

export interface AgentModelCompareHandoffDiffWorkspaceToolArgs {
  readonly mode: 'handoffDiff';
  readonly leftArtifactId?: string;
  readonly rightArtifactId?: string;
  readonly sectionId?: string;
}

export interface AgentModelCompareJudgmentWorkspaceToolArgs {
  readonly mode: 'judge';
  readonly comparisonId?: string;
  readonly artifactId?: string;
  readonly winnerBlindId: string;
  readonly reasons: string;
  readonly notes?: string;
  readonly reveal?: boolean;
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export interface AgentModelCompareApplyWorkspaceToolArgs {
  readonly mode: 'apply';
  readonly artifactId: string;
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export interface AgentModelCompareRouteDecisionWorkspaceToolArgs {
  readonly mode: 'routeDecision';
  readonly artifactId: string;
  readonly decision: 'left-unchanged';
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export interface AgentModelCompareExportWorkspaceToolArgs {
  readonly mode: 'export' | 'handoff' | 'handoffArchive';
  readonly artifactId: string;
  readonly relatedArtifactIds?: readonly string[];
  readonly reveal?: boolean;
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export interface AgentModelCompareAnalyticsWorkspaceToolArgs {
  readonly mode: 'analytics' | 'synthesis';
  readonly limit?: number;
  readonly includeReasons?: boolean;
  readonly benchmarkKind?: string;
  readonly taskType?: string;
  readonly documentId?: string;
}
