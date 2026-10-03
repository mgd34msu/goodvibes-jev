import type { ModelPickerTarget } from './model-picker.ts';
import type { AgentWorkspaceChannelSetupGuide, AgentWorkspaceChannelStatus } from './agent-workspace-channels.ts';
import type { AgentWorkspaceSetupChecklistItem } from './agent-workspace-setup.ts';
import type { AgentWorkspaceVoiceMediaReadiness } from './agent-workspace-voice-media.ts';
import type { AgentBehaviorDiscoverySnapshot } from '../agent/behavior-discovery-summary.ts';
import type { AgentSetupWizard } from '../agent/setup-wizard.ts';
import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditorKind } from './agent-workspace-editor-kinds.ts';

export const AGENT_WORKSPACE_MODAL_NAME = 'agentWorkspace';

export type AgentWorkspaceCategoryGroup = 'START' | 'ONBOARDING' | 'DAY-TO-DAY' | 'CAPABILITIES' | 'LOCAL BEHAVIOR' | 'OPERATIONS' | 'FINISH';

export type AgentWorkspaceFocusPane = 'categories' | 'actions';

export const AGENT_WORKSPACE_CATEGORY_IDS = [
  'home',
  'setup',
  'account-model',
  'assistant-behavior',
  'tools-permissions',
  'onboarding-display',
  'onboarding-channels',
  'onboarding-voice-media',
  'onboarding-context',
  'onboarding-automation',
  'personal-ops',
  'research',
  'documents',
  'artifacts',
  'conversation',
  'channels',
  'tools',
  'knowledge',
  'voice-media',
  'profiles',
  'owner-profile',
  'memory',
  'notes',
  'personas',
  'skills',
  'routines',
  'work',
  'host',
  'automation',
  'delegate',
  'finish',
] as const;

export type AgentWorkspaceCategoryId = (typeof AGENT_WORKSPACE_CATEGORY_IDS)[number];

export type AgentWorkspaceActionKind = 'command' | 'guidance' | 'workspace' | 'editor' | 'setting' | 'settings-import' | 'setup-checkpoint' | 'model-picker' | 'settings-modal' | 'local-selection' | 'local-operation' | 'onboarding-complete';
export type AgentWorkspaceSetupCheckpointOperation = 'show' | 'mark-current' | 'clear';

// The editor-kind unions grow with every new card, so they live in their own
// module and are re-exported here, this stays the one place to import them.
export type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditorKind } from './agent-workspace-editor-kinds.ts';

export type AgentWorkspaceLocalOperation =
  | 'memory-edit'
  | 'memory-review'
  | 'memory-stale'
  | 'memory-delete'
  | 'note-edit'
  | 'note-review'
  | 'note-stale'
  | 'note-delete'
  | 'note-promote-memory'
  | 'note-promote-persona'
  | 'note-promote-skill'
  | 'note-promote-routine'
  | 'note-promote-knowledge-url'
  | 'persona-edit'
  | 'persona-use'
  | 'persona-review'
  | 'persona-clear'
  | 'persona-delete'
  | 'skill-edit'
  | 'skill-enable'
  | 'skill-disable'
  | 'skill-review'
  | 'skill-delete'
  | 'routine-edit'
  | 'routine-start'
  | 'routine-enable'
  | 'routine-disable'
  | 'routine-review'
  | 'routine-delete';

export interface AgentWorkspaceEditorField {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly required: boolean;
  readonly multiline: boolean;
  readonly hint: string;
  readonly redact?: boolean;
}

export interface AgentWorkspaceLocalEditor {
  readonly kind: AgentWorkspaceEditorKind;
  readonly mode: 'create' | 'update' | 'delete';
  readonly recordId?: string;
  readonly title: string;
  readonly fields: readonly AgentWorkspaceEditorField[];
  readonly selectedFieldIndex: number;
  readonly message: string;
}

