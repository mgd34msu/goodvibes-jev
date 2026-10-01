/**
 * Runtime barrel for the daemon product.
 *
 * The SDK groups its runtime seams into namespace exports (`bootstrap`,
 * `observability`, `operations`, `security`, `shell`, `state`, `transport`,
 * `ui`). This file names the ones the daemon composition actually uses so the
 * composition modules import them as plain symbols, and so there is exactly one
 * place to look when the SDK moves one.
 *
 * It re-exports and nothing else: no local runtime entry points, no wrappers, no
 * behavior. Anything that needs behavior belongs in its own module or in the
 * SDK.
 */

// Type-only: the runtime namespace objects must never be READ at module scope.
// An eager `export const X = ns.X` compiles to a top-level property read off a
// lazy namespace object, and Bun's single-file compiler orders module bodies
// nondeterministically, on some builds the read lands before the defining
// module and the binary dies at load. Values below are grouped live re-exports
// from the SDK's registered subpaths instead; the toolchain post-build-smoke
// scans compiled artifacts for the eager pattern and fails the build if one
// returns.
import type {
  operations,
  shell,
  ui,
} from '@goodvibes-jev/engine/sdk/platform/runtime';

// State, the event bus and the read-model store.
export * from '@goodvibes-jev/engine/sdk/platform/runtime/state';
export * from '@goodvibes-jev/engine/sdk/platform/runtime/store';
export * from '@goodvibes-jev/engine/sdk/platform/runtime/feature-flags';
export * from '@goodvibes-jev/engine/sdk/platform/runtime/settings';
export * from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';

// Shell paths + the surface-scoped storage handle. Grouped live re-exports:
// class values (WorktreeRegistry etc.) carry their instance types with them.
export { createShellPathService, WorktreeRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
export type ShellPathService = shell.ShellPathService;
export { createSessionSurface } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
export type SessionSurface = operations.SessionSurface;

// Remote execution + the distributed runtime.
export {
  DistributedRuntimeManager,
  RemoteRunnerRegistry,
  RemoteSupervisor,
} from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

// Boot helpers the daemon runs itself (the facade does not know about them).
export { synchronizeConfiguredServices as syncConfiguredServices } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';

// Observability.
export {
  TelemetryApiService,
  ComponentHealthMonitor,
  IdempotencyStore,
} from '@goodvibes-jev/engine/sdk/platform/runtime/observability';

// Security.
export { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';

// Integration helpers (surface-scoped continuity reads) and the no-op screen
// stand-ins. The daemon facade's service-graph contract names a panel manager
// and a keybindings manager because a surface that has a screen supplies real
// ones; the daemon has no screen, and the SDK ships the honest no-ops for
// exactly this case rather than leaving a hole a fake would fill.
export {
  IntegrationHelperService,
  createNoopPanelManager,
  createNoopKeybindingsManager,
} from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
export type PanelManagerLike = ui.PanelManagerLike;
export type KeybindingsManagerLike = ui.KeybindingsManagerLike;

// Notification routing types (the router itself is imported from its own subpath).
export type Notification = ui.Notification;
export type RoutingDecision = ui.RoutingDecision;

// Outbound network transport installation (proxy/TLS policy from settings).
export { GlobalNetworkTransportInstaller } from '@goodvibes-jev/engine/sdk/platform/runtime/transport';


// Runtime event payload unions, re-exported so a consumer names one import path
// for the bus and the shapes that travel on it. WRFC orchestration/workflow
// events were replaced by ContractEvent; the permission domain became GateEvent.
// Do not publish legacy aliases for incompatible payload unions.
export type {
  AgentEvent,
  CommunicationEvent,
  OpsEvent,
  ContractEvent,
  GateEvent,
  ProviderEvent,
  RouteEvent,
  SessionEvent,
  TaskEvent,
  ToolEvent,
  TransportEvent,
  TurnEvent,
} from '@goodvibes-jev/engine/sdk/events';
