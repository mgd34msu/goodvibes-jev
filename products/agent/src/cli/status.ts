import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { OnboardingCheckMarkersState } from '../runtime/onboarding/index.ts';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';
import type { GoodVibesCliOutputFormat } from './types.ts';
import type { CliServicePosture } from './service-posture.ts';
import type { CliExternalRuntimeSnapshot } from './external-runtime.ts';
import type { CliConnectedHostMetricsSnapshot } from './connected-host-metrics.ts';
import { getProviderIdFromModel } from '../config/provider-model.ts';
import { formatAgentRecordSource } from '../agent/record-labels.ts';
import { formatAgentKnowledgeFailureKind } from './agent-knowledge-format.ts';
import { computeApprovalPosture, type ApprovalPosture } from '../permissions/approval-posture.ts';
import { appendTemporalLabel } from './temporal-label.ts';

export interface CliStatusOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly onboardingMarkers?: OnboardingCheckMarkersState;
  readonly auth?: CliAuthStatus;
  readonly service?: CliServicePosture;
  readonly externalRuntime?: CliExternalRuntimeSnapshot;
  readonly connectedHostMetrics?: CliConnectedHostMetricsSnapshot;
  readonly checkpoints?: CliCheckpointsStatus;
  readonly doctor?: boolean;
  readonly outputFormat?: GoodVibesCliOutputFormat;
}

/**
 * Registered-workspaces-only checkpoint posture (owner ruling, 2026-07-10; see
 * ../config/workspace-registration.ts and ../runtime/services.ts). Computed by the
 * caller (entrypoint.ts already builds a ShellPathService for status/doctor)
 * and passed in here so this module stays a pure renderer.
 */
export interface CliCheckpointsStatus {
  readonly workspaceRegistered: boolean;
  readonly unregisteredWorkspaceMode: 'off' | 'guarded';
}

export interface CliAuthStatus {
  readonly userStorePath: string;
  readonly userStorePresent: boolean;
  readonly bootstrapCredentialPath: string;
  readonly bootstrapCredentialPresent: boolean;
  readonly operatorTokenPath: string;
  readonly operatorTokenPresent: boolean;
}

export interface CliDoctorFinding {
  readonly id: string;
  readonly area: 'auth' | 'onboarding' | 'runtime' | 'security' | 'secrets';
  readonly severity: 'warning' | 'risk';
  readonly summary: string;
  readonly cause: string;
  readonly impact: string;
  readonly action: string;
}

export interface CliStatusSnapshot {
  readonly title: 'GoodVibes Agent status' | 'GoodVibes Agent doctor';
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly provider: {
    readonly provider: string;
    readonly model: string;
    readonly reasoning: string;
  };
  readonly auth: {
    readonly permissionMode: unknown;
    readonly permissionLabel: string;
    readonly autoApprove: boolean;
    readonly automaticApprovals: boolean;
    readonly bypassesPrompts: boolean;
    readonly permissionDetail: string;
    readonly secretPolicy: unknown;
    readonly secretPolicyLabel: string;
    readonly runtimeAuthSignal: CliAuthStatus | null;
  };
  readonly runtimeConnection: {
    readonly enabled: unknown;
    readonly autostart: unknown;
    readonly restartOnFailure: unknown;
    readonly lifecycle?: CliServicePosture;
  };
  readonly externalRuntime: CliExternalRuntimeSnapshot | null;
  readonly connectedHostMetrics: CliConnectedHostMetricsSnapshot | null;
  readonly relay: {
    readonly enabled: boolean;
    readonly url: string;
    readonly requireStepUpForMutations: boolean;
    readonly liveVerified: false;
  };
  readonly runtimeEndpoints: {
    readonly controlPlane: ReturnType<typeof resolveRuntimeEndpointBinding> & { readonly enabled: unknown };
    readonly httpListener: ReturnType<typeof resolveRuntimeEndpointBinding> & { readonly enabled: unknown };
    readonly web: ReturnType<typeof resolveRuntimeEndpointBinding> & { readonly enabled: unknown };
  };
  readonly onboarding: {
    readonly checked: boolean;
    readonly scope: string;
    readonly updatedAt: number | null;
  };
  readonly checkpoints: {
    readonly automaticCheckpointsActive: boolean;
    readonly workspaceRegistered: boolean;
    readonly unregisteredWorkspaceMode: 'off' | 'guarded';
    readonly statusLine: string;
  } | null;
  readonly findings: readonly CliDoctorFinding[];
}

