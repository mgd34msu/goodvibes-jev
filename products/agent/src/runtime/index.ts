/**
 * Runtime module barrel for GoodVibes Agent.
 *
 * The shared runtime removed private deep imports and the runtime root
 * god-barrel. This file keeps the Agent app on public runtime exports
 * while preserving the local import surface used by the shell.
 */

// `security` is the ONLY namespace object imported as a value: its members are
// read inside function bodies (evaluateSegmentNode / evaluateCommandAST below),
// which run after the module graph settles. Everything else re-exports from the
// SDK's registered runtime subpaths as grouped live re-exports, an eager
// `export const X = ns.X` is a module-scope read off a lazy namespace object,
// and Bun's single-file compiler orders module bodies nondeterministically, so
// on some builds the read landed before the defining module and the compiled
// binary died at load with a ReferenceError (this repo's 2.0.11 CI smoke
// failure; the operations block below documents the first bite of this class).
// The toolchain post-build-smoke now scans compiled artifacts for the eager
// pattern and fails the build if one returns.
import { security } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  bootstrap as Bootstrap,
  operations as Operations,
  security as Security,
  shell as Shell,
  transport as Transport,
} from '@goodvibes-jev/engine/sdk/platform/runtime';

// Local runtime entry points.
export { bootstrapRuntime } from './bootstrap.ts';
export type { RuntimeContext, BootstrapOptions } from './context.ts';
export type { BootstrapContext } from './bootstrap.ts';
export { createUiRuntimeServices } from './ui-services.ts';
export type { UiRuntimeServices } from './ui-services.ts';

// Public runtime exports. createFeatureFlagManager comes straight from the
// SDK state surface below: gate states are seeded from domain settings keys
// via deriveFeatureStates (exported there too), so the old local wrapper that
// filtered unknown persisted featureFlags-category ids has nothing to filter.
export * from '@goodvibes-jev/engine/sdk/platform/runtime/state';
export * from '@goodvibes-jev/engine/sdk/platform/runtime/store';
export * from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
export * from '@goodvibes-jev/engine/sdk/platform/runtime/observability';
export * from '@goodvibes-jev/engine/sdk/platform/runtime/settings';
export * from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
export {
  CONTROL_PLANE_CLIENT_KINDS,
  CONTROL_PLANE_TRANSPORT_KINDS,
  ROUTE_SURFACE_KINDS,
  SURFACE_KINDS,
  registeredEventTypes,
  validateKnownEvent as validateEvent,
} from '@goodvibes-jev/engine/sdk/events';
export type {
  AgentEvent,
  CommunicationEvent,
  CompactionEvent,
  DeliveryEvent,
  McpEvent,
  OpsEvent,
  OpsInterventionReason,
  ContractEvent,
  GateEvent,
  PlannerEvent,
  PluginEvent,
  ProviderEvent,
  RouteEvent,
  SessionEvent,
  TaskEvent,
  ToolEvent,
  TransportEvent,
  TurnEvent,
} from '@goodvibes-jev/engine/sdk/events';

// Bootstrap compatibility aliases, grouped live re-exports (see the import
// comment above for why these must not be eager namespace reads).
export {
  scheduleBackgroundMcpDiscovery,
  startBackgroundProviderDiscovery,
  startBackgroundProviderDiscovery as startBackgroundProviderRegistration,
  loadRuntimeSystemPrompt,
  loadRuntimeSystemPrompt as loadBootstrapSystemPrompt,
  restoreRuntimeModel,
  restoreRuntimeModel as restoreSavedModel,
  synchronizeConfiguredServices,
  synchronizeConfiguredServices as syncConfiguredServices,
  registerHostRuntimeEvents,
  // Shared adopt-or-spawn policy (daemon-adoption-policy.ts): probes the
  // configured host/port, band-checks any GoodVibes daemon found there, and
  // only ever ADOPTS a compatible one, Agent passes `adoptOnly: true` at the
  // call site (bootstrap-external-services.ts) so it never spawns or embeds a
  // daemon itself. A daemon that is INSTALLED on this machine but stopped is
  // handled separately at boot: one start through the platform service manager,
  // then a fresh adopt-only probe (the SDK's autostartInstalledDaemon, wired in
  // runtime/bootstrap-external-services.ts).
  startHostServices,
  startHostServices as startExternalServices,
  registerBootstrapHookBridge,
  createDeferredStartupCoordinator,
  shutdownRuntime,
  saveSession,
  fireSessionStart,
  createDirectTransportServices,
  createOperatorClientServices,
  createPeerClientDependencies,
  createRuntimeFoundationClients,
  createOperatorClient,
  createPeerClient,
  createRuntimeProviderApi,
  createRuntimeKnowledgeApi,
  createRuntimeHookApi,
  createRuntimeMcpApi,
  createRuntimeOpsApi,
} from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';

