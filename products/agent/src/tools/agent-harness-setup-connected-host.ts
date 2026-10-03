import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { requireShellPaths } from '../input/commands/runtime-services.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { CliServicePosture } from '../cli/service-posture.ts';
import { connectedHostOperatorTokenFingerprint, readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { operatorMethodRoute, provisionConnectedHostTokenRoute } from './agent-harness-setup-posture-utils.ts';
import type { OperatorContractMethod, SetupBootstrapPlan, SetupConnectedHostAuthPosture, SetupPlanStatus, SetupRepairCard, SetupRepairCardEffect, SetupRepairLiveEvidence, SetupRepairOutcome, SetupRepairRecommendation, SetupRepairCardState, SetupServiceLifecycleDecision, SetupServiceProbe, SetupServiceProbeStatus } from './agent-harness-setup-posture-types.ts';
import type { collectSnapshot } from './agent-harness-setup-posture-utils.ts';

export function connectedHostServiceProbe(posture: CliServicePosture | null): SetupServiceProbe {
  const endpoint = posture?.endpoints.find((candidate) => candidate.id === 'controlPlane');
  if (!posture || !endpoint) {
    return {
      status: 'not-probed',
      endpointId: 'controlPlane',
      label: 'runtime connection',
      enabled: false,
      binding: '(unavailable)',
      diagnosticRoute: 'host action:"services" includeParameters:true',
      issues: ['Service posture probe is unavailable in this runtime.'],
    };
  }
  const binding = `${endpoint.binding.host}:${endpoint.binding.port}`;
  const status: SetupServiceProbeStatus = !endpoint.enabled
    ? 'not-enabled'
    : endpoint.reachable === true
      ? 'reachable'
      : endpoint.reachable === false
        ? 'unreachable'
        : 'not-probed';
  return {
    status,
    endpointId: endpoint.id,
    label: endpoint.label,
    enabled: endpoint.enabled,
    binding,
    diagnosticRoute: 'host action:"service" endpointId:"controlPlane" includeParameters:true',
    issues: posture.issues,
  };
}

export function serviceProbeSignal(probe: SetupServiceProbe): string {
  return `runtime connection probe: ${probe.status} ${probe.binding}`;
}

export function repairLiveEvidence(probe: SetupServiceProbe, summary: string): SetupRepairLiveEvidence {
  return {
    probeStatus: probe.status,
    summary,
  };
}

export function lifecycleRepairRecommendation(probe: SetupServiceProbe): SetupRepairRecommendation {
  if (probe.status === 'reachable') return 'not-needed';
  if (probe.status === 'unreachable') return 'inspect-first';
  return 'inspect-first';
}

export function hostSetupStatus(snapshot: Awaited<ReturnType<typeof collectSnapshot>>, probe: SetupServiceProbe): SetupPlanStatus {
  if (snapshot.collectionIssues.some((issue) => issue.area === 'host')) return 'blocked';
  if (probe.status === 'unreachable') return 'blocked';
  return 'check';
}

export function connectedHostAuthPosture(
  context: CommandContext,
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
): SetupConnectedHostAuthPosture {
  const shellPaths = requireShellPaths(context);
  const token = readConnectedHostOperatorToken(shellPaths.homeDirectory);
  const usable = Boolean(token.token);
  return {
    owner: 'connected-host',
    operatorToken: {
      present: token.present,
      usable,
      path: token.path,
      ...(token.token ? { fingerprint: connectedHostOperatorTokenFingerprint(token.token) } : {}),
      ...(token.error ? { error: previewHarnessText(token.error, 120) } : {}),
    },
    compatibilityAuth: {
      userStorePath: snapshot.auth.snapshot.userStorePath,
      userStorePresent: snapshot.auth.snapshot.persisted,
      bootstrapCredentialPath: snapshot.auth.snapshot.bootstrapCredentialPath,
      bootstrapCredentialPresent: snapshot.auth.snapshot.bootstrapCredentialPresent,
      users: snapshot.auth.snapshot.userCount,
      sessions: snapshot.auth.snapshot.sessionCount,
    },
    routes: {
      reviewCommand: '/auth review',
      connectedHostStatus: 'host action:"status" includeParameters:true',
      pairingPosture: 'agent_harness mode:"pairing_posture" includeParameters:true',
      qrPairingRoute: 'agent_harness mode:"pairing_route" pairingRouteId:"qr-pairing"',
      manualTokenRoute: 'agent_harness mode:"pairing_route" pairingRouteId:"manual-token-display"',
      provisionTokenRoute: provisionConnectedHostTokenRoute(),
      tokenProvisioningOwner: 'connected GoodVibes host canonical token store',
      tokenProvisioningSource: 'SDK getOrCreateCompanionToken writes ~/.goodvibes/daemon/operator-tokens.json with mode 0600; Agent exposes it only through confirmed setup and never returns the raw token',
    },
  };
}

export function connectedHostAuthStatus(posture: SetupConnectedHostAuthPosture): SetupPlanStatus {
  if (!posture.operatorToken.usable) return 'blocked';
  if (posture.compatibilityAuth.bootstrapCredentialPresent) return 'check';
  return 'ready';
}

export function connectedHostAuthNextAction(posture: SetupConnectedHostAuthPosture): string {
  if (!posture.operatorToken.present) {
    return 'Run the confirmed connected-host token provisioning route, inspect pairing posture for visible handoff routes, then rerun auth review and connected-host status.';
  }
  if (!posture.operatorToken.usable) {
    return 'Run the confirmed connected-host token provisioning route to repair the local token file, then rerun auth review and connected-host status.';
  }
  if (posture.compatibilityAuth.bootstrapCredentialPresent) {
    return 'Review auth status and clear or rotate the compatibility bootstrap credential through the owning GoodVibes host if it is no longer needed.';
  }
  return 'Verify the token against connected-host status and Agent Knowledge readiness before relying on protected daemon routes.';
}

export function connectedHostAuthSignals(posture: SetupConnectedHostAuthPosture): readonly string[] {
  return [
    `operator token: ${posture.operatorToken.usable ? 'usable' : posture.operatorToken.present ? 'present but unusable' : 'missing'} (${posture.operatorToken.path})`,
    ...(posture.operatorToken.fingerprint ? [`operator token fingerprint: ${posture.operatorToken.fingerprint}`] : []),
    ...(posture.operatorToken.error ? [`operator token parse error: ${posture.operatorToken.error}`] : []),
    `token provisioning route: ${posture.routes.provisionTokenRoute}`,
    `compatibility auth users: ${posture.compatibilityAuth.users}`,
    `compatibility auth sessions: ${posture.compatibilityAuth.sessions}`,
    `bootstrap credential: ${posture.compatibilityAuth.bootstrapCredentialPresent ? 'present' : 'missing'} (${posture.compatibilityAuth.bootstrapCredentialPath})`,
    `token provisioning owner: ${posture.routes.tokenProvisioningOwner}`,
    `token provisioning source: ${posture.routes.tokenProvisioningSource}`,
  ];
}

export function operatorMethodIds(): ReadonlySet<string> {
  const contract = getOperatorContract();
  const methods = Array.isArray(contract.operator?.methods)
    ? contract.operator.methods as OperatorContractMethod[]
    : [];
  return new Set(methods.map((method) => method.id).filter(Boolean));
}

export function setupRepairCard(
  methodIds: ReadonlySet<string>,
  options: {
    readonly id: string;
    readonly label: string;
    readonly methodId?: string;
    readonly effect: SetupRepairCardEffect;
    readonly userRoute: string;
    readonly prerequisite?: string;
    readonly recommendation?: SetupRepairRecommendation;
    readonly liveEvidence?: SetupRepairLiveEvidence;
    readonly outcome?: SetupRepairOutcome;
    readonly recommendedWhen: string;
    readonly safety: string;
    readonly liveHostRequired?: boolean;
  },
): SetupRepairCard {
  const methodPresent = options.methodId ? methodIds.has(options.methodId) : true;
  const state: SetupRepairCardState = !methodPresent
    ? 'missing'
    : options.liveHostRequired
      ? 'requires-live-host'
      : 'available';
  return {
    id: options.id,
    label: options.label,
    state,
    effect: options.effect,
    ...(options.methodId ? { methodId: options.methodId } : {}),
    ...(options.methodId && methodPresent ? { modelRoute: operatorMethodRoute(options.methodId, options.effect === 'confirmed-effect') } : {}),
    userRoute: options.userRoute,
    ...(options.prerequisite ? { prerequisite: options.prerequisite } : {}),
    recommendation: !methodPresent || state === 'requires-live-host' ? 'unavailable' : options.recommendation ?? 'inspect-first',
    ...(options.liveEvidence ? { liveEvidence: options.liveEvidence } : {}),
    ...(options.outcome ? { outcome: options.outcome } : {}),
    recommendedWhen: options.recommendedWhen,
    safety: options.safety,
  };
}

export function serviceRepairOutcome(methodId: 'services.status' | 'services.install' | 'services.start' | 'services.restart'): SetupRepairOutcome {
  const common = {
    evidenceFields: ['installed', 'autostart', 'running', 'pid', 'lastAction', 'actionError', 'network.controlPlane.ready'],
    verificationRoute: operatorMethodRoute('services.status', false),
    recoveryRoute: 'setup action:"item" setupItemId:"connected-host-readiness" includeParameters:true',
  };
  if (methodId === 'services.status') {
    return {
      target: 'read-current-posture',
      successCriteria: [
        'The daemon returns installed, autostart, and running booleans.',
        'The receipt has no actionError.',
      ],
      ...common,
    };
  }
  if (methodId === 'services.install') {
    return {
      target: 'installed-service',
      successCriteria: [
        'The confirmed services.install receipt reports installed:true.',
        'The receipt has no actionError.',
        'A follow-up services.status read confirms the same installed posture before retrying another lifecycle action.',
      ],
      ...common,
    };
  }
  if (methodId === 'services.start') {
    return {
      target: 'running-service',
      successCriteria: [
        'The confirmed services.start receipt reports running:true.',
        'The receipt has no actionError.',
        'A follow-up services.status read confirms running:true before retrying start or escalating.',
      ],
      ...common,
    };
  }
  return {
    target: 'restarted-running-service',
    successCriteria: [
      'The confirmed services.restart receipt reports running:true after restart.',
      'The receipt has no actionError.',
      'A follow-up services.status read confirms running:true before retrying restart or escalating.',
    ],
    ...common,
  };
}

export function connectedHostRepairCards(
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
  probe: SetupServiceProbe,
): readonly SetupRepairCard[] {
  const methodIds = operatorMethodIds();
  const hostIssue = snapshot.collectionIssues.some((issue) => issue.area === 'host');
  const liveHostPrerequisite = hostIssue
    ? 'Run connected-host status first; confirmed service methods require a reachable compatible operator endpoint and usable token.'
    : 'Requires a reachable compatible operator endpoint and usable token.';
  const statusRecommendation: SetupRepairRecommendation = probe.status === 'unreachable'
    ? 'recommended'
    : probe.status === 'reachable'
      ? 'not-needed'
      : 'inspect-first';
  const postureRecommendation: SetupRepairRecommendation = probe.status === 'unreachable' || probe.issues.length > 0
    ? 'recommended'
    : probe.status === 'reachable'
      ? 'not-needed'
      : 'inspect-first';
  const lifecycleRecommendation = lifecycleRepairRecommendation(probe);
  return [
    {
      id: 'connected-host-status',
      label: 'Inspect connected-host status',
      state: 'available',
      effect: 'read-only',
      modelRoute: 'host action:"status" includeParameters:true',
      userRoute: '/compat',
      recommendation: statusRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.status === 'reachable'
        ? 'Runtime endpoint is reachable; use connected-host status when token, compatibility, or Knowledge readiness still needs review.'
        : probe.status === 'unreachable'
          ? 'Runtime endpoint is enabled but not reachable; inspect connected-host status and service posture before any lifecycle mutation.'
          : 'Runtime endpoint reachability is not proven; inspect connected-host status before lifecycle mutation.'),
      recommendedWhen: 'Use first for every host setup or repair question.',
      safety: 'Read-only diagnostic; returns redacted token posture and route readiness.',
    },
    {
      id: 'service-posture',
      label: 'Inspect service posture',
      state: 'available',
      effect: 'read-only',
      modelRoute: 'host action:"services" includeParameters:true',
      userRoute: '/health',
      recommendation: postureRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.issues.length > 0
        ? `Service posture reports ${probe.issues.length} issue(s); inspect endpoint binding, reachability, and logs before mutation.`
        : probe.status === 'reachable'
          ? 'Runtime endpoint is reachable and service posture has no current probe issue.'
          : 'Inspect endpoint binding, reachability, and logs before choosing a lifecycle action.'),
      recommendedWhen: 'Use when endpoints, bind addresses, ports, logs, or listener exposure may be the blocker.',
      safety: 'Read-only diagnostic; probes endpoints only when requested with includeParameters.',
    },
    setupRepairCard(methodIds, {
      id: 'service-status',
      label: 'Read service install/runtime status',
      methodId: 'services.status',
      effect: 'read-only',
      userRoute: '/compat',
      prerequisite: liveHostPrerequisite,
      recommendation: statusRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.status === 'reachable'
        ? 'Runtime endpoint is reachable; service status is optional unless the user is auditing install/autostart posture.'
        : 'Read service status before deciding whether install, start, or restart is actually needed.'),
      outcome: serviceRepairOutcome('services.status'),
      recommendedWhen: 'Use when the daemon is reachable and the user needs install/autostart/running posture.',
      safety: 'Read-only daemon method.',
      liveHostRequired: hostIssue,
    }),
    setupRepairCard(methodIds, {
      id: 'service-install',
      label: 'Install service',
      methodId: 'services.install',
      effect: 'confirmed-effect',
      userRoute: 'Connected-host service control',
      prerequisite: liveHostPrerequisite,
      recommendation: lifecycleRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.status === 'reachable'
        ? 'Runtime endpoint is already reachable; install is not recommended without service status evidence.'
        : 'Install is not recommended from endpoint reachability alone; require service status to prove the service is not installed.'),
      outcome: serviceRepairOutcome('services.install'),
      recommendedWhen: 'Use only when service status says the platform service is not installed and the user explicitly asks to install it.',
      safety: 'Confirmed service mutation; no uninstall or stop action is included in first-run setup.',
      liveHostRequired: hostIssue,
    }),
    setupRepairCard(methodIds, {
      id: 'service-start',
      label: 'Start service',
      methodId: 'services.start',
      effect: 'confirmed-effect',
      userRoute: 'Connected-host service control',
      prerequisite: liveHostPrerequisite,
      recommendation: lifecycleRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.status === 'reachable'
        ? 'Runtime endpoint is already reachable; start is not recommended without service status evidence.'
        : 'Start is not recommended from endpoint reachability alone; require service status to prove the service is installed but stopped.'),
      outcome: serviceRepairOutcome('services.start'),
      recommendedWhen: 'Use only when service status says the service is installed but not running and the user explicitly asks to start it.',
      safety: 'Confirmed service mutation.',
      liveHostRequired: hostIssue,
    }),
    setupRepairCard(methodIds, {
      id: 'service-restart',
      label: 'Restart service',
      methodId: 'services.restart',
      effect: 'confirmed-effect',
      userRoute: 'Connected-host service control',
      prerequisite: liveHostPrerequisite,
      recommendation: lifecycleRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.status === 'reachable'
        ? 'Runtime endpoint is reachable; restart is not recommended unless diagnostics prove the host is unhealthy or incompatible.'
        : 'Restart is not recommended from endpoint reachability alone; require diagnostics or service status to prove a running unhealthy service.'),
      outcome: serviceRepairOutcome('services.restart'),
      recommendedWhen: 'Use only when the service is running but unhealthy or incompatible and the user explicitly asks to restart it.',
      safety: 'Confirmed service mutation; use diagnostics first to avoid disrupting a healthy host.',
      liveHostRequired: hostIssue,
    }),
  ];
}

