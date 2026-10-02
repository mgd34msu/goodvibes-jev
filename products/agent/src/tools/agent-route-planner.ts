import type { CommandContext } from '../input/command-registry.ts';
import { listHarnessModes } from './agent-harness-mode-catalog.ts';
import { listWorkspaceActions } from './agent-harness-workspace-actions.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { addSetupModelContextRouteCandidates } from './agent-route-planner-candidates-setup.ts';
import { addResearchScheduleExecutionRouteCandidates } from './agent-route-planner-candidates-work.ts';
import { addSurfaceSecurityRouteCandidates } from './agent-route-planner-candidates-surfaces.ts';
import { autonomousLike, browserCockpitLike, browserControlLike, channelDeliveriesLike, channelSendLike, channelSetupLike, channelTargetFromText, channelTriageLike, directScheduleLike, externalChannelLike, externalMemoryProviderId, externalMemoryProviderLike, fileRecoveryLike, hasAll, hasAny, hostDiagnosticsLike, interactiveProcessCapabilityLike, localModelLike, localModelSmokeLike, mediaGenerationLike, modelProviderId, modelRouteReadinessLike, personalOpsBriefingLike, personalOpsConnectorSetupLike, personalOpsFreshReadLike, personalOpsLaneFromText, personalOpsLike, personalOpsMutationLike, personalOpsQueueLike, processLifecycleLike, providerAccountLike, quote, releaseAuditLike, releaseEvidenceLike, researchRunnerLike, scheduleLike, securityFindingLike, securityPermissionLike, securityPolicyExplainLike, securityPolicyToolTarget, securityStatusLike, sessionMutationLike, sessionWorkspaceLike, simplifiedModeQuery, supportBundleEffectLike, supportBundleLike, ttsProviderLike, visualResearchReportLike, voiceWorkflowLike } from './agent-route-planner-helpers.ts';

export interface AgentRoutePlannerArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

export interface RouteCandidateDraft {
  readonly id: string;
  readonly label: string;
  readonly score: number;
  readonly userSurface: string;
  readonly userOutcome: string;
  readonly why: string;
  readonly modelRoute: string;
  readonly inspectRoute: string;
  readonly userRoute?: string;
  readonly requiresConfirmation: boolean;
  readonly missingFields?: readonly string[];
  readonly nextQuestion?: string;
  readonly supportingRoutes?: readonly string[];
  readonly policy?: string;
}

export interface AgentRouteCandidate {
  readonly id: string;
  readonly label: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly userSurface: string;
  readonly userOutcome: string;
  readonly why: string;
  readonly modelRoute: string;
  readonly inspectRoute: string;
  readonly userRoute?: string;
  readonly requiresConfirmation: boolean;
  readonly missingFields?: readonly string[];
  readonly nextQuestion?: string;
  readonly supportingRoutes?: readonly string[];
  readonly policy?: string;
  readonly score?: number;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(20, Math.trunc(parsed)));
}

function buildCandidates(request: string): readonly RouteCandidateDraft[] {
  const lower = request.toLowerCase();
  const candidates: RouteCandidateDraft[] = [];

  const add = (candidate: RouteCandidateDraft): void => {
    candidates.push(candidate);
  };

  addSetupModelContextRouteCandidates(lower, request, add);

  addResearchScheduleExecutionRouteCandidates(lower, request, add);

  addSurfaceSecurityRouteCandidates(lower, request, add);

  if (candidates.length === 0) {
    add({
      id: 'main-conversation-first',
      label: 'Main conversation first',
      score: 35,
      userSurface: 'Main conversation',
      userOutcome: 'Answer or plan directly before escalating into a specialized tool or workspace.',
      why: 'The request does not clearly need a specialized route yet.',
      modelRoute: 'main conversation',
      inspectRoute: `workspace action:"actions" query:${quote(request, 72)}`,
      userRoute: 'Main conversation',
      requiresConfirmation: false,
      supportingRoutes: [
        `route action:"plan" query:${quote(request, 72)}`,
        `workspace action:"actions" query:${quote(request, 72)}`,
      ],
      policy: 'Stay in the main conversation unless a visible specialized route improves clarity, durability, safety, or autonomy.',
    });
  }

  return candidates;
}

