/**
 * Shared SDK protocol contracts for the daemon handler layer.
 *
 * Protocol types come from declared public engine subpaths. Implementation
 * factories and ownership types use their own public subpaths directly. The
 * host never re-declares an SDK id, descriptor or schema: it only attaches
 * handlers to the descriptors the SDK already registered.
 */

// Catalog + invocation contract types (concrete control-plane subpath, not a project barrel).
export type {
  GatewayMethodCatalog,
  GatewayMethodDescriptor,
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
  GatewayMethodHandler,
} from '@goodvibes-jev/engine/sdk/platform/control-plane';

// The SDK's own `payments.*` route module: the registrar and the service seam
// it dispatches to. The engine's payment host implementation owns the extra
// card, purchase and checkout handlers; product composition supplies its stores.
export { registerPaymentsGatewayMethods } from '@goodvibes-jev/engine/sdk/platform/control-plane';
export type { PaymentsGatewayService, PaymentPurchaseView } from '@goodvibes-jev/engine/sdk/platform/control-plane';

// The browser-checkout seam a daemon composition receives through
// `onBrowserCheckout` (sdk 2.0.19, platform/control-plane's
// `composeDaemonBrowser`). See daemon/handlers/payments/register.ts for how
// the checkout pair reads it.
export type { BrowserCheckoutSeam } from '@goodvibes-jev/engine/sdk/platform/control-plane';

// Channel domain types reused in handler signatures (read-only SDK interfaces; never re-declared).
export type {
  ChannelIdentity,
  ChannelResolvedTarget,
  ChannelAccountRecord,
} from '@goodvibes-jev/engine/sdk/platform/channels';

/**
 * The two remote-route contracts a host has to name: the per-peer auth
 * envelope, and the distributed-runtime service the SDK facade injects into
 * `DaemonRemoteRouteContext.distributedRuntime` so the published
 * `remote.peers.*` HTTP routes can dispatch to it.
 *
 * Both were declared here, by hand, as a verbatim structural mirror of the
 * daemon-sdk's own declarations, seventeen methods copied signature for
 * signature, for one reason: neither carried the `export` keyword upstream,
 * so neither could be imported. Both do now, and a mirror that can drift out of
 * agreement with the interface it must satisfy is worse than no mirror at all.
 *
 * They are re-exported under the same names so every implementer in this
 * product keeps naming them the way it already does. The engine now supplies shared remote backends; the product still owns
 * their composition and lifetime.
 */
export type { DistributedRuntimeRouteService, RemotePeerAuth } from '@goodvibes-jev/engine/daemon-sdk/remote-routes';
