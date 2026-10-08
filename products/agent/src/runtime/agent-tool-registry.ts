import { buildAgentConfigRouting } from '../config/daemon-config-routing.ts';
import { ToolRegistry, registerAllTools } from '@goodvibes-jev/engine/sdk/platform/tools';
import { installAgentToolPolicyGuard } from '../tools/agent-tool-policy-guard.ts';
import { installAgentPlatformBoundaryGuard } from '../tools/agent-platform-boundary-policy.ts';
import { registerAgentChannelSendTool } from '../tools/agent-channel-send-tool.ts';
import { registerAgentAutonomyScheduleTool } from '../tools/agent-autonomy-schedule-tool.ts';
import { registerAgentArtifactsTool } from '../tools/agent-artifacts-tool.ts';
import { agentBrowserProfileRoot, agentBrowserScreenshotRoot } from './agent-browser.ts';
import { registerAgentBrowserTool } from '../tools/agent-browser-tool.ts';
import { registerAgentDocumentsTool } from '../tools/agent-documents-tool.ts';
import { registerAgentAccountsTool } from '../tools/agent-accounts-tool.ts';
import { AgentAccountRegistry, ACCOUNT_REGISTRY_PATH_SEGMENTS, ensureGoogleConfigDefaults } from '@goodvibes-jev/engine/sdk/platform/google';
import { containsSecretLikeText } from '../agent/memory-safety.ts';
import { wireAgentGoogleTool, type GoogleToolWiringDeps } from './bootstrap-google-tool.ts';
import { ensureCalendarConfigDefaults } from '@goodvibes-jev/engine/sdk/platform/config';
import { registerAgentKnowledgeIngestTool } from '../tools/agent-knowledge-ingest-tool.ts';
import { registerAgentKnowledgeTool } from '../tools/agent-knowledge-tool.ts';
import { registerAgentLearningConsolidationTool } from '../tools/agent-learning-consolidation-tool.ts';
import { registerAgentLocalRegistryTool } from '../tools/agent-local-registry-tool.ts';
import { registerAgentMediaGenerateTool } from '../tools/agent-media-generate-tool.ts';
import { registerAgentModelCompareTool } from '../tools/agent-model-compare-tool.ts';
import { registerAgentNotifyTool } from '../tools/agent-notify-tool.ts';
import { registerAgentOperatorActionTool } from '../tools/agent-operator-action-tool.ts';
import { registerAgentOperatorBriefingTool } from '../tools/agent-operator-briefing-tool.ts';
import { registerAgentOperatorMethodTool } from '../tools/agent-operator-method-tool.ts';
import { registerAgentReminderScheduleTool } from '../tools/agent-reminder-schedule-tool.ts';
import { registerAgentReviewPacketPresetsTool } from '../tools/agent-review-packet-presets-tool.ts';
import { registerAgentReviewPacketShareTool } from '../tools/agent-review-packet-share-tool.ts';
import { registerAgentResearchReportTool } from '../tools/agent-research-report-tool.ts';
import { registerAgentResearchRunsTool } from '../tools/agent-research-runs-tool.ts';
import { registerAgentResearchSourcesTool } from '../tools/agent-research-sources-tool.ts';
import { registerAgentScheduleEditTool } from '../tools/agent-schedule-edit-tool.ts';
import { registerAgentScheduleTool } from '../tools/agent-schedule-tool.ts';
import { registerAgentWorkPlanTool } from '../tools/agent-work-plan-tool.ts';
import { compactRegisteredToolDefinitions } from '../tools/tool-definition-compaction.ts';
import { installToolExecutionSafetyGuard } from '../tools/tool-execution-safety.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { AGENT_OWNER_TERMINAL_GUARD } from './agent-exec-posture.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { RuntimeServices } from './services.ts';
import type { ProtectedSourceOwner } from '@goodvibes-jev/engine/sdk/platform/security';

/**
 * The main conversation's tool registry, composed exactly once, in one place:
 * the platform tools (with the Agent's owner-terminal posture and daemon config
 * routing), the Agent's own tools, then the Agent's wrappers in order: the tool
 * policy guard, the platform-boundary guard (installed after the policy guard
 * so it wraps the policy-wrapped execute), the execution-safety wrapper, and
 * definition compaction. bootstrap-core.ts calls it for the live shell; the
 * exec refusal-and-kill test calls it too, so a reorder here is what that test
 * runs.
 */
