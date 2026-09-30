// ---------------------------------------------------------------------------
// Channel routing surface, HANDLERS for the SDK-defined methods
//   - channels.routing.list   (read-only)
//   - channels.routing.assign (admin, confirmation-gated)
//   - channels.routing.delete (admin, dangerous, confirmation-gated)
//
// The SDK's GatewayMethodCatalog already registered the canonical descriptors
// (id, input/output schema, access, scopes, dangerous) for these three method
// ids with `handler: undefined`. This module NEVER re-declares an id, schema,
// or descriptor: it looks each one up by id and attaches a typed handler via
// `registerCatalogHandlers`, flipping the builtin method from HTTP-fallback to
// in-process execution. Handler outputs match the SDK output schemas exactly.
//
// Confirmation posture (per the daemon handoff, Responsibility 2): assign and
// delete are control-plane mutations that require explicit user confirmation
// (the SDK marks assign access:admin + 'Requires explicit confirmation', and
// delete dangerous:true). Both pass `{ confirm: true }` so the register wrapper
// enforces `body.confirm === true` AND `context.explicitUserRequest === true`.
// list is read-only and ungated.
// ---------------------------------------------------------------------------

import type { RoutingHostContext as HandlerContext } from './registration-types.js';
import {
  registerCatalogHandlers,
  HandlerError,
  type CatalogHandlerEntry,
  type TypedHandler,
  type Unregister,
} from '../../control-plane/host-handlers.js';
import {
  buildChannelId,
  parseChannelId,
  RouteStore,
  toRouteListItem,
  type RoutingChannelRoute,
  type RoutingRouteListItem,
} from './route-store.js';
import { createRoutingResolver, type RoutingResolver } from './routing-resolver.js';

export { createInboxRouteResolver, type RouteResolver, type RouteResolverInput } from './inbox-bridge.js';
export {
  buildChannelId,
  parseChannelId,
  RouteStore,
  toRouteListItem,
  type RoutingChannelRoute,
  type RoutingRouteListItem,
} from './route-store.js';
export {
  createRoutingResolver,
  resolveProfile,
  WILDCARD_SURFACE,
  type RoutingResolver,
} from './routing-resolver.js';

// ---------------------------------------------------------------------------
// Wire shapes (derived from the SDK contracts; NOT re-declared schemas).
//
// list   in : { profileId?, surfaceKind?, limit? }
//         out: { routes: [{ id, createdAt, updatedAt, surfaceKind, routeId?,
//                           profileId, label? }], total }   (SDK route-item shape)
// assign in : { channelId?, surfaceKind, routeId?, profileId, label? }
//             out: { assignmentId, channelId?, surfaceKind, routeId?, profileId, label?, createdAt, updatedAt }
// delete in : { assignmentId }                        out: { deleted, assignmentId }
// ---------------------------------------------------------------------------

interface RoutingListBody {
  profileId?: unknown;
  surfaceKind?: unknown;
  limit?: unknown;
}
interface RoutingListResult {
  routes: RoutingRouteListItem[];
  total: number;
}

interface RoutingAssignBody {
  channelId?: unknown;
  surfaceKind?: unknown;
  routeId?: unknown;
  profileId?: unknown;
  label?: unknown;
}
interface RoutingAssignResult {
  assignmentId: string;
  channelId: string;
  surfaceKind: string;
  routeId?: string;
  profileId: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

interface RoutingDeleteBody {
  assignmentId?: unknown;
}
interface RoutingDeleteResult {
  deleted: boolean;
  assignmentId: string;
}

const LIST_METHOD = 'channels.routing.list';
const ASSIGN_METHOD = 'channels.routing.assign';
const DELETE_METHOD = 'channels.routing.delete';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function clampLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.floor(n));
}

/**
 * Routing surface handle. Satisfies the foundation `RoutingRegistration`
 * (`{ unregister, resolveProfileId }`) and exposes the live
 * {@link RoutingResolver} and {@link RouteStore} so the inbox surface and tests
 * can reuse routing resolution without going through the catalog.
 */
export interface RoutingRegistration {
  readonly unregister: Unregister;
  /** Explicit lazy readiness. Await before the synchronous resolver is used. */
  readonly initialize: () => Promise<void>;
  /** Stop admission and await all owned handlers/storage before replacement. */
  readonly close: () => Promise<void>;
  readonly resolveProfileId: (surfaceKind: string, routeId?: string) => string | null;
  readonly resolver: RoutingResolver;
  readonly store: RouteStore;
}

/**
 * Attach the channel-routing handlers to the SDK gateway catalog held by `ctx`.
 *
 * The {@link RouteStore} is lazily initialized on first invocation (the
 * register contract is synchronous) so registration never blocks on disk I/O.
 * Await initialize() before using the synchronous resolver; catalog calls warm
 * storage lazily themselves. Await close() before transferring ownership.
 */
