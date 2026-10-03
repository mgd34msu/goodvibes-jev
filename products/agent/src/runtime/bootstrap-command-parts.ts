import { getConfigSnapshot } from '../config/index.ts';
import { describeServingEffort, publishActiveEffortOptions, resolveRequestedEffortForServingModel, toEffortModel } from '../providers/reasoning-effort-surface.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { AdaptivePlanner } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { KnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { AgentPromptContextReceiptStore } from '../agent/prompt-context-receipts.ts';
import type { HookApi } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { McpApi } from '@goodvibes-jev/engine/sdk/platform/mcp';
import type { ProviderApi } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { CommandContext } from '../input/command-registry.ts';
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
  RemoteCommandService,
  PlanRuntimeService,
} from '@/runtime/index.ts';
import type { BootstrapCommandShellServices } from '@/runtime/index.ts';
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
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { ConsolidationReceiptSource } from '../agent/memory-consolidation-proposals.ts';
import { listPendingConsolidationProposals } from '../agent/memory-consolidation-proposals.ts';
import { activeTokens } from '../renderer/theme.ts';

export type BootstrapCommandSessionSection = CommandContext['session'];
export type BootstrapCommandProviderSection = CommandContext['provider'];
export type BootstrapCommandWorkspaceSection = CommandContext['workspace'];
export type BootstrapCommandPlatformSection = CommandContext['platform'];
export type BootstrapCommandOpsSection = CommandContext['ops'];
export type BootstrapCommandExtensionSection = CommandContext['extensions'];
export type BootstrapCommandClientSection = NonNullable<CommandContext['clients']>;

export interface BootstrapCommandActionOptions {
  readonly providerRegistry: ProviderRegistry;
  readonly configManager: ConfigManager;
  readonly conversation: ConversationManager;
  readonly runtime: MutableRuntimeState;
  readonly requestRender: () => void;
  readonly loadSystemPrompt: () => string;
  readonly activatePlan: (planId: string, task: string) => void;
  readonly requestPermission: PermissionRequestHandler;
  readonly completeModelSelectionSideEffect?: () => void;
}