export type BackgroundRuntimeTaskHandle = Bootstrap.BackgroundRuntimeTaskHandle;
export type BackgroundMcpDiscoveryOptions = Bootstrap.BackgroundMcpDiscoveryOptions;
export type BackgroundProviderDiscoveryOptions = Bootstrap.BackgroundProviderDiscoveryOptions;
export type HostSystemMessageSink = Bootstrap.HostSystemMessageSink;
export type RuntimeSelectionState = Bootstrap.RuntimeSelectionState;
export type RuntimeModelSelectionState = Bootstrap.RuntimeModelSelectionState;
export type BootstrapRuntimeEventBridgeOptions = Bootstrap.BootstrapRuntimeEventBridgeOptions;
export type HostRuntimeEventBridgeOptions = Bootstrap.HostRuntimeEventBridgeOptions;
export type HostRuntimeMessageRouter = Bootstrap.HostRuntimeMessageRouter;
export type HostServiceMode = Bootstrap.HostServiceMode;
export type HostServicesConfig = Bootstrap.HostServicesConfig;
export type HostServicesHandle = Bootstrap.HostServicesHandle;
export type ExternalServicesHandle = Bootstrap.HostServicesHandle;
export type HostServiceStatus = Bootstrap.HostServiceStatus;
export type HookBridgeRegistrationOptions = Bootstrap.HookBridgeRegistrationOptions;
export type DeferredStartupCoordinator = Bootstrap.DeferredStartupCoordinator;
export type DeferredStartupTask = Bootstrap.DeferredStartupTask;
export type DirectTransportServicesOptions = Bootstrap.DirectTransportServicesOptions;
export type DirectTransportServices = Bootstrap.DirectTransportServices;
export type OperatorClientServicesOptions = Bootstrap.OperatorClientServicesOptions;
export type OperatorClientServices = Bootstrap.OperatorClientServices;
export type OperatorClientReadModels = Bootstrap.OperatorClientReadModels;
export type RuntimeFoundationClients = Bootstrap.RuntimeFoundationClients;
export type RuntimeFoundationClientsOptions = Bootstrap.RuntimeFoundationClientsOptions;
export type OperatorClient = Bootstrap.OperatorClient;
export type PeerClient = Bootstrap.PeerClient;
export type OpsApi = Bootstrap.OpsApi;

// Transport compatibility aliases, grouped live re-exports.
export {
  createDirectTransport,
  createDirectTransportFromServices,
  createRuntimeDirectTransport,
  createDirectClientTransport,
  createHttpTransport,
  createClientTransport,
  buildUrl,
  createTransportPaths,
  normalizeBaseUrl,
  createFetch,
  createHttpJsonTransport,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJsonRaw,
  requestJsonRaw as requestJson,
  createRealtimeTransport,
  invokeContractRoute,
  openContractRouteStream,
  requireContractRoute,
  isAbortError,
  openServerSentEventStream,
  createOperatorRemoteClient,
  createPeerRemoteClient,
  buildEventSourceUrl,
  buildWebSocketUrl,
  createEventSourceConnector,
  createRemoteDomainEvents,
  createRemoteRuntimeEvents,
  createRemoteUiRuntimeEvents,
  createWebSocketConnector,
  applyOutboundTlsToFetchInit,
  createNetworkFetch,
  GlobalNetworkTransportInstaller,
  inspectOutboundTls,
} from '@goodvibes-jev/engine/sdk/platform/runtime/transport';

