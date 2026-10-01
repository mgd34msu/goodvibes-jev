/**
 * fleet-needs-input-push.ts, wires the fleet "needs-input" browser-push fan-out
 * that the SDK's registerGatewayVerbGroups (reached through the terminal-shell's
 * attachWsOnlyGatewayVerbHandlers wrapper) gates on two deps: `runtimeBus` and
 * `sessionPresence` (see push/service.js's attachFleetNeedsInputSource). When a
 * fleet node blocks on the operator, it pushes an "Input needed" notification
 * carrying the session/node deep link to every registered device, suppressed
 * while an operator surface is already attached to that node's session.
 *
 * TWO seams have to be live for a real push, not just descriptor presence:
 *  1. Fleet lifecycle deltas (FLEET_NODE_BLOCKED_ON_USER etc.) have to reach the
 *     runtime bus's 'fleet' domain in the first place. That is
 *     attachFleetEmitBridge, diffing the process registry's own coalesced
 *     snapshot tick into per-node lifecycle events. The terminal-shell package's
 *     createArchivableFleetRegistry only builds the registry, it does not
 *     attach the bridge, so the composition root that owns both the registry
 *     and the bus (this file) is the one place responsible for it. The SDK's
 *     own daemon composition (platform/runtime/services.ts) attaches this same
 *     bridge right after building its process registry.
 *  2. registerGatewayVerbGroups has to be handed `runtimeBus` (to subscribe onto
 *     that domain) and `sessionPresence` (to suppress a push when an operator is
 *     already looking at the session).
 *
 * sessionPresence is the SDK's own hasFreshSurfaceParticipant: a session counts
 * as attended when any participant heartbeated within the SDK's freshness
 * window. This is the one implementation, imported, so every surface's
 * push/suppress behavior agrees.
 */
import { attachFleetEmitBridge } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import type { ArchivableProcessRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { hasFreshSurfaceParticipant, SURFACE_ROUTE_FRESHNESS_MS, type SharedSessionBroker } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { RuntimeEventBus } from './index.js';

export interface FleetNeedsInputPushDeps {
  readonly runtimeBus: RuntimeEventBus;
  readonly sessionPresence: { isAttached(sessionId: string): boolean };
}

/**
 * Attach the fleet emit-bridge (registry snapshot deltas -> runtime bus `fleet`
 * domain) and build the presence lookup, returning both as the deps
 * `attachWsOnlyGatewayVerbHandlers` spreads into its call so the needs-input
 * push source registers for real instead of gracefully degrading to absent.
 */
export function wireFleetNeedsInputPush(input: {
  readonly registry: ArchivableProcessRegistry;
  readonly runtimeBus: RuntimeEventBus;
  readonly sessionBroker: Pick<SharedSessionBroker, 'getSession'>;
}): FleetNeedsInputPushDeps {
  attachFleetEmitBridge({ registry: input.registry, bus: input.runtimeBus });
  const sessionBroker = input.sessionBroker;
  return {
    runtimeBus: input.runtimeBus,
    sessionPresence: {
      isAttached: (sessionId: string) => {
        const session = sessionBroker.getSession(sessionId);
        return session !== null && hasFreshSurfaceParticipant(session, Date.now(), SURFACE_ROUTE_FRESHNESS_MS);
      },
    },
  };
}
