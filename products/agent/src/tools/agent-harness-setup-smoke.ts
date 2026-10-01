import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import { requireShellPaths } from '../input/commands/runtime-services.ts';
import { readOnboardingCompletionMarker } from '../runtime/onboarding/index.ts';
import { buildSetupWizardDurableReceipts } from '../agent/setup-wizard-artifact-receipts.ts';
import { mergeSetupWizardDurableReceipts, setupWizardLiveDurableReceipts } from '../input/setup-wizard-live-receipts.ts';
import { clearSetupWizardCheckpoint, readSetupWizardCheckpoint, saveSetupWizardCheckpoint } from '../agent/setup-wizard-checkpoint.ts';
import { DEFAULT_AGENT_SETUP_WIZARD_CLEAR_CHECKPOINT_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_INSPECT_CHECKPOINT_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_MARK_CHECKPOINT_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE, buildAgentSetupWizard, emptyAgentSetupSmokeHistory, emptyAgentSetupWizardCheckpoint, type AgentSetupWizard, type AgentSetupWizardCheckpoint, type AgentSetupWizardDurableReceipt, type AgentSetupWizardSmokeHistory, type AgentSetupWizardSourceItem } from '../agent/setup-wizard.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readFieldMap, readString, safeIso, setupSmokeArtifactStore } from './agent-harness-setup-posture-utils.ts';
import { setupHandoffsForItem } from './agent-harness-setup-handoffs.ts';
import type { SetupConnectedHostAuthPosture, SetupInstallSmokeCheck, SetupInstallSmokePlan, SetupInstallSmokeRunSummary, SetupPlanItem, SetupServiceProbe, SetupSmokeEvidenceField } from './agent-harness-setup-posture-types.ts';
import type { OnboardingStep1CapabilityItem } from '../runtime/onboarding/index.ts';

export function installSmokeCheckStatus(ready: boolean): 'ready' | 'blocked' {
  return ready ? 'ready' : 'blocked';
}

export function installSmokePlan(
  providerAccess: OnboardingStep1CapabilityItem,
  serviceProbe: SetupServiceProbe,
  authPosture: SetupConnectedHostAuthPosture,
): SetupInstallSmokePlan {
  const hostReady = serviceProbe.status === 'reachable';
  const authReady = authPosture.operatorToken.usable;
  const modelReady = providerAccess.selected;
  const checks: SetupInstallSmokeCheck[] = [
    {
      id: 'agent-binary',
      label: 'Agent binary starts',
      status: 'user-run',
      evidence: 'The installed package binary should answer version/help/status without exposing secrets.',
      route: 'goodvibes-agent --version && goodvibes-agent status --json',
    },
    {
      id: 'connected-host-status',
      label: 'Connected host reachable',
      status: installSmokeCheckStatus(hostReady),
      evidence: `Runtime probe is ${serviceProbe.status} at ${serviceProbe.binding}.`,
      route: 'host action:"status" includeParameters:true',
    },
    {
      id: 'connected-host-auth',
      label: 'Connected-host operator auth usable',
      status: installSmokeCheckStatus(authReady),
      evidence: authReady
        ? `Operator token is usable (${authPosture.operatorToken.fingerprint ?? 'fingerprint unavailable'}).`
        : `Operator token is ${authPosture.operatorToken.present ? 'present but not usable' : 'missing'} at ${authPosture.operatorToken.path}.`,
      route: 'setup action:"item" setupItemId:"connected-host-auth"',
    },
    {
      id: 'provider-model',
      label: 'Provider/model route selected',
      status: installSmokeCheckStatus(modelReady),
      evidence: modelReady ? 'Provider/model access is selected in onboarding state.' : 'Provider/model access is not selected yet.',
      route: 'models action:"status" includeParameters:true',
    },
    {
      id: 'setup-posture',
      label: 'Setup posture reviewed',
      status: 'user-run',
      evidence: 'Setup posture should show no unresolved autonomy blockers before ongoing work.',
      route: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
    },
    {
      id: 'first-assistant-turn',
      label: 'First assistant turn responds',
      status: 'user-run',
      evidence: 'Ask the main assistant for a short ready response once a provider/model route is selected.',
      route: 'Ask the assistant: "Say ready in one sentence and list the active model route."',
    },
  ];
  return {
    status: hostReady && authReady && modelReady ? 'ready-to-run' : 'blocked',
    source: 'GoodVibes Agent installed package plus connected GoodVibes host',
    checks,
    successCriteria: [
      'The Agent binary starts and reports status without printing connected-host tokens.',
      'The connected GoodVibes host is reachable from Agent.',
      'Connected-host operator auth is usable or the user has an explicit pairing handoff.',
      'A provider/model route is selected for normal assistant turns.',
      'The first assistant turn responds in the main conversation.',
    ],
    policy: 'Install smoke is read-only, token-safe guidance. Agent does not run package, host, or shell smoke commands implicitly; use explicit user-run commands or confirmed routes only.',
  };
}

