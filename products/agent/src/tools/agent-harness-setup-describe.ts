import type { OnboardingStep1CapabilityItem } from '../runtime/onboarding/index.ts';
import type { AgentSetupWizard } from '../agent/setup-wizard.ts';
import { DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE } from '../agent/setup-wizard.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { setupHandoffsForItem } from './agent-harness-setup-handoffs.ts';
import { collectSnapshot, lookupFromArgs, readLimit, safeIso, summarizeLocalBehavior } from './agent-harness-setup-posture-utils.ts';
import type { AgentHarnessSetupArgs, SetupHandoffCard, SetupPlanItem, SetupRepairCard, SetupRepairDecision, SetupServiceLifecycleDecision } from './agent-harness-setup-posture-types.ts';

export function planSearchText(item: SetupPlanItem): string {
  return [
    item.id,
    item.label,
    item.status,
    item.reason,
    item.nextAction,
    item.userRoute,
    item.modelRoute,
    item.relatedSetupItemId ?? '',
    item.signals?.join('\n') ?? '',
    JSON.stringify(item.localModelReadiness ?? {}),
    setupHandoffsForItem(item).map((handoff) => [
      handoff.id,
      handoff.label,
      handoff.kind,
      handoff.effect,
      handoff.modelRoute,
      handoff.userRoute,
      handoff.nextStep,
      handoff.safety,
      handoff.prerequisite ?? '',
    ].join(' ')).join('\n'),
    item.repairCards?.map((card) => [
      card.id,
      card.label,
      card.state,
      card.effect,
      card.methodId ?? '',
      card.modelRoute ?? '',
      card.prerequisite ?? '',
      card.recommendation,
      card.liveEvidence?.probeStatus ?? '',
      card.liveEvidence?.summary ?? '',
      card.recommendedWhen,
      card.safety,
    ].join(' ')).join('\n') ?? '',
    JSON.stringify(item.serviceLifecycleDecision ?? {}),
    JSON.stringify(item.serviceProbe ?? {}),
    JSON.stringify(item.authPosture ?? {}),
    JSON.stringify(item.installSmokePlan ?? {}),
    JSON.stringify(item.sudoPosture ?? {}),
  ].join('\n').toLowerCase();
}

export function describeRepairCard(card: SetupRepairCard): Record<string, unknown> {
  return {
    id: card.id,
    label: card.label,
    state: card.state,
    effect: card.effect,
    recommendation: card.recommendation,
    ...(card.methodId ? { methodId: card.methodId } : {}),
    ...(card.modelRoute ? { modelRoute: card.modelRoute } : {}),
    userRoute: card.userRoute,
    ...(card.prerequisite ? { prerequisite: previewHarnessText(card.prerequisite, 140) } : {}),
    ...(card.liveEvidence ? { liveEvidence: {
      probeStatus: card.liveEvidence.probeStatus,
      summary: previewHarnessText(card.liveEvidence.summary, 160),
    } } : {}),
    ...(card.outcome ? { outcome: {
      target: card.outcome.target,
      successCriteria: card.outcome.successCriteria.map((criterion) => previewHarnessText(criterion, 160)),
      evidenceFields: card.outcome.evidenceFields,
      verificationRoute: previewHarnessText(card.outcome.verificationRoute, 160),
      recoveryRoute: previewHarnessText(card.outcome.recoveryRoute, 160),
    } } : {}),
    recommendedWhen: previewHarnessText(card.recommendedWhen, 160),
    safety: previewHarnessText(card.safety, 160),
  };
}

export function describeServiceLifecycleDecision(decision: SetupServiceLifecycleDecision): Record<string, unknown> {
  return {
    status: decision.status,
    recommendedAction: decision.recommendedAction,
    modelRoute: previewHarnessText(decision.modelRoute, 160),
    reason: previewHarnessText(decision.reason, 180),
    evidence: decision.evidence,
    receiptRules: decision.receiptRules,
    blockedMutations: decision.blockedMutations,
  };
}

