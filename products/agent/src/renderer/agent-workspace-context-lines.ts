import type { AgentWorkspace, AgentWorkspaceCategory, AgentWorkspaceLocalEditor, AgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace.ts';
import { buildAssistantCockpitFromWorkspaceSnapshot, type AssistantCockpitLane, type AssistantCockpitLaneState, type AssistantCockpitStatus } from '../agent/assistant-cockpit.ts';
import { formatAgentRecordReviewState } from '../agent/record-labels.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { WORKSPACE_PALETTE as PALETTE } from './fullscreen-workspace.ts';
import { setupStatusColor, type AgentWorkspaceContextLine as ContextLine } from './agent-workspace-style.ts';
function setupCounts(snapshot: AgentWorkspaceRuntimeSnapshot): { ready: number; recommended: number; optional: number; blocked: number } {
  return {
    ready: snapshot.setupChecklist.filter((item) => item.status === 'ready').length,
    recommended: snapshot.setupChecklist.filter((item) => item.status === 'recommended').length,
    optional: snapshot.setupChecklist.filter((item) => item.status === 'optional').length,
    blocked: snapshot.setupChecklist.filter((item) => item.status === 'blocked').length,
  };
}

function setupStatusLabel(status: AgentWorkspaceRuntimeSnapshot['setupChecklist'][number]['status']): string {
  return status === 'ready'
    ? 'Ready'
    : status === 'recommended'
      ? 'Recommended'
      : status === 'blocked'
        ? 'Blocked'
        : 'Optional';
}

function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// The memory/routine counts below are re-derived live on every
// repaint (AgentWorkspace.syncLiveCountersForRender). If that live read
// fails, liveCountersStale flags it so we say so instead of asserting a
// number the disk might already contradict.
function liveCounterStaleSuffix(snapshot: AgentWorkspaceRuntimeSnapshot): string {
  return snapshot.liveCountersStale ? ' (refreshing...)' : '';
}

export function compactText(text: string, maxWidth = 104): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return '';
  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  const source = firstSentence && firstSentence.length <= maxWidth ? firstSentence : normalized;
  return truncateDisplay(source, maxWidth, '...');
}

function setupAttentionItems(snapshot: AgentWorkspaceRuntimeSnapshot, limit: number): AgentWorkspaceRuntimeSnapshot['setupChecklist'] {
  return [
    ...snapshot.setupChecklist.filter((item) => item.status === 'blocked'),
    ...snapshot.setupChecklist.filter((item) => item.status === 'recommended'),
    ...snapshot.setupChecklist.filter((item) => item.status === 'optional'),
  ].slice(0, limit);
}

function setupOverviewLines(snapshot: AgentWorkspaceRuntimeSnapshot): ContextLine[] {
  const counts = setupCounts(snapshot);
  const attentionItems = setupAttentionItems(snapshot, 1);
  const doneCount = counts.ready;
  const totalCount = snapshot.setupChecklist.length;
  const attentionCount = counts.blocked + counts.recommended;
  const progressDetail = attentionCount > 0
    ? `${doneCount} of ${totalCount} done, ${attentionCount} need attention`
    : `${doneCount} of ${totalCount} done`;
  const lines: ContextLine[] = [
    { text: 'Onboarding', fg: PALETTE.title, bold: true },
    { text: progressDetail, fg: counts.blocked > 0 ? PALETTE.warn : doneCount === totalCount ? PALETTE.good : PALETTE.info },
    { text: `Chat: ${snapshot.provider} / ${snapshot.modelDisplayName}.`, fg: PALETTE.info },
    { text: `Local: ${snapshot.localPersonaCount} personas, ${snapshot.localSkillCount} skills, ${snapshot.localRoutineCount} routines, ${snapshot.localMemoryCount} memories.`, fg: PALETTE.info },
  ];
  if (attentionItems.length > 0) {
    const item = attentionItems[0]!;
    lines.push({
      text: `Next: ${item.label} (${setupStatusLabel(item.status).toLowerCase()})`,
      fg: setupStatusColor(item.status),
      bold: item.status === 'blocked',
    });
  }
  return lines;
}

function cockpitStatusColor(status: AssistantCockpitStatus): string {
  return status === 'attention' ? PALETTE.warn : status === 'ready-with-optional-setup' ? PALETTE.info : PALETTE.good;
}

function cockpitLaneColor(state: AssistantCockpitLaneState): string {
  return state === 'attention' ? PALETTE.warn : state === 'setup' ? PALETTE.info : PALETTE.good;
}

function cockpitLaneLine(lane: AssistantCockpitLane): ContextLine {
  const state = lane.state === 'attention' ? 'Attention' : lane.state === 'setup' ? 'Setup' : 'Ready';
  return {
    text: `${state}: ${lane.label} - ${compactText(lane.summary, 40)}`,
    fg: cockpitLaneColor(lane.state),
    bold: lane.state === 'attention',
  };
}

function homeAssistantCockpitLines(snapshot: AgentWorkspaceRuntimeSnapshot): ContextLine[] {
  const cockpit = buildAssistantCockpitFromWorkspaceSnapshot(snapshot);
  return [
    {
      text: `Assistant: ${cockpit.status}; chat route ${snapshot.provider} / ${snapshot.modelDisplayName}.`,
      fg: cockpitStatusColor(cockpit.status),
      bold: cockpit.status === 'attention',
    },
    {
      text: `Next: ${compactText(cockpit.primaryNextAction, 86)}`,
      fg: cockpitStatusColor(cockpit.status),
      bold: cockpit.status === 'attention',
    },
    ...cockpit.lanes.map(cockpitLaneLine),
  ];
}