function confidence(score: number): AgentRouteCandidate['confidence'] {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

function describeCandidate(candidate: RouteCandidateDraft, includeParameters: boolean): AgentRouteCandidate {
  return {
    id: candidate.id,
    label: candidate.label,
    confidence: confidence(candidate.score),
    userSurface: candidate.userSurface,
    userOutcome: candidate.userOutcome,
    why: candidate.why,
    modelRoute: candidate.modelRoute,
    inspectRoute: candidate.inspectRoute,
    ...(candidate.userRoute ? { userRoute: candidate.userRoute } : {}),
    requiresConfirmation: candidate.requiresConfirmation,
    ...(candidate.missingFields?.length ? { missingFields: candidate.missingFields } : {}),
    ...(candidate.nextQuestion ? { nextQuestion: candidate.nextQuestion } : {}),
    ...(candidate.supportingRoutes?.length ? { supportingRoutes: candidate.supportingRoutes } : {}),
    ...(candidate.policy ? { policy: candidate.policy } : {}),
    ...(includeParameters ? { score: candidate.score } : {}),
  };
}

function workspaceMatches(context: CommandContext, request: string, limit: number): readonly Record<string, unknown>[] {
  try {
    return listWorkspaceActions(context, { query: request, limit }).slice(0, limit);
  } catch {
    return [];
  }
}

function modeMatches(request: string, limit: number): readonly Record<string, unknown>[] {
  try {
    const result = listHarnessModes({ query: request, limit }) as { readonly modes?: readonly Record<string, unknown>[] };
    const matches = result.modes?.slice(0, limit) ?? [];
    if (matches.length > 0) return matches;
    const simplified = simplifiedModeQuery(request);
    if (!simplified || simplified === request.toLowerCase()) return [];
    const fallback = listHarnessModes({ query: simplified, limit }) as { readonly modes?: readonly Record<string, unknown>[] };
    return fallback.modes?.slice(0, limit) ?? [];
  } catch {
    return [];
  }
}

export function planAgentTaskRoute(context: CommandContext, args: AgentRoutePlannerArgs): Record<string, unknown> {
  const request = readString(args.query) || readString(args.target);
  if (!request) {
    return {
      status: 'missing_request',
      usage: 'Use route action:"plan" query:"<user task>" to get the preferred GoodVibes Agent route, alternatives, missing fields, and confirmation boundary.',
      examples: [
        'Fix the failing tests in this repo.',
        'Triage my inbox and draft replies.',
        'Run a weekly source-backed research report.',
        'Why would settings action:set need confirmation?',
      ],
      policy: 'Route planning is read-only. It never runs tools, creates jobs, sends messages, changes settings, or opens UI surfaces.',
    };
  }

  const includeParameters = args.includeParameters === true;
  const limit = readLimit(args.limit, includeParameters ? 8 : 5);
  const ranked = [...buildCandidates(request)].sort((left, right) => right.score - left.score);
  const candidates = ranked
    .slice(0, limit)
    .map((candidate) => describeCandidate(candidate, includeParameters));
  const preferred = candidates[0]!;
  const workspaceActionMatches = workspaceMatches(context, request, includeParameters ? 6 : 3);
  const modes = modeMatches(request, includeParameters ? 6 : 3);

  return {
    status: 'ready',
    request: previewHarnessText(request, includeParameters ? 220 : 120),
    preferred,
    alternatives: candidates.slice(1),
    // The plan ranks and then cuts. Naming how many routes were considered
    // keeps `alternatives` from reading as "these are the only other routes"
    // when it is the top few of a longer ranked list.
    routesConsidered: ranked.length,
    ...(candidates.length < ranked.length
      ? { note: `Showing the ${candidates.length} highest-scoring of ${ranked.length} candidate routes; raise limit to see the rest.` }
      : {}),
    nextAction: preferred.requiresConfirmation
      ? 'Inspect the preferred route, collect missing fields, then run the returned confirmed route only after the user explicitly asks for that effect.'
      : 'Use the preferred read-only route first; only move to a confirmed route if the returned plan asks for one and the user requested the effect.',
    workspaceMatches: workspaceActionMatches,
    harnessModeMatches: modes,
    policy: 'GoodVibes Agent routes by user outcome. Package, daemon, TUI, SDK, and host ownership are diagnostic details; the model should choose the visible route that is easiest and safest for the user.',
  };
}