export type DirectTransport = Transport.DirectTransport;
export type DirectClientTransport<TOperator = unknown, TPeer = unknown> = Transport.DirectClientTransport<TOperator, TPeer>;
export type HttpTransport = Transport.HttpTransport;
export type HttpTransportOptions = Transport.HttpTransportOptions;
export type HttpTransportSnapshot = Transport.HttpTransportSnapshot;
export type ClientTransport<TKind extends string = string, TOperator = unknown, TPeer = unknown> = Transport.ClientTransport<TKind, TOperator, TPeer>;
export type TransportPaths = Transport.TransportPaths;
export type RealtimeTransport = Transport.RealtimeTransport;
export type RealtimeTransportOptions = Transport.RealtimeTransportOptions;
export type RealtimeTransportSnapshot = Transport.RealtimeTransportSnapshot;
export type HttpJsonRequestOptions = Transport.HttpJsonRequestOptions;
export type HttpJsonTransport = Transport.HttpJsonTransport;
export type HttpJsonTransportOptions = Transport.HttpJsonTransportOptions;
export type JsonObject = Transport.JsonObject;
export type JsonValue = Transport.JsonValue;
export type ResolvedContractRequest = Transport.ResolvedContractRequest;
export type TransportJsonError = Transport.TransportJsonError;
export type ContractInvokeOptions = Transport.ContractInvokeOptions;
export type ContractRouteDefinition = Transport.ContractRouteDefinition;
export type ContractRouteLike = Transport.ContractRouteLike;
export type ContractStreamOptions = Transport.ContractStreamOptions;
export type ServerSentEventHandlers = Transport.ServerSentEventHandlers;
export type ServerSentEventOptions = Transport.ServerSentEventOptions;
export type OperatorRemoteClient = Transport.OperatorRemoteClient;
export type OperatorRemoteClientInvokeOptions = Transport.OperatorRemoteClientInvokeOptions;
export type OperatorRemoteClientStreamOptions = Transport.OperatorRemoteClientStreamOptions;
export type PeerRemoteClient = Transport.PeerRemoteClient;
export type PeerRemoteClientInvokeOptions = Transport.PeerRemoteClientInvokeOptions;
export type DomainEventConnector<TDomain extends string = string, TEvent extends { readonly type: string } = { readonly type: string }> = Transport.DomainEventConnector<TDomain, TEvent>;
export type RemoteDomainEventsOptions = Transport.RemoteDomainEventsOptions;
export type RemoteDomainEvents<TDomain extends string = string, TEvent extends { readonly type: string } = { readonly type: string }> = Transport.RemoteDomainEvents<TDomain, TEvent>;
export type RemoteRuntimeEventsOptions = Transport.RemoteRuntimeEventsOptions;
export type RemoteRuntimeEvents = Transport.RemoteRuntimeEvents;
export type SerializedRuntimeEnvelope = Transport.SerializedRuntimeEnvelope;

// Operations compatibility aliases. Grouped as a single live ESM re-export
// from the SDK's own `platform/runtime/operations` subpath rather than eager
// `export const X = operations.X` module-scope reads off the `operations`
// namespace object: those reads evaluated the namespace getter while the
// compiled single-file bundle could still be mid-cycle, and the binding they
// reached for was not defined yet, source execution hid this, the compiled
// binary died on it at load. A grouped `export { ... } from '<subpath>'` is a
// live binding resolved by the module system, not a module-scope value read,
// so it is cycle-safe.
// (OpsControlPlane and its error classes are deliberately NOT re-exported:
// the Agent never constructs the ops intervention plane, connected-host
// tasks are read-only by product policy, with mutations routed to
// /workplan and /delegate.)
export {
  ToolContractVerifier, McpLifecycleManager, McpPermissionManager, McpSchemaFreshnessTracker, buildMcpAttackPathReview, createMcpLifecycleManager,
  DEFAULT_RECONNECT_CONFIG, ALL_CAPABILITIES, PLUGIN_CAPABILITIES, HIGH_RISK_CAPABILITIES, PluginLifecycleManager, PluginQuarantineEngine,
  PluginTrustStore, SAFE_CAPABILITIES, filterCapabilitiesByTrust, hasCapability, isHighRiskCapability, isPluginOperational,
  isPluginReloadable, isPluginTerminal, resolveCapabilityManifest, validateManifestV2, validatePluginSignature, LOW_QUALITY_THRESHOLD,
  computeQualityScore, createCompactionManager, describeScore, escalateStrategy, isTerminalCompactionState, reachableFromCompactionState,
  compactionFailurePlaybook, exportRecoveryPlaybook, permissionDeadlockPlaybook, pluginDegradationPlaybook, reconnectFailurePlaybook, sessionUnrecoverablePlaybook,
  stuckTurnPlaybook, createSessionUnrecoverablePlaybook, createStuckTurnPlaybook, evaluateOrchestrationSpawn, TRANSPORT_COMPATIBILITY_MATRIX, applyTransition,
  canTransition, isOperational, isReloadable, isTerminal, reachableFrom, evaluateSessionMaintenance,
  formatSessionMaintenanceLines, getGuidanceMode, DEFAULT_RETENTION_CONFIG, RetentionPolicy, SnapshotPruner, buildPersistedSessionContext,
  buildLocalReturnContextSummary, formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary, persistConversation, generateUserSessionId,
  loadLastConversation, loadRecoveryConversation, writeRecoveryFile, deleteRecoveryFile, checkRecoveryFile, getRecoveryFilePath,
  getLastSessionPointerPath, writeLastSessionPointer, readLastSessionPointer,
  // Declare-once product storage handle (see platform/runtime/session-surface.ts):
  // every session-persistence / SessionManager / checkpoint call site threads
  // this through instead of re-deriving workingDirectory/homeDirectory/surfaceRoot
  // independently. consumeRecovery/removeRecoveryPoint are the prompted
  // resume/discard primitives for a surface-backed recovery flow (load-then-delete,
  // and delete-without-load, respectively).
  createSessionSurface, consumeRecovery,
  // The reclaim half of those same artefacts: one bounded sweep of the sessions
  // directory that removes what no live session can ever use again, discloses
  // what it removed, and never touches the session in use.
  startDurabilityHousekeeping,
  // OS-level terminal focus, from the focus-reporting tokens a host feeds it.
  FocusTracker,
  // The last-session pointer writer, bound to one SessionSurface so a caller in a
  // (sessionId) => void slot cannot silently drop the surface argument.
  bindWriteLastSessionPointerToSurface,
  // "Is this the build you are actually reaching, and is it the current one",
  // the PATH shadow scan, the install-kind answer it depends on, and the wording
  // it produces. A product supplies its own command/package name and release
  // lookup (runtime/path-shadow-startup.ts) and nothing else.
  detectInstallKind, announceReachability, boundedLatestRelease, runReachabilityCheck, resolveSelfDirectory, probeVersionLine,
  buildReachabilityNotices, reachabilityNoticeLines, INSTALLED_COMMANDS, removeRecoveryPoint, exportRemoteArtifactForAgent, importRemoteArtifact,
  RemoteRunnerRegistry, RemoteSupervisor, DistributedRuntimeManager, getDistributedNodeHostContract, CURRENT_PROTOCOL_VERSION, VersionMismatchError,
  negotiateProtocolVersion,
  // Protocol version types, re-exported for transport compatibility tests.
  // ProtocolVersion, VersionNegotiationResult, NegotiatedProtocol are available
  // via operations namespace (operations.ProtocolVersion etc.) but cannot be
  // re-exported here without a registered subpath. Tests that need these types
  // should import from the operations namespace types directly.
  createTaskManager, PhasedToolExecutor, budgetPhase, permissionPhase,
} from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
export type InstallKind = Operations.InstallKind;
export type ReachabilityCheckInput = Operations.ReachabilityCheckInput;
export type ReachabilityCheckResult = Operations.ReachabilityCheckResult;
export type ReachabilityNotice = Operations.ReachabilityNotice;

