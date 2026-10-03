import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from './command-registry.ts';
import { readSetupWizardCheckpoint } from '../agent/setup-wizard-checkpoint.ts';
import { readOnboardingCompletionMarker } from '../runtime/onboarding/index.ts';
import { DEFAULT_AGENT_SETUP_WIZARD_CLEAR_CHECKPOINT_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_INSPECT_CHECKPOINT_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_MARK_CHECKPOINT_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE, buildAgentSetupWizard, emptyAgentSetupSmokeHistory, emptyAgentSetupWizardCheckpoint, type AgentSetupWizard, type AgentSetupWizardBlockedCheckFrequency, type AgentSetupWizardCheckpoint, type AgentSetupWizardDurableReceipt, type AgentSetupWizardSmokeHistory, type AgentSetupWizardSourceItem } from '../agent/setup-wizard.ts';
import type { AgentWorkspaceSetupChecklistItem } from './agent-workspace-setup.ts';
import { readArtifactMetadataString, readArtifactMetadataStringList } from './agent-workspace-artifact-metadata.ts';

function isSetupSmokeEvidenceArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-setup-smoke-evidence';
}

function setupSmokeEvidenceScore(artifact: ArtifactDescriptor): number {
  const result = readArtifactMetadataString(artifact.metadata, 'result');
  if (result === 'ready-for-user-run') return 2;
  if (result === 'blocked') return 0;
  return 1;
}

function setupSmokeEvidenceTrend(artifacts: readonly ArtifactDescriptor[]): string {
  if (artifacts.length === 0) return 'none';
  if (artifacts.length === 1) return 'first-run';
  const latest = setupSmokeEvidenceScore(artifacts[0]!);
  const previous = setupSmokeEvidenceScore(artifacts[1]!);
  if (latest > previous) return 'improving';
  if (latest < previous) return 'regressing';
  const result = readArtifactMetadataString(artifacts[0]!.metadata, 'result');
  if (result === 'ready-for-user-run') return 'unchanged-ready';
  if (result === 'blocked') return 'unchanged-blocked';
  return 'unchanged';
}

function artifactCreatedAtIso(artifact: ArtifactDescriptor): string | null {
  const createdAt = artifact.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  return new Date(createdAt).toISOString();
}

