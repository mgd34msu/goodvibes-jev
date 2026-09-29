/**
 * handler-plumbing.ts, the small piece of host handler plumbing the `payments.*`
 * registration needs and the engine's catalog does not carry on its own.
 *
 * Ported from the daemon's `handlers/register.ts` and `handlers/errors.ts` with
 * behaviour unchanged:
 *
 *  - `registerCatalogHandler` binds a typed host handler to the descriptor the
 *    catalog already holds, BY ID, re-registering it with `{ replace: true }` so
 *    only the handler slot changes; no descriptor or schema is authored here.
 *  - `normalizeContext` reads the invocation context into the least-privilege
 *    envelope (an absent context is the empty one: no principal, no scopes, not
 *    admin, nobody claiming a person asked).
 *  - `assertConfirmed` is the confirmation gate: `body.confirm === true` AND
 *    `context.explicitUserRequest === true`, else a 403 `REQUIRE_CONFIRM`.
 *
 * The daemon's `HandlerError` is the engine's `GatewayVerbError` (a message, a
 * stable machine `code` and an HTTP `status`, read by shape at the dispatcher),
 * so the engine's own class is used instead of a second one.
 */
import type { GatewayMethodCatalog } from '../../control-plane/method-catalog.js';
import type {
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
} from '../../control-plane/method-catalog-shared.js';
import { GatewayVerbError } from '../../control-plane/routes/gateway-verb-error.js';

/** Code emitted when a confirmation-gated method is invoked without explicit user confirmation. */
export const REQUIRE_CONFIRM = 'REQUIRE_CONFIRM';

/** The refusal type every host payments handler throws. */
export const HandlerError = GatewayVerbError;
export type HandlerError = GatewayVerbError;

/** Function returned by every registration; calling it removes the attached handler. */
export type Unregister = () => void;

/** Normalized, host-facing principal/auth context derived from the invocation. */
export interface HandlerContextEnvelope {
  readonly principalId: string;
  readonly admin: boolean;
  readonly scopes: string[];
  readonly explicitUserRequest: boolean;
  readonly authToken: string;
}

/** Typed, host-facing shape of a single method invocation. */
export interface HandlerInvocation<TBody> {
  readonly body: TBody;
  readonly query: Record<string, string>;
  readonly context: HandlerContextEnvelope;
}

/** A host handler: receives the typed invocation, returns the method result. */
export type TypedHandler<TBody, TResult> = (
  input: HandlerInvocation<TBody>,
) => Promise<TResult>;

export interface RegisterHandlerOptions {
  /**
   * When true, the wrapper enforces a confirmation gate before the handler
   * runs: `body.confirm === true` AND `context.explicitUserRequest === true`.
   */
  readonly confirm?: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Derive the host-facing context envelope from the raw invocation context.
 * `explicitUserRequest` is carried in `context.metadata.explicitUserRequest`.
 *
 * An ABSENT context is accepted and read as the empty one. The type says a
 * context is always there and at runtime it is not always: an in-process invoke
 * that builds the invocation by hand can omit it, and reading `.metadata` off
 * `undefined` turned that into a TypeError thrown out of the handler wrapper
 * instead of the refusal every caller can act on. Defaulting to the least
 * privilege can cost a caller an authorization it never proved, never grant one.
 */
export function normalizeContext(
  c: GatewayMethodInvocationContext | undefined,
): HandlerContextEnvelope {
  const context: GatewayMethodInvocationContext = c ?? {};
  const metadata = context.metadata ?? {};
  return {
    principalId: context.principalId ?? '',
    admin: context.admin === true,
    scopes: context.scopes ? [...context.scopes] : [],
    explicitUserRequest: metadata['explicitUserRequest'] === true,
    authToken: context.authToken ?? '',
  };
}

function normalizeQuery(query: GatewayMethodInvocation['query']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') out[key] = value;
    else if (value != null) out[key] = String(value);
  }
  return out;
}

/**
 * Guard a confirmation-gated mutation. Throws `GatewayVerbError(REQUIRE_CONFIRM, 403)`
 * unless the caller both set `body.confirm === true` and the request was an
 * explicit user request.
 */
export function assertConfirmed(
  body: unknown,
  ctx: { readonly explicitUserRequest: boolean },
): void {
  const confirmed =
    typeof body === 'object'
    && body !== null
    && (body as { confirm?: unknown }).confirm === true;
  if (!confirmed || ctx.explicitUserRequest !== true) {
    throw new HandlerError('explicit user confirmation required', REQUIRE_CONFIRM, 403);
  }
}

/**
 * Attach a typed handler to the descriptor identified by `methodId`. Reuses the
 * descriptor the catalog already holds and re-registers it with the wrapped
 * handler via `{ replace: true }`.
 */
export function registerCatalogHandler<TBody, TResult>(
  catalog: GatewayMethodCatalog,
  methodId: string,
  handler: TypedHandler<TBody, TResult>,
  options?: RegisterHandlerOptions,
): Unregister {
  const descriptor = catalog.get(methodId);
  if (!descriptor) {
    throw new HandlerError(`Unknown gateway method: ${methodId}`, 'METHOD_NOT_FOUND', 404);
  }

  const wrapped = async (inv: GatewayMethodInvocation): Promise<unknown> => {
    const context = normalizeContext(inv.context);
    const body = inv.body as TBody;
    if (options?.confirm) assertConfirmed(inv.body, context);
    try {
      return await handler({ body, query: normalizeQuery(inv.query), context });
    } catch (error) {
      if (error instanceof HandlerError) throw error;
      throw new HandlerError(errorMessage(error), 'HANDLER_FAILED', 500);
    }
  };

  return catalog.register(descriptor, wrapped, { replace: true });
}

/** A single id to handler binding for batch registration. */
export interface CatalogHandlerEntry {
  readonly id: string;
  readonly handler: TypedHandler<unknown, unknown>;
  readonly options?: RegisterHandlerOptions;
}

/**
 * Register many handlers at once. Returns a single `Unregister` that tears them
 * down in REVERSE registration order (best-effort: a failing teardown never
 * aborts the rest).
 */
export function registerCatalogHandlers(
  catalog: GatewayMethodCatalog,
  entries: readonly CatalogHandlerEntry[],
): Unregister {
  const teardowns: Unregister[] = [];
  for (const entry of entries) {
    teardowns.push(registerCatalogHandler(catalog, entry.id, entry.handler, entry.options));
  }
  return () => {
    for (let i = teardowns.length - 1; i >= 0; i -= 1) {
      try {
        teardowns[i]!();
      } catch {
        // best-effort teardown; continue unwinding the rest
      }
    }
  };
}