/**
 * The one honest line this surface must never omit or soften (owner ruling,
 * 2026-07-10): whether automatic checkpoints are active for THIS working
 * directory, and why. `"checkpoints off: workspace not registered"` is the
 * literal wording the ruling calls for the default (unregistered, `"off"`) case.
 */
function checkpointsStatusLine(checkpoints: CliCheckpointsStatus): { active: boolean; line: string } {
  if (checkpoints.workspaceRegistered) {
    return { active: true, line: 'checkpoints on: workspace registered' };
  }
  if (checkpoints.unregisteredWorkspaceMode === 'guarded') {
    return { active: true, line: 'checkpoints on: unregistered workspace allowed via checkpoints.unregisteredWorkspaces="guarded"' };
  }
  return { active: false, line: 'checkpoints off: workspace not registered' };
}

function yesNo(value: unknown): string {
  return value === true ? 'yes' : 'no';
}

/**
 * The connected-host runtime-metrics lines. Each non-ok state is rendered as a
 * plain sentence naming exactly why there are no numbers to show, most
 * importantly, a token without the read:telemetry scope reads as "not
 * permitted", never as a wall of zeros that would misrepresent an unauthorized
 * token as a healthy idle host.
 */
function connectedHostMetricsLines(snapshot: CliConnectedHostMetricsSnapshot | null): string[] {
  if (!snapshot) return ['  live check unavailable'];
  switch (snapshot.status) {
    case 'ok': {
      const m = snapshot.metrics!;
      return [
        `  http requests total: ${m.httpRequestsTotal}`,
        `  llm requests total: ${m.llmRequestsTotal}`,
        `  auth success/failure: ${m.authSuccessTotal}/${m.authFailureTotal}`,
        `  transport retries total: ${m.transportRetriesTotal}`,
        `  sessions active: ${m.sessionsActive}`,
        `  sse subscribers: ${m.sseSubscribers}`,
        `  telemetry buffer fill: ${m.telemetryBufferFill}`,
      ];
    }
    case 'scope_missing':
      return [`  not shown: the connected-host token does not include the ${snapshot.requiredScope} scope required by ${snapshot.methodId}.`];
    case 'auth_required':
      return ['  not shown: connected-host operator token is missing or unauthenticated.'];
    case 'route_unavailable':
      return [`  not shown: this connected host does not expose ${snapshot.route} (incompatible or older daemon).`];
    case 'unavailable':
      return [`  not shown: connected host is not reachable${snapshot.error ? ` (${snapshot.error})` : '.'}`];
    default:
      return [`  not shown: ${snapshot.error ?? 'runtime metrics could not be read.'}`];
  }
}

/** permissions.tools.* keys, mirrors PermissionsToolConfig in the SDK config schema. */
const PERMISSION_TOOL_KEYS = [
  'read', 'write', 'edit', 'exec', 'find', 'fetch', 'analyze',
  'inspect', 'agent', 'state', 'workflow', 'registry', 'delegate', 'mcp',
] as const;

/**
 * Reads the configured posture, including behavior.autoApprove rather than
 * permissions.mode alone (the original display bug). Per-call readings and
 * boundary checks still decide whether any individual action can run.
 */
