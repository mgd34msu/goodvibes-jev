/**
 * disposal-wiring.ts
 *
 * Teardown for every poller the daemon's runtime graph starts.
 *
 * The mechanics, the ordered, best-effort, idempotent scope and the
 * all-required owner list, live in the SDK (`platform/runtime/disposal`), so
 * the daemon and the SDK's own composition root cannot drift into two different
 * ideas of what "stop the graph" means. What lives here is only the mapping from
 * the daemon's assembled graph onto that list, plus the four pollers the daemon
 * owns that the SDK's composition does not have at all: the crash-residue sweep,
 * the device housekeeping sweep, the wake-model recovery sweep, and the product
 * handler surfaces with their inbox timers. Calling the SDK's list alone would
 * silently leave every one of them running.
 *
 * It is a separate module because `runtime/services.ts` sits against the repo's
 * 800-line source cap (check-architecture.ts) with no room for the wiring.
 *
 * Ownership note, and the reason any of this exists: this product builds the
 * graph and hands the SAME object to `DaemonServer`. The SDK facade disposes
 * only a graph it constructed itself, so it deliberately leaves this one alone
 *, nothing upstream will ever stop these pollers. The shutdown paths in
 * daemon/cli.ts and the one-shot CLI commands are the only things that can.
 *
 * The owner type below is declared structurally rather than imported from
 * services.ts: that module imports this one, and a type-only edge is still a
 * cycle to the architecture check.
 */

import {
  createAsyncDisposalScope,
  registerRuntimePollers,
  type AsyncDisposalRegistry,
  type RuntimePollerOwners,
} from '@goodvibes-jev/engine/sdk/platform/runtime/disposal';

/** Re-exported so the composition root reaches the whole seam through one import. */
export { createAsyncDisposalScope as createDisposalScope };

/** The assembled graph, narrowed to the poller owners it exposes as fields. */
export interface DaemonRuntimePollerOwners extends Omit<RuntimePollerOwners, 'stopConfigWatch'> {
  /** Daemon-only: the repeating crash-residue sweep. */
  readonly stopDurabilityHousekeeping: () => void;
  /**
   * Daemon-only: the wake-word recovery sweep and a pending boot provision
   * Started only when an entrypoint opted into boot
   * provisioning, and a no-op otherwise, but it is on this list unconditionally,
   * because "the graph did not start it this time" is not a reason for the
   * teardown path to have no way to stop it.
   */
  readonly stopWakeHousekeeping: () => void;
  /**
   * Daemon-only: the product handler surfaces (daemon-handler-composition.ts).
   *
   * `close()` detaches gateway handlers and awaits the owned work of the pollers this
   * product's inbox surface owns, the retention sweep inside `InboxCursorStore`
   * and the per-provider `InboundPoller` intervals. The SDK does not know either
   * exists, so if this surface does not stop them nothing does.
   */
  readonly daemonHandlers: { readonly close: () => Promise<void> };
  /**
   * This daemon only: the paired-phone feature's housekeeping timer
   * (device-posture-composition.ts). Started by whichever entry point boots the
   * host, so the stop belongs on this list rather than in one shutdown path.
   */
  readonly devicePosture: { readonly stopHousekeeping: () => void };
}

/**
 * The poller owners this daemon holds that are NOT reachable from the
 * assembled graph, handles the factory keeps as locals.
 */
export interface RuntimeDisposalExtras {
  /** Handle returned by `ConfigManager.watchConfigFiles()`. */
  readonly stopConfigWatch: () => void;
}

/**
 * Register the stop call for every poller the graph started.
 *
 * `services` is the fully-assembled graph, which already exposes each poller
 * owner as a field, so a poller whose owner reaches the public surface is
 * wired by name rather than by threading another local out of the factory.
 */
export function registerDaemonRuntimePollers(
  registry: AsyncDisposalRegistry,
  services: DaemonRuntimePollerOwners,
  extras: RuntimeDisposalExtras,
): void {
  registerRuntimePollers(registry, { ...services, stopConfigWatch: extras.stopConfigWatch });
  registry.add('durability housekeeping', services.stopDurabilityHousekeeping);
  registry.add('device housekeeping', () => services.devicePosture.stopHousekeeping());
  registry.add('wake-word housekeeping', services.stopWakeHousekeeping);
  // Registered LAST so it tears down FIRST (the scope unwinds in reverse), which
  // is the order daemon/cli.ts already used by hand: release the handler surfaces
  //, closing the inbox store and stopping its poll timers, before the pollers
  // the rest of the graph owns. Being on this list is what makes a plain
  // `await close()` total: every shutdown path stops these, not just the one that
  // remembered to call `unregister()` itself.
  registry.add('daemon handler surfaces', () => services.daemonHandlers.close());
}
