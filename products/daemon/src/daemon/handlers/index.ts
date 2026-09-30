/**
 * The daemon's host-handler assembly, adapted from pinned daemon 443e5ee.
 *
 * Registration order remains routing, inbox/triage, drafts, payments, remote;
 * cleanup is the reverse. The async boundary is deliberate: no half-ready
 * graph escapes, and a failed startup releases previously created owners
 * before rejecting. Product roots and boot callers must await this factory.
 *
 * Providers are actual surface factories supplied by the product root. This
 * module defines no gateway descriptor, fallback handler or semantic policy.
 */
import { createAsyncDisposalScope } from '@goodvibes-jev/engine/sdk/platform/runtime/disposal';
import type { RoutingRegistration as EngineRoutingRegistration } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { PaymentReplyInbox } from '@goodvibes-jev/engine/sdk/platform/payments';
import type { DistributedRuntimeRouteService } from './contracts.js';
import type { HandlerContext, OwnedHandlerSurface, SurfaceRegister } from './context.js';

/** The canonical routing handle narrowed to the members other surfaces need. */
export type RoutingRegistration = Pick<EngineRoutingRegistration, 'initialize' | 'close' | 'unregister' | 'resolveProfileId'>;

export interface RemoteInvokeAdapter {
  invoke(input: Record<string, unknown>): Promise<unknown>;
}

export interface RemoteSurfaceRegistration extends OwnedHandlerSurface {
  readonly service: DistributedRuntimeRouteService;
  readonly dispatch: RemoteInvokeAdapter;
}

export interface PaymentRegistration extends OwnedHandlerSurface {
  /** The actual inbox owned by this payment registration, borrowed by ingress. */
  readonly paymentReplies: PaymentReplyInbox;
}

export interface DaemonHandlerSurfaces {
  /** Legacy initiation only. New shutdown paths must await close(). */
  readonly unregister: () => void;
  readonly close: () => Promise<void>;
  readonly routing: RoutingRegistration;
  readonly paymentReplies: PaymentReplyInbox;
  readonly remoteSurface: { readonly service: DistributedRuntimeRouteService };
  readonly remoteDispatch: RemoteInvokeAdapter;
}

export interface DaemonHandlerSurfaceProviders {
  readonly registerRouting: (ctx: HandlerContext) => RoutingRegistration | Promise<RoutingRegistration>;
  readonly registerInbox: (ctx: HandlerContext, routing: RoutingRegistration) => OwnedHandlerSurface | Promise<OwnedHandlerSurface>;
  readonly registerDrafts: SurfaceRegister;
  readonly registerPayments: (ctx: HandlerContext) => PaymentRegistration | Promise<PaymentRegistration>;
  readonly registerRemote: (ctx: HandlerContext) => RemoteSurfaceRegistration | Promise<RemoteSurfaceRegistration>;
}

/** Compose every supplied surface and await its declared readiness before returning. */
export async function registerDaemonHandlers(
  ctx: HandlerContext,
  providers: DaemonHandlerSurfaceProviders,
): Promise<DaemonHandlerSurfaces> {
  const scope = createAsyncDisposalScope('Daemon handler surfaces');
  const acquire = async <T extends OwnedHandlerSurface>(
    label: string,
    create: () => T | Promise<T>,
  ): Promise<T> => {
    const surface = await create();
    // Register ownership before waiting, so a rejected ready promise cannot
    // strand the surface that failed or any owner created before it.
    scope.registry.add(label, () => surface.close());
    await surface.ready;
    return surface;
  };

  try {
    const routing = await acquire('routing', () => providers.registerRouting(ctx));
    await routing.initialize();
    await acquire('inbox', () => providers.registerInbox(ctx, routing));
    await acquire('drafts', () => providers.registerDrafts(ctx));
    const payments = await acquire('payments', () => providers.registerPayments(ctx));
    const remote = await acquire('remote', () => providers.registerRemote(ctx));
    return {
      unregister: () => scope.dispose(),
      close: scope.close,
      routing,
      paymentReplies: payments.paymentReplies,
      remoteSurface: { service: remote.service },
      remoteDispatch: remote.dispatch,
    };
  } catch (startupError) {
    try { await scope.close(); }
    catch (cleanupError) {
      throw new AggregateError([startupError, cleanupError], 'Daemon handler startup and cleanup failed');
    }
    throw startupError;
  }
}