export interface AgentWorkspaceAction {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly command?: string;
  readonly targetCategoryId?: AgentWorkspaceCategoryId;
  readonly editorKind?: AgentWorkspaceEditorKind;
  readonly settingKey?: string;
  readonly settingValueHint?: string;
  readonly modelPickerTarget?: ModelPickerTarget;
  readonly modelPickerFlow?: 'providerModel' | 'model';
  readonly settingsTarget?: string;
  readonly setupCheckpointOperation?: AgentWorkspaceSetupCheckpointOperation;
  readonly visibleWhenSettingKey?: string;
  readonly visibleWhenSettingValue?: string | boolean | number;
  readonly localKind?: AgentWorkspaceLocalEditorKind;
  readonly selectionDelta?: number;
  readonly localOperation?: AgentWorkspaceLocalOperation;
  readonly kind: AgentWorkspaceActionKind;
  readonly safety: 'safe' | 'read-only' | 'delegates' | 'blocked';
  readonly commandBehavior?: 'inline' | 'compose' | 'exit';
}

export interface AgentWorkspaceCategory {
  readonly id: AgentWorkspaceCategoryId;
  readonly group: AgentWorkspaceCategoryGroup;
  readonly label: string;
  readonly summary: string;
  readonly detail: string;
  readonly actions: readonly AgentWorkspaceAction[];
}

export interface AgentWorkspaceActionSearchResult {
  readonly category: AgentWorkspaceCategory;
  readonly categoryIndex: number;
  readonly action: AgentWorkspaceAction;
  readonly actionIndex: number;
}

export type AgentWorkspaceCommandDispatcher = (command: string, behavior?: 'inline' | 'compose' | 'exit') => void;
export type AgentWorkspacePromptDispatcher = (prompt: string) => void;

export type AgentWorkspaceActionResultKind = 'guidance' | 'blocked' | 'dispatched' | 'refreshed' | 'error' | 'recap';

export interface AgentWorkspaceActionResult {
  readonly kind: AgentWorkspaceActionResultKind;
  readonly title: string;
  readonly detail: string;
  readonly command?: string;
  readonly safety?: AgentWorkspaceAction['safety'];
  /** Lines to display when kind is 'recap'. */
  readonly lines?: readonly string[];
}

export interface AgentWorkspaceLocalLibraryItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly reviewState: string;
  readonly source: string;
  readonly tags: readonly string[];
  readonly triggers: readonly string[];
  readonly scope?: string;
  readonly cls?: string;
  readonly confidence?: number;
  readonly active?: boolean;
  readonly enabled?: boolean;
  readonly requirementCount?: number;
  readonly missingRequirementCount?: number;
  readonly missingRequirements?: readonly string[];
  readonly startCount?: number;
  /** Memory-only: whether this record currently clears the prompt-injection recall floor, per describeMemoryPromptEligibility. */
  readonly promptEligible?: boolean;
  /** Memory-only: the honest, per-record reason from describeMemoryPromptEligibility, the same wording source prompt-context-receipts.ts and agent-harness-prompt-context.ts use. */
  readonly promptEligibilityReason?: string;
  readonly temporalStatus?: 'active' | 'pending' | 'expired'; // memoryRecordTemporalStatus; pending/expired stay stored, just not prompt-injected
}

export interface AgentWorkspaceRecentReviewerHandoffArtifact {
  readonly id: string;
  readonly filename: string;
  readonly createdAt: number;
  readonly handoffId: string;
  readonly comparisonId: string;
  readonly sourceArtifactId: string;
  readonly sourceKind: string;
  readonly relatedArtifactCount: number;
}

export interface AgentWorkspaceReviewerReadinessBadge {
  readonly status: 'ready' | 'attention' | 'needs-setup';
  readonly summary: string;
  readonly next: string;
  readonly issueCount: number;
  readonly openComments: number;
  readonly proposedSuggestions: number;
  readonly missingSourceArtifacts: number;
  readonly unrevealedComparisons: number;
  readonly hiddenJudgments: number;
  readonly revealedJudgments: number;
  readonly handoffsMissingRelatedArtifacts: number;
}