export interface BootstrapCommandSectionOptions {
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  readonly conversation: ConversationManager;
  readonly runtime: MutableRuntimeState;
  readonly keybindingsManager?: KeybindingsManager;
  readonly processManager?: import('@goodvibes-jev/engine/sdk/platform/tools').ProcessManager;
  readonly requestRender: () => void;
  readonly requestPermission: PermissionRequestHandler;
  readonly toolRegistry: ToolRegistry;
  readonly mcpRegistry: McpRegistry;
  readonly voiceProviderRegistry?: VoiceProviderRegistry;
  readonly voiceService?: VoiceService;
  readonly voiceSetup?: AgentVoiceSetupService;
  readonly memoryGovernor?: AgentMemoryDiagnostics;
  readonly mediaProviderRegistry?: MediaProviderRegistry;
  readonly artifactStore?: ArtifactStore;
  readonly channelDeliveryRouter?: ChannelDeliveryRouter;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly readModels: UiReadModels;
  readonly shellPaths: ShellPathService;
  readonly fileUndoManager: FileUndoManager;
  readonly executionLedger?: AgentExecutionLedger;
  readonly approvalsView?: ApprovalsView;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly projectPlanningService?: import('@goodvibes-jev/engine/sdk/platform/knowledge').ProjectPlanningService;
  readonly projectPlanningProjectId?: string;
  readonly workPlanStore?: import('@goodvibes-jev/engine/sdk/platform/workflow').WorkPlanStore;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
  readonly providerOptimizer?: import('@goodvibes-jev/engine/sdk/platform/providers').ProviderOptimizer;
  readonly sessionManager?: import('@goodvibes-jev/engine/sdk/platform/sessions').SessionManager;
  readonly profileManager?: import('@goodvibes-jev/engine/sdk/platform/profiles').ProfileManager;
  readonly bookmarkManager?: import('@goodvibes-jev/engine/sdk/platform/bookmarks').BookmarkManager;
  readonly favoritesStore?: import('@goodvibes-jev/engine/sdk/platform/providers').FavoritesStore;
  readonly benchmarkStore?: import('@goodvibes-jev/engine/sdk/platform/providers').BenchmarkStore;
  readonly subscriptionManager?: import('@goodvibes-jev/engine/sdk/platform/config').SubscriptionManager;
  readonly secretsManager?: import('../config/secrets.ts').SecretsManager;
  readonly serviceRegistry?: import('@goodvibes-jev/engine/sdk/platform/config').ServiceRegistry;
  readonly localUserAuthManager?: import('@goodvibes-jev/engine/sdk/platform/security').UserAuthManager;
  readonly tokenAuditor?: import('@goodvibes-jev/engine/sdk/platform/security').ApiTokenAuditor;
  readonly replayEngine?: import('@goodvibes-jev/engine/sdk/platform/core').DeterministicReplayEngine;
  readonly webhookNotifier?: import('@goodvibes-jev/engine/sdk/platform/integrations').WebhookNotifier;
  readonly sessionMemoryStore?: import('@goodvibes-jev/engine/sdk/platform/core').SessionMemoryStore;
  readonly sessionLineageTracker?: import('@goodvibes-jev/engine/sdk/platform/core').SessionLineageTracker;
  readonly changeTracker?: import('@goodvibes-jev/engine/sdk/platform/sessions').SessionChangeTracker;
  readonly writeLastSessionPointer?: (sessionId: string) => void;
  /** Reload a resumed session's persisted rewind anchors. Bound at bootstrap to the runtime's SessionSurface; returns how many were restored. */
  readonly restoreTurnAnchors?: (sessionId: string) => number;
  readonly surface?: import('@/runtime/index.ts').SessionSurface;
  readonly hydrateSessionUsage?: () => void;
  readonly agentManager?: ShellAgentManagerService;
  readonly modeManager?: ShellModeManagerService;
  readonly automationManager?: ShellAutomationManagerRuntimeService;
  readonly planManager?: ShellPlanManagerService;
  readonly adaptivePlanner?: AdaptivePlanner;
  readonly sessionOrchestration?: ShellSessionOrchestrationService;
  readonly remoteRuntime?: RemoteCommandService;
  readonly planRuntime?: PlanRuntimeService;
  readonly operatorClient?: OperatorClient;
  readonly peerClient?: PeerClient;
  readonly providerApi?: ProviderApi;
  readonly agentKnowledgeApi?: KnowledgeApi;
  readonly promptContextReceipts?: AgentPromptContextReceiptStore;
  readonly hookApi?: HookApi;
  readonly mcpApi?: McpApi;
  readonly opsApi?: OpsApi;
  readonly directTransport?: DirectTransport;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  /**
   * The runtime's own memory-consolidation scheduler, exposed to the memory
   * review surface (input/commands/recall-review.ts) as
   * clients.memoryConsolidation, see agent/memory-consolidation-proposals.ts.
   */
  readonly memoryConsolidationScheduler?: ConsolidationReceiptSource;
}

function unwiredShellAction(name: string): never {
  throw new Error(`Agent runtime action "${name}" was called before the operator route was attached.`);
}

export function createBootstrapCommandActions(
  options: BootstrapCommandActionOptions,
): Pick<
  CommandContext,
  | 'renderRequest'
  | 'submitInput'
  | 'executeCommand'
  | 'cancelGeneration'
  | 'clearScreen'
  | 'activatePlan'
  | 'requestPermission'
  | 'completeModelSelection'
  | 'jumpToBookmark'
  | 'scrollToLine'
  | 'print'
  | 'exit'
  | 'reloadSystemPrompt'
  | 'openMcpWorkspace'
  | 'openAgentWorkspace'
  | 'dismissAgentWorkspace'
  | 'openSecurityWorkspace'
  | 'openKnowledgeWorkspace'
  | 'openSubscriptionWorkspace'