export function registerRoutingMethods(ctx: HandlerContext): RoutingRegistration {
  const descriptors = [LIST_METHOD, ASSIGN_METHOD, DELETE_METHOD].map((id) => {
    const descriptor = ctx.catalog.get(id);
    if (!descriptor) throw new HandlerError(`Unknown gateway method: ${id}`, 'METHOD_NOT_FOUND', 404);
    return descriptor;
  });
  const store = new RouteStore({ workingDirectory: ctx.workingDirectory });
  const rawResolver = createRoutingResolver(store);
  let closed = false;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  let mutationTail: Promise<unknown> = Promise.resolve();
  const closedError = (): HandlerError => new HandlerError('Routing surface is closed', 'ROUTING_SURFACE_CLOSED', 409);
  const own = <T>(operation: () => Promise<T>, mutation = false): Promise<T> => {
    if (closed) return Promise.reject(closedError());
    const work = (mutation ? mutationTail : Promise.resolve()).then(operation);
    active.add(work);
    if (mutation) mutationTail = work.then(() => {}, () => {});
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  };
  const admit = (handler: TypedHandler<unknown, unknown>, mutation = false): TypedHandler<unknown, unknown> =>
    (input) => own(() => handler(input), mutation);

  let initPromise: Promise<void> | null = null;
  const ensureInit = async (): Promise<void> => {
    if (!initPromise) {
      initPromise = store.init().catch((error) => {
        // Allow a later invocation to retry initialization.
        initPromise = null;
        throw error;
      });
    }
    await initPromise;
  };

  const listHandler: TypedHandler<RoutingListBody, RoutingListResult> = async ({ body }) => {
    await ensureInit();
    const profileId = optionalString(body.profileId);
    const surfaceKind = optionalString(body.surfaceKind);
    const routes = store.list({
      ...(profileId !== undefined ? { profileId } : {}),
      ...(surfaceKind !== undefined ? { surfaceKind } : {}),
    });
    const limit = clampLimit(body.limit);
    const limited = limit !== undefined ? routes.slice(0, limit) : routes;
    // Project to the SDK `channels.routing.list` item shape: emit `id`
    // (= assignmentId) and drop the daemon-internal `channelId`/`assignmentId`,
    // which additionalProperties:false forbids.
    const items = limited.map(toRouteListItem);
    return { routes: items, total: items.length };
  };

  const assignHandler: TypedHandler<RoutingAssignBody, RoutingAssignResult> = async ({ body, context }) => {
    await ensureInit();
    const profileId = optionalString(body.profileId);
    if (profileId === undefined) {
      throw new Error('profileId is required');
    }
    // The SDK contract accepts either a composite `channelId` or the
    // `surfaceKind` (+ optional `routeId`) parts. Prefer an explicit
    // channelId; otherwise build one from the parts.
    const explicitChannelId = optionalString(body.channelId);
    const surfaceKind = optionalString(body.surfaceKind);
    const routeId = optionalString(body.routeId);
    const channelId = explicitChannelId ?? (
      surfaceKind !== undefined ? buildChannelId(surfaceKind, routeId) : undefined
    );
    if (channelId === undefined) {
      throw new Error('surfaceKind (or channelId) is required');
    }
    const label = optionalString(body.label);
    const { route, created } = await store.upsert({
      channelId,
      profileId,
      ...(label !== undefined ? { label } : {}),
    });
    ctx.logger.info('channels.routing.assign', {
      assignmentId: route.assignmentId,
      channelId: route.channelId,
      surfaceKind: route.surfaceKind,
      profileId: route.profileId,
      created,
      principalId: context.principalId,
    });
    const result: RoutingAssignResult = {
      assignmentId: route.assignmentId,
      channelId: route.channelId,
      surfaceKind: route.surfaceKind,
      profileId: route.profileId,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    };
    if (route.routeId !== undefined) result.routeId = route.routeId;
    if (route.label !== undefined) result.label = route.label;
    return result;
  };

  const deleteHandler: TypedHandler<RoutingDeleteBody, RoutingDeleteResult> = async ({ body, context }) => {
    await ensureInit();
    const assignmentId = optionalString(body.assignmentId);
    if (assignmentId === undefined) {
      throw new Error('assignmentId is required');
    }
    const deleted = await store.delete(assignmentId);
    ctx.logger.info('channels.routing.delete', {
      assignmentId,
      deleted,
      principalId: context.principalId,
    });
    return { deleted, assignmentId };
  };

  const entries: CatalogHandlerEntry[] = [
    { id: LIST_METHOD, handler: admit(listHandler as TypedHandler<unknown, unknown>) },
    {
      id: ASSIGN_METHOD,
      handler: admit(assignHandler as TypedHandler<unknown, unknown>, true),
      options: { confirm: true },
    },
    {
      id: DELETE_METHOD,
      handler: admit(deleteHandler as TypedHandler<unknown, unknown>, true),
      options: { confirm: true },
    },
  ];

  const teardownHandlers = registerCatalogHandlers(ctx.catalog, entries);

  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    const errors: unknown[] = [];
    try { teardownHandlers(); } catch (error) { errors.push(error); }
    for (const descriptor of descriptors) {
      try { ctx.catalog.register(descriptor, undefined, { replace: true }); } catch (error) { errors.push(error); }
    }
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...active]);
      try { await store.close(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, 'Routing surface did not close cleanly');
    });
    void closing.catch(() => {
      try { ctx.logger.warn('Routing surface did not close cleanly'); } catch { /* Preserve cleanup failure. */ }
    });
    return closing;
  };
  const resolve = (surfaceKind: string, routeId?: string): string | null => {
    if (closed) throw closedError();
    return rawResolver.getProfileForChannel(surfaceKind, routeId);
  };
  return {
    unregister: () => { void close(); },
    initialize: () => own(async () => {
      await ensureInit();
      // A stopped startup must not tell a new intake consumer it is ready.
      if (closed) throw closedError();
    }),
    close,
    resolveProfileId: resolve,
    resolver: { getProfileForChannel: resolve, resolveProfile: resolve },
    store,
  };
}

/**
 * Provider entry point consumed by `registerDaemonHandlers`
 * (`DaemonHandlerSurfaceProviders.registerRouting`).
 */
export const registerRouting = (ctx: HandlerContext): RoutingRegistration =>
  registerRoutingMethods(ctx);