function companionAccessLine(snapshot: AgentWorkspaceRuntimeSnapshot): ContextLine {
  const access = snapshot.companionAccess;
  const tokenState = access.tokenReadable
    ? `ready sha256:${access.tokenFingerprint ?? 'unknown'}`
    : access.tokenPresent
      ? 'present but unreadable'
      : 'missing';
  const error = access.tokenError ? `; token read error ${access.tokenError}` : '';
  return {
    text: `Companion: ${access.surface}; token ${tokenState}; QR ${access.qrCommand}${error}.`,
    fg: access.pairingReady ? PALETTE.good : PALETTE.warn,
  };
}

function compactLocalLibraryLines(
  title: string,
  items: readonly AgentWorkspaceRuntimeSnapshot['localPersonas'][number][],
  emptyText: string,
  selectedId: string | null,
): ContextLine[] {
  const lines: ContextLine[] = [];
  if (items.length === 0) {
    lines.push({ text: `${title}: 0. ${emptyText}`, fg: PALETTE.warn });
    return lines;
  }
  const selected = items.find((item) => item.id === selectedId) ?? items[0]!;
  const status = [
    selected.active ? 'active' : '',
    selected.enabled === true ? 'enabled' : selected.enabled === false ? 'disabled' : '',
    selected.scope && selected.cls ? `${selected.scope}/${selected.cls}` : '',
    selected.confidence !== undefined ? `${selected.confidence}%` : '',
    selected.requirementCount !== undefined && selected.requirementCount > 0
      ? (selected.missingRequirementCount && selected.missingRequirementCount > 0 ? `needs ${selected.missingRequirementCount}/${selected.requirementCount}` : `ready ${selected.requirementCount}/${selected.requirementCount}`)
      : '',
    formatAgentRecordReviewState(selected.reviewState),
    selected.startCount !== undefined ? `starts ${selected.startCount}` : '',
  ].filter(Boolean).join(', ');
  lines.push({
    text: `${title}: ${items.length}; selected ${selected.name}${status ? ` (${status})` : ''}.`,
    fg: selected.reviewState === 'stale' ? PALETTE.warn : PALETTE.info,
    bold: selected.active === true,
  });
  if (selected.missingRequirements && selected.missingRequirements.length > 0) {
    lines.push({ text: `Missing setup: ${selected.missingRequirements.join(', ')}`, fg: PALETTE.warn });
  }
  return lines;
}

type LocalRoutineItem = AgentWorkspaceRuntimeSnapshot['localRoutines'][number];

function readyRoutineItems(snapshot: AgentWorkspaceRuntimeSnapshot): readonly LocalRoutineItem[] {
  return snapshot.localRoutines.filter((routine) =>
    routine.enabled === true
    && routine.reviewState === 'reviewed'
    && (routine.missingRequirementCount ?? 0) === 0
  );
}

function routinesNeedingSetup(snapshot: AgentWorkspaceRuntimeSnapshot): readonly LocalRoutineItem[] {
  return snapshot.localRoutines.filter((routine) => (routine.missingRequirementCount ?? 0) > 0);
}

function routinesNeedingReview(snapshot: AgentWorkspaceRuntimeSnapshot): readonly LocalRoutineItem[] {
  return snapshot.localRoutines.filter((routine) => routine.reviewState !== 'reviewed');
}

function routineNextActionLine(snapshot: AgentWorkspaceRuntimeSnapshot): ContextLine {
  const discovered = snapshot.discoveredBehavior.routines.count;
  const ready = readyRoutineItems(snapshot);
  const needsSetup = routinesNeedingSetup(snapshot);
  const needsReview = routinesNeedingReview(snapshot);

  if (snapshot.localRoutineCount === 0 && discovered > 0) {
    return { text: 'Next routine action: Discover routine files, preview one, then import it from this workspace.', fg: PALETTE.warn, bold: true };
  }
  if (snapshot.localRoutineCount === 0) {
    return { text: 'Next routine action: Create routine for a repeatable main-conversation workflow.', fg: PALETTE.warn, bold: true };
  }
  if (needsSetup.length > 0) {
    return { text: `Next routine action: Needs setup for ${needsSetup[0]?.id ?? 'a routine'} before it can be trusted for schedule promotion.`, fg: PALETTE.warn, bold: true };
  }
  if (needsReview.length > 0) {
    return { text: `Next routine action: Review selected or inspect ${needsReview[0]?.id ?? 'a routine'} before schedule promotion.`, fg: PALETTE.warn, bold: true };
  }
  if (ready.length > 0 && snapshot.routineScheduleReceiptCount === 0) {
    return { text: `Next routine action: Promote ${ready[0]?.id ?? 'a reviewed routine'} to a connected schedule when you have a real cadence.`, fg: PALETTE.good, bold: true };
  }
  return { text: 'Next routine action: Start selected in the main conversation, inspect receipts, or reconcile connected schedules.', fg: PALETTE.info, bold: true };
}

function compactRoutineReceiptLine(snapshot: AgentWorkspaceRuntimeSnapshot): ContextLine {
  const latest = snapshot.latestRoutineScheduleReceipt;
  if (!latest) {
    return {
      text: `Promotion receipts: ${snapshot.routineScheduleReceiptCount}; none created yet.`,
      fg: PALETTE.muted,
    };
  }
  return {
    text: `Promotion receipts: ${snapshot.routineScheduleReceiptCount}; latest ${latest.status} ${latest.routineId}.`,
    fg: latest.status === 'failed' ? PALETTE.warn : PALETTE.good,
  };
}

function promptReceiptOutcomeColor(status: AgentWorkspaceRuntimeSnapshot['promptContextReceipts']['items'][number]['outcomeStatus']): string {
  if (status === 'completed') return PALETTE.good;
  if (status === 'error' || status === 'cancelled') return PALETTE.warn;
  return PALETTE.info;
}