export function describeHandoffCard(card: SetupHandoffCard, includeParameters: boolean): Record<string, unknown> {
  return {
    id: card.id,
    label: card.label,
    kind: card.kind,
    effect: card.effect,
    userRoute: previewHarnessText(card.userRoute, includeParameters ? 140 : 96),
    modelRoute: previewHarnessText(card.modelRoute, includeParameters ? 220 : 120),
    nextStep: previewHarnessText(card.nextStep, includeParameters ? 180 : 120),
    safety: previewHarnessText(card.safety, includeParameters ? 180 : 120),
    ...(card.requiresConfirmation ? { requiresConfirmation: true } : {}),
    ...(card.prerequisite ? { prerequisite: previewHarnessText(card.prerequisite, includeParameters ? 160 : 100) } : {}),
  };
}

export function describeRepairDecision(decision: SetupRepairDecision, includeParameters: boolean): Record<string, unknown> {
  return {
    id: decision.id,
    label: decision.label,
    status: decision.status,
    effect: decision.effect,
    modelRoute: previewHarnessText(decision.modelRoute, includeParameters ? 220 : 140),
    userRoute: previewHarnessText(decision.userRoute, includeParameters ? 160 : 120),
    nextStep: previewHarnessText(decision.nextStep, includeParameters ? 220 : 140),
    reason: previewHarnessText(decision.reason, includeParameters ? 220 : 140),
    safety: previewHarnessText(decision.safety, includeParameters ? 220 : 140),
    ...(decision.requiresConfirmation ? { requiresConfirmation: true } : {}),
    ...(decision.prerequisite ? { prerequisite: previewHarnessText(decision.prerequisite, includeParameters ? 180 : 120) } : {}),
  };
}

export function setupRepairDecisionFromCard(
  card: SetupRepairCard,
  status: SetupRepairDecision['status'],
  nextStep: string,
): SetupRepairDecision | null {
  if (!card.modelRoute) return null;
  return {
    id: card.id,
    label: card.label,
    status,
    effect: card.effect,
    modelRoute: card.modelRoute,
    userRoute: card.userRoute,
    nextStep,
    reason: card.liveEvidence?.summary ?? card.recommendedWhen,
    safety: card.safety,
    ...(card.effect === 'confirmed-effect' ? { requiresConfirmation: true } : {}),
    ...(card.prerequisite ? { prerequisite: card.prerequisite } : {}),
  };
}

export function setupRepairDecisionFromHandoff(
  handoff: SetupHandoffCard,
  status: SetupRepairDecision['status'],
  reason: string,
): SetupRepairDecision {
  return {
    id: handoff.id,
    label: handoff.label,
    status,
    effect: handoff.effect,
    modelRoute: handoff.modelRoute,
    userRoute: handoff.userRoute,
    nextStep: handoff.nextStep,
    reason,
    safety: handoff.safety,
    ...(handoff.requiresConfirmation ? { requiresConfirmation: true } : {}),
    ...(handoff.prerequisite ? { prerequisite: handoff.prerequisite } : {}),
  };
}

export function repairCardById(item: SetupPlanItem, id: string): SetupRepairCard | null {
  return item.repairCards?.find((card) => card.id === id) ?? null;
}

export function confirmedRepairCandidates(item: SetupPlanItem): readonly SetupRepairDecision[] {
  return (item.repairCards ?? [])
    .filter((card) => card.state === 'available' && card.effect === 'confirmed-effect' && card.recommendation !== 'not-needed' && card.modelRoute)
    .map((card) => setupRepairDecisionFromCard(
      card,
      'confirmed-repair-available',
      'Run only after read-only status evidence proves this exact service lifecycle mutation is needed.',
    ))
    .filter((decision): decision is SetupRepairDecision => decision !== null);
}

