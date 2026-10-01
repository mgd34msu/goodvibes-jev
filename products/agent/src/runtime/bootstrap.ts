import { readTierPromptSupplement } from '@goodvibes-jev/engine/sdk/platform/providers';
import { factsFor } from '@goodvibes-jev/engine/sdk/platform/routing';
/**
 * Bootstrap composition root for GoodVibes Agent.
 *
 * Initializes all runtime subsystems in dependency order and returns a
 * RuntimeContext that main.ts uses to drive the render loop and terminal I/O.
 *
 * Separation of concerns:
 *   - bootstrap.ts: initialization, event wiring, manager setup
 *   - main.ts: terminal setup, render loop, stdin/stdout handlers
 *   - lifecycle.ts: save/shutdown helpers
 */
import { Orchestrator, type OrchestratorUserInputOptions } from '@goodvibes-jev/engine/sdk/platform/core';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { collectStartupAnnouncements } from '@goodvibes-jev/engine/sdk/platform/runtime/feature-announcements';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHistory } from '../input/input-history.ts';
import type { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import type { Compositor } from '../renderer/compositor.ts';

import type { RuntimeContext, BootstrapOptions } from './context.ts';
import { shutdownRuntime, fireSessionStart } from '@/runtime/index.ts';
import { createTaskManager } from '@/runtime/index.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import { emitSessionReady, emitSessionStarted } from '@/runtime/index.ts';
import { loadLastConversation } from '@/runtime/index.ts';
import { bindWriteLastSessionPointerToSurface } from '@/runtime/index.ts';
import { scheduleMcpSuggestionScanOnFirstUse } from './mcp-suggestion-scan.ts';
import { restoreSavedModel } from '@/runtime/index.ts';
import { runGatedLanScan } from './lan-scan-consent.ts';
import { scheduleCalendarSubscriptionBootRefresh } from './calendar-boot-refresh.ts';
import type { TurnEvent } from '@/runtime/index.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { createDeferredStartupCoordinator } from '@/runtime/index.ts';
import { wireAgentExternalServices } from './bootstrap-external-services.ts';
import { initializeBootstrapCore } from './bootstrap-core.ts';
import { ensureBootModelResolvable } from './provider-boot.ts';
import { bindOrchestratorContextAccounting } from './context-accounting-source.ts';
import { createBootstrapShell } from './bootstrap-shell.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { startMcpConfigAutoReload } from '@goodvibes-jev/engine/terminal-shell';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { registerAgentTools } from './bootstrap-agent-tools.ts';
import { foldLegacySpineStore } from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine';
import { reconcileMemorySpineAdoption } from './memory-spine-adoption.ts';
import { createAgentSessionInputsClient } from './client/session-inputs.ts';
import { AgentPromptContextReceiptStore, composeRuntimePromptWithReceipt } from '../agent/prompt-context-receipts.ts';
import {
  bindRestoreTurnAnchorsToSurface,
  recordCompletedTurnAnchor,
  startAnchorDurabilityHousekeeping,
} from './rewind-anchor-wiring.ts';
import { createMemoryUsageTracker } from './memory-usage-wiring.ts';
import { installOccasionsNudging } from './occasions-boot.ts';
import { registerAgentAuditTool } from '../tools/agent-audit-tool.ts';
import { createRuntimeShutdown } from './bootstrap-shutdown.ts';
import { installAgentMcpCallRoute } from '../tools/agent-mcp-call-route.ts';
import { capabilitySnapshot } from '../capabilities/capability-snapshot.ts';
import { wireCapabilityIndex } from './bootstrap-capability-wiring.ts';
import { registerAgentCapabilityTool } from '../tools/agent-capability-tool.ts';
import { registerAgentAutonomyTool } from '../tools/agent-autonomy-tool.ts';
import { registerAgentChannelsTool } from '../tools/agent-channels-tool.ts';
import { registerAgentComputerTool } from '../tools/agent-computer-tool.ts';
import { registerAgentContextTool } from '../tools/agent-context-tool.ts';
import { registerAgentDelegationTool } from '../tools/agent-delegation-tool.ts';
import { registerAgentDeviceTool } from '../tools/agent-device-tool.ts';
import { registerAgentExecutionTool } from '../tools/agent-execution-tool.ts';
import { registerAgentHarnessTool } from '../tools/agent-harness-tool.ts';
import { registerAgentHostTool } from '../tools/agent-host-tool.ts';
import { registerAgentMemoryTool } from '../tools/agent-memory-tool.ts';
import { registerAgentModelsTool } from '../tools/agent-models-tool.ts';
import { registerAgentPersonalOpsTool } from '../tools/agent-personal-ops-tool.ts';
import { registerAgentProfileTool } from '../tools/agent-profile-tool.ts';
import { createProfileGatewayInvoke } from '../agent/owner-profile-gateway.ts';
import { registerAgentResearchTool } from '../tools/agent-research-tool.ts';
import { registerAgentRouteTool } from '../tools/agent-route-tool.ts';
import { registerAgentSecurityTool } from '../tools/agent-security-tool.ts';
import { registerAgentSessionsTool } from '../tools/agent-sessions-tool.ts';
import { registerAgentSetupTool } from '../tools/agent-setup-tool.ts';
import { registerAgentSettingsImportTool } from '../tools/agent-settings-import-tool.ts';
import { registerAgentSettingsTool } from '../tools/agent-settings-tool.ts';
import { registerAgentSupportTool } from '../tools/agent-support-tool.ts';
import { registerAgentTerminalProcessTools } from '../tools/agent-terminal-process-tools.ts';
import { registerAgentVibeTool } from '../tools/agent-vibe-tool.ts';
import { registerAgentWorkspaceTool } from '../tools/agent-workspace-tool.ts';
import { compactRegisteredToolDefinitions } from '../tools/tool-definition-compaction.ts';
import { GOODVIBES_AGENT_OPERATOR_POLICY } from './agent-operator-policy.ts';


// ── Bootstrap context type ──────────────────────────────────────────────────

/**
 * The fully-initialized context returned by bootstrapRuntime().
 *
 * A typed superset of RuntimeContext that exposes the additional fields required
 * by main.ts (UI-layer objects that do not belong in the shared RuntimeContext
 * interface, since they are not needed by anything else).
 */
export type BootstrapContext = RuntimeContext & {
  /** Compositor handles double-buffered terminal output. */
  compositor: Compositor;
  /** Manages text selection state. */
  selection: SelectionManager;
  /** Context object passed to slash-command handlers. */
  commandContext: CommandContext;
  /** Shell-facing read models, events, and narrow runtime services. */
  uiServices: UiRuntimeServices;
  /** Persists and navigates input history across sessions. */
  inputHistory: InputHistory;
  /** Unsubscribe functions owned by bootstrap (cleared on shutdown). */
  bootstrapUnsubs: Array<() => void>;
  /** Ref holding the periodic agent-status interval (use ref, not local var, to keep shutdown in sync). */
  agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null };
  /** Mutable refs for viewport/scroll/render functions; main.ts patches these after constructing UI state. */
  orchestratorRefs: { getViewportHeight: () => number; scrollToEnd: (vHeight: number) => void; requestRender: () => void };
  /** Patch the bootstrap-owned render route after main.ts constructs the real render loop. */
  setRenderRequest: (fn: () => void) => void;
  /** Shell-owned permission prompt route that main.ts patches after UI setup. */
  permissionPromptRef: { requestPermission: PermissionRequestHandler };
  /** Load the most recently saved conversation from disk. */
  loadLastConversation: () => { messages: Array<Record<string, unknown>> } | null;
  /** Write the last-session pointer file (used after session resume). */
  _writeLastSessionPointer: (sessionId: string) => void;
  /** Retrieve pinned model IDs for the model picker. */
  _getPinned: () => Promise<string[]>;
  /** Retrieve configured provider IDs for the model picker. */
  _getConfiguredProviderIds: () => string[];
  /** Command registry used by InputHandler. main.ts needs this to wire input. */
  commandRegistry: import('../input/command-registry.ts').CommandRegistry;
  /**
   * System message router instantiated at startup, wired to the conversation and the activity feed.
   *
   * @remarks
   * Route operational messages through this rather than calling
   * conversation.addSystemMessage() directly so that low-priority messages
   * stay out of the main conversation and go to the activity feed instead.
   */
  systemMessageRouter: SystemMessageRouter;
};