function promptReceiptTimelineLines(snapshot: AgentWorkspaceRuntimeSnapshot): ContextLine[] {
  const timeline = snapshot.promptContextReceipts;
  if (timeline.status === 'unavailable') {
    return [
      { text: 'Prompt receipt timeline: unavailable in this runtime.', fg: PALETTE.warn },
      { text: `Next: ${compactText(timeline.next, 104)}`, fg: PALETTE.warn },
    ];
  }
  const lines: ContextLine[] = [
    {
      text: `Prompt receipt timeline: ${timeline.count} total; completed ${timeline.completedCount}; errors ${timeline.errorCount}; cancelled ${timeline.cancelledCount}; pending ${timeline.pendingCount}.`,
      fg: timeline.errorCount > 0 || timeline.cancelledCount > 0 ? PALETTE.warn : timeline.count > 0 ? PALETTE.good : PALETTE.muted,
      bold: timeline.errorCount > 0 || timeline.cancelledCount > 0,
    },
  ];
  const latest = timeline.items[0] ?? null;
  if (!latest) {
    lines.push({ text: `Next: ${compactText(timeline.next, 104)}`, fg: PALETTE.info });
    return lines;
  }
  const turnLabel = latest.turnId ?? 'manual/no-turn';
  const stop = latest.stopReason ? `; stop ${latest.stopReason}` : '';
  lines.push({
    text: `Latest prompt receipt: ${latest.outcomeStatus} turn ${turnLabel}; ${latest.activeRecords} applied / ${latest.suppressedRecords} suppressed; ${latest.approxPromptTokens} tokens${stop}.`,
    fg: promptReceiptOutcomeColor(latest.outcomeStatus),
    bold: latest.outcomeStatus === 'error' || latest.outcomeStatus === 'cancelled',
  });
  lines.push({ text: `Latest prompt receipt: ${latest.receiptId}; inspect it from Prompt context.`, fg: PALETTE.good });
  if (timeline.errorCount > 0) {
    lines.push({ text: 'Prompt receipt filter: show errors.', fg: PALETTE.warn });
  } else if (timeline.cancelledCount > 0) {
    lines.push({ text: 'Prompt receipt filter: show cancelled turns.', fg: PALETTE.warn });
  } else if (timeline.pendingCount > 0) {
    lines.push({ text: 'Prompt receipt filter: show pending turns.', fg: PALETTE.info });
  }
  for (const receipt of timeline.items.slice(0, 3)) {
    lines.push({
      text: `- ${receipt.receiptId}: ${receipt.outcomeStatus}; ${receipt.provider}/${receipt.model}; ${receipt.segmentCount} segment(s), ${receipt.activeRecords} active, ${receipt.suppressedRecords} suppressed.`,
      fg: promptReceiptOutcomeColor(receipt.outcomeStatus),
    });
  }
  if (latest.detail) {
    lines.push({ text: `Latest outcome detail: ${compactText(latest.detail, 104)}`, fg: PALETTE.warn });
  }
  lines.push({ text: 'Prompt context controls stay read-only from this setup page.', fg: PALETTE.good });
  return lines;
}

function automationNextActionLine(snapshot: AgentWorkspaceRuntimeSnapshot): ContextLine {
  const ready = readyRoutineItems(snapshot);
  const needsSetup = routinesNeedingSetup(snapshot);
  const needsReview = routinesNeedingReview(snapshot);
  if (snapshot.routineScheduleReceiptCount > 0) {
    return { text: 'Next automation action: Reconcile schedules to compare local receipts with the connected host.', fg: PALETTE.info, bold: true };
  }
  if (ready.length > 0) {
    return { text: `Next automation action: Promote ${ready[0]?.id ?? 'a reviewed routine'} or create a one-off reminder.`, fg: PALETTE.good, bold: true };
  }
  if (needsSetup.length > 0) {
    return { text: `Next automation action: Resolve routine setup gaps in ${needsSetup[0]?.id ?? 'Routines'} before promotion, or create a reminder.`, fg: PALETTE.warn, bold: true };
  }
  if (needsReview.length > 0) {
    return { text: `Next automation action: Review ${needsReview[0]?.id ?? 'a routine'} in Routines before schedule promotion, or create a reminder.`, fg: PALETTE.warn, bold: true };
  }
  return { text: 'Next automation action: Create a reminder, or create/import a routine before recurring workflow promotion.', fg: PALETTE.warn, bold: true };
}

function reviewerHandoffArtifactLine(snapshot: AgentWorkspaceRuntimeSnapshot): ContextLine {
  const recent = snapshot.recentReviewerHandoffArtifacts;
  if (recent.length >= 2) {
    const newer = recent[0]!;
    const older = recent[1]!;
    return {
      text: `Reviewer handoffs: ${snapshot.recentReviewerHandoffArtifactCount} saved; diff defaults ${older.id} -> ${newer.id}.`,
      fg: PALETTE.good,
    };
  }
  if (recent.length === 1) {
    return {
      text: `Reviewer handoffs: 1 saved (${recent[0]!.id}); create one more handoff or leave diff ids blank to list choices.`,
      fg: PALETTE.info,
    };
  }
  return {
    text: 'Reviewer handoffs: none saved yet; create a comparison handoff before diffing or archiving.',
    fg: PALETTE.muted,
  };
}

function reviewPacketTimelineStatusColor(status: AgentWorkspaceRuntimeSnapshot['reviewPacketTimeline']['items'][number]['status']): string {
  if (status === 'attention') return PALETTE.warn;
  if (status === 'ready' || status === 'complete') return PALETTE.good;
  return PALETTE.info;
}

