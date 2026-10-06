import { readAgentHostPairing } from '../runtime/connected-host-pairing-store.ts';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { join } from 'node:path';
import { getOrCreateCompanionToken } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { GOODVIBES_AGENT_PAIRING_SURFACE } from '../config/surface.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { requireShellPaths } from '../input/commands/runtime-services.ts';
import { deriveStep1Capabilities, deriveStep1CapabilityFlags } from '../runtime/onboarding/index.ts';
import { connectedHostOperatorTokenFingerprint, connectedHostOperatorTokenPath, readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { clearSetupWizardCheckpoint, saveSetupWizardCheckpoint } from '../agent/setup-wizard-checkpoint.ts';
import { DEFAULT_AGENT_SETUP_WIZARD_CLEAR_CHECKPOINT_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_INSPECT_CHECKPOINT_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_MARK_CHECKPOINT_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE } from '../agent/setup-wizard.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import type { AgentHarnessSetupArgs, SetupResolution } from './agent-harness-setup-posture-types.ts';
import { buildSetupPlan } from './agent-harness-setup-plan.ts';
import { buildSetupWizard, describeInstallSmokeCheck, installSmokeNextAction, installSmokeRunResult, installSmokeRunSummary, latestSetupSmokeEvidence, saveSetupSmokeArtifact, setupCompletionMarkerExists, setupSmokeEvidenceFields, setupSmokeEvidenceHistory } from './agent-harness-setup-smoke.ts';
import { confirmedRepairCandidates, describeCandidate, describeHandoffCard, describeItem, describePlanItem, describeRepairCard, describeRepairDecision, describeServiceLifecycleDecision, nextSetupHandoffSummaries, planSearchText, planSummary, primarySetupRepairDecision, setupRepairTarget } from './agent-harness-setup-describe.ts';
import { setupHandoffsForItem } from './agent-harness-setup-handoffs.ts';
import { collectServicePosture, collectSnapshot, itemSearchText, lookupFromArgs, quoteRouteValue, readLimit, readString, safeFileMode, safeIso, summarizeLocalBehavior } from './agent-harness-setup-posture-utils.ts';

export async function setupPostureCatalogStatus(context: CommandContext): Promise<Record<string, unknown>> {
  const snapshot = await collectSnapshot(context);
  const servicePosture = await collectServicePosture(context);
  const plan = await buildSetupPlan(context, snapshot, deriveStep1Capabilities(snapshot), servicePosture);
  const setupSmokeEvidence = latestSetupSmokeEvidence(context);
  const setupSmokeHistory = setupSmokeEvidenceHistory(context);
  const setupWizard = buildSetupWizard(plan, context);
  return {
    modes: ['setup_posture', 'setup_item', 'setup_repair', 'setup_checkpoint', 'mark_setup_checkpoint', 'clear_setup_checkpoint', 'provision_connected_host_token', 'run_setup_smoke'],
    capabilities: deriveStep1Capabilities(snapshot).length,
    planItems: plan.length,
    blockedPlanItems: plan.filter((item) => item.status === 'blocked').length,
    autonomyBlockers: plan.filter((item) => item.blocksAutonomy && item.status !== 'ready').length,
    nextSetupHandoffs: nextSetupHandoffSummaries(plan, 5),
    setupWizard,
    setupCloseout: setupWizard._diagnostic.closeout,
    collectionIssues: snapshot.collectionIssues.length,
    setupMarkerExists: setupCompletionMarkerExists(context),
    setupSmokeEvidence,
    setupSmokeHistory,
    readOnly: true,
  };
}

export async function setupRepairSummary(context: CommandContext, args: AgentHarnessSetupArgs): Promise<Record<string, unknown>> {
  const snapshot = await collectSnapshot(context);
  const servicePosture = await collectServicePosture(context);
  const plan = await buildSetupPlan(context, snapshot, deriveStep1Capabilities(snapshot), servicePosture);
  const setupWizard = buildSetupWizard(plan, context);
  const includeParameters = args.includeParameters === true;
  const target = setupRepairTarget(plan, setupWizard, args);
  if ('error' in target) return target.error;

  const item = target.item;
  const decision = primarySetupRepairDecision(item);
  const handoffs = setupHandoffsForItem(item);
  const alternatives = handoffs
    .filter((handoff) => handoff.id !== decision.id)
    .slice(0, includeParameters ? 8 : 3)
    .map((handoff) => describeHandoffCard(handoff, includeParameters));
  const confirmedCandidates = confirmedRepairCandidates(item);
  return {
    mode: 'setup_repair',
    capturedAt: new Date(snapshot.capturedAt).toISOString(),
    setupItemId: item.id,
    label: item.label,
    status: item.status,
    blocksAutonomy: item.blocksAutonomy,
    lookup: target.lookup,
    decision: describeRepairDecision(decision, includeParameters),
    nextAction: previewHarnessText(item.nextAction, includeParameters ? 220 : 140),
    userRoute: previewHarnessText(item.userRoute, includeParameters ? 160 : 120),
    modelRoute: previewHarnessText(item.modelRoute, includeParameters ? 160 : 120),
    alternatives,
    ...(confirmedCandidates.length > 0 ? {
      possibleConfirmedRepairs: confirmedCandidates.map((candidate) => describeRepairDecision(candidate, includeParameters)),
    } : {}),
    ...(item.serviceProbe ? { serviceProbe: item.serviceProbe } : {}),
    ...(item.serviceLifecycleDecision ? { serviceLifecycleDecision: describeServiceLifecycleDecision(item.serviceLifecycleDecision) } : {}),
    ...(includeParameters && item.repairCards ? { repairCards: item.repairCards.map(describeRepairCard) } : {}),
    ...(includeParameters && item.bootstrapPlan ? { bootstrapPlan: item.bootstrapPlan } : {}),
    ...(includeParameters && item.authPosture ? { authPosture: item.authPosture } : {}),
    setupWizard: {
      status: setupWizard.status,
      currentStepId: setupWizard.currentStepId,
      currentStepLabel: setupWizard.currentStepLabel,
      closeout: setupWizard._diagnostic.closeout,
    },
    routes: {
      inspectSetup: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
      inspectItem: `setup action:"item" setupItemId:"${quoteRouteValue(item.id)}" includeParameters:true`,
      rerunRepair: `setup action:"repair" setupItemId:"${quoteRouteValue(item.id)}" includeParameters:true`,
    },
    policy: {
      effect: 'read-only-repair-decision',
      boundary: 'This route chooses the safest next setup repair route only. It never starts, installs, restarts, writes tokens, imports settings, or opens UI by itself.',
      confirmation: 'Any returned confirmed-effect route still requires confirm:true and explicitUserRequest tied to the user request.',
      hostOwnership: 'GoodVibes Agent does not take ambient ownership of the GoodVibes host lifecycle. At boot it starts an installed-but-stopped host once through the platform service manager and reports it; beyond that, disconnected hosts use user-run bootstrap guidance, and reachable hosts use daemon receipts before lifecycle mutation.',
    },
  };
}

export async function setupPostureSummary(context: CommandContext, args: AgentHarnessSetupArgs): Promise<Record<string, unknown>> {
  const snapshot = await collectSnapshot(context);
  const servicePosture = await collectServicePosture(context);
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const all = deriveStep1Capabilities(snapshot);
  const plan = await buildSetupPlan(context, snapshot, all, servicePosture);
  const setupSmokeEvidence = latestSetupSmokeEvidence(context);
  const setupSmokeHistory = setupSmokeEvidenceHistory(context);
  const setupWizard = buildSetupWizard(plan, context);
  const filtered = all
    .filter((item) => !query || itemSearchText(item).includes(query))
    .slice(0, readLimit(args.limit, 100));
  const filteredPlan = plan
    .filter((item) => !query || planSearchText(item).includes(query))
    .slice(0, readLimit(args.limit, 100));
  return {
    capturedAt: new Date(snapshot.capturedAt).toISOString(),
    setupMarker: {
      scope: snapshot.acknowledgements.scope,
      exists: snapshot.acknowledgements.exists,
      completionExists: setupCompletionMarkerExists(context),
      updatedAt: safeIso(snapshot.acknowledgements.updatedAt),
      source: snapshot.acknowledgements.source,
      mode: snapshot.acknowledgements.mode ?? null,
      acceptedCount: Object.values(snapshot.acknowledgements.accepted).filter(Boolean).length,
    },
    summary: {
      capabilities: all.length,
      selectedCapabilities: all.filter((item) => item.selected).length,
      collectionIssues: snapshot.collectionIssues.length,
      services: snapshot.services.total,
      oauthProviders: snapshot.services.oauthProviderIds.length,
      subscriptionSessions: snapshot.subscriptions.active.length,
      pendingSubscriptionSessions: snapshot.subscriptions.pending.length,
      providerAccounts: snapshot.providerAccounts?.providers.length ?? 0,
      providerAccountIssues: snapshot.providerAccounts?.issueCount ?? 0,
      secretsStoredKeys: snapshot.secrets.review.storedKeys,
      secretRecordCount: snapshot.secrets.records.length,
      authUsers: snapshot.auth.snapshot.userCount,
      authSessions: snapshot.auth.snapshot.sessionCount,
      enabledSurfaceKinds: snapshot.surfaces.configuredEnabledKinds.length,
      localBehavior: summarizeLocalBehavior(snapshot),
      capabilityFlags: deriveStep1CapabilityFlags(snapshot),
      readinessPlan: planSummary(plan),
      setupSmokeEvidence,
      setupSmokeHistory,
      setupWizard: {
        status: setupWizard.status,
        progressLabel: setupWizard.progressLabel,
        currentStepId: setupWizard.currentStepId,
        currentStepLabel: setupWizard.currentStepLabel,
        repeatedBlocker: setupWizard._diagnostic.repeatedBlocker,
      },
      setupCloseout: setupWizard._diagnostic.closeout,
    },
    setupSmokeEvidence,
    setupSmokeHistory,
    setupWizard,
    setupCloseout: setupWizard._diagnostic.closeout,
    currentRoute: snapshot.providerRouting,
    issues: snapshot.collectionIssues,
    readinessPlan: filteredPlan.map((item) => describePlanItem(item, includeParameters)),
    nextSetupActions: nextSetupHandoffSummaries(plan, 5),
    capabilities: filtered.map((item) => describeItem(item, snapshot, { includeParameters })),
    returned: filtered.length,
    total: all.length,
    policy: 'Read-only setup/onboarding posture. Apply, import, auth, profile, channel, and setting mutations remain confirmation-gated through visible workspace, settings, slash-command, or first-class tool flows.',
  };
}

export async function setupCheckpointSummary(context: CommandContext): Promise<Record<string, unknown>> {
  const snapshot = await collectSnapshot(context);
  const servicePosture = await collectServicePosture(context);
  const plan = await buildSetupPlan(context, snapshot, deriveStep1Capabilities(snapshot), servicePosture);
  const setupWizard = buildSetupWizard(plan, context);
  return {
    mode: 'setup_checkpoint',
    checkpoint: setupWizard._diagnostic.checkpoint,
    currentStep: setupWizard.currentStepId
      ? setupWizard.steps.find((step) => step.id === setupWizard.currentStepId) ?? null
      : null,
    setupWizard: {
      status: setupWizard.status,
      progressLabel: setupWizard.progressLabel,
      currentStepId: setupWizard.currentStepId,
      currentStepLabel: setupWizard.currentStepLabel,
      next: setupWizard.next,
    },
    routes: {
      inspectSetup: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
      markCurrent: DEFAULT_AGENT_SETUP_WIZARD_MARK_CHECKPOINT_ROUTE,
      clear: DEFAULT_AGENT_SETUP_WIZARD_CLEAR_CHECKPOINT_ROUTE,
    },
    policy: 'Read-only checkpoint inspection. Saving or clearing the setup wizard checkpoint requires a confirmed route with explicit user request.',
  };
}

export async function markSetupCheckpoint(context: CommandContext, args: AgentHarnessSetupArgs): Promise<Record<string, unknown>> {
  const snapshot = await collectSnapshot(context);
  const servicePosture = await collectServicePosture(context);
  const plan = await buildSetupPlan(context, snapshot, deriveStep1Capabilities(snapshot), servicePosture);
  const setupWizard = buildSetupWizard(plan, context);
  const requestedStepId = readString(args.setupItemId);
  const step = requestedStepId
    ? setupWizard.steps.find((candidate) => candidate.id === requestedStepId)
    : setupWizard.currentStepId
      ? setupWizard.steps.find((candidate) => candidate.id === setupWizard.currentStepId)
      : null;
  if (!step) {
    return {
      status: 'no_checkpoint_written',
      mode: 'mark_setup_checkpoint',
      reason: requestedStepId
        ? `Unknown setup wizard step ${requestedStepId}.`
        : 'Setup wizard has no current step to checkpoint.',
      setupWizard: {
        status: setupWizard.status,
        currentStepId: setupWizard.currentStepId,
        currentStepLabel: setupWizard.currentStepLabel,
      },
      routes: {
        inspectSetup: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
      },
    };
  }
  if (step.sourceStatus === 'ready') {
    return {
      status: 'no_checkpoint_written',
      mode: 'mark_setup_checkpoint',
      reason: `Setup wizard step ${step.label} is already ready.`,
      step,
      routes: {
        inspectSetup: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
        clear: DEFAULT_AGENT_SETUP_WIZARD_CLEAR_CHECKPOINT_ROUTE,
      },
    };
  }
  const shellPaths = requireShellPaths(context);
  const checkpoint = saveSetupWizardCheckpoint(shellPaths, {
    currentStepId: step.id,
    currentStepLabel: step.label,
    source: 'harness',
    note: 'User-confirmed setup wizard checkpoint.',
  });
  const updatedWizard = buildSetupWizard(plan, context);
  return {
    status: 'checkpoint_saved',
    mode: 'mark_setup_checkpoint',
    explicitUserRequest: previewHarnessText(readString(args.explicitUserRequest), 160),
    step,
    checkpoint,
    setupWizard: {
      status: updatedWizard.status,
      progressLabel: updatedWizard.progressLabel,
      currentStepId: updatedWizard.currentStepId,
      currentStepLabel: updatedWizard.currentStepLabel,
      checkpoint: updatedWizard._diagnostic.checkpoint,
    },
    routes: {
      inspectCheckpoint: DEFAULT_AGENT_SETUP_WIZARD_INSPECT_CHECKPOINT_ROUTE,
      inspectSetup: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
      clear: DEFAULT_AGENT_SETUP_WIZARD_CLEAR_CHECKPOINT_ROUTE,
    },
    policy: {
      effect: 'confirmed-setup-checkpoint-save',
      boundary: 'Only the current setup wizard step id, label, source, timestamp, and generic note were saved in Agent-owned setup state.',
    },
  };
}

export function clearSetupCheckpoint(context: CommandContext, args: AgentHarnessSetupArgs): Record<string, unknown> {
  const shellPaths = requireShellPaths(context);
  const checkpoint = clearSetupWizardCheckpoint(shellPaths);
  return {
    status: 'checkpoint_cleared',
    mode: 'clear_setup_checkpoint',
    explicitUserRequest: previewHarnessText(readString(args.explicitUserRequest), 160),
    checkpoint,
    routes: {
      inspectCheckpoint: DEFAULT_AGENT_SETUP_WIZARD_INSPECT_CHECKPOINT_ROUTE,
      inspectSetup: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
      markCurrent: DEFAULT_AGENT_SETUP_WIZARD_MARK_CHECKPOINT_ROUTE,
    },
    policy: {
      effect: 'confirmed-setup-checkpoint-clear',
      boundary: 'Removed only the Agent-owned setup wizard checkpoint file.',
    },
  };
}

export function provisionConnectedHostOperatorToken(context: CommandContext, args: AgentHarnessSetupArgs): Record<string, unknown> {
  const setupItemId = readString(args.setupItemId);
  if (setupItemId && setupItemId !== 'connected-host-auth') {
    return {
      status: 'unsupported_setup_item',
      usage: 'provision_connected_host_token supports setupItemId:"connected-host-auth" only.',
    };
  }

  const shellPaths = requireShellPaths(context);
  const pairing = readAgentHostPairing(shellPaths.homeDirectory, resolveConnectedHostBaseUrl(context.platform.configManager));
  if (pairing.status !== 'missing') return {
    status: 'blocked', mode: 'provision_connected_host_token', setupItemId: 'connected-host-auth',
    mutation: { performed: false },
    error: 'Agent host-bound pairing already exists or requires review. Use /setup pair; this route will not rewrite shared-token storage to bypass it.',
  };
  const before = readConnectedHostOperatorToken(shellPaths.homeDirectory);
  const explicitUserRequest = readString(args.explicitUserRequest);
  const beforeFingerprint = before.token ? connectedHostOperatorTokenFingerprint(before.token) : null;
  if (before.token && before.path.startsWith('env:')) {
    return {
      status: 'already_usable_env_token',
      mode: 'provision_connected_host_token',
      setupItemId: 'connected-host-auth',
      explicitUserRequest: previewHarnessText(explicitUserRequest, 160),
      token: {
        path: before.path,
        present: true,
        usable: true,
        fingerprint: beforeFingerprint,
        rawValueReturned: false,
      },
      mutation: {
        performed: false,
        reason: 'Environment-provided connected-host token is already effective; no local token file was written.',
      },
      routes: {
        inspectAuth: 'setup action:"item" setupItemId:"connected-host-auth"',
        inspectStatus: 'host action:"status" includeParameters:true',
        pairingPosture: 'agent_harness mode:"pairing_posture" includeParameters:true',
      },
      policy: {
        effect: 'confirmed-local-token-provisioning',
        secrets: 'Raw connected-host tokens are never returned.',
        boundary: 'Environment-provided tokens take precedence and are not modified by this route.',
      },
    };
  }

  const daemonHomeDir = join(shellPaths.homeDirectory, '.goodvibes', 'daemon');
  const canonicalPath = connectedHostOperatorTokenPath(shellPaths.homeDirectory);
  try {
    const record = getOrCreateCompanionToken(GOODVIBES_AGENT_PAIRING_SURFACE, { daemonHomeDir });
    const after = readConnectedHostOperatorToken(shellPaths.homeDirectory);
    if (!after.token) {
      return {
        status: 'failed',
        mode: 'provision_connected_host_token',
        setupItemId: 'connected-host-auth',
        explicitUserRequest: previewHarnessText(explicitUserRequest, 160),
        error: after.error ? previewHarnessText(after.error, 160) : 'SDK token provisioning completed but no usable connected-host token was readable.',
        token: {
          path: after.path,
          present: after.present,
          usable: false,
          rawValueReturned: false,
        },
        routes: {
          inspectAuth: 'setup action:"item" setupItemId:"connected-host-auth"',
          inspectStatus: 'host action:"status" includeParameters:true',
        },
      };
    }
    const afterFingerprint = connectedHostOperatorTokenFingerprint(after.token);
    const changed = beforeFingerprint !== afterFingerprint;
    const result = before.token
      ? changed ? 'repaired' : 'already_usable'
      : before.present ? 'repaired' : 'created';
    return {
      status: result,
      mode: 'provision_connected_host_token',
      setupItemId: 'connected-host-auth',
      explicitUserRequest: previewHarnessText(explicitUserRequest, 160),
      token: {
        path: after.path,
        canonicalPath,
        present: true,
        usable: true,
        fingerprint: afterFingerprint,
        rawValueReturned: false,
        fileMode: safeFileMode(canonicalPath),
      },
      companionRecord: {
        surface: GOODVIBES_AGENT_PAIRING_SURFACE,
        peerId: record.peerId,
        createdAt: safeIso(record.createdAt),
      },
      mutation: {
        performed: result === 'created' || result === 'repaired',
        result,
        existingTokenPreserved: result === 'already_usable',
        source: 'getOrCreateCompanionToken',
      },
      routes: {
        inspectAuth: 'setup action:"item" setupItemId:"connected-host-auth"',
        inspectStatus: 'host action:"status" includeParameters:true',
        pairingPosture: 'agent_harness mode:"pairing_posture" includeParameters:true',
        runSetupSmoke: DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE,
      },
      policy: {
        effect: 'confirmed-local-token-provisioning',
        source: 'SDK platform pairing helper writes the canonical connected-host operator token file with owner-only permissions.',
        secrets: 'Only path, fingerprint, peer id, and timestamps are returned; the raw token is not returned.',
        rotation: 'This route preserves a valid existing token and only creates or repairs the local canonical file.',
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      mode: 'provision_connected_host_token',
      setupItemId: 'connected-host-auth',
      explicitUserRequest: previewHarnessText(explicitUserRequest, 160),
      error: previewHarnessText(error instanceof Error ? error.message : String(error), 160),
      token: {
        path: canonicalPath,
        present: before.present,
        usable: false,
        rawValueReturned: false,
      },
      routes: {
        inspectAuth: 'setup action:"item" setupItemId:"connected-host-auth"',
        inspectStatus: 'host action:"status" includeParameters:true',
      },
      policy: {
        effect: 'confirmed-local-token-provisioning',
        secrets: 'Raw connected-host tokens are never returned.',
      },
    };
  }
}

export async function runSetupInstallSmoke(context: CommandContext, args: AgentHarnessSetupArgs): Promise<Record<string, unknown>> {
  const setupItemId = readString(args.setupItemId);
  if (setupItemId && setupItemId !== 'install-smoke') {
    return {
      status: 'unsupported_setup_item',
      usage: 'run_setup_smoke currently supports setupItemId:"install-smoke" only.',
    };
  }

  const snapshot = await collectSnapshot(context);
  const servicePosture = await collectServicePosture(context);
  const plan = await buildSetupPlan(context, snapshot, deriveStep1Capabilities(snapshot), servicePosture);
  const installSmoke = plan.find((item) => item.id === 'install-smoke');
  const smokePlan = installSmoke?.installSmokePlan;
  if (!smokePlan) {
    return {
      status: 'missing_smoke_plan',
      usage: 'Install smoke plan is not available. Inspect mode:"setup_posture" for setup readiness.',
    };
  }

  const includeParameters = args.includeParameters === true;
  const summary = installSmokeRunSummary(smokePlan);
  const blockedChecks = smokePlan.checks.filter((check) => check.status === 'blocked').map((check) => check.id);
  const userRunChecks = smokePlan.checks.filter((check) => check.status === 'user-run').map((check) => check.id);
  const capturedAt = new Date(snapshot.capturedAt).toISOString();
  const explicitUserRequest = readString(args.explicitUserRequest);
  const evidenceFields = setupSmokeEvidenceFields(args.fields);
  const artifact = await saveSetupSmokeArtifact({
    context,
    capturedAt,
    explicitUserRequest,
    smokePlan,
    summary,
    blockedChecks,
    userRunChecks,
    evidenceFields,
  });
  return {
    status: 'executed',
    mode: 'run_setup_smoke',
    setupItemId: 'install-smoke',
    capturedAt,
    smokeStatus: smokePlan.status,
    result: installSmokeRunResult(smokePlan),
    explicitUserRequest: previewHarnessText(explicitUserRequest, 160),
    summary,
    blockedChecks,
    userRunChecks,
    checks: smokePlan.checks.map((check) => describeInstallSmokeCheck(check, includeParameters)),
    artifact,
    successCriteria: includeParameters ? smokePlan.successCriteria : smokePlan.successCriteria.map((entry) => previewHarnessText(entry, 120)),
    nextAction: installSmokeNextAction(smokePlan),
    routes: {
      inspectSetup: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
      inspectSmoke: 'setup action:"item" setupItemId:"install-smoke"',
      rerunSmoke: DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE,
      saveEvidence: DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE,
    },
    policy: {
      effect: 'confirmed-redacted-setup-smoke',
      shell: 'No package, host, or shell commands were executed implicitly.',
      secrets: 'Secrets and connected-host tokens are never returned; token evidence remains presence, path, and fingerprint only.',
      source: smokePlan.policy,
    },
    source: smokePlan.source,
  };
}

export async function describeHarnessSetupItem(context: CommandContext, args: AgentHarnessSetupArgs): Promise<SetupResolution> {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'setup_item requires setupItemId, target, or query. Use mode:"setup_posture" to inspect setup item ids.',
    };
  }
  const snapshot = await collectSnapshot(context);
  const servicePosture = await collectServicePosture(context);
  const items = deriveStep1Capabilities(snapshot);
  const plan = await buildSetupPlan(context, snapshot, items, servicePosture);
  const normalized = lookup.input.toLowerCase();
  const exact = items.find((item) => item.id === lookup.input);
  if (exact) return { status: 'found', item: describeItem(exact, snapshot, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'id' } }) };
  const exactPlan = plan.find((item) => item.id === lookup.input);
  if (exactPlan) return { status: 'found', item: { ...describePlanItem(exactPlan, true), lookup: { ...lookup, resolvedBy: 'plan-id' } } };
  const insensitive = items.find((item) => item.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', item: describeItem(insensitive, snapshot, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } }) };
  const insensitivePlan = plan.find((item) => item.id.toLowerCase() === normalized);
  if (insensitivePlan) return { status: 'found', item: { ...describePlanItem(insensitivePlan, true), lookup: { ...lookup, resolvedBy: 'case-insensitive-plan-id' } } };
  const searched = items.filter((item) => itemSearchText(item).includes(normalized));
  const searchedPlan = plan.filter((item) => planSearchText(item).includes(normalized));
  if (searched.length === 1 && searchedPlan.length === 0) return { status: 'found', item: describeItem(searched[0]!, snapshot, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' } }) };
  if (searched.length === 0 && searchedPlan.length === 1) return { status: 'found', item: { ...describePlanItem(searchedPlan[0]!, true), lookup: { ...lookup, resolvedBy: 'plan-search' } } };
  if (searched.length > 0 || searchedPlan.length > 0) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: [
        ...searched.map(describeCandidate),
        ...searchedPlan.map((item) => describePlanItem(item, false)),
      ].slice(0, 8),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown setup item ${lookup.input}. Use mode:"setup_posture" to inspect setup item ids.`,
  };
}