export function installSmokeSignals(plan: SetupInstallSmokePlan): readonly string[] {
  return [
    `install smoke: ${plan.status}`,
    ...plan.checks.map((check) => `${check.id}: ${check.status}`),
  ];
}

export const SETUP_SMOKE_EVIDENCE_FIELD_DEFINITIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'agentBinaryOutput', label: 'Agent binary output' },
  { id: 'statusJson', label: 'Agent status JSON' },
  { id: 'connectedHostStatusOutput', label: 'Connected-host status output' },
  { id: 'setupPostureOutput', label: 'Setup posture output' },
  { id: 'firstAssistantTurn', label: 'First assistant turn' },
  { id: 'notes', label: 'Operator notes' },
];

export const MAX_SETUP_SMOKE_FIELD_CHARS = 8_000;

export function redactSetupSmokeEvidence(input: string): string {
  const bounded = input.slice(0, MAX_SETUP_SMOKE_FIELD_CHARS);
  return bounded
    .replace(/(\bauthorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1<redacted>')
    .replace(/("?\b(?:api[-_]?key|apikey|token|secret|password|credential)\b"?\s*:\s*)("[^"]*"|[^\s,}]+)/gi, '$1"<redacted>"')
    .replace(/(\b(?:api[-_]?key|apikey|token|secret|password|credential)\b\s*=\s*)[^\s&]+/gi, '$1<redacted>')
    .replace(/([?&](?:api[-_]?key|apikey|token|secret|password|credential)=)[^&\s]+/gi, '$1<redacted>');
}

export function setupSmokeEvidenceFields(fields: unknown): readonly SetupSmokeEvidenceField[] {
  const values = readFieldMap(fields);
  return SETUP_SMOKE_EVIDENCE_FIELD_DEFINITIONS
    .map((definition) => {
      const raw = values[definition.id]?.trim() ?? '';
      return raw ? { ...definition, value: redactSetupSmokeEvidence(raw) } : null;
    })
    .filter((entry): entry is SetupSmokeEvidenceField => entry !== null);
}

export function safeSetupSmokeFilename(capturedAt: string): string {
  return `setup-smoke-${capturedAt.replace(/[:.]/g, '-').replace(/[^a-zA-Z0-9-]+/g, '-')}.md`;
}

export function setupSmokeEvidenceMarkdown(input: {
  readonly capturedAt: string;
  readonly explicitUserRequest: string;
  readonly smokePlan: SetupInstallSmokePlan;
  readonly summary: SetupInstallSmokeRunSummary;
  readonly blockedChecks: readonly string[];
  readonly userRunChecks: readonly string[];
  readonly evidenceFields: readonly SetupSmokeEvidenceField[];
}): string {
  const checkLines = input.smokePlan.checks.map((check) => `- ${check.id}: ${check.status} - ${redactSetupSmokeEvidence(check.evidence)}`);
  const evidenceSections = input.evidenceFields.map((field) => [
    `## ${field.label}`,
    '',
    '```text',
    field.value,
    '```',
  ].join('\n'));
  return [
    '# GoodVibes Agent Setup Smoke Evidence',
    '',
    `Captured: ${input.capturedAt}`,
    `Explicit user request: ${redactSetupSmokeEvidence(input.explicitUserRequest)}`,
    `Smoke status: ${input.smokePlan.status}`,
    `Ready checks: ${input.summary.ready}`,
    `Blocked checks: ${input.blockedChecks.join(', ') || 'none'}`,
    `User-run checks: ${input.userRunChecks.join(', ') || 'none'}`,
    '',
    '## Check Statuses',
    '',
    ...checkLines,
    '',
    '## Success Criteria',
    '',
    ...input.smokePlan.successCriteria.map((criterion) => `- ${criterion}`),
    '',
    ...evidenceSections,
    '',
    '## Policy',
    '',
    input.smokePlan.policy,
    'Evidence fields are redacted before storage. Agent does not run package, host, or shell smoke commands implicitly.',
  ].join('\n');
}

export async function saveSetupSmokeArtifact(input: {
  readonly context: CommandContext;
  readonly capturedAt: string;
  readonly explicitUserRequest: string;
  readonly smokePlan: SetupInstallSmokePlan;
  readonly summary: SetupInstallSmokeRunSummary;
  readonly blockedChecks: readonly string[];
  readonly userRunChecks: readonly string[];
  readonly evidenceFields: readonly SetupSmokeEvidenceField[];
}): Promise<Record<string, unknown>> {
  if (input.evidenceFields.length === 0) {
    return {
      status: 'not_requested',
      reason: 'Pass fields with user-run smoke output to save a redacted setup evidence artifact.',
      supportedFields: SETUP_SMOKE_EVIDENCE_FIELD_DEFINITIONS.map((field) => field.id),
    };
  }
  const artifactStore = setupSmokeArtifactStore(input.context);
  if (!artifactStore?.create) {
    return {
      status: 'unavailable',
      reason: 'This runtime did not provide an artifact store with create support.',
      evidenceFields: input.evidenceFields.map((field) => field.id),
    };
  }
  const descriptor = await artifactStore.create({
    kind: 'document',
    mimeType: 'text/markdown',
    filename: safeSetupSmokeFilename(input.capturedAt),
    text: setupSmokeEvidenceMarkdown(input),
    metadata: {
      purpose: 'agent-setup-smoke-evidence',
      source: 'agent-harness-run-setup-smoke',
      capturedAt: input.capturedAt,
      smokeStatus: input.smokePlan.status,
      result: input.blockedChecks.length > 0 ? 'blocked' : 'ready-for-user-run',
      blockedChecks: input.blockedChecks,
      userRunChecks: input.userRunChecks,
      evidenceFields: input.evidenceFields.map((field) => field.id),
      checkStatuses: Object.fromEntries(input.smokePlan.checks.map((check) => [check.id, check.status])),
      explicitUserRequest: redactSetupSmokeEvidence(input.explicitUserRequest),
      redaction: 'token, secret, password, credential, authorization, and api-key-like values redacted before storage',
    },
  });
  return {
    status: 'saved',
    artifactId: descriptor.id,
    filename: descriptor.filename ?? null,
    mimeType: descriptor.mimeType,
    sizeBytes: descriptor.sizeBytes,
    purpose: 'agent-setup-smoke-evidence',
    evidenceFields: input.evidenceFields.map((field) => ({
      id: field.id,
      preview: previewHarnessText(field.value, 120),
    })),
    inspectRoute: `agent_artifacts show artifactId:"${descriptor.id}" includeContent:false`,
  };
}

export function readArtifactMetadataString(artifact: ArtifactDescriptor, key: string): string {
  const value = artifact.metadata[key];
  return typeof value === 'string' ? value : '';
}

export function readArtifactMetadataStringArray(artifact: ArtifactDescriptor, key: string): readonly string[] {
  const value = artifact.metadata[key];
  return Array.isArray(value) ? value.map((entry) => readString(entry)).filter(Boolean) : [];
}

export function setupSmokeEvidenceArtifacts(context: CommandContext): { readonly status: 'available'; readonly artifacts: readonly ArtifactDescriptor[] } | { readonly status: 'unavailable'; readonly reason: string } {
  const artifactStore = setupSmokeArtifactStore(context);
  if (!artifactStore?.list) {
    return {
      status: 'unavailable',
      reason: 'Artifact list support is unavailable in this runtime.',
    };
  }
  const artifacts = artifactStore.list(100)
    .filter((artifact) => readArtifactMetadataString(artifact, 'purpose') === 'agent-setup-smoke-evidence')
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  return { status: 'available', artifacts };
}

export function setupSmokeEvidenceScore(artifact: ArtifactDescriptor): number {
  const result = readArtifactMetadataString(artifact, 'result');
  if (result === 'ready-for-user-run') return 2;
  if (result === 'blocked') return 0;
  return 1;
}

export function setupSmokeEvidenceTrend(artifacts: readonly ArtifactDescriptor[]): string {
  if (artifacts.length === 0) return 'none';
  if (artifacts.length === 1) return 'first-run';
  const latest = setupSmokeEvidenceScore(artifacts[0]!);
  const previous = setupSmokeEvidenceScore(artifacts[1]!);
  if (latest > previous) return 'improving';
  if (latest < previous) return 'regressing';
  const result = readArtifactMetadataString(artifacts[0]!, 'result');
  if (result === 'ready-for-user-run') return 'unchanged-ready';
  if (result === 'blocked') return 'unchanged-blocked';
  return 'unchanged';
}

function artifactCreatedAtIso(artifact: ArtifactDescriptor): string | null {
  const createdAt = artifact.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  return new Date(createdAt).toISOString();
}

export function setupSmokeBlockedCheckFrequency(artifacts: readonly ArtifactDescriptor[]): readonly Record<string, unknown>[] {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    for (const check of readArtifactMetadataStringArray(artifact, 'blockedChecks')) {
      counts.set(check, (counts.get(check) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([checkId, count]) => ({ checkId, count }));
}

export function describeSetupSmokeEvidenceArtifact(artifact: ArtifactDescriptor): Record<string, unknown> {
  return {
    artifactId: artifact.id,
    filename: artifact.filename ?? null,
    capturedAt: readArtifactMetadataString(artifact, 'capturedAt') || safeIso(artifact.createdAt),
    result: readArtifactMetadataString(artifact, 'result') || 'unknown',
    smokeStatus: readArtifactMetadataString(artifact, 'smokeStatus') || 'unknown',
    blockedChecks: readArtifactMetadataStringArray(artifact, 'blockedChecks'),
    userRunChecks: readArtifactMetadataStringArray(artifact, 'userRunChecks'),
    evidenceFields: readArtifactMetadataStringArray(artifact, 'evidenceFields'),
    inspectRoute: `agent_artifacts show artifactId:"${artifact.id}" includeContent:false`,
  };
}

export function latestSetupSmokeEvidence(context: CommandContext): Record<string, unknown> {
  const listed = setupSmokeEvidenceArtifacts(context);
  if (listed.status === 'unavailable') return listed;
  const artifacts = listed.artifacts;
  const latest = artifacts[0];
  if (!latest) {
    return {
      status: 'none',
      reason: 'No saved setup smoke evidence artifact found.',
      saveRoute: DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE,
    };
  }
  return {
    status: 'saved',
    ...describeSetupSmokeEvidenceArtifact(latest),
    rerunRoute: DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE,
  };
}

export function setupSmokeEvidenceHistory(context: CommandContext): Record<string, unknown> {
  const listed = setupSmokeEvidenceArtifacts(context);
  if (listed.status === 'unavailable') return listed;
  const artifacts = listed.artifacts;
  if (artifacts.length === 0) {
    return {
      status: 'none',
      total: 0,
      trend: 'none',
      reason: 'No saved setup smoke evidence artifact found.',
      saveRoute: DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE,
    };
  }
  const resultCounts = artifacts.reduce<Record<string, number>>((counts, artifact) => {
    const result = readArtifactMetadataString(artifact, 'result') || 'unknown';
    counts[result] = (counts[result] ?? 0) + 1;
    return counts;
  }, {});
  return {
    status: 'available',
    total: artifacts.length,
    trend: setupSmokeEvidenceTrend(artifacts),
    latestResult: readArtifactMetadataString(artifacts[0]!, 'result') || 'unknown',
    previousResult: artifacts[1] ? readArtifactMetadataString(artifacts[1], 'result') || 'unknown' : null,
    latestEvidenceId: artifacts[0]!.id,
    latestEvidenceAt: artifactCreatedAtIso(artifacts[0]!),
    resultCounts,
    blockedCheckFrequency: setupSmokeBlockedCheckFrequency(artifacts),
    recent: artifacts.slice(0, 5).map(describeSetupSmokeEvidenceArtifact),
    inspectLatestRoute: `agent_artifacts show artifactId:"${artifacts[0]!.id}" includeContent:false`,
    rerunRoute: DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE,
    saveRoute: DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE,
  };
}

export function setupWizardSmokeHistory(context: CommandContext): AgentSetupWizardSmokeHistory {
  const listed = setupSmokeEvidenceArtifacts(context);
  if (listed.status === 'unavailable') {
    return {
      ...emptyAgentSetupSmokeHistory(listed.reason),
      status: 'unavailable',
    };
  }
  const artifacts = listed.artifacts;
  if (artifacts.length === 0) return emptyAgentSetupSmokeHistory();
  const resultCounts = artifacts.reduce<Record<string, number>>((counts, artifact) => {
    const result = readArtifactMetadataString(artifact, 'result') || 'unknown';
    counts[result] = (counts[result] ?? 0) + 1;
    return counts;
  }, {});
  return {
    status: 'available',
    total: artifacts.length,
    trend: setupSmokeEvidenceTrend(artifacts),
    latestResult: readArtifactMetadataString(artifacts[0]!, 'result') || 'unknown',
    previousResult: artifacts[1] ? readArtifactMetadataString(artifacts[1], 'result') || 'unknown' : null,
    latestEvidenceId: artifacts[0]!.id,
    latestEvidenceAt: artifactCreatedAtIso(artifacts[0]!),
    resultCounts,
    blockedCheckFrequency: setupSmokeBlockedCheckFrequency(artifacts).map((entry) => ({
      checkId: readString(entry.checkId),
      count: typeof entry.count === 'number' ? entry.count : 0,
    })).filter((entry) => entry.checkId && entry.count > 0),
    inspectLatestRoute: `agent_artifacts show artifactId:"${artifacts[0]!.id}" includeContent:false`,
    rerunRoute: DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE,
    saveRoute: DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE,
  };
}

export function setupWizardCheckpoint(context: CommandContext): AgentSetupWizardCheckpoint {
  const routes = {
    markCurrentRoute: DEFAULT_AGENT_SETUP_WIZARD_MARK_CHECKPOINT_ROUTE,
    clearRoute: DEFAULT_AGENT_SETUP_WIZARD_CLEAR_CHECKPOINT_ROUTE,
    inspectRoute: DEFAULT_AGENT_SETUP_WIZARD_INSPECT_CHECKPOINT_ROUTE,
  };
  try {
    const shellPaths = requireShellPaths(context);
    const snapshot = readSetupWizardCheckpoint(shellPaths);
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
  } catch (error) {
    return {
      ...emptyAgentSetupWizardCheckpoint(previewHarnessText(error instanceof Error ? error.message : String(error), 160)),
      ...routes,
      status: 'unavailable',
    };
  }
}

export function setupWizardDurableReceipts(context: CommandContext): readonly AgentSetupWizardDurableReceipt[] {
  const artifactStore = setupSmokeArtifactStore(context);
  const liveReceipts = setupWizardLiveDurableReceipts(context);
  if (!artifactStore?.list) return liveReceipts;
  try {
    return mergeSetupWizardDurableReceipts(buildSetupWizardDurableReceipts(artifactStore.list(100)), liveReceipts);
  } catch {
    return liveReceipts;
  }
}

export function setupCompletionMarkerExists(context: CommandContext): boolean {
  try {
    return readOnboardingCompletionMarker(requireShellPaths(context), 'user').exists;
  } catch {
    return false;
  }
}

export const SETUP_WIZARD_PLAN_BLOCKER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'agent-binary': ['install-smoke', 'connected-host-readiness'],
  'connected-host-status': ['connected-host-readiness'],
  'connected-host-auth': ['connected-host-auth'],
  'provider-model': ['provider-access'],
  'setup-posture': ['install-smoke'],
  'first-assistant-turn': ['install-smoke'],
};

export function setupPlanItemToWizardSource(item: SetupPlanItem): AgentSetupWizardSourceItem {
  const primaryHandoff = setupHandoffsForItem(item)[0];
  return {
    id: item.id,
    label: item.label,
    status: item.status,
    detail: item.nextAction || item.reason,
    userRoute: primaryHandoff?.userRoute ?? item.userRoute,
    modelRoute: primaryHandoff?.modelRoute ?? item.modelRoute,
    actionId: primaryHandoff?.id ?? item.id,
  };
}

export function buildSetupWizard(plan: readonly SetupPlanItem[], context: CommandContext): AgentSetupWizard {
  const markerItem = plan.find((item) => item.id === 'finish-onboarding');
  return buildAgentSetupWizard({
    items: plan.map(setupPlanItemToWizardSource),
    smokeHistory: setupWizardSmokeHistory(context),
    checkpoint: setupWizardCheckpoint(context),
    closeoutCriticalStepIds: plan.filter((item) => item.blocksAutonomy).map((item) => item.id),
    receiptRequiredStepIds: ['connected-host-readiness', 'connected-host-auth', 'install-smoke'],
    durableReceipts: setupWizardDurableReceipts(context),
    setupMarkerExists: markerItem?.status === 'ready' || setupCompletionMarkerExists(context),
    repeatedBlockerAliases: SETUP_WIZARD_PLAN_BLOCKER_ALIASES,
  });
}

export function installSmokeRunSummary(plan: SetupInstallSmokePlan): SetupInstallSmokeRunSummary {
  return {
    ready: plan.checks.filter((check) => check.status === 'ready').length,
    blocked: plan.checks.filter((check) => check.status === 'blocked').length,
    userRun: plan.checks.filter((check) => check.status === 'user-run').length,
    total: plan.checks.length,
  };
}

export function installSmokeRunResult(plan: SetupInstallSmokePlan): 'blocked' | 'ready-for-user-run' {
  return plan.checks.some((check) => check.status === 'blocked') ? 'blocked' : 'ready-for-user-run';
}

export function installSmokeNextAction(plan: SetupInstallSmokePlan): string {
  const blocked = plan.checks.filter((check) => check.status === 'blocked').map((check) => check.id);
  if (blocked.length > 0) return `Resolve blocked checks (${blocked.join(', ')}), then rerun setup action:"smoke".`;
  const userRun = plan.checks.filter((check) => check.status === 'user-run').map((check) => check.id);
  return `Run user-visible checks (${userRun.join(', ')}), then keep the redacted output with the setup evidence.`;
}

export function describeInstallSmokeCheck(check: SetupInstallSmokeCheck, includeParameters: boolean): Record<string, unknown> {
  return {
    id: check.id,
    label: check.label,
    status: check.status,
    evidence: previewHarnessText(check.evidence, includeParameters ? 180 : 120),
    route: previewHarnessText(check.route, includeParameters ? 180 : 120),
    action: check.status === 'blocked'
      ? 'fix-before-smoke'
      : check.status === 'user-run'
        ? 'user-visible-run'
        : 'evidence-ready',
  };
}