// ── Bootstrap function ────────────────────────────────────────────────────

/**
 * Initialize all runtime subsystems and return a fully-wired RuntimeContext.
 *
 * main.ts calls this once, then uses the returned context to:
 *   - Run the render loop
 *   - Handle stdin/stdout events
 *   - Manage terminal lifecycle (alt-screen, raw mode, resize)
 *
 * Phase summary:
 *   1. Config, caches, keybindings
 *   2. Runtime event bus, conversation, compositor, selection
 *   3. Tool registry + agent wiring
 *   4. Runtime bus subscriptions (delegation, subagent, hook route)
 *   5. Providers, webhooks, PermissionManager, HookDispatcher
 *   6. Orchestrator and Agent-local task read models
 *   7. MCP auto-connect + workspace
 *   8. Command registry + plugin init + CommandContext
 *   9. Input handler wiring
 *  10. Input history, splash options
 *  11. Background: provider auto-registration, persisted providers, scan
 */
export async function bootstrapRuntime(
  stdout: NodeJS.WriteStream,
  options: BootstrapOptions,
): Promise<BootstrapContext> {
  const workingDir = options.workingDir;
  const configManager = options.configManager;
  const controlPlaneRecentEventsRef: {
    value: (limit: number) => readonly import('@goodvibes-jev/engine/sdk/platform/control-plane').ControlPlaneRecentEvent[];
  } = {
    value: (_limit) => [],
  };
  const {
    userSessionId,
    runtimeBus,
    store,
    services,
    uiServices,
    conversation,
    compositor,
    selection,
    toolRegistry,
    fileCache,
    projectIndex,
    permissionManager,
    forensicsCollector,
    forensicsRegistry,
    runtime,
    bootstrapUnsubs,
    runtimeUnsubs,
    agentStatusIntervalRef,
    permissionPromptRef,
    systemMessageRouterRef,
    conversationFollowUpRef,
    orchestratorHandleUserInputRef,
    requestRender,
    setRenderRequest,
    runtimeSessionIdRef,
  } = await initializeBootstrapCore(stdout, options, (limit) => controlPlaneRecentEventsRef.value(limit));
  const providerRegistry = services.providerRegistry;
  // A saved custom-provider model must never crash boot, see provider-boot.ts.
  await ensureBootModelResolvable(providerRegistry, options.configManager);
  const promptContextReceipts = new AgentPromptContextReceiptStore(
    services.shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'prompt-context-receipts.jsonl'),
  );
  let activePromptTurnId: string | null = null;
  // The current turn's raw text: the injection seam
  // (composeRuntimePromptWithReceipt, invoked from getSystemPrompt below) needs the
  // active turn's intent to rank the already-eligible memory set by relevance. This is
  // the real seam that was left unthreaded, TURN_SUBMITTED already carries `prompt`, it
  // was just never captured. Mirrors activePromptTurnId's lifecycle exactly: set on
  // TURN_SUBMITTED, cleared on every terminal event for that turn.
  let activePromptTurnText: string | null = null;
  // Idle-time memory consolidation now runs on services.memoryConsolidationScheduler
  // (the SDK's own daemon-side MemoryConsolidationScheduler, constructed in
  // runtime/services.ts the way the SDK's own RuntimeServices composition
  // constructs it: a standing 5-minute tick, not turn-settled events). This
  // repo's old turn-settled-driven local wiring is retired.
  // Usage-outcome instrumentation: records which memories were injected and, at
  // turn completion, whether the model output plausibly referenced them (honest
  // heuristic overlap). No longer feeds consolidation's decay ranking (the SDK's
  // own composition root does not wire a usageLookup into its scheduler either,
  // matched here for parity); still tracked for its own reporting.
  const memoryUsageTracker = createMemoryUsageTracker(services.shellPaths, services.memoryRegistry);
  // Both halves of the owner ruling that occasion nudges go to Telegram AND the
  // agent (docs/occasions.md §4.2): this product is a PUSH destination the daemon
  // addresses, and the surface that PULLS what is outstanding. Neither replaces
  // the other and they cannot double-speak, see runtime/occasions-boot.ts for
  // why, and for the guard that makes it true.
  const occasionsNudgeSurface = installOccasionsNudging({
    router: services.channelDeliveryRouter,
    gatewayMethods: services.gatewayMethods,
    configManager,
    homeDirectory: services.shellPaths.homeDirectory,
    conversation,
    requestRender,
    disposals: bootstrapUnsubs,
  });
  runtimeUnsubs.push(
    runtimeBus.on<Extract<TurnEvent, { type: 'TURN_SUBMITTED' }>>('TURN_SUBMITTED', (event) => {
      activePromptTurnId = event.payload.turnId;
      activePromptTurnText = event.payload.prompt;
      // Per-turn recall refresh (SDK 1.2.0 sync-recall seam): the ASYNC
      // pre-turn hook. getSystemPrompt below is SYNCHRONOUS and cannot await
      // this, so it is fired here (not awaited) and read back via the cached
      // recallSnapshot() a moment later when the orchestrator actually builds
      // the prompt. A miss (this turn's prompt reads last turn's snapshot, or
      // the still-empty boot snapshot on a very first turn) is surfaced
      // honestly by the snapshot's own staleness note, never silently hidden.
      services.memorySpineClient.refreshRecallSnapshot(undefined, { recall: false }).catch((error: unknown) => {
        logger.debug('Per-turn memory recall snapshot refresh failed', { error: summarizeError(error) });
      });
    }),
    runtimeBus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', (event) => {
      promptContextReceipts.recordTurnOutcome({
        turnId: event.payload.turnId,
        status: 'completed',
        terminalEvent: 'TURN_COMPLETED',
        stopReason: event.payload.stopReason,
      });
      // The join key between conversation and files rewind (rewind-anchor-wiring.ts).
      recordCompletedTurnAnchor({
        sessionId: runtimeSessionIdRef.value,
        turnId: event.payload.turnId,
        conversation,
        surface: services.surface,
      });
      if (activePromptTurnId === event.payload.turnId) {
        activePromptTurnId = null;
        activePromptTurnText = null;
      }
      memoryUsageTracker.onTurnCompleted(event.payload.turnId, event.payload.response);
      // Raise anything outstanding, now that the transcript is quiet. Appending
      // the agent's own line while a response was still streaming would
      // interleave two voices in one transcript, which is why this rides the
      // turn's completion rather than its submission. Not awaited and it never
      // throws, a nudge that could not be pulled must not disturb the turn it
      // rode in on.
      void occasionsNudgeSurface.raiseNow();
    }),
    runtimeBus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', (event) => {
      promptContextReceipts.recordTurnOutcome({
        turnId: event.payload.turnId,
        status: 'error',
        terminalEvent: 'TURN_ERROR',
        stopReason: event.payload.stopReason,
        detail: event.payload.error,
      });
      if (activePromptTurnId === event.payload.turnId) {
        activePromptTurnId = null;
        activePromptTurnText = null;
      }
      memoryUsageTracker.onTurnAborted(event.payload.turnId);
    }),
    runtimeBus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', (event) => {
      promptContextReceipts.recordTurnOutcome({
        turnId: event.payload.turnId,
        status: 'cancelled',
        terminalEvent: 'TURN_CANCEL',
        stopReason: event.payload.stopReason,
        detail: event.payload.reason,
      });
      if (activePromptTurnId === event.payload.turnId) {
        activePromptTurnId = null;
        activePromptTurnText = null;
      }
      memoryUsageTracker.onTurnAborted(event.payload.turnId);
    }),
  );
  const {
    automationManager,
    hookDispatcher,
    pluginManager,
  } = services;

  // ── Phase 6: Orchestrator and Agent-local task read models ───────────────

  // Mutable function refs so main.ts can patch these after constructing the scroll/viewport state.
  // The orchestrator closes over these refs, so patching them in main.ts takes immediate effect.
  const orchestratorRefs = {
    getViewportHeight: (): number => 20,
    scrollToEnd: (_vHeight: number): void => { /* patched by main.ts */ },
    requestRender: (): void => { requestRender(); },
  };

  const systemPromptBySignal = new WeakMap<AbortSignal, Promise<string>>();
  const orchestrator = new Orchestrator({
    conversation,
    getViewportHeight: () => orchestratorRefs.getViewportHeight(),
    scrollToEnd: (vHeight: number) => orchestratorRefs.scrollToEnd(vHeight),
    toolRegistry,
    permissionManager,
    getSystemPrompt: (signal) => {
      const existing = signal ? systemPromptBySignal.get(signal) : undefined;
      if (existing) return existing;
      const currentModel = providerRegistry.getCurrentModel();
      const turnId = activePromptTurnId;
      const captured = {
        sessionId: runtime.sessionId,
        turnId,
        source: turnId ? 'turn' as const : 'follow_up' as const,
        provider: runtime.provider,
        model: currentModel,
        contextWindow: providerRegistry.getKnownContextWindowForModel(currentModel),
        runtimePrompt: runtime.systemPrompt,
        operatorPolicy: GOODVIBES_AGENT_OPERATOR_POLICY,
        shellPaths: services.shellPaths,
        memoryRegistry: services.memoryRegistry,
        turnText: activePromptTurnText,
        memoryRecallSnapshot: services.memorySpineClient.recallSnapshot(),
        capabilityIndex: capabilitySnapshot(),
      };
      const composedPrompt = (async () => {
        signal?.throwIfAborted();
        const tierPrompt = await readTierPromptSupplement(
          factsFor({ catalog: providerRegistry }, currentModel), providerRegistry.modelTiers,
          'agent.conversation-system-prompt', { audience: 'conversation', signal },
        );
        signal?.throwIfAborted();
        const composed = composeRuntimePromptWithReceipt({ ...captured, tierPrompt });
        signal?.throwIfAborted();
        promptContextReceipts.record(composed.receipt);
        memoryUsageTracker.onComposed(turnId, composed.receipt);
        return composed.prompt;
      })();
      if (signal) systemPromptBySignal.set(signal, composedPrompt);
      return composedPrompt;
    },
    hookDispatcher,
    flagManager: services.featureFlags,
    requestRender: () => orchestratorRefs.requestRender(),
    runtimeBus,
    sessionId: runtime.sessionId,
    services: {
      agentManager: services.agentManager,
      contractRunner: services.contractRunner,
      contractIntake: services.contractIntake,
    },
  });
  conversationFollowUpRef.value = (item) => orchestrator.enqueueConversationFollowUp(item);
  // Bind this repo's live interactive Orchestrator into the SDK's live-turn
  // controls holder (SDK round: sessions.toolCalls.cancel, sessions.
  // queuedMessages.list/edit/delete). The Orchestrator's public cancelToolCall/
  // listQueuedMessages/editQueuedMessage/deleteQueuedMessage methods already
  // structurally satisfy SessionLiveTurnControls, no adapter needed. Until this
  // bind call the gateway verbs refuse honestly (LIVE_TURN_CONTROLS_UNAVAILABLE).
  services.sessionLiveTurnControls.bind(orchestrator);
  // Wire orchestratorHandleUserInputRef so COMPANION_MESSAGE_RECEIVED fires a real LLM turn.
  orchestratorHandleUserInputRef.value = (text: string, options?: OrchestratorUserInputOptions) => {
    orchestrator.handleUserInput(text, undefined, options).catch((err: unknown) => {
      logger.debug('companion handleUserInput safety catch', { error: String(err) });
    });
  };
  orchestrator.setCoreServices({
    configManager,
    providerRegistry,
    cacheHitTracker: services.cacheHitTracker,
    planManager: services.planManager,
    adaptivePlanner: services.adaptivePlanner,
    sessionMemoryStore: services.sessionMemoryStore,
    sessionLineageTracker: services.sessionLineageTracker,
    idempotencyStore: services.idempotencyStore,
  });
  conversation.setSessionLineageTracker(services.sessionLineageTracker);

  // Bind the context_accounting tool (SDK 1.6.1) to THIS Orchestrator so it
  // reports real session data instead of the unbound-holder honesty message.
  // Must run after setCoreServices (nothing here depends on it, but this
  // keeps every orchestrator.* wiring call grouped) and before the first
  // turn, see context-accounting-source.ts for what each facet reads.
  runtimeUnsubs.push(bindOrchestratorContextAccounting({
    orchestrator,
    holder: services.contextAccountingHolder,
    runtimeBus,
    runtimeStore: store,
    sessionId: runtime.sessionId,
    getContextWindow: () => providerRegistry.getKnownContextWindowForModel(providerRegistry.getCurrentModel()),
  }));

  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional. isFeatureGateEnabled(null, ...) is permissive by design, so
  // omitting it did not disable task tracking when runtime.unifiedTasks was
  // turned off, it made the setting configure nothing: createTask/etc. kept
  // working either way. The SDK has corrected this key's recorded default to
  // match the behaviour every install has always shipped (true/enabled), so
  // threading the flag manager here changes nothing for an existing install
  // and only makes turning the setting off now actually turn it off.
  const opsTaskManager = createTaskManager(store, runtimeBus, userSessionId, services.featureFlags);

  // Surface-bound closure, not the raw multi-arg SDK function, see
  // the SDK's bindWriteLastSessionPointerToSurface for why that matters.
  const writeLastSessionPointerForSurface = bindWriteLastSessionPointerToSurface(services.surface);
  const restoreTurnAnchorsForSurface = bindRestoreTurnAnchorsToSurface(services.surface);

  const shell = createBootstrapShell({
    configManager,
    runtimeBus,
    runtimeStore: store,
    services,
    conversation,
    runtime,
    orchestrator,
    requestRender,
    permissionPromptRef,
    onSessionIdChanged: (sessionId) => {
      runtimeSessionIdRef.value = sessionId;
    },
    writeLastSessionPointer: writeLastSessionPointerForSurface,
    restoreTurnAnchors: restoreTurnAnchorsForSurface,
    getControlPlaneRecentEvents: (limit) => controlPlaneRecentEventsRef.value(limit),
    toolRegistry,
    promptContextReceipts,
    forensicsRegistry,
    policyRuntimeState: services.policyRuntimeState,
    uiServices,
    taskManager: opsTaskManager,
    completeModelSelectionSideEffect: () => {
      compositor.resetDiff();
    },
  });
  const systemMessageRouter = shell.systemMessageRouter;
  systemMessageRouterRef.value = systemMessageRouter;
  // Announce-once receipts due at boot (e.g. the web surface URL when
  // web.enabled). The store is shared per install, so whichever process of
  // this install boots first (daemon, TUI, or this Agent) announces; every
  // other process stays silent. Mirrors the SDK daemon boot's collection.
  for (const announcement of collectStartupAnnouncements({
    configManager,
    store: services.featureAnnouncementStore,
  })) {
    logger.info(announcement.text, { announcement: announcement.id });
    systemMessageRouter.low(`[Startup] ${announcement.text}`);
  }
  const commandRegistry = shell.commandRegistry;
  const commandContext = shell.commandContext;
  const inputHistory = shell.inputHistory;
  registerAgentTools({
    toolRegistry,
    commandRegistry,
    commandContext,
    configManager,
    services,
    getSessionId: () => runtimeSessionIdRef.value,
  });
  const pluginCommandRegistry = {
    register(command: {
      readonly name: string;
      readonly aliases?: readonly string[];
      readonly description: string;
      readonly usage?: string;
      readonly argsHint?: string;
      readonly handler: (args: string[]) => void | Promise<void>;
    }): void {
      commandRegistry.register({
        ...command,
        aliases: command.aliases ? [...command.aliases] : undefined,
      });
    },
    unregister(name: string): void {
      commandRegistry.unregister(name);
    },
  };

  // ── Phase 7: Connected-host posture + deferred startup ────────────────

  const deferredStartup = createDeferredStartupCoordinator();

  // GoodVibes Agent does not own the connected daemon's (or HTTP listener's)
  // lifecycle, see bootstrap-external-services.ts for the adopt-only wiring
  // and the deferred discovery probe it schedules. One bounded exception at
  // boot: a host that is INSTALLED on this machine but stopped is started
  // once through the platform service manager, with an honest receipt.
  const agentExternalServices = wireAgentExternalServices({
    configManager,
    runtimeBus,
    hookDispatcher,
    services,
    uiServices,
    deferredStartup,
    systemMessageRouter,
    requestRender,
  });

  deferredStartup.schedule({
    label: 'plugins',
    run: async () => {
      await pluginManager.init({
        runtimeBus,
        commandRegistry: pluginCommandRegistry,
        providerRegistry,
        toolRegistry,
        gatewayMethods: services.gatewayMethods,
        channelRegistry: services.channelPlugins,
        channelDeliveryRouter: services.deliveryManager.getDeliveryRouter(),
        memoryEmbeddingRegistry: services.memoryEmbeddingRegistry,
        voiceProviderRegistry: services.voiceProviders,
        mediaProviderRegistry: services.mediaProviders,
        webSearchProviderRegistry: services.webSearchProviders,
        getPluginConfig: (name) => pluginManager.getPluginConfig(name),
        isEnabled: (name) => pluginManager.isEnabled(name),
      });
      requestRender();
    },
    onError: (error) => {
      const message = summarizeError(error);
      logger.error('Deferred plugin startup failed', { error: message });
      systemMessageRouter.high(`[Startup] Plugin initialization failed: ${message}`);
      requestRender();
    },
  });
  // Probe the daemon spine OFF the interactive path. On a reachable daemon,
  // fold the agent's own per-cwd legacy session store into it (once; marked
  // migrated). Waits for connected-host discovery (which may have just started
  // an installed-but-stopped daemon) so this probe sees the settled state; a
  // down/absent daemon leaves the agent local-only with an honest offline status.
  deferredStartup.schedule({
    label: 'session-spine',
    run: async () => {
      await agentExternalServices.whenDiscovered();
      const reachability = await services.sessionSpineClient.probeReachability();
      if (reachability !== 'online') return;
      foldLegacySpineStore(services.sessionSpineClient, {
        storePath: services.shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'sessions.json'),
        markerPath: services.shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'sessions.spine-folded.json'),
        project: workingDir,
        log: logger,
      });
    },
    onError: (error) => {
      logger.debug('Deferred session-spine startup failed', { error: summarizeError(error) });
    },
  });
  // Memory spine (SDK 1.1.0): the daemon-owned canonical memory store is
  // single-writer, so the agent must make an explicit adopted/not-adopted decision
  // rather than trying the wire per call. Reuses the SAME reachability signal as the
  // session-spine fold above (services.sessionSpineClient.probeReachability(), one
  // daemon, one connected-host token) instead of inventing a second probe. On a
  // reachable daemon, activate the spine for CLIENT mode, every wire-covered memory
  // op now routes over HTTP and the local store is never written again. Embedded/
  // offline is unaffected: the agent must keep working with no daemon running, and a
  // failed/absent probe simply leaves the client in its constructed LOCAL mode.
  //
  // A daemon can also appear or disappear AFTER boot, so this keeps checking for the
  // whole process lifetime on the same cadence as the runtime heartbeat: adopt late
  // if one shows up, and hand back to local (deactivate) the moment a PREVIOUSLY
  // adopted daemon stops answering, never guess and keep routing to a dead wire.
  let memorySpineHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  //
  // Inbound continuation dispatch rides the SAME adoption edge. It has to: the
  // wire dispatch polls `sessions.inputs.list` on the adopted daemon, and there
  // is nothing to poll until one is adopted. `onAttach` fires exactly on the
  // transition INTO adoption, so activating there is idempotent per attach and
  // re-activates for free when a daemon comes back after a loss; the detach side
  // deactivates so the poller stops dialing a dead wire while keeping the bound
  // runner for the next attach.
  const sessionInputsClient = createAgentSessionInputsClient(services.daemonVerbs);
  const reconcileMemorySpine = (): Promise<void> => reconcileMemorySpineAdoption({
    memorySpineClient: services.memorySpineClient,
    transport: services.memorySpineTransport,
    probeReachability: () => services.sessionSpineClient.probeReachability(),
    // Reachable is not usable: a daemon below this build's floor is refused here,
    // so nothing activates and the spine keeps its local store. Re-asked per
    // attempt, so a daemon updated mid-session is adopted on the next tick.
    mayAdopt: () => services.mayAdoptDaemonBuild(),
    // One consuming /status read per attach: a current daemon delivers its
    // one-shot honesty receipts ("restarted after a crash at HH:MM", "updated
    // from X to Y") only to a ?receipts=consume read, and this adoption edge is
    // exactly where the agent (re)attaches to a daemon. The plain liveness probe
    // stays receipt-neutral.
    onAttach: () => {
      services.sessionBroker.activate(sessionInputsClient);
      return services.consumeDaemonReceipts();
    },
    onDetach: () => services.sessionBroker.deactivate('the connected host stopped answering'),
  });
  deferredStartup.schedule({
    label: 'memory-spine',
    run: async () => {
      // Wait for connected-host discovery (which may have just started an
      // installed-but-stopped daemon) so the first adoption decision sees the
      // settled daemon state instead of racing it; the heartbeat below keeps
      // reconciling for the rest of the process lifetime either way.
      await agentExternalServices.whenDiscovered();
      await reconcileMemorySpine();
      // Prime the recall snapshot (SDK 1.2.0 sync-recall seam) so the FIRST
      // system prompt built after boot already has a real snapshot to read
      // instead of the honest-but-empty "not yet captured" one, see
      // recallSnapshot's doc comment on prompt-context-receipts.ts's
      // memoryRecallSnapshot field. { recall: false } captures an unfiltered
      // browse set: the receipt's own eligibility/suppression logic (not the
      // snapshot) decides what is prompt-active, so this must mirror the old
      // memoryRegistry.getAll() read exactly, not the recall-floor-filtered set.
      await services.memorySpineClient.refreshRecallSnapshot(undefined, { recall: false }).catch((error: unknown) => {
        logger.debug('Initial memory recall snapshot refresh failed', { error: summarizeError(error) });
      });
      if (configManager.get('watchers.enabled')) {
        const intervalMs = Number(configManager.get('watchers.heartbeatIntervalMs') ?? 30_000);
        memorySpineHeartbeatTimer = setInterval(() => {
          reconcileMemorySpine().catch((error: unknown) => {
            logger.debug('Memory-spine reachability recheck failed', { error: summarizeError(error) });
          });
        }, intervalMs);
        memorySpineHeartbeatTimer.unref?.();
      }
    },
    onError: (error) => {
      logger.debug('Deferred memory-spine startup failed', { error: summarizeError(error) });
    },
  });

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
  };

  // ── Phase 8: Background provider registration (non-blocking) ────────────
  // These run after the initial render so they don't delay startup.
  //
  // Gated: the SDK's discovery pass probes every host on the local subnet
  // unconditionally, so it is only ever invoked through runGatedLanScan,
  // which requires an explicit, persisted consent decision first and reframes
  // whatever the SDK emits into a single honest summary line. See
  // src/runtime/lan-scan-consent.ts.

  runGatedLanScan({
    configManager,
    providerRegistry,
    runtime,
    requestRender,
    restoreRuntimeModel: restoreSavedModel,
    systemMessageRouter,
    shellPaths: services.shellPaths,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
  });
  // Refresh explicitly-subscribed external calendar feeds that are DUE
  // per their own bounded interval (conditional 304 requests keep it cheap).
  // Consent was given at subscribe time ("now and on each refresh"); with no
  // subscriptions this touches nothing. Non-blocking, boot never waits on it;
  // one honest aggregate line only when something refreshed or failed.
  void scheduleCalendarSubscriptionBootRefresh({
    shellPaths: services.shellPaths,
    secretsManager: services.secretsManager,
    systemMessageRouter,
    requestRender,
  });
  const mcpDiscovery = scheduleMcpSuggestionScanOnFirstUse({ // lazy, see mcp-lazy-start.ts
    mcpRegistry: services.mcpRegistry,
    systemMessageRouter,
    requestRender,
    shellPaths: services.shellPaths,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
  });
  bootstrapUnsubs.push(() => mcpDiscovery.stop());
  const mcpAutoReload = startMcpConfigAutoReload({
    roots: services.shellPaths,
    registry: services.mcpRegistry,
    onReload: ({ connected, total }) => {
      systemMessageRouter.low(`[MCP] Reloaded config: ${connected}/${total} server(s) connected.`);
      requestRender();
    },
    onError: (error) => {
      const message = summarizeError(error);
      logger.warn('MCP config auto-reload failed', { error: message });
      systemMessageRouter.high(`[MCP] Config reload failed: ${message}`);
      requestRender();
    },
  });
  bootstrapUnsubs.push(() => mcpAutoReload.stop());
  // The reclaim half of what the anchors above write. The live session id is
  // read at sweep time, so a resume repointing it is respected.
  bootstrapUnsubs.push(startAnchorDurabilityHousekeeping({
    surface: services.surface,
    currentSessionId: () => runtimeSessionIdRef.value,
  }));
  if (configManager.get('automation.enabled')) {
    logger.warn('Local automation startup is disabled in GoodVibes Agent; use connected-host observability instead.');
    systemMessageRouter.low('[Startup] Local automation execution is disabled in GoodVibes Agent; use read-only automation observability or explicit connected-host actions.');
  }

  // ── Phase 12: Session:start lifecycle hook ─────────────────────────────

  fireSessionStart(runtime.sessionId, services.hookDispatcher);
  emitSessionStarted(runtimeBus, {
    sessionId: runtime.sessionId,
    traceId: `${runtime.sessionId}:session-start`,
    source: 'bootstrap',
  }, {
    sessionId: runtime.sessionId,
    profileId: 'default',
    workingDir,
  });
  emitSessionReady(runtimeBus, {
    sessionId: runtime.sessionId,
    traceId: `${runtime.sessionId}:session-ready`,
    source: 'bootstrap',
  }, {
    sessionId: runtime.sessionId,
  });

  // ── Compose RuntimeContext ────────────────────────────────────────────────

  const ctx: BootstrapContext = {
    runtimeBus,
    store,
    services,
    featureFlags: services.featureFlags,
    conversation,
    permissions: permissionManager,
    toolRegistry,
    providerRegistry,
    componentHealthMonitor: services.componentHealthMonitor,
    worktreeRegistry: services.worktreeRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    hookDispatcher,
    fileCache,
    projectIndex,
    sessionId: userSessionId,
    isResumed: false, // Sessions start fresh; use /session resume to load a previous one
    runtime,
    orchestrator,
    compositor,
    selection,
    commandContext,
    uiServices,
    inputHistory,
    bootstrapUnsubs,
    agentStatusIntervalRef,
    orchestratorRefs,
    setRenderRequest,
    permissionPromptRef,
    loadLastConversation: () => loadLastConversation({ surface: services.surface }),
    _writeLastSessionPointer: writeLastSessionPointerForSurface,
    _getPinned: () => services.favoritesStore.getPinned(),
    _getConfiguredProviderIds: () => services.providerRegistry.getConfiguredProviderIds(),
    commandRegistry,
    systemMessageRouter,
    shutdown: createRuntimeShutdown({
      sessionId: runtime.sessionId,
      model: runtime.model,
      provider: runtime.provider,
      conversationTitle: () => conversation.title || '',
      sessionSpineClient: services.sessionSpineClient,
      takeMemorySpineTimer: () => {
        const timer = memorySpineHeartbeatTimer;
        memorySpineHeartbeatTimer = null;
        return timer;
      },
      bootstrapUnsubs,
      runtimeUnsubs,
      forensicsCollector,
      executionLedger: services.executionLedger,
      disposeSessionWriteLedger: () => { services.disposeSessionWriteLedger(); },
      disposeRuntimeGraph: () => { services.dispose(); },
      deferredStartup,
      agentExternalServices,
      agentStatusIntervalRef,
      scheduleManager: services.workflow.scheduleManager,
      hookDispatcher: services.hookDispatcher,
      providerRegistry: services.providerRegistry,
      sessionOrchestration: services.sessionOrchestration,
      shutdownOptions: { surface: services.surface },
    }),
  };

  // Wire exit from options if provided; otherwise main.ts binds the operator route.
  if (options?.exit) {
    ctx.commandContext.exit = options.exit;
  }

  return ctx;
}