function readApprovalPosture(config: Pick<ConfigManager, 'get'>): ApprovalPosture {
  const customTools: Record<string, unknown> = {};
  for (const key of PERMISSION_TOOL_KEYS) customTools[key] = config.get(`permissions.tools.${key}`);
  return computeApprovalPosture({
    autoApprove: config.get('behavior.autoApprove') === true,
    mode: config.get('permissions.mode'),
    customTools,
  });
}

function secretPolicyLabel(policy: unknown): string {
  if (policy === 'preferred_secure') return 'Use secure storage when available';
  if (policy === 'require_secure') return 'Require secure storage';
  if (policy === 'plaintext_allowed') return 'Allow plaintext storage';
  return String(policy ?? 'unknown');
}

export function buildCliDoctorFindings(options: CliStatusOptions): readonly CliDoctorFinding[] {
  const config = options.configManager;
  const permissionMode = config.get('permissions.mode');
  const secretPolicy = config.get('storage.secretPolicy');
  const posture = readApprovalPosture(config);
  const marker = options.onboardingMarkers?.effective;

  const findings: CliDoctorFinding[] = [];

  if (options.externalRuntime) {
    if (!options.externalRuntime.reachable) {
      findings.push({
        id: 'external-runtime-unreachable',
        area: 'runtime',
        severity: 'warning',
        summary: 'Connected GoodVibes host is not reachable.',
        cause: `Agent could not reach ${options.externalRuntime.baseUrl}${options.externalRuntime.error ? `: ${options.externalRuntime.error}` : '.'}`,
        impact: 'Companion chat, isolated Agent Knowledge, approvals, automation status, and build delegation cannot work until the connected GoodVibes host is available.',
        action: 'Make the owning GoodVibes host available, then rerun goodvibes-agent status.',
      });
    } else if (!options.externalRuntime.compatible) {
      findings.push({
        id: 'external-runtime-incompatible',
        area: 'runtime',
        severity: 'warning',
        summary: 'Connected GoodVibes host compatibility does not satisfy Agent readiness.',
        cause: 'Connected host is reachable, but at least one public Agent route is unavailable or incompatible.',
        impact: 'Agent-only routes, especially isolated Agent Knowledge, may be unavailable.',
        action: 'Update the owning GoodVibes host so its public Agent routes are compatible.',
      });
    }

    if (!options.externalRuntime.operatorToken.present) {
      findings.push({
        id: 'external-runtime-token-missing',
        area: 'auth',
        severity: 'warning',
        summary: 'Connected-host operator token is missing.',
        cause: `No operator token was found at ${options.externalRuntime.operatorToken.path}.`,
        impact: 'Agent can inspect only unauthenticated routes and cannot use protected connected-host APIs.',
        action: 'Pair or provision access through the owning GoodVibes host, then rerun goodvibes-agent auth.',
      });
    }

    if (options.externalRuntime.reachable && options.externalRuntime.operatorToken.present && !options.externalRuntime.agentKnowledge.ready) {
      findings.push({
        id: 'agent-knowledge-route-not-ready',
        area: 'runtime',
        severity: 'warning',
        summary: 'Isolated Agent Knowledge route is not ready.',
        cause: `${options.externalRuntime.agentKnowledge.route} returned ${options.externalRuntime.agentKnowledge.kind}${options.externalRuntime.agentKnowledge.statusCode === null ? '' : ` (${options.externalRuntime.agentKnowledge.statusCode})`}.`,
        impact: 'Agent Knowledge ask/search will not use default or non-Agent knowledge fallback; it will fail closed until the Agent route is available.',
        action: 'Update the connected GoodVibes host so public Agent routes are compatible, then verify goodvibes-agent compat.',
      });
    }
  }

  if (options.service) {
    // Advisories describe the arrangement the operator chose, so they are
    // reported at risk severity, printed, never silent, and never a release
    // defect. See doctorRiskAdvisoryOnlyCount in verification/live-verifier.ts.
    for (const advisory of options.service.advisories) {
      if (findings.some((finding) => finding.summary === advisory)) continue;
      findings.push({
        id: `runtime-posture-${findings.length}`,
        area: 'runtime',
        severity: 'risk',
        summary: advisory,
        cause: 'The connected-host inspection found a deliberate arrangement worth stating.',
        impact: 'None on its own; it describes how this installation is set up.',
        action: 'No action needed unless this is not the arrangement you intended.',
      });
    }
    for (const issue of options.service.issues) {
      if (findings.some((finding) => finding.summary === issue)) continue;
      findings.push({
        id: `runtime-connection-${findings.length}`,
        area: 'runtime',
        severity: 'warning',
        summary: issue,
        cause: 'The connected-host inspection found a mismatch between configured endpoint state and observed host state.',
        impact: 'Companion chat, Agent Knowledge, approvals, automation status, or build delegation may be unavailable.',
        action: 'Use Agent status and doctor diagnostics here, then repair the connected GoodVibes host outside Agent.',
      });
    }
  }

  if (!marker?.exists) {
    findings.push({
      id: 'onboarding-incomplete',
      area: 'onboarding',
      severity: 'warning',
      summary: 'Agent setup has not been applied for this user.',
      cause: 'No global user setup completion marker was found.',
      impact: 'Provider/model, Agent Knowledge, local behavior, channel, and permission choices may still be implicit defaults.',
      action: 'Run /agent in GoodVibes Agent or goodvibes-agent setup status to review setup state.',
    });
  }

  if (posture.autoApprove) {
    findings.push({
      id: 'auto-approve-enabled',
      area: 'security',
      severity: 'risk',
      summary: 'Auto-approve is on; boundary checks still apply.',
      cause: 'behavior.autoApprove is true.',
      impact: 'Calls that pass the boundary, including powerful write, edit, network, and execution actions, are approved automatically regardless of permissions.mode or custom per-tool rules. Boundary checks can still refuse a call or require approval.',
      action: 'Disable behavior.autoApprove unless this is an intentionally trusted environment.',
    });
  }

  if (permissionMode === 'allow-all') {
    findings.push({
      id: 'allow-all-permissions',
      area: 'security',
      severity: 'risk',
      summary: 'Automatic permission mode is active; critical calls still ask.',
      cause: 'permissions.mode is allow-all.',
      impact: 'Powerful write, edit, network, and execution tools can run without a Human-in-the-Loop (HITL) approval prompt.',
      action: 'Use Ask before powerful actions or Custom rules unless this is an intentionally trusted environment.',
    });
  }

  if (secretPolicy === 'plaintext_allowed') {
    findings.push({
      id: 'plaintext-secrets-allowed',
      area: 'secrets',
      severity: 'risk',
      summary: 'Plaintext secret storage is allowed.',
      cause: 'storage.secretPolicy is plaintext_allowed.',
      impact: 'Provider keys and channel tokens may be stored without secure backend protection.',
      action: 'Use Require secure storage or Use secure storage when available for normal operation.',
    });
  }

  return findings;
}

