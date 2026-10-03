import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { AdaptivePlanner } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { KnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { HookApi } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { McpApi } from '@goodvibes-jev/engine/sdk/platform/mcp';
import type { ProviderApi } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { CommandContext } from '../input/command-registry.ts';
import type { AgentPromptContextReceiptStore } from '../agent/prompt-context-receipts.ts';
import type { ConsolidationReceiptSource } from '../agent/memory-consolidation-proposals.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import type { MemoryRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import type { IntegrationHelperService } from '@/runtime/index.ts';
import type { KnowledgeService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { PluginManager } from '@goodvibes-jev/engine/sdk/platform/plugins';
import type { HookWorkbench } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { WorktreeRegistry } from '@/runtime/index.ts';
import type { SandboxSessionRegistry } from '@/runtime/index.ts';
import type { UiReadModels } from './ui-read-models.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import type {
  ShellAgentManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
} from '@/runtime/index.ts';
import { createBootstrapCommandShellServices, type PlanRuntimeService, type RemoteCommandService } from '@/runtime/index.ts';
import type { OperatorClient } from '@/runtime/index.ts';
import type { PeerClient } from '@/runtime/index.ts';
import type { DirectTransport } from '@/runtime/index.ts';
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes-jev/engine/sdk/platform/voice';
import type { AgentMemoryDiagnostics, AgentVoiceSetupService } from './services.ts';
import type { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import type { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { AgentExecutionLedger } from './execution-ledger.ts';
import type { ApprovalsView } from './client/approvals-view.ts';
import {
  createBootstrapCommandActions,
  createBootstrapCommandClientsSection,
  createBootstrapCommandExtensionsSection,
  createBootstrapCommandOpsSection,
  createBootstrapCommandPlatformSection,
  createBootstrapCommandProviderSection,
  createBootstrapCommandSessionSection,
  createBootstrapCommandWorkspaceSection,
} from './bootstrap-command-parts.ts';

export type CreateBootstrapCommandContextOptions = {
  configManager: ConfigManager;
  providerRegistry: ProviderRegistry;
  conversation: ConversationManager;
  runtime: MutableRuntimeState;
  requestRender: () => void;
  keybindingsManager?: KeybindingsManager;
  requestPermission: PermissionRequestHandler;
  toolRegistry: ToolRegistry;
  mcpRegistry: McpRegistry;
  voiceProviderRegistry?: VoiceProviderRegistry;
  voiceService?: VoiceService;
  voiceSetup?: AgentVoiceSetupService;
  memoryGovernor?: AgentMemoryDiagnostics;
  mediaProviderRegistry?: MediaProviderRegistry;
  artifactStore?: ArtifactStore;
  channelDeliveryRouter?: ChannelDeliveryRouter;
  forensicsRegistry: ForensicsRegistry;
  policyRuntimeState: PolicyRuntimeState;
  readModels: UiReadModels;
  shellPaths: ShellPathService;
  remoteRuntime?: RemoteCommandService;
  planRuntime?: PlanRuntimeService;
  fileUndoManager: FileUndoManager;
  processManager?: import('@goodvibes-jev/engine/sdk/platform/tools').ProcessManager;
  executionLedger?: AgentExecutionLedger;
  approvalsView?: ApprovalsView;
  memoryRegistry?: MemoryRegistry;
  integrationHelpers?: IntegrationHelperService;
  automationManager?: ShellAutomationManagerRuntimeService;
  knowledgeService?: KnowledgeService;
  projectPlanningService?: import('@goodvibes-jev/engine/sdk/platform/knowledge').ProjectPlanningService;
  projectPlanningProjectId?: string;
  workPlanStore?: import('@goodvibes-jev/engine/sdk/platform/workflow').WorkPlanStore;
  providerOptimizer?: import('@goodvibes-jev/engine/sdk/platform/providers').ProviderOptimizer;
  pluginManager?: PluginManager;
  hookWorkbench?: HookWorkbench;
  agentManager?: ShellAgentManagerService;
  modeManager?: ShellModeManagerService;
  sessionManager?: import('@goodvibes-jev/engine/sdk/platform/sessions').SessionManager;
  profileManager?: import('@goodvibes-jev/engine/sdk/platform/profiles').ProfileManager;
  bookmarkManager?: import('@goodvibes-jev/engine/sdk/platform/bookmarks').BookmarkManager;
  favoritesStore?: import('@goodvibes-jev/engine/sdk/platform/providers').FavoritesStore;
  benchmarkStore?: import('@goodvibes-jev/engine/sdk/platform/providers').BenchmarkStore;
  providerApi?: ProviderApi;
  subscriptionManager?: import('@goodvibes-jev/engine/sdk/platform/config').SubscriptionManager;
  secretsManager?: import('../config/secrets.ts').SecretsManager;
  serviceRegistry?: import('@goodvibes-jev/engine/sdk/platform/config').ServiceRegistry;
  localUserAuthManager?: import('@goodvibes-jev/engine/sdk/platform/security').UserAuthManager;
  tokenAuditor?: import('@goodvibes-jev/engine/sdk/platform/security').ApiTokenAuditor;
  replayEngine?: import('@goodvibes-jev/engine/sdk/platform/core').DeterministicReplayEngine;
  webhookNotifier?: import('@goodvibes-jev/engine/sdk/platform/integrations').WebhookNotifier;
  sessionMemoryStore?: import('@goodvibes-jev/engine/sdk/platform/core').SessionMemoryStore;
  changeTracker?: import('@goodvibes-jev/engine/sdk/platform/sessions').SessionChangeTracker;
  planManager?: ShellPlanManagerService;
  adaptivePlanner?: AdaptivePlanner;
  sessionOrchestration?: ShellSessionOrchestrationService;
  operatorClient?: OperatorClient;
  peerClient?: PeerClient;
  agentKnowledgeApi?: KnowledgeApi;
  promptContextReceipts?: AgentPromptContextReceiptStore;
  hookApi?: HookApi;
  mcpApi?: McpApi;
  opsApi?: OpsApi;
  directTransport?: DirectTransport;
  worktreeRegistry: WorktreeRegistry;
  sandboxSessionRegistry: SandboxSessionRegistry;
  memoryConsolidationScheduler?: ConsolidationReceiptSource;
  loadSystemPrompt: () => string;
  activatePlan: (planId: string, task: string) => void;
  completeModelSelectionSideEffect?: () => void;
  sessionLineageTracker?: import('@goodvibes-jev/engine/sdk/platform/core').SessionLineageTracker;
  componentHealthMonitor: import('@/runtime/index.ts').ComponentHealthMonitor;
  writeLastSessionPointer?: (sessionId: string) => void;
  restoreTurnAnchors?: (sessionId: string) => number;
  surface?: import('@/runtime/index.ts').SessionSurface;
  hydrateSessionUsage?: () => void;
};

export function createBootstrapCommandContext(
  options: CreateBootstrapCommandContextOptions,
): CommandContext {
  const {
    providerRegistry,
    configManager,
    conversation,
    runtime,
    requestRender,
    keybindingsManager,
    requestPermission,
    toolRegistry,
    mcpRegistry,
    voiceProviderRegistry,
    voiceService,
    voiceSetup,
    memoryGovernor,
    mediaProviderRegistry,
    artifactStore,
    channelDeliveryRouter,
    forensicsRegistry,
    policyRuntimeState,
    readModels,
    shellPaths,
    remoteRuntime,
    planRuntime,
    fileUndoManager,
    processManager,
    executionLedger,
    approvalsView,
    memoryRegistry,
    integrationHelpers,
    automationManager,
    knowledgeService,
    projectPlanningService,
    projectPlanningProjectId,
    workPlanStore,
    providerOptimizer,
    pluginManager,
    hookWorkbench,
    agentManager,
    modeManager,
    sessionManager,
    profileManager,
    bookmarkManager,
    favoritesStore,
    benchmarkStore,
    providerApi,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
    sessionMemoryStore,
    sessionLineageTracker,
    changeTracker,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    operatorClient,
    peerClient,
    agentKnowledgeApi,
    promptContextReceipts,
    hookApi,
    mcpApi,
    opsApi,
    directTransport,
    worktreeRegistry,
    sandboxSessionRegistry,
    loadSystemPrompt,
    activatePlan,
    completeModelSelectionSideEffect,
    componentHealthMonitor,
    memoryConsolidationScheduler,
    writeLastSessionPointer,
    restoreTurnAnchors,
    surface,
    hydrateSessionUsage,
  } = options;

  const shellServices = createBootstrapCommandShellServices({
    agentManager,
    automationManager,
    modeManager,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    shellPaths,
    componentHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
    readModels,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
    remoteRuntime,
    planRuntime,
    forensicsRegistry,
    policyRuntimeState,
    memoryRegistry,
    integrationHelpers,
    knowledgeService,
    pluginManager,
    hookWorkbench,
  });
  const session = createBootstrapCommandSessionSection({
    conversation,
    runtime,
    sessionManager,
    sessionMemoryStore,
    sessionLineageTracker,
    changeTracker,
    writeLastSessionPointer,
    restoreTurnAnchors,
    surface,
    hydrateSessionUsage,
  });
  const provider = createBootstrapCommandProviderSection({
    providerRegistry,
    providerOptimizer,
    favoritesStore,
    benchmarkStore,
  });
  const workspace = createBootstrapCommandWorkspaceSection({
    keybindingsManager,
    fileUndoManager,
    processManager,
    profileManager,
    bookmarkManager,
    projectPlanningService,
    projectPlanningProjectId,
    workPlanStore,
  }, shellServices);
  const platform = createBootstrapCommandPlatformSection({ configManager, voiceProviderRegistry, voiceService, voiceSetup, memoryGovernor, mediaProviderRegistry, artifactStore, channelDeliveryRouter }, shellServices);
  const extensions = createBootstrapCommandExtensionsSection({
    toolRegistry,
    mcpRegistry,
  }, shellServices);
  const clients = createBootstrapCommandClientsSection({
    operatorClient,
    peerClient,
    agentKnowledgeApi,
    promptContextReceipts,
    providerApi,
    hookApi,
    mcpApi,
    opsApi,
    directTransport,
    memoryConsolidationScheduler,
  });
  const actions = createBootstrapCommandActions({
    providerRegistry,
    configManager,
    conversation,
    runtime,
    requestRender,
    loadSystemPrompt,
    activatePlan,
    requestPermission,
    completeModelSelectionSideEffect,
  });

  return {
    session,
    provider,
    workspace,
    platform,
    ops: createBootstrapCommandOpsSection(shellServices, { executionLedger, approvalsView }),
    extensions,
    clients,
    ...actions,
  };
}
