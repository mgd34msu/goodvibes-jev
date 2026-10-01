import { join } from 'node:path';
import type { ConversationManager } from '../core/conversation';
import type { Orchestrator } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { RuntimeStore } from './store/index.ts';
import type { RuntimeServices } from './services.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { AgentPromptContextReceiptStore } from '../agent/prompt-context-receipts.ts';
import { CommandRegistry } from '../input/command-registry.ts';
import { registerBuiltinCommands } from '../input/commands.ts';
import { InputHistory } from '../input/input-history.ts';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { ActivityFeed } from '../core/activity-feed.ts';
import { sumConversationUsage } from '../core/conversation-usage.ts';
import { createSystemMessageRouter, type SystemMessageRouter } from '../core/system-message-router.ts';
import { getConfigSnapshot } from '../config/index.ts';
import { createBootstrapCommandContext } from './bootstrap-command-context.ts';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { loadBootstrapSystemPrompt } from '@/runtime/index.ts';
import { createShellPlanRuntime, createShellRemoteCommandService } from '@/runtime/index.ts';
import { createRuntimeFoundationClients } from '@/runtime/index.ts';
import type { ControlPlaneRecentEvent } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { TaskManager } from '@/runtime/index.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { createKnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';

export interface BootstrapShellState {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly inputHistory: InputHistory;
  readonly systemMessageRouter: SystemMessageRouter;
}

export interface BootstrapShellOptions {
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly services: RuntimeServices;
  readonly conversation: ConversationManager;
  readonly runtime: MutableRuntimeState;
  readonly orchestrator: Orchestrator;
  readonly requestRender: () => void;
  readonly permissionPromptRef: { requestPermission: PermissionRequestHandler };
  readonly onSessionIdChanged: (sessionId: string) => void;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly restoreTurnAnchors: (sessionId: string) => number;
  readonly getControlPlaneRecentEvents: (limit: number) => readonly ControlPlaneRecentEvent[];
  readonly toolRegistry: ToolRegistry;
  readonly promptContextReceipts?: AgentPromptContextReceiptStore;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly uiServices: UiRuntimeServices;
  readonly taskManager: TaskManager;
  readonly completeModelSelectionSideEffect?: () => void;
}

type PlanningAnswerSubmit = (answer: string) => void;

export interface PlanningAnswerSubmitBridgeOptions {
  readonly getSubmitInput: () => PlanningAnswerSubmit | undefined;
  readonly addSystemMessage: (message: string) => void;
  readonly requestRender: () => void;
  readonly defer?: (callback: () => void) => void;
}

export function submitPlanningAnswerWithShellFallback(
  answer: string,
  options: PlanningAnswerSubmitBridgeOptions,
): void {
  const submit = options.getSubmitInput();
  if (submit) {
    submit(answer);
    return;
  }

  const defer = options.defer ?? ((callback) => {
    setTimeout(callback, 0);
  });
  defer(() => {
    const deferredSubmit = options.getSubmitInput();
    if (deferredSubmit) {
      deferredSubmit(answer);
      return;
    }

    options.addSystemMessage([
      '[Planning] Could not submit the selected answer because the prompt route is not ready.',
      `Paste this answer into the prompt to continue planning: ${answer}`,
    ].join('\n'));
    options.requestRender();
  });
}