> {
  const {
    providerRegistry,
    configManager,
    conversation,
    runtime,
    requestRender,
    loadSystemPrompt,
    activatePlan,
    requestPermission,
    completeModelSelectionSideEffect,
  } = options;

  const pointToWorkspace = (what: string) => {
    conversation.log(`${what} lives in the Agent workspace, press Ctrl+P or run /agent.`, { fg: activeTokens().warning });
    requestRender();
  };

  return {
    renderRequest: requestRender,
    submitInput: () => unwiredShellAction('submitInput'),
    executeCommand: async () => unwiredShellAction('executeCommand'),
    cancelGeneration: () => unwiredShellAction('cancelGeneration'),
    clearScreen: () => unwiredShellAction('clearScreen'),
    activatePlan,
    requestPermission: (request) => requestPermission(request),
    completeModelSelection: ({ model, effort, contextCap, target, effortChosenByUser }) => {
      if (!model) return;
      const def = model;
      const key = def.registryKey ?? `${def.provider}:${def.id}`;
      const resolvedTarget = target ?? 'main';
      try {
        if (resolvedTarget === 'helper') {
          // Write to helper config keys and enable the helper
          configManager.set('helper.globalProvider', def.provider);
          configManager.set('helper.globalModel', key);
          configManager.set('helper.enabled', true);
          conversation.log(`Helper model set to: ${def.displayName} (${def.provider})`, { fg: activeTokens().secondary });
        } else if (resolvedTarget === 'tool') {
          // Write to tool LLM config keys and enable the tool LLM
          configManager.set('tools.llmProvider', def.provider);
          configManager.set('tools.llmModel', key);
          configManager.setDynamic('tools.llmEnabled', true);
          conversation.log(`Tool LLM set to: ${def.displayName} (${def.provider})`, { fg: activeTokens().secondary });
        } else if (resolvedTarget === 'tts') {
          configManager.set('tts.llmProvider', def.provider);
          configManager.set('tts.llmModel', key);
          conversation.log(`TTS LLM set to: ${def.displayName} (${def.provider})`, { fg: activeTokens().secondary });
        } else {
          // Default: main provider/model
          if (contextCap != null && contextCap > 0) {
            providerRegistry.setModelContextCap(key, contextCap);
          }
          providerRegistry.setCurrentModel(key);
          runtime.model = key;
          runtime.provider = def.provider;
          // Two levels, kept apart on purpose. Config `provider.reasoningEffort`
          // holds what the USER asked for; `runtime.reasoningEffort` holds what
          // the model now serving will actually receive, which is the requested
          // level snapped DOWN to this model's own levels.
          //
          // The picker's effort STEP is the only user choice here, and only it
          // writes the preference. That step is skipped for a model with
          // nothing configurable, so `effort` can otherwise be a level merely
          // carried over from whatever was selected before; storing that is
          // what used to ratchet the preference down for good, one hop
          // through a model that caps at 'medium' and 'xhigh' was gone from
          // config, so hopping back could not restore it.
          //
          // A stored 'xhigh' that becomes 'high' on the wire would make a
          // single-value display a lie, so the display carries BOTH values with
          // their provenance (describeServingEffort) rather than the preference
          // being corrupted to match.
          const switchedTo = toEffortModel(providerRegistry.getCurrentModel());
          // Publish this model's real levels first, so both the preference
          // write below and any later `config set provider.reasoningEffort`
          // are validated against them.
          publishActiveEffortOptions(switchedTo, runtime.sessionId);
          if (effortChosenByUser && effort) configManager.set('provider.reasoningEffort', effort);
          const serving = resolveRequestedEffortForServingModel(configManager, switchedTo);
          runtime.reasoningEffort = serving.effective ?? '';
          configManager.set('provider.model', key);
          const ctxNote = contextCap != null && contextCap > 0
            ? `, context cap: ${contextCap.toLocaleString()}`
            : '';
          const effortNote = serving.requested !== '' ? `, effort: ${describeServingEffort(serving, switchedTo)}` : '';
          conversation.log(`Switched to model: ${def.displayName} (${def.provider})${effortNote}${ctxNote}`, { fg: activeTokens().secondary });
          if (serving.note) conversation.log(serving.note, { fg: activeTokens().secondary });
        }
      } catch (e) {
        conversation.log(`Error switching model: ${summarizeError(e)}`, { fg: activeTokens().error });
      }
      completeModelSelectionSideEffect?.();
      requestRender();
    },
    jumpToBookmark: () => unwiredShellAction('jumpToBookmark'),
    scrollToLine: () => unwiredShellAction('scrollToLine'),
    print: (text: string) => {
      conversation.log(text, { fg: activeTokens().text });
      requestRender();
    },
    exit: () => unwiredShellAction('exit'),
    reloadSystemPrompt: loadSystemPrompt,
    openMcpWorkspace: () => unwiredShellAction('openMcpWorkspace'),
    openAgentWorkspace: () => unwiredShellAction('openAgentWorkspace'),
    dismissAgentWorkspace: () => unwiredShellAction('dismissAgentWorkspace'),
    openSecurityWorkspace: () => {
      pointToWorkspace('Security review');
    },
    openKnowledgeWorkspace: () => {
      pointToWorkspace('Knowledge');
    },
    openSubscriptionWorkspace: () => {
      pointToWorkspace('Provider subscriptions');
    },
  };
}

export function createBootstrapCommandSessionSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'conversation' | 'runtime' | 'sessionManager' | 'sessionMemoryStore' | 'sessionLineageTracker' | 'changeTracker' | 'writeLastSessionPointer' | 'restoreTurnAnchors'
    | 'surface' | 'hydrateSessionUsage'
  >,
): BootstrapCommandSessionSection {
  return {
    conversationManager: options.conversation,
    runtime: options.runtime,
    sessionManager: options.sessionManager,
    sessionMemoryStore: options.sessionMemoryStore,
    sessionLineageTracker: options.sessionLineageTracker,
    changeTracker: options.changeTracker,
    writeLastSessionPointer: options.writeLastSessionPointer,
    restoreTurnAnchors: options.restoreTurnAnchors,
    surface: options.surface,
    hydrateSessionUsage: options.hydrateSessionUsage,
  };
}

export function createBootstrapCommandProviderSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'providerRegistry' | 'providerOptimizer' | 'favoritesStore' | 'benchmarkStore'
  >,
): BootstrapCommandProviderSection {
  return {
    providerRegistry: options.providerRegistry,
    providerOptimizer: options.providerOptimizer,
    favoritesStore: options.favoritesStore,
    benchmarkStore: options.benchmarkStore,
  };
}

export function createBootstrapCommandWorkspaceSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'keybindingsManager' | 'fileUndoManager' | 'profileManager' | 'bookmarkManager'
    | 'processManager' | 'projectPlanningService' | 'projectPlanningProjectId' | 'workPlanStore'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandWorkspaceSection {
  return {
    keybindingsManager: options.keybindingsManager,
    fileUndoManager: options.fileUndoManager,
    processManager: options.processManager,
    profileManager: options.profileManager,
    bookmarkManager: options.bookmarkManager,
    projectPlanningService: options.projectPlanningService,
    projectPlanningProjectId: options.projectPlanningProjectId,
    workPlanStore: options.workPlanStore,
    ...shellServices.workspace,
  };
}

export function createBootstrapCommandPlatformSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'configManager' | 'voiceProviderRegistry' | 'voiceService' | 'voiceSetup' | 'memoryGovernor' | 'mediaProviderRegistry' | 'artifactStore' | 'channelDeliveryRouter'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandPlatformSection {
  return {
    config: getConfigSnapshot(options.configManager),
    configManager: options.configManager,
    voiceProviderRegistry: options.voiceProviderRegistry,
    voiceService: options.voiceService,
    voiceSetup: options.voiceSetup,
    memoryGovernor: options.memoryGovernor,
    mediaProviderRegistry: options.mediaProviderRegistry,
    artifactStore: options.artifactStore,
    channelDeliveryRouter: options.channelDeliveryRouter,
    ...shellServices.platform,
  };
}

export function createBootstrapCommandOpsSection(
  shellServices: BootstrapCommandShellServices,
  options: Pick<BootstrapCommandSectionOptions, 'executionLedger' | 'approvalsView'> = {},
): BootstrapCommandOpsSection {
  return {
    ...shellServices.ops,
    executionLedger: options.executionLedger,
    approvalsView: options.approvalsView,
  };
}

export function createBootstrapCommandExtensionsSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'toolRegistry' | 'mcpRegistry'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandExtensionSection {
  const shellExtensionServices = shellServices.extensions;
  return {
    toolRegistry: options.toolRegistry,
    mcpRegistry: options.mcpRegistry,
    ...shellExtensionServices,
    agentKnowledgeService: shellExtensionServices.knowledgeService,
  };
}

export function createBootstrapCommandClientsSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'operatorClient' | 'peerClient' | 'providerApi' | 'agentKnowledgeApi' | 'promptContextReceipts' | 'hookApi' | 'mcpApi' | 'opsApi' | 'directTransport' | 'memoryConsolidationScheduler'
  >,
): BootstrapCommandClientSection {
  const memoryConsolidationScheduler = options.memoryConsolidationScheduler;
  return {
    operator: options.operatorClient,
    peer: options.peerClient,
    providerApi: options.providerApi,
    agentKnowledgeApi: options.agentKnowledgeApi,
    promptContextReceipts: options.promptContextReceipts,
    hookApi: options.hookApi,
    mcpApi: options.mcpApi,
    opsApi: options.opsApi,
    ...(memoryConsolidationScheduler
      ? { memoryConsolidation: { listPendingProposals: () => listPendingConsolidationProposals(memoryConsolidationScheduler) } }
      : {}),
    transport: options.directTransport,
  };
}
