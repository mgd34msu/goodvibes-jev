import type { BrowserJudgmentService } from '@goodvibes-jev/engine/sdk/platform/judgment-browser';
/**
 * runtime-services-types.ts, the public contract createRuntimeServices() takes
 * and returns.
 *
 * Split out of services.ts (the composition root that builds every one of
 * these fields) so the construction logic can stay under the repo's
 * architecture line-count gate without trimming 35 arbitrary lines to clear
 * the number. This module owns ONLY the shape of the input options and the
 * output surface, no runtime code, no wiring order, nothing that constructs
 * anything. services.ts re-exports both types from here, so no import site
 * anywhere else in the app had to change.
 */

import type { ConfigManager, ServiceRegistry, SubscriptionManager, ToolLLM } from '@goodvibes-jev/engine/sdk/platform/config';
import type { SecretsManager } from '../config/secrets.js';
import type { AutomationDeliveryManager, AutomationManager } from '@goodvibes-jev/engine/sdk/platform/automation';
import type { ChannelDeliveryRouter, ChannelPolicyManager, ChannelPluginRegistry, RouteBindingManager, SurfaceRegistry } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { ApprovalBroker, GatewayMethodCatalog, SessionLiveTurnControlsHolder, SharedSessionBroker } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { PowerManager } from '@goodvibes-jev/engine/sdk/platform/power';

