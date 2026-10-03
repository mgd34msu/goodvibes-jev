import type { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { OnboardingStep1CapabilityItem, OnboardingSurfaceRecord } from '../runtime/onboarding/index.ts';
import type { AgentHarnessVibeHealth } from './agent-harness-vibe-health.ts';
import type { AgentHarnessSudoPosture } from './agent-harness-sudo-posture.ts';

export interface AgentHarnessSetupArgs {
  readonly setupItemId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly fields?: unknown;
  readonly explicitUserRequest?: unknown;
}

export type SetupResolution =
  | { readonly status: 'found'; readonly item: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

export type SetupLookupSource = 'setupItemId' | 'target' | 'query';

export interface SurfaceRegistryLike {
  syncConfiguredSurfaces(): readonly OnboardingSurfaceRecord[];
}

export type SetupPlanStatus = 'ready' | 'blocked' | 'recommended' | 'optional' | 'check';
export type SetupRepairCardState = 'available' | 'requires-live-host' | 'missing';
export type SetupRepairCardEffect = 'read-only' | 'confirmed-effect';
export type SetupRepairRecommendation = 'recommended' | 'inspect-first' | 'not-needed' | 'unavailable';
export type SetupServiceProbeStatus = 'reachable' | 'unreachable' | 'not-enabled' | 'not-probed';
export type SetupSmokeArtifactStore = Partial<Pick<ArtifactStore, 'create' | 'list'>>;
export type SetupHandoffKind = 'diagnostic' | 'workspace-action' | 'ui-surface' | 'confirmed-route' | 'operator-method' | 'conversation' | 'user-command' | 'tool-discovery';
export type SetupHandoffEffect = 'read-only' | 'visible-navigation' | 'confirmed-effect' | 'user-run';

export interface OperatorContractMethod {
  readonly id: string;
}

export interface SetupPlanItem {
  readonly id: string;
  readonly label: string;
  readonly status: SetupPlanStatus;
  readonly priority: number;
  readonly blocksAutonomy: boolean;
  readonly reason: string;
  readonly nextAction: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly relatedSetupItemId?: string;
  readonly signals?: readonly string[];
  readonly repairCards?: readonly SetupRepairCard[];
  readonly serviceLifecycleDecision?: SetupServiceLifecycleDecision;
  readonly bootstrapPlan?: SetupBootstrapPlan;
  readonly serviceProbe?: SetupServiceProbe;
  readonly authPosture?: SetupConnectedHostAuthPosture;
  readonly installSmokePlan?: SetupInstallSmokePlan;
  readonly localModelReadiness?: Record<string, unknown>;
  readonly vibeHealth?: AgentHarnessVibeHealth;
  readonly sudoPosture?: AgentHarnessSudoPosture;
}

export interface SetupRepairCard {
  readonly id: string;
  readonly label: string;
  readonly state: SetupRepairCardState;
  readonly effect: SetupRepairCardEffect;
  readonly methodId?: string;
  readonly modelRoute?: string;
  readonly userRoute: string;
  readonly prerequisite?: string;
  readonly recommendation: SetupRepairRecommendation;
  readonly liveEvidence?: SetupRepairLiveEvidence;
  readonly outcome?: SetupRepairOutcome;
  readonly recommendedWhen: string;
  readonly safety: string;
}

export interface SetupRepairLiveEvidence {
  readonly probeStatus: SetupServiceProbeStatus;
  readonly summary: string;
}

export interface SetupRepairOutcome {
  readonly target: string;
  readonly successCriteria: readonly string[];
  readonly evidenceFields: readonly string[];
  readonly verificationRoute: string;
  readonly recoveryRoute: string;
}

export interface SetupServiceLifecycleDecision {
  readonly status: 'needs-status-receipt' | 'no-lifecycle-action' | 'bootstrap-first' | 'status-route-unavailable';
  readonly recommendedAction: 'read-services-status' | 'inspect-service-posture' | 'none';
  readonly modelRoute: string;
  readonly reason: string;
  readonly evidence: {
    readonly probeStatus: SetupServiceProbeStatus;
    readonly binding: string;
    readonly hostIssue: boolean;
    readonly serviceStatusMethodPublished: boolean;
  };
  readonly receiptRules: readonly string[];
  readonly blockedMutations: readonly string[];
}

export interface SetupServiceProbe {
  readonly status: SetupServiceProbeStatus;
  readonly endpointId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly binding: string;
  readonly diagnosticRoute: string;
  readonly issues: readonly string[];
}

export interface SetupConnectedHostAuthPosture {
  readonly owner: 'connected-host';
  readonly operatorToken: {
    readonly present: boolean;
    readonly usable: boolean;
    readonly path: string;
    readonly fingerprint?: string;
    readonly error?: string;
  };
  readonly compatibilityAuth: {
    readonly userStorePath: string;
    readonly userStorePresent: boolean;
    readonly bootstrapCredentialPath: string;
    readonly bootstrapCredentialPresent: boolean;
    readonly users: number;
    readonly sessions: number;
  };
  readonly routes: {
    readonly reviewCommand: string;
    readonly connectedHostStatus: string;
    readonly pairingPosture: string;
    readonly qrPairingRoute: string;
    readonly manualTokenRoute: string;
    readonly provisionTokenRoute: string;
    readonly tokenProvisioningOwner: string;
    readonly tokenProvisioningSource: string;
  };
}

export interface SetupInstallSmokeCheck {
  readonly id: string;
  readonly label: string;
  readonly status: 'ready' | 'blocked' | 'user-run';
  readonly evidence: string;
  readonly route: string;
}

export interface SetupInstallSmokePlan {
  readonly status: 'ready-to-run' | 'blocked';
  readonly source: string;
  readonly checks: readonly SetupInstallSmokeCheck[];
  readonly successCriteria: readonly string[];
  readonly policy: string;
}

export interface SetupInstallSmokeRunSummary {
  readonly ready: number;
  readonly blocked: number;
  readonly userRun: number;
  readonly total: number;
}

export interface SetupSmokeEvidenceField {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface SetupBootstrapStep {
  readonly id: string;
  readonly label: string;
  readonly purpose: string;
  readonly commands: readonly string[];
  readonly expected: string;
  readonly fallback?: string;
}

export interface SetupBootstrapPlan {
  readonly status: 'recommended' | 'optional';
  readonly source: string;
  readonly recommendedWhen: string;
  readonly steps: readonly SetupBootstrapStep[];
  readonly reconnectRoutes: Record<string, string>;
  readonly policy: string;
}

export interface SetupHandoffCard {
  readonly id: string;
  readonly label: string;
  readonly kind: SetupHandoffKind;
  readonly effect: SetupHandoffEffect;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly nextStep: string;
  readonly safety: string;
  readonly requiresConfirmation?: boolean;
  readonly prerequisite?: string;
}

export interface SetupRepairDecision {
  readonly id: string;
  readonly label: string;
  readonly status: 'inspect-first' | 'ready' | 'confirmed-repair-available' | 'user-run-bootstrap';
  readonly effect: SetupHandoffEffect;
  readonly modelRoute: string;
  readonly userRoute: string;
  readonly nextStep: string;
  readonly reason: string;
  readonly safety: string;
  readonly requiresConfirmation?: boolean;
  readonly prerequisite?: string;
}