export function primarySetupRepairDecision(item: SetupPlanItem): SetupRepairDecision {
  if (item.id === 'connected-host-auth') {
    const handoff = setupHandoffsForItem(item)[0];
    if (handoff) {
      return setupRepairDecisionFromHandoff(
        handoff,
        handoff.requiresConfirmation ? 'confirmed-repair-available' : 'inspect-first',
        item.authPosture?.operatorToken.usable
          ? 'Connected-host token is usable; verify protected daemon route readiness before relying on automation.'
          : 'Connected-host token is missing or unusable; token provisioning is the narrow confirmed repair.',
      );
    }
  }

  if (item.id === 'connected-host-readiness') {
    const lifecycle = item.serviceLifecycleDecision;
    if (lifecycle?.status === 'bootstrap-first') {
      return {
        id: 'connected-host-bootstrap',
        label: 'Show host bootstrap checklist',
        status: 'user-run-bootstrap',
        effect: 'user-run',
        modelRoute: 'setup action:"item" setupItemId:"connected-host-readiness" includeParameters:true',
        userRoute: item.userRoute,
        nextStep: 'Show the user-run Bun install, GoodVibes host install/start, binary verification, and reconnect checks for the owning host.',
        reason: lifecycle.reason,
        safety: item.bootstrapPlan?.policy ?? 'Bootstrap remains user-run guidance; Agent does not start or install the owning host implicitly.',
      };
    }

    if (lifecycle?.status === 'needs-status-receipt') {
      const statusCard = repairCardById(item, 'service-status');
      const decision = statusCard
        ? setupRepairDecisionFromCard(
          statusCard,
          'inspect-first',
          'Read services.status first; choose install, start, restart, or no mutation only from that receipt.',
        )
        : null;
      if (decision) return decision;
    }

    if (lifecycle?.status === 'status-route-unavailable') {
      const posture = repairCardById(item, 'service-posture');
      const decision = posture
        ? setupRepairDecisionFromCard(
          posture,
          'inspect-first',
          'Inspect endpoint binding, reachability, and logs because the daemon contract does not publish services.status.',
        )
        : null;
      if (decision) return decision;
    }

    if (lifecycle?.status === 'no-lifecycle-action') {
      const status = repairCardById(item, 'connected-host-status');
      const decision = status
        ? setupRepairDecisionFromCard(
          status,
          'ready',
          'Runtime is reachable; inspect host readiness and avoid install/start/restart unless later diagnostics prove a gap.',
        )
        : null;
      if (decision) return decision;
    }
  }

  const handoff = setupHandoffsForItem(item)[0];
  if (handoff) {
    return setupRepairDecisionFromHandoff(
      handoff,
      handoff.requiresConfirmation ? 'confirmed-repair-available' : item.status === 'ready' ? 'ready' : 'inspect-first',
      item.reason,
    );
  }

  return {
    id: `${item.id}-inspect`,
    label: `Inspect ${item.label}`,
    status: item.status === 'ready' ? 'ready' : 'inspect-first',
    effect: 'read-only',
    modelRoute: item.modelRoute,
    userRoute: item.userRoute,
    nextStep: item.nextAction,
    reason: item.reason,
    safety: 'Read-only setup inspection. Mutating routes remain separate and confirmation-gated.',
  };
}