export type AgentWorkspaceReviewPacketTimelineEventKind =
  | 'document'
  | 'comment'
  | 'suggestion'
  | 'attachment'
  | 'document-export'
  | 'compare'
  | 'compare-export'
  | 'judgment'
  | 'route-decision'
  | 'packet-preset'
  | 'handoff'
  | 'handoff-archive';

export interface AgentWorkspaceReviewPacketTimelineEvent {
  readonly id: string;
  readonly kind: AgentWorkspaceReviewPacketTimelineEventKind;
  readonly at: number;
  readonly label: string;
  readonly detail: string;
  readonly status: 'ready' | 'attention' | 'complete' | 'info';
  readonly route: string;
  readonly sourceId: string;
}

export interface AgentWorkspaceReviewPacketTimeline {
  readonly available: boolean;
  readonly count: number;
  readonly next: string;
  readonly items: readonly AgentWorkspaceReviewPacketTimelineEvent[];
}

export interface AgentWorkspaceReviewPacketPresetLineage {
  readonly artifactId: string;
  readonly presetId: string | null;
  readonly name: string | null;
  readonly refreshed: boolean;
  readonly refreshedFromArtifactId: string | null;
  readonly refreshedFromPresetId: string | null;
  readonly freshnessMissingCount: number | null;
  readonly freshnessSupersededCount: number | null;
  readonly freshnessUnresolvedCount: number | null;
  readonly summary: string;
  readonly inspectRoute: string;
}

export interface AgentWorkspaceReviewPacketDefaults {
  readonly documentId: string | null;
  readonly documentTitle: string | null;
  readonly documentExportArtifactId: string | null;
  readonly comparisonArtifactId: string | null;
  readonly judgmentArtifactId: string | null;
  readonly revealedJudgmentArtifactId: string | null;
  readonly routeDecisionArtifactId: string | null;
  readonly routeDecision: string | null;
  readonly handoffArtifactId: string | null;
  readonly handoffArchiveArtifactId: string | null;
  readonly reviewPacketPresetArtifactId: string | null;
  readonly reviewPacketPresetName: string | null;
  readonly reviewPacketPresetLineage: AgentWorkspaceReviewPacketPresetLineage | null;
  readonly relatedArtifactIds: readonly string[];
  readonly summary: string;
}

export type AgentWorkspaceReviewPacketWizardStepStatus = 'done' | 'current' | 'pending' | 'blocked';

export interface AgentWorkspaceReviewPacketWizardStep {
  readonly id: string;
  readonly label: string;
  readonly status: AgentWorkspaceReviewPacketWizardStepStatus;
  readonly detail: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly actionId: string;
  readonly backtrackRoute: string | null;
}

export interface AgentWorkspaceReviewPacketWizard {
  readonly available: boolean;
  readonly status: 'complete' | 'active' | 'blocked' | 'empty';
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly currentStepId: string | null;
  readonly currentStepLabel: string | null;
  readonly next: string;
  readonly finalReview: string;
  readonly presetLineage: AgentWorkspaceReviewPacketPresetLineage | null;
  readonly steps: readonly AgentWorkspaceReviewPacketWizardStep[];
}

export interface AgentWorkspaceRuntimeProfileItem {
  readonly id: string;
  readonly homeDirectory: string;
  readonly createdAt: string | null;
  readonly starterTemplateId?: string;
  readonly starterTemplateName?: string;
}

export interface AgentWorkspaceRuntimeStarterTemplateItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly personaName: string;
  readonly skillNames: readonly string[];
  readonly routineNames: readonly string[];
  readonly source: string;
}

export interface AgentWorkspaceRoutineScheduleReceiptSummary {
  readonly id: string;
  readonly status: string;
  readonly routineId: string;
  readonly routineName: string;
  readonly scheduleName: string;
  readonly scheduleKind: string;
  readonly scheduleValue: string;
  readonly createdAt: string;
}

export interface AgentWorkspaceResearchRunSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly progress: number;
  readonly sourceIds: readonly string[];
  readonly nextSteps: readonly string[];
  readonly checkpointCount: number;
  readonly logTail: readonly string[];
  readonly updatedAt: string;
  readonly note?: string;
  readonly reportArtifactId?: string;
}

