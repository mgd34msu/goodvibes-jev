/**
 * daemon-gateway.ts, the verb catalog THE DAEMON composes over this graph, for
 * tests whose subject only becomes observable through one.
 *
 * ── Why a test builds one and the product does not ────────────────────────
 *
 * This process composes no server and starts no listener, so a verb handler
 * registered here would be reachable by nobody. The daemon serves the fifteen
 * verb families; the product's own catalog carries only what a loaded plugin
 * registers into it.
 *
 * ── What this helper is for, and what it is not ──────────────────────────
 *
 * It is NOT for pinning the platform's verb contracts. That job belongs to the
 * daemon repository, where the suites drive the daemon's OWN composition
 * (`createRuntimeServices(...).gatewayMethods`) instead of a reconstruction of
 * it, which is the difference between verifying the contract and verifying that
 * a copy of the dependency list still agrees with itself:
 *
 *   - goodvibes-daemon/src/test/daemon/gateway-verb-family-parity.test.ts
 *    , every verb family, with the reason each one registers
 *   - goodvibes-daemon/src/test/daemon/gateway-checkin-round-trip.test.ts
 *   - goodvibes-daemon/src/test/daemon/gateway-ci-principals-channel-profiles-round-trip.test.ts
 *   - goodvibes-daemon/src/test/daemon/gateway-catalog-handler-or-route.test.ts
 *    , the whole-catalog partition, so an unwired verb fails loudly
 *
 * What it IS for: the handful of suites in this repository whose subject is an
 * AGENT seam that only becomes observable through a daemon-shaped catalog,
 * this process's conversation rewind port, its occasions push/pull, its
 * `profile` tool, its voice-setup and memory-governance wiring. Those assert
 * something about this package; they just need a catalog to look through.
 *
 * Nothing about the product's catalog changes: `services.gatewayMethods` still
 * has no handler for any of these, which is pinned in
 * daemon/gateway-ws-only-invokable.test.ts.
 *
 * ── One caution ───────────────────────────────────────────────────────────
 *
 * This composes real stores under the graph's own `shellPaths`, including the
 * owner-profile document at daemon scope. Every caller here runs against a temp
 * home, and a suite that does not is reaching the machine's real profile.
 */
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { attachWsOnlyGatewayVerbHandlers } from '@goodvibes-jev/engine/terminal-shell';
import { createSessionConversationRewindPort } from '../../runtime/conversation-rewind-port.ts';
import type { RuntimeServices } from '../../runtime/services.ts';

export interface DaemonGatewayCatalogOptions {
  /** Override the conversation port; defaults to this process's live registry. */
  readonly conversationRewindPort?: Parameters<typeof attachWsOnlyGatewayVerbHandlers>[1]['conversationRewindPort'];
}

/**
 * Build the catalog a daemon composed from this graph would carry.
 *
 * The dep list is the full one the registrar takes, so a suite driving this
 * observes what a daemon over this graph does, not a narrower stand-in that
 * happens to answer.
 */
const cached = new WeakMap<RuntimeServices, GatewayMethodCatalog>();

export function buildDaemonGatewayCatalog(
  services: RuntimeServices,
  options: DaemonGatewayCatalogOptions = {},
): GatewayMethodCatalog {
  // One catalog per graph, like a daemon has. Rebuilding per call would give
  // each verb a fresh store, so a `principals.create` followed by a
  // `principals.list` would read an empty registry and the round-trip a suite
  // is asserting would never be observable.
  const existing = cached.get(services);
  if (existing && options.conversationRewindPort === undefined) return existing;
  const catalog = new GatewayMethodCatalog();
  const view = services.asDaemonGradeView();
  attachWsOnlyGatewayVerbHandlers(catalog, {
    // Platform runtime 2.0.8: the control-plane store resolver refuses a blank
    // surface segment, so this helper names its surface like any host.
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    processRegistry: services.processRegistry,
    sessionLiveTurnControls: services.sessionLiveTurnControls,
    powerManager: services.powerManager,
    memoryGovernor: services.memoryGovernor,
    voiceSetup: services.voiceSetup,
    workspaceCheckpointManager: services.guardedCheckpoints,
    sessionBroker: view.sessionBroker,
    secretsManager: services.secretsManager,
    approvalBroker: services.approvalBroker,
    requestApproval: (input) => services.approvalBroker.requestApproval(input),
    watcherRegistry: services.watcherRegistry,
    userPermissionRuleStore: view.userPermissionRuleStore,
    runtimeBus: services.runtimeBus,
    shellPaths: services.shellPaths,
    configManager: services.configManager,
    runtimeStore: services.runtimeStore,
    channelDeliveryRouter: services.channelDeliveryRouter,
    providerRegistry: services.providerRegistry,
    automationManager: services.automationManager,
    sessionLister: view.sessionBroker,
    attemptsController: services.orchestrationEngine,
    workingDirectory: services.workingDirectory,
    conversationRewindPort: options.conversationRewindPort ?? createSessionConversationRewindPort(),
  });
  if (options.conversationRewindPort === undefined) cached.set(services, catalog);
  return catalog;
}