export function setupRepairPlanCandidates(plan: readonly SetupPlanItem[], input: string): readonly SetupPlanItem[] {
  const normalized = input.toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  const scored = plan
    .map((item, index) => {
      const id = item.id.toLowerCase();
      const label = item.label.toLowerCase();
      const text = planSearchText(item);
      let score = 0;
      if (id === normalized || label === normalized) score += 10_000;
      if (id.includes(normalized) || label.includes(normalized)) score += 3_000;
      for (const token of tokens) {
        if (id.includes(token)) score += 1_000;
        if (label.includes(token)) score += 700;
        if (text.includes(token)) score += 120;
      }
      if (item.blocksAutonomy && item.status !== 'ready') score += 200;
      if (item.status === 'blocked') score += 120;
      if (item.status === 'check') score += 60;
      return { item, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.item.priority - right.item.priority || left.index - right.index);
  return scored.map((entry) => entry.item);
}

export function defaultSetupRepairItem(plan: readonly SetupPlanItem[], wizard: AgentSetupWizard): SetupPlanItem | null {
  const current = wizard.currentStepId
    ? plan.find((item) => item.id === wizard.currentStepId)
    : null;
  if (current) return current;
  return plan.find((item) => item.blocksAutonomy && item.status !== 'ready')
    ?? plan.find((item) => item.status === 'blocked')
    ?? plan.find((item) => item.status === 'check')
    ?? plan.find((item) => item.status === 'recommended')
    ?? plan[0]
    ?? null;
}

export function setupRepairTarget(
  plan: readonly SetupPlanItem[],
  wizard: AgentSetupWizard,
  args: AgentHarnessSetupArgs,
): { readonly item: SetupPlanItem; readonly lookup: Record<string, unknown> } | { readonly error: Record<string, unknown> } {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    const item = defaultSetupRepairItem(plan, wizard);
    if (!item) {
      return {
        error: {
          status: 'no_setup_items',
          usage: 'No setup repair target is available. Inspect setup action:"status".',
        },
      };
    }
    return {
      item,
      lookup: {
        source: 'setup_wizard',
        resolvedBy: wizard.currentStepId === item.id ? 'current-step' : 'first-actionable-plan-item',
      },
    };
  }

  const normalized = lookup.input.toLowerCase();
  const exact = plan.find((item) => item.id === lookup.input);
  if (exact) return { item: exact, lookup: { ...lookup, resolvedBy: 'plan-id' } };
  const insensitive = plan.find((item) => item.id.toLowerCase() === normalized);
  if (insensitive) return { item: insensitive, lookup: { ...lookup, resolvedBy: 'case-insensitive-plan-id' } };
  const candidates = setupRepairPlanCandidates(plan, lookup.input);
  if (candidates.length === 1) return { item: candidates[0]!, lookup: { ...lookup, resolvedBy: 'repair-search' } };
  if (candidates.length > 1) {
    const best = candidates[0]!;
    return {
      item: best,
      lookup: {
        ...lookup,
        resolvedBy: 'ranked-repair-search',
        candidates: candidates.slice(0, 6).map((item) => ({
          setupItemId: item.id,
          label: item.label,
          status: item.status,
          modelRoute: item.modelRoute,
        })),
      },
    };
  }
  return {
    error: {
      status: 'missing_lookup',
      usage: `Unknown setup repair target ${lookup.input}. Use setup action:"status" to inspect setup item ids.`,
    },
  };
}

export function describePlanItem(item: SetupPlanItem, includeParameters: boolean): Record<string, unknown> {
  const availableRepairCards = item.repairCards
    ?.filter((card) => card.state === 'available')
    .map((card) => card.id);
  const recommendedRepairCards = item.repairCards
    ?.filter((card) => card.state === 'available' && card.recommendation === 'recommended')
    .map((card) => card.id);
  const handoffs = setupHandoffsForItem(item);
  const primaryHandoff = handoffs[0];
  return {
    setupItemId: item.id,
    label: item.label,
    status: item.status,
    priority: item.priority,
    blocksAutonomy: item.blocksAutonomy,
    summary: previewHarnessText(item.reason, includeParameters ? 180 : 96),
    nextAction: previewHarnessText(item.nextAction, includeParameters ? 180 : 96),
    userRoute: previewHarnessText(item.userRoute, includeParameters ? 140 : 96),
    modelRoute: previewHarnessText(item.modelRoute, includeParameters ? 140 : 96),
    ...(primaryHandoff ? { primaryHandoff: describeHandoffCard(primaryHandoff, includeParameters) } : {}),
    ...(item.relatedSetupItemId ? { relatedSetupItemId: item.relatedSetupItemId } : {}),
    ...(item.signals && item.signals.length > 0 ? { signals: item.signals.slice(0, includeParameters ? 10 : 3) } : {}),
    ...(availableRepairCards && availableRepairCards.length > 0 ? { availableRepairCards } : {}),
    ...(recommendedRepairCards && recommendedRepairCards.length > 0 ? { recommendedRepairCards } : {}),
    ...(item.bootstrapPlan ? { bootstrapRoute: 'setup action:"item" setupItemId:"connected-host-readiness"' } : {}),
    ...(includeParameters && item.serviceProbe ? { serviceProbe: item.serviceProbe } : {}),
    ...(includeParameters && item.serviceLifecycleDecision ? { serviceLifecycleDecision: describeServiceLifecycleDecision(item.serviceLifecycleDecision) } : {}),
    ...(includeParameters && item.authPosture ? { authPosture: item.authPosture } : {}),
    ...(includeParameters && item.installSmokePlan ? { installSmokePlan: item.installSmokePlan } : {}),
    ...(includeParameters && item.localModelReadiness ? { localModelReadiness: item.localModelReadiness } : {}),
    ...(includeParameters && item.vibeHealth ? { vibeHealth: item.vibeHealth } : {}),
    ...(includeParameters && item.sudoPosture ? { sudoPosture: item.sudoPosture } : {}),
    ...(includeParameters && handoffs.length > 0 ? { handoffs: handoffs.map((handoff) => describeHandoffCard(handoff, true)) } : {}),
    ...(includeParameters && item.repairCards && item.repairCards.length > 0 ? { repairCards: item.repairCards.map(describeRepairCard) } : {}),
    ...(includeParameters && item.bootstrapPlan ? { bootstrapPlan: item.bootstrapPlan } : {}),
    ...(includeParameters ? {
      policy: {
        effect: 'read-only',
        mutation: 'Setup plan rows only point to visible setup, status, settings, read-only diagnostics, and confirmed tool routes. Destructive service stop/uninstall actions are intentionally excluded from first-run repair cards.',
      },
    } : {}),
  };
}

export function planSummary(plan: readonly SetupPlanItem[]): Record<string, number> {
  return {
    ready: plan.filter((item) => item.status === 'ready').length,
    blocked: plan.filter((item) => item.status === 'blocked').length,
    recommended: plan.filter((item) => item.status === 'recommended').length,
    optional: plan.filter((item) => item.status === 'optional').length,
    check: plan.filter((item) => item.status === 'check').length,
    blocksAutonomy: plan.filter((item) => item.blocksAutonomy && item.status !== 'ready').length,
  };
}

export function nextSetupHandoffSummaries(plan: readonly SetupPlanItem[], limit: number): readonly Record<string, unknown>[] {
  return plan
    .filter((item) => item.status === 'blocked' || item.status === 'check' || item.status === 'recommended')
    .slice(0, limit)
    .map((item) => {
      const primaryHandoff = setupHandoffsForItem(item)[0];
      return {
        setupItemId: item.id,
        label: item.label,
        status: item.status,
        nextAction: previewHarnessText(item.nextAction, 140),
        modelRoute: previewHarnessText(item.modelRoute, 96),
        ...(primaryHandoff ? {
          handoffLabel: primaryHandoff.label,
          handoffKind: primaryHandoff.kind,
          handoffRoute: previewHarnessText(primaryHandoff.modelRoute, 140),
          handoffUserRoute: previewHarnessText(primaryHandoff.userRoute, 120),
          ...(primaryHandoff.requiresConfirmation ? { requiresConfirmation: true } : {}),
        } : {}),
      };
    });
}

export function signalsForItem(
  item: OnboardingStep1CapabilityItem,
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
): Record<string, unknown> {
  if (item.id === 'provider-access') {
    return {
      currentRoute: snapshot.providerRouting,
      providerAccounts: {
        providers: snapshot.providerAccounts?.providers.length ?? 0,
        configured: snapshot.providerAccounts?.configuredCount ?? 0,
        issues: snapshot.providerAccounts?.issueCount ?? 0,
      },
      subscriptions: {
        active: snapshot.subscriptions.active.length,
        pending: snapshot.subscriptions.pending.length,
        activeProviderIds: snapshot.subscriptions.activeProviderIds,
        pendingProviderIds: snapshot.subscriptions.pendingProviderIds,
      },
      credentialReferences: snapshot.secrets.records.length,
    };
  }
  if (item.id === 'local-behavior') {
    return summarizeLocalBehavior(snapshot);
  }
  if (item.id === 'communication-channels') {
    return {
      configuredEnabledKinds: snapshot.surfaces.configuredEnabledKinds,
      surfaces: snapshot.surfaces.records.map((surface) => ({
        id: surface.id,
        kind: surface.kind,
        label: surface.label,
        enabled: surface.enabled,
        state: surface.state,
        capabilities: surface.capabilities,
      })),
    };
  }
  if (item.id === 'automation-review') {
    return {
      permissionsMode: snapshot.runtimeDefaults.permissionsMode,
      helperEnabled: snapshot.providerRouting.helperEnabled,
      toolLlmEnabled: snapshot.providerRouting.toolLlmEnabled,
    };
  }
  if (item.id === 'operator-terminal') {
    return {
      display: snapshot.runtimeDefaults.display,
      setupMarker: {
        scope: snapshot.acknowledgements.scope,
        exists: snapshot.acknowledgements.exists,
        updatedAt: safeIso(snapshot.acknowledgements.updatedAt),
        source: snapshot.acknowledgements.source,
        mode: snapshot.acknowledgements.mode ?? null,
      },
      collectionIssues: snapshot.collectionIssues,
    };
  }
  return {
    status: item.selected ? 'covered' : 'available',
  };
}

export function describeItem(
  item: OnboardingStep1CapabilityItem,
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
  options: {
    readonly includeParameters?: boolean;
    readonly lookup?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    setupItemId: item.id,
    label: item.label,
    selected: item.selected,
    modelRoute: setupItemModelRoute(),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters
      ? {
        detail: item.detail,
        signals: signalsForItem(item, snapshot),
        policy: {
          effect: 'read-only',
          values: 'Setup posture returns onboarding readiness, counts, safe setting keys, and route metadata only; secret values and raw provider tokens are never returned.',
          mutation: 'Setup apply, provider auth, local behavior import/create, channel delivery, and starter profile changes stay visible workspace, settings, slash-command, or first-class tool flows.',
        },
        modelAccess: {
          inspectSetup: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
          inspectSetupItem: 'setup action:"item"',
          openOnboarding: 'agent_harness mode:"open_ui_surface" surfaceId:"onboarding" confirm:true explicitUserRequest:"..."',
          setupWorkspace: 'agent_harness mode:"workspace_action" target:"setup"',
          settings: 'settings action:"list|get|set|reset"; compatibility detail remains in agent_harness settings modes',
          providerRouting: 'models action:"status"',
          providerAccounts: 'models action:"providers"',
          channels: 'channels action:"status"',
          media: 'agent_harness mode:"media_posture"',
          security: 'agent_harness mode:"security_posture"',
        },
      }
      : {
        summary: previewHarnessText(item.detail),
      }),
  };
}

export function setupItemModelRoute(): string {
  return 'setup action:"item" or agent_harness mode:"open_ui_surface"';
}

export function describeCandidate(item: OnboardingStep1CapabilityItem): Record<string, unknown> {
  return {
    setupItemId: item.id,
    label: item.label,
    selected: item.selected,
    modelRoute: setupItemModelRoute(),
  };
}