export type RemoteSessionBundle = Operations.RemoteSessionBundle;
export type ContractVerifierOptions = Operations.ContractVerifierOptions;
export type McpAttackPathFinding = Operations.McpAttackPathFinding;
export type McpAttackPathFindingKind = Operations.McpAttackPathFindingKind;
export type McpAttackPathReview = Operations.McpAttackPathReview;
export type McpCapabilityClass = Operations.McpCapabilityClass;
export type McpCoherenceAssessment = Operations.McpCoherenceAssessment;
export type McpCoherenceVerdict = Operations.McpCoherenceVerdict;
export type McpDecisionRecord = Operations.McpDecisionRecord;
export type McpEventHandler = Operations.McpEventHandler;
export type McpLifecycleManagerOptions = Operations.McpLifecycleManagerOptions;
export type McpPermission = Operations.McpPermission;
export type McpReconnectConfig = Operations.McpReconnectConfig;
export type McpRiskLevel = Operations.McpRiskLevel;
export type McpSchemaRecord = Operations.McpSchemaRecord;
export type McpSecuritySnapshot = Operations.McpSecuritySnapshot;
export type McpServerEntry = Operations.McpServerEntry;
export type McpServerPermissions = Operations.McpServerPermissions;
export type McpServerRole = Operations.McpServerRole;
export type McpServerState = Operations.McpServerState;
export type McpToolPermission = Operations.McpToolPermission;
export type McpTrustLevel = Operations.McpTrustLevel;
export type McpTrustMode = Operations.McpTrustMode;
export type McpTrustProfile = Operations.McpTrustProfile;
export type QuarantineReason = Operations.QuarantineReason;
export type QuarantineRecord = Operations.QuarantineRecord;
export type SchemaFreshness = Operations.SchemaFreshness;
export type PluginCapability = Operations.PluginCapability;
export type PluginCapabilityManifest = Operations.PluginCapabilityManifest;
export type PluginManifestV2 = Operations.PluginManifestV2;
export type PluginTrustTier = Operations.PluginTrustTier;
export type CompactionQualityScore = Operations.CompactionQualityScore;
export type CompactionStrategy = Operations.CompactionStrategy;
export type StrategyInput = Operations.StrategyInput;
export type StrategyOutput = Operations.StrategyOutput;
export type DistributedRuntimeSnapshotStore = Operations.DistributedRuntimeSnapshotStore;
// RemoteRunnerRegistry, FocusTracker, RemoteSupervisor, and
// DistributedRuntimeManager are classes forwarded by the grouped value
// re-export above (`export { X } from '<subpath>'` carries both the value
// and its implicit instance type), so redeclaring their types here would
// conflict (TS2484).
export type RuntimeTransitionResult = Operations.RuntimeTransitionResult;
export type RetentionClass = Operations.RetentionClass;
export type RetentionClassConfig = Operations.RetentionClassConfig;
export type RetentionConfig = Operations.RetentionConfig;
export type CheckpointRecord = Operations.CheckpointRecord;
export type PruneOptions = Operations.PruneOptions;
export type PruneResult = Operations.PruneResult;
export type PerClassPruneResult = Operations.PerClassPruneResult;
export type Pruner = Operations.Pruner;
export type RetentionStats = Operations.RetentionStats;
export type SessionReturnContextSummary = Operations.SessionReturnContextSummary;
export type SessionSnapshot = Operations.SessionSnapshot;
export type RecoveryFileInfo = Operations.RecoveryFileInfo;
export type SessionSurface = Operations.SessionSurface;
export type SurfaceIdentity = Operations.SurfaceIdentity;
export type SessionPersistenceOptions = Operations.SessionPersistenceOptions;
export type RecoveryConsumeResult = Operations.RecoveryConsumeResult;
export type RecoveryRemoveResult = Operations.RecoveryRemoveResult;
export type RemoteSupervisorSnapshot = Operations.RemoteSupervisorSnapshot;
export type DistributedPeerKind = Operations.DistributedPeerKind;
export type DistributedPairRequestStatus = Operations.DistributedPairRequestStatus;
export type DistributedPeerStatus = Operations.DistributedPeerStatus;
export type DistributedWorkPriority = Operations.DistributedWorkPriority;
export type DistributedWorkStatus = Operations.DistributedWorkStatus;
export type DistributedWorkType = Operations.DistributedWorkType;
export type DistributedSessionBridge = Operations.DistributedSessionBridge;
export type DistributedApprovalBridge = Operations.DistributedApprovalBridge;
export type DistributedAutomationBridge = Operations.DistributedAutomationBridge;
export type DistributedRuntimePairRequest = Operations.DistributedRuntimePairRequest;
export type DistributedPeerTokenRecord = Operations.DistributedPeerTokenRecord;
export type DistributedPeerRecord = Operations.DistributedPeerRecord;
export type DistributedPendingWork = Operations.DistributedPendingWork;
export type DistributedRuntimeAuditRecord = Operations.DistributedRuntimeAuditRecord;
export type DistributedPeerAuth = Operations.DistributedPeerAuth;
export type DistributedNodeHostContract = Operations.DistributedNodeHostContract;
export type TaskManager = Operations.TaskManager;
export type TaskHooks = Operations.TaskHooks;
export type ToolRuntimeContext = Operations.ToolRuntimeContext;
export type RuntimeStoreAccess = Operations.RuntimeStoreAccess;
export type ToolExecutionPhase = Operations.ToolExecutionPhase;
export type PhaseResult = Operations.PhaseResult;
export type ToolExecutionRecord = Operations.ToolExecutionRecord;