export function buildCliStatusSnapshot(options: CliStatusOptions): CliStatusSnapshot {
  const config = options.configManager;
  const controlPlaneBinding = resolveRuntimeEndpointBinding(config, 'controlPlane');
  const httpListenerBinding = resolveRuntimeEndpointBinding(config, 'httpListener');
  const webBinding = resolveRuntimeEndpointBinding(config, 'web');
  const marker = options.onboardingMarkers?.effective;
  const findings = buildCliDoctorFindings(options);
  const posture = readApprovalPosture(config);
  return {
    title: options.doctor ? 'GoodVibes Agent doctor' : 'GoodVibes Agent status',
    workingDirectory: options.workingDirectory,
    homeDirectory: options.homeDirectory,
    provider: {
      provider: getProviderIdFromModel(config.get('provider.model')),
      model: String(config.get('provider.model')),
      reasoning: String(config.get('provider.reasoningEffort')),
    },
    auth: {
      permissionMode: config.get('permissions.mode'),
      permissionLabel: posture.label,
      autoApprove: posture.autoApprove,
      automaticApprovals: posture.automaticApprovals,
      bypassesPrompts: posture.bypassesPrompts,
      permissionDetail: posture.detail,
      secretPolicy: config.get('storage.secretPolicy'),
      secretPolicyLabel: secretPolicyLabel(config.get('storage.secretPolicy')),
      runtimeAuthSignal: options.auth ?? null,
    },
    runtimeConnection: {
      enabled: config.get('service.enabled'),
      autostart: config.get('service.autostart'),
      restartOnFailure: config.get('service.restartOnFailure'),
      ...(options.service ? { lifecycle: options.service } : {}),
    },
    externalRuntime: options.externalRuntime ?? null,
    connectedHostMetrics: options.connectedHostMetrics ?? null,
    relay: {
      enabled: config.get('relay.enabled') === true,
      url: String(config.get('relay.url') ?? ''),
      requireStepUpForMutations: config.get('relay.requireStepUpForMutations') === true,
      liveVerified: false,
    },
    runtimeEndpoints: {
      controlPlane: { enabled: config.get('controlPlane.enabled'), ...controlPlaneBinding },
      httpListener: { enabled: config.get('danger.httpListener'), ...httpListenerBinding },
      web: { enabled: config.get('web.enabled'), ...webBinding },
    },
    onboarding: {
      checked: Boolean(marker?.exists),
      scope: marker?.scope ?? 'none',
      updatedAt: marker?.payload?.updatedAt ?? null,
    },
    checkpoints: options.checkpoints
      ? {
        automaticCheckpointsActive: checkpointsStatusLine(options.checkpoints).active,
        workspaceRegistered: options.checkpoints.workspaceRegistered,
        unregisteredWorkspaceMode: options.checkpoints.unregisteredWorkspaceMode,
        statusLine: checkpointsStatusLine(options.checkpoints).line,
      }
      : null,
    findings,
  };
}