export interface AgentToolRegistryDeps {
  /** Explicit trusted local service capability; absent keeps research report writes held. */
  readonly researchSourceOwner?: ProtectedSourceOwner;
  readonly services: RuntimeServices;
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  /** The runtime session id, read fresh on every call. */
  readonly resolveSessionId: () => string;
  /** What the owner said this turn; the policy and boundary guards read it. */
  readonly getLastUserMessage: () => string | null;
}

export interface AgentToolRegistry {
  readonly toolRegistry: ToolRegistry;
  readonly fileCache: ReturnType<typeof registerAllTools>['fileCache'];
  readonly projectIndex: ReturnType<typeof registerAllTools>['projectIndex'];
}

export function composeAgentToolRegistry(deps: AgentToolRegistryDeps): AgentToolRegistry {
  const { services, configManager, homeDirectory, resolveSessionId, getLastUserMessage } = deps;
  const toolRegistry = new ToolRegistry(services.permissionManager);
  const { fileCache, projectIndex } = registerAllTools(toolRegistry, {
    contractRunner: services.contractRunner,
    projectRoot: services.workingDirectory,
    // Task refs are owned by the REAL runtime session, read fresh on every call:
    // accepting a recovery snapshot reassigns runtime.sessionId in place, and a
    // value captured here would keep writing refs under the session the user
    // just left. Without this the task graph falls back to the shared legacy
    // namespace and nothing is keyed to a session that can be reaped.
    resolveSessionId,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    readAdmissionPolicy: 'agent-main-conversation',
    // ONE file cache and ONE project index for the process. registerAllTools
    // built its own pair when none was passed, so the tools read one index while
    // `services.rerootStores` re-rooted a different one on a workspace swap,
    // the swap took effect nowhere the file tools could see. Passing the graph's
    // pair makes the instance the tools read the instance the graph owns.
    fileCache: services.fileCache,
    projectIndex: services.projectIndex,
    // Daemon-owned settings (surfaces.*, the control-plane binding, watchers,
    // pairing, retention) must be read and written through the daemon that owns
    // them, not through this process's own store. Without this the settings
    // tools silently fall back to the local file: a value written here would
    // configure nothing, and reading it back afterwards would report it unset.
    //
    // The daemon home is derived from THIS process's home rather than the
    // machine's, so a run rooted at a scratch home cannot reach a real daemon.
    // Only an explicit GOODVIBES_DAEMON_HOME overrides that.
    configRouting: buildAgentConfigRouting({ homeDir: homeDirectory }),
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    processManager: services.processManager,
    agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus,
    archetypeLoader: services.archetypeLoader,
    webSearchService: services.webSearchService,
    channelRegistry: services.channelPlugins,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    workflowServices: services.workflow,
    mcpRegistry: services.mcpRegistry,
    sessionOrchestration: services.sessionOrchestration,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    workingDirectory: services.workingDirectory,
    configManager,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    featureFlags: services.featureFlags,
    serviceRegistry: services.serviceRegistry,
    overflowHandler: services.overflowHandler,
    changeTracker: services.sessionChangeTracker,
    // Same holder instance `services.contextAccountingHolder` exposes, the
    // context_accounting tool registered here and the bind call bootstrap.ts
    // makes after constructing the Orchestrator (see
    // context-accounting-source.ts) must share ONE holder, otherwise the tool
    // would read an unbound holder of its own while the real source sits on a
    // different instance nothing reads.
    contextAccountingHolder: services.contextAccountingHolder,
    // A local turn reaches the owner's tmux through the same exec tool a hosted
    // turn does, so the rule is stated here too, see agent-exec-posture.ts.
    ownerTerminalGuard: AGENT_OWNER_TERMINAL_GUARD,
  });
  registerAgentArtifactsTool(toolRegistry, services.artifactStore, { projectRoot: services.shellPaths.workingDirectory });
  registerAgentBrowserTool(toolRegistry, {
    screenshotDirectory: agentBrowserScreenshotRoot(services.shellPaths.homeDirectory),
    profileRoot: agentBrowserProfileRoot(services.shellPaths.homeDirectory),
    homeDirectory: services.shellPaths.homeDirectory,
  });
  // google.* and calendar.* are app-layer sections absent from the SDK schema;
  // resolvePath throws on a section that is not there.
  ensureGoogleConfigDefaults(configManager);
  ensureCalendarConfigDefaults(configManager);
  // The native Gmail/Calendar route, wired in bootstrap-google-tool.ts, its
  // write ports carry an argument long enough to deserve its own file.
  wireAgentGoogleTool(toolRegistry, {
    configManager: configManager as GoogleToolWiringDeps['configManager'],
    secretsManager: services.secretsManager,
    homeDirectory: services.shellPaths.homeDirectory,
  });
  // Accounts the agent creates are recorded here at creation time. Autonomous
  // signup is authorized; doing it invisibly is not, and this is what makes it
  // enumerable and revocable.
  registerAgentAccountsTool(toolRegistry, {
    // The platform registry takes its store path and its "does this look like a
    // credential" rule as inputs rather than deriving either: the path so no
    // product writes into another's storage root, the predicate because the
    // wording of that judgement belongs to the product that shows it.
    registry: new AgentAccountRegistry({
      storePath: services.shellPaths.resolveUserPath(
        GOODVIBES_AGENT_SURFACE_ROOT,
        ...ACCOUNT_REGISTRY_PATH_SEGMENTS,
      ),
      containsSecretLikeText,
    }),
    baseAddress: () => {
      const value = (configManager as { get: (key: string) => unknown }).get('email.fromAddress');
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    },
  });
  registerAgentDocumentsTool(toolRegistry, services.shellPaths, services.artifactStore);
  registerAgentKnowledgeIngestTool(toolRegistry, services.shellPaths, configManager);
  registerAgentChannelSendTool(toolRegistry, services.channelDeliveryRouter, { shellPaths: services.shellPaths });
  registerAgentKnowledgeTool(toolRegistry, services.shellPaths, configManager);
  registerAgentLearningConsolidationTool(toolRegistry, services.shellPaths, services.memoryRegistry);
  registerAgentLocalRegistryTool(toolRegistry, services.shellPaths, services.memoryRegistry, services.memorySpineClient);
  registerAgentMediaGenerateTool(toolRegistry, services.mediaProviders, services.artifactStore);
  registerAgentResearchRunsTool(toolRegistry, services.shellPaths);
  registerAgentResearchSourcesTool(toolRegistry, services.shellPaths);
  registerAgentResearchReportTool(toolRegistry, services.artifactStore, deps.researchSourceOwner);
  registerAgentReviewPacketPresetsTool(toolRegistry, services.artifactStore);
  registerAgentReviewPacketShareTool(toolRegistry, services.artifactStore, services.channelDeliveryRouter);
  registerAgentModelCompareTool(toolRegistry, {
    modelCatalog: services.providerRegistry,
    providerRegistry: services.providerRegistry,
    artifactStore: services.artifactStore,
    applyModelRoute: (registryKey) => {
      const previousModel = String(configManager.get('provider.model') ?? '').trim();
      configManager.set('provider.model', registryKey);
      return {
        ...(previousModel ? { previousModel } : {}),
        selectedModel: registryKey,
      };
    },
  });
  registerAgentNotifyTool(toolRegistry, configManager, services.webhookNotifier);
  registerAgentOperatorActionTool(toolRegistry, services.shellPaths, configManager);
  registerAgentOperatorBriefingTool(toolRegistry, services.shellPaths, configManager);
  registerAgentOperatorMethodTool(toolRegistry, services.shellPaths, configManager);
  registerAgentAutonomyScheduleTool(toolRegistry, services.shellPaths, configManager);
  registerAgentReminderScheduleTool(toolRegistry, services.shellPaths, configManager);
  registerAgentScheduleEditTool(toolRegistry, services.shellPaths, configManager);
  registerAgentScheduleTool(toolRegistry, services.shellPaths, configManager);
  registerAgentWorkPlanTool(toolRegistry, services.workPlanStore);
  installAgentToolPolicyGuard(toolRegistry, {
    getLastUserMessage: getLastUserMessage,
  });
  // The conversational-session boundary: platform source is not touched as a
  // means of self-repair in a turn that asked for something else. Installed
  // AFTER the policy guard so it wraps the policy-wrapped execute rather than
  // the other way round, the boundary question ("did he ask for this at all")
  // is answered before the read policy is asked what shape the read may take.
  // Reads his own words this turn through the same conversation accessor, which
  // is the only thing that distinguishes self-directed repair from a read he
  // requested.
  installAgentPlatformBoundaryGuard(toolRegistry, getLastUserMessage);
  installToolExecutionSafetyGuard(toolRegistry);
  compactRegisteredToolDefinitions(toolRegistry);
  return { toolRegistry, fileCache, projectIndex };
}