export function createBootstrapShell(options: BootstrapShellOptions): BootstrapShellState {
  const {
    configManager,
    runtimeBus,
    runtimeStore,
    services,
    conversation,
    runtime,
    orchestrator,
    requestRender,
    permissionPromptRef,
    writeLastSessionPointer,
    restoreTurnAnchors,
    getControlPlaneRecentEvents,
    toolRegistry,
    promptContextReceipts,
    forensicsRegistry,
    policyRuntimeState,
    uiServices,
    taskManager,
    completeModelSelectionSideEffect,
  } = options;

  const activityFeed = new ActivityFeed();

  let commandContextRef: CommandContext | null = null;

  const systemMessageRouter = createSystemMessageRouter(
    conversation,
    activityFeed,
    (kind) => {
      const ui = getConfigSnapshot(configManager).ui;
      if (kind === 'contract') return ui.contractMessages;
      if (kind === 'operational') return ui.operationalMessages;
      return ui.systemMessages;
    },
  );
  orchestrator.setSystemMessageRouter(systemMessageRouter);

  const commandRegistry = new CommandRegistry();
  registerBuiltinCommands(commandRegistry);
  // No opsControlPlane: the Agent's product boundary keeps connected-host
  // tasks read-only (see /tasks: every mutation subcommand is blocked and
  // routed to /workplan or /delegate), so the opsApi intervention verbs
  // honestly report the control plane as unavailable.
  const foundationClients = createRuntimeFoundationClients({
    // The foundation clients read the session REGISTER (listSessions and the
    // rest), not the dispatch seam, so they get the daemon-grade view, the one
    // that names the register automation runs on.
    runtimeServices: services.asDaemonGradeView(),
    tasksReadModel: uiServices.readModels.tasks,
    taskManager,
  });
  const {
    directTransport,
    hookApi,
    mcpApi,
    opsApi,
    providerApi,
  } = foundationClients;
  const agentKnowledgeApi = createKnowledgeApi(services.agentKnowledgeService, { memoryRegistry: services.memoryRegistry });
  const remoteRuntime = createShellRemoteCommandService({
    readModels: uiServices.readModels,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    runtimeStore,
  });
  const planRuntime = createShellPlanRuntime({
    adaptivePlanner: services.adaptivePlanner,
    runtimeBus,
  });

  const commandContext: CommandContext = createBootstrapCommandContext({
    configManager,
    providerRegistry: services.providerRegistry,
    conversation,
    runtime,
    requestRender,
    keybindingsManager: services.keybindingsManager,
    requestPermission: (request) => permissionPromptRef.requestPermission(request),
    toolRegistry,
    mcpRegistry: services.mcpRegistry,
    voiceProviderRegistry: services.voiceProviders,
    voiceService: services.voiceService,
    voiceSetup: services.voiceSetup,
    memoryGovernor: services.memoryGovernor,
    mediaProviderRegistry: services.mediaProviders,
    artifactStore: services.artifactStore,
    channelDeliveryRouter: services.channelDeliveryRouter,
    forensicsRegistry,
    policyRuntimeState,
    readModels: uiServices.readModels,
    shellPaths: services.shellPaths,
    remoteRuntime,
    planRuntime,
    fileUndoManager: services.fileUndoManager,
    processManager: services.processManager,
    executionLedger: services.executionLedger,
    approvalsView: services.approvalsView,
    memoryRegistry: services.memoryRegistry,
    integrationHelpers: services.integrationHelpers,
    automationManager: services.automationManager,
    knowledgeService: services.agentKnowledgeService,
    projectPlanningService: services.projectPlanningService,
    projectPlanningProjectId: services.projectPlanningProjectId,
    workPlanStore: services.workPlanStore,
    providerOptimizer: services.providerOptimizer,
    pluginManager: services.pluginManager,
    hookWorkbench: services.hookWorkbench,
    agentManager: services.agentManager,
    modeManager: services.modeManager,
    sessionManager: services.sessionManager,
    profileManager: services.profileManager,
    bookmarkManager: services.bookmarkManager,
    favoritesStore: services.favoritesStore,
    benchmarkStore: services.benchmarkStore,
    providerApi,
    subscriptionManager: services.subscriptionManager,
    secretsManager: services.secretsManager,
    serviceRegistry: services.serviceRegistry,
    localUserAuthManager: services.localUserAuthManager,
    tokenAuditor: services.tokenAuditor,
    replayEngine: services.replayEngine,
    webhookNotifier: services.webhookNotifier,
    sessionMemoryStore: services.sessionMemoryStore,
    sessionLineageTracker: services.sessionLineageTracker,
    changeTracker: services.sessionChangeTracker,
    planManager: services.planManager,
    adaptivePlanner: services.adaptivePlanner,
    sessionOrchestration: services.sessionOrchestration,
    operatorClient: directTransport.operator,
    peerClient: directTransport.peer,
    agentKnowledgeApi,
    promptContextReceipts,
    hookApi,
    mcpApi,
    opsApi,
    directTransport,
    worktreeRegistry: services.worktreeRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    memoryConsolidationScheduler: services.memoryConsolidationScheduler,
    loadSystemPrompt: () => loadBootstrapSystemPrompt(configManager),
    activatePlan: (_planId, task) => {
      setTimeout(() => {
        orchestrator.handleUserInput(task).catch((err) => {
          logger.debug('activatePlan handler failed', { error: summarizeError(err) });
        });
      }, 50);
    },
    completeModelSelectionSideEffect,
    componentHealthMonitor: services.componentHealthMonitor,
    writeLastSessionPointer,
    restoreTurnAnchors,
    surface: services.surface,
    // Token counters and context occupancy come from the transcript (/clear empties it).
    hydrateSessionUsage: () => {
      const { usage, lastInputTokens } = sumConversationUsage(conversation.getMessageSnapshot());
      orchestrator.usage = usage;
      orchestrator.lastInputTokens = lastInputTokens;
    },
  });
  commandContextRef = commandContext;

  const saveHistory = configManager.get('behavior.saveHistory') as boolean;
  const inputHistory = new InputHistory({
    historyPath: services.shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'input-history.json'),
    persist: saveHistory,
  });

  return {
    commandRegistry,
    commandContext,
    inputHistory,
    systemMessageRouter,
  };
}