export function renderCliStatus(options: CliStatusOptions): string {
  const config = options.configManager;
  const snapshot = buildCliStatusSnapshot(options);
  const marker = options.onboardingMarkers?.effective;
  const findings = snapshot.findings;
  const externalRuntime = snapshot.externalRuntime;

  if (options.outputFormat === 'json') return JSON.stringify(snapshot, null, 2);

  const lines = [
    snapshot.title,
    `  working directory ${options.workingDirectory}`,
    `  home directory ${options.homeDirectory}`,
    '',
    'Provider',
    `  provider ${getProviderIdFromModel(config.get('provider.model'))}`,
    `  model ${String(config.get('provider.model'))}`,
    `  reasoning ${String(config.get('provider.reasoningEffort'))}`,
    '',
    'Auth',
    `  permissions: ${snapshot.auth.permissionLabel} (${String(config.get('permissions.mode'))})`,
    `  autoApprove: ${yesNo(snapshot.auth.autoApprove)} (behavior.autoApprove)`,
    `  approval checks: ${snapshot.auth.permissionDetail}`,
    `  secretPolicy: ${secretPolicyLabel(config.get('storage.secretPolicy'))} (${String(config.get('storage.secretPolicy'))})`,
    options.auth
      ? `  local auth store ${options.auth.userStorePresent ? 'present' : 'missing'} (${options.auth.userStorePath})`
      : '  local auth store unknown',
    options.auth
      ? `  setup credential ${options.auth.bootstrapCredentialPresent ? 'present' : 'missing'} (${options.auth.bootstrapCredentialPath})`
      : '  setup credential unknown',
    options.auth
      ? `  connected host token ${options.auth.operatorTokenPresent ? 'present' : 'missing'} (${options.auth.operatorTokenPath})`
      : '  connected host token unknown',
    '',
    'Connected GoodVibes host:',
    ...(externalRuntime ? [
      `  baseUrl: ${externalRuntime.baseUrl}`,
      `  reachable: ${yesNo(externalRuntime.reachable)}${externalRuntime.statusCode === null ? '' : ` (HTTP ${externalRuntime.statusCode})`}`,
      `  compatible: ${yesNo(externalRuntime.compatible)}`,
      `  access token: ${externalRuntime.operatorToken.present ? 'present' : 'missing'} (${externalRuntime.operatorToken.path})`,
      `  Agent Knowledge: ${externalRuntime.agentKnowledge.ready ? 'ready' : `not ready (${formatAgentKnowledgeFailureKind(externalRuntime.agentKnowledge.kind)})`}`,
      ...(externalRuntime.error ? [`  error: ${externalRuntime.error}`] : []),
    ] : [
      '  live check unavailable',
    ]),
    '',
    'Connected host metrics (runtime.metrics.get; read:telemetry):',
    ...connectedHostMetricsLines(snapshot.connectedHostMetrics),
    '',
    'Relay (connected host\'s imported config; not live-verified, see goodvibes-agent relay status):',
    `  relay.enabled: ${yesNo(snapshot.relay.enabled)}`,
    `  relay.url: ${snapshot.relay.url || '(empty)'}`,
    `  relay.requireStepUpForMutations: ${yesNo(snapshot.relay.requireStepUpForMutations)}`,
    '',
    'Agent role:',
    '  product: interactive operator TUI',
    '  host lifecycle: external',
    '  starts or exposes host: no',
    ...(options.service ? [
      `  host log signal ${options.service.log.path ?? 'n/a'} (${options.service.log.exists ? 'present' : 'missing'})`,
    ] : []),
    'Onboarding',
    `  checked ${marker?.exists ? 'yes' : 'no'}`,
    `  scope ${marker?.scope ?? 'none'}`,
    `  updated ${marker?.payload ? appendTemporalLabel(new Date(marker.payload.updatedAt).toISOString(), marker.payload.updatedAt) : 'n/a'}`,
    '',
    'Checkpoints',
    ...(snapshot.checkpoints ? [
      `  ${snapshot.checkpoints.statusLine}`,
      `  unregisteredWorkspaces mode: ${snapshot.checkpoints.unregisteredWorkspaceMode}`,
      '  next goodvibes-agent workspaces list',
      ...(snapshot.checkpoints.workspaceRegistered ? [] : ['  next goodvibes-agent workspaces register --yes']),
    ] : [
      '  checkpoint posture unknown',
    ]),
  ];

  if (options.doctor) {
    lines.push(
      '',
      'Readiness Checks:',
      '  companion chat route',
      '  isolated Agent Knowledge route',
      '  approvals and automation status routes',
      '  explicit build delegation route',
    );
    lines.push('', 'Warnings');
    if (findings.length === 0) {
      lines.push('  none');
    } else {
      for (const finding of findings) {
        lines.push(
          `  - [${finding.severity}:${finding.area}:${finding.id}] ${finding.summary}`,
          `    cause: ${finding.cause}`,
          `    impact: ${finding.impact}`,
          `    action: ${finding.action}`,
        );
      }
    }
  }

  return lines.join('\n');
}

export function renderOnboardingCliStatus(options: CliStatusOptions): string {
  const marker = options.onboardingMarkers?.effective;
  return [
    'GoodVibes Agent setup status',
    `  checked ${marker?.exists ? 'yes' : 'no'}`,
    `  scope ${marker?.scope ?? 'none'}`,
    `  origin ${marker?.payload?.source ? formatAgentRecordSource(marker.payload.source) : 'n/a'}`,
    `  mode ${marker?.payload?.mode ?? 'n/a'}`,
    `  updated ${marker?.payload ? appendTemporalLabel(new Date(marker.payload.updatedAt).toISOString(), marker.payload.updatedAt) : 'n/a'}`,
    `  working directory ${options.workingDirectory}`,
  ].join('\n');
}