import type { StepUpService } from '@goodvibes-jev/engine/sdk/daemon';
import type { PairingTokenManager } from '@goodvibes-jev/engine/sdk/platform/pairing';
import type { WatcherRegistry } from '@goodvibes-jev/engine/sdk/platform/watchers';
import type { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { HomeGraphService, KnowledgeService, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import type { MultimodalService } from '@goodvibes-jev/engine/sdk/platform/multimodal';
import type { AgentMessageBus, AgentOrchestrator, ArchetypeLoader } from '@goodvibes-jev/engine/sdk/platform/agents';
import type { AgentManager, ContextAccountingHolder, OverflowHandler, ProcessManager, WorkflowServices } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { FileUndoManager, MemoryConsolidationScheduler, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, ModeManager, ProjectIndex, CodeIndexStore, CodeIndexReindexScheduler } from '@goodvibes-jev/engine/sdk/platform/state';
import type { StoreSnapshotScheduler } from '@goodvibes-jev/engine/sdk/platform/state/store-snapshots';
import type { PermissionManager, UserPermissionRuleStore } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { buildExecPromptAnswerHandler } from '@goodvibes-jev/engine/sdk/platform/runtime/permissions/exec-prompt-wiring';
import type { buildLocalhostFetchApproval } from '@goodvibes-jev/engine/sdk/platform/runtime/permissions/localhost-fetch-approval';
import type { operations } from '@goodvibes-jev/engine/sdk/platform/runtime';
import type { MemorySpineClient } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import type { WorkspaceCheckpointManager } from '@goodvibes-jev/engine/sdk/platform/workspace';
import type { DomainDispatch, RuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import type { DevicePostureRuntime } from '@goodvibes-jev/engine/sdk/platform/devices';
import type { RuntimeEventBus, DistributedRuntimeManager, RemoteRunnerRegistry, RemoteSupervisor, IntegrationHelperService, PanelManagerLike, KeybindingsManagerLike, IdempotencyStore, ComponentHealthMonitor, WorktreeRegistry, SandboxSessionRegistry, ShellPathService, FeatureFlagManager, PolicyRuntimeState, SessionSurface } from './index.js';
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes-jev/engine/sdk/platform/voice';
import type { CacheRegistry, PauseController, MemoryGovernor } from '@goodvibes-jev/engine/sdk/platform/runtime/memory';
import type { WebSearchProviderRegistry, WebSearchService } from '@goodvibes-jev/engine/sdk/platform/web-search';
import type { HookActivityTracker } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { HookDispatcher, HookWorkbench } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { PluginManager } from '@goodvibes-jev/engine/sdk/platform/plugins';
import type { BookmarkManager } from '@goodvibes-jev/engine/sdk/platform/bookmarks';
import type { ProfileManager } from '@goodvibes-jev/engine/sdk/platform/profiles';
import type { SessionManager, CrossSessionTaskRegistry, SessionChangeTracker } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { ApiTokenAuditor, UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import type { WebhookNotifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import type { BenchmarkStore, CacheHitTracker, FavoritesStore, ModelLimitsService, ProviderCapabilityRegistry, ProviderOptimizer, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { AdaptivePlanner, DeterministicReplayEngine, ExecutionPlanManager, SessionLineageTracker, SessionMemoryStore } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ArchivableProcessRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import type { WorkPlanStore } from '@goodvibes-jev/engine/sdk/platform/workflow';
import type { WorkLedgerService } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import type { DaemonHandlerSurfaces } from '../daemon/handlers/index.js';
import type { ClusterGroupComposition } from './cluster-group-composition.js';
import type { ClusterCoordinator } from '@goodvibes-jev/engine/sdk/platform/cluster';

import type { ContractRunner, ContractOperatorService } from '@goodvibes-jev/engine/sdk/platform/contract';
import type { JudgmentServices } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { SessionSnapshot } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';
import type { TriggerManager } from '@goodvibes-jev/engine/sdk/platform/triggers';
import type { DaemonBootController, DaemonBootOperations } from './boot-tasks.js';

export interface RuntimeServicesOptions {
  readonly capturedBunRuntimeExecutable?: string | undefined;
  /**
   * Explicit boot composition, constructed synchronously without starting its
   * operations. The entrypoint starts the returned controller after the facade
   * initializes memory. No production default is installed until the live
   * notification privacy and awaited webhook lifetime dependencies are ready.
   */
  readonly createBootOperations?: ((services: RuntimeServices) => DaemonBootOperations) | undefined;
  /** Explicit server-side installation. Receives this graph's recorded port, never browser credentials. */
  readonly createBrowserJudgment?: ((judgment: JudgmentServices) => BrowserJudgmentService) | undefined;
  /** Required explicit composition until built-in inbox migration is complete. */
  readonly inboxFactory: DaemonInboxFactory;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager: ConfigManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly featureFlags?: FeatureFlagManager;
  readonly getConversationTitle?: () => string | undefined;
  readonly workingDir: string;
  readonly homeDirectory: string;
  /**
   * The daemon's state root when the host was told one (`--daemon-home`,
   * `GOODVIBES_DAEMON_HOME`); absent ⇒ `<homeDirectory>/.goodvibes/daemon`.
   * Threaded into `SecretsManager` so the override MOVES the daemon-scoped
   * credential store; without it a daemon told to run out of a temp tree still
   * read the real home's daemon secrets, so an "isolated" test daemon held the
   * owner's live credentials. One name for one thing, `resolveGoodVibesHomeOwnership`
   * is the single reader that produces it.
   */
  readonly daemonHomeDirectory?: string | undefined;
  /** Opt-in (daemon-side only): fold host-observed external coding-agent sessions
   * into the fleet as 'observed-external' rows. Interactive leaves it off and reads
   * the daemon snapshot. Mirrors the SDK's own createRuntimeServices option. */
  readonly observeExternalAgents?: boolean | undefined;
  /** Host power seam opt-in. Left out, the SDK's idle-power wiring falls back to
   * the non-spawning unavailable seam; the daemon entrypoint passes the real
   * host seam, which is what starts systemd-inhibit and the sleep-edge watcher. */
  readonly powerSeam?: operations.IdlePowerServicesDeps['powerSeam'];
  /** Live session id, read per crash-residue sweep so the running session is exempt. */
  readonly currentSessionId?: (() => string | null) | undefined;
  /**
   * Wake-word boot provisioning opt-in. Same shape as `powerSeam`: the real
   * entrypoint (`daemon/cli.ts`) asks for it, the one-shot CLI commands do
   * not, and a test composing this graph gets neither a network fetch nor an
   * hourly sweep it did not ask for.
   */
  readonly provisionWakeModelsAtBoot?: boolean | undefined;
}

export interface RuntimeServices {
  /** Absent when the host did not supply the pending product boot composition. */
  readonly bootTasks?: DaemonBootController | undefined;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /**
   * The `.goodvibes/<surface root>/` segment this daemon's own state lives
   * under, always GOODVIBES_DAEMON_SURFACE_ROOT here (config/surface.ts).
   * Declared so a consumer ASKS for it instead of deriving a second one; the
   * unscoped pre-split control-plane store is what deriving it twice produced.
   */
  readonly surfaceRoot: string;
  /** The declare-once session-storage handle every session reader and writer threads through. */
  readonly surface: SessionSurface;
  readonly shellPaths: ShellPathService;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeDispatch: DomainDispatch;
  /** No-op stand-ins: the facade's contract names them, and the daemon has no screen. */
  readonly panelManager: PanelManagerLike;
  readonly keybindingsManager: KeybindingsManagerLike;
  readonly routeBindings: RouteBindingManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly channelDeliveryRouter: ChannelDeliveryRouter;
  readonly watcherRegistry: WatcherRegistry;
  readonly approvalBroker: ApprovalBroker;
  /** Loopback-fetch approval that rides the approval broker; shared by the tool registry and orchestrator so every surface asks the same way. */
  readonly localhostFetchApproval: ReturnType<typeof buildLocalhostFetchApproval>;
  /** Terminal prompt-answer handler that rides the approval broker; shared by the tool registry and orchestrator so an interactive command's prompt gets an ask/card on every surface. */
  readonly execPromptAnswerHandler: ReturnType<typeof buildExecPromptAnswerHandler>;
  /** Durable user-origin permission rules (remembered approvals); permissions.rules.* surface. Mirrors the SDK composition. */
  readonly userPermissionRuleStore: UserPermissionRuleStore;
  readonly sessionBroker: SharedSessionBroker;
  readonly deliveryManager: AutomationDeliveryManager;
  readonly automationManager: AutomationManager;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly artifactStore: ArtifactStore;
  readonly knowledgeService: KnowledgeService;
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  readonly workPlanStore: WorkPlanStore;
  /** Native project ledger; actor issuance stays in trusted host composition. */
  readonly workLedger: WorkLedgerService;
  readonly memoryStore: MemoryStore;
  readonly memoryRegistry: MemoryRegistry;
  /** Host-vs-client memory access: local until bootstrap.ts activates it for an adopted 'external' daemon (mirrors sessionSpine). */
  readonly memorySpine: MemorySpineClient;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
  readonly stepUpService: StepUpService;
  readonly pairingTokens: PairingTokenManager; // backs pairing.tokens.* verbs + the settings device surface (mirrors the SDK composition)
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
  /** Stream watchers, on-exit process triggers and condition checks, supervised as one, see trigger-services.ts. */
  readonly triggerManager: TriggerManager;
  readonly voiceProviders: VoiceProviderRegistry;
  readonly voiceService: VoiceService;
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
  /**
   * The paired-phone feature for this host: the grants ledger, the capture
   * store, the housekeeping sweeps, and the capability service every `device.*`
   * setting governs. Bound to the `devices.*` verbs at composition; the `phone`
   * tool is registered on it in the bootstrap tail.
   */
  readonly devicePosture: DevicePostureRuntime;
  readonly daemonHandlers: DaemonHandlerSurfaces;
  /** Elects the one node on this network that consumes inbound messages; hand it to the DaemonServer so its consumers share this leadership instead of holding a second election. */
  readonly clusterCoordinator: ClusterCoordinator;
  /** LAN group membership: identity, keys, roster, and the `cluster` verbs. */
  readonly clusterGroup: ClusterGroupComposition;
  /** Start the group layer and then the election, in that order. Idempotent. */
  readonly startCluster: () => Promise<void>;
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
  readonly contextAccountingHolder: ContextAccountingHolder; // bound at bootstrap.ts; see context-accounting-source.ts
  readonly contractRunner: ContractRunner;
  readonly contractOperator: ContractOperatorService;
  readonly judgment: JudgmentServices;
  readonly browserJudgment?: BrowserJudgmentService | undefined;
  /** Canonical saved conversation plus its contract trees. */
  sessionSnapshot(sessionId: string, conversation: Omit<SessionSnapshot, 'contracts'>): SessionSnapshot;
  readonly processManager: ProcessManager;
  /** The repo source-tree code index. */
  readonly codeIndexStore: CodeIndexStore;
  readonly codeIndexReindexScheduler: CodeIndexReindexScheduler; // tool-site reindex
  /** Daily snapshots of every SQLite store this runtime writes, with bounded retention; unref'd timers (mirrors the SDK composition, hosts that tear down a runtime stop() it themselves). */
  readonly storeSnapshotScheduler: StoreSnapshotScheduler;
  readonly appendOnlyRetentionScheduler: operations.DurabilityServices['appendOnlyRetentionScheduler']; // periodic append-only sweep; unref'd timers, stop() on teardown
  /** Stops the recurring crash-residue sweep; idempotent, unref'd timer (hosts that tear a runtime down call it). */
  readonly stopDurabilityHousekeeping: () => void;
  /** Stops the wake-word recovery sweep and a pending boot provision; a no-op unless `provisionWakeModelsAtBoot` was set. */
  readonly stopWakeHousekeeping: () => void;
  readonly memoryConsolidationScheduler: MemoryConsolidationScheduler;
  readonly powerManager: PowerManager;
  /** The daemon's memory governor (default ON). Backs ops.memory.get and defends the daemon's footprint by tier. */
  readonly memoryGovernor: MemoryGovernor;
  /** Registry of every retained cache the governor can shrink (knowledge stores + shared session broker). */
  readonly cacheRegistry: CacheRegistry;
  /** Controller the governor uses to pause/resume the deferrable background jobs under pressure. */
  readonly pauseController: PauseController;
  readonly sessionLiveTurnControls: SessionLiveTurnControlsHolder;
  /** Unified live process registry (agents, WRFC chains, workflows, watchers, background processes) backing the Fleet panel; archive-aware, finished subtrees can be moved to the session archive view. */
  readonly processRegistry: ArchivableProcessRegistry;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly workspaceCheckpointManager: WorkspaceCheckpointManager;
  /** Whether checkpoints are currently permitted for this workspace; re-reads the registration store on every call. */
  readonly checkpointsCurrentlyAllowed: () => boolean;
  /** Surface-scoped continuity reads (recovery-file presence, last-session pointer). */
  readonly integrationHelpers: IntegrationHelperService;
  /** Per-workspace trust gate, restricts write/execute/delegate tools until the workspace is trusted. */
  readonly workspaceTrustManager: operations.WorkspaceTrustManager;
  /**
   * The permission manager the runs this daemon hosts ask through. Its ask seam
   * is the workspace trust gate over the approval broker, so an undecided
   * workspace has the trust question raised as an approval record rather than
   * being treated as trusted (which is what a missing manager means to the
   * background permission gate) or refused without a word.
   */
  readonly permissionManager: PermissionManager;
  /** Re-root path-bound stores (MemoryStore, ProjectIndex) to a new working directory, called by WorkspaceSwapManager after verification; stores needing a process restart just warn-log and keep serving the old path until the daemon restarts with the new --working-dir. */
  rerootStores(newWorkingDir: string): Promise<void>;
  /**
   * Cancel the agent runs this graph is hosting, returning how many.
   *
   * The shared poller registry cancels these calls before closing the runner,
   * fleet and process owners they depend on.
   */
  cancelHostedAgentRuns(): number;
  /** Await before replacing this graph or removing its owned files. */
  close(): Promise<void>;
  dispose(): void; // Stops every poller this graph started: best-effort, total, idempotent. This surface owns its graph, and the SDK's disposal scope drives it.
}
