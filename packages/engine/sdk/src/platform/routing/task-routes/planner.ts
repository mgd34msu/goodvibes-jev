/**
 * The task route planner: the agent's planAgentTaskRoute, with the keyword
 * ladder replaced by Jev readings. One planning pass asks, concurrently, the
 * route selection (route-selector.ts) and the slot readings (slots.ts); code
 * then composes the plan.
 *
 * A plan is ready only when the selected route, slots, named targets and
 * supplied catalog readings permit action. Unresolved readings remain typed
 * diagnostics in an uncertain plan, with no executable route recommendation.
 * Confident none means main conversation; uncertainty never implies none.
 * Alternatives contain only actionable fitting routes. All original readings
 * and decision ids remain available under judgment, independent of display limits.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { NONE, type Outcome, type Selection } from '@goodvibes-jev/judgment';
import { mainConversationRoute, TASK_ROUTES } from './catalog.js';
import { routeCandidates, taskRoutePick } from './route-selector.js';
import { readSlots } from './slots.js';
import { NAMED_ID_KINDS, type NamedIdSources } from './named-ids.js';
import { previewText } from './text.js';
import type {
  MissingRequestPlan,
  ReadyPlan,
  TaskRouteArgs,
  TaskRouteCandidate,
  TaskRouteCatalogResult,
  TaskRouteJudgment,
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
    .filter(({ entry, fit }) => fit.verdict === 'yes' && fit.outcome === 'act' && entry.id !== selection.chosen)
    .sort((left, right) => right.fit.probability - left.fit.probability)
    .map(({ entry, fit }) => ({ draft: entry.build(request, slots), outcome: fit.outcome, score: fit.probability }));
  const chosen = selection.chosen === undefined ? undefined : TASK_ROUTES.find((entry) => entry.id === selection.chosen);
  const preferred: RankedRoute = chosen
    ? { draft: chosen.build(request, slots), outcome: selection.outcome, score: selection.fits[chosen.id]!.probability }
    : { draft: mainConversationRoute(request), outcome: selection.outcome, score: selection.pick.probabilities[NONE] ?? 0 };
  return [preferred, ...fitting];
}

async function catalogMatches(
  lookup: ((request: string, limit: number) => TaskRouteCatalogResult | Promise<TaskRouteCatalogResult>) | undefined,
  request: string,
  limit: number,
): Promise<{ matches: readonly Record<string, unknown>[]; ranked: TaskRouteJudgment['workspace'] }> {
  if (lookup === undefined) return { matches: [], ranked: [] };
  const result = await lookup(request, limit);
  if (!('ranked' in result)) return { matches: result.slice(0, limit), ranked: [] };
  const byId = new Map(result.records.map(record => [String(record.id), record]));
  return {
    matches: result.ranked.filter(entry => entry.reading.verdict === 'yes' && entry.reading.outcome === 'act')
      .slice(0, limit).map(entry => {
        const record = byId.get(entry.id);
        if (!record) throw new Error(`Task-route catalog reading names an absent record: ${entry.id}`);
        return { ...record, judgment: entry };
      }),
    ranked: result.ranked,
  };
}

function selectionEvidence(selection: Selection): Omit<Selection, 'recordAction'> {
  const { recordAction: _recordAction, ...evidence } = selection;
  return evidence;
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

  options.signal?.throwIfAborted();
  const includeParameters = args.includeParameters === true;
  const limit = readLimit(args.limit, includeParameters ? 8 : 5);
  const port = judgmentPort(TASK_ROUTE_SITE);
  const call = { site: TASK_ROUTE_SITE, ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const asked = request.slice(0, MAX_REQUEST_CHARS);
  const matchLimit = includeParameters ? 6 : 3;

  // Bind judgments to this pass's exact live listings. A later registry edit
  // invalidates the pass; it must not publish routes for removed/replaced ids.
  const snapshots = Object.entries(deps.namedIds ?? {}).map(([kind, source]) => ({
    kind: kind as keyof typeof NAMED_ID_KINDS, source,
    ids: (source?.() ?? []).map(({ id, names }) => ({ id, names: [...names] })),
  }));
  const namedIds: NamedIdSources = Object.fromEntries(snapshots.map(({ kind, ids }) => [kind, () => ids]));
  const [selection, slotRun, workspaceMatches, harnessModeMatches] = await Promise.all([
    taskRoutePick.select(port, { request: asked }, routeCandidates(), call),
    readSlots(port, asked, { ...call, namedIds }),
    catalogMatches(deps.workspaceMatches, request, matchLimit),
    catalogMatches(deps.modeMatches, request, matchLimit),
  ]);

  options.signal?.throwIfAborted();
  for (const { source, ids } of snapshots) {
    if (JSON.stringify((source?.() ?? []).map(({ id, names }) => ({ id, names: [...names] }))) !== JSON.stringify(ids)) {
      selection.recordAction('stale context: no route published');
      slotRun.recordAction('stale context: no route published');
      throw new Error('Task-route context changed while judgment was pending; no route published.');
    }
  }
  const judgment: TaskRouteJudgment = {
    selection: selectionEvidence(selection),
    slots: { readings: slotRun.readings, decisionId: slotRun.decisionId },
    named: Object.fromEntries(Object.entries(slotRun.named).map(([kind, value]) => [kind, selectionEvidence(value)])),
    workspace: workspaceMatches.ranked,
    harness: harnessModeMatches.ranked,
  };
  const unresolved = selection.outcome !== 'act'
    || Object.values(slotRun.readings).some(reading => reading.outcome !== 'act')
    || Object.values(slotRun.named).some(reading => reading.outcome !== 'act')
    || [...workspaceMatches.ranked, ...harnessModeMatches.ranked].some(entry => entry.reading.outcome !== 'act');
  if (unresolved) {
    selection.recordAction('uncertain: no route published');
    slotRun.recordAction('uncertain: no route published');
    return {
      status: 'uncertain', request: previewText(request, includeParameters ? 220 : 120), judgment,
      nextAction: 'Resolve the outstanding Jev readings against current context before choosing a route.',
      policy: 'This incomplete read-only plan authorizes no dispatch or effects.',
    };
  }
  const ranked = rankRoutes(request, selection, slotRun.slots);
  const candidates = ranked.slice(0, limit).map((route) => describeRoute(route, includeParameters));
  const preferred = candidates[0]!;
  selection.recordAction(`preferred ${preferred.id}`);
  slotRun.recordAction(`planned ${preferred.id}`);

  const plan: ReadyPlan = {
    status: 'ready',
    judgment,
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
    workspaceMatches: workspaceMatches.matches,
    harnessModeMatches: harnessModeMatches.matches,
    policy: 'GoodVibes Agent routes by user outcome. Package, daemon, TUI, SDK, and host ownership are diagnostic details; the model should choose the visible route that is easiest and safest for the user.',
  };
  return plan;
}
