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
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { captureStrictJudgmentJson, prepareJudgmentResult } from '../../gate/judgment-result.js';
import { SOURCE_SCREENING_LIMITS, type SourceScreeningReceipt } from '../../security/source-screening/types.js';
import { ToolInputProjectionError } from '../../tools/input-projection.js';
import { NONE, type Outcome, type Selection } from '@goodvibes-jev/judgment';
import { mainConversationRoute, TASK_ROUTES } from './catalog.js';
import { routeCandidates, taskRoutePick } from './route-selector.js';
import { readSlots } from './slots.js';
import type { NamedId, NamedIdSources } from './named-ids.js';
import { previewText } from './text.js';
import type {
  MissingRequestPlan,
  ReadyPlan,
  TaskRouteArgs,
  TaskRouteCandidate,
  TaskRouteJudgment,
  TaskRouteConfidence,
  TaskRouteDeps,
  TaskRouteDraft,
  TaskRoutePlan,
  TaskRouteSlots,
  TaskRouteReadOptions,
} from './types.js';

export const TASK_ROUTE_SITE = 'routing.task-route.plan';

const NAMED_KINDS = ['modelProvider', 'memoryProvider', 'channelTarget'] as const;

async function whileCurrent<T>(work: Promise<T>, options: JudgmentReadingOptions): Promise<T> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (!options.signal) return work;
  const signal = options.signal;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new ToolInputProjectionError('held'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
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
  lookup: TaskRouteDeps['workspaceMatches'],
  request: string,
  limit: number,
  options: JudgmentReadingOptions,
): Promise<{ matches: readonly Record<string, unknown>[]; ranked: TaskRouteJudgment['workspace'] }> {
  if (lookup === undefined) return { matches: [], ranked: [] };
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const result = captureStrictJudgmentJson(await whileCurrent(Promise.resolve().then(() => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    return lookup(request, limit, options);
  }), options));
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (!('ranked' in result)) return { matches: result.slice(0, limit), ranked: [] };
  const byId = new Map(result.records.map(record => [String(record.id), record]));
  return {
    matches: result.ranked.filter(entry => entry.reading.verdict === 'yes' && entry.reading.outcome === 'act')
      .slice(0, limit).map(entry => {
        const record = byId.get(entry.id);
        if (!record) throw new Error('Task-route catalog reading names an absent record.');
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
 * and a current protected source owner; `deps` supplies the product catalogs
 * whose matches the plan lists.
 */
export async function planTaskRoute(
  args: TaskRouteArgs,
  deps: TaskRouteDeps = {},
  options: TaskRouteReadOptions = {},
): Promise<TaskRoutePlan> {
  const originalArgs = captureStrictJudgmentJson(args);
  const request = typeof originalArgs.query === 'string' && originalArgs.query.trim() ? originalArgs.query
    : typeof originalArgs.target === 'string' && originalArgs.target.trim() ? originalArgs.target : '';
  if (!request) return MISSING_REQUEST;
  assertJudgmentInput(originalArgs);

  const descriptors = (value: object) => {
    if (nodeTypes.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ToolInputProjectionError('invalid');
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !('value' in field))) throw new ToolInputProjectionError('invalid');
    return fields;
  };
  const sameBindings = (left: Record<string, PropertyDescriptor>, right: Record<string, PropertyDescriptor>) =>
    Object.keys(left).length === Object.keys(right).length && Object.entries(right).every(([key, field]) => {
      const current = left[key];
      return current !== undefined && Object.is(current.value, field.value) && current.enumerable === field.enumerable
        && current.configurable === field.configurable && current.writable === field.writable;
    });
  const depsFields = descriptors(deps), optionsFields = descriptors(options);
  const listing = deps.namedIds;
  const listingFields = listing === undefined ? undefined : descriptors(listing);
  const owner = options.sourceOwner;
  if (!owner) throw new ToolInputProjectionError('held');
  const ownerFields = descriptors(owner);
  const capture = owner.capture, screen = owner.screen, project = owner.project, release = owner.release;
  const signal = options.signal, callerCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const depsPrototype = Object.getPrototypeOf(deps), optionsPrototype = Object.getPrototypeOf(options);
  const ownerPrototype = Object.getPrototypeOf(owner), listingPrototype = listing === undefined ? undefined : Object.getPrototypeOf(listing);
  const assertBindings = () => {
    signal?.throwIfAborted();
    if (Object.getPrototypeOf(deps) !== depsPrototype || Object.getPrototypeOf(options) !== optionsPrototype
      || Object.getPrototypeOf(owner) !== ownerPrototype || (listing !== undefined && Object.getPrototypeOf(listing) !== listingPrototype)
      || !sameBindings(descriptors(deps), depsFields) || !sameBindings(descriptors(options), optionsFields)
      || !sameBindings(descriptors(owner), ownerFields)
      || (listing !== undefined && listingFields !== undefined && !sameBindings(descriptors(listing), listingFields))
      || !isDeepStrictEqual(captureStrictJudgmentJson(args), originalArgs)) throw new ToolInputProjectionError('held');
  };
  const assertCaller = () => {
    signal?.throwIfAborted();
    const checked: unknown = callerCurrent?.();
    if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); throw new ToolInputProjectionError('held'); }
    signal?.throwIfAborted();
  };
  assertBindings(); assertCaller(); assertBindings();
  const sources = NAMED_KINDS.map(kind => ({ kind, source: listing?.[kind] }));
  const snapshots = sources.map(({ kind, source }) => {
    assertBindings(); const ids = captureStrictJudgmentJson(source?.() ?? []); assertBindings();
    return { kind, source, ids };
  });
  const routeSource = captureStrictJudgmentJson(routeCandidates());
  const routeBuilders = TASK_ROUTES.map(entry => ({ entry, build: entry.build }));
  const sourceCurrent = () => {
    assertBindings();
    if (!isDeepStrictEqual(captureStrictJudgmentJson(routeCandidates()), routeSource)
      || routeBuilders.some(({ entry, build }, index) => TASK_ROUTES[index] !== entry || entry.build !== build)) throw new ToolInputProjectionError('held');
    for (const { source, ids } of snapshots) {
      if (!isDeepStrictEqual(captureStrictJudgmentJson(source?.() ?? []), ids)) throw new ToolInputProjectionError('held');
    }
    assertBindings();
  };
  const assertOriginal = () => {
    sourceCurrent();
    assertCaller();
    sourceCurrent();
  };
  assertOriginal();
  const parts = [request, ...snapshots.map(({ ids }) => JSON.stringify(ids))];
  if (parts.reduce((total, part) => total + part.length, 0) > SOURCE_SCREENING_LIMITS.characters) throw new ToolInputProjectionError('held');
  const handle = capture.call(owner, parts);
  let receipt: SourceScreeningReceipt | undefined;
  let projection: readonly string[] | undefined;
  let publicationCurrent = sourceCurrent;
  const assertSource = () => {
    assertOriginal();
    if (receipt && !isDeepStrictEqual(project.call(owner, receipt), projection)) throw new ToolInputProjectionError('held');
    assertOriginal();
  };
  const abort = () => { void release.call(owner, handle).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    assertSource();
    const screened = await whileCurrent(screen.call(owner, handle), { signal, assertCurrent: assertSource });
    assertSource();
    if (screened.status !== 'settled') throw new ToolInputProjectionError('held');
    receipt = screened.receipt; projection = captureStrictJudgmentJson(project.call(owner, receipt));
    if (projection.length !== parts.length || typeof projection[0] !== 'string') throw new ToolInputProjectionError('held');
    const protectedRequest = projection[0];
    const namedIds: NamedIdSources = Object.fromEntries(snapshots.map(({ kind, ids }, index) => {
      const text = projection?.[index + 1];
      if (typeof text !== 'string') throw new ToolInputProjectionError('held');
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed) || parsed.length !== ids.length) throw new ToolInputProjectionError('held');
      const protectedIds: NamedId[] = parsed.map((entry: unknown, item) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('id' in entry) || typeof entry.id !== 'string'
          || entry.id !== ids[item]?.id || !('names' in entry) || !Array.isArray(entry.names)
          || !entry.names.every((name: unknown) => typeof name === 'string')) throw new ToolInputProjectionError('held');
        return { id: entry.id, names: entry.names };
      });
      return [kind, () => protectedIds];
    }));
    assertJudgmentInput({ request: protectedRequest, namedIds: snapshots.map(({ kind }) => namedIds[kind]?.()) });
    assertSource();
    const authority = captureJudgmentPort(TASK_ROUTE_SITE, { ...options, assertCurrent: assertSource, prepareResultCapture: prepareJudgmentResult });
    const includeParameters = originalArgs.includeParameters === true;
    const limit = readLimit(originalArgs.limit, includeParameters ? 8 : 5);
    const matchLimit = includeParameters ? 6 : 3;
    const call = { site: TASK_ROUTE_SITE, signal: authority.signal, beforeAttempt: authority.assertCurrent };
    const catalogOptions = { ...options, signal: authority.signal, assertCurrent: authority.assertCurrent };
    const [selection, slotRun, workspaceMatches, harnessModeMatches] = await Promise.all([
      taskRoutePick.select(authority.port, { request: protectedRequest }, routeSource, call),
      readSlots(authority.port, protectedRequest, { ...call, namedIds, assertCurrent: authority.assertCurrent }),
      catalogMatches(deps.workspaceMatches, protectedRequest, matchLimit, catalogOptions),
      catalogMatches(deps.modeMatches, protectedRequest, matchLimit, catalogOptions),
    ]);
    authority.assertCurrent();
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
      const restriction = authority.consumeObservation();
      publicationCurrent = () => { sourceCurrent(); restriction.assertCurrent(); sourceCurrent(); };
      retainCurrent?.(publicationCurrent, TASK_ROUTE_SITE); assertOriginal(); publicationCurrent();
      return {
        status: 'uncertain', request: previewText(protectedRequest, includeParameters ? 220 : 120), judgment,
        nextAction: 'Resolve the outstanding Jev readings against current context before choosing a route.',
        policy: 'This incomplete read-only plan authorizes no dispatch or effects.',
      };
    }
    const ranked = rankRoutes(protectedRequest, selection, slotRun.slots);
    const candidates = ranked.slice(0, limit).map((route) => describeRoute(route, includeParameters));
    const preferred = candidates[0]!;
    selection.recordAction(`preferred ${preferred.id}`);
    slotRun.recordAction(`planned ${preferred.id}`);

    const plan: ReadyPlan = {
      status: 'ready',
      judgment,
      request: previewText(protectedRequest, includeParameters ? 220 : 120),
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
    authority.assertCurrent();
    const restriction = authority.consumeObservation();
    publicationCurrent = () => { sourceCurrent(); restriction.assertCurrent(); sourceCurrent(); };
    retainCurrent?.(publicationCurrent, TASK_ROUTE_SITE); assertOriginal(); publicationCurrent();
    return plan;
  } finally {
    signal?.removeEventListener('abort', abort);
    await release.call(owner, handle);
    assertOriginal(); publicationCurrent();
  }
}