export function serviceLifecycleReceiptRules(): readonly string[] {
  return [
    'installed:false -> recommend confirmed services.install.',
    'installed:true and running:false -> recommend confirmed services.start.',
    'installed:true and running:true and network.controlPlane.ready:false -> recommend confirmed services.restart.',
    'installed:true and running:true with no failed control-plane evidence -> no service lifecycle mutation.',
  ];
}

export function setupServiceLifecycleDecision(
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
  probe: SetupServiceProbe,
): SetupServiceLifecycleDecision {
  const methodIds = operatorMethodIds();
  const statusPublished = methodIds.has('services.status');
  const hostIssue = snapshot.collectionIssues.some((issue) => issue.area === 'host');
  const evidence = {
    probeStatus: probe.status,
    binding: probe.binding,
    hostIssue,
    serviceStatusMethodPublished: statusPublished,
  };
  const blockedMutations = [
    'services.install until a services.status receipt reports installed:false',
    'services.start until a services.status receipt reports installed:true and running:false',
    'services.restart until a services.status receipt reports installed:true, running:true, and network.controlPlane.ready:false or diagnostics prove an unhealthy running service',
  ];
  if (hostIssue) {
    return {
      status: 'bootstrap-first',
      recommendedAction: 'inspect-service-posture',
      modelRoute: 'host action:"services" includeParameters:true',
      reason: 'Agent cannot trust connected-host lifecycle methods until the owning host is reachable enough to return compatible status evidence.',
      evidence,
      receiptRules: serviceLifecycleReceiptRules(),
      blockedMutations,
    };
  }
  if (!statusPublished) {
    return {
      status: 'status-route-unavailable',
      recommendedAction: 'inspect-service-posture',
      modelRoute: 'host action:"services" includeParameters:true',
      reason: 'The connected-host operator contract does not publish services.status, so setup cannot select install/start/restart from a service receipt.',
      evidence,
      receiptRules: serviceLifecycleReceiptRules(),
      blockedMutations,
    };
  }
  if (probe.status === 'reachable') {
    return {
      status: 'no-lifecycle-action',
      recommendedAction: 'none',
      modelRoute: operatorMethodRoute('services.status', false),
      reason: 'The runtime endpoint is reachable; no install/start/restart mutation is justified by probe evidence alone. Read services.status only for install/autostart audit or setup closeout.',
      evidence,
      receiptRules: serviceLifecycleReceiptRules(),
      blockedMutations,
    };
  }
  return {
    status: 'needs-status-receipt',
    recommendedAction: 'read-services-status',
    modelRoute: operatorMethodRoute('services.status', false),
    reason: 'Probe evidence is not enough to choose install, start, or restart. Read a services.status receipt first and let agent_operator_method return the exact lifecycle decision.',
    evidence,
    receiptRules: serviceLifecycleReceiptRules(),
    blockedMutations,
  };
}

