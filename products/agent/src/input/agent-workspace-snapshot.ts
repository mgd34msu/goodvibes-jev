import { readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { basename, sep } from 'node:path';
import type { CommandContext } from './command-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { memoryRecordTemporalStatus } from '@goodvibes-jev/engine/sdk/platform/state';
import { describeMemoryPromptEligibility, isPromptActiveMemory } from '../agent/memory-prompt.ts';
import { summarizeAgentBehaviorDiscovery } from '../agent/behavior-discovery-summary.ts';
import { buildSetupWizardDurableReceipts } from '../agent/setup-wizard-artifact-receipts.ts';
import { mergeSetupWizardDurableReceipts, setupWizardLiveDurableReceipts } from './setup-wizard-live-receipts.ts';
import { buildAgentWorkspaceChannelSetupGuide, buildAgentWorkspaceChannels } from './agent-workspace-channels.ts';
import { buildAgentWorkspaceSetupChecklist } from './agent-workspace-setup.ts';
import { buildAgentWorkspaceVoiceMediaReadiness } from './agent-workspace-voice-media.ts';
import { buildProcessSupervisionSummary, buildProjectContextSummary, buildPromptContextReceiptTimeline, buildResearchBrowserRunnerContract, buildResearchVisualReportContract, buildVibeSummary } from './agent-workspace-context-snapshot.ts';
import { summarizeMemoryItem, summarizeRoutineItem, summarizeRuntimeProfile, summarizeStarterTemplate } from './agent-workspace-local-library-snapshot.ts';
import { buildReviewPacketDefaults, buildReviewPacketTimeline, buildReviewPacketWizard, readDocumentDrafts, reviewerReadinessBadge } from './agent-workspace-review-packet-snapshot.ts';
import { buildSetupSmokeHistory, buildSetupWizardCheckpoint, buildWorkspaceSetupWizard, setupCompletionMarkerExists } from './agent-workspace-setup-snapshot.ts';
import { readConfigNumber, readConfigString } from './agent-workspace-snapshot-config.ts';
import {
  buildAgentWorkspaceArtifactListSnapshot,
  buildAgentWorkspaceCalendarOAuthConfigStatus,
  buildAgentWorkspaceCompanionAccessSnapshot,
  buildAgentWorkspaceConfigSettingsSnapshot,
  buildAgentWorkspaceCurrentModelSnapshot,
  buildAgentWorkspaceEmailConnectStatus,
  buildAgentWorkspaceMcpServerSnapshot,
  buildAgentWorkspaceNoteSnapshot,
  buildAgentWorkspacePersonaSnapshot,
  buildAgentWorkspaceRecentReviewerHandoffsSnapshot,
  buildAgentWorkspaceResearchRunSnapshot,
  buildAgentWorkspaceResearchSourceSnapshot,
  buildAgentWorkspaceRoutineScheduleReceiptsSnapshot,
  buildAgentWorkspaceRuntimeProfilesSnapshot,
  buildAgentWorkspaceSessionMemoryCount,
  buildAgentWorkspaceSkillSnapshot,
  buildAgentWorkspaceSubscriptionSnapshot,
  buildAgentWorkspaceVoiceMediaProvidersSnapshot,
} from './agent-workspace-snapshot-builders.ts';
import type { AgentWorkspaceLocalLibraryItem, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';

// Re-exported so this module's public surface still carries this builder,
// whose body now lives in agent-workspace-snapshot-builders.ts.
export { buildAgentWorkspaceEmailConnectStatus } from './agent-workspace-snapshot-builders.ts';

function inferActiveRuntimeProfile(homeDirectory: string): string {
  const marker = `${sep}.goodvibes${sep}agent${sep}profile-homes${sep}`;
  return homeDirectory.includes(marker) ? basename(homeDirectory) : '(default home)';
}

function inferRuntimeProfileBaseHome(homeDirectory: string): string {
  const marker = `${sep}.goodvibes${sep}agent${sep}profile-homes${sep}`;
  const markerIndex = homeDirectory.indexOf(marker);
  return markerIndex >= 0 ? homeDirectory.slice(0, markerIndex) : homeDirectory;
}

export interface AgentWorkspaceLiveMemoryCounters {
  readonly count: number;
  readonly reviewQueueCount: number;
  readonly promptActiveCount: number;
  /** Stored but not yet valid (now < validFrom). Still counted in `count`. */
  readonly temporallyPendingCount: number;
  /** Stored but past validUntil. Still counted in `count`, never deleted. */
  readonly temporallyExpiredCount: number;
  readonly items: readonly AgentWorkspaceLocalLibraryItem[];
}

/**
 * Reads the Agent memory count + items directly from the live memory API
 * (no caching). Throws if the read itself fails (e.g. the memory API errors
 * mid-call) rather than swallowing it, callers that need a best-effort,
 * never-throws default (the full runtime snapshot builder below) should use
 * buildAgentWorkspaceMemorySnapshot instead. The render-path live-counter
 * refresh (AgentWorkspace.syncLiveCountersForRender) calls this
 * directly so a genuine read failure can be surfaced as "stale" instead of
 * being silently rewritten to a fabricated 0.
 *
 * NOTE (observability flag): these live process/state counters are
 * flagged as observability-shaped content whose eventual surface home is the
 * fleet/observability layer, not this admin-console snapshot builder. Nothing
 * moves today (no observability layer exists yet); this function is kept
 * intact and separate rather than folded into the sibling sub-builders in
 * agent-workspace-snapshot-builders.ts extracted alongside it.
 */
export function readLiveAgentMemoryCounters(context: CommandContext): AgentWorkspaceLiveMemoryCounters {
  const memory = context.clients?.agentKnowledgeApi?.memory;
  if (!memory) {
    return { count: 0, reviewQueueCount: 0, promptActiveCount: 0, temporallyPendingCount: 0, temporallyExpiredCount: 0, items: [] };
  }
  const records = [...memory.getAll()].sort((left, right) => right.updatedAt - left.updatedAt);
  let temporallyPendingCount = 0;
  let temporallyExpiredCount = 0;
  for (const record of records) {
    const temporalStatus = memoryRecordTemporalStatus(record);
    if (temporalStatus === 'pending') temporallyPendingCount += 1;
    else if (temporalStatus === 'expired') temporallyExpiredCount += 1;
  }
  return {
    count: records.length,
    // The public review queue ranks all retrieved records without filtering.
    // Its capped cardinality is known locally; a repaint must not launch readings.
    reviewQueueCount: Math.min(records.length, 100),
    // Bound to one arg, a bare `.filter(isPromptActiveMemory)` leaks the
    // array index in as Array.filter's second (index) argument, which lands
    // in isPromptActiveMemory's `now` param and silently breaks the
    // temporal-validity check for every record past index 0.
    promptActiveCount: records.filter((record) => isPromptActiveMemory(record)).length,
    temporallyPendingCount,
    temporallyExpiredCount,
    // Each item carries the honest, per-record eligibility reason straight from
    // describeMemoryPromptEligibility, the same wording source
    // prompt-context-receipts.ts and agent-harness-prompt-context.ts use for prompt
    // recall. No locally invented "not reviewed"/"outside prompt limit" paraphrase here.
    items: records.map((record) => ({
      ...summarizeMemoryItem(record),
      promptEligible: isPromptActiveMemory(record),
      promptEligibilityReason: describeMemoryPromptEligibility(record).reason,
    })),
  };
}

/**
 * Best-effort variant of readLiveAgentMemoryCounters for the full runtime
 * snapshot builder: never throws, defaults to empty on any read failure.
 */
export function buildAgentWorkspaceMemorySnapshot(context: CommandContext): AgentWorkspaceLiveMemoryCounters {
  try {
    return readLiveAgentMemoryCounters(context);
  } catch {
    return { count: 0, reviewQueueCount: 0, promptActiveCount: 0, temporallyPendingCount: 0, temporallyExpiredCount: 0, items: [] };
  }
}

export interface AgentWorkspaceLiveRoutineCounters {
  readonly count: number;
  readonly enabled: number;
  readonly items: readonly AgentWorkspaceLocalLibraryItem[];
}

/**
 * Reads the Agent routine count + items (including each routine's live
 * startCount) directly from the on-disk routine store (no caching). Throws
 * if the store read fails (e.g. a corrupt/unreadable routines.json,
 * AgentRoutineRegistry.snapshot() itself throws in that case) rather than
 * swallowing it; see readLiveAgentMemoryCounters above for why the
 * render-path live-counter refresh wants that.
 *
 * NOTE (observability flag): see readLiveAgentMemoryCounters above,
 * the same flag applies to these routine counters.
 */
export function readLiveAgentRoutineCounters(context: CommandContext): AgentWorkspaceLiveRoutineCounters {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return { count: 0, enabled: 0, items: [] };
  const snapshot = AgentRoutineRegistry.fromShellPaths(shellPaths).snapshot();
  return {
    count: snapshot.routines.length,
    enabled: snapshot.enabledRoutines.length,
    items: snapshot.routines.map(summarizeRoutineItem),
  };
}

/**
 * Best-effort variant of readLiveAgentRoutineCounters for the full runtime
 * snapshot builder: never throws, defaults to empty on any read failure.
 */
export function buildAgentWorkspaceRoutineCounters(context: CommandContext): AgentWorkspaceLiveRoutineCounters {
  try {
    return readLiveAgentRoutineCounters(context);
  } catch {
    return { count: 0, enabled: 0, items: [] };
  }
}

/**
 * Assembles the full Agent workspace runtime snapshot. Composes the
 * sub-builders in agent-workspace-snapshot-builders.ts (split out of what
 * was previously one ~516-line function) plus the two live-counter builders
 * above, then maps everything onto the AgentWorkspaceRuntimeSnapshot shape.
 */
export function buildAgentWorkspaceRuntimeSnapshot(context: CommandContext): AgentWorkspaceRuntimeSnapshot {
  const host = readConfigString(context, 'controlPlane.host', '127.0.0.1');
  const port = readConfigNumber(context, 'controlPlane.port', 3421);
  const model = context.session?.runtime?.model ?? 'unknown';
  const provider = context.session?.runtime?.provider ?? 'unknown';
  const currentModel = buildAgentWorkspaceCurrentModelSnapshot(context);
  const sessionMemoryCount = buildAgentWorkspaceSessionMemoryCount(context);
  const memorySnapshot = buildAgentWorkspaceMemorySnapshot(context);
  const personaSnapshot = buildAgentWorkspacePersonaSnapshot(context);
  const noteSnapshot = buildAgentWorkspaceNoteSnapshot(context);
  const skillSnapshot = buildAgentWorkspaceSkillSnapshot(context);
  const routineSnapshot = buildAgentWorkspaceRoutineCounters(context);
  const routineScheduleReceipts = buildAgentWorkspaceRoutineScheduleReceiptsSnapshot(context);
  const researchSourceSnapshot = buildAgentWorkspaceResearchSourceSnapshot(context);
  const researchRunSnapshot = buildAgentWorkspaceResearchRunSnapshot(context);
  const artifactListSnapshot = buildAgentWorkspaceArtifactListSnapshot(context);
  const setupSmokeHistory = buildSetupSmokeHistory(artifactListSnapshot.items, artifactListSnapshot.available);
  const durableSetupReceipts = mergeSetupWizardDurableReceipts(
    buildSetupWizardDurableReceipts(artifactListSnapshot.items),
    setupWizardLiveDurableReceipts(context),
  );
  const recentReviewerHandoffs = buildAgentWorkspaceRecentReviewerHandoffsSnapshot(artifactListSnapshot.items);
  const documentDrafts = readDocumentDrafts(context);
  const reviewerBadge = reviewerReadinessBadge(
    documentDrafts,
    artifactListSnapshot.items,
    artifactListSnapshot.available,
  );
  const reviewPacketTimeline = buildReviewPacketTimeline(
    documentDrafts,
    artifactListSnapshot.items,
    artifactListSnapshot.available,
  );
  const reviewPacketDefaults = buildReviewPacketDefaults(
    documentDrafts,
    artifactListSnapshot.items,
  );
  const reviewPacketWizard = buildReviewPacketWizard(
    documentDrafts,
    artifactListSnapshot.available,
    reviewPacketDefaults,
  );
  const discoveredBehavior = summarizeAgentBehaviorDiscovery(context.workspace?.shellPaths);
  const profileBaseHome = inferRuntimeProfileBaseHome(context.workspace?.shellPaths?.homeDirectory ?? '');
  const { runtimeProfiles, runtimeStarterTemplates, selectedRuntimeProfile, runtimeProfileRoot } = buildAgentWorkspaceRuntimeProfilesSnapshot(profileBaseHome);
  const { voiceProviders, mediaProviders } = buildAgentWorkspaceVoiceMediaProvidersSnapshot(context);
  const mcpSnapshot = buildAgentWorkspaceMcpServerSnapshot(context);
  const voiceProviderDescriptors = voiceProviders.map((provider) => ({
    id: provider.id,
    label: provider.label,
    capabilities: provider.capabilities,
  }));
  const mediaProviderDescriptors = mediaProviders.map((provider) => ({
    id: provider.id,
    label: provider.label,
    capabilities: provider.capabilities,
  }));
  const warnings: string[] = [];
  if (provider === 'unknown' || model === 'unknown') warnings.push('Provider/model unavailable in this runtime context.');
  if (!context.executeCommand) warnings.push('Command dispatch is unavailable; workspace actions will show guidance only.');
  const config = buildAgentWorkspaceConfigSettingsSnapshot(context);
  const runtimeBaseUrl = connectedHostBaseUrl(host, port);
  const companionAccess = buildAgentWorkspaceCompanionAccessSnapshot(context, runtimeBaseUrl);
  const subscriptionSnapshot = buildAgentWorkspaceSubscriptionSnapshot(context);
  const channels = buildAgentWorkspaceChannels(context);
  const channelSetupGuide = buildAgentWorkspaceChannelSetupGuide(channels);
  const voiceMediaReadiness = buildAgentWorkspaceVoiceMediaReadiness({
    context,
    voiceProviders: voiceProviderDescriptors,
    mediaProviders: mediaProviderDescriptors,
  });
  const homeDirectory = context.workspace?.shellPaths?.homeDirectory;
  const nativeCredential = homeDirectory
    ? readConnectedHostOperatorToken(homeDirectory, runtimeBaseUrl)
    : { present: false, token: null, path: '(Agent home unavailable)', error: undefined };
  const setupChecklist = buildAgentWorkspaceSetupChecklist({
    provider,
    model,
    runtimeBaseUrl,
    connectedHostTokenPresent: nativeCredential.present,
    connectedHostTokenReadable: Boolean(nativeCredential.token),
    connectedHostTokenPath: nativeCredential.path,
    connectedHostTokenError: nativeCredential.error,
    activeSubscriptionCount: subscriptionSnapshot.active,
    pendingSubscriptionCount: subscriptionSnapshot.pending,
    availableSubscriptionProviderCount: subscriptionSnapshot.available,
    sessionMemoryCount,
    localMemoryCount: memorySnapshot.count,
    localMemoryReviewQueueCount: memorySnapshot.reviewQueueCount,
    localNoteCount: noteSnapshot.count,
    localNoteReviewQueueCount: noteSnapshot.reviewQueueCount,
    routineCount: routineSnapshot.count,
    enabledRoutineCount: routineSnapshot.enabled,
    missingRoutineRequirementCount: routineSnapshot.items.reduce((total, item) => total + (item.missingRequirementCount ?? 0), 0),
    skillCount: skillSnapshot.count,
    enabledSkillCount: skillSnapshot.enabled,
    skillBundleCount: skillSnapshot.bundleCount,
    enabledSkillBundleCount: skillSnapshot.enabledBundleCount,
    missingSkillRequirementCount: skillSnapshot.items.reduce((total, item) => total + (item.missingRequirementCount ?? 0), 0),
    activePersonaName: personaSnapshot.activeName,
    discoveredPersonas: discoveredBehavior.personas,
    discoveredSkills: discoveredBehavior.skills,
    discoveredRoutines: discoveredBehavior.routines,
    readyChannelCount: channels.filter((channel) => channel.ready).length,
    voiceProviderCount: voiceProviders.length,
    mediaProviderCount: mediaProviders.length,
    runtimeProfileCount: runtimeProfiles.length,
    runtimeStarterTemplateCount: runtimeStarterTemplates.length,
  });
  const setupWizard = buildWorkspaceSetupWizard(
    setupChecklist,
    setupSmokeHistory,
    buildSetupWizardCheckpoint(context),
    setupCompletionMarkerExists(context),
    durableSetupReceipts,
  );
  const researchBrowserRunnerContract = buildResearchBrowserRunnerContract(context);
  const researchVisualReportContract = buildResearchVisualReportContract(researchSourceSnapshot);
  const vibe = buildVibeSummary(context);
  const projectContext = buildProjectContextSummary(context);
  const promptContextReceipts = buildPromptContextReceiptTimeline(context);
  const processSupervision = buildProcessSupervisionSummary(context);

  return {
    provider,
    model,
    modelDisplayName: currentModel?.displayName ?? model,
    embeddingProvider: config.embeddingProvider,
    reasoningEffort: config.reasoningEffort,
    helperEnabled: config.helperEnabled,
    toolLlmEnabled: config.toolLlmEnabled,
    providerFailureHints: config.providerFailureHints,
    cacheEnabled: config.cacheEnabled,
    cacheStableTtl: config.cacheStableTtl,
    cacheMonitorHitRate: config.cacheMonitorHitRate,
    cacheHitRateWarningThreshold: config.cacheHitRateWarningThreshold,
    hitlMode: config.hitlMode,
    guidanceMode: config.guidanceMode,
    saveHistory: config.saveHistory,
    autoApprove: config.autoApprove,
    autoCompactThreshold: config.autoCompactThreshold,
    staleContextWarnings: config.staleContextWarnings,
    showThinking: config.showThinking,
    showReasoningSummary: config.showReasoningSummary,
    theme: config.theme,
    stream: config.stream,
    lineNumbers: config.lineNumbers,
    operationalMessages: config.operationalMessages,
    systemMessages: config.systemMessages,
    releaseChannel: config.releaseChannel,
    permissionMode: config.permissionMode,
    toolAutoHeal: config.toolAutoHeal,
    toolsDefaultTokenBudget: config.toolsDefaultTokenBudget,
    artifactMaxBytes: config.artifactMaxBytes,
    rawPromptTelemetry: config.rawPromptTelemetry,
    automationEnabled: config.automationEnabled,
    automationMaxConcurrentRuns: config.automationMaxConcurrentRuns,
    automationRunHistoryLimit: config.automationRunHistoryLimit,
    automationDefaultTimeoutMs: config.automationDefaultTimeoutMs,
    automationCatchUpWindowMinutes: config.automationCatchUpWindowMinutes,
    automationFailureCooldownMs: config.automationFailureCooldownMs,
    automationDeleteAfterRun: config.automationDeleteAfterRun,
    sessionId: context.session?.runtime?.sessionId ?? 'unknown',
    workingDirectory: context.workspace?.shellPaths?.workingDirectory ?? 'unavailable',
    homeDirectory: context.workspace?.shellPaths?.homeDirectory ?? 'unavailable',
    runtimeBaseUrl,
    runtimeOwnership: 'external',
    activeSubscriptionCount: subscriptionSnapshot.active,
    pendingSubscriptionCount: subscriptionSnapshot.pending,
    availableSubscriptionProviderCount: subscriptionSnapshot.available,
    sessionMemoryCount,
    localMemoryCount: memorySnapshot.count,
    localMemoryReviewQueueCount: memorySnapshot.reviewQueueCount,
    localMemoryPromptActiveCount: memorySnapshot.promptActiveCount,
    localMemoryTemporallyPendingCount: memorySnapshot.temporallyPendingCount,
    localMemoryTemporallyExpiredCount: memorySnapshot.temporallyExpiredCount,
    localMemories: memorySnapshot.items,
    localNoteCount: noteSnapshot.count,
    localNoteReviewQueueCount: noteSnapshot.reviewQueueCount,
    localNotes: noteSnapshot.items,
    researchSourceCount: researchSourceSnapshot.count,
    researchSourceCandidateCount: researchSourceSnapshot.candidate,
    researchSourceReviewedCount: researchSourceSnapshot.reviewed,
    researchSourceRejectedCount: researchSourceSnapshot.rejected,
    researchSourceUsedCount: researchSourceSnapshot.used,
    researchRunCount: researchRunSnapshot.count,
    researchRunPlannedCount: researchRunSnapshot.planned,
    researchRunRunningCount: researchRunSnapshot.running,
    researchRunPausedCount: researchRunSnapshot.paused,
    researchRunBlockedCount: researchRunSnapshot.blocked,
    researchRunTerminalCount: researchRunSnapshot.terminal,
    researchRuns: researchRunSnapshot.items,
    researchBrowserRunnerContract,
    researchVisualReportContract,
    vibe,
    projectContext,
    promptContextReceipts,
    processSupervision,
    recentReviewerHandoffArtifactCount: recentReviewerHandoffs.count,
    recentReviewerHandoffArtifacts: recentReviewerHandoffs.items,
    reviewerReadinessBadge: reviewerBadge,
    reviewPacketTimeline,
    reviewPacketDefaults,
    reviewPacketWizard,
    localRoutineCount: routineSnapshot.count,
    enabledRoutineCount: routineSnapshot.enabled,
    localRoutines: routineSnapshot.items,
    routineScheduleReceiptCount: routineScheduleReceipts.count,
    successfulRoutineScheduleReceiptCount: routineScheduleReceipts.successful,
    failedRoutineScheduleReceiptCount: routineScheduleReceipts.failed,
    latestRoutineScheduleReceipt: routineScheduleReceipts.latest,
    localSkillCount: skillSnapshot.count,
    enabledSkillCount: skillSnapshot.enabled,
    localSkillBundleCount: skillSnapshot.bundleCount,
    enabledSkillBundleCount: skillSnapshot.enabledBundleCount,
    activeSkillCount: skillSnapshot.active,
    localSkillBundles: skillSnapshot.bundleItems,
    localSkills: skillSnapshot.items,
    localPersonaCount: personaSnapshot.count,
    activePersonaName: personaSnapshot.activeName,
    localPersonas: personaSnapshot.items,
    discoveredBehavior,
    knowledgeRoute: '/api/goodvibes-agent/knowledge',
    knowledgeIsolation: 'agent-only',
    executionPolicy: 'serial-proactive',
    delegatedReviewPolicy: 'explicit-build-delegation-only',
    companionAccess,
    channels,
    channelSetupGuide,
    voiceProviderCount: voiceProviders.length,
    voiceStreamingProviderCount: voiceProviders.filter((entry) => entry.capabilities.includes('tts-stream')).length,
    voiceSttProviderCount: voiceProviders.filter((entry) => entry.capabilities.includes('stt')).length,
    voiceRealtimeProviderCount: voiceProviders.filter((entry) => entry.capabilities.includes('realtime')).length,
    ttsProvider: config.ttsProvider,
    ttsVoice: config.ttsVoice,
    ttsResponseModel: config.ttsLlmProvider && config.ttsLlmModel ? `${config.ttsLlmProvider}/${config.ttsLlmModel}` : '(chat route)',
    voiceSurfaceEnabled: config.voiceSurfaceEnabled,
    mediaProviderCount: mediaProviders.length,
    mediaUnderstandingProviderCount: mediaProviders.filter((entry) => entry.capabilities.includes('understand')).length,
    mediaGenerationProviderCount: mediaProviders.filter((entry) => entry.capabilities.includes('generate')).length,
    voiceMediaReadiness,
    mcpServerCount: mcpSnapshot.serverCount,
    mcpConnectedServerCount: mcpSnapshot.connectedCount,
    mcpQuarantinedServerCount: mcpSnapshot.quarantinedCount,
    mcpAllowAllServerCount: mcpSnapshot.allowAllCount,
    browserToolExposureEnabled: config.browserPwaEnabled,
    browserToolPublicBaseUrl: config.browserPwaPublicBaseUrl,
    activeRuntimeProfile: inferActiveRuntimeProfile(context.workspace?.shellPaths?.homeDirectory ?? ''),
    selectedRuntimeProfile: selectedRuntimeProfile?.id ?? null,
    selectedRuntimeProfileExists: selectedRuntimeProfile?.exists ?? false,
    selectedRuntimeProfileSelectedAt: selectedRuntimeProfile?.selectedAt ?? null,
    runtimeProfileCount: runtimeProfiles.length,
    runtimeProfiles: runtimeProfiles.map(summarizeRuntimeProfile),
    runtimeProfileRoot,
    runtimeStarterTemplateCount: runtimeStarterTemplates.length,
    localStarterTemplateCount: runtimeStarterTemplates.filter((template) => template.source === 'local').length,
    runtimeStarterTemplates: runtimeStarterTemplates.map(summarizeStarterTemplate),
    setupChecklist,
    setupWizard,
    warnings,
    liveCountersStale: false,
    emailConnectStatus: buildAgentWorkspaceEmailConnectStatus(context),
    calendarOAuthConfigStatus: buildAgentWorkspaceCalendarOAuthConfigStatus(context),
  };
}