function reviewPacketTimelineLines(snapshot: AgentWorkspaceRuntimeSnapshot): ContextLine[] {
  const timeline = snapshot.reviewPacketTimeline;
  if (timeline.items.length === 0) {
    return [
      {
        text: timeline.available
          ? 'Review packet timeline: no document, artifact, comparison, judgment, handoff, or archive events yet.'
          : 'Review packet timeline: artifact history unavailable; no document-local events yet.',
        fg: timeline.available ? PALETTE.muted : PALETTE.warn,
      },
      { text: `Packet next: ${compactText(timeline.next, 110)}`, fg: timeline.available ? PALETTE.info : PALETTE.warn },
    ];
  }
  const visible = timeline.items.slice(0, 3);
  return [
    {
      text: `Review packet timeline: ${timeline.count} event(s); showing ${visible.length} latest${timeline.available ? '' : '; artifacts unavailable'}.`,
      fg: timeline.available ? PALETTE.info : PALETTE.warn,
    },
    ...visible.map((event): ContextLine => ({
      text: `Packet ${event.kind}: ${compactText(`${event.label} - ${event.detail}`, 116)}`,
      fg: reviewPacketTimelineStatusColor(event.status),
      bold: event.status === 'attention',
    })),
    { text: `Packet next: ${compactText(timeline.next, 110)}`, fg: timeline.items.some((event) => event.status === 'attention') ? PALETTE.warn : PALETTE.good },
  ];
}

function reviewerReadinessBadgeColor(status: AgentWorkspaceRuntimeSnapshot['reviewerReadinessBadge']['status']): string {
  if (status === 'ready') return PALETTE.good;
  if (status === 'attention') return PALETTE.warn;
  return PALETTE.warn;
}

function reviewerReadinessBadgeLabel(status: AgentWorkspaceRuntimeSnapshot['reviewerReadinessBadge']['status']): string {
  if (status === 'ready') return 'ready';
  if (status === 'attention') return 'attention';
  return 'setup needed';
}

function researchContractColor(status: string): string {
  if (status === 'ready-with-confirmation' || status === 'visual-report-packet-ready') return PALETTE.good;
  if (status === 'needs-review') return PALETTE.warn;
  return PALETTE.info;
}

export function reviewerReadinessContextLines(editor: AgentWorkspaceLocalEditor, snapshot: AgentWorkspaceRuntimeSnapshot | null): ContextLine[] {
  if (!snapshot) return [];
  if (
    editor.kind !== 'document-export'
    && editor.kind !== 'model-compare-export'
    && editor.kind !== 'model-compare-apply'
  ) {
    return [];
  }
  const badge = snapshot.reviewerReadinessBadge;
  const reportKind = editor.kind === 'model-compare-export'
    ? editor.fields.find((field) => field.id === 'reportKind')?.value.trim().toLowerCase()
    : '';
  const scope = editor.kind === 'document-export'
    ? 'Document export'
    : editor.kind === 'model-compare-apply'
      ? 'Route apply'
      : reportKind === 'archive' || reportKind === 'handoffarchive'
        ? 'Handoff archive'
        : reportKind === 'handoff'
          ? 'Reviewer handoff'
          : 'Compare export';
  return [
    {
      text: `${scope} readiness: ${reviewerReadinessBadgeLabel(badge.status)} - ${badge.summary}`,
      fg: reviewerReadinessBadgeColor(badge.status),
      bold: badge.status !== 'ready',
    },
    {
      text: `Preflight next: ${compactText(badge.next, 110)}`,
      fg: badge.status === 'ready' ? PALETTE.good : PALETTE.info,
    },
  ];
}