function setupSmokeBlockedCheckFrequency(artifacts: readonly ArtifactDescriptor[]): readonly AgentSetupWizardBlockedCheckFrequency[] {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    for (const checkId of readArtifactMetadataStringList(artifact.metadata, 'blockedChecks')) {
      counts.set(checkId, (counts.get(checkId) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([checkId, count]) => ({ checkId, count }));
}

export function buildSetupSmokeHistory(artifacts: readonly ArtifactDescriptor[], artifactListAvailable: boolean): AgentSetupWizardSmokeHistory {
  if (!artifactListAvailable) {
    return {
      ...emptyAgentSetupSmokeHistory('Artifact list support is unavailable in this runtime.'),
      status: 'unavailable',
    };
  }
  const setupSmokeArtifacts = artifacts
    .filter(isSetupSmokeEvidenceArtifact)
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  if (setupSmokeArtifacts.length === 0) return emptyAgentSetupSmokeHistory();
  const resultCounts = setupSmokeArtifacts.reduce<Record<string, number>>((counts, artifact) => {
    const result = readArtifactMetadataString(artifact.metadata, 'result') || 'unknown';
    counts[result] = (counts[result] ?? 0) + 1;
    return counts;
  }, {});
  const latest = setupSmokeArtifacts[0]!;
  const previous = setupSmokeArtifacts[1] ?? null;
  return {
    status: 'available',
    total: setupSmokeArtifacts.length,
    trend: setupSmokeEvidenceTrend(setupSmokeArtifacts),
    latestResult: readArtifactMetadataString(latest.metadata, 'result') || 'unknown',
    previousResult: previous ? readArtifactMetadataString(previous.metadata, 'result') || 'unknown' : null,
    latestEvidenceId: latest.id,
    latestEvidenceAt: artifactCreatedAtIso(latest),
    resultCounts,
    blockedCheckFrequency: setupSmokeBlockedCheckFrequency(setupSmokeArtifacts),
    inspectLatestRoute: `agent_artifacts show artifactId:"${latest.id}" includeContent:false`,
    rerunRoute: DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE,
    saveRoute: DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE,
  };
}

export function buildSetupWizardCheckpoint(context: CommandContext): AgentSetupWizardCheckpoint {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths || typeof shellPaths.resolveUserPath !== 'function') {
    return {
      ...emptyAgentSetupWizardCheckpoint('Agent shell paths are unavailable; setup wizard checkpoint storage cannot be inspected.'),
      status: 'unavailable',
    };
  }
  const snapshot = readSetupWizardCheckpoint(shellPaths);
  const routes = {
    markCurrentRoute: DEFAULT_AGENT_SETUP_WIZARD_MARK_CHECKPOINT_ROUTE,
    clearRoute: DEFAULT_AGENT_SETUP_WIZARD_CLEAR_CHECKPOINT_ROUTE,
    inspectRoute: DEFAULT_AGENT_SETUP_WIZARD_INSPECT_CHECKPOINT_ROUTE,
  };
  if (!snapshot.exists) {
    return {
      ...emptyAgentSetupWizardCheckpoint(),
      ...routes,
      path: snapshot.path,
    };
  }
  if (!snapshot.checkpoint) {
    return {
      ...emptyAgentSetupWizardCheckpoint(snapshot.parseError ?? 'Saved setup wizard checkpoint could not be read.'),
      ...routes,
      status: 'unavailable',
      path: snapshot.path,
      ...(snapshot.parseError ? { parseError: snapshot.parseError } : {}),
    };
  }
  return {
    status: 'available',
    currentStepId: snapshot.checkpoint.currentStepId,
    currentStepLabel: snapshot.checkpoint.currentStepLabel,
    savedAt: snapshot.checkpoint.savedAt,
    source: snapshot.checkpoint.source,
    resumed: false,
    summary: `Saved setup checkpoint for ${snapshot.checkpoint.currentStepLabel}.`,
    path: snapshot.path,
    ...(snapshot.checkpoint.note ? { note: snapshot.checkpoint.note } : {}),
    ...routes,
  };
}

function setupChecklistUserRoute(item: AgentWorkspaceSetupChecklistItem): string {
  return item.breadcrumb ?? 'Start';
}

function setupChecklistModelRoute(item: AgentWorkspaceSetupChecklistItem): string {
  if (item.id === 'runtime') return 'agent_harness mode:"setup_item" setupItemId:"connected-host-readiness"';
  if (item.id === 'provider-model') return 'models action:"status"';
  if (item.id === 'subscriptions') return 'models action:"providers"';
  if (item.id === 'agent-knowledge') return 'agent_knowledge mode:"status"';
  if (item.id === 'profile') return 'agent_harness mode:"workspace_action" actionId:"profile-template-show"';
  if (item.id === 'persona') return 'agent_harness mode:"workspace" target:"personas"';
  if (item.id === 'skills') return 'agent_harness mode:"workspace" target:"skills"';
  if (item.id === 'routines') return 'agent_harness mode:"workspace" target:"routines"';
  if (item.id === 'memory') return 'memory action:"status"';
  if (item.id === 'notes') return 'personal_ops action:"lane" laneId:"notes"';
  if (item.id === 'channels') return 'channels action:"status"';
  if (item.id === 'voice-media') return 'device action:"voice"';
  return `agent_harness mode:"setup_item" setupItemId:"${item.id}"`;
}

function setupChecklistActionId(item: AgentWorkspaceSetupChecklistItem): string {
  if (item.id === 'provider-model') return 'setup-provider-model';
  if (item.id === 'subscriptions') return 'subscription-login-start';
  if (item.id === 'agent-knowledge') return 'knowledge-status';
  if (item.id === 'profile') return 'profile-template-show';
  if (item.id === 'persona') return 'persona-search';
  if (item.id === 'skills') return 'skill-search';
  if (item.id === 'routines') return 'routine-search';
  if (item.id === 'channels') return 'channel-show';
  if (item.id === 'voice-media') return 'voice-enable';
  return item.id;
}

const SETUP_WIZARD_SNAPSHOT_BLOCKER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'agent-binary': ['runtime'],
  'connected-host-status': ['runtime'],
  'connected-host-auth': ['connected-host-auth'],
  'provider-model': ['provider-model'],
};

export function buildWorkspaceSetupWizard(
  checklist: readonly AgentWorkspaceSetupChecklistItem[],
  smokeHistory: AgentSetupWizardSmokeHistory,
  checkpoint: AgentSetupWizardCheckpoint,
  setupMarkerExists: boolean,
  durableReceipts: readonly AgentSetupWizardDurableReceipt[] = [],
): AgentSetupWizard {
  const items: AgentSetupWizardSourceItem[] = checklist.map((item) => ({
    id: item.id,
    label: item.label,
    status: item.status,
    detail: item.detail,
    userRoute: setupChecklistUserRoute(item),
    modelRoute: setupChecklistModelRoute(item),
    actionId: setupChecklistActionId(item),
  }));
  return buildAgentSetupWizard({
    items,
    smokeHistory,
    checkpoint,
    closeoutCriticalStepIds: ['runtime', 'connected-host-auth', 'provider-model'],
    receiptRequiredStepIds: [
      'runtime',
      'connected-host-auth',
    ],
    durableReceipts,
    setupMarkerExists,
    repeatedBlockerAliases: SETUP_WIZARD_SNAPSHOT_BLOCKER_ALIASES,
  });
}

export function setupCompletionMarkerExists(context: CommandContext): boolean {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths || typeof shellPaths.resolveUserPath !== 'function') return false;
  try {
    return readOnboardingCompletionMarker(shellPaths, 'user').exists;
  } catch {
    return false;
  }
}