export interface AgentWorkspaceResearchContractSummary {
  readonly status: string;
  readonly label: string;
  readonly next: string;
  readonly route: string;
  readonly details: readonly string[];
}

export interface AgentWorkspaceVibeSummary {
  readonly status: 'ready' | 'attention' | 'needs-setup' | 'unavailable';
  readonly applied: number;
  readonly blocked: number;
  readonly truncated: number;
  readonly projectInitPath: string | null;
  readonly globalInitPath: string | null;
  readonly statusRoute: '/vibe status';
  readonly initProjectRoute: '/vibe init';
  readonly initGlobalRoute: '/vibe init --global';
  readonly next: string;
}

export interface AgentWorkspaceProjectContextSummary {
  readonly status: 'ready' | 'attention' | 'needs-setup' | 'unavailable';
  readonly loaded: number;
  readonly blocked: number;
  readonly truncated: number;
  readonly supportedSources: readonly string[];
  readonly targetAware: boolean;
  readonly catalogRoute: 'context action:"files"';
  readonly inspectRoute: 'context action:"file"';
  readonly next: string;
}

export interface AgentWorkspacePromptContextReceiptSummary {
  readonly receiptId: string;
  readonly turnId: string | null;
  readonly source: string;
  readonly provider: string;
  readonly model: string;
  readonly createdAt: number;
  readonly activeRecords: number;
  readonly suppressedRecords: number;
  readonly segmentCount: number;
  readonly approxPromptTokens: number;
  readonly outcomeStatus: 'completed' | 'error' | 'cancelled' | 'pending';
  readonly stopReason: string | null;
  readonly completedAt: number | null;
  readonly detail: string | null;
  readonly inspectRoute: string;
  readonly outcomeFilterRoute: string;
}

export interface AgentWorkspacePromptContextReceiptTimeline {
  readonly status: 'ready' | 'empty' | 'unavailable';
  readonly count: number;
  readonly latestReceiptId: string | null;
  readonly latestTurnId: string | null;
  readonly completedCount: number;
  readonly errorCount: number;
  readonly cancelledCount: number;
  readonly pendingCount: number;
  readonly inspectRoute: 'context action:"prompt" includeParameters:true';
  readonly filterRoutes: {
    readonly completed: string;
    readonly error: string;
    readonly cancelled: string;
    readonly pending: string;
  };
  readonly next: string;
  readonly items: readonly AgentWorkspacePromptContextReceiptSummary[];
}

export interface AgentWorkspaceProcessSupervisionSummary {
  readonly status: 'available' | 'unavailable';
  readonly tracked: number;
  readonly running: number;
  readonly completed: number;
  readonly stdinWriteStatus: 'supported-with-confirmation' | 'not-yet-supported';
  readonly stdinMethod: string | null;
  readonly ptyStatus: 'contract-discovered' | 'not-yet-supported';
  readonly ptyMethod: string | null;
  readonly sudoStatus: 'foreground-only';
  readonly processRoute: string;
  readonly capabilitiesRoute: string;
  readonly visibleMonitorRoute: string;
  readonly liveTailRoute: string;
}

export interface AgentWorkspaceCompanionAccessSummary {
  readonly surface: 'goodvibes-agent';
  readonly hostUrl: string;
  readonly tokenPath: string;
  readonly tokenPresent: boolean;
  readonly tokenReadable: boolean;
  readonly tokenFingerprint: string | null;
  readonly tokenError: string | null;
  readonly pairingReady: boolean;
  readonly qrCommand: '/pair';
  readonly manualTokenCommand: '/pair --show-token --yes';
  readonly nextStep: string;
}

/** Honest, no-I/O email-connect status (config validation only) for the inbox connect card/wizard. */
export interface AgentWorkspaceEmailConnectStatus {
  readonly connected: boolean;
  readonly username: string;
  readonly imapHost: string;
  readonly errors: readonly string[];
}

export interface AgentWorkspaceRuntimeSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly modelDisplayName: string;
  readonly embeddingProvider: string;
  readonly reasoningEffort: string;
  readonly helperEnabled: boolean;
  readonly toolLlmEnabled: boolean;
  readonly providerFailureHints: boolean;
  readonly cacheEnabled: boolean;
  readonly cacheStableTtl: string;
  readonly cacheMonitorHitRate: boolean;
  readonly cacheHitRateWarningThreshold: number;
  readonly hitlMode: string;
  readonly guidanceMode: string;
  readonly saveHistory: boolean;
  readonly autoApprove: boolean;
  readonly autoCompactThreshold: number;
  readonly staleContextWarnings: boolean;
  readonly showThinking: boolean;
  readonly showReasoningSummary: boolean;
  readonly theme: string;
  readonly stream: boolean;
  readonly lineNumbers: string;
  readonly operationalMessages: string;
  readonly systemMessages: string;
  readonly releaseChannel: string;
  readonly permissionMode: string;
  readonly toolAutoHeal: boolean;
  readonly toolsDefaultTokenBudget: number;
  readonly artifactMaxBytes: number;
  readonly rawPromptTelemetry: boolean;
  readonly automationEnabled: boolean;
  readonly automationMaxConcurrentRuns: number;
  readonly automationRunHistoryLimit: number;
  readonly automationDefaultTimeoutMs: number;
  readonly automationCatchUpWindowMinutes: number;
  readonly automationFailureCooldownMs: number;
  readonly automationDeleteAfterRun: boolean;
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly runtimeBaseUrl: string;
  readonly runtimeOwnership: 'external';
  readonly activeSubscriptionCount: number;
  readonly pendingSubscriptionCount: number;
  readonly availableSubscriptionProviderCount: number;
  readonly sessionMemoryCount: number;
  readonly localMemoryCount: number;
  readonly localMemoryReviewQueueCount: number;
  readonly localMemoryPromptActiveCount: number;
  readonly localMemoryTemporallyPendingCount: number;
  readonly localMemoryTemporallyExpiredCount: number;
  readonly localMemories: readonly AgentWorkspaceLocalLibraryItem[];
  readonly localNoteCount: number;
  readonly localNoteReviewQueueCount: number;
  readonly localNotes: readonly AgentWorkspaceLocalLibraryItem[];
  readonly researchSourceCount: number;
  readonly researchSourceCandidateCount: number;
  readonly researchSourceReviewedCount: number;
  readonly researchSourceRejectedCount: number;
  readonly researchSourceUsedCount: number;
  readonly researchRunCount: number;
  readonly researchRunPlannedCount: number;
  readonly researchRunRunningCount: number;
  readonly researchRunPausedCount: number;
  readonly researchRunBlockedCount: number;
  readonly researchRunTerminalCount: number;
  readonly researchRuns: readonly AgentWorkspaceResearchRunSummary[];
  readonly researchBrowserRunnerContract: AgentWorkspaceResearchContractSummary;
  readonly researchVisualReportContract: AgentWorkspaceResearchContractSummary;
  readonly vibe: AgentWorkspaceVibeSummary;
  readonly projectContext: AgentWorkspaceProjectContextSummary;
  readonly promptContextReceipts: AgentWorkspacePromptContextReceiptTimeline;
  readonly processSupervision: AgentWorkspaceProcessSupervisionSummary;
  readonly recentReviewerHandoffArtifactCount: number;
  readonly recentReviewerHandoffArtifacts: readonly AgentWorkspaceRecentReviewerHandoffArtifact[];
  readonly reviewerReadinessBadge: AgentWorkspaceReviewerReadinessBadge;
  readonly reviewPacketTimeline: AgentWorkspaceReviewPacketTimeline;
  readonly reviewPacketDefaults: AgentWorkspaceReviewPacketDefaults;
  readonly reviewPacketWizard: AgentWorkspaceReviewPacketWizard;
  readonly localRoutineCount: number;
  readonly enabledRoutineCount: number;
  readonly localRoutines: readonly AgentWorkspaceLocalLibraryItem[];
  readonly routineScheduleReceiptCount: number;
  readonly successfulRoutineScheduleReceiptCount: number;
  readonly failedRoutineScheduleReceiptCount: number;
  readonly latestRoutineScheduleReceipt: AgentWorkspaceRoutineScheduleReceiptSummary | null;
  readonly localSkillCount: number;
  readonly enabledSkillCount: number;
  readonly localSkillBundleCount: number;
  readonly enabledSkillBundleCount: number;
  readonly activeSkillCount: number;
  readonly localSkillBundles: readonly AgentWorkspaceLocalLibraryItem[];
  readonly localSkills: readonly AgentWorkspaceLocalLibraryItem[];
  readonly localPersonaCount: number;
  readonly activePersonaName: string;
  readonly localPersonas: readonly AgentWorkspaceLocalLibraryItem[];
  readonly discoveredBehavior: AgentBehaviorDiscoverySnapshot;
  readonly knowledgeRoute: '/api/goodvibes-agent/knowledge';
  readonly knowledgeIsolation: 'agent-only';
  readonly executionPolicy: 'serial-proactive';
  readonly delegatedReviewPolicy: 'explicit-build-delegation-only';
  readonly companionAccess: AgentWorkspaceCompanionAccessSummary;
  readonly channels: readonly AgentWorkspaceChannelStatus[];
  readonly channelSetupGuide: AgentWorkspaceChannelSetupGuide;
  readonly voiceProviderCount: number;
  readonly voiceStreamingProviderCount: number;
  readonly voiceSttProviderCount: number;
  readonly voiceRealtimeProviderCount: number;
  readonly ttsProvider: string;
  readonly ttsVoice: string;
  readonly ttsResponseModel: string;
  readonly voiceSurfaceEnabled: boolean;
  readonly mediaProviderCount: number;
  readonly mediaUnderstandingProviderCount: number;
  readonly mediaGenerationProviderCount: number;
  readonly voiceMediaReadiness: AgentWorkspaceVoiceMediaReadiness;
  readonly mcpServerCount: number;
  readonly mcpConnectedServerCount: number;
  readonly mcpQuarantinedServerCount: number;
  readonly mcpAllowAllServerCount: number;
  readonly browserToolExposureEnabled: boolean;
  readonly browserToolPublicBaseUrl: string;
  readonly activeRuntimeProfile: string;
  readonly selectedRuntimeProfile: string | null;
  readonly selectedRuntimeProfileExists: boolean;
  readonly selectedRuntimeProfileSelectedAt: string | null;
  readonly runtimeProfileCount: number;
  readonly runtimeProfiles: readonly AgentWorkspaceRuntimeProfileItem[];
  readonly runtimeProfileRoot: string;
  readonly runtimeStarterTemplateCount: number;
  readonly localStarterTemplateCount: number;
  readonly runtimeStarterTemplates: readonly AgentWorkspaceRuntimeStarterTemplateItem[];
  readonly setupChecklist: readonly AgentWorkspaceSetupChecklistItem[];
  readonly setupWizard: AgentSetupWizard;
  readonly warnings: readonly string[];
  /**
   * True when the most recent render-path attempt to re-derive the live
   * counters (memory count, routine counts + start counts) failed
   * and the previous values below had to be kept. A fresh
   * buildAgentWorkspaceRuntimeSnapshot() call is never stale (it just read
   * everything); this only flips true from
   * AgentWorkspace.syncLiveCountersForRender() when a live re-read errors.
   * The render path uses this to label the counters honestly ("refreshing")
   * instead of asserting a number the disk might already contradict.
   */
  readonly liveCountersStale: boolean;
  /** Honest email-connect status for the connect wizard's entry state. Null when unavailable in this runtime. */
  readonly emailConnectStatus: AgentWorkspaceEmailConnectStatus | null;
  readonly calendarOAuthConfigStatus: { readonly google: boolean; readonly microsoft: boolean } | null; // F1c: per-provider client-id-configured state for the advanced cards
}