export function connectedHostBootstrapPlan(
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
  probe: SetupServiceProbe,
): SetupBootstrapPlan {
  const hostIssue = snapshot.collectionIssues.some((issue) => issue.area === 'host');
  const probeIssue = probe.status === 'unreachable';
  return {
    status: hostIssue || probeIssue ? 'recommended' : 'optional',
    source: 'goodvibes-tui README, package.json, and bin launchers from the connected-host checkout',
    recommendedWhen: hostIssue
      ? 'Use when Agent cannot reach a compatible connected host, so operator service methods cannot be trusted yet.'
      : probeIssue
        ? 'Use when the configured runtime connection is enabled but unreachable, before confirmed service methods have proven an install/start fix.'
      : 'Use only when the user is setting up a new GoodVibes host or wants to verify the owning host install.',
    steps: [
      {
        id: 'verify-bun',
        label: 'Verify Bun is installed',
        purpose: 'GoodVibes TUI and the daemon package are Bun programs; package lifecycle scripts also need Bun.',
        commands: ['bun --version'],
        expected: 'Prints a Bun version.',
        fallback: 'Install Bun, reopen the terminal so PATH is refreshed, then retry.',
      },
      {
        id: 'install-goodvibes-host',
        label: 'Install the owning GoodVibes host',
        purpose: 'Install the package that provides both the TUI and goodvibes-daemon launchers.',
        commands: [
          'bun add -g @pellux/goodvibes-tui',
          'bun pm trust -g @pellux/goodvibes-tui @goodvibes-jev/engine/sdk core-js tree-sitter-css tree-sitter-javascript tree-sitter-json tree-sitter-python tree-sitter-typescript',
        ],
        expected: 'Global package install completes and Bun reports lifecycle scripts are trusted.',
        fallback: 'If release assets cannot download, use the goodvibes-tui source checkout and run bun install before bun run daemon.',
      },
      {
        id: 'verify-goodvibes-binaries',
        label: 'Verify host binaries',
        purpose: 'Confirm the package installed both user-facing and daemon entrypoints.',
        commands: [
          'bun pm -g untrusted',
          'goodvibes --version',
          'goodvibes-daemon --version',
        ],
        expected: 'Untrusted reports zero remaining lifecycle-script packages, and both binaries print versions.',
        fallback: 'Rerun the full trust command if Bun still reports untrusted package scripts.',
      },
      {
        id: 'start-goodvibes-host',
        label: 'Start or install the host service',
        purpose: 'Bring up the daemon/API host that owns schedules, channels, Knowledge, media, and operator routes.',
        commands: [
          'goodvibes service status',
          'goodvibes service install',
          'goodvibes service start',
        ],
        expected: 'Service status reports an installed running service, or the interactive GoodVibes TUI starts the daemon/listener surfaces configured by the user.',
        fallback: 'For a one-shot headless host from source, use GOODVIBES_DAEMON_TOKEN=... GOODVIBES_HTTP_TOKEN=... bun run daemon inside goodvibes-tui.',
      },
      {
        id: 'reconnect-agent',
        label: 'Reconnect Agent to the host',
        purpose: 'Verify Agent can reach the default host or an explicitly configured runtime URL.',
        commands: [
          'goodvibes-agent status --json',
          'goodvibes-agent compat',
        ],
        expected: 'Agent status reports reachable connected-host and compatible Agent Knowledge routes.',
        fallback: 'Use goodvibes-agent --runtime-url http://host:port or GOODVIBES_AGENT_RUNTIME_URL=http://host:port when the host is not on http://127.0.0.1:3421.',
      },
    ],
    reconnectRoutes: {
      agentStatus: 'host action:"status" includeParameters:true',
      serviceDiagnostics: 'host action:"services" includeParameters:true',
      setupItem: 'setup action:"item" setupItemId:"connected-host-readiness"',
    },
    policy: 'Bootstrap commands are user-run setup guidance. At boot the Agent runtime starts an already-installed host whose service is stopped, through the platform service manager, and reports it; beyond that one bounded boot behavior the Agent does not run host install/start commands implicitly, and once the host is reachable exact service mutations stay on confirmed operator methods.',
  };
}
