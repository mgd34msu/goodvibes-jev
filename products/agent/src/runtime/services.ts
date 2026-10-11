import { join } from 'node:path';
import { StepUpService } from '@goodvibes-jev/engine/sdk/daemon';
import { PairingTokenManager } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { shell as runtimeShell, operations as runtimeOperations } from '@goodvibes-jev/engine/sdk/platform/runtime';
// The graph's shutdown seam. Shared with the SDK composition root rather than
// reimplemented here, so "which pollers exist" has exactly one answer across
// both compositions: RuntimePollerOwners is all-required, and a poller added to
// this fork's graph later cannot compile without being named for teardown.
import { createDisposalScope, registerRuntimePollers } from '@goodvibes-jev/engine/sdk/platform/runtime/disposal';
import type { shell as RuntimeShell, bootstrap as RuntimeBootstrap } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { applyRawSecretLiteralHandling, type SecretsManager } from '../config/secrets.ts';
import { readCheckpointGuardSettings, readCheckpointRegistrationSetting } from '../config/checkpoint-settings.ts';
import { backfillCheckpointEligibilityIfNeeded, createWorkspaceRegistrationLiveChecker, migrateLegacyWorkspaceRegistryIfNeeded } from '../config/workspace-registration.ts';
import { FocusTracker } from '@/runtime/index.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { AutomationDeliveryManager, AutomationManager, AutomationRouteStore } from '@goodvibes-jev/engine/sdk/platform/automation';
import { ChannelPluginRegistry, ChannelPolicyManager, RouteBindingManager, SurfaceRegistry } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createArchivableFleetRegistry } from '@goodvibes-jev/engine/terminal-shell';
import { createSessionConversationRewindPort } from './conversation-rewind-port.ts';
// ── The client seams ───────────────────────────────────────────────────────
// The policy for every boundary this process crosses, raising an approval,
// writing a daemon-owned setting, storing a credential, receiving inbound
// session work, answering a conversation-rewind question, reaching a paired
// phone, is the platform's, taken whole. Each takes one thing: the
// DaemonVerbCaller this product builds in client/daemon-verbs.ts, where
// resolving WHICH host this agent trusts stays product-side.
import {
  createClientApprovalRaiser,
  createConversationRewindHost,
  createDaemonConfigClient,
  createDaemonCredentialsClient,
  createDevicesClient,
  createWireSessionDispatch,
  readSurfaceAgentOutcome,
  watchApprovalUpdates,
} from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import type { AgentCompletionRecordView } from '@goodvibes-jev/engine/sdk/platform/agents';
import type {
  ConversationRewindHostClient,
  DaemonConfigClient,
  DaemonCredentialsClient,
  DaemonVerbCaller,
  DevicesClient,
  WireSessionDispatch,
} from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { createClientRuntimeServices } from '@goodvibes-jev/engine/sdk/platform/runtime/client-services';
import type {
  ApprovalRaiser,
  ProviderRegistryConstructionOptions,
  UserPermissionRuleAccess,
} from '@goodvibes-jev/engine/sdk/platform/runtime/client-services';
import { createAgentDaemonVerbCaller, resolveConnectedHostConnection } from './client/daemon-verbs.ts';
import { createApprovalsView, type ApprovalsView } from './client/approvals-view.ts';
import { createAgentFleetUnion, type AgentFleetUnion } from './client/fleet-union.ts';
import { createAgentSessionInputsClient } from './client/session-inputs.ts';
import { createHostedSessionRegistry, type HostedSessionRegistry } from './client/hosted-sessions.ts';
import { createHostedConversationHandoff, type HostedConversationHandoff } from './client/hosted-handoff.ts';
import { installAgentDaemonCredentialsClient } from '../config/daemon-credential-routing.ts';
import { installAgentDaemonConfigClient } from '../config/daemon-config-routing.ts';
import type { LocalPermissionPrompt } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
// Not re-exported by @goodvibes-jev/engine/terminal-shell (only the gateway-verb
// composition and the registry factory are), reached directly per the SDK
// adoption convention of going straight to the platform package for whatever
// terminal-shell does not already wrap, rather than hand-rolling the bridge.
import { attachFleetEmitBridge } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import {
  computeUsageCostUsd,
  createLaunchTolerantProviderRegistry,
  ensureConfiguredModelIsRoutable,
} from '@goodvibes-jev/engine/sdk/platform/providers';
import { buildSharedSessionAgentSpawnRoutingInput } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { logger, singleFlight, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
// SDK-owned memory governance (public since sdk 4d5e247b published the
// composition surface): the same CacheRegistry/PauseController/MemoryGovernor
// wiring the SDK's own daemon composition constructs and starts.
import {
  CacheRegistry,
  PauseController,
  wireDaemonMemoryGovernance,
  type MemoryGovernor,
} from '@goodvibes-jev/engine/sdk/platform/runtime/memory';
// The shared free function both compositions build the local remembered-approval
// store through (platform/runtime/permissions/permission-composition.ts, public
// via the runtime bootstrap namespace). Same path, same background init, one
// implementation, see the userPermissionRuleStore construction below for why a
// surface keeping its own remembered approvals is the client-shaped thing to do.
import { bootstrap as runtimeComposition } from '@goodvibes-jev/engine/sdk/platform/runtime';
import type { PermissionManager } from '@goodvibes-jev/engine/sdk/platform/permissions';
import {
  AGENT_SPINE_PARTICIPANT,
  SessionSpineClient,
  createSessionSpineRestProbe,
  createSessionSpineRestTransport,
  createSessionSpineReceiptConsumer,
} from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine';
import { createSpineConnectionResolver } from './session-spine-rest-transport.ts';
import { MemorySpineClient, createLocalMemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import type { MemoryTransport } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { createMemorySpineRestTransport } from './memory-spine-rest-transport.ts';
import { WatcherRegistry } from '@goodvibes-jev/engine/sdk/platform/watchers';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import {
  GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  HOME_GRAPH_KNOWLEDGE_DB_FILE,
  HOME_GRAPH_KNOWLEDGE_EXTENSION,
  HomeGraphService,
  KnowledgeService,
  KnowledgeSemanticService,
  KnowledgeStore,
  ProjectPlanningService,
  createProviderBackedKnowledgeSemanticLlm,
  createWebKnowledgeGapRepairer,
  projectPlanningProjectIdFromPath,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '@goodvibes-jev/engine/sdk/platform/media';
import { MultimodalService } from '@goodvibes-jev/engine/sdk/platform/multimodal';
import { AgentManager, cancelAllAgentRuns } from '@goodvibes-jev/engine/sdk/platform/tools';
import { AgentMessageBus } from '@goodvibes-jev/engine/sdk/platform/agents';
import { createContractOperatorService, createContractIntake, type ContractIntake } from '@goodvibes-jev/engine/sdk/platform/contract';
import { createApprovalDerivedHandlers, type ApprovalDerivedHandlers } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { continuationContractOptions } from '@goodvibes-jev/engine/sdk/platform/agents';
import { AgentOrchestrator } from '@goodvibes-jev/engine/sdk/platform/agents';
import { ArchetypeLoader } from '@goodvibes-jev/engine/sdk/platform/agents';
import { CodeIndexStore, resolveMemoryVectorDbPath } from '@goodvibes-jev/engine/sdk/platform/state';
import { CodeIndexReindexScheduler } from '@goodvibes-jev/engine/sdk/platform/state';
// Daemon-side idle+schedule memory consolidation driver, the SAME class the
// SDK's own RuntimeServices composition constructs (it superseded this repo's
// retired turn-settled local wiring), consumed from the public platform/state
// barrel (re-exported there since sdk a03bf218).
import { MemoryConsolidationScheduler } from '@goodvibes-jev/engine/sdk/platform/state';
import type { MemoryConsolidationRunReceipt } from '@goodvibes-jev/engine/sdk/platform/state';
import type { SessionLiveTurnControlsHolder } from '@goodvibes-jev/engine/sdk/platform/control-plane';
// Sleep ownership (SDK round: power/*): work inhibition, sleep-edge honesty,
// the keep-awake toggle. Constructed exactly as the SDK composition root does
// (wireRuntimePower binds runtimeBus work signals and starts the manager).
import { createUnavailablePowerSeam, wireRuntimePower } from '@goodvibes-jev/engine/sdk/platform/power';
import { forwardKeepAwakeToAdoptedDaemon } from '@goodvibes-jev/engine/sdk/platform/power';
import { StoreSnapshotScheduler } from '@goodvibes-jev/engine/sdk/platform/state/store-snapshots';
import { AgentDaemonReceiptFeed } from './daemon-receipts.ts';
import { WorkspaceCheckpointManager, type CheckpointSessionResolver } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { TriggerManager } from '@goodvibes-jev/engine/sdk/platform/triggers';
import { createBunStreamHost, createProcessManagerTriggerHost, createTriggerActionExecutor } from '@goodvibes-jev/engine/sdk/platform/triggers';
import { ModeManager } from '@goodvibes-jev/engine/sdk/platform/state';
import { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import { MemoryRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import { MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
// One canonical cross-surface memory store + no-loss legacy fold.
import { resolveCanonicalMemoryDbPath, foldMemoryStores } from '@goodvibes-jev/engine/sdk/platform/state';
import type { LegacyMemorySource, MemoryFoldReport } from '@goodvibes-jev/engine/sdk/platform/state';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import type { DomainDispatch, RuntimeStore } from './store/index.ts';
import { DistributedRuntimeManager } from '@/runtime/index.ts';
import { RemoteRunnerRegistry, RemoteSupervisor } from '@/runtime/index.ts';
import { IntegrationHelperService } from '@/runtime/index.ts';
import {
  VoiceProviderRegistry,
  VoiceService,
  ensureBuiltinVoiceProviders,
} from '@goodvibes-jev/engine/sdk/platform/voice';
import { createVoiceSetupService, type VoiceSetupService } from '@goodvibes-jev/engine/sdk/platform/runtime/voice-setup';
import { WebSearchProviderRegistry, WebSearchService } from '@goodvibes-jev/engine/sdk/platform/web-search';
import { MemoryEmbeddingProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import { HookActivityTracker } from '@goodvibes-jev/engine/sdk/platform/hooks';
import { HookDispatcher, type HookWorkbench } from '@goodvibes-jev/engine/sdk/platform/hooks';
import { PluginManager } from '@goodvibes-jev/engine/sdk/platform/plugins';
import { BookmarkManager } from '@goodvibes-jev/engine/sdk/platform/bookmarks';
import { ProfileManager } from '@goodvibes-jev/engine/sdk/platform/profiles';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { CrossSessionTaskRegistry } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { ApiTokenAuditor } from '@goodvibes-jev/engine/sdk/platform/security';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { WebhookNotifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { DeterministicReplayEngine } from '@goodvibes-jev/engine/sdk/platform/core';
import { ProviderOptimizer } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ProviderCapabilityRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { CacheHitTracker } from '@goodvibes-jev/engine/sdk/platform/providers';
import { FavoritesStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ModelLimitsService } from '@goodvibes-jev/engine/sdk/platform/providers';
import { KeybindingsManager } from '../input/keybindings.ts';
import { SessionMemoryStore } from '@goodvibes-jev/engine/sdk/platform/core';
import { SessionLineageTracker } from '@goodvibes-jev/engine/sdk/platform/core';
import { SessionChangeTracker } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { ExecutionPlanManager } from '@goodvibes-jev/engine/sdk/platform/core';
import { AdaptivePlanner } from '@goodvibes-jev/engine/sdk/platform/core';
import { FileStateCache } from '@goodvibes-jev/engine/sdk/platform/state';
import { ProjectIndex } from '@goodvibes-jev/engine/sdk/platform/state';
import { IdempotencyStore } from '@/runtime/index.ts';
import { OverflowHandler } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ContextAccountingHolder } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ToolLLM } from '@goodvibes-jev/engine/sdk/platform/config';
import { ComponentHealthMonitor } from '@/runtime/index.ts';
import { SandboxSessionRegistry } from '@/runtime/index.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import { createSessionSurface, type SessionSurface } from '@/runtime/index.ts';
import { createLazyMcpRegistry } from './mcp-lazy-start.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import { createFeatureFlagManager, deriveFeatureStates, bindFeatureSettingsBridge } from '@/runtime/index.ts';
import {
  FeatureAnnouncementStore,
  featureAnnouncementsPath,
} from '@goodvibes-jev/engine/sdk/platform/runtime/feature-announcements';
import {
  type LocalhostFetchApproval,
} from '@goodvibes-jev/engine/sdk/platform/runtime/permissions/localhost-fetch-approval';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import type { WorkflowServices } from '@goodvibes-jev/engine/sdk/platform/tools';
import { WorkPlanStore } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { AgentExecutionLedger } from '@goodvibes-jev/engine/sdk/platform/gate/policy';
import { attachAgentSessionWriteLedger, clearAgentSessionWrites } from '../tools/agent-session-write-ledger.ts';
import { VERSION } from '../version.ts';
import { ClientBuildGuard } from './client-build-compatibility.ts';
import {
  AGENT_DAEMON_BUILD_FLOOR,
  DaemonBuildGuard,
  readDaemonStatusPayload,
} from './daemon-build-compatibility.ts';

type WorktreeRegistry = RuntimeShell.WorktreeRegistry;
// The SDK's FULL runtime-services shape. This graph deliberately is not that
// shape: three members are narrowed or withheld (see the Omit on RuntimeServices
// below), because a surface that runs a loop and reaches a daemon for everything
// else does not own a persisting session register, does not serve the canonical
// permission-rule store, and mints no pairing tokens.
type SdkRuntimeServices = RuntimeBootstrap.RuntimeServices;
type AssertTrue<T extends true> = T;
// Compile-pin: this graph must satisfy the CLIENT composition shape. That is the
// contract a surface product owes now, `ClientRuntimeServices` is what a turn
// needs in-process, and pinning it here is what stops a future edit from
// quietly re-growing a member back into daemon-grade furniture. It is checked
// against the full client shape (not `ClientRuntimeServicesFromHost`) precisely
// because this graph, unlike a daemon's, DOES carry the client-only members:
// surfaceRoot, permissionManager, requestApproval, the two spine clients, and
// the file-tool caches.
type _ClientRuntimeServicesPin = AssertTrue<
  RuntimeServices extends RuntimeBootstrap.ClientRuntimeServices ? true : false
>;
type SdkCompanionGraphService = NonNullable<SdkRuntimeServices>['homeGraphService'];
// Compile-pin: the real HomeGraphService constructed below must remain
// assignable to the SDK's own RuntimeServices#homeGraphService slot.
type _HomeGraphServicePin = AssertTrue<HomeGraphService extends SdkCompanionGraphService ? true : false>;


class DisabledAgentWorktreeRegistry extends runtimeShell.WorktreeRegistry {
  public override async list(): Promise<Awaited<ReturnType<WorktreeRegistry['list']>>> {
    return [] as Awaited<ReturnType<WorktreeRegistry['list']>>;
  }

  public override attach(_path: string, _target: { sessionId?: string; taskId?: string }): void {
    throw new Error('GoodVibes Agent does not own local worktree attachment. Delegate build, fix, and review work to GoodVibes TUI.');
  }

  public override setState(_path: string, _state: Parameters<WorktreeRegistry['setState']>[1]): void {
    throw new Error('GoodVibes Agent does not own local worktree state. Delegate build, fix, and review work to GoodVibes TUI.');
  }

  public override async cleanup(_path: string): Promise<void> {
    throw new Error('GoodVibes Agent does not own local worktree cleanup. Delegate build, fix, and review work to GoodVibes TUI.');
  }
}

function createDisabledAgentWorktreeRegistry(workingDirectory: string): WorktreeRegistry {
  return new DisabledAgentWorktreeRegistry(workingDirectory, {
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
  });
}

/**
 * Managed voice provisioning: the surface this Agent exposes both to its own
 * slash commands (/voice status, /voice setup, /voice wake status, /voice wake
 * setup) and to the voice.local.* and voice.wake.* gateway verbs.
 *
 * An alias for the SDK's own service type rather than a locally-declared shape.
 * It was declared locally while the SDK's composition was internal; now that
 * createVoiceSetupService is exported, a separate declaration could only drift
 * from what is actually constructed, and the wake trio it grew (wakeStatus,
 * wakeProvision, wakeModelChunk) is exactly the kind of addition a hand-written
 * mirror silently misses until the gateway registration stops typechecking.
 */
export type AgentVoiceSetupService = VoiceSetupService;

/**
 * The narrow live-snapshot slice /health memory reads. A Pick over the SDK's
 * real MemoryGovernor so the command surface can be handed the composed
 * governor without gaining pause/exit authority.
 */
export type AgentMemoryDiagnostics = Pick<MemoryGovernor, 'snapshot'>;

/**
 * How a runtime treats the live model-discovery sweep. See
 * {@link RuntimeServicesOptions.modelDiscovery}.
 */
export type ModelDiscoveryMode = 'refresh' | 'skip';

/**
 * The default is `'refresh'`, absent means refresh, which is what every
 * composition did before the option existed. Exported so the decision can be
 * driven directly rather than inferred from the source text of its call site.
 */
export function shouldRefreshModels(mode: ModelDiscoveryMode | undefined): boolean {
  return (mode ?? 'refresh') === 'refresh';
}

/**
 * How the client floor builds this product's provider registry, the two
 * things that are true of it and of no default composition, in one named
 * place rather than two side effects in a lambda.
 *
 * 1. LAUNCH TOLERANCE. The default `new ProviderRegistry(...)` throws when a
 *    configured provider credential is broken or absent. This product has to
 *    reach a first frame and then TELL the owner what is wrong, so it
 *    constructs under placeholder credentials instead: a misconfigured key is
 *    a degraded provider, never a crash before anything is on screen.
 *
 * 2. THE RAW-LITERAL PAIR on the credential store. The floor builds its own
 *    `SecretsManager` and hands this same instance to the provider stack, the
 *    service registry and the agent orchestrator; it takes no secrets-manager
 *    option, so this callback is the only point at which that instance is in
 *    this product's hands. It is also early enough: the floor's boot
 *    credential refresh reads the store inside the synchronous prefix of
 *    `refreshProviderCredentials()`, which runs immediately AFTER this
 *    callback returns. See applyRawSecretLiteralHandling for what the pair
 *    does and the SDK option that would retire this.
 */
function buildAgentProviderRegistry(options: ProviderRegistryConstructionOptions): ProviderRegistry {
  // The registry's own option bag narrows the credential store to the two
  // methods the registry itself calls. The OBJECT is the floor's full
  // `SecretsManager`, `createProviderStack` passes its own field straight
  // through, and the pair has to go on the whole thing, so the widening is
  // stated here.
  applyRawSecretLiteralHandling(options.secretsManager as SecretsManager);
  return createLaunchTolerantProviderRegistry(options);
}

export interface RuntimeServicesOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager: ConfigManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly featureFlags?: FeatureFlagManager;
  readonly getConversationTitle?: () => string | undefined;
  /**
   * Maps a triggering turn/agent lifecycle event to the owning session id so the
   * WorkspaceCheckpointManager can stamp automatic (and defaulted explicit)
   * checkpoints with it. Without this, same-launch checkpoints are written with
   * an undefined session id and the session-scoped restore/rewind lookup filters
   * them out, so a checkpoint made this launch could not be activated until a
   * restart. Consulted live at each event, so a resolver reading a mutable
   * session-id ref reflects the current session without re-wiring.
   */
  readonly resolveSessionId?: CheckpointSessionResolver;
  readonly workingDir: string;
  readonly homeDirectory: string;
  /**
   * Host power seam opt-in. Left ABSENT, createRuntimeServices defaults to the
   * SDK's non-spawning "unavailable" seam so a test-constructed runtime never
   * spawns systemd-inhibit inhibitors or a dbus-monitor sleep-edge watcher.
   * Only the real long-lived composition that owns the sleep edge (the embedded
   * interactive runtime, see bootstrap-core.ts) passes createHostPowerSeam()
   * to opt into live OS keep-awake / idle-inhibit.
   */
  readonly powerSeam?: Parameters<typeof wireRuntimePower>[0]['seam'];
  /**
   * What the runtime does about the provider registry's live model-discovery
   * sweep.
   *
   * DEFAULT `'refresh'`, which is what every composition did before this option
   * existed. The sweep reaches each configured provider's models endpoint and
   * writes `<configDir>/provider-models/<provider>.json`, so the runtime routes
   * against the models a provider actually serves rather than a stale list.
   *
   * `'skip'` starts nothing and leaves whatever list is already on disk in
   * place. It exists for callers whose process will not outlive the sweep: the
   * write is unawaited, and under test it landed AFTER the run had finished and
   * re-created a temp workspace that cleanup had already removed. That is a
   * property of the caller's lifetime, not a property of the product, so the
   * test setup opts out explicitly and the shipped default is unchanged.
   *
   * A named mode rather than a boolean because a third answer is foreseeable
   * (refresh-and-await, for a one-shot CLI that wants a fresh list before it
   * answers) and a boolean cannot grow one without changing every call site.
   */
  readonly modelDiscovery?: ModelDiscoveryMode;
}

/**
 * This product's runtime graph.
 *
 * Two members are OMITTED from the SDK's daemon-grade shape and re-declared to
 * the client contract, because this process is a client:
 *
 * - `sessionBroker` is the inbound-DISPATCH seam, not a persisting register.
 *   Work that arrives for a session this process hosts reaches the loop over
 *   `sessions.inputs.list` on the adopted daemon.
 * - `userPermissionRuleStore` is `UserPermissionRuleAccess`, read the rules
 *   this surface remembered, add one. The canonical store and its
 *   `permissions.rules.*` verbs are the daemon's.
 * - `pairingTokens` is absent entirely. Minting, checking and revoking a
 *   per-device token is the work of a process that listens, and this one does
 *   not; a phone reaches this Agent's device tools through `devicesClient`,
 *   over the daemon's verbs.
 *
 * Everything else the daemon-grade shape declares is built here, because this
 * product legitimately carries more than the client floor.
 */
export interface RuntimeServices extends Omit<SdkRuntimeServices, 'sessionBroker' | 'userPermissionRuleStore' | 'pairingTokens'> {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** This product's storage root, every per-product path derives from it. */
  readonly surfaceRoot: string;
  /**
   * The declare-once session-storage handle (platform/runtime/session-surface.ts),
   * built exactly once here from workingDirectory/homeDirectory/GOODVIBES_AGENT_SURFACE_ROOT.
   * Every session-persistence, SessionManager, and checkpoint call site threads
   * this through instead of re-deriving those three values independently, so a
   * writer and a reader can never disagree about where a file lives.
   */
  readonly surface: SessionSurface;
  readonly shellPaths: ShellPathService;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeDispatch: DomainDispatch;
  readonly keybindingsManager: KeybindingsManager;
  readonly routeBindings: RouteBindingManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly channelDeliveryRouter: ChannelDeliveryRouter;
  readonly watcherRegistry: WatcherRegistry;
  /**
   * Trigger family supervisor (stream watchers, model-free condition checks,
   * on-exit process triggers). Constructed unconditionally so
   * `watchers.triggers.enabled` is a real runtime toggle; it does no work
   * while that flag is false. The SDK daemon facade start()/shutdown()s it.
   */
  readonly triggerManager: TriggerManager;
  readonly approvalBroker: ApprovalBroker;
  /**
   * What a surface SHOWS when it shows approvals: the daemon's record over
   * `approvals.list`, unioned with the asks the local broker still legitimately
   * holds, and the honest reason when the daemon's record could not be read.
   *
   * The broker above is not the whole list and must not be rendered as though
   * it were, an ask raised here is recorded on the daemon, so a list fed from
   * the broker alone shows "nothing pending" while three asks wait.
   * See client/approvals-view.ts.
   */
  readonly approvalsView: ApprovalsView;
  /**
   * Localhost dev-server fetch approval (ask once, persist
   * fetch.allowLocalhost for the project), same instance wired into the
   * orchestrator's tool deps; bootstrap-core must replay it there.
   */
  readonly localhostFetchApproval: LocalhostFetchApproval;
  /**
   * Announce-once store for default-on feature receipts (shared per-install
   * file under the control-plane config dir).
   */
  readonly featureAnnouncementStore: FeatureAnnouncementStore;
  /**
   * First-contained-exec-run announcer, same instance wired into the
   * orchestrator's tool deps; bootstrap-core must replay it there.
   */
  readonly onSandboxedRun: () => void;
  /**
   * The inbound-dispatch seam. Named `sessionBroker` because that is the name a
   * composition already carries, the NAME is shared so the two graphs stay
   * interchangeable; the TYPE is the client one. Bind a continuation runner
   * onto it, activate it with an adopted daemon's session inputs, and work
   * queued for a session this process hosts reaches the loop.
   */
  readonly sessionBroker: WireSessionDispatch;
  /**
   * The persisting cross-surface session register, KEPT for exactly one
   * consumer: `AutomationManager`, which takes a concrete `SharedSessionBroker`
   * and drives seven of its methods to run a job. Automation is not in this
   * round's scope, so the register it needs is not either. Nothing dispatches
   * through it, see {@link sessionBroker} for where continuations arrive.
   */
  readonly automationSessionRegister: SharedSessionBroker;
  /**
   * Durable rules this surface remembered for its OWN asks, the client
   * interface, not the daemon's concrete store.
   */
  readonly userPermissionRuleStore: UserPermissionRuleAccess;
  /**
   * This graph as the SDK's DAEMON-GRADE shape, for the three SDK entry points
   * that still take it whole: `startHostServices` (adopt-only discovery),
   * `createRuntimeFoundationClients`, and the observability read models.
   *
   * It supplies exactly the three members this graph narrows or withholds, the
   * session register for the dispatch seam, the concrete rule store for the
   * access interface, and a surface-scoped pairing-token manager for a member
   * only a listening daemon has a use for, and nothing else. It is a named
   * function rather than a cast so every substitution is greppable and so a
   * FOURTH cannot be smuggled past it: adding one makes this stop compiling.
   *
   * None of the three entry points dereferences a substituted member under the
   * way this product calls them (`startHostServices` reads `localUserAuthManager`
   * and `configManager` only, and never constructs a DaemonServer with
   * `adoptOnly: true`), but each is a real instance regardless, so nothing here
   * hands an SDK entry point a stub.
   */
  readonly asDaemonGradeView: () => SdkRuntimeServices;
  /**
   * How a permission ask leaves this process: raised on the daemon
   * (`approvals.raise`) AND prompted locally, first real answer wins.
   */
  readonly requestApproval: ApprovalRaiser;
  /**
   * The local prompt holder the ask seam reads through. The renderer patches
   * `requestPermission` onto it once it can draw one; until then an ask is
   * denied locally and the daemon's answer still wins the race.
   */
  readonly permissionPromptRef: { requestPermission: LocalPermissionPrompt };
  /** The foreground permission gate for this surface's turns. */
  readonly permissionManager: PermissionManager;
  /** The sessions this process is running, and whether one is mid-turn. */
  readonly hostedSessions: HostedSessionRegistry;
  /**
   * The other answer the continuation runner can give: hand an inbound channel
   * conversation to the daemon to host instead of answering it here. Off unless
   * `hostedSessions.promoteInboundConversations` says otherwise; exposed on the
   * graph so a surface can say which conversations were handed over.
   */
  readonly hostedHandoff: HostedConversationHandoff;
  /**
   * Checkpoint operations with the registered-workspace gate applied to
   * `create`. The raw {@link workspaceCheckpointManager} sits beside it for the
   * read/restore paths that were never gated.
   */
  readonly guardedCheckpoints: Pick<WorkspaceCheckpointManager, 'list' | 'create' | 'diff' | 'restore' | 'sessionChanges' | 'workspaceRoot'>;
  /** Every client seam's one plug into the connected host. */
  readonly daemonVerbs: DaemonVerbCaller;
  /**
   * The connected host's address and token, or the honest reason there is
   * none, the SAME resolution {@link daemonVerbs} uses.
   *
   * For the seams that need a long-lived stream rather than a call (the
   * approvals update stream, a hosted conversation's event stream). Sharing
   * the resolution is what keeps a surface from calling one daemon and
   * streaming from another.
   */
  readonly resolveConnectedHost: () => { readonly baseUrl: string; readonly token: string } | { readonly reason: string };
  /** Daemon-owned settings, read and written where they are acted on. */
  readonly daemonConfigClient: DaemonConfigClient;
  /** Credentials the daemon uses, written as one verified pair. */
  readonly daemonCredentialsClient: DaemonCredentialsClient;
  /** The paired-phone surface, as a client of the daemon's device runtime. */
  readonly devicesClient: DevicesClient;
  /**
   * Answers the daemon's conversation-rewind questions about the session this
   * process is holding. Started at bootstrap, released at shutdown.
   */
  readonly conversationRewindHost: ConversationRewindHostClient;
  readonly sessionSpineClient: SessionSpineClient;
  /** The client shape's name for {@link sessionSpineClient}; the same instance. */
  readonly sessionSpine: SessionSpineClient | null;
  /** The client shape's name for {@link memorySpineClient}; the same instance. */
  readonly memoryAccess: MemorySpineClient | null;
  /** Local file-tool state (surface-local by design). */
  readonly fileCache: FileStateCache;
  readonly projectIndex: ProjectIndex;
  /**
   * Connected-host honesty receipts ("updated from X to Y", "restarted after
   * a crash") captured off the spine probe's /status reads; the renderer
   * attaches at bootstrap and every receipt is delivered exactly once.
   */
  readonly daemonReceiptFeed: AgentDaemonReceiptFeed;
  /**
   * Performs ONE receipt-consuming /status read (`?receipts=consume`) and pushes
   * whatever the daemon delivered into {@link daemonReceiptFeed}. A current
   * daemon delivers its one-shot honesty receipts only to a consuming read (a
   * plain liveness /status read is receipt-neutral), so bootstrap invokes this
   * exactly once per attach, see the memory-spine adoption reconciler's
   * `onAttach`. Best-effort: it never throws and yields nothing on failure.
   */
  readonly consumeDaemonReceipts: () => Promise<void>;
  /**
   * May the daemon answering right now be adopted by this build?
   *
   * Reads `/status` for the daemon's version and judges it against this
   * product's build floor. False means the daemon is too old to serve what this
   * build depends on, and the adoption reconciler leaves the memory spine local
   * and the inbound dispatch unbound, the same state as no daemon at all, plus
   * one notice naming both versions.
   *
   * True when nothing could be read. An unreachable or truncated `/status` is
   * not evidence of an old daemon, and refusing on a dropped request would turn
   * one failed read into a lost adoption; a daemon that is not answering is the
   * reachability probe's business, not the floor's.
   */
  readonly mayAdoptDaemonBuild: () => Promise<boolean>;
  /**
   * Local idle-time memory-consolidation run receipts, one honest one-line
   * summary per run with something to report, rendered through the SAME
   * attach-time-notice idiom as {@link daemonReceiptFeed} (buffered until a
   * render sink attaches, delivered exactly once), but on its own feed so a
   * local consolidation run is never mislabeled "[Connected host]".
   */
  readonly memoryConsolidationReceiptFeed: AgentDaemonReceiptFeed;
  readonly deliveryManager: AutomationDeliveryManager;
  readonly automationManager: AutomationManager;
  /**
   * Fleet rows from this process's registry unioned with the adopted daemon's,
   * local winning on a shared id. Read by the Activity modal so work the
   * daemon is running is visible here too.
   */
  readonly fleetUnion: AgentFleetUnion;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly artifactStore: ArtifactStore;
  /** Compatibility alias that intentionally points at the isolated Agent Knowledge service, not default knowledge. */
  readonly knowledgeService: KnowledgeService;
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: SdkCompanionGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  readonly workPlanStore: WorkPlanStore;
  readonly memoryStore: MemoryStore;
  readonly memoryRegistry: MemoryRegistry;
  /**
   * The consumer half of the daemon-served memory spine (SDK 1.1.0). Constructed
   * in LOCAL mode always (wrapping `memoryRegistry` directly); a deferred boot task
   * (see bootstrap.ts, mirroring the session-spine reachability probe) activates it
   * with the REST wire transport when the agent confirms an adopted daemon, and
   * deactivates it back to local on confirmed daemon loss. Every consumer that can
   * express its memory op through the five wire-covered methods (add/honestSearch/
   * get/updateReview/delete) should route through THIS client, never `memoryRegistry`
   * directly, so it automatically stops touching the local store file the moment a
   * daemon is adopted (the single-writer invariant, see memory-spine/client.ts).
   */
  readonly memorySpineClient: MemorySpineClient;
  /** The wire transport handed to `memorySpineClient.activate()` on daemon adoption; exposed so bootstrap can activate/reuse it without rebuilding the connection resolver. */
  readonly memorySpineTransport: MemoryTransport;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly profileManager: ProfileManager;
  readonly bookmarkManager: BookmarkManager;
  readonly sessionManager: SessionManager;
  readonly sessionOrchestration: CrossSessionTaskRegistry;
  readonly hookDispatcher: HookDispatcher;
  readonly hookActivityTracker: HookActivityTracker;
  readonly hookWorkbench: HookWorkbench;
  readonly pluginManager: PluginManager;
  readonly workflow: WorkflowServices;
  readonly voiceProviders: VoiceProviderRegistry;
  readonly voiceService: VoiceService;
  /**
   * Managed local-voice provisioning: status read + one-act install, mirroring
   * the SDK's own daemon composition (platform/runtime/services.ts).
   */
  readonly voiceSetup: AgentVoiceSetupService;
  /**
   * SDK-owned memory governance, composed here exactly as the SDK's own
   * daemon composition does (constructed and STARTED by default, it is a
   * safety feature): samples RSS/heap, sheds registered caches by tier,
   * pauses deferrable background jobs, and trips on a genuine leak before
   * the OS OOM-kills the process. Serves ops.memory.get and /health memory.
   */
  readonly memoryGovernor: MemoryGovernor;
  /** Registry of every retained cache the governor can observe and shrink. */
  readonly cacheRegistry: CacheRegistry;
  /** Backpressure seam the governor drives to pause/resume deferrable background jobs. */
  readonly pauseController: PauseController;
  readonly webSearchProviders: WebSearchProviderRegistry;
  readonly webSearchService: WebSearchService;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  readonly channelPolicy: ChannelPolicyManager;
  readonly mcpRegistry: McpRegistry;
  readonly tokenAuditor: ApiTokenAuditor;
  readonly componentHealthMonitor: ComponentHealthMonitor;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly webhookNotifier: WebhookNotifier;
  /** OS-level terminal focus tracker (SDK platform/runtime). */
  readonly focusTracker: FocusTracker;
  readonly replayEngine: DeterministicReplayEngine;
  readonly providerOptimizer: ProviderOptimizer;
  readonly providerCapabilityRegistry: ProviderCapabilityRegistry;
  readonly cacheHitTracker: CacheHitTracker;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly modelLimitsService: ModelLimitsService;
  readonly providerRegistry: ProviderRegistry;
  readonly toolLLM: ToolLLM;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly sessionLineageTracker: SessionLineageTracker;
  readonly sessionChangeTracker: SessionChangeTracker;
  readonly planManager: ExecutionPlanManager;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly idempotencyStore: IdempotencyStore;
  readonly overflowHandler: OverflowHandler;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentManager: AgentManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly agentOrchestrator: AgentOrchestrator;
  readonly contractIntake: ContractIntake;
  readonly execPromptAnswerHandler: ApprovalDerivedHandlers['execPromptAnswerHandler'];
  readonly sandboxEscalationHandler: ApprovalDerivedHandlers['sandboxEscalationHandler'];
  readonly processManager: ProcessManager;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly executionLedger: AgentExecutionLedger;
  /** Detaches the session write ledger from the runtime bus and clears it. */
  readonly disposeSessionWriteLedger: () => void;
  /**
   * Stop every poller this graph started (config watch, fleet tick, memory
   * governor, watcher registry, cross-session sweep, orchestration writer, push
   * sweep, both knowledge schedulers, the snapshot/retention/consolidation
   * schedulers, the spine keepalive) and release their handles.
   *
   * Restated from the SDK interface because ownership differs here: this fork
   * composes no DaemonServer of its own, so nothing else will ever call this.
   * Every path that builds a graph owns taking it back down. Best-effort, total
   * and idempotent, an owner that throws is logged and the rest still come down.
   */
  dispose(): void;
  readonly integrationHelpers: IntegrationHelperService;
  /**
   * Re-root workspace-bound stores to a new working directory.
   * Agent memory is home/profile-owned and intentionally does not move on workspace swap.
   * Called by WorkspaceSwapManager after the new directory has been verified.
   * Stores that require a process restart emit a warn-level log; they continue serving
   * the old path until the externally owned GoodVibes host restarts with the new --working-dir.
   */
  rerootStores(newWorkingDir: string): Promise<void>;
}

/**
 * One honest one-line summary of a consolidation run, or null for a run that
 * genuinely did nothing (nothing merged, archived, decayed, or proposed),
 * a quiet no-op run should not interrupt the user with an empty notice.
 */
export function describeMemoryConsolidationReceipt(receipt: MemoryConsolidationRunReceipt): string | null {
  const parts: string[] = [];
  if (receipt.merged.length > 0) parts.push(`merged ${receipt.merged.length}`);
  if (receipt.archived.length > 0) parts.push(`archived ${receipt.archived.length}`);
  if (receipt.decayed.length > 0) parts.push(`decayed ${receipt.decayed.length}`);
  if (receipt.proposed.length > 0) parts.push(`${receipt.proposed.length} proposed for review`);
  if (parts.length === 0) return null;
  return `Memory consolidation (${receipt.trigger}): ${parts.join(', ')}.`;
}

export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  const disposalScope = createDisposalScope('RuntimeServices'); // see @goodvibes-jev/engine/sdk/platform/runtime/disposal
  const workingDirectory = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const surface = createSessionSurface({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDirectory,
    homeDirectory,
  });
  const configManager = options.configManager;
  const featureFlags = options.featureFlags ?? createFeatureFlagManager();
  if (options.featureFlags === undefined) {
    // Gate states derive from domain settings keys; the bridge keeps live
    // config.set changes flowing. Wired only for a manager this call owns,
    // an injected manager (bootstrap-core's) is the caller's to seed/bridge.
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    bindFeatureSettingsBridge(configManager, featureFlags);
  }
  // AGENT-LOCAL DUTY: the in-process dispatch table a loaded plugin registers
  // its verbs into.
  //
  // bootstrap.ts hands this catalog to `pluginManager.init({ gatewayMethods })`,
  // which is the one thing that ever writes to it. Two model tools read it:
  // `createOccasionsGatewayInvoke` and `createProfileGatewayInvoke` probe
  // `catalog.hasHandler(methodId)` and, finding nothing, dispatch to the daemon
  // instead, so `occasions.*` and `profile.*` are answered by the process that
  // owns the owner-profile document, and a plugin that registers a verb of its
  // own is still picked up by the same probe.
  //
  // It is local dispatch for this process and never a served surface: this
  // process composes no DaemonServer and starts no listener, so nothing outside
  // it can reach a handler registered here. Anything a client of this Agent
  // needs from a verb family reaches the daemon that serves it.
  const gatewayMethods = new GatewayMethodCatalog();

  // ── The client seams ─────────────────────────────────────────────────────
  // One verb caller, handed to every seam. Connection resolution stays here (see
  // client/daemon-verbs.ts) because deciding which daemon this agent trusts is a
  // trust-boundary concern, not a policy the platform reaches into.
  // One set of options, used twice on purpose: the verb caller dials the host
  // with them, and the approval-update stream resolves the SAME host and token
  // from them. Two resolutions would be two hosts the day they disagree.
  const connectedHostAccess = { configManager, homeDirectory };
  const daemonVerbs: DaemonVerbCaller = createAgentDaemonVerbCaller(connectedHostAccess);
  // What this process is actually running, answered from itself rather than from
  // the daemon's cross-surface register. Feeds inbound dispatch, the
  // conversation-rewind host, the trigger family's liveness check, and both
  // "is anything busy" consumers.
  const hostedSessions = createHostedSessionRegistry(options.runtimeBus);
  // The prompt this surface draws. Late-bound: the renderer patches it in after
  // boot, which is why the raiser takes a getter rather than the function.
  // Constructed here (not in bootstrap-core) so the ask seam and the permission
  // manager it feeds are both part of the graph, exactly as the client shape
  // says they are.
  const permissionPromptRef: { requestPermission: LocalPermissionPrompt } = {
    requestPermission: async () => ({ approved: false, remember: false }),
  };
  // An ask is raised on the daemon AND prompted here, and the first real answer
  // wins. Raising it only into this process's own ApprovalBroker would leave it
  // invisible to the daemon's attention machinery, to every other surface, and
  // to the phone that is supposed to be able to answer it.
  const requestApproval: ApprovalRaiser = createClientApprovalRaiser({
    verbs: daemonVerbs,
    actor: 'agent',
    localPrompt: () => permissionPromptRef.requestPermission,
    sessionId: () => options.resolveSessionId?.({}),
  });
  // Inbound continuation dispatch, over the wire instead of over a register this
  // process holds. Inert until `activate`, an agent with no adopted daemon holds
  // its bound runner and dispatches nothing, which is the honest offline posture.
  // The agent register this dispatch reads finished runs from. It is built by
  // the client floor below, after this line, so the seam is late-bound rather
  // than reordered, the floor takes `sessionDispatch` as an option, so the two
  // cannot both be constructed first.
  let dispatchAgentStatus: ((agentId: string) => AgentCompletionRecordView | null) | null = null;
  const sessionDispatch: WireSessionDispatch = createWireSessionDispatch({
    hostedSessionIds: () => hostedSessions.ids(),
    // The reply half. A continuation dispatched here runs in THIS process, so
    // the daemon's own completion poll can never see it finish; this is how the
    // answer gets reported back, and how a message that arrived over a channel
    // is answered into that channel instead of into nothing.
    readAgentOutcome: (agentId) => readSurfaceAgentOutcome(dispatchAgentStatus?.(agentId) ?? null),
  });
  // Hand-to-hosting. The continuation runner below asks this FIRST on every
  // inbound message; with the setting off it answers "not promoted" without a
  // round trip and the runner spawns locally exactly as it always has. The
  // setting is read per call, so turning it on takes effect on the next message
  // rather than the next restart.
  const hostedHandoff = createHostedConversationHandoff({
    verbs: daemonVerbs,
    isEnabled: () => configManager.get('hostedSessions.promoteInboundConversations') === true,
    // The workspace a promoted conversation's tools operate in is the one this
    // process is working in, the same root its local spawn would have used.
    workspaceRoot: () => workingDirectory,
    // Stable for the life of the process and legible in `attachedClients`, so
    // an owner listing hosted sessions can see which surface handed each one over.
    clientId: `${GOODVIBES_AGENT_SURFACE_ROOT}:${process.pid}`,
    log: logger,
  });

  // ── The client floor ─────────────────────────────────────────────────────
  //
  // Everything a surface's own turn needs in-process, built by the platform
  // rather than a second time here: the credential/config/service stores, the
  // model stack, the agent graph, hooks, plugins, MCP, permissions as a client,
  // the file-tool caches, and the session/orchestration stores. What follows
  // this call is what the AGENT genuinely has on top of a surface, automation,
  // channels and delivery, watchers and triggers, the two knowledge stores and
  // the home graph, voice and media, checkpoints, the orchestration engine, the
  // fleet registry, the memory governor, all of it built over these instances.
  //
  // The three named options are the floor's own seams for the three places this
  // product's posture differs from the default, each spelled out rather than
  // re-derived by rebuilding the piece:
  //
  //  • providerRegistryFactory, launch tolerance. This product must reach a
  //    first frame with broken or absent provider credentials; the default
  //    `new ProviderRegistry` throws on one. (The callback also gives this
  //    product's raw-literal handling to the credential store the floor built,
  //    see buildAgentProviderRegistry.)
  //  • modelDiscovery, the unawaited discovery write outlives a short-lived
  //    composition (a suite against a temp workspace, a one-shot subcommand),
  //    so callers that will not outlive it say `skip`. Same rule
  //    `shouldRefreshModels` has always applied, now spoken to the floor.
  //  • hookAgentManager: 'withhold', a `type: 'agent'` hook here answers
  //    "agent hook runner is not configured in this runtime" and spawns
  //    nothing. The omission is the feature (pinned by
  //    src/test/runtime/bootstrap-services.test.ts); naming it as an option is
  //    what keeps it legible as a decision rather than a wiring bug.
  //
  // Not taken from the floor, with the reason in each case: `sessionSpine` and
  // `memoryAccess` (this product builds both over its OWN REST transports and
  // a locally-opened canonical memory store, and hands them to the graph under
  // their own names below); `surface` (a declared `SessionSurface`, which the
  // floor takes as a bare surfaceRoot); and the approval-derived handlers plus
  // the feature-announcement store, which the floor builds internally and does
  // not expose, so this composition keeps its own, they are graph members here
  // (`localhostFetchApproval`, `onSandboxedRun`, `featureAnnouncementStore`)
  // that other code reads by name.
  const clientFloor = createClientRuntimeServices({
    workspaceTrust: null, // Agent has no separate legacy workspace-trust policy.
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    configManager,
    featureFlags,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDirectory,
    requestApproval,
    sessionDispatch,
    providerRegistryFactory: buildAgentProviderRegistry,
    modelDiscovery: shouldRefreshModels(options.modelDiscovery) ? 'run' : 'skip',
    hookAgentManager: 'withhold',
    // One live agent per home. This product is a singleton: one agent per
    // machine, holding one `.goodvibes/agent/` tree with one session store,
    // one state file and one transcript. A second copy booted onto the same
    // home, a fork out of a turn is how it happened, gave that tree two
    // writers, which is what tore a temp file and left a session marked
    // "active" by a process that no longer existed. With `claim`, the second
    // boot stops at the claim and says which pid holds the home instead of
    // racing it. The terminal deliberately stays 'off': one project opened in
    // two windows is a shape people use every day.
    homeSingleWriter: 'claim',
  });
  const {
    shellPaths,
    runtimeDispatch,
    secretsManager,
    serviceRegistry,
    subscriptionManager,
    providerRegistry,
    providerCapabilityRegistry,
    providerOptimizer,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    toolLLM,
    archetypeLoader,
    agentManager,
    agentMessageBus,
    agentOrchestrator,
    contractRunner,
    sessionManager,
    sessionOrchestration,
    workflow,
    sandboxSessionRegistry,
    processManager,
    modeManager,
    fileUndoManager,
    overflowHandler,
    contextAccountingHolder,
    sessionLiveTurnControls,
    mcpRegistry,
    artifactStore,
    webSearchProviders,
    webSearchService,
    hookDispatcher,
    hookActivityTracker,
    hookWorkbench,
    pluginManager,
    policyRuntimeState,
    userPermissionRuleStore,
    permissionManager,
    fileCache,
    projectIndex,
  } = clientFloor;
  // The configured chat model must name a provider the registry can actually
  // route to. Runs after the floor's `initCustomProviders()` rather than before
  // it, so a model served by a user-defined provider is seen as routable
  // instead of being rewritten off a registry that had not loaded it yet.
  ensureConfiguredModelIsRoutable(providerRegistry, configManager);
  // Everything the floor started comes down with this graph. Idempotent, and it
  // overlaps deliberately with the poller registration further below: whichever
  // runs first does the work.
  disposalScope.registry.add('client runtime floor', () => clientFloor.dispose());

  const daemonConfigClient: DaemonConfigClient = createDaemonConfigClient(daemonVerbs);
  const daemonCredentialsClient: DaemonCredentialsClient = createDaemonCredentialsClient(daemonVerbs);
  // NOT installed here. The two settings-routing clients are process-wide (five
  // settings writers reach them with no graph in scope), and this factory is
  // called by unit tests, one-shot CLI subcommands and readiness probes as well
  // as by the real boot, so installing here would let any of them change how a
  // later, unrelated write behaves, silently, for the rest of the process.
  // The interactive bootstrap installs them (see bootstrap-core.ts) and
  // `dispose()` below clears them.
  // The grants ledger, the capture store and the housekeeping sweeps are the
  // daemon's; two runtimes writing one ledger is the second-writer hazard the
  // split exists to end. The `phone` TOOL still lives here, because the loop
  // that calls it does.
  const devicesClient: DevicesClient = createDevicesClient(daemonVerbs);
  const keybindingsManager = new KeybindingsManager({
    configPath: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'keybindings.json'),
  });
  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional. `isFeatureGateEnabled(null, ...)` is permissive by design, a
  // narrow embed with no manager wired gets the capability rather than a silent
  // off, so omitting it did not disable route binding. It did something worse:
  // it made `integrations.routeBinding` configure nothing at all. The setting
  // rendered, accepted a write, reported success, and the manager went on
  // resolving bindings either way, which is the exact shape of the defect the
  // Telegram-bot-username round was about: a value that looks applied and is
  // not. The TUI has always threaded it (runtime/channel-composition.ts); this
  // fork's composition root did not.
  //
  // Threading it preserves current effective behaviour rather than changing it:
  // the config default is true (the SDK's schema-domain-features.ts), the flag's
  // own defaultState is 'enabled', and the flag declares no notOperable record,
  // so with nothing configured the gate reads exactly as it did before, and the
  // difference is only that turning it OFF now turns it off.
  const routeBindings = new RouteBindingManager({
    store: new AutomationRouteStore({ configManager }),
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    featureFlags,
  });
  const surfaceRegistry = new SurfaceRegistry(configManager, options.runtimeStore);
  const channelPlugins = new ChannelPluginRegistry();
  surfaceRegistry.attachPluginRegistry(channelPlugins);
  const localUserAuthManager = options.localUserAuthManager ?? new UserAuthManager({
    bootstrapFilePath: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-users.json'),
    bootstrapCredentialPath: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-bootstrap.txt'),
  });
  const profileManager = new ProfileManager(shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'profiles'));
  const bookmarkManager = new BookmarkManager(shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'bookmarks'));
  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional. isFeatureGateEnabled(null, ...) is permissive by design, a
  // narrow embed with no manager wired gets the capability rather than a
  // silent off, so omitting it did not disable the watcher framework when
  // watchers.enabled is turned off; it made the setting configure nothing.
  // Threading it preserves current effective behaviour rather than changing
  // it: watchers.enabled defaults true, the watcher-framework flag's own
  // defaultState is 'enabled', and the flag declares no notOperable record,
  // so with nothing configured the gate reads exactly as before, and the
  // difference is only that turning it OFF now turns it off. The TUI has
  // always threaded it the same way.
  const watcherRegistry = new WatcherRegistry({
    storePath: shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'watchers.json'),
    featureFlags,
  });
  watcherRegistry.attachRuntime({
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
  });
  const contractOperator = createContractOperatorService({ runner: contractRunner, workingDirectory });
  const contractIntake = createContractIntake({ runner: contractRunner, projectRoot: workingDirectory });
  // Close the late-bound seam declared above `createWireSessionDispatch`: the
  // dispatch can now read the outcome of a run it started.
  dispatchAgentStatus = (agentId) => agentManager.getStatus(agentId);
  // AGENT-LOCAL DUTY: the asks this process must be able to answer on its own
  // screen.
  //
  // A tool running in this loop asks for permission here, and the on-screen card
  // resolves it here (permissions/broker-approval.ts calls resolveApproval on
  // this instance); the shell's approvals card opens off this broker's
  // subscribe(); and the distributed-runtime handover records its asks against
  // it. All three are answers a person gives at THIS terminal, which no wire
  // call can stand in for.
  //
  // What it is NOT is the record of record. Every ask is also raised on the
  // daemon (`requestApproval` above), the approvals list RENDERS the union of both halves
  // (`approvalsView` below), and a phone answering over the daemon's verbs wins
  // the race just as a keystroke here does.
  const approvalBroker = new ApprovalBroker({
    storePath: shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'approvals.json'),
  });
  // The approvals list's source. The broker above holds only what the distributed-runtime
  // bridge still hands this process in-process; the asks THIS surface raises are
  // recorded on the daemon, and so are every other surface's. One list, read
  // over `approvals.list`, unioned with the broker's, with the honest reason
  // when the daemon cannot be read. Started by the interactive bootstrap (a
  // one-shot subcommand has nobody to show the list to); `refresh()` works
  // without `start()` for a single read.
  const approvalsView = createApprovalsView({
    verbs: daemonVerbs,
    localBroker: approvalBroker,
    // Push replaces the 15s wait, not the read. An ask raised on a phone shows
    // in the list the moment the daemon records it, and a decision made
    // elsewhere clears it just as fast; when the stream cannot be opened or
    // drops, the periodic re-read is still there and the snapshot says so.
    subscribe: async ({ onUpdate, onTerminate }) => {
      const resolved = resolveConnectedHostConnection(connectedHostAccess);
      if ('reason' in resolved) {
        logger.debug('[approvals] no connected host for the approval-update stream; the list keeps re-reading', {
          reason: resolved.reason,
        });
        return null;
      }
      return await watchApprovalUpdates({
        baseUrl: resolved.baseUrl,
        getAuthToken: () => resolved.token,
        onUpdate,
        onTerminate,
      });
    },
  });
  disposalScope.registry.add('approvals view', () => approvalsView.stop());
  // NOT an agent-local duty, and withheld from this graph accordingly.
  //
  // A pairing token is minted, checked and revoked at a listener: the
  // `pairing.tokens.*` verb group and the HTTP auth path that reads the token a
  // paired phone presents. Both belong to the daemon, which is the process that
  // listens. This one composes no server, so a manager here would hold a
  // snapshot of the daemon's pairing file that nothing reads and nothing keeps
  // current. Phones and companion clients reach this Agent's device tools
  // through `devicesClient` below, over the daemon's verbs, never through a
  // token this process holds.
  //
  // The SDK's DAEMON-GRADE shape still names the member, because a daemon has
  // one, so `asDaemonGradeView()` supplies it, scoped to THIS surface's own
  // control-plane directory so it can never read or write the daemon's file,
  // and built lazily so nothing exists unless one of those three SDK entry
  // points someday asks. None of them dereferences it today.
  let surfaceScopedPairingTokens: PairingTokenManager | null = null;
  const pairingTokensForDaemonGradeView = (): PairingTokenManager => (
    surfaceScopedPairingTokens ??= new PairingTokenManager(
      shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'pairing-tokens.json'),
    )
  );
  // AGENT-LOCAL DUTY: the register this product's automation runs its jobs on.
  //
  // `AutomationManager` takes a concrete `SharedSessionBroker` and drives seven
  // of its methods to run a job, ensureSession, findPreferredSession,
  // submitMessage, bindAgent, completeAgent, appendSystemMessage, start
  // (platform/automation/manager-runtime-execution.ts), and bootstrap-core
  // registers this process's own live session in it. It is named for that
  // rather than for the wider word "sessions".
  //
  // It DISPATCHES nothing. Inbound continuation work for a session this process
  // hosts arrives over `sessionDispatch` above, from the daemon.
  //
  // Its other readers are read-only and follow it here rather than justify a
  // second copy: the fleet registry's session rows, the distributed-runtime
  // session bridge, the memory governor's session-union cache adapter, and the
  // integration helpers. Nothing in that list is a dispatch path either.
  const automationSessionRegister = new SharedSessionBroker({
    storePath: shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'sessions.json'),
    routeBindings,
    agentStatusProvider: agentManager,
    messageSender: agentMessageBus,
    // Without this the conversation gate runs on DEFAULTS: an inbound channel
    // message landing in an already-live session takes the live-agent handover
    // and starts work whatever conversationGate.mode/gatedSurfaces say.
    conversationGateConfig: configManager,
  });
  // The SDK's extracted session-spine core, consumed via this surface's
  // own REST transport adapter (session-spine-rest-transport.ts), version-
  // tolerant, since the agent may compile against a pinned SDK predating the
  // typed sessions.register client. Live-immediately mode: passing `transport`
  // at construction starts the keepalive now, for the whole process lifetime
  // (no separate activate() step, the agent has none). Client-only; never
  // starts the daemon. All calls are fire-and-forget; a down daemon degrades to
  // an honest offline queue while the local broker keeps rendering.
  const spineResolveConnection = createSpineConnectionResolver(configManager, homeDirectory);
  const daemonReceiptFeed = new AgentDaemonReceiptFeed();
  // The daemon's one-shot honesty receipts are delivered ONLY to an explicit
  // `?receipts=consume` read (a plain /status read is receipt-neutral), so the
  // liveness probe below stays plain and a SEPARATE consuming read runs once
  // per attach (bootstrap wires this to the memory-spine reconciler's onAttach).
  const spineReceiptConsumer = createSessionSpineReceiptConsumer({ resolveConnection: spineResolveConnection });
  // The reverse of the client floor below: this process judging the daemon it
  // attached to. A daemon too old to serve a verb this build depends on shows
  // up as one call returning 400 or 404, which reads as a broken feature rather
  // than as an old daemon, so the build is checked once per attach and the
  // owner is told in the same feed the forward guard uses. The floor this
  // product declares is '1.28.0', the daemon/TUI product-split breaking
  // change; see runtime/daemon-build-compatibility.ts for why that is a
  // decision with a release note attached.
  const daemonBuildGuard = new DaemonBuildGuard({
    floor: AGENT_DAEMON_BUILD_FLOOR,
    onDaemonUpdateRequired: (verdict) => {
      logger.warn('the attached daemon is older than this Agent build requires', {
        daemonVersion: verdict.daemonVersion,
        floor: verdict.floor,
      });
      daemonReceiptFeed.push([{ id: `daemon-build-floor:${verdict.floor ?? 'unknown'}`, text: verdict.message, at: Date.now() }]);
    },
  });
  // The adoption gate. Asked on the adoption edge, before anything routes over
  // the wire, so a daemon below the floor is refused rather than half-used.
  // Its own plain /status read: the receipt-consuming read below has a side
  // effect (the daemon serves each receipt once) and must not be what decides
  // adoption, and it only runs AFTER a daemon has been adopted anyway.
  const mayAdoptDaemonBuild = async (): Promise<boolean> => {
    const connection = spineResolveConnection();
    const status = await readDaemonStatusPayload(connection);
    // Nothing read, nothing known, adopt, and leave a daemon that is not
    // answering to the reachability handling that owns that question.
    if (status === null) return true;
    return daemonBuildGuard.judgeForAdoption(status, connection.baseUrl).status !== 'daemon-update-required';
  };
  const consumeDaemonReceipts = async (): Promise<void> => {
    // Same attach, two reads of the same route: the consuming one that collects
    // the daemon's one-shot receipts, and a plain one for the build it is
    // running. Kept separate because `?receipts=consume` has a side effect and
    // the build check must not be the thing that drains them.
    const connection = spineResolveConnection();
    const status = await readDaemonStatusPayload(connection);
    if (status !== null) daemonBuildGuard.observeStatus(status, connection.baseUrl);
    const receipts = await spineReceiptConsumer();
    if (receipts.length > 0) daemonReceiptFeed.push(receipts);
  };
  // A daemon update swaps the daemon binary and leaves this process running the
  // build it started with. The daemon announces the minimum client build it
  // accepts on the same /status read the liveness probe already makes; when
  // this build is below it, the guard latches, the owner is told in the receipt
  // feed that already renders daemon notices, and the continuation runner below
  // stops taking shared-session work rather than executing it under superseded
  // rules. See runtime/client-build-compatibility.ts.
  const clientBuildGuard = new ClientBuildGuard({
    clientVersion: VERSION,
    onRestartRequired: (verdict) => {
      logger.warn('daemon requires a newer client build; shared-session work is paused', {
        clientVersion: verdict.clientVersion,
        floor: verdict.floor,
      });
      daemonReceiptFeed.push([{ id: `client-build-floor:${verdict.floor ?? 'unknown'}`, text: verdict.message, at: Date.now() }]);
    },
  });
  const sessionSpineClient = new SessionSpineClient({
    participant: AGENT_SPINE_PARTICIPANT,
    // Explicit, despite AGENT_SPINE_PARTICIPANT's own doc comment suggesting
    // recordKind can be left unset: verified against the live daemon-sdk route
    // (runtime-session-register.js) that no server-side stamping of kind:'agent'
    // for a surfaceKind:'service' participant actually exists, an absent kind
    // falls through SharedSessionBroker's own default (`input.kind ?? 'tui'`),
    // which would silently record every agent session as a TUI session. Setting
    // recordKind here is supplying the class's own public option.
    recordKind: 'agent',
    transport: createSessionSpineRestTransport({ resolveConnection: spineResolveConnection }),
    // Liveness only: a plain /status read that never consumes receipts. The
    // once-per-attach consuming read above is the agent's receipt reader.
    probe: createSessionSpineRestProbe({
      resolveConnection: spineResolveConnection,
      onDaemonFloor: (floor) => clientBuildGuard.observeFloor(floor),
    }),
    log: logger,
  });
  // The runner body for an inbound continuation. It ARRIVES over
  // `sessions.inputs.list` on the adopted daemon, for the sessions this process
  // is hosting, and runs here because this is the process holding the loop. The
  // build-floor check is the first thing the runner does.
  sessionDispatch.setContinuationRunner(async ({ task, input }) => {
    // Too old for the live daemon: refuse the work instead of doing it the old
    // way. The owner has already been told to restart this process.
    if (!clientBuildGuard.maySharedSessionWork()) {
      logger.warn('declined a shared-session continuation: this build is below the daemon floor', {
        sessionId: input.sessionId,
        floor: clientBuildGuard.current().floor,
      });
      return null;
    }
    // Hand-to-hosting, tried before anything is spawned here. Promoted, the
    // conversation's loop runs in the daemon and this process is done with the
    // message; not promoted, the reason is stated and the local answer below is
    // exactly the answer this runner has always given. The one silent case is
    // the setting being off, which is the shipped default and not news.
    const handoff = await hostedHandoff.promote({
      sessionId: input.sessionId,
      task,
      body: input.body,
      ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
      ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    if (handoff.promoted) {
      // No local agent ran, and saying otherwise would bind a reply to an agent
      // id that does not exist. The input is still consumed: the daemon has it.
      return null;
    }
    if (!handoff.disabled) {
      logger.warn('this conversation could not be handed to the daemon to host; answering it in this process', {
        sessionId: input.sessionId,
        reason: handoff.reason,
      });
    }
    const record = agentManager.spawn({
      mode: 'spawn',
      task,
      // Conversation first: a follow-up message in a session gets an answer,
      // not a write-review-fix-confirm chain with a reviewer, quality gates,
      // and a second agent. A chain opens only for an explicit authorization
      // marker, set by the channel confirmation the owner gave, or by the
      // schedule/trigger that was confirmed when it was created, or for a
      // follow-up typed on a local surface. Both `conversationGate.mode` and
      // the `gatedSurfaces` list now read the live config: the 1.21.0 re-pin
      // carries the `conversationGate` schema domain, so `getCategory` reads
      // the configured surface list instead of falling back to the SDK's
      // shipped defaults.
      ...continuationContractOptions(input, {
        configReader: {
          get: (key: string) => configManager.get(key as never),
          getCategory: (name: string) => configManager.getCategory(name as never),
        },
      }),
      // Spawn routing resolves through the SDK's shared model-reference
      // resolver contract (unique-across-registry auto-qualifies; ambiguous
      // and unknown ids throw errors naming real candidates), the live
      // registry's models are the candidate list.
      ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { restrictTools: true, modelCandidates: providerRegistry.listModels() }),
      context: `shared-session:${input.sessionId}`,
    });
    return { agentId: record.id };
  });
  const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  // The ONE canonical cross-surface store, not a private per-surface
  // memory.sqlite, so a fact learned here recalls in the TUI and vice-versa. An
  // agent-global path from an earlier layout is folded in at boot with no loss
  // (see foldAgentLegacyMemory), then left in place, migration never deletes.
  const memoryDbPath = resolveCanonicalMemoryDbPath(shellPaths.homeDirectory);
  const memoryStore = new MemoryStore(memoryDbPath, {
    embeddingRegistry: memoryEmbeddingRegistry,
  });
  const memoryRegistry = new MemoryRegistry(memoryStore);
  // Consumer half of the memory spine (SDK 1.1.0). Always constructed in LOCAL mode
  // (embedded/offline is a hard requirement, the agent must work with no daemon
  // running). `spineResolveConnection` above is the SAME connected-host connection
  // (host/port/token) already built for the session spine; one daemon, one resolver.
  // Activation to CLIENT mode (routing every op over the wire, for the whole process
  // lifetime, never touching this local store again) happens in a deferred boot task
  //, see bootstrap.ts's 'memory-spine' schedule, once that task confirms a daemon
  // is actually adopted, reusing sessionSpineClient.probeReachability() as the
  // existing daemon-adoption signal rather than inventing a second one.
  const memorySpineClient = new MemorySpineClient({
    local: createLocalMemoryAccess(memoryRegistry),
    log: logger,
  });
  const memorySpineTransport = createMemorySpineRestTransport({ resolveConnection: spineResolveConnection });
  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional. isFeatureGateEnabled(null, ...) is permissive by design, so
  // omitting it did not disable delivery tracking when
  // integrations.deliveryTracking is turned off, deliverText/deliverJobRun
  // kept running either way. Threading it preserves current effective
  // behaviour rather than changing it: the config default is true, the
  // delivery-engine flag's own defaultState is 'enabled', and the flag
  // declares no notOperable record, so with nothing configured the gate
  // reads exactly as before. Same fix as goodvibes-tui's services.ts.
  const deliveryManager = new AutomationDeliveryManager({
    configManager,
    // Required: the router this builds resolves goodvibes://secrets/...
    // surface credentials through it. Omitting it produced a delivery path
    // that accepted replies and dropped them at send time, see the same fix
    // in goodvibes-tui and the SDK's now-mandatory parameter.
    secretsManager,
    serviceRegistry,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    routeBindings,
    artifactStore,
    featureFlags,
  });
  // Same shape as deliveryManager above: automation.enabled defaults true, the
  // automation-domain flag's own defaultState is 'enabled', so threading
  // featureFlags here does not change what a default install does, it only
  // makes turning automation.enabled off actually turn AutomationManager's own
  // create/update/run/list surface off. This composes with bootstrap.ts's own
  // `if (configManager.get('automation.enabled'))` gate around scheduling
  // automationManager.start(): that check reads the same key, and
  // AutomationManager.start() re-checks the same gate internally (it no-ops
  // and stops rather than starting when disabled), so the two can never
  // disagree, this fix only reaches the manager's OTHER entry points
  // (createJob/updateJob/runNow/etc.) that the bootstrap.ts gate does not
  // cover.
  const automationManager = new AutomationManager({
    configManager,
    defaultSurfaceKind: 'service',
    routeBindings,
    sessionBroker: automationSessionRegister,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    deliveryManager,
    providerRegistry,
    featureFlags,
    spawnTask: (input) => {
      const record = agentManager.spawn({
        mode: 'spawn',
        task: input.prompt,
        ...(input.modelId ? { model: input.modelId } : {}),
        ...(input.modelProvider ? { provider: input.modelProvider } : {}),
        ...(input.fallbackModels ? { fallbackModels: [...input.fallbackModels] } : {}),
        ...(input.routing ? { routing: input.routing } : {}),
        ...(input.executionIntent ? { executionIntent: input.executionIntent } : {}),
        ...(input.template ? { template: input.template } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.toolAllowlist ? { tools: [...input.toolAllowlist], restrictTools: true } : {}),
        context: [
          'automation-manager:visible-agent',
          input.context,
        ].filter((part): part is string => Boolean(part?.trim())).join('\n\n'),
      });
      return record.id;
    },
  });
  const agentKnowledgeStore = new KnowledgeStore({
    configManager,
    dbFileName: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  });
  const homeGraphKnowledgeStore = new KnowledgeStore({
    configManager,
    dbFileName: HOME_GRAPH_KNOWLEDGE_DB_FILE,
  });
  // Memory-governance seams, built EARLY exactly as the SDK's own daemon
  // composition builds them (platform/runtime/services.ts): the knowledge
  // background job and the consolidation scheduler consult the pause
  // controller and the late-bound admission gate below before the
  // MemoryGovernor (constructed + started at the composition tail via
  // wireDaemonMemoryGovernance) drives them. `admitExpensiveWork` is a
  // late-bound closure: until the governor exists, everything is admitted
  // (the process is still booting).
  const cacheRegistry = new CacheRegistry();
  const pauseController = new PauseController();
  // Same job ids as the SDK composition. This fork runs the first two for
  // real; 'code-index-reindex' is registered for contract parity even though
  // this fork's reindex scheduler is permanently disabled (isEnabled: () =>
  // false below), a registered-but-never-scheduled job pauses as a no-op.
  const MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex'];
  const admitExpensiveWorkRef: { current: ((label: string) => { allowed: boolean; reason?: string | undefined }) | null } = { current: null };
  const admitExpensiveWork = (label: string): { allowed: boolean; reason?: string | undefined } =>
    admitExpensiveWorkRef.current?.(label) ?? { allowed: true };
  const isKnowledgeBackgroundPaused = (): boolean => pauseController.isPaused('knowledge-self-improvement');
  const knowledgeSemanticLlm = createProviderBackedKnowledgeSemanticLlm(providerRegistry, {
    timeoutMs: 20_000,
    maxConcurrent: 1,
  });
  const agentKnowledgeSemanticService = new KnowledgeSemanticService(agentKnowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
    isBackgroundPaused: isKnowledgeBackgroundPaused,
    admitExpensiveWork,
  });
  const homeGraphSemanticService = new KnowledgeSemanticService(homeGraphKnowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
    objectProfiles: HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles,
    isBackgroundPaused: isKnowledgeBackgroundPaused,
    admitExpensiveWork,
  });
  const agentKnowledgeService = new KnowledgeService(agentKnowledgeStore, artifactStore, undefined, {
    memoryRegistry,
    runtimeBus: options.runtimeBus,
    semanticService: agentKnowledgeSemanticService,
    admitExpensiveWork,
  });
  agentKnowledgeService.attachRuntimeBus(options.runtimeBus);
  const homeGraphService = new HomeGraphService(homeGraphKnowledgeStore, artifactStore, {
    semanticService: homeGraphSemanticService,
    admitExpensiveWork,
  });
  const projectPlanningProjectId = projectPlanningProjectIdFromPath(workingDirectory);
  const projectPlanningService = new ProjectPlanningService(agentKnowledgeStore, {
    defaultProjectId: projectPlanningProjectId,
  });
  const workPlanStore = new WorkPlanStore({
    homeDirectory,
    // This product's storage scope: the plan lands beside the rest of the
    // Agent's state at <home>/.goodvibes/agent/work-plans/.
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    projectId: projectPlanningProjectId,
    projectRoot: workingDirectory,
  });
  const voiceProviders = new VoiceProviderRegistry();
  ensureBuiltinVoiceProviders(voiceProviders);
  const voiceService = new VoiceService(voiceProviders);

  // Managed local-voice provisioning (voice.local.status/install) AND the
  // wake-word artifact service behind voice.wake.status/provision/model.get.
  //
  // The platform owns all of it: the
  // single-flight install, the ownership-aware preconfigure that never
  // overwrites a genuinely user-set value, the reset of the local engine's
  // tripped failure state after a successful (re-)install, the critical-tier
  // MemoryGovernor admission gate, the live install-progress tracker folded
  // into status() while (and only while) an install runs, and the checksum-
  // pinned wake provisioning the same managed root holds under `wake`.
  const managedVoiceRoot = shellPaths.resolveUserPath('voice');
  const voiceSetup: AgentVoiceSetupService = createVoiceSetupService({
    managedVoiceRoot,
    getConfig: (key) => String(configManager.get(key as never) ?? ''),
    setConfig: (key, value) => configManager.setDynamic(key as never, value),
    resetLocalEngineFailureState: () => { voiceProviders.get('local')?.resetEngineFailureState?.(); },
    admitExpensiveWork,
  });

  agentKnowledgeSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: agentKnowledgeService,
  }));
  homeGraphSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: homeGraphService,
  }));
  const mediaProviders = new MediaProviderRegistry();
  ensureBuiltinMediaProviders(mediaProviders, artifactStore, providerRegistry);
  const multimodalService = new MultimodalService(artifactStore, mediaProviders, voiceService, agentKnowledgeService);
  const channelPolicy = new ChannelPolicyManager({
    storePath: shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'channels', 'policies.json'),
  });
  const distributedRuntime = new DistributedRuntimeManager(
    shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'remote', 'distributed-runtime.json'),
  );
  distributedRuntime.attachRuntime({
    sessionBridge: automationSessionRegister,
    approvalBridge: approvalBroker,
    automationBridge: automationManager,
  });
  const remoteRunnerRegistry = new RemoteRunnerRegistry(agentManager);
  const remoteSupervisor = new RemoteSupervisor(remoteRunnerRegistry);
  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional. isFeatureGateEnabled(null, ...) is permissive by design, so
  // omitting it did not disable managed blocking when
  // security.tokenAudit.enabled is turned off. Threading it preserves current
  // effective behaviour rather than changing it: managed is hardcoded false
  // here (advisory reporting only; excess-scope/overdue tokens are reported,
  // never blocked, regardless of this flag, see isBlocked()'s
  // `this._config.managed && this._managedBlockingEnabled()` guard), the
  // config default for security.tokenAudit.enabled is true, and the
  // token-scope-rotation-audit flag's own defaultState is 'enabled', so with
  // nothing configured the gate reads exactly as before either way.
  const tokenAuditor = new ApiTokenAuditor({ managed: false, featureFlags });
  const componentHealthMonitor = new ComponentHealthMonitor();
  const worktreeRegistry = createDisabledAgentWorktreeRegistry(workingDirectory);
  // Configured and attached to the runtime bus during bootstrap when webhook URLs are present.
  const webhookNotifier = new WebhookNotifier();
  // One shared instance for the process lifetime (mirrors goodvibes-tui's
  // runtime/services.ts); fed from 'focus' tokens in handler-feed.ts and read by
  // the approval-alert wiring in main.ts.
  const focusTracker = new FocusTracker();
  const replayEngine = new DeterministicReplayEngine(workingDirectory);
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker();
  const sessionChangeTracker = new SessionChangeTracker();
  const planManager = new ExecutionPlanManager(workingDirectory);
  const adaptivePlanner = new AdaptivePlanner();
  const idempotencyStore = new IdempotencyStore();
  const channelDeliveryRouter = new ChannelDeliveryRouter({
    configManager,
    secretsManager,
    serviceRegistry,
    artifactStore,
  });
  const executionLedger = new AgentExecutionLedger(options.runtimeBus);
  // Tracks which paths this session's own write/edit tools produced, so the
  // read guard can tell a file the agent just authored from someone else's
  // hidden file (see tools/agent-read-policy.ts).
  const detachSessionWriteLedger = attachAgentSessionWriteLedger(options.runtimeBus);
  // The SDK's foundation/integration contracts still expect a panel manager;
  // the Agent shell has no panel UI (modals replaced it), so we
  // satisfy those contracts with a no-op implementation.
  const NOOP_PANEL_MANAGER = (() => {
    const emptyPane = { panels: [], activeIndex: 0 } as const;
    return {
      getTopPane: () => emptyPane,
      getBottomPane: () => emptyPane,
      getRegisteredTypes: () => [],
      open: () => undefined,
      show: () => {},
    };
  })();
  const panelManager = NOOP_PANEL_MANAGER;
  // Surface-scoped, not the loose workingDirectory/homeDirectory pair. This
  // product declares its own `.goodvibes/<surface>/` root and writes everything
  // through it, and the SDK's two construction scopes are a mutually exclusive
  // union precisely so the choice is deliberate: constructed with the legacy
  // fields, this service's continuity reads, the recovery-file check among them
  //, resolve to the UNSCOPED directories, i.e. to paths nothing in this product
  // has ever written to. It answers, and it answers about the wrong place. The
  // TUI carries the same note on its own construction.
  const integrationHelpers = new IntegrationHelperService({
    surface,
    panelManager,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    configManager,
    getConversationTitle: options.getConversationTitle,
    automationManager,
    approvalBroker,
    sessionBroker: automationSessionRegister,
    distributedRuntime,
    remoteRunnerRegistry,
    remoteSupervisor,
    localUserAuthManager,
    providerRegistry,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
  });
  // Localhost dev-server fetches ride the same broker: ask once, one-tap
  // "allow for this project", persisted as fetch.allowLocalhost.
  // An exec command blocked on a terminal prompt (host-key confirmation,
  // credential ask) rides the same broker: the pending prompt surfaces through
  // every surface's approval machinery and the typed answer feeds the same
  // continuing run. The SDK's own wiring (public since this SDK round): the
  // former agent-local mirror existed only because the builder had no public
  // export path.
  //
  // Both ride the CLIENT raiser now, not this process's own broker: an exec
  // prompt or a localhost fetch ask is a permission ask, and a permission ask
  // leaves this process.
  const announcementStore = new FeatureAnnouncementStore(featureAnnouncementsPath(configManager));
  const promptLifetime = new AbortController();
  disposalScope.registry.add('autonomous tool prompt lifetime', () => promptLifetime.abort());
  const approvalHandlers = createApprovalDerivedHandlers({ requestApproval, configManager, featureFlags, announcementStore,
    autonomousHost: { port: clientFloor.judgment.port, permissionManager, config: configManager, signal: promptLifetime.signal, workspaceTrust: null } });
  const { execPromptAnswerHandler, localhostFetchApproval, onSandboxedRun, sandboxEscalationHandler } = approvalHandlers;
  agentOrchestrator.setDependencies({
    ...approvalHandlers,
    permissionManager,
    agentManager,
    contractRunner,
    contractHooks: contractRunner.hooks(),
    contextAccountingHolder,
    secretsManager,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    execPromptAnswerHandler,
    localhostFetchApproval,
    onSandboxedRun,
    fileCache,
    projectIndex,
    workingDirectory,
    fileUndoManager,
    modeManager,
    processManager,
    agentMessageBus,
    webSearchService,
    channelRegistry: channelPlugins,
    remoteRunnerRegistry,
    knowledgeService: agentKnowledgeService,
    memoryRegistry,
    archetypeLoader,
    configManager,
    providerRegistry,
    providerOptimizer,
    toolLLM,
    serviceRegistry,
    sessionOrchestration,
    featureFlags,
    overflowHandler,
    sandboxSessionRegistry,
    workflowServices: workflow,
  });

  // The public client runtime owns the contract runner and each contract engine.
  // The remaining Agent-local services retain their existing lifetime:
  //   • codeIndexStore      , constructed but neither schema-initialized nor
  //                            auto-built; the Agent runs no repo source-tree
  //                            code index (inert unless explicitly invoked).
  //   • codeIndexReindexScheduler, real-but-inert twin of the above: isEnabled
  //                            is a permanent `() => false`, so tool-driven
  //                            reindex scheduling (Stage B, TUI-only feature)
  //                            never fires for the Agent.
  //   • processRegistry     , fleet observability over the managers the Agent
  //                            already owns (agents, contracts, processes, watchers).
  //   • workspaceCheckpointManager, a runtimeBus (hence automatic turn/agent-
  //                            lifecycle snapshots) is only passed when
  //                            `workingDirectory` is a registered workspace (or
  //                            the unregistered-workspaces override is
  //                            "guarded"); otherwise it stays inert unless
  //                            explicitly invoked. See the construction site
  //                            below for the full registered-workspaces-only
  //                            rule (owner ruling, 2026-07-10).
  // Honest-unpriced: usage prices through the ONE model pricing resolver
  // (manual -> registration -> provider-served -> catalog -> unknown; any
  // resolvable model). Unknown/subscription yields null (costState
  // 'unpriced'), never $0. SHARED by fleet + orchestration so totals never
  // double-count, mirrors the SDK composition root.
  const priceUsage = (model: string | undefined, usage: { inputTokens: number; outputTokens: number }): number | null => (model ? computeUsageCostUsd(providerRegistry.resolveModelPricing(model), usage) : null);

  const codeIndexStore = new CodeIndexStore(
    workingDirectory,
    join(workingDirectory, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'code-index.sqlite'),
    memoryEmbeddingRegistry,
  );
  // Data safety with no discipline: a daily snapshot of every SQLite store
  // this runtime writes, bounded retention, unref'd timers, the SDK's own
  // StoreSnapshotScheduler (public since this SDK round; the former agent-local
  // mirror and its local pruning engine existed only because the class and
  // RetentionPolicy/SnapshotPruner had no public export path). The canonical
  // memory db is shared with the daemon/TUI; the shared snapshot layout means
  // whichever process sweeps first writes that day's copy. The agent's code
  // index is deliberately inert (see the block comment above), its entry is a
  // no-op until a file actually exists.
  const storeSnapshotScheduler = new StoreSnapshotScheduler({
    stores: [
      { name: 'memory store', dbPath: memoryDbPath },
      { name: 'memory vector index', dbPath: resolveMemoryVectorDbPath(memoryDbPath) },
      { name: 'code index store', dbPath: join(workingDirectory, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'code-index.sqlite') },
    ],
  });
  storeSnapshotScheduler.start();
  // Start-time janitor: one retention pass over every registered append-only
  // store (best-effort, mirrors the SDK's own composition root at
  // platform/runtime/services.ts). Every root this composition knows is
  // passed, logDir/telemetryDir resolve to THIS repo's actual on-disk
  // locations (join(workingDirectory, '.goodvibes', 'logs'|'telemetry'), the
  // same root entrypoint.ts's configureActivityLogger already writes
  // activity.md into, NOT the home-scoped shellPaths.resolveUserPath('logs')
  // the SDK's own default composition uses, which would silently sweep a
  // directory nothing here ever writes to). Omitting logDir/telemetryDir
  // would leave the registered activity-log and telemetry-ledger entries
  // skipped on every sweep, same defect class the SDK round fixed at its own
  // call site.
  // MCP servers start when a tool needs one, never at boot. See
  // runtime/mcp-lazy-start.ts: launching the agent used to spawn every server
  // in mcp.json, which on a real machine meant two browser-automation servers
  // (one aimed at a cloud console) starting because someone opened a terminal.
  const lazyMcp = createLazyMcpRegistry(mcpRegistry, shellPaths);

  const appendOnlyRetentionRoots = {
    workingDirectory,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    homeDirectory,
    logDir: shellPaths.resolveProjectPath('logs'),
    telemetryDir: shellPaths.resolveProjectPath('telemetry'),
  };
  const appendOnlyRetentionConfigGet = (key: string): unknown => configManager.get(key as never);
  runtimeOperations.runStartupAppendOnlySweep(appendOnlyRetentionRoots, appendOnlyRetentionConfigGet);
  // ...and again on a cadence for as long as this process lives. A start-time
  // sweep alone never prunes a long-lived process again after boot, which is
  // exactly the window in which these stores grow. Unref'd timers; the host
  // that tears the runtime down stop()s it, same posture as
  // storeSnapshotScheduler.
  const appendOnlyRetentionScheduler = new runtimeOperations.AppendOnlyRetentionScheduler({
    roots: appendOnlyRetentionRoots,
    configGet: appendOnlyRetentionConfigGet,
  });
  appendOnlyRetentionScheduler.start();
  // External config edits apply LIVE through the same subscribe() pipeline an
  // in-process set() uses, a hand-edited settings.json needs no restart to
  // take effect. The underlying file watchers are unref'd, so this can never
  // pin the process open.
  //
  // The watch is STARTED by the client floor (createClientRuntimeServices calls
  // watchConfigFiles() and holds the handle in its own disposal scope). Named
  // here because the poller contract below is all-required and must still be
  // able to stop it: `watchConfigFiles()` returns exactly
  // `() => stopWatchingConfigFiles()`, so this is the same stop, reached
  // through the manager's public method rather than through a handle this
  // composition does not take.
  const stopConfigWatch = (): void => { configManager.stopWatchingConfigFiles(); };
  const codeIndexReindexScheduler = new CodeIndexReindexScheduler({
    target: codeIndexStore,
    workingDirectory,
    isEnabled: () => false,
  });
  // Archive-aware: finished agent/swarm subtrees can be moved out of the
  // live fleet view into a session-scoped archive (SDK fleet/archive.ts).
  // createArchivableFleetRegistry is the shared terminal-shell wrapper over the
  // SDK's withFleetArchive(createProcessRegistry(...)), one named seam both
  // daemon front-ends build the registry through so it cannot drift.
  // Trigger family. Mirrors the SDK factory's own composition: config is a
  // CLOSURE over configManager (so the flag toggles at runtime rather than only
  // at restart) and the process host is ProcessManager-backed, so a supervised
  // on-exit child inherits the same credential-env scrub, live output
  // collection and SIGTERM/SIGKILL watchdog as any other background command.
  const triggerManager = new TriggerManager({
    storePath: shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'triggers.json'),
    config: () => ({
      enabled: configManager.get('watchers.triggers.enabled'),
      backoffLadderMs: configManager.get('watchers.triggers.backoffLadderMs'),
      breakerStrikes: configManager.get('watchers.triggers.breakerStrikes'),
      defaultCheckIntervalMs: configManager.get('watchers.triggers.defaultCheckIntervalMs'),
      probeTimeoutMs: configManager.get('watchers.triggers.probeTimeoutMs'),
      maxConcurrentChecks: configManager.get('watchers.triggers.maxConcurrentChecks'),
      observationRingSize: configManager.get('watchers.triggers.observationRingSize'),
      runHistoryLimit: configManager.get('watchers.triggers.runHistoryLimit'),
      runHistoryTtlHours: configManager.get('watchers.triggers.runHistoryTtlHours'),
      eventLogLimit: configManager.get('watchers.triggers.eventLogLimit'),
      eventLogTtlHours: configManager.get('watchers.triggers.eventLogTtlHours'),
      sweepIntervalMs: configManager.get('watchers.triggers.sweepIntervalMs'),
      supervisionTickMs: configManager.get('watchers.triggers.supervisionTickMs'),
      streamQueueLimit: configManager.get('watchers.triggers.streamQueueLimit'),
      streamBatchLines: configManager.get('watchers.triggers.streamBatchLines'),
      streamBatchIntervalMs: configManager.get('watchers.triggers.streamBatchIntervalMs'),
      onExitMaxDurationMs: configManager.get('watchers.triggers.onExitMaxDurationMs'),
      onExitStdin: configManager.get('watchers.triggers.onExitStdin'),
      outputTailBytes: configManager.get('watchers.triggers.outputTailBytes'),
    }),
    actions: createTriggerActionExecutor({ agents: agentManager, processManager }),
    processHost: createProcessManagerTriggerHost(processManager),
    streamHost: createBunStreamHost(),
    // Answered from the sessions THIS process is running, not from the daemon's
    // register. A trigger scoped to a session this agent is not hosting is not
    // this agent's to fire.
    sessionIsLive: (sessionId: string) => hostedSessions.hosts(sessionId),
  });

  const processRegistry = createArchivableFleetRegistry({
    agentManager,
    contractRunner,
    codeIndexService: codeIndexStore,
    processManager,
    watcherRegistry,
    triggerSupervisor: triggerManager,
    workflow,
    approvalBroker,
    sessionBroker: automationSessionRegister,
    messageBus: agentMessageBus,
    automationManager,
    runtimeBus: options.runtimeBus,
    priceUsage,
  });
  // The fleet a surface can SEE is wider than the fleet it started. The
  // registry above answers for work this process spawned; the daemon runs its
  // own, scheduled jobs, channel-driven runs, work other surfaces submitted,
  // and the union is what the Activity modal reads (client/fleet-union.ts,
  // over the SDK's poll + local-wins merge policy).
  const fleetUnion = createAgentFleetUnion({
    local: { nodes: () => processRegistry.query().nodes },
    verbs: daemonVerbs,
  });
  disposalScope.registry.add('fleet union poller', () => fleetUnion.stop());
  // Root/retention guard options come from the user's `checkpoints.*` settings
  // (see config/checkpoint-settings.ts); any key the user did not set is omitted
  // so the SDK manager applies its own default. These guards are defense in
  // depth UNDER the registered-workspaces-only rule below, not replaced by it:
  // even a registered root can still be refused as too broad or too large.
  //
  // Registered-workspaces-only (owner ruling, 2026-07-10; live-gating extended
  // 2026-07-11 so registering mid-launch takes effect without a restart, the
  // same stale-until-restart defect class fixed for permission-mode metadata).
  // The SDK's WorkspaceCheckpointManager only takes automatic turn/agent-
  // lifecycle snapshots when constructed WITH a runtimeBus (see the SDK's own
  // platform/runtime/services.ts, which always passes one). This composition
  // root ALWAYS passes runtimeBus now (so the automatic-snapshot subscription
  // is live from process start regardless of boot-time registration state),
  // and instead gates each individual automatic snapshot attempt through a
  // LIVE re-check via `checkpointsCurrentlyAllowed` below, patched onto this
  // one manager instance's own `create` method, since the SDK has no built-in
  // predicate hook for this. `checkpointsCurrentlyAllowed` is cheap to call on
  // every event: `createWorkspaceRegistrationLiveChecker` probes the git
  // worktree link ONCE (a `git` subprocess spawn) and every call after that
  // only re-reads the shared registration JSON file. "Allowed" means
  // `workingDirectory` resolves as COVERED by the shared registration store
  // (SDK 1.6.1 platform/workspace/registration, via
  // config/workspace-registration.ts, the successor to this fork's local
  // per-user registry, migrated in once below), or the owner has explicitly
  // opted an unregistered workspace back in via
  // `checkpoints.unregisteredWorkspaces: "guarded"` (config/checkpoint-settings.ts;
  // default "off"). Coverage flows down a registered root's subtree AND
  // through the git worktree→main-repo link, so an orchestration-spawned
  // worktree of a registered repo checkpoints automatically without being
  // registered itself. A workspace SWAP at runtime is still not tracked here
  // (WorkspaceSwapManager's rerootStores does not re-root this manager; a swap
  // needs a restart to pick up a new root's registration), only the
  // registration STATE of this fixed workingDirectory is now live.
  const registrationMigration = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
  if (registrationMigration) {
    logger.info('Migrated the local workspace registry into the shared registration store', { ...registrationMigration });
  }
  // After the import migration (records now in the shared store), stamp the ones
  // that came from the agent's OWN explicit list as checkpoint-eligible, so the
  // eligibility boundary below does not retroactively drop workspaces the owner
  // had already opted into checkpoints. Runs once (receipt-gated); derives the
  // explicit set from the still-present legacy registry file. Records lacking the
  // flag (a TUI first-open self-record) stay ineligible, the boundary the owner
  // ruled stays explicit.
  const eligibilityBackfill = backfillCheckpointEligibilityIfNeeded(shellPaths);
  if (eligibilityBackfill && eligibilityBackfill.recordsStamped > 0) {
    logger.info('Marked the agent\'s explicitly-registered workspaces checkpoint-eligible', { ...eligibilityBackfill });
  }
  const checkpointsRegistrationStatus = createWorkspaceRegistrationLiveChecker(shellPaths, workingDirectory);
  const checkpointsCurrentlyAllowed = (): boolean =>
    checkpointsRegistrationStatus() === 'covered' || readCheckpointRegistrationSetting(configManager) === 'guarded';
  const workspaceCheckpointManager = new WorkspaceCheckpointManager({
    workspaceRoot: workingDirectory,
    ...readCheckpointGuardSettings(configManager),
    // Resolves the checkpoint git store to surface.checkpointsDir
    // (<workingDirectory>/.goodvibes/agent/checkpoints) instead of the legacy,
    // surface-unaware <workspaceRoot>/.goodvibes/checkpoints, which the TUI
    // and Agent would otherwise SHARE when run against the same working
    // directory. Fixed to the surface's own workingDirectory regardless of
    // preferGitRoot; readCheckpointGuardSettings may still override via an
    // explicit checkpointDir, which the SDK's own resolution order respects
    // over this surface default. The SDK migrates the legacy checkpoint dir
    // into this scoped location automatically on first surface use.
    surface,
    runtimeBus: options.runtimeBus,
    // Stamp automatic snapshots with the live session id so a checkpoint created
    // during this launch is found by the session-scoped restore/rewind lookup,
    // the fix that makes same-launch activation work without a restart. The
    // resolver is consulted at each lifecycle event, so it tracks the current
    // session even though the id is finalized after this manager is built.
    ...(options.resolveSessionId ? { resolveSessionId: options.resolveSessionId } : {}),
  });
  // Gate AUTOMATIC snapshots (kind 'turn' | 'agent-run', fired internally by
  // the manager's own bus subscription via `this.create(...)`) on the live
  // registration check, by overriding this instance's own `create` method,
  // the manager has no predicate-hook option, and this is the one seam that
  // every automatic-snapshot call and every explicit caller both go through.
  // 'manual' (explicit, gateway-invoked) creates are NOT re-gated here: they
  // already go through checkpointsGatewayManager.create's own live check
  // below, which throws an actionable message BEFORE ever reaching this
  // method, this override would just be a silent, redundant pass for that
  // path. For an automatic snapshot there is no caller to throw to (the
  // manager's own subscription callbacks only `.catch()`-log a rejection), so
  // an automatic attempt against an unregistered/un-guarded workspace resolves
  // to `null` quietly, the same "cheap no-op" contract `create()` already
  // documents for an unchanged tree, not a new error path.
  const originalCreateCheckpoint = workspaceCheckpointManager.create.bind(workspaceCheckpointManager);
  workspaceCheckpointManager.create = ((opts) => {
    if (opts.kind !== 'manual' && !checkpointsCurrentlyAllowed()) return Promise.resolve(null);
    return originalCreateCheckpoint(opts);
  }) as typeof workspaceCheckpointManager.create;
  // Eagerly initialize so the automatic snapshot subscription is wired up
  // immediately (mirrors the SDK's own default runtime services) rather than
  // only on first explicit checkpoints.* call, otherwise the very first
  // TURN_COMPLETED could arrive before anything has touched the manager. Now
  // unconditional (previously skipped for an unregistered-at-boot workspace):
  // the subscription itself is inert-by-gate rather than inert-by-absence, so
  // a workspace registered mid-launch starts producing automatic snapshots on
  // the very next eligible event, with no restart needed to (re)wire the bus.
  void workspaceCheckpointManager.init().catch((err) => {
    logger.warn('WorkspaceCheckpointManager.init failed', { error: err instanceof Error ? err.message : String(err) });
  });
  // Explicit user-invoked checkpoint creation (the ws-only `checkpoints.create`
  // gateway verb) is gated the SAME way: refuse with an actionable hint rather
  // than silently registering the workspace on the caller's behalf. This is
  // the chosen policy for the pending owner ruling (the alternative,
  // register-and-proceed, was NOT chosen, to keep "create a checkpoint" from
  // having a side effect the caller did not ask for). list/diff/restore/
  // sessionChanges are read/restore operations over checkpoints that may
  // already exist (e.g. from a since-unregistered workspace) and are left
  // unrestricted here.
  // The explicit-create gate: the manager the CALLERS in this process go
  // through. The daemon serves `checkpoints.*` for every surface, including this
  // one; what this gate covers is a create issued HERE, by a slash command or a
  // tool, which refuses an unregistered workspace with an actionable message
  // rather than registering it on the caller's behalf. Exposed on the graph so
  // those callers reach the GATED create rather than the raw manager beside it.
  const checkpointsGatewayManager: Pick<WorkspaceCheckpointManager, 'list' | 'create' | 'diff' | 'restore' | 'sessionChanges' | 'workspaceRoot'> = {
    workspaceRoot: workspaceCheckpointManager.workspaceRoot,
    list: workspaceCheckpointManager.list.bind(workspaceCheckpointManager),
    diff: workspaceCheckpointManager.diff.bind(workspaceCheckpointManager),
    restore: workspaceCheckpointManager.restore.bind(workspaceCheckpointManager),
    sessionChanges: workspaceCheckpointManager.sessionChanges.bind(workspaceCheckpointManager),
    create: (opts) => {
      // Re-reads the registry and setting live via the same cheap checker the
      // automatic-snapshot gate above uses, so registering the workspace via
      // `goodvibes-agent workspaces register` takes effect for the NEXT
      // explicit create call (same as it always has), and, as of the live
      // gate above, for automatic snapshots too, without a restart either way.
      if (!checkpointsCurrentlyAllowed()) {
        throw new Error(
          `Checkpoints are off for this workspace: ${workingDirectory} is not registered. `
          + 'Register it first, then retry: goodvibes-agent workspaces register --yes '
          + '(or set checkpoints.unregisteredWorkspaces to "guarded" to opt this workspace out of the registration gate).',
        );
      }
      // Default the session stamp from the live resolver when the caller omits it
      // (the resolveSessionId hook only auto-stamps AUTOMATIC snapshots, not
      // explicit create calls). Without this, an explicit checkpoint made this
      // launch would be written unstamped and excluded by the session-scoped
      // restore lookup, the same same-launch activation gap the resolver closes
      // for automatic snapshots. An explicitly supplied sessionId always wins.
      const sessionId = opts.sessionId ?? options.resolveSessionId?.({});
      return workspaceCheckpointManager.create(sessionId ? { ...opts, sessionId } : opts);
    },
  };

  // Idle-time + slow-schedule memory consolidation, constructed the way the
  // SDK's own RuntimeServices composition root constructs it (platform/
  // runtime/services.ts: `new MemoryConsolidationScheduler({ memoryRegistry,
  // configSource: configManager, isIdle: ... })`), replacing this repo's
  // retired local scheduler/wiring/receipt-store trio. Every run's receipt
  // renders through the SAME attach-time-notice idiom the connected-host
  // receipts use (daemonReceiptFeed below), a dedicated feed instance so a
  // local consolidation run is never mislabeled "[Connected host]".
  const memoryConsolidationReceiptFeed = new AgentDaemonReceiptFeed();
  const memoryConsolidationScheduler = new MemoryConsolidationScheduler({
    memoryRegistry,
    configSource: configManager,
    // Idle AND not paused by the governor AND admitted at the current memory
    // tier, memory pressure defers consolidation (mirrors the SDK's own
    // daemon composition of this same scheduler).
    isIdle: () => hostedSessions.countBusySessions() === 0
      && !pauseController.isPaused('memory-consolidation')
      && admitExpensiveWork('memory consolidation').allowed,
    onReceipt: (receipt: MemoryConsolidationRunReceipt) => {
      const summary = describeMemoryConsolidationReceipt(receipt);
      if (summary) memoryConsolidationReceiptFeed.push([{ id: receipt.runId, text: summary, at: Date.now() }]);
    },
  });
  memoryConsolidationScheduler.start();

  // Sleep ownership (SDK round: power/*). Constructed exactly as the SDK
  // composition root does: readConfig/writeConfig over the live ConfigManager,
  // runtimeBus bound so real work (a running turn, an active agent, a
  // due schedule) automatically holds the inhibitor, sleep-edge hooks that
  // checkpoint the store snapshots on sleep and catch consolidation + store
  // snapshots + heartbeat back up on wake.
  const powerManager = wireRuntimePower({
    // Non-spawning default: without an explicit opt-in the seam is the SDK's
    // honest "unavailable" seam, NOT the spawning host seam that
    // wireRuntimePower would otherwise pick for an undefined seam. This keeps
    // every test-constructed runtime (and one-shot CLI subcommands) from
    // spawning systemd-inhibit inhibitors or a dbus-monitor sleep-edge watcher.
    // Only the real long-lived composition that owns the sleep edge, the
    // embedded interactive runtime in bootstrap-core.ts, passes
    // powerSeam: createHostPowerSeam() to hold a LOCAL OS inhibitor for
    // keep-awake / idle-inhibit while the process lives. Pinned by
    // power-keep-awake-composition.test.ts.
    seam: options.powerSeam ?? createUnavailablePowerSeam('runtime services constructed without a host power seam'),
    readConfig: (key) => configManager.get(key as never),
    writeConfig: (key, value) => configManager.setDynamic(key as never, value),
    // Live-apply straight from the SDK's own PowerManager (SDK round: the
    // config live-apply is SDK-side now, see manager.ts's
    // unsubscribeKeepAwakeConfig). A power.keepAwake change from ANY origin
    // (settings modal, CLI flag, or an external settings.json edit reaching
    // configManager via watchConfigFiles()) flips this process's real
    // inhibitor with no bespoke onSettingApplied special case needed,
    // ui-openers.ts's former manual `powerManager.setKeepAwake(...)` call is
    // retired in favor of this.
    subscribeConfig: (key, cb) => configManager.subscribe(key as never, (newValue) => cb(newValue)),
    runtimeBus: options.runtimeBus,
    sleepCheckpoint: () => storeSnapshotScheduler.tick(),
    wakeCatchUp: [
      () => memoryConsolidationScheduler.tick(),
      () => storeSnapshotScheduler.tick(),
    ],
  });
  // DAEMON-held reach: this process's own PowerManager above holds a LOCAL
  // inhibitor that releases the moment this agent exits, the opposite of
  // "survives surfaces closing". power.keepAwake is a surface-local config
  // key (see shared-config-tier.ts, only tts.* rides the shared tier), so a
  // local config write never reaches an externally-adopted daemon's own
  // config file; the only way to reach a durable, out-of-process hold is to
  // forward the toggle explicitly over the wire whenever a daemon is
  // reachable right now (the same adoption signal the memory/session spine
  // already use). Best-effort and silent on failure beyond a warn log, a
  // down or incompatible daemon must never break the local settings-modal
  // apply this rides alongside.
  configManager.subscribe('power.keepAwake', (newValue, oldValue) => {
    if (newValue === oldValue) return;
    void forwardKeepAwakeToAdoptedDaemon(newValue, {
      probeReachability: () => sessionSpineClient.probeReachability(),
      resolveConnection: spineResolveConnection,
    }).then((outcome) => {
      if (outcome.attempted && !outcome.result.ok) {
        logger.warn('[power] keep-awake daemon forward failed', { error: outcome.result.error, kind: outcome.result.kind });
      }
    }).catch((error) => {
      logger.warn('[power] keep-awake daemon forward failed', { error: summarizeError(error) });
    });
  });

  // Memory governance: construct + START the MemoryGovernor (default ON, it
  // is a safety feature) with REAL cache adapters, exactly as the SDK's own
  // daemon composition does (platform/runtime/services.ts, via the same
  // public wireDaemonMemoryGovernance). Registered caches: this fork's two
  // knowledge stores (job-run history pruning is the real reclaim) and the
  // session register automation runs on (GC + bucket truncation). Registered
  // pausable jobs: MEMORY_BACKGROUND_JOB_IDS (declared with the early seams
  // above).
  const { memoryGovernor } = wireDaemonMemoryGovernance({
    config: {
      budgetMb: configManager.get('memory.budgetMb'),
      elevatedPct: configManager.get('memory.tier.elevatedPct'),
      highPct: configManager.get('memory.tier.highPct'),
      criticalPct: configManager.get('memory.tier.criticalPct'),
      tripwireRateMbPerSec: configManager.get('memory.tripwire.rateMbPerSec'),
      tripwireSustainSec: configManager.get('memory.tripwire.sustainSec'),
      hardLimitPct: configManager.get('memory.hardLimitPct'),
    },
    runtimeBus: options.runtimeBus,
    cacheRegistry,
    pauseController,
    jobIds: MEMORY_BACKGROUND_JOB_IDS,
    receiptPath: shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory', 'tripwire-receipt.json'),
    // This fork's knowledge stores: the compatibility `knowledgeService`
    // alias points at agent knowledge (no separate regular store exists
    // here), so the real set is agent + home-graph.
    knowledgeStores: [agentKnowledgeStore, homeGraphKnowledgeStore],
    // The register kept for automation is a real retained cache with a real
    // trim, so it stays registered with the governor. It is the same instance
    // automation runs on, one broker, one cache adapter, not a second copy
    // registered for the look of it.
    sessionBroker: automationSessionRegister,
    // Graceful tripwire shutdown flushes in-flight state via ASYNC store
    // snapshots, same as the SDK composition: sync copies on a stalled disk
    // would block the event loop and defeat the governor's 10s shutdown
    // ceiling.
    onTripwireShutdown: async () => { await storeSnapshotScheduler.snapshotAllAsync('tripwire'); },
  });
  // Late-bind the admission gate now that the governor exists: the expensive
  // entry points (knowledge services, consolidation scheduler, voice install)
  // captured `admitExpensiveWork` earlier via this holder.
  admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label);

  // The conversation half of unified rewind, offered rather than served.
  //
  // `rewind.plan`/`apply` with scope 'conversation' or 'both' can only be
  // answered by the process running the loop, and that is this one. It used to
  // be wired as a HANDLER on a catalog nothing could call, which meant the
  // daemon, asked to plan a rewind for a session hosted here, answered
  // "0 messages to drop" from its own empty registry: a confident answer to a
  // question it could not reach.
  //
  // Now this process OFFERS the conversation and the daemon asks it. The host
  // client below holds a long poll on `rewind.conversation.requests.take` and
  // answers from the same live per-session registry
  // (`createSessionConversationRewindPort`) the old handler read; a question
  // about a session this process is not holding is answered `unavailable` with
  // the reason, never zero. Started on the hosted session at bootstrap and
  // released at shutdown (see bootstrap.ts).
  const conversationRewindHost = createConversationRewindHost({
    verbs: daemonVerbs,
    port: createSessionConversationRewindPort(),
    hosts: (sessionId) => hostedSessions.hosts(sessionId),
    label: 'GoodVibes Agent',
  });
  // Turn the fleet registry's coalesced snapshot tick into poll-free
  // spawn/progress/attention/completion events on the runtime event bus's
  // 'fleet' domain (SDK 1.6.1, runtime/fleet/emit-bridge.ts), the SDK's own
  // doc note on this bridge: "The control-plane gateway already fans every
  // runtime-bus domain out to subscribed SSE/WebSocket clients, so no
  // gateway/channel change is needed once the fleet domain exists." Without
  // this call the fleet.* gateway verbs above still answer pull queries
  // (fleet.snapshot/fleet.list), but nothing pushes live deltas, a webui
  // FleetView watching this agent's orchestrator-spawned sub-agents would see
  // them only on manual refresh, never their attention state flipping to
  // needs-input in real time. No unsubscribe is kept: the bridge is meant to
  // live for the registry's lifetime (same non-disposed pattern as the
  // fleet/push verb registrations just above; see the SDK's own doc comment
  // on attachFleetEmitBridge).
  attachFleetEmitBridge({ registry: processRegistry, bus: options.runtimeBus });

  // The relay step-up ceremony service the SDK's RuntimeServices requires (and
  // the daemon facade dereferences at start). Constructed exactly as the SDK
  // composition root does, from the public @goodvibes-jev/engine/sdk/daemon export.
  const stepUpService = new StepUpService({ secrets: secretsManager });

  // Teardown for every poller started above. This fork composes no DaemonServer
  //, it hands its graph to one, and the SDK's ownership rule leaves a
  // caller-supplied graph alone, so dispose() below is the ONLY thing that
  // stops these, and the shutdown paths (runtime/bootstrap-shutdown.ts,
  // cli/management.ts, cli/bundle-command.ts) are the ones that must call it.
  const disposeSessionWriteLedgerOnce = (): void => { detachSessionWriteLedger(); clearAgentSessionWrites(); };
  registerRuntimePollers(disposalScope.registry, {
    stopConfigWatch, watcherRegistry, storeSnapshotScheduler, appendOnlyRetentionScheduler,
    memoryConsolidationScheduler, codeIndexReindexScheduler, sessionOrchestration,
    // This fork has no separate regular knowledge store: the `knowledgeService`
    // compatibility alias points at isolated Agent Knowledge (pinned by
    // scripts/check-architecture.ts), so both slots are the same instance.
    // KnowledgeService.dispose() clears its schedule-timer map, disposing it
    // twice is a no-op, not a double-free.
    knowledgeService: agentKnowledgeService, agentKnowledgeService,
    contractRunner, processRegistry, memoryGovernor, triggerManager,
    // Named here rather than registered separately below: RuntimePollerOwners
    // is all-required precisely so a poller cannot be forgotten, and this fork
    // had been registering the home-graph service by hand where the contract
    // could not see it.
    homeGraphService, agentOrchestrator,
    // By dispose() time the registries and bus these runs report through are
    // already down, so a run still described as "running" is orphaned rather
    // than preserved, and this is the only shutdown-reachable way to abort its
    // in-flight provider call instead of letting it sleep out a retry backoff.
    cancelHostedAgentRuns: () => cancelAllAgentRuns(agentManager),
  });
  // Owners this product has that the SDK's composition does not. The
  // session-spine client's keepalive is graph-owned even though the interactive
  // shutdown path also closes it by session id first, dispose() is idempotent,
  // and registering here is what covers the CLI paths that have no such path.
  disposalScope.registry.add('session spine client', () => sessionSpineClient.dispose());
  disposalScope.registry.add('session write ledger', disposeSessionWriteLedgerOnce);
  // The client seams that started something. Each is idempotent; the rewind
  // host's release is fire-and-forget here because a dispose() is synchronous
  // and a daemon that never hears the release simply lets the lease lapse.
  disposalScope.registry.add('inbound session dispatch', () => sessionDispatch.stop());
  disposalScope.registry.add('conversation rewind host', () => { void conversationRewindHost.stop(); });
  disposalScope.registry.add('hosted session registry', () => hostedSessions.dispose());
  // The two installed routing clients go down with the graph that installed
  // them. They are process-wide by design (five settings writers reach them
  // without a graph in scope), and process-wide state that outlives its owner is
  // how a torn-down runtime keeps answering for a live one.
  disposalScope.registry.add('daemon settings routing', () => {
    installAgentDaemonCredentialsClient(null);
    installAgentDaemonConfigClient(null);
  });

  const graph: RuntimeServices = {
    asDaemonGradeView: (): SdkRuntimeServices => ({
      ...graph,
      sessionBroker: automationSessionRegister,
      // The client floor builds this through `createUserPermissionRuleStore`,
      // so the OBJECT is the concrete store; the client shape names it by the
      // narrow `UserPermissionRuleAccess` (read the rules, add one) because that
      // is all a surface owes. The daemon-grade view asks for the concrete
      // class, so the widening is stated here rather than by keeping a second
      // store over the same file, a second writer of one file is how two
      // answers to the same question start.
      userPermissionRuleStore: userPermissionRuleStore as ReturnType<typeof runtimeComposition.createUserPermissionRuleStore>,
      get pairingTokens(): PairingTokenManager { return pairingTokensForDaemonGradeView(); },
    }),
    // The REAL SDK memory-governance instances composed above (governor
    // constructed + started by wireDaemonMemoryGovernance). The SDK's
    // DaemonServer facade (facade-composition.ts) genuinely consumes these
    // when this repo hands its RuntimeServices to it, e.g. it registers the
    // control-plane event-replay ring onto cacheRegistry.
    memoryGovernor,
    cacheRegistry,
    pauseController,
    stepUpService,
    workingDirectory,
    homeDirectory,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    surface,
    shellPaths,
    configManager,
    featureFlags,
    contextAccountingHolder,
    codeIndexStore,
    codeIndexReindexScheduler,
    storeSnapshotScheduler,
    appendOnlyRetentionScheduler,
    userPermissionRuleStore,
    processRegistry,
    fleetUnion,
    workspaceCheckpointManager,
    guardedCheckpoints: checkpointsGatewayManager,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    runtimeDispatch,
    panelManager,
    keybindingsManager,
    routeBindings,
    surfaceRegistry,
    channelPlugins,
    channelDeliveryRouter,
    watcherRegistry,
    triggerManager,
    approvalBroker,
    approvalsView,
    localhostFetchApproval,
    featureAnnouncementStore: announcementStore,
    onSandboxedRun,
    execPromptAnswerHandler,
    sandboxEscalationHandler,
    // The client shape's dispatch seam. The register automation still needs
    // rides beside it under its own name, so nothing reads one and gets the
    // other.
    sessionBroker: sessionDispatch,
    automationSessionRegister,
    requestApproval,
    permissionPromptRef,
    permissionManager,
    hostedSessions,
    hostedHandoff,
    daemonVerbs,
    resolveConnectedHost: () => resolveConnectedHostConnection(connectedHostAccess),
    daemonConfigClient,
    daemonCredentialsClient,
    devicesClient,
    conversationRewindHost,
    fileCache,
    projectIndex,
    sessionSpineClient,
    sessionSpine: sessionSpineClient,
    daemonReceiptFeed,
    consumeDaemonReceipts,
    mayAdoptDaemonBuild,
    memoryConsolidationReceiptFeed,
    memoryConsolidationScheduler,
    powerManager,
    sessionLiveTurnControls,
    deliveryManager,
    automationManager,
    gatewayMethods,
    artifactStore,
    knowledgeService: agentKnowledgeService,
    agentKnowledgeService,
    homeGraphService,
    projectPlanningService,
    projectPlanningProjectId,
    workPlanStore,
    memoryStore,
    memoryRegistry,
    memorySpineClient,
    memoryAccess: memorySpineClient,
    memorySpineTransport,
    serviceRegistry,
    secretsManager,
    subscriptionManager,
    localUserAuthManager,
    profileManager,
    bookmarkManager,
    sessionManager,
    sessionOrchestration,
    hookDispatcher,
    hookActivityTracker,
    hookWorkbench,
    pluginManager,
    workflow,
    voiceProviders,
    voiceService,
    voiceSetup,
    webSearchProviders,
    webSearchService,
    mediaProviders,
    multimodalService,
    memoryEmbeddingRegistry,
    channelPolicy,
    mcpRegistry: lazyMcp.registry,
    tokenAuditor,
    componentHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
    webhookNotifier,
    focusTracker,
    replayEngine,
    providerOptimizer,
    providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    providerRegistry,
    toolLLM,
    distributedRuntime,
    remoteRunnerRegistry,
    remoteSupervisor,
    sessionMemoryStore,
    sessionLineageTracker,
    sessionChangeTracker,
    planManager,
    adaptivePlanner,
    idempotencyStore,
    overflowHandler,
    policyRuntimeState,
    archetypeLoader,
    agentManager,
    agentMessageBus,
    agentOrchestrator,
    contractRunner,
    contractOperator,
    contractIntake,
    judgment: clientFloor.judgment,
    sessionSnapshot: (sessionId, conversation) => ({ ...conversation, contracts: contractRunner.list({ sessionId, includeTerminal: true }) }),
    processManager,
    modeManager,
    fileUndoManager,
    executionLedger,
    // Kept as its own member because the interactive shutdown path detaches the
    // ledger at a specific point in its ordering, well before the graph goes
    // down. It is the SAME closure the disposal scope holds, so the two are one
    // mechanism rather than two: whichever runs first does the work, the other
    // is a no-op.
    disposeSessionWriteLedger: disposeSessionWriteLedgerOnce,
    dispose: (): void => disposalScope.dispose(),
    integrationHelpers,
    async rerootStores(newWorkingDir: string): Promise<void> {
      await projectIndex.reroot(newWorkingDir);
    },
  };
  return graph;
}

/**
 * Fold the agent's legacy per-surface memory store into the canonical
 * cross-surface store. Called once at boot AFTER `memoryStore.init()` so any records
 * written before unification survive. Id-keyed and idempotent, a re-run imports
 * nothing new and never deletes the legacy file. Returns the report so boot can log
 * exactly what moved (nothing is silently dropped).
 */
export async function foldAgentLegacyMemory(
  memoryStore: MemoryStore,
  memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry,
  shellPaths: ShellPathService,
): Promise<MemoryFoldReport> {
  const legacyAgentGlobal = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.sqlite');
  const sources: LegacyMemorySource[] = [
    { label: 'agent-global (pre-E6)', dbPath: legacyAgentGlobal },
  ];
  return foldMemoryStores(memoryStore, sources, { embeddingRegistry: memoryEmbeddingRegistry });
}