// Runtime shell compatibility aliases, grouped live re-exports.
// WorktreeRegistry is a class: the value re-export carries its instance type,
// so the old separate `export type WorktreeRegistry` alias is gone (TS2484).
export {
  createShellPathService,
  createShellPlanRuntime,
  createShellRemoteCommandService,
  createBootstrapCommandShellServices,
  resolveSurfaceDirectory,
  classifySystemMessageKind,
  classifySystemMessagePriority,
  defaultSystemMessageTarget,
  resolveSystemMessageDelivery,
  buildProviderAccountSnapshot,
  loadEcosystemCatalog,
  searchEcosystemCatalog,
  exportEcosystemCatalogBundle,
  importEcosystemCatalogBundle,
  inspectEcosystemCatalogBundle,
  inspectInstalledEcosystemEntry,
  installEcosystemCatalogEntry,
  listEcosystemInstallBackups,
  listInstalledEcosystemEntries,
  removeEcosystemCatalogEntry,
  reviewEcosystemCatalogEntry,
  rollbackInstalledEcosystemEntry,
  uninstallEcosystemCatalogEntry,
  updateInstalledEcosystemEntry,
  upsertEcosystemCatalogEntry,
  summarizeWorktreeOwnership,
  listPersistedWorktreeMeta,
  getPersistedWorktreeMeta,
  reviewWorktreeAttachments,
  WorktreeRegistry,
} from '@goodvibes-jev/engine/sdk/platform/runtime/shell';

