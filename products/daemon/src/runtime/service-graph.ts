import { createLocalWorkLedgerReadBinding } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { registerWorkLedgerGatewayMethods, registerWorkLedgerImportGatewayMethods } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { join } from 'node:path';
import { ServiceRegistry, SubscriptionManager, ToolLLM, sharedSubscriptionsPath } from '@goodvibes-jev/engine/sdk/platform/config';
import { AutomationDeliveryManager, AutomationManager } from '@goodvibes-jev/engine/sdk/platform/automation';
import { ChannelPolicyManager } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker, buildSharedSessionAgentSpawnRoutingInput, controlPlaneStorePath } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { AcpHostService } from '@goodvibes-jev/engine/sdk/platform/acp';
import { continuationContractOptions } from '@goodvibes-jev/engine/sdk/platform/agents';
import { PersonalCaptureHolder, conversationalTurnSpawnOptions } from '@goodvibes-jev/engine/sdk/platform/personal-capture';
import { resolvePairingWebOrigin } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { attachWsOnlyGatewayVerbHandlers } from '@goodvibes-jev/engine/terminal-shell';
import { createRuntimeAcquisitionScope } from './acquisition.js';
import { composeMailDeps } from './mail-composition.js';
import { composeCredentialServices } from './credential-composition.js';
import { registerDaemonRuntimeBasePollers } from './disposal-wiring.js';
import { attachConfigEmitBridge } from '@goodvibes-jev/engine/sdk/platform/runtime/config';
import { WatcherRegistry } from '@goodvibes-jev/engine/sdk/platform/watchers';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { createWebKnowledgeGapRepairer } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { createKnowledgeServices } from './knowledge-services.js';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '@goodvibes-jev/engine/sdk/platform/media';
import { MultimodalService } from '@goodvibes-jev/engine/sdk/platform/multimodal';
import { OverflowHandler, ProcessManager, cancelAllAgentRuns, createWorkflowServices } from '@goodvibes-jev/engine/sdk/platform/tools';
import { FileStateCache, FileUndoManager, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, ModeManager, ProjectIndex, resolveCanonicalMemoryDbPath } from '@goodvibes-jev/engine/sdk/platform/state';
import { buildExecPromptAnswerHandler } from '@goodvibes-jev/engine/sdk/platform/runtime/permissions/exec-prompt-wiring';
import { buildLocalhostFetchApproval } from '@goodvibes-jev/engine/sdk/platform/runtime/permissions/localhost-fetch-approval';
import { createBrokeredPermissionManager } from '@goodvibes-jev/engine/sdk/platform/runtime/client-services';
import { wireMemoryPressureChannelNotice } from './notification-dispatch.js';
import { operations } from '@goodvibes-jev/engine/sdk/platform/runtime';
const {
  applyProviderOptimizerConfigMode, bindProviderOptimizerFeatureFlag, codeIndexDbPath,
  createAgentExecutionGraph, createChannelComposition, createCodeIndexServices, composeJudgment,
  createRemoteExecutionServices, createSessionStorageServices, createStoreRerooter,
  isCodeInjectionSettingEnabled, wireIdlePowerAndLiveTurn, wireVoiceSetup,
} = operations;
const { WorkspaceTrustManager } = operations;
import { MemorySpineClient, createLocalMemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { createWorkspaceCheckpointing } from './workspace-checkpointing.js';
import { createSessionConversationRewindPort } from './conversation-rewind-port.js';
import { createDomainDispatch } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { DistributedRuntimeManager, IntegrationHelperService, IdempotencyStore, ComponentHealthMonitor, WorktreeRegistry, createShellPathService, createFeatureFlagManager, createNoopPanelManager, createNoopKeybindingsManager, PolicyRuntimeState } from './index.js';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '@goodvibes-jev/engine/sdk/platform/voice';
import { CacheRegistry, PauseController, wireDaemonMemoryGovernance } from '@goodvibes-jev/engine/sdk/platform/runtime/memory';
import { WebSearchProviderRegistry, WebSearchService } from '@goodvibes-jev/engine/sdk/platform/web-search';
import { HookActivityTracker } from '@goodvibes-jev/engine/sdk/platform/hooks';
import { HookDispatcher, createHookWorkbench } from '@goodvibes-jev/engine/sdk/platform/hooks';
import { PluginManager } from '@goodvibes-jev/engine/sdk/platform/plugins';
import { BookmarkManager } from '@goodvibes-jev/engine/sdk/platform/bookmarks';
import { ProfileManager } from '@goodvibes-jev/engine/sdk/platform/profiles';
import { CrossSessionTaskRegistry, SessionChangeTracker } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { ApiTokenAuditor, UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { NOTIFICATIONS_METADATA_ONLY_KEY, readNotificationsMetadataOnly } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { WebhookNotifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { BenchmarkStore, CacheHitTracker, FavoritesStore, ModelLimitsService, ProviderCapabilityRegistry, ProviderOptimizer, createLaunchTolerantProviderRegistry, ensureConfiguredModelIsRoutable } from '@goodvibes-jev/engine/sdk/platform/providers';
import { AdaptivePlanner, DeterministicReplayEngine, ExecutionPlanManager, SessionLineageTracker, SessionMemoryStore } from '@goodvibes-jev/engine/sdk/platform/core';
import { deriveFeatureStates, bindFeatureSettingsBridge } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createFleetServices } from './fleet-services.js';
import { createTriggerServices } from './trigger-services.js';
import { wireFleetNeedsInputPush } from './fleet-needs-input-push.js';
import type { DaemonHandlerCompositionOptions } from './daemon-handler-composition.js';
import { createDaemonContractServices } from './contract-composition.js';
import { createBrowserCheckoutSeamHolder } from './browser-checkout-seam-holder.js';
import { createDevicePostureServices } from './device-posture-composition.js';
// Re-exported so the daemon entrypoint reaches the housekeeping sweep through
// the same module it already imports the runtime graph from. `installDevicePosture`
// is deliberately NOT re-exported: it registers the phone TOOL into a tool
// registry, and the daemon registers no tools, the sweep is the half it needs.
export { startDeviceHousekeeping } from './device-posture-composition.js';
import { createClusterServices, startClusterServices } from './cluster-group-composition.js';
import { createWorkspaceTrustDecisionAsk, trustGatedApprovalRaiser } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.js';
export type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.js';

/** Construct the daemon's base owners before the outer async handler boundary.
 * Adapted from pinned daemon 443e5ee; shared capabilities use canonical factories.
 */
export async function createRuntimeBaseServices(options: RuntimeServicesOptions): Promise<{ services: Omit<RuntimeServices, 'daemonHandlers'>; handlerOptions: Omit<DaemonHandlerCompositionOptions, 'distributedRuntimeReady'>; closeWorkLedger: () => Promise<void> }> {
  // The SDK's disposal scope and its all-required poller list, plus the four
  // pollers only the daemon has, see disposal-wiring.ts.
  const disposalScope = createRuntimeAcquisitionScope('RuntimeServices');
  let fenceWorkLedger: (() => Promise<void>) | undefined;
  const close = (): Promise<void> => {
    // Fence immediately, before reverse-order drains can await other owners.
    // The registered ledger owner reports any cleanup failure through the scope.
    void fenceWorkLedger?.().catch(() => {});
    return disposalScope.close();
  };
  try {
    const workingDirectory = options.workingDir;
    const homeDirectory = options.homeDirectory;
    const shellPaths = createShellPathService({
      workingDirectory,
      homeDirectory,
    });
    // Built before anything that touches session state.
    const { surface, sessionManager } = createSessionStorageServices({ surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT, workingDirectory, homeDirectory });
    const workspaceTrustManager = new WorkspaceTrustManager({ shellPaths, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT });
    const configManager = options.configManager;
    const featureFlags = options.featureFlags ?? createFeatureFlagManager();
    if (options.featureFlags === undefined) {
      // Owned manager: gate states derive from domain settings keys + live bridge
      // (mirrors the SDK composition root; a passed manager is the caller's to wire).
      featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
      disposalScope.registry.add('feature settings bridge', bindFeatureSettingsBridge(configManager, featureFlags));
    }
    const runtimeDispatch = createDomainDispatch(options.runtimeStore);
    // Late-bound governor admission keeps construction and background work on
    // the same pause policy; the governor is attached below before return.
    const cacheRegistry = new CacheRegistry();
    const pauseController = new PauseController();
    const MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex'];
    const admitExpensiveWorkRef: { current: ((label: string) => { allowed: boolean; reason?: string | undefined }) | null } = { current: null };
    const admitExpensiveWork = (label: string): { allowed: boolean; reason?: string | undefined } =>
      admitExpensiveWorkRef.current?.(label) ?? { allowed: true };
    const isKnowledgeBackgroundPaused = (): boolean => pauseController.isPaused('knowledge-self-improvement');
    const gatewayMethods = new GatewayMethodCatalog();
    // The daemon has no screen. The facade's service-graph contract names a panel
    // manager and a keybindings manager because a surface that HAS a screen
    // supplies real ones; the SDK ships no-ops for a host that does not, which is
    // the honest answer rather than a stub that pretends to open panels.
    const panelManager = createNoopPanelManager();
    const keybindingsManager = createNoopKeybindingsManager();
    // Channel/surface wiring, composed by the SDK helper.
    const { routeBindings, surfaceRegistry, channelPlugins } = createChannelComposition({
      configManager,
      runtimeStore: options.runtimeStore,
      runtimeBus: options.runtimeBus,
      featureFlags,
    });
    // The credential/identity seam (credential-composition.ts).
    const { secretsManager, stepUpService, pairingTokens } = composeCredentialServices({
      workingDirectory, homeDirectory, configManager,
      daemonHomeDirectory: options.daemonHomeDirectory,
      pairingTokenPath: controlPlaneStorePath(shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'pairing-tokens.json'),
    });
    const judgment = composeJudgment({ config: configManager, secrets: secretsManager, env: process.env, stateRoot: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT), disposal: disposalScope.registry });
    const browserJudgment = options.createBrowserJudgment?.(judgment);
    if (browserJudgment) disposalScope.registry.add('browser judgment transport', () => browserJudgment.close());
    const subscriptionManager = new SubscriptionManager(sharedSubscriptionsPath(shellPaths), { legacyPath: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'subscriptions.json') });
    const serviceRegistry = new ServiceRegistry(shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'services.json'), {
      secretsManager,
      subscriptionManager,
    });
    const providerCapabilityRegistry = new ProviderCapabilityRegistry();
    const cacheHitTracker = new CacheHitTracker();
    const favoritesStore = new FavoritesStore({ dir: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT) });
    const benchmarkStore = new BenchmarkStore({ dir: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT) });
    const modelLimitsService = new ModelLimitsService({
      cachePath: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'model-limits.json'),
    });
    // Canonical construction preserves honest unconfigured provider status.
    const providerRegistry = createLaunchTolerantProviderRegistry({
      configManager,
      subscriptionManager,
      secretsManager,
      serviceRegistry,
      capabilityRegistry: providerCapabilityRegistry,
      cacheHitTracker,
      favoritesStore,
      benchmarkStore,
      modelLimitsService,
      featureFlags,
      runtimeBus: options.runtimeBus,
    });
    disposalScope.registry.add('provider metadata startup', async () => { await Promise.all([providerRegistry.modelDiscoverySettled(), benchmarkStore.benchmarksSettled()]); });
    ensureConfiguredModelIsRoutable(providerRegistry, configManager);
    providerRegistry.initCustomProviders();
    // Background, TTL-respecting live model discovery so provider model lists
    // refresh from their own listing APIs.
    providerRegistry.initProviderModelDiscovery();
    benchmarkStore.initBenchmarks();
    const toolLLM = new ToolLLM({
      configManager,
      providerRegistry,
      runtimeBus: options.runtimeBus,
    });
    const localUserAuthManager = options.localUserAuthManager ?? new UserAuthManager({
      bootstrapFilePath: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'auth-users.json'),
      bootstrapCredentialPath: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'auth-bootstrap.txt'),
    });
    const profileManager = new ProfileManager(shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'profiles'));
    const bookmarkManager = new BookmarkManager(shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'bookmarks'));
    const sessionOrchestration = new CrossSessionTaskRegistry(
      join(surface.sessionsDir, 'task-graph.json'),
    );
    disposalScope.ownUntilRegistered('cross-session task registry', () => sessionOrchestration.dispose());
    const hookActivityTracker = new HookActivityTracker();
    // featureFlags is REQUIRED here in practice, even though the SDK types it
    // optional. isFeatureGateEnabled(null, ...) is permissive by design, a narrow
    // embed with no manager wired gets the capability rather than a silent off,
    // so omitting it did not disable the watcher framework when watchers.enabled
    // is turned off; it made the setting configure nothing.
    const watcherRegistry = new WatcherRegistry({
      storePath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'watchers.json'),
      featureFlags,
    });
    disposalScope.ownUntilRegistered('watcher registry', () => watcherRegistry.dispose());
    watcherRegistry.attachRuntime({
      runtimeStore: options.runtimeStore,
      runtimeBus: options.runtimeBus,
    });
    // The agent-execution graph, wired in both directions; see
    // the SDK's agent-graph composition for why the six are built as one.
    const {
      agentMessageBus, archetypeLoader, agentOrchestrator,
      agentManager, contextAccountingHolder,
    } = createAgentExecutionGraph({
      runtimeBus: options.runtimeBus, workingDirectory, configManager, providerRegistry,
    });
    disposalScope.ownUntilRegistered('agent orchestrator tool registries', () => agentOrchestrator.dispose());
    disposalScope.ownUntilRegistered('hosted agent runs', () => { cancelAllAgentRuns(agentManager); });
    // The one late-binding holder for the personal-capture port. The gateway verb
    // groups fill it (they own the owner-profile store and the occasions service),
    // and the agent orchestrator reads it when it builds a run's tool registry.
    // Registration happens before setDependencies in this file, but the registry
    // is built per run, so by the time a conversational turn asks for `profile`
    // the port is already in place.
    const personalCapture = new PersonalCaptureHolder();
    const hookDispatcher = new HookDispatcher({ agentManager, toolLLM, projectRoot: workingDirectory }, hookActivityTracker);
    disposalScope.registry.add('config hook attachment', configManager.attachHookDispatcher(hookDispatcher));
    const hookWorkbench = createHookWorkbench({
      hookDispatcher,
      configManager,
    });
    const approvalBroker = new ApprovalBroker({
      storePath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'approvals.json'),
    });
    const sessionBroker = new SharedSessionBroker({
      storePath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'sessions.json'),
      routeBindings,
      agentStatusProvider: agentManager,
      messageSender: agentMessageBus,
      conversationGateConfig: configManager, // without this the gate runs on DEFAULTS: an inbound message landing in a live session takes the handover and starts work whatever conversationGate.mode/gatedSurfaces say
    });
    sessionBroker.setContinuationRunner(async ({ task, input }) => {
      const record = agentManager.spawn({
        mode: 'spawn',
        task,
        // Canonical continuation authority: only an explicit work marker or a
        // local surface starts a contract. Other follow-ups remain conversations.
        ...continuationContractOptions(input, {
          configReader: {
            get: (key: string) => configManager.get(key as never),
            getCategory: (name: string) => configManager.getCategory(name as never),
          },
        }),
        // What the answering agent is given and what it is told. `restrictTools:
        // true` with no tool list used to mean an EMPTY registry: the agent could
        // emit text and nothing else, which is why a trip pasted into a channel
        // was answered and stored nowhere. This names the tools a conversational
        // turn actually needs (read, find, fetch, and the `profile` capture tool),
        // supplies the instruction that makes recording part of answering, and
        // carries the write authority for the surface the message arrived on.
        // It also supplies the run's context, which is why the bare
        // `context: shared-session:<id>` line that used to sit below is gone.
        // Spread BEFORE the routing builder so an explicit tool list coming from
        // a routing intent still wins, that builder emits `tools` only when it
        // actually has one.
        ...conversationalTurnSpawnOptions(input, { configReader: configManager }),
        // Spawn routing through the SDK's shared model-reference resolver
        // (unique-across-registry auto-qualifies; ambiguous and unknown ids throw
        // errors naming real candidates), against the live registry's models.
        ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { restrictTools: true, modelCandidates: providerRegistry.listModels() }),
      });
      return { agentId: record.id };
    });
    const artifactStore = new ArtifactStore({ configManager });
    const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
    // Open the ONE home-scoped canonical store; legacy per-project memory folds in at boot.
    const memoryDbPath = resolveCanonicalMemoryDbPath(homeDirectory);
    const memoryStore = new MemoryStore(memoryDbPath, {
      embeddingRegistry: memoryEmbeddingRegistry,
    });
    const memoryRegistry = new MemoryRegistry(memoryStore);
    // The daemon is the memory spine's HOST: it always serves the local store.
    // Clients construct the same facade in wire mode against this process.
    const memorySpine = new MemorySpineClient({ local: createLocalMemoryAccess(memoryRegistry) });
    // featureFlags is REQUIRED here in practice, even though the SDK types it
    // optional (same reasoning as the watcher registry above): without it,
    // integrations.deliveryTracking configured nothing.
    const deliveryManager = new AutomationDeliveryManager({
      configManager,
      // This manager builds the delivery router the daemon actually replies
      // through. Without the secrets manager it cannot resolve a
      // goodvibes://secrets/... credential, so Telegram accepted every inbound
      // message and dropped every reply with "Missing Telegram bot token" while
      // ntfy, which needs no secret, worked.
      secretsManager,
      serviceRegistry,
      runtimeBus: options.runtimeBus,
      runtimeStore: options.runtimeStore,
      routeBindings,
      artifactStore,
      featureFlags,
    });
    const automationManager = new AutomationManager({
      configManager,
      // The daemon is a service, not a terminal: a job it creates is attributed to
      // the service surface.
      defaultSurfaceKind: 'service',
      routeBindings,
      sessionBroker,
      runtimeStore: options.runtimeStore,
      runtimeBus: options.runtimeBus,
      deliveryManager,
      // Same live registry: a bare model id on an automation job resolves through
      // the shared resolver instead of a format-only rejection.
      providerRegistry,
      featureFlags,
      spawnTask: (input) => {
        const record = agentManager.spawn({
          mode: 'spawn',
          task: input.prompt,
          ...(input.modelId ? { model: input.modelId } : {}),
          ...(input.modelProvider ? { provider: input.modelProvider } : {}),
          ...(input.fallbackModels !== undefined ? { fallbackModels: [...input.fallbackModels] } : {}),
          ...(input.routing ? { routing: input.routing } : {}),
          ...(input.executionIntent ? { executionIntent: input.executionIntent } : {}),
          ...(input.template ? { template: input.template } : {}),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(input.toolAllowlist?.length ? { tools: [...input.toolAllowlist], restrictTools: true } : {}),
          ...(input.context ? { context: input.context } : {}),
        });
        return record.id;
      },
    });
    // Knowledge/wiki + home-graph stack (governor backpressure wired in), see knowledge-services.ts.
    const {
      knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore,
      knowledgeSemanticService, homeGraphSemanticService, agentKnowledgeSemanticService,
      knowledgeService, agentKnowledgeService, homeGraphService,
      projectPlanningService, projectPlanningProjectId, workPlanStore, workLedgerOwner,
    } = createKnowledgeServices({ ownership: disposalScope, configManager, providerRegistry, artifactStore, memoryRegistry, runtimeBus: options.runtimeBus, workingDirectory, homeDirectory, isBackgroundPaused: isKnowledgeBackgroundPaused, admitExpensiveWork });
    // This daemon's existing owner and host-selected project are authoritative.
    // Request payloads can only verify this binding, never select a store or actor.
    const workLedgerReadBinding = createLocalWorkLedgerReadBinding({
      available: true, projectId: projectPlanningProjectId, actorId: 'host:operator-ledger-read',
      // Gateway checks each request's read:knowledge scope before source provenance leaves the host.
      allowLegacyProvenance: true,
      service: workLedgerOwner.service, authority: workLedgerOwner.authority,
    });
    if (!workLedgerReadBinding.available) throw new Error(workLedgerReadBinding.reason);
    const workLedgerReader = workLedgerReadBinding.client;
    disposalScope.registry.add('native work ledger reader', () => workLedgerReader.dispose());
    fenceWorkLedger = async () => {
      try { workLedgerReader.dispose(); } finally { await workLedgerOwner.close(); }
    };
    registerWorkLedgerGatewayMethods(gatewayMethods, workLedgerReader);
    registerWorkLedgerImportGatewayMethods(gatewayMethods, {
      hostId: workLedgerOwner.importHostId, projectId: projectPlanningProjectId,
      service: workLedgerOwner.service, authority: workLedgerOwner.authority,
      readSource: id => knowledgeStore.getSourceSnapshot({ id }),
    });
    const voiceProviders = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(voiceProviders, { readConfig: (key) => configManager.get(key as Parameters<typeof configManager.get>[0]) });
    const voiceService = new VoiceService(voiceProviders);
    const webSearchProviders = new WebSearchProviderRegistry({
      env: process.env,
      serviceRegistry,
    });
    const webSearchService = new WebSearchService(webSearchProviders, {
      serviceRegistry,
      featureFlags,
    });
    for (const [semantic, ingest] of [[knowledgeSemanticService, knowledgeService], [agentKnowledgeSemanticService, agentKnowledgeService], [homeGraphSemanticService, homeGraphService]] as const) {
      semantic.setGapRepairer(createWebKnowledgeGapRepairer({ searchService: webSearchService, ingestService: ingest }));
    }
    const mediaProviders = new MediaProviderRegistry();
    ensureBuiltinMediaProviders(mediaProviders, artifactStore, providerRegistry);
    const multimodalService = new MultimodalService(artifactStore, mediaProviders, voiceService, knowledgeService);
    const pluginManager = new PluginManager({
      pathOptions: {
        cwd: shellPaths.workingDirectory,
        homeDir: shellPaths.homeDirectory,
      },
      stateFilePath: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'plugins.json'),
    });
    disposalScope.ownUntilRegistered('plugins', () => pluginManager.close());
    const workflow = createWorkflowServices();
    hookDispatcher.setTriggerManager(workflow.triggerManager);
    const channelPolicy = new ChannelPolicyManager({
      storePath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'channels', 'policies.json'),
    });
    const distributedRuntime = new DistributedRuntimeManager(
      shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'remote', 'distributed-runtime.json'),
    );
    distributedRuntime.attachRuntime({
      sessionBridge: sessionBroker,
      approvalBridge: approvalBroker,
      automationBridge: automationManager,
    });
    // The paired-phone feature for this host, on the SAME runtime phones pair onto
    // and the SAME approval broker every other confirmation rides. Every `device.*`
    // setting is read live through this; see device-posture-composition.ts.
    const { devicePosture } = createDevicePostureServices({
      configManager,
      distributedRuntime,
      approvals: approvalBroker,
      stateDirectory: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'devices'),
      gatewayMethods,
    });
    disposalScope.ownUntilRegistered('device housekeeping', () => devicePosture.stopHousekeeping());

    // Which machines on this network are "us", and which of them reads the shared
    // inbox. Both inert until startCluster(), no socket, no key material read;
    // see cluster-group-composition.ts for why they are built together.
    const { clusterGroup, clusterCoordinator } = createClusterServices({
      configManager, shellPaths, secretsManager,
    });
    disposalScope.registry.add('cluster group', () => clusterGroup.stop());
    disposalScope.registry.add('cluster coordinator', () => clusterCoordinator.stop('runtime closing'));
    // ONE router, not two (a second built from the same four arguments would
    // differ from the one replies leave through). Moved up from its original
    // spot near the ws-only verb options (still consumed there): the payments
    // composition below needs it too.
    const channelDeliveryRouter = deliveryManager.getDeliveryRouter();
    // Browser composition fills this shared holder before async host registration.
    const browserCheckoutSeam = createBrowserCheckoutSeamHolder();


    // Remote runners and the sandboxes tool calls are confined to; see
    // the SDK's remote-execution composition for why the four are built as one.
    const { remoteRunnerRegistry, remoteSupervisor, sandboxSessionRegistry, mcpRegistry }
      = createRemoteExecutionServices({
        agentManager, workingDirectory, hookDispatcher, configManager, runtimeBus: options.runtimeBus,
      });
    // Advisory reporting only: `managed` is hardcoded false here, so excess-scope
    // and overdue tokens are reported and never blocked.
    const tokenAuditor = new ApiTokenAuditor({ managed: false, featureFlags });
    const componentHealthMonitor = new ComponentHealthMonitor();
    const worktreeRegistry = new WorktreeRegistry(workingDirectory);
    const webhookNotifier = new WebhookNotifier([], {
      metadataOnly: () => readNotificationsMetadataOnly(() => configManager.get(NOTIFICATIONS_METADATA_ONLY_KEY as never)),
    });
    // This shared owner can send memory-pressure notices before boot attachment.
    // Own it immediately, including failed graph construction or omitted boot.
    disposalScope.registry.add('shared webhook notifier', () => webhookNotifier.close());
    const replayEngine = new DeterministicReplayEngine(workingDirectory);
    const providerOptimizer = new ProviderOptimizer(providerRegistry, providerCapabilityRegistry, false); // dark until its gate flips it
    disposalScope.registry.add('provider optimizer bridge', bindProviderOptimizerFeatureFlag(featureFlags, providerOptimizer));
    applyProviderOptimizerConfigMode(configManager, providerOptimizer);
    const sessionMemoryStore = new SessionMemoryStore();
    const sessionLineageTracker = new SessionLineageTracker(); const sessionChangeTracker = new SessionChangeTracker();
    const planManager = new ExecutionPlanManager(workingDirectory);
    const adaptivePlanner = new AdaptivePlanner();
    const idempotencyStore = new IdempotencyStore();
    const overflowHandler = new OverflowHandler({ baseDir: workingDirectory });
    const policyRuntimeState = new PolicyRuntimeState();
    const fileCache = new FileStateCache();
    const projectIndex = new ProjectIndex(workingDirectory);
    disposalScope.ownUntilRegistered('default workspace project index', () => projectIndex.dispose());
    const processManager = new ProcessManager();
    disposalScope.registry.add('background processes', () => processManager.close());
    // The source-tree index shares memory embeddings; auto-build is config-gated and off by default.
    const { codeIndexStore, codeIndexReindexScheduler } = createCodeIndexServices({ workingDirectory, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT, configManager, memoryEmbeddingRegistry, isReindexPaused: () => pauseController.isPaused('code-index-reindex'), admitExpensiveWork });
    disposalScope.ownUntilRegistered('code-index reindex scheduler', () => codeIndexReindexScheduler.dispose());
    // Store snapshots, the periodic append-only sweep, durable remembered-approval rules + the live credential chain.
    const { storeSnapshotScheduler, appendOnlyRetentionScheduler, userPermissionRuleStore, stopDurabilityHousekeeping, stopConfigWatch } = operations.createDurabilityServices({
      configManager, secretsManager, providerRegistry, memoryDbPath, codeIndexDbPath: codeIndexDbPath(workingDirectory, GOODVIBES_DAEMON_SURFACE_ROOT), surface, shellPaths, // + retention-sweep roots & live config watch (mirrors the SDK)
      ...(options.currentSessionId ? { currentSessionId: options.currentSessionId } : {}), // exempts the running session from crash-residue reaping
    });
    disposalScope.ownUntilRegistered('config file watch', stopConfigWatch);
    disposalScope.ownUntilRegistered('store snapshot scheduler', () => storeSnapshotScheduler.stop());
    disposalScope.ownUntilRegistered('append-only retention scheduler', () => appendOnlyRetentionScheduler.stop());
    disposalScope.ownUntilRegistered('durability housekeeping', stopDurabilityHousekeeping);
    const codeInjectionOrchestratorDeps = { codeIndex: codeIndexStore, isCodeInjectionSettingEnabled: () => isCodeInjectionSettingEnabled(configManager), codeIndexReindexScheduler };
    // The trigger family: stream watchers, on-exit process triggers, condition
    // checks, fed to the fleet below as its trigger supervisor, so a trigger
    // is visible and steerable like every other running thing.
    const triggerManager = createTriggerServices({
      configManager, shellPaths, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
      agentManager, processManager, sessionBroker,
    });
    disposalScope.ownUntilRegistered('trigger manager', () => triggerManager.shutdown());
    // Hosted third-party coding agents (ACP): permission asks route through the
    // SAME shared approval broker every other confirmation rides (approvals
    // panel + push like any native ask), and each hosted agent maps onto a
    // kind-'acp' shared session so it is attachable/steerable like any other.
    // Mirrors the SDK's own createRuntimeServices composition (services.ts ~879).
    const acpHost = new AcpHostService({
      requestPermission: (request) => approvalBroker.requestApproval({ request }),
      registerSession: ({ id, title, agentTitle, cwd }) => void sessionBroker
        .register({ sessionId: id, kind: 'acp', title, project: cwd, participant: { surfaceKind: 'service', surfaceId: `acp-host:${agentTitle}`, lastSeenAt: Date.now() } })
        .catch(() => { /* best-effort; the fleet row is authoritative */ }),
    });
    const contracts = createDaemonContractServices({ runtimeBus: options.runtimeBus, agentManager, agentMessageBus, configManager, providerRegistry, projectRoot: workingDirectory, acpHost, runtimeStore: options.runtimeStore, workPlanService: projectPlanningService, planManager });
    disposalScope.ownUntilRegistered('contract runner', () => contracts.dispose());
    const { runner: contractRunner, operator: contractOperator } = contracts;
    const { processRegistry } = createFleetServices({ // Shared archive-aware fleet registry (+ daemon observed rows). See fleet-services.ts.
      agentManager, contractRunner,
      codeIndexService: codeIndexStore, // Folds a single 'code-index' node into the fleet
      processManager, watcherRegistry, workflow, approvalBroker, sessionBroker,
      triggerSupervisor: triggerManager,
      messageBus: agentMessageBus, // Backs steer()/`steerable` (the Fleet steer composer builds on top)
      automationManager, // Folds scheduled AutomationJobs into the fleet as 'schedule' nodes
      runtimeBus: options.runtimeBus,
      observeExternalAgents: options.observeExternalAgents, providerRegistry, // observeExternalAgents is daemon-side only
      acpHost, // Folds live hosted-agent sessions into the fleet as 'acp' rows
    });
    disposalScope.ownUntilRegistered('fleet process registry', () => processRegistry.dispose());
    const modeManager = new ModeManager({ featureFlags }); const fileUndoManager = new FileUndoManager();
    // Checkpoints, gated on live workspace registration, see workspace-checkpointing.ts.
    const checkpointing = createWorkspaceCheckpointing({
      workspaceRoot: workingDirectory, surface, runtimeBus: options.runtimeBus, configManager, shellPaths,
    });
    disposalScope.registry.add('workspace checkpoint initialization and work', checkpointing.close);
    const workspaceCheckpointManager = checkpointing.manager;
    // memory-consolidation honors governor backpressure: it ticks only when idle
    // AND the 'memory-consolidation' job is not paused AND expensive work is
    // admitted (mirrors the SDK's own createRuntimeServices idle gate).
    const { memoryConsolidationScheduler, powerManager, sessionLiveTurnControls } = wireIdlePowerAndLiveTurn({ configManager, memoryRegistry, runtimeBus: options.runtimeBus, isIdle: () => sessionBroker.countBusySessions() === 0 && !pauseController.isPaused('memory-consolidation') && admitExpensiveWork('memory consolidation').allowed, snapshotTick: () => storeSnapshotScheduler.tick(), heartbeat: async () => { await automationManager.triggerHeartbeat({ source: 'wake-catchup' }); }, powerSeam: options.powerSeam });
    disposalScope.ownUntilRegistered('memory consolidation scheduler', () => memoryConsolidationScheduler.stop());
    disposalScope.registry.add('runtime power', () => powerManager.stop());

    // Construct + start the MemoryGovernor (default ON, a safety feature) with the
    // standard KNOWN cache adapters (knowledge stores + shared session broker),
    // then late-bind the admission gate the expensive entry points captured
    // earlier. The SDK owns this wiring.
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
      receiptPath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'memory', 'tripwire-receipt.json'),
      knowledgeStores: [knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore],
      sessionBroker,
      // Graceful tripwire shutdown flushes in-flight state via ASYNC store
      // snapshots so the governor's 10s shutdown ceiling stays enforceable.
      onTripwireShutdown: async () => { await storeSnapshotScheduler.snapshotAllAsync('tripwire'); },
    });
    disposalScope.ownUntilRegistered('memory governor', () => memoryGovernor.stop());
    admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label);

    // Managed local-voice provisioning (voice.local.status/install), single-flight
    // one-act install + no-network status.
    const { voiceSetup, stopWakeHousekeeping } = wireVoiceSetup({ configManager, shellPaths, voiceProviders, admitExpensiveWork,
      // Boot provisioning of the wake-word model + its recovery sweep, opted into
      // by the real entrypoint only (same treatment as powerSeam) so a one-shot CLI
      // command and a test composing this graph fetch nothing and start no timer.
      provisionWakeModelsAtBoot: options.provisionWakeModelsAtBoot === true });
    disposalScope.ownUntilRegistered('wake-word housekeeping', stopWakeHousekeeping);

    // Terminal-shell wrapper over the SDK registerGatewayVerbGroups (gateway-verbs.ts); checkin.*/fleet-needs-input/pairing.* register only when their deps are present. memoryGovernor lights up ops.memory.get; voiceSetup lights up voice.local.status/install.
    // calendar.*/email.* are platform-served; these two let it register (mail-composition.ts).
    const { emailServiceDeps, describeEmailConfigProblem } = composeMailDeps({ configManager, secretsManager });
    attachWsOnlyGatewayVerbHandlers(gatewayMethods, {
      // The surface segment every control-plane store path is built from
      // (SDK control-plane-store-paths.ts). Required, not defaulted: a default
      // is what let these stores write to the unscoped orphan directory.
      surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
      homeDirectory, emailServiceDeps, describeEmailConfigProblem, processRegistry,
      onBrowserCheckout: browserCheckoutSeam.set,
      // The registration-gated surface, not the raw manager: an explicit create in
      // an unregistered workspace refuses with something actionable.
      workspaceCheckpointManager: checkpointing.gatewayManager,
      conversationRewindPort: createSessionConversationRewindPort(), sessionBroker, secretsManager, stepUpService,
      // Fills the capture port with the owner-profile store and the occasions
      // service, so the `profile` tool a conversational turn is given has
      // somewhere real to write.
      personalCapture,
      // The session intake attributes a sender on this policy's owner allowlist
      // to the owner principal instead of unknown.
      channelPolicy,
      approvalBroker, requestApproval: (input) => approvalBroker.requestApproval(input),
      // approvals.raise, a surface CREATING an ask in this broker. Without it the
      // verb is cataloged and unhandled, and a client whose prompt runs outside
      // this process has no way to raise one.
      approvalRaise: approvalBroker,
      // credentials.set / credentials.delete, a credential written THROUGH the
      // control plane, so a client with no access to the daemon's settings file can
      // configure one. The value lands in the daemon's secret tier and the verb
      // never echoes it back.
      credentialWrites: { config: configManager, secrets: secretsManager },
      watcherRegistry, userPermissionRuleStore, shellPaths, configManager, runtimeStore: options.runtimeStore,
      channelDeliveryRouter, providerRegistry, automationManager, sessionLister: sessionBroker, sessionIntake: sessionBroker,
      workingDirectory, memoryRegistry, pairingTokens, sessionLiveTurnControls, powerManager, memoryGovernor, voiceSetup,
      acpHost, // Registers acp.agents.list (discovery) and acp.sessions.create (spawn). See register-gateway-verb-groups.ts.
      attemptsController: contractRunner.fleetControls(), contractOperator,
      relayAvailable: () => configManager.get('relay.enabled') === true,
      pairingWebOrigin: () => resolvePairingWebOrigin(configManager).origin,
      disposal: disposalScope.registry,
      ...wireFleetNeedsInputPush({ registry: processRegistry, runtimeBus: options.runtimeBus, sessionBroker }),
    });
    disposalScope.registry.add('browser checkout seam holder', () => browserCheckoutSeam.clear()); // newer than 'browser sessions' above, so runs first
    // A loopback fetch that isn't allow-listed asks once through the approval
    // broker; "allow for this project" persists and later fetches never ask. Built
    // once and shared with the tool registry so both ask alike.
    const localhostFetchApproval = buildLocalhostFetchApproval({ requestApproval: (input) => approvalBroker.requestApproval(input), configManager });
    // Exec stuck on a terminal prompt rides the approval broker; the typed answer
    // feeds the continuing run. Built once and shared (like localhostFetchApproval)
    // so every setDependencies site installs the SAME handler; otherwise a
    // wholesale replace drops it and prompts hang.
    const execPromptAnswerHandler = buildExecPromptAnswerHandler({ requestApproval: (input) => approvalBroker.requestApproval(input) });
    // Tool asks from the runs this daemon HOSTS. Without a manager here, the
    // background permission gate short-circuits to approved and every hosted
    // write, command and delegation ran ungated, the workspace trust decision
    // was read by nobody in this process.
    //
    // The ask seam is the trust gate wrapping the approval broker: a workspace
    // with no decision yet has the question raised as an approval record and
    // answered by whichever surface is attached (trust-gated-approvals.ts),
    // there is no screen here to show a modal on, so the raise replaces it. The
    // manager's own layers, permission mode, policy, session cache, durable
    // user rules, still run first and are unchanged.
    const permissionManager = createBrokeredPermissionManager({
      requestApproval: trustGatedApprovalRaiser(
        workspaceTrustManager,
        (input) => approvalBroker.requestApproval(input),
        createWorkspaceTrustDecisionAsk({
          broker: approvalBroker,
          workingDirectory,
        }),
      ),
      configManager,
      policyRuntimeState,
      hookDispatcher,
      featureFlags,
      userRuleStore: userPermissionRuleStore,
    });
    agentOrchestrator.setDependencies({
      contractRunner, contractHooks: contractRunner.hooks(),
      agentManager,
      surfaceRoot: surface.surfaceRoot,
      permissionManager,
      execPromptAnswerHandler,
      localhostFetchApproval,
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
      knowledgeService,
      memoryRegistry,
      ...codeInjectionOrchestratorDeps, // Agent-run code injection + tool-site reindex
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
      contextAccountingHolder,
      // Without this the `profile` tool is never registered, and a conversational
      // turn that was told to record what the owner said has nothing to call.
      personalCapture,
    });

    // Continuity reads (recovery-file presence, last-session pointer) scoped to
    // the same surface the daemon writes with, so a reader never checks the
    // unscoped legacy pair. Part of the facade's service-graph contract.
    const integrationHelpers = new IntegrationHelperService({
      surface, configManager, automationManager, approvalBroker, sessionBroker, distributedRuntime,
      remoteRunnerRegistry, remoteSupervisor, panelManager, localUserAuthManager, providerRegistry,
      serviceRegistry, subscriptionManager, secretsManager,
      runtimeStore: options.runtimeStore, runtimeBus: options.runtimeBus,
      getConversationTitle: options.getConversationTitle,
    });

    // This process's own memory pressure, to the operator's configured notice
    // destination. Targeted at OPS_MEMORY_PRESSURE rather than subscribed to the
    // whole high-churn 'ops' domain, and sent over the SAME WebhookNotifier the
    // notification verbs keep live and boot-tasks attaches to the bus. There is
    // no panel notification router here: its targets are all screen targets and
    // this product has no screen, see notification-dispatch.ts.
    disposalScope.registry.add('memory pressure notice', wireMemoryPressureChannelNotice(options.runtimeBus, webhookNotifier));

    // In-process config changes become key-level events on the `config` domain, so
    // a client whose settings live HERE gets live change notices instead of
    // polling. Secret-bearing keys are named and never valued.
    disposalScope.registry.add('config event bridge', attachConfigEmitBridge({
      config: { subscribe: (key, cb) => configManager.subscribe(key as never, cb as never) },
      bus: options.runtimeBus,
    }));

    const services: Omit<RuntimeServices, 'daemonHandlers'> = {
      workingDirectory,
      homeDirectory,
      surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
      surface,
      shellPaths,
      workspaceTrustManager,
      permissionManager,
      configManager,
      featureFlags,
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
      approvalBroker,
      localhostFetchApproval,
      execPromptAnswerHandler,
      userPermissionRuleStore,
      sessionBroker,
      deliveryManager,
      automationManager,
      gatewayMethods,
      artifactStore,
      knowledgeService,
      agentKnowledgeService,
      homeGraphService,
      projectPlanningService,
      projectPlanningProjectId,
      workPlanStore,
      workLedger: workLedgerOwner.service,
      memoryStore,
      memoryRegistry,
      memorySpine,
      serviceRegistry,
      secretsManager,
      stepUpService,
      pairingTokens,
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
      triggerManager,
      voiceProviders,
      voiceService,
      webSearchProviders,
      webSearchService,
      mediaProviders,
      multimodalService,
      memoryEmbeddingRegistry,
      channelPolicy,
      mcpRegistry,
      tokenAuditor,
      componentHealthMonitor,
      worktreeRegistry,
      sandboxSessionRegistry,
      webhookNotifier,
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
      devicePosture,
      clusterCoordinator,
      clusterGroup,
      startCluster: () => startClusterServices({ clusterGroup, clusterCoordinator }),
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
      contextAccountingHolder,
      contractRunner, contractOperator, judgment, browserJudgment,
      sessionSnapshot: (sessionId, conversation) => ({ ...conversation, contracts: contractRunner.list({ sessionId, includeTerminal: true }) }),
      processManager,
      codeIndexStore,
      codeIndexReindexScheduler,
      storeSnapshotScheduler, appendOnlyRetentionScheduler, stopDurabilityHousekeeping, stopWakeHousekeeping,
      memoryConsolidationScheduler,
      powerManager,
      memoryGovernor,
      cacheRegistry,
      pauseController,
      sessionLiveTurnControls,
      processRegistry,
      modeManager,
      fileUndoManager,
      workspaceCheckpointManager,
      checkpointsCurrentlyAllowed: checkpointing.currentlyAllowed,
      integrationHelpers,
      rerootStores: createStoreRerooter({ codeIndexStore, projectIndex, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT }),
      // Cancel hosted calls before their runtime dependencies close; the shared
      // poller registry places this ahead of runner, fleet and process teardown.
      cancelHostedAgentRuns: () => cancelAllAgentRuns(agentManager),
      close,
      dispose: (): void => { void close().catch(() => {}); },
    };
    registerDaemonRuntimeBasePollers(disposalScope.registry, { ...services, contractRunner: contracts }, { stopConfigWatch });
    // Drain plugin work before releasing the graph it can call into.
    disposalScope.registry.add('plugins', () => pluginManager.close());
    const handlerOptions = {
      gatewayMethods,
      secretsManager,
      configManager,
      workingDirectory,
      homeDirectory,
      shellPaths,
      distributedRuntime,
      clusterCoordinator,
      checkoutSeam: browserCheckoutSeam.get, channelDeliveryRouter, inboxFactory: options.inboxFactory,
    };
    return { services, handlerOptions, closeWorkLedger: fenceWorkLedger };
  } catch (startupError) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([startupError, cleanupError], 'Runtime graph construction and cleanup failed'); }
    throw startupError;
  }
}
