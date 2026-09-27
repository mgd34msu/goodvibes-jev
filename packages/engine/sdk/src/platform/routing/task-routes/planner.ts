/**
 * The task route planner: the agent's planAgentTaskRoute, with the keyword
 * ladder replaced by Jev readings. One planning pass asks, concurrently, the
 * route selection (route-selector.ts) and the slot readings (slots.ts); code
 * then composes the plan.
 *
 * - The preferred route is the selection's pick when that route fits; when
 *   the pick is none, or the picked route does not read as fitting, the plan
 *   prefers the main conversation.
 * - Alternatives are the other routes whose fit reads yes, best first by fit
 *   probability; routesConsidered counts the preferred route and those.
 * - confidence is the reading's outcome (act high, confirm medium, escalate
 *   low): the selection's for the preferred route, the fit reading's for an
 *   alternative. score, shown with includeParameters, is the fit probability
 *   (for the main conversation, the pick's probability of none).
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { NONE, type Outcome, type Selection } from '@goodvibes-jev/judgment';
import { mainConversationRoute, TASK_ROUTES } from './catalog.js';
import { routeCandidates, taskRoutePick } from './route-selector.js';
import { readSlots } from './slots.js';
import { previewText } from './text.js';
import type {
  MissingRequestPlan,
  ReadyPlan,
  TaskRouteArgs,
  TaskRouteCandidate,
  TaskRouteConfidence,
  TaskRouteDeps,
  TaskRouteDraft,
  TaskRoutePlan,
  TaskRouteSlots,
} from './types.js';

export const TASK_ROUTE_SITE = 'routing.task-route.plan';

/** Long requests say what they want in their opening; the readings need no more. */
const MAX_REQUEST_CHARS = 4_000;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The candidate limit: a number or numeric string, truncated and held to 1..20, else the fallback. */
export function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(20, Math.trunc(parsed)));
}

const CONFIDENCE: Readonly<Record<Outcome, TaskRouteConfidence>> = { act: 'high', confirm: 'medium', escalate: 'low' };

interface RankedRoute {
  readonly draft: TaskRouteDraft;
  readonly outcome: Outcome;
  readonly score: number;
}

function describeRoute(route: RankedRoute, includeParameters: boolean): TaskRouteCandidate {
  const { draft } = route;
  return {
    id: draft.id,
    label: draft.label,
    confidence: CONFIDENCE[route.outcome],
    userSurface: draft.userSurface,
    userOutcome: draft.userOutcome,
    why: draft.why,
    modelRoute: draft.modelRoute,
    inspectRoute: draft.inspectRoute,
    ...(draft.userRoute ? { userRoute: draft.userRoute } : {}),
    requiresConfirmation: draft.requiresConfirmation,
    ...(draft.missingFields?.length ? { missingFields: draft.missingFields } : {}),
    ...(draft.nextQuestion ? { nextQuestion: draft.nextQuestion } : {}),
    ...(draft.supportingRoutes?.length ? { supportingRoutes: draft.supportingRoutes } : {}),
    ...(draft.policy ? { policy: draft.policy } : {}),
    ...(includeParameters ? { score: route.score } : {}),
  };
}

/** The preferred route, then every other fitting route best first. */
export function rankRoutes(request: string, selection: Selection, slots: TaskRouteSlots): readonly RankedRoute[] {
  const fitting = TASK_ROUTES
    .map((entry) => ({ entry, fit: selection.fits[entry.id]! }))
    .filter(({ entry, fit }) => fit.verdict === 'yes' && entry.id !== selection.chosen)
    .sort((left, right) => right.fit.probability - left.fit.probability)
    .map(({ entry, fit }) => ({ draft: entry.build(request, slots), outcome: fit.outcome, score: fit.probability }));
  const chosen = selection.chosen === undefined ? undefined : TASK_ROUTES.find((entry) => entry.id === selection.chosen);
  const preferred: RankedRoute = chosen
    ? { draft: chosen.build(request, slots), outcome: selection.outcome, score: selection.fits[chosen.id]!.probability }
    : { draft: mainConversationRoute(request), outcome: selection.outcome, score: selection.pick.probabilities[NONE] ?? 0 };
  return [preferred, ...fitting];
}

async function catalogMatches(
  lookup: ((request: string, limit: number) => readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>) | undefined,
  request: string,
  limit: number,
): Promise<readonly Record<string, unknown>[]> {
  if (lookup === undefined) return [];
  try {
    return (await lookup(request, limit)).slice(0, limit);
  } catch {
    return [];
  }
}

const MISSING_REQUEST: MissingRequestPlan = {
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

/**
 * Plans the route for a user task. Needs an installed judgment port
 * (judgmentPort throws when none is); `deps` supplies the product catalogs
 * whose matches the plan lists.
 */
export async function planTaskRoute(
  args: TaskRouteArgs,
  deps: TaskRouteDeps = {},
  options: { readonly signal?: AbortSignal } = {},
): Promise<TaskRoutePlan> {
  const request = readString(args.query) || readString(args.target);
  if (!request) return MISSING_REQUEST;

  const includeParameters = args.includeParameters === true;
  const limit = readLimit(args.limit, includeParameters ? 8 : 5);
  const port = judgmentPort(TASK_ROUTE_SITE);
  const call = { site: TASK_ROUTE_SITE, ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const asked = request.slice(0, MAX_REQUEST_CHARS);
  const matchLimit = includeParameters ? 6 : 3;

  const [selection, slotRun, workspaceMatches, harnessModeMatches] = await Promise.all([
    taskRoutePick.select(port, { request: asked }, routeCandidates(), call),
    readSlots(port, asked, { ...call, namedIds: deps.namedIds }),
    catalogMatches(deps.workspaceMatches, request, matchLimit),
    catalogMatches(deps.modeMatches, request, matchLimit),
  ]);

  const ranked = rankRoutes(request, selection, slotRun.slots);
  const candidates = ranked.slice(0, limit).map((route) => describeRoute(route, includeParameters));
  const preferred = candidates[0]!;
  selection.recordAction(`preferred ${preferred.id}`);
  slotRun.recordAction(`planned ${preferred.id}`);

  const plan: ReadyPlan = {
    status: 'ready',
    request: previewText(request, includeParameters ? 220 : 120),
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
    workspaceMatches,
    harnessModeMatches,
    policy: 'GoodVibes Agent routes by user outcome. Package, daemon, TUI, SDK, and host ownership are diagnostic details; the model should choose the visible route that is easiest and safest for the user.',
  };
  return plan;
}
