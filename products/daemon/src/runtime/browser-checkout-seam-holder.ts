/**
 * browser-checkout-seam-holder.ts, holding a seam that arrives after its
 * first reader is constructed.
 *
 * ── Why a holder, and not a constructor argument ──────────────────────────
 *
 * The SDK hands out a `BrowserCheckoutSeam` through `onBrowserCheckout`, a
 * callback `composeDaemonBrowser` invokes once, synchronously, at the moment
 * IT composes the browser. In this daemon that composition runs inside
 * `attachWsOnlyGatewayVerbHandlers` (services.ts), which is called AFTER
 * `createDaemonHandlerComposition` builds the payments handlers, because the
 * ws-only verb groups need managers (disposal scope, workspace checkpoint
 * manager, ...) that do not exist yet at the point payments is composed.
 * Reordering the two would ripple across every other verb group that call
 * builds, for one capability's benefit.
 *
 * So the payments composition cannot receive the seam as a constructor
 * argument; it receives a GETTER, closed over this holder, and reads it at
 * CALL time rather than at registration time. By the time any real invocation
 * reaches `payments.checkout.begin`, the daemon has finished booting and
 * `onBrowserCheckout` has already fired (or the composition is one where the
 * browser was never buildable at all, `composeDaemonBrowser` returned null,
 * homeDirectory absent, and the getter honestly keeps returning undefined
 * forever, which the checkout handler already refuses on cleanly).
 */
import type { BrowserCheckoutSeam } from '@goodvibes-jev/engine/sdk/platform/control-plane';

export interface BrowserCheckoutSeamHolder {
  readonly get: () => BrowserCheckoutSeam | undefined;
  readonly set: (seam: BrowserCheckoutSeam) => void;
  /**
   * Forgets the held seam. Call this from the browser's own disposal path
   * (services.ts, registered on the SAME disposal scope the browser sessions
   * teardown runs on), so a daemon that has started shutting its browser down
   * cannot hand a checkout call a seam whose `driverFor`/`cardFieldGuard` point
   * at an engine that is being (or has been) torn down. After this, `get()`
   * returns `undefined` again, and `payments.checkout.begin`/`.fillCard` fall
   * back to their ordinary "checkout is not available right now" 409 refusal,
   * see checkout-handlers.ts, rather than reaching into a disposed engine.
   */
  readonly clear: () => void;
}

export function createBrowserCheckoutSeamHolder(): BrowserCheckoutSeamHolder {
  let seam: BrowserCheckoutSeam | undefined;
  return {
    get: () => seam,
    set: (received) => {
      seam = received;
    },
    clear: () => {
      seam = undefined;
    },
  };
}