export function snapshotLines(workspace: AgentWorkspace, category: AgentWorkspaceCategory, snapshot: AgentWorkspaceRuntimeSnapshot | null): ContextLine[] {
  if (!snapshot) return [{ text: 'Runtime context is not loaded yet.', fg: PALETTE.warn }];
  const base: ContextLine[] = [];
  if (category.id === 'home') {
    base.push(
      ...homeAssistantCockpitLines(snapshot),
    );
  } else if (category.id === 'setup') {
    base.push(
      ...setupOverviewLines(snapshot),
    );
  } else if (category.id === 'account-model') {
    base.push(
      { text: `Chat route: ${snapshot.provider} / ${snapshot.modelDisplayName}`, fg: PALETTE.info },
      { text: `Subscriptions: ${snapshot.activeSubscriptionCount} active; ${snapshot.pendingSubscriptionCount} pending; ${snapshot.availableSubscriptionProviderCount} available.`, fg: snapshot.activeSubscriptionCount > 0 ? PALETTE.good : snapshot.pendingSubscriptionCount > 0 ? PALETTE.warn : PALETTE.muted },
      { text: `Embedding: ${snapshot.embeddingProvider}; reasoning ${snapshot.reasoningEffort}.`, fg: PALETTE.info },
      { text: `Helper: ${snapshot.helperEnabled ? 'enabled' : 'disabled'}; Tool LLM: ${snapshot.toolLlmEnabled ? 'enabled' : 'disabled'}.`, fg: snapshot.helperEnabled || snapshot.toolLlmEnabled ? PALETTE.good : PALETTE.muted },
      { text: 'Route readiness: scores, missing signals, pinned state, and safe route keys via models action:"status".', fg: PALETTE.good },
      { text: 'Local cookbook: Ollama first, llama.cpp offline, vLLM for GPU throughput.', fg: PALETTE.good },
      { text: 'Local servers: endpoint map, model-list smoke checks, and refresh routes before benchmarks.', fg: PALETTE.good },
      { text: 'Benchmark evidence: run local compare, review saved judgments, then apply routes separately.', fg: PALETTE.info },
      { text: `Cache: ${snapshot.cacheEnabled ? snapshot.cacheStableTtl : 'off'}; monitor ${snapshot.cacheMonitorHitRate ? snapshot.cacheHitRateWarningThreshold : 'off'}; failure hints ${snapshot.providerFailureHints ? 'on' : 'off'}.`, fg: snapshot.cacheEnabled ? PALETTE.info : PALETTE.muted },
    );
  } else if (category.id === 'assistant-behavior') {
    base.push(
      { text: `Interaction: ${snapshot.hitlMode}; guidance ${snapshot.guidanceMode}; history ${snapshot.saveHistory ? 'saved' : 'off'}.`, fg: PALETTE.info },
      { text: `Context: compact at ${snapshot.autoCompactThreshold}; stale warnings ${snapshot.staleContextWarnings ? 'on' : 'off'}.`, fg: PALETTE.info },
      { text: `Reasoning display: thinking ${snapshot.showThinking ? 'on' : 'off'}; summaries ${snapshot.showReasoningSummary ? 'on' : 'off'}.`, fg: PALETTE.muted },
    );
  } else if (category.id === 'tools-permissions') {
    base.push(
      { text: `Permission mode: ${snapshot.permissionMode}.`, fg: snapshot.permissionMode === 'allow-all' ? PALETTE.warn : PALETTE.info },
      { text: `Auto-approve ${snapshot.autoApprove ? 'on' : 'off'}; tool auto-heal ${snapshot.toolAutoHeal ? 'on' : 'off'}; token budget ${snapshot.toolsDefaultTokenBudget}.`, fg: snapshot.autoApprove ? PALETTE.warn : PALETTE.info },
      { text: `Artifact limit ${formatMegabytes(snapshot.artifactMaxBytes)}; raw prompt telemetry ${snapshot.rawPromptTelemetry ? 'on' : 'off'}.`, fg: snapshot.rawPromptTelemetry ? PALETTE.warn : PALETTE.muted },
      { text: `MCP servers: ${snapshot.mcpConnectedServerCount}/${snapshot.mcpServerCount} connected; quarantined ${snapshot.mcpQuarantinedServerCount}.`, fg: snapshot.mcpQuarantinedServerCount > 0 ? PALETTE.warn : PALETTE.info },
      { text: 'MCP and secret setup use forms; selecting a row does not run arbitrary tools.', fg: PALETTE.good },
    );
  } else if (category.id === 'onboarding-display') {
    base.push(
      { text: `Theme: ${snapshot.theme}; streaming ${snapshot.stream ? 'on' : 'off'}; line numbers ${snapshot.lineNumbers}.`, fg: PALETTE.info },
      { text: `Messages: operational ${snapshot.operationalMessages}; system ${snapshot.systemMessages}.`, fg: PALETTE.info },
      { text: `Release channel: ${snapshot.releaseChannel}.`, fg: PALETTE.muted },
    );
  } else if (category.id === 'onboarding-channels') {
    const enabledCount = snapshot.channels.filter((channel) => channel.enabled).length;
    const readyCount = snapshot.channels.filter((channel) => channel.ready).length;
    const needsConfig = snapshot.channels.filter((channel) => channel.setupState === 'needs-config');
    const needsTarget = snapshot.channels.filter((channel) => channel.setupState === 'needs-target');
    const guide = snapshot.channelSetupGuide;
    base.push(
      { text: `Channels: ${readyCount}/${snapshot.channels.length} ready; ${enabledCount} enabled.`, fg: enabledCount > 0 ? PALETTE.info : PALETTE.muted },
      { text: `Needs config: ${needsConfig.length}; needs target: ${needsTarget.length}.`, fg: needsConfig.length > 0 || needsTarget.length > 0 ? PALETTE.warn : PALETTE.good },
      { text: `Setup guide: ${guide.progressLabel}; ${guide.currentChannelLabel ?? 'choose a channel'}.`, fg: guide.status === 'ready' ? PALETTE.good : PALETTE.warn },
      { text: 'Enable only the channels you want; hidden channel fields appear after the channel is enabled.', fg: PALETTE.good },
    );
  } else if (category.id === 'onboarding-voice-media') {
    const readiness = snapshot.voiceMediaReadiness;
    base.push(
      { text: `Voice: ${snapshot.voiceSurfaceEnabled ? 'enabled' : 'disabled'}; TTS ${snapshot.ttsProvider}; voice ${snapshot.ttsVoice}.`, fg: snapshot.voiceSurfaceEnabled ? PALETTE.good : PALETTE.info },
      { text: `Media readiness: ${readiness.readyMediaProviderCount}/${snapshot.mediaProviderCount}; generation providers ${snapshot.mediaGenerationProviderCount}.`, fg: readiness.readyMediaProviderCount > 0 ? PALETTE.good : PALETTE.muted },
      { text: `Telephony channel: ${snapshot.channels.find((channel) => channel.id === 'telephony')?.setupState ?? 'disabled'}.`, fg: PALETTE.info },
    );
  } else if (category.id === 'onboarding-context') {
    const vibe = snapshot.vibe;
    const projectContext = snapshot.projectContext;
    base.push(
      { text: `Local context: ${snapshot.localMemoryCount} memories, ${snapshot.localNoteCount} notes, ${snapshot.localPersonaCount} personas.`, fg: PALETTE.info },
      { text: `Skills: ${snapshot.enabledSkillCount}/${snapshot.localSkillCount} enabled; routines ${snapshot.enabledRoutineCount}/${snapshot.localRoutineCount} enabled.`, fg: PALETTE.info },
      { text: `Discovered files: personas ${snapshot.discoveredBehavior.personas.count}, skills ${snapshot.discoveredBehavior.skills.count}, routines ${snapshot.discoveredBehavior.routines.count}.`, fg: PALETTE.muted },
      { text: `VIBE.md: ${vibe.applied} applied; ${vibe.blocked} blocked; ${vibe.truncated} truncated.`, fg: vibe.blocked > 0 ? PALETTE.warn : vibe.applied > 0 ? PALETTE.good : PALETTE.muted },
      { text: `Project context: ${projectContext.loaded} loaded; ${projectContext.blocked} blocked; ${projectContext.truncated} truncated.`, fg: projectContext.blocked > 0 ? PALETTE.warn : projectContext.loaded > 0 ? PALETTE.good : PALETTE.muted },
      ...promptReceiptTimelineLines(snapshot),
      { text: 'Context controls: prompt receipts, project files, one-file inspection, and VIBE.md review.', fg: PALETTE.good },
    );
  } else if (category.id === 'research') {
    const runnerContract = snapshot.researchBrowserRunnerContract;
    const visualContract = snapshot.researchVisualReportContract;
    base.push(
      { text: `Research route: ${snapshot.provider} / ${snapshot.modelDisplayName}; Knowledge: ${snapshot.knowledgeRoute}.`, fg: PALETTE.info },
      { text: 'Model route: research action:"briefing|plan|search|runner|runs|sources|reports|report".', fg: PALETTE.good },
      { text: `Browser runner contract: ${runnerContract.label}; ${compactText(runnerContract.next, 64)}`, fg: researchContractColor(runnerContract.status), bold: runnerContract.status !== 'ready-with-confirmation' },
      { text: `Runner requires: ${runnerContract.details.join(', ')}.`, fg: PALETTE.muted },
      { text: 'Briefing: one read-only next-action queue with confirmed routes.', fg: PALETTE.good },
      { text: `Research runs: ${snapshot.researchRunRunningCount} running; ${snapshot.researchRunPausedCount} paused; ${snapshot.researchRunBlockedCount} blocked; ${snapshot.researchRunPlannedCount} planned.`, fg: snapshot.researchRunRunningCount > 0 || snapshot.researchRunBlockedCount > 0 ? PALETTE.warn : snapshot.researchRunPausedCount > 0 || snapshot.researchRunPlannedCount > 0 ? PALETTE.info : PALETTE.muted },
      { text: `Source queue: ${snapshot.researchSourceCandidateCount} candidate; ${snapshot.researchSourceReviewedCount} reviewed; ${snapshot.researchSourceRejectedCount} rejected; ${snapshot.researchSourceUsedCount} used.`, fg: snapshot.researchSourceCandidateCount > 0 ? PALETTE.warn : snapshot.researchSourceReviewedCount > 0 ? PALETTE.good : PALETTE.muted },
      { text: `Visual report contract: ${visualContract.label}; ${compactText(visualContract.next, 64)}`, fg: researchContractColor(visualContract.status), bold: visualContract.status !== 'visual-report-packet-ready' },
      { text: `Report requires: ${visualContract.details.join(', ')}.`, fg: PALETTE.muted },
      { text: 'Web and URL inspection stay read-only until the user confirms source ingest.', fg: PALETTE.good },
    );
  } else if (category.id === 'personal-ops') {
    const ready = readyRoutineItems(snapshot);
    const readyChannels = snapshot.channels.filter((channel) => channel.ready).length;
    const enabledChannels = snapshot.channels.filter((channel) => channel.enabled).length;
    const configuredTargets = snapshot.channels.filter((channel) => channel.defaultTarget === 'configured').length;
    base.push(
      { text: `Personal Ops: notes ${snapshot.localNoteCount}; routines ${snapshot.localRoutineCount}/${snapshot.enabledRoutineCount}; schedule-ready ${ready.length}.`, fg: PALETTE.info },
      { text: 'Daily brief: plan inbox, agenda, tasks, reminders, routines, delivery, notes, and autonomy before live reads or effects.', fg: PALETTE.good },
      { text: `Tasks: work plan and host task inspection; reminders via confirmed schedules; receipts ${snapshot.routineScheduleReceiptCount}.`, fg: PALETTE.good },
      { text: 'Review queue: saved inbox threads/calendar events, refresh routes, and follow-up boundaries stay in one read-only list.', fg: PALETTE.good },
      { text: 'Autonomy queue: inspect owners, status, and cancel/recovery routes before adding background work.', fg: PALETTE.good },
      { text: `Delivery: ${readyChannels}/${snapshot.channels.length} channels ready; ${enabledChannels} enabled; ${configuredTargets} configured target(s).`, fg: readyChannels > 0 ? PALETTE.good : PALETTE.warn },
      { text: 'Email/calendar: connector setup needed before inbox triage or agenda workflows are first-class.', fg: PALETTE.warn },
      { text: 'Model route: personal_ops action:"briefing|status|queue|intake|lane|read".', fg: PALETTE.muted },
    );
  } else if (category.id === 'knowledge') {
    base.push(
      { text: `Route: ${snapshot.knowledgeRoute}; isolation ${snapshot.knowledgeIsolation}.`, fg: PALETTE.info },
      { text: 'Ask/search, ingest, review, reindex, and reports stay Agent-owned.', fg: PALETTE.good },
      { text: 'Ingest requires explicit confirmation.', fg: PALETTE.warn },
    );
  } else if (category.id === 'documents') {
    const mediaReady = snapshot.voiceMediaReadiness.readyMediaProviderCount;
    base.push(
      { text: `Document route: ${snapshot.provider} / ${snapshot.modelDisplayName}; Knowledge: ${snapshot.knowledgeRoute}`, fg: PALETTE.info },
      { text: `Files: attach, paste, source ingest, export-to-file/package/ZIP; artifact limit ${formatMegabytes(snapshot.artifactMaxBytes)}.`, fg: PALETTE.good },
      { text: `Media artifacts: ${mediaReady}/${snapshot.mediaProviderCount} providers ready; generation ${snapshot.mediaGenerationProviderCount}.`, fg: mediaReady > 0 ? PALETTE.good : PALETTE.warn },
      reviewerHandoffArtifactLine(snapshot),
      { text: 'Model route: agent_harness mode:"document_ops" or document_ops_lane.', fg: PALETTE.muted },
      ...reviewPacketTimelineLines(snapshot),
      { text: `Packet wizard: ${snapshot.reviewPacketWizard.completedSteps}/${snapshot.reviewPacketWizard.totalSteps} done; ${snapshot.reviewPacketWizard.currentStepLabel ? `current ${snapshot.reviewPacketWizard.currentStepLabel}` : snapshot.reviewPacketWizard.status}.`, fg: snapshot.reviewPacketWizard.status === 'complete' ? PALETTE.good : snapshot.reviewPacketWizard.status === 'blocked' ? PALETTE.warn : PALETTE.info },
      { text: `Packet defaults: ${snapshot.reviewPacketDefaults.summary}.`, fg: snapshot.reviewPacketDefaults.documentId || snapshot.reviewPacketDefaults.comparisonArtifactId || snapshot.reviewPacketDefaults.handoffArtifactId ? PALETTE.info : PALETTE.muted },
      ...(snapshot.reviewPacketDefaults.reviewPacketPresetLineage
        ? [{ text: `Preset lineage: ${compactText(snapshot.reviewPacketDefaults.reviewPacketPresetLineage.summary, 128)}.`, fg: snapshot.reviewPacketDefaults.reviewPacketPresetLineage.refreshed ? PALETTE.good : PALETTE.muted }]
        : []),
      { text: 'Versioned drafts, review comments, AI suggestion review, artifact attachment/insertion, artifact browser, and Knowledge promotion are available.', fg: PALETTE.good },
      { text: 'Compare: reuse, review/side-by-side/judgment, analytics/synthesis, handoff diff, export/archive, and route update.', fg: PALETTE.good },
    );
  } else if (category.id === 'tools') {
    base.push(
      { text: `MCP servers: ${snapshot.mcpConnectedServerCount}/${snapshot.mcpServerCount} connected; quarantined ${snapshot.mcpQuarantinedServerCount}; allow-all ${snapshot.mcpAllowAllServerCount}.`, fg: snapshot.mcpQuarantinedServerCount > 0 || snapshot.mcpAllowAllServerCount > 0 ? PALETTE.warn : PALETTE.info },
      { text: 'Add/update/reload and trust changes require confirmation.', fg: PALETTE.good },
      { text: 'Start: /mcp review, /mcp tools, /mcp config, Add MCP server.', fg: PALETTE.muted },
    );
  } else if (category.id === 'profiles') {
    const defaultProfile = snapshot.selectedRuntimeProfile
      ? `${snapshot.selectedRuntimeProfile}${snapshot.selectedRuntimeProfileExists ? '' : ' (missing)'}`
      : '(base Agent home)';
    base.push(
      { text: `Profiles: active ${snapshot.activeRuntimeProfile}; default ${defaultProfile}.`, fg: snapshot.selectedRuntimeProfileExists || !snapshot.selectedRuntimeProfile ? PALETTE.info : PALETTE.warn },
      { text: `Local profiles: ${snapshot.runtimeProfileCount}; starters ${snapshot.runtimeStarterTemplateCount}; custom ${snapshot.localStarterTemplateCount}.`, fg: PALETTE.info },
      { text: `Starter ids: ${truncateDisplay(snapshot.runtimeStarterTemplates.map((template) => template.id).join(', ') || 'none', 96, '...')}`, fg: PALETTE.muted },
      { text: 'Profiles isolate local Agent config, sessions, memory, personas, skills, routines, setup, and bundles.', fg: PALETTE.good },
    );
  } else if (category.id === 'memory') {
    const behaviorNeedsSetup = [
      ...snapshot.localSkills,
      ...snapshot.localSkillBundles,
      ...snapshot.localRoutines,
    ].filter((item) => (item.missingRequirementCount ?? 0) > 0).length;
    const injectedNeedsReview = [
      ...snapshot.localPersonas.filter((item) => item.active),
      ...snapshot.localSkills.filter((item) => item.enabled),
      ...snapshot.localSkillBundles.filter((item) => item.enabled),
      ...snapshot.localRoutines.filter((item) => item.enabled),
    ].filter((item) => item.reviewState !== 'reviewed').length;
    base.push(
      { text: `Memory: ${snapshot.localMemoryCount}; prompt ${snapshot.localMemoryPromptActiveCount}; queue ${snapshot.localMemoryReviewQueueCount}; session ${snapshot.sessionMemoryCount}.${liveCounterStaleSuffix(snapshot)}`, fg: PALETTE.info },
      { text: `Notes: ${snapshot.localNoteCount}; skills ${snapshot.localSkillCount}/${snapshot.enabledSkillCount}; routines ${snapshot.localRoutineCount}/${snapshot.enabledRoutineCount}; personas ${snapshot.localPersonaCount}.`, fg: PALETTE.info },
      { text: `Learning curator: memory queue ${snapshot.localMemoryReviewQueueCount}; note queue ${snapshot.localNoteReviewQueueCount}; setup gaps ${behaviorNeedsSetup}; injected review ${injectedNeedsReview}.`, fg: behaviorNeedsSetup > 0 || injectedNeedsReview > 0 ? PALETTE.warn : PALETTE.good },
      { text: 'Prompt plan: score reviewed context, show suppressed records, and route review before behavior expands.', fg: PALETTE.good },
      { text: `Active persona: ${snapshot.activePersonaName}.`, fg: PALETTE.info },
      ...compactLocalLibraryLines('Agent Memory', snapshot.localMemories, 'Create one with Create memory.', workspace.selectedLocalLibraryItem('memory')?.id ?? null),
      { text: 'Secrets are rejected or redacted; use secret references.', fg: PALETTE.warn },
    );
  } else if (category.id === 'notes') {
    base.push(
      { text: `Scratchpad notes: ${snapshot.localNoteCount}; review queue: ${snapshot.localNoteReviewQueueCount}`, fg: PALETTE.info },
      ...compactLocalLibraryLines('Scratchpad Notes', snapshot.localNotes, 'Create one with Create note.', workspace.selectedLocalLibraryItem('note')?.id ?? null),
      { text: 'Notes stay local unless promoted by explicit action.', fg: PALETTE.warn },
    );
  } else if (category.id === 'personas') {
    const vibe = snapshot.vibe;
    base.push(
      { text: `VIBE.md: ${vibe.applied} applied; ${vibe.blocked} blocked; ${vibe.truncated} truncated.`, fg: vibe.blocked > 0 ? PALETTE.warn : vibe.applied > 0 ? PALETTE.good : PALETTE.muted },
      { text: `Personas: ${snapshot.localPersonaCount}; active: ${snapshot.activePersonaName}`, fg: PALETTE.info },
      ...compactLocalLibraryLines('Persona Library', snapshot.localPersonas, 'Create one with Create persona.', workspace.selectedLocalLibraryItem('persona')?.id ?? null),
      { text: 'VIBE.md is personality; project context files are separate workspace instructions.', fg: PALETTE.good },
      { text: 'Personas shape the serial main-conversation assistant.', fg: PALETTE.good },
    );
  } else if (category.id === 'skills') {
    base.push(
      { text: `Skills: ${snapshot.localSkillCount}; enabled: ${snapshot.enabledSkillCount}; bundles: ${snapshot.localSkillBundleCount}; enabled bundles: ${snapshot.enabledSkillBundleCount}; active skills: ${snapshot.activeSkillCount}`, fg: PALETTE.info },
      ...compactLocalLibraryLines('Skill Library', snapshot.localSkills, 'Create one with Create skill.', workspace.selectedLocalLibraryItem('skill')?.id ?? null),
      ...compactLocalLibraryLines('Skill Bundles', snapshot.localSkillBundles, 'Create one after adding skills.', null),
      { text: 'Enabled skills/bundles become operating guidance; secrets are rejected.', fg: PALETTE.warn },
    );
  } else if (category.id === 'routines') {
    const ready = readyRoutineItems(snapshot);
    const needsSetup = routinesNeedingSetup(snapshot);
    const needsReview = routinesNeedingReview(snapshot);
    base.push(
      { text: `Routines: ${snapshot.localRoutineCount}; enabled: ${snapshot.enabledRoutineCount}${liveCounterStaleSuffix(snapshot)}`, fg: PALETTE.info },
      { text: `Schedule-ready routines: ${ready.length}; setup gaps: ${needsSetup.length}; review needed: ${needsReview.length}`, fg: needsSetup.length > 0 || needsReview.length > 0 ? PALETTE.warn : PALETTE.good },
      routineNextActionLine(snapshot),
      compactRoutineReceiptLine(snapshot),
      ...compactLocalLibraryLines('Routine Library', snapshot.localRoutines, 'Create one with Create routine.', workspace.selectedLocalLibraryItem('routine')?.id ?? null),
      { text: 'Scheduling requires a confirmed action.', fg: PALETTE.warn },
    );
  } else if (category.id === 'work') {
    const processSupervision = snapshot.processSupervision;
    base.push(
      { text: 'Work plans and approvals are read or explicitly confirmed.', fg: PALETTE.info },
      { text: `Process supervision: ${processSupervision.status}; ${processSupervision.tracked} tracked; ${processSupervision.running} running; ${processSupervision.completed} completed.`, fg: processSupervision.running > 0 ? PALETTE.warn : processSupervision.status === 'available' ? PALETTE.good : PALETTE.warn },
      { text: `Process parity: stdin ${processSupervision.stdinWriteStatus}; PTY ${processSupervision.ptyStatus}; sudo ${processSupervision.sudoStatus}.`, fg: processSupervision.stdinWriteStatus === 'supported-with-confirmation' || processSupervision.ptyStatus === 'contract-discovered' ? PALETTE.info : PALETTE.warn },
      { text: 'Process routes: execution / capabilities / process monitor / live tail.', fg: PALETTE.good },
      { text: 'Autonomy queue covers work plan, host tasks, approvals, automation, schedules, routines, delegation, and delivery.', fg: PALETTE.good },
      { text: 'Selection alone does not approve, deny, cancel, or mutate requests.', fg: PALETTE.good },
      { text: 'Approval actions require id plus typed confirmation.', fg: PALETTE.warn },
    );
  } else if (category.id === 'automation') {
    base.push(
      { text: `Automation: ${snapshot.automationEnabled ? 'enabled' : 'disabled'}; max ${snapshot.automationMaxConcurrentRuns} concurrent; history ${snapshot.automationRunHistoryLimit}.`, fg: snapshot.automationEnabled ? PALETTE.good : PALETTE.muted },
      { text: `Timeout ${snapshot.automationDefaultTimeoutMs} ms; catch-up ${snapshot.automationCatchUpWindowMinutes} min; cooldown ${snapshot.automationFailureCooldownMs} ms.`, fg: PALETTE.info },
      { text: `Delete one-shot jobs after success: ${snapshot.automationDeleteAfterRun ? 'yes' : 'no'}.`, fg: snapshot.automationDeleteAfterRun ? PALETTE.info : PALETTE.muted },
    );
    const ready = readyRoutineItems(snapshot);
    base.push(
      { text: `Automation: ${ready.length} schedule-ready routine(s); receipts ${snapshot.routineScheduleReceiptCount}.`, fg: ready.length > 0 ? PALETTE.good : PALETTE.warn },
      automationNextActionLine(snapshot),
      compactRoutineReceiptLine(snapshot),
      { text: 'Autonomy queue: review visible schedules, runs, receipts, and cancel routes first.', fg: PALETTE.good },
      { text: 'Reminders and routine promotion require confirmation.', fg: PALETTE.warn },
    );
  } else if (category.id === 'finish') {
    base.push(
      { text: 'Apply & close marks onboarding finished for this user.', fg: PALETTE.good },
      { text: 'Future normal launches start in the main conversation.', fg: PALETTE.info },
      { text: 'Use /agent, /setup, or /onboarding to reopen this workspace later.', fg: PALETTE.muted },
    );
  }
  if (snapshot.warnings.length > 0) {
    base.push({ text: `Warnings: ${snapshot.warnings.map((warning) => compactText(warning, 60)).join('; ')}`, fg: PALETTE.warn });
  }
  return base;
}