export type MutableRuntimeState = Shell.MutableRuntimeState;
export type ProviderAccountRecord = Shell.ProviderAccountRecord;
export type ProviderAccountSnapshot = Shell.ProviderAccountSnapshot;
export type ProviderAuthFreshness = Shell.ProviderAuthFreshness;
export type ProviderAuthRoute = Shell.ProviderAuthRoute;
export type ShellPathService = Shell.ShellPathService;
export type BootstrapCommandShellServices = Shell.BootstrapCommandShellServices;
export type CommandExtensionShellServices = Shell.CommandExtensionShellServices;
export type CommandOpsShellServices = Shell.CommandOpsShellServices;
export type CommandPlatformShellServices = Shell.CommandPlatformShellServices;
export type CommandWorkspaceShellServices = Shell.CommandWorkspaceShellServices;
export type RemoteCommandService = Shell.RemoteCommandService;
export type PlanRuntimeService = Shell.PlanRuntimeService;
export type WorktreeStatusRecord = Shell.WorktreeStatusRecord;
export type ManagedWorktreeMeta = Shell.ManagedWorktreeMeta;
export type ShellAgentManagerService = Shell.ShellAgentManagerService;
export type ShellAutomationManagerService = Shell.ShellAutomationManagerService;
export type ShellAutomationManagerRuntimeService = Shell.ShellAutomationManagerRuntimeService;
export type ShellModeManagerService = Shell.ShellModeManagerService;
export type ShellPlanManagerService = Shell.ShellPlanManagerService;
export type ShellSessionOrchestrationService = Shell.ShellSessionOrchestrationService;
export type SystemMessageKind = Shell.SystemMessageKind;
export type SystemMessageTarget = Shell.SystemMessageTarget;
export type EcosystemCatalogPathOptions = Shell.EcosystemCatalogPathOptions;
export type EcosystemCatalogBundle = Shell.EcosystemCatalogBundle;
export type EcosystemCatalogEntry = Shell.EcosystemCatalogEntry;
export type EcosystemEntryKind = Shell.EcosystemEntryKind;

// Runtime security compatibility aliases, grouped live re-exports. The class
// re-exports (PolicyRegistry, PolicyRuntimeState, …) carry their instance
// types, so the old separate `export type` aliases for those names are gone.
export {
  buildAuthInspectionSnapshot,
  inspectProviderAuth,
  DivergenceDashboard,
  DivergenceGateError,
  LayeredPolicyEvaluator,
  PermissionSimulator,
  PolicyRegistry,
  PolicyRuntimeState,
  buildDefaultPolicySimulationScenarios,
  buildPermissionRuleSuggestions,
  buildPolicyPreflightReview,
  createPermissionEvaluator,
  createPermissionSimulator,
  createUnsignedBundle,
  lintPolicyConfig,
  loadPolicyBundle,
  runPolicySimulationScenarios,
  buildDenialExplanation,
  canonicalize,
  collectCommandNodes,
  parseAST,
  parseCommandAST,
  tokenize,
  PolicySignatureError,
  canonicalise,
  runSafetyChecks,
  signBundle,
  verifyBundle,
  MAX_INPUT_LENGTH,
  MAX_TOKEN_COUNT,
} from '@goodvibes-jev/engine/sdk/platform/runtime/security';

type RuntimeSegmentVerdict = ReturnType<typeof security.evaluateSegmentNode>;
type RuntimeCompoundVerdict = ReturnType<typeof security.evaluateCommandAST>;
type RuntimeShellNode = Parameters<typeof security.evaluateCommandAST>[1];

const AGENT_OBFUSCATION_CHECKS: Array<{ description: string; test: (raw: string) => boolean }> = [
  {
    description: 'base64-encoded argument (possible command injection)',
    test: (raw) =>
      extractInspectableShellWords(raw).some((word) =>
        /^[A-Za-z0-9+/]+={0,2}$/.test(word) && word.length >= 12 && word.length % 4 === 0,
      ),
  },
  {
    description: 'URL-encoded content in argument',
    test: (raw) => hasPercentEncodedContent(raw),
  },
];

/**
 * A `%` followed by two hex-ish characters is grammatically identical in a
 * printf/strftime specifier (`%4d`, `%02d`, `%2f`, `date +%ad`) and in a URL
 * escape (`%2F`, `%20`). Testing the whole raw command against
 * `/%[0-9a-fA-F]{2}/` therefore denied ordinary formatting commands as
 * "obfuscation". Two independent narrowings replace that test:
 *
 *  1. Shape, percent-encoding only counts when the word carries it the way a
 *     URI does: an explicit `scheme://`, or an encoded path separator / NUL
 *     (`%2F`, `%5C`, `%00`), which is the evasion this check exists to catch.
 *     `%02d:%02d` and `+%ad` carry neither and are left alone.
 *  2. Consumer, the printf family legitimately emits `%2f` (float, width 2),
 *     so its own arguments are exempt from the shape rule.
 *
 * This only narrows an existing detector. No new denial class is introduced:
 * the exec-guard catastrophic list stays frozen.
 */
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;
const URI_SCHEME = /[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** Encoded `/`, `\` and NUL, separators that change path or argument meaning once decoded. */
const ENCODED_SEPARATOR = /%(?:2[fF]|5[cC]|00)/;
const FORMAT_SPECIFIER_COMMANDS = new Set(['printf', 'awk', 'gawk', 'mawk', 'nawk', 'seq']);
const ENV_ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

function extractInspectableShellWords(raw: string): string[] {
  return (raw.match(/"[^"]*"|'[^']*'|`[^`]*`|\S+/g) ?? []).map((word) =>
    word.replace(/^["'`]+|["'`;|&]+$/g, ''),
  );
}

/** First word that is not a leading `NAME=value` assignment, reduced to its basename. */
function segmentCommandName(words: readonly string[]): string {
  for (const word of words) {
    if (word.length === 0 || ENV_ASSIGNMENT_PREFIX.test(word)) continue;
    return (word.split('/').pop() ?? word).toLowerCase();
  }
  return '';
}

function hasPercentEncodedContent(raw: string): boolean {
  const words = extractInspectableShellWords(raw);
  if (FORMAT_SPECIFIER_COMMANDS.has(segmentCommandName(words))) return false;
  return words.some(
    (word) =>
      PERCENT_ESCAPE.test(word) && (URI_SCHEME.test(word) || ENCODED_SEPARATOR.test(word)),
  );
}

function agentObfuscationPatterns(raw: string, existing: readonly string[]): string[] {
  const patterns = new Set(existing);
  for (const check of AGENT_OBFUSCATION_CHECKS) {
    if (check.test(raw)) {
      patterns.add(check.description);
    }
  }
  return [...patterns];
}

function enforceAgentObfuscationVerdict(verdict: RuntimeSegmentVerdict): RuntimeSegmentVerdict {
  const obfuscationPatterns = agentObfuscationPatterns(verdict.raw, verdict.obfuscationPatterns);
  if (obfuscationPatterns.length === verdict.obfuscationPatterns.length) {
    return verdict;
  }

  return {
    ...verdict,
    allowed: false,
    reason: `obfuscation detected: ${obfuscationPatterns.join('; ')}`,
    hasObfuscation: true,
    obfuscationPatterns,
  };
}

export function evaluateSegmentNode(
  node: Security.CommandNode,
  allowedClasses?: ReadonlySet<Security.CommandClassification>,
): RuntimeSegmentVerdict {
  const verdict = allowedClasses === undefined
    ? security.evaluateSegmentNode(node)
    : security.evaluateSegmentNode(node, allowedClasses);
  return enforceAgentObfuscationVerdict(verdict);
}

export function evaluateCommandAST(
  original: string,
  ast: RuntimeShellNode,
  allowedClasses?: ReadonlySet<Security.CommandClassification>,
): RuntimeCompoundVerdict {
  const compound = allowedClasses === undefined
    ? security.evaluateCommandAST(original, ast)
    : security.evaluateCommandAST(original, ast, allowedClasses);
  const segments = compound.segments.map(enforceAgentObfuscationVerdict);
  const allowed = segments.every((segment) => segment.allowed);
  const hasObfuscation = segments.some((segment) => segment.hasObfuscation);

  const next: RuntimeCompoundVerdict = {
    ...compound,
    allowed,
    segments,
    hasObfuscation,
  };
  if (allowed) {
    delete next.denialExplanation;
  } else {
    next.denialExplanation = security.buildDenialExplanation(original, segments);
  }
  return next;
}

export type AuthInspectionSnapshot = Security.AuthInspectionSnapshot;
export type ProviderAuthInspection = Security.ProviderAuthInspection;
export type DivergenceDashboardSnapshot = Security.DivergenceDashboardSnapshot;
export type DivergenceStats = Security.DivergenceStats;
export type PermissionsConfig = Security.PermissionsConfig;
export type PolicyBundlePayload = Security.PolicyBundlePayload;
export type PolicyBundleVersion = Security.PolicyBundleVersion;
export type PolicyDiffResult = Security.PolicyDiffResult;
export type PolicyLintFinding = Security.PolicyLintFinding;
export type PolicyPreflightReview = Security.PolicyPreflightReview;
export type PolicyRule = Security.PolicyRule;
export type PolicySimulationSummary = Security.PolicySimulationSummary;
export type PermissionAuditEntry = Security.PermissionAuditEntry;
export type CommandClassification = Security.CommandClassification;
export type CommandNode = Security.CommandNode;
export type CommandSegment = Security.CommandSegment;
export type CommandToken = Security.CommandToken;
export type PipeNode = Security.PipeNode;
export type SequenceNode = Security.SequenceNode;
export type SubshellNode = Security.SubshellNode;
export type BundleProvenance = Security.BundleProvenance;
export type DecisionReason = Security.DecisionReason;
export type DivergenceReport = Security.DivergenceReport;
export type EnforceGateResult = Security.EnforceGateResult;
export type SignedPolicyBundle<T = unknown> = Security.SignedPolicyBundle<T>;

export interface InspectableDomain {
  readonly name: string;
  getState(): Record<string, unknown>;
  getRevision(): number;
  getLastUpdatedAt(): number;
}

export type InboundTlsMode = 'off' | 'proxy' | 'direct';
export type InboundServerSurface = 'controlPlane' | 'httpListener';

export interface InboundTlsSnapshot {
  readonly surface: InboundServerSurface;
  readonly host: string;
  readonly port: number;
  readonly mode: InboundTlsMode;
  readonly scheme: 'http' | 'https';
  readonly trustProxy: boolean;
  readonly certFile?: string | undefined;
  readonly keyFile?: string | undefined;
  readonly usingDefaultPaths: boolean;
  readonly ready: boolean;
  readonly errors: readonly string[];
  readonly keyPermissions?: {
    readonly available: boolean;
    readonly safe?: boolean | undefined;
    readonly mode?: string | undefined;
  };
}

interface InboundTlsConfigReader {
  get(path: string): unknown;
  getControlPlaneConfigDir(): string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function resolveGoodVibesRoot(configManager: Pick<InboundTlsConfigReader, 'getControlPlaneConfigDir'>): string {
  return resolve(configManager.getControlPlaneConfigDir());
}

function resolvePathFromGoodVibesRoot(value: string | null | undefined, configManager: Pick<InboundTlsConfigReader, 'getControlPlaneConfigDir'>): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return trimmed;
  return resolve(resolveGoodVibesRoot(configManager), trimmed);
}

function getDefaultInboundCertPaths(configManager: Pick<InboundTlsConfigReader, 'getControlPlaneConfigDir'>): { readonly certFile: string; readonly keyFile: string } {
  const certDir = join(resolveGoodVibesRoot(configManager), 'certs');
  return {
    certFile: join(certDir, 'fullchain.pem'),
    keyFile: join(certDir, 'privkey.pem'),
  };
}

function inspectPrivateKeyPermissions(path: string): { readonly available: boolean; readonly safe?: boolean | undefined; readonly mode?: string | undefined } {
  try {
    const stats = statSync(path);
    if (process.platform === 'win32') return { available: true };
    const mode = stats.mode & 0o777;
    return {
      available: true,
      safe: (mode & 0o077) === 0,
      mode: mode.toString(8).padStart(4, '0'),
    };
  } catch {
    return { available: false };
  }
}

export function extractForwardedClientIp(req: Request, trustProxy: boolean): string | undefined {
  if (!trustProxy) return undefined;
  const forwardedFor = req.headers.get('x-forwarded-for');
  const firstForwarded = forwardedFor?.split(',')[0]?.trim();
  if (firstForwarded) return firstForwarded;
  return req.headers.get('x-real-ip')?.trim() || undefined;
}

export function inspectInboundTls(configManager: InboundTlsConfigReader, surface: InboundServerSurface): InboundTlsSnapshot {
  const prefix = surface === 'controlPlane' ? 'controlPlane' : 'httpListener';
  const defaultPort = surface === 'controlPlane' ? 3421 : 3422;
  const mode = (readString(configManager.get(`${prefix}.tls.mode`)) || 'off') as InboundTlsMode;
  const trustProxy = readBoolean(configManager.get(`${prefix}.trustProxy`));
  const host = readString(configManager.get(`${prefix}.host`)) || '127.0.0.1';
  const port = readNumber(configManager.get(`${prefix}.port`), defaultPort);
  const defaults = getDefaultInboundCertPaths(configManager);
  const explicitCert = resolvePathFromGoodVibesRoot(readString(configManager.get(`${prefix}.tls.certFile`)), configManager);
  const explicitKey = resolvePathFromGoodVibesRoot(readString(configManager.get(`${prefix}.tls.keyFile`)), configManager);
  const certFile = explicitCert ?? defaults.certFile;
  const keyFile = explicitKey ?? defaults.keyFile;
  const usingDefaultPaths = explicitCert === null && explicitKey === null;
  const errors: string[] = [];

  if (mode === 'direct') {
    if (!existsSync(certFile)) errors.push(`Certificate file not found: ${certFile}`);
    if (!existsSync(keyFile)) errors.push(`Private key file not found: ${keyFile}`);
  }

  const keyPermissions = mode === 'direct' ? inspectPrivateKeyPermissions(keyFile) : undefined;
  return {
    surface,
    host,
    port,
    mode,
    scheme: mode === 'off' ? 'http' : 'https',
    trustProxy,
    ...(mode === 'direct' ? { certFile, keyFile } : {}),
    usingDefaultPaths,
    ready: mode === 'off' || mode === 'proxy' || errors.length === 0,
    errors,
    ...(keyPermissions ? { keyPermissions } : {}),
  };
}
