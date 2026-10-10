import { assertCurrentToolExecution } from '@goodvibes-jev/engine/sdk/platform/tools';
import { processClassificationOptions } from './agent-harness-process-launch.ts';
import { createProcessInputProjector } from './agent-process-ingress.ts';
import { createPersonalOpsInputProjector } from './agent-personal-ops-ingress.ts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import { createAgentHarnessResearchProjector, protectAgentHarnessResearchTool } from './agent-research-ingress.ts';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { agentOrchestrationCatalogStatus, agentOrchestrationSummary, describeAgentOrchestrationAgent } from './agent-harness-agent-orchestration.ts';
import { autonomyIntakeSummary } from './agent-harness-autonomy-intake.ts';
import { autonomyQueueCatalogStatus, autonomyQueueSummary, describeAutonomyQueueItem } from './agent-harness-autonomy-queue.ts';
import { channelReadinessCatalogStatus, describeHarnessChannel, describeHarnessChannelDeliveries, describeHarnessChannelSetupGuide, describeHarnessChannelTriage, listHarnessChannels } from './agent-harness-channel-metadata.ts';
import { blockedHarnessCliCommandTokens, describeHarnessCliCommand, listHarnessCliCommands, totalHarnessCliCommands } from './agent-harness-cli-metadata.ts';
import { describeHarnessCommand, searchHarnessCommands } from './agent-harness-command-catalog.ts';
import { describeLearningCandidate, learningCuratorCatalogStatus, learningCuratorSummary } from './agent-harness-learning-curator.ts';
import { runAutoPromoter } from './agent-harness-learning-auto-promote.ts';
import { runSkillDraftProposer } from '../agent/skill-draft-runner.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { delegationPostureCatalogStatus, delegationPostureSummary, describeHarnessDelegationRoute } from './agent-harness-delegation-posture.ts';
import { describeHarnessKeybinding, listHarnessKeybindings, listHarnessShortcuts, resetHarnessKeybinding, runHarnessKeybinding, setHarnessKeybinding, totalHarnessKeybindings, totalHarnessShortcuts } from './agent-harness-keybinding-metadata.ts';
import { describeHarnessMediaProvider, mediaPostureCatalogStatus, mediaPostureSummary } from './agent-harness-media-posture.ts';
import { describeHarnessNotificationTarget, listHarnessNotificationTargets, notificationTargetCatalogStatus } from './agent-harness-notification-metadata.ts';
import { connectedHostStatusSummary } from './agent-harness-connected-host-status.ts';
import { backgroundProcessCatalogStatus, backgroundProcessSummary, describeBackgroundProcess, runBackgroundProcessAction } from './agent-harness-background-processes.ts';
import { describeDocumentOpsLane, documentOpsCatalogStatus, documentOpsSummary } from './agent-harness-document-ops.ts';
import { browserControlRouteSummary } from './agent-harness-browser-control.ts';
import { describeExecutionHistoryItem, executionHistoryCatalogStatus, executionHistorySummary } from './agent-harness-execution-history.ts';
import { describeHarnessExecutionRoute, executionPostureCatalogStatus, executionPostureSummary } from './agent-harness-execution-posture.ts';
import { fileRecoveryCatalogStatus, fileRecoverySummary, runFileRecovery } from './agent-harness-file-recovery.ts';
import { describeHarnessMcpServer, mcpServerCatalogStatus, mcpServerSummary } from './agent-harness-mcp-metadata.ts';
import { describeHarnessModelRoute, modelRoutingCatalogStatus, modelRoutingSummary, runLocalModelServerSmoke } from './agent-harness-model-routing.ts';
import { describeHarnessModelTool, describeUnknownModelTool, searchHarnessModelTools } from './agent-harness-model-tool-catalog.ts';
import { describeMemoryProvider, memoryPostureCatalogStatus, memoryPostureSummary } from './agent-harness-memory-posture.ts';
import { memoryRefinementCatalogStatus, memoryRefinementSummary, runMemoryRefinement } from './agent-harness-memory-refinement.ts';
import { describeHarnessOperatorMethod, operatorMethodCatalogStatus, operatorMethodSummary } from './agent-harness-operator-methods.ts';
import { describePersonalOpsLane, personalOpsBriefingSummary, personalOpsCatalogStatus, personalOpsIntakeSummary, personalOpsQueueSummary, personalOpsSummary, runPersonalOpsRead } from './agent-harness-personal-ops.ts';
import { describeHarnessPairingRoute, pairingPostureCatalogStatus, pairingPostureSummary } from './agent-harness-pairing-posture.ts';
import { explainAgentPolicyDecision } from './agent-policy-explanation.ts';
import { promptContextCatalogStatus, promptContextSummary } from './agent-harness-prompt-context.ts';
import { describeProjectContextFile, projectContextCatalogStatus, projectContextSummary } from './agent-harness-project-context.ts';
import { describeHarnessProviderAccount, providerAccountCatalogStatus, providerAccountSummary } from './agent-harness-provider-account-metadata.ts';
import { planAgentTaskRoute } from './agent-route-planner.ts';
import { describeHarnessReleaseEvidenceArtifact, releaseEvidenceBundleStatus, releaseEvidenceSummary } from './agent-harness-release-evidence.ts';
import { describeHarnessReleaseReadinessItem, releaseReadinessInventoryStatus, releaseReadinessSummary } from './agent-harness-release-readiness.ts';
import { researchBriefingCatalogStatus, researchBriefingSummary } from './agent-harness-research-briefing.ts';
import { describeResearchRun, researchRunsCatalogStatus, researchRunsSummary } from './agent-harness-research-runs.ts';
import { researchWorkflowSummary } from './agent-harness-research-workflow.ts';
import { describeResearchSource, researchQueueCatalogStatus, researchQueueSummary } from './agent-harness-research-queue.ts';
import { describeHarnessSecurityFinding, describeHarnessSupportBundle, securityPostureCatalogStatus, securityPostureSummary, supportBundleCatalogStatus, supportBundleSummary } from './agent-harness-security-posture.ts';
import { describeHarnessSession, sessionCatalogStatus, sessionSummary } from './agent-harness-session-metadata.ts';
import { describeHarnessServiceEndpoint, servicePostureCatalogStatus, servicePostureSummary } from './agent-harness-service-posture.ts';
import { clearSetupCheckpoint, describeHarnessSetupItem, markSetupCheckpoint, provisionConnectedHostOperatorToken, runSetupInstallSmoke, setupCheckpointSummary, setupPostureCatalogStatus, setupPostureSummary, setupRepairSummary } from './agent-harness-setup-posture.ts';
import { AGENT_HARNESS_MODES, AGENT_HARNESS_PARAMETER_PROPERTIES } from './agent-harness-tool-schema.ts';
import { runCommand } from './agent-harness-command-runner.ts';
import { runWorkspaceAction } from './agent-harness-workspace-action-runner.ts';
import type { AgentHarnessToolArgs, AgentHarnessToolDeps } from './agent-harness-tool-types.ts';
import { catalogEnvelope, catalogFilters, error, output, readLimit, readString, requireConfirmedAction, settingLookupArgs } from './agent-harness-tool-utils.ts';
import { CATALOG_QUERIES as CQ } from './agent-harness-catalog-filters.ts';
import { describeHarnessMode, HARNESS_MODE_DESCRIPTORS, listHarnessModes, type AgentHarnessMode } from './agent-harness-mode-catalog.ts';
import { describeHarnessUiSurface, listHarnessUiSurfaces, openHarnessUiSurface, totalHarnessUiSurfaces } from './agent-harness-ui-surface-metadata.ts';
import { AGENT_WORKSPACE_CATEGORIES, allWorkspaceActions, buildWorkspaceEditorContext, describeWorkspaceAction, describeWorkspaceCategory, listWorkspaceActions, resolveWorkspaceActionDetail } from './agent-harness-workspace-actions.ts';
import { connectedHostSummary, describeConnectedHostCapability, settingsPolicySummary } from './agent-harness-metadata.ts';
import { countHarnessSettingCatalog, formatHarnessError, resetHarnessSetting, resolveEffectiveHarnessSetting, setHarnessSetting } from '../agent/harness-control.ts';
import { harnessSettingsCatalog } from './agent-harness-settings-catalog.ts';
import { buildAssistantCockpitFromSummaries } from '../agent/assistant-cockpit.ts';
import { remoteCatalogStatus, remotePairApproveHandoff, remotePairRejectHandoff, remotePairRequestsSummary, remotePeersInvokeHandoff, remotePeersSummary, remoteSnapshotSummary, remoteWorkCancelHandoff, remoteWorkSummary } from './agent-harness-remote.ts';
import { channelDraftSaveHandoff, channelDraftSendHandoff, channelDraftsSummary, channelRoutingAssignHandoff, channelRoutingRemoveHandoff, channelRoutingSummary, unifiedInboxSummary } from './agent-harness-comms.ts';

function isMode(value: unknown): value is AgentHarnessMode {
  return typeof value === 'string' && AGENT_HARNESS_MODES.includes(value as AgentHarnessMode);
}

function harnessModeIdsByKind(kind: AgentHarnessModeGuideKind): readonly AgentHarnessMode[] {
  return HARNESS_MODE_DESCRIPTORS
    .filter((descriptor) => descriptor.kind === kind)
    .map((descriptor) => descriptor.id);
}

type AgentHarnessModeGuideKind = typeof HARNESS_MODE_DESCRIPTORS[number]['kind'];

function compactHarnessModeGuide(): Record<string, unknown> {
  return {
    start: ['summary', 'modes', 'mode'],
    discover: harnessModeIdsByKind('discover'),
    inspect: harnessModeIdsByKind('inspect'),
    effects: harnessModeIdsByKind('effect'),
    aliases: harnessModeIdsByKind('alias'),
    pattern: 'Use query|target for search, exact ids for inspect modes, and confirm:true plus explicitUserRequest for effects.',
  };
}

function detailedHarnessModelAccessGuide(): Record<string, string> {
  return {
    cliCommands: 'Prefer workspace action:"cli_commands|cli_command" for CLI discovery. Lower-level cli command modes remain available.',
    uiSurfaces: 'Prefer workspace action:"surfaces|surface|open" for visible UI and computer action:"browser|open_browser" for browser/PWA. Lower-level UI modes remain available.',
    shortcuts: 'Prefer workspace action:"shortcuts|keybindings|keybinding|run_keybinding|set_keybinding|reset_keybinding"; effects need confirmation.',
    slashCommands: 'Prefer workspace action:"commands|command|run_command"; slash-command execution needs confirmation.',
    channels: 'Prefer channels action:"status|channel|setup|triage|deliveries"; deliver with agent_channel_send and confirmation. Lower-level channel harness modes remain available for detail.',
    notifications: 'List mode:"notifications"; inspect mode:"notification_target"; deliver with agent_notify and confirmation.',
    providerAccounts: 'Prefer models action:"providers|provider" for account and subscription posture. Lower-level mode:"provider_accounts" and mode:"provider_account" remain available; auth changes stay confirmed workspace/command flows.',
    mcpServers: 'List mode:"mcp_servers"; inspect mode:"mcp_server"; trust/server changes stay confirmed workspace/command flows.',
    setupPosture: 'Prefer setup action:"status|item|repair|checkpoint|token|smoke|finish"; lower-level setup_* modes remain available for detailed harness inspection.',
    routeDecision: 'Prefer route action:"plan" before choosing a specialized tool when the user task could map to setup, Personal Ops, research, autonomy, execution, delegation, computer/browser, workspace, host, or device routes.',
    projectContext: 'Prefer context action:"files|file"; lower-level project_context modes remain available for detail. Context files are read-only and secret-scanned.',
    promptContext: 'Prefer context action:"prompt|receipts|receipt" for prompt composition, selected/suppressed records, token budget, and prompt receipt outcomes.',
    agentOrchestration: 'List mode:"agent_orchestration" for managed plan and closeout cards; keep local todos with agent_work_plan; the owner can submit original source with /work submit-file <JSON-path> (no execution); inspect mode:"agent_orchestration_agent"; spawn/message/wait/cancel stay on first-class agent.',
    modelRouting: 'Prefer models action:"status|local|route|smoke" for model choice, local cookbook, route inspection, and confirmed local server checks. Lower-level mode:"model_routing", mode:"model_route", and mode:"run_local_model_smoke" remain available; changes stay visible.',
    executionPosture: 'Prefer execution action:"status|route"; use computer action:"plan" for browser, screenshot, or desktop-control route planning; use local read/edit/exec when current workspace is sufficient, delegation for isolation/parallel/remote.',
    backgroundProcesses: 'Use execution action:"processes|process|capabilities" to inspect tracked local commands and process parity, terminal background:true to start visible tracked commands, and process action:list|poll|log|wait|kill|write to manage them. Lower-level background_* modes remain for compatibility. process action:"capabilities" probes SDK/daemon interactive contracts; write dispatches only when a safe ProcessManager stdin method exists and is explicitly confirmed; PTY/sudo stay typed-contract or foreground-only boundaries.',
    executionHistory: 'Prefer execution action:"history|record" for activity cards and records; use returned verification, supervision, and recovery routes.',
    fileRecovery: 'Prefer execution action:"recovery"; apply local file undo/redo snapshots with mode:"run_file_recovery" and confirmation.',
    personalOps: 'Prefer personal_ops action:"briefing|status|queue|intake|lane|read"; lower-level modes personal_ops_briefing/personal_ops/personal_ops_queue/personal_ops_intake/personal_ops_lane/run_personal_ops_read remain available for harness inspection.',
    memoryPosture: 'Prefer memory action:"status|provider|refinement|run_refinement|curator|candidate|list|search|get"; run_refinement, memory writes, vector rebuilds, and embedding-provider changes stay on confirmed existing routes.',
    autonomyQueue: 'Prefer autonomy action:"intake|queue|item" for ongoing work and visible autonomous work; lower-level autonomy_* modes remain available for detail. Effects stay confirmed on the owning route.',
    learningCurator: 'Prefer memory action:"curator|candidate"; writes stay on reviewed Agent-local routes.',
    researchWorkflow: 'Prefer research action:"briefing" for the current next-action queue, action:"plan" for deep-research route planning, action:"search" for bounded public source candidates, and action:"runner" for browser-runner readiness; lower-level mode:"research_workflow" sequences visible run, web/fetch or browser posture, source queue, report, and Knowledge promotion routes.',
    researchRuns: 'Prefer research action:"runs|run"; lower-level mode:"research_runs" and mode:"research_run" inspect run posture; checkpoint/cancel/complete stays confirmed.',
    researchQueue: 'Prefer research action:"sources|source|bundle|reports|report_artifact"; lower-level research modes inspect source posture; capture/review/report/ingest stay confirmed.',
    documentOps: 'List mode:"document_ops"; inspect mode:"document_ops_lane"; browse saved artifacts with agent_artifacts; use returned routes for documents, review packet wizard, reviewer readiness, uploads, exports, source checks, artifacts, and blind compare.',
    pairingPosture: 'Prefer device action:"status|capability" for device maps. Lower-level mode:"pairing_posture" and mode:"pairing_route" remain available; raw token/QR and pairing effects stay visible user flows.',
    delegationPosture: 'Prefer delegation action:"status|routes|route"; delegated submission stays confirmed visible flow.',
    securityPosture: 'Prefer security action:"status|finding|explain"; lower-level security modes remain available for detail.',
    supportBundles: 'Prefer support action:"status|bundle"; lower-level support-bundle modes remain available; export/import stays confirmation-gated.',
    mediaPosture: 'Prefer device action:"voice|provider" for voice/media posture. Lower-level mode:"media_posture" and mode:"media_provider" remain available; generate with agent_media_generate and confirmation.',
    sessions: 'Prefer sessions action:"list|get"; lower-level session modes remain available; save/resume/export/delete stays visible confirmed flow.',
    workspace: 'Prefer workspace action:"status|actions|action|run|surfaces|surface|open|commands|command|run_command"; includeParameters:true inlines editor schemas.',
    settings: 'Prefer settings action:"list|get|set|reset|import"; list accepts category|prefix|query|includeHidden:true; lower-level settings modes remain for compatibility.',
    tools: 'List mode:"tools" with query|limit|includeParameters:true; inspect mode:"tool" with toolName|target|query.',
    modeCatalog: 'Search mode:"modes" with query|target; inspect one contract with mode:"mode" target:"...".',
    releaseEvidence: 'Operator/audit: prefer audit action:"evidence|artifact"; includeParameters:true inlines artifact detail.',
    releaseReadiness: 'Operator/audit: prefer audit action:"readiness|item"; includeParameters:true inlines item detail.',
    operatorMethods: 'Prefer host action:"methods|method"; lower-level mode:"operator_methods|operator_method" remains for detail. Run exact daemon methods with agent_operator_method; write/admin routes require confirmation.',
    servicePosture: 'Prefer host action:"services|service"; lower-level mode:"service_posture|service_endpoint" remains for probes and redacted log tail.',
    connectedHost: 'Prefer host action:"capabilities|capability"; lower-level mode:"connected_host|connected_host_capability" remains for route-family detail.',
    connectedHostStatus: 'Prefer host action:"status" for host reachability, token posture, and Knowledge readiness.',
    daemon: 'Daemon aliases route to host action:"capabilities|status"; use agent_operator_method for exact confirmed contract calls.',
  };
}

export function createAgentHarnessTool(deps: AgentHarnessToolDeps): Tool {
  const tool: Tool = {
    definition: {
      name: 'agent_harness',
      description: 'Inspect or operate Agent harness surfaces; mode:"modes" lists all.',
      parameters: {
        type: 'object',
        properties: AGENT_HARNESS_PARAMETER_PROPERTIES,
        required: ['mode'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs, options) => {
      const signal = options?.signal;
      // Inspect the routing descriptor without invoking a caller accessor. Full
      // judgment validation belongs to explanation input, not unrelated local
      // harness routes (which retain their own credential/redaction handling).
      const modeDescriptor = Object.getOwnPropertyDescriptor(rawArgs, 'mode');
      const args = (!modeDescriptor || !('value' in modeDescriptor) || modeDescriptor.value === 'policy_explain'
        ? snapshotJudgmentInput(rawArgs)
        : rawArgs) as AgentHarnessToolArgs;
      // Dispatch only on the inspected value. A Proxy must not switch routes
      // by returning a different mode from a subsequent property read.
      const dispatchMode = snapshotJudgmentInput(modeDescriptor && 'value' in modeDescriptor ? modeDescriptor.value : undefined);
      if (!isMode(dispatchMode)) {
        const requested = String(dispatchMode).toLowerCase();
        const suggestions = AGENT_HARNESS_MODES
          .filter((mode) => mode.includes(requested) || requested.includes(mode))
          .slice(0, 5);
        return error(`Unknown agent_harness mode: ${String(dispatchMode)}. ${suggestions.length > 0 ? `Closest modes: ${suggestions.join(', ')}. ` : ''}Use mode:"modes" to list the full catalog.`);
      }
      // Judgment stays pending or rejects with its typed outcome; the generic
      // harness display catch must not turn unavailable judgment into tool text.
      if (dispatchMode === 'policy_explain') {
        const resolved = await explainAgentPolicyDecision(deps.commandContext, deps.toolRegistry, args, signal);
        if (resolved.status === 'found') return output(resolved.explanation);
        if (resolved.status === 'ambiguous') return error(`Ambiguous policy explanation target ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
        return error(resolved.usage);
      }
      if (dispatchMode === 'run_background_process') return output(await runBackgroundProcessAction(deps.commandContext, args, processClassificationOptions(deps.commandContext, deps.toolRegistry, signal, () => { assertCurrentToolExecution(rawArgs, options); })));
      const personalOpsOwner = agentResearchSourceOwner(deps.toolRegistry);
      const personalOpsSession = deps.commandContext.session?.runtime;
      const personalOpsSessionId = personalOpsSession?.sessionId;
      const personalOpsApi = deps.commandContext.clients?.mcpApi ?? deps.commandContext.extensions?.mcpRegistry;
      const personalOpsOptions = { signal, sourceOwner: personalOpsOwner, assertCurrent: () => {
        signal?.throwIfAborted();
        if (agentResearchSourceOwner(deps.toolRegistry) !== personalOpsOwner
          || deps.commandContext.session?.runtime !== personalOpsSession
          || deps.commandContext.session?.runtime?.sessionId !== personalOpsSessionId
          || (deps.commandContext.clients?.mcpApi ?? deps.commandContext.extensions?.mcpRegistry) !== personalOpsApi) throw new Error('PersonalOps source owner changed.');
      } };
      if (dispatchMode === 'personal_ops_queue') return output(await personalOpsQueueSummary(deps.commandContext, args, personalOpsOptions));
      if (dispatchMode === 'personal_ops_intake') return output(await personalOpsIntakeSummary(deps.commandContext, args, personalOpsOptions));
      if (dispatchMode === 'personal_ops_lane') {
        const resolved = await describePersonalOpsLane(deps.commandContext, args, personalOpsOptions);
        if (resolved.status === 'found') return output(resolved.lane);
        if (resolved.status === 'deferred') return output(resolved);
        if (resolved.status === 'ambiguous') return error(`Ambiguous Personal Ops lane ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
        return error(resolved.usage);
      }
      if (dispatchMode === 'run_personal_ops_read') return output(await runPersonalOpsRead(deps.commandContext, args, personalOpsOptions));
      try {
        if (dispatchMode === 'summary') {
          const channelReadiness = channelReadinessCatalogStatus(deps.commandContext);
          const notificationTargets = notificationTargetCatalogStatus(deps.commandContext);
          const providerAccounts = await providerAccountCatalogStatus(deps.commandContext).catch((err) => ({
            modes: ['provider_accounts', 'provider_account'],
            status: 'unavailable',
            error: formatHarnessError(err),
          }));
          const mcpServers = mcpServerCatalogStatus(deps.commandContext);
          const setupPosture = await setupPostureCatalogStatus(deps.commandContext).catch((err) => ({
            modes: ['setup_posture', 'setup_item', 'setup_repair', 'setup_checkpoint', 'mark_setup_checkpoint', 'clear_setup_checkpoint', 'provision_connected_host_token', 'run_setup_smoke'],
            status: 'unavailable',
            error: formatHarnessError(err),
          }));
          const projectContext = projectContextCatalogStatus(deps.commandContext);
          const promptContext = await promptContextCatalogStatus(deps.commandContext, signal);
          const agentOrchestration = agentOrchestrationCatalogStatus(deps.commandContext, deps.toolRegistry);
          const modelRouting = await modelRoutingCatalogStatus(deps.commandContext).catch((err) => ({
            modes: ['model_routing', 'model_route'],
            status: 'unavailable',
            error: formatHarnessError(err),
          }));
          const executionPosture = executionPostureCatalogStatus(deps.commandContext, deps.toolRegistry);
          const backgroundProcesses = backgroundProcessCatalogStatus(deps.commandContext);
          const executionHistory = executionHistoryCatalogStatus(deps.commandContext);
          const fileRecovery = fileRecoveryCatalogStatus(deps.commandContext);
          const personalOps = personalOpsCatalogStatus(deps.commandContext);
          const memoryPosture = await memoryPostureCatalogStatus(deps.commandContext).catch((err) => ({
            modes: ['memory_posture', 'memory_provider'],
            status: 'unavailable',
            error: formatHarnessError(err),
          }));
          const memoryRefinement = memoryRefinementCatalogStatus(deps.commandContext);
          const autonomyQueue = autonomyQueueCatalogStatus(deps.commandContext);
          const learningCurator = learningCuratorCatalogStatus(deps.commandContext);
          const researchBriefing = researchBriefingCatalogStatus(deps.commandContext);
          const researchRuns = researchRunsCatalogStatus(deps.commandContext);
          const researchQueue = researchQueueCatalogStatus(deps.commandContext);
          const documentOps = documentOpsCatalogStatus(deps.commandContext);
          const pairingPosture = pairingPostureCatalogStatus(deps.commandContext);
          const delegationPosture = delegationPostureCatalogStatus(deps.commandContext);
          const securityPosture = securityPostureCatalogStatus(deps.commandContext);
          const supportBundles = supportBundleCatalogStatus();
          const mediaPosture = mediaPostureCatalogStatus(deps.commandContext);
          const sessions = sessionCatalogStatus(deps.commandContext);
          const releaseEvidence = releaseEvidenceBundleStatus();
          const releaseReadiness = releaseReadinessInventoryStatus();
          const operatorMethods = operatorMethodCatalogStatus();
          const servicePosture = servicePostureCatalogStatus();
          const remote = remoteCatalogStatus(deps.commandContext);
          const connectedHost = connectedHostSummary(deps.commandContext, deps.toolRegistry, {
            includeParameters: args.includeParameters === true,
          });
          return output({
            assistant: buildAssistantCockpitFromSummaries({
              setupPosture,
              projectContext,
              agentOrchestration,
              modelRouting,
              executionPosture,
              backgroundProcesses,
              personalOps,
              autonomyQueue,
              researchRuns,
              documentOps,
              securityPosture,
            }),
            harnessModes: HARNESS_MODE_DESCRIPTORS.length,
            cliCommands: totalHarnessCliCommands(),
            blockedCliCommandTokens: blockedHarnessCliCommandTokens(),
            uiSurfaces: totalHarnessUiSurfaces(),
            shortcuts: totalHarnessShortcuts(deps.commandContext),
            keybindings: totalHarnessKeybindings(deps.commandContext),
            commands: deps.commandRegistry.list().length,
            channelReadiness,
            notificationTargets,
            providerAccounts,
            mcpServers,
            setupPosture,
            projectContext,
            promptContext,
            agentOrchestration,
            modelRouting,
            executionPosture,
            backgroundProcesses,
            executionHistory,
            fileRecovery,
            personalOps,
            memoryPosture,
            memoryRefinement,
            autonomyQueue,
            learningCurator,
            researchBriefing,
            researchRuns,
            researchQueue,
            documentOps,
            pairingPosture,
            delegationPosture,
            securityPosture,
            supportBundles,
            mediaPosture,
            sessions,
            settings: countHarnessSettingCatalog(deps.commandContext.platform.configManager, { includeHidden: true }),
            workspaceCategories: AGENT_WORKSPACE_CATEGORIES.length,
            workspaceActions: allWorkspaceActions().length,
            tools: deps.toolRegistry.getToolDefinitions().length,
            releaseEvidence,
            releaseReadiness,
            operatorMethods,
            servicePosture,
            remote,
            modeGuide: compactHarnessModeGuide(),
            ...(args.includeParameters === true ? { modelAccess: detailedHarnessModelAccessGuide() } : {}),
            settingsPolicy: settingsPolicySummary(),
            connectedHost,
          });
        }
        if (dispatchMode === 'modes') return output(listHarnessModes(args));
        if (dispatchMode === 'mode') {
          const mode = describeHarnessMode(args);
          if (mode.status === 'ambiguous') return error(`Ambiguous harness mode ${String(mode.input)}. Candidates: ${JSON.stringify(mode.candidates)}`);
          if (mode.status === 'missing_lookup') return error(String(mode.usage));
          return output(mode.mode);
        }
        if (dispatchMode === 'route_decision') return output(await planAgentTaskRoute(deps.commandContext, args, deps.taskRouteSources, { ...(signal ? { signal } : {}) }));
        if (dispatchMode === 'cli_commands') {
          const commands = listHarnessCliCommands(args);
          return output({
            ...catalogEnvelope('commands', commands, totalHarnessCliCommands(), catalogFilters(args, CQ.cli_commands.filters), CQ.cli_commands.discovery),
            blockedTokens: blockedHarnessCliCommandTokens(),
            policy: 'CLI modes are read-only discovery. Use first-class model tools, workspace actions, settings modes, or confirmed slash-command mirrors for in-process operation.',
          });
        }
        if (dispatchMode === 'cli_command') {
          return output(describeHarnessCliCommand(args));
        }
        if (dispatchMode === 'ui_surfaces') {
          const surfaces = listHarnessUiSurfaces(deps.commandContext, args);
          return output(catalogEnvelope('surfaces', surfaces, totalHarnessUiSurfaces(), catalogFilters(args, CQ.ui_surfaces.filters), CQ.ui_surfaces.discovery));
        }
        if (dispatchMode === 'ui_surface') {
          const surface = describeHarnessUiSurface(deps.commandContext, args);
          return surface ? output(surface) : error(`Unknown UI surface ${readString(args.surfaceId || args.query || args.target) || '<missing>'}.`);
        }
        if (dispatchMode === 'open_ui_surface') {
          const confirmationError = requireConfirmedAction(args, 'UI surface routing');
          if (confirmationError) return error(confirmationError);
          return output(await openHarnessUiSurface(deps.commandContext, args));
        }
        if (dispatchMode === 'shortcuts') return output(listHarnessShortcuts(deps.commandContext, args));
        if (dispatchMode === 'keybindings') return output(listHarnessKeybindings(deps.commandContext, args));
        if (dispatchMode === 'keybinding') {
          const binding = describeHarnessKeybinding(deps.commandContext, args);
          return binding ? output(binding) : error(`Unknown keybinding action ${readString(args.actionId || args.target || args.key || args.query) || '<missing>'}.`);
        }
        if (dispatchMode === 'set_keybinding') {
          const confirmationError = requireConfirmedAction(args, 'Keybinding mutation');
          return confirmationError ? error(confirmationError) : output(setHarnessKeybinding(deps.commandContext, args));
        }
        if (dispatchMode === 'reset_keybinding') {
          const confirmationError = requireConfirmedAction(args, 'Keybinding reset');
          return confirmationError ? error(confirmationError) : output(resetHarnessKeybinding(deps.commandContext, args));
        }
        if (dispatchMode === 'run_keybinding') {
          const confirmationError = requireConfirmedAction(args, 'Keybinding action');
          return confirmationError ? error(confirmationError) : output(runHarnessKeybinding(deps.commandContext, args));
        }
        if (dispatchMode === 'commands') {
          const commands = searchHarnessCommands(deps.commandRegistry, args);
          return output(catalogEnvelope('commands', commands.matches, deps.commandRegistry.list().length, catalogFilters(args, CQ.commands.filters), CQ.commands.discovery, { relaxedQuery: commands.relaxed }));
        }
        if (dispatchMode === 'command') {
          const detail = describeHarnessCommand(deps.commandRegistry, args);
          const query = readString(args.command || args.commandName || args.target || args.query);
          return detail
            ? output(detail)
            : error(`Unknown slash command ${query || '<missing>'}. Use mode:"commands" to inspect available commands.`);
        }
        if (dispatchMode === 'run_command') return runCommand(deps, args);
        if (dispatchMode === 'channels') return output(listHarnessChannels(deps.commandContext, args));
        if (dispatchMode === 'channel') {
          const resolved = describeHarnessChannel(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.channel);
          if (resolved.status === 'ambiguous') return error(`Ambiguous channel ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'channel_setup_guide') {
          const resolved = describeHarnessChannelSetupGuide(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.guide);
          if (resolved.status === 'ambiguous') return error(`Ambiguous channel setup guide target ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'channel_triage') return output(await describeHarnessChannelTriage(deps.commandContext, args));
        if (dispatchMode === 'channel_deliveries') return output(describeHarnessChannelDeliveries(deps.commandContext, args));
        if (dispatchMode === 'notifications') return output(listHarnessNotificationTargets(deps.commandContext, args));
        if (dispatchMode === 'notification_target') {
          const resolved = describeHarnessNotificationTarget(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.target);
          if (resolved.status === 'ambiguous') return error(`Ambiguous notification target ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'provider_accounts') return output(await providerAccountSummary(deps.commandContext, args));
        if (dispatchMode === 'provider_account') {
          const resolved = await describeHarnessProviderAccount(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.account);
          if (resolved.status === 'ambiguous') return error(`Ambiguous provider account ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'mcp_servers') return output(await mcpServerSummary(deps.commandContext, args));
        if (dispatchMode === 'mcp_server') {
          const resolved = await describeHarnessMcpServer(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.server);
          if (resolved.status === 'ambiguous') return error(`Ambiguous MCP server ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'setup_posture') return output(await setupPostureSummary(deps.commandContext, args));
        if (dispatchMode === 'setup_item') {
          const resolved = await describeHarnessSetupItem(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.item);
          if (resolved.status === 'ambiguous') return error(`Ambiguous setup item ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'setup_repair') return output(await setupRepairSummary(deps.commandContext, args));
        if (dispatchMode === 'setup_checkpoint') return output(await setupCheckpointSummary(deps.commandContext));
        if (dispatchMode === 'mark_setup_checkpoint') {
          const confirmationError = requireConfirmedAction(args, 'Setup wizard checkpoint save');
          if (confirmationError) return error(confirmationError);
          return output(await markSetupCheckpoint(deps.commandContext, args));
        }
        if (dispatchMode === 'clear_setup_checkpoint') {
          const confirmationError = requireConfirmedAction(args, 'Setup wizard checkpoint clear');
          if (confirmationError) return error(confirmationError);
          return output(clearSetupCheckpoint(deps.commandContext, args));
        }
        if (dispatchMode === 'project_context') return output(projectContextSummary(deps.commandContext, args));
        if (dispatchMode === 'project_context_file') {
          const resolved = describeProjectContextFile(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.file);
          if (resolved.status === 'ambiguous') return error(`Ambiguous project context file ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'prompt_context') return output(await promptContextSummary(deps.commandContext, args, signal));
        if (dispatchMode === 'agent_orchestration') return output(agentOrchestrationSummary(deps.commandContext, deps.toolRegistry, args));
        if (dispatchMode === 'agent_orchestration_agent') {
          const resolved = describeAgentOrchestrationAgent(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.agent);
          if (resolved.status === 'ambiguous') return error(`Ambiguous visible Agent ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'provision_connected_host_token') {
          const confirmationError = requireConfirmedAction(args, 'Connected-host token provisioning');
          if (confirmationError) return error(confirmationError);
          const setupItemId = readString(args.setupItemId);
          if (setupItemId && setupItemId !== 'connected-host-auth') {
            return error('provision_connected_host_token supports setupItemId:"connected-host-auth" only.');
          }
          return output(provisionConnectedHostOperatorToken(deps.commandContext, args));
        }
        if (dispatchMode === 'run_setup_smoke') {
          const confirmationError = requireConfirmedAction(args, 'Setup smoke');
          if (confirmationError) return error(confirmationError);
          const setupItemId = readString(args.setupItemId);
          if (setupItemId && setupItemId !== 'install-smoke') return error('run_setup_smoke currently supports setupItemId:"install-smoke" only.');
          return output(await runSetupInstallSmoke(deps.commandContext, args));
        }
        if (dispatchMode === 'model_routing') return output(await modelRoutingSummary(deps.commandContext, args));
        if (dispatchMode === 'model_route') {
          const resolved = await describeHarnessModelRoute(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.route);
          if (resolved.status === 'ambiguous') return error(`Ambiguous model route ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'run_local_model_smoke') {
          const confirmationError = requireConfirmedAction(args, 'Local model smoke');
          return confirmationError ? error(confirmationError) : output(await runLocalModelServerSmoke(deps.commandContext, args));
        }
        if (dispatchMode === 'execution_posture') return output(executionPostureSummary(deps.commandContext, deps.toolRegistry, args));
        if (dispatchMode === 'browser_control_route') return output(browserControlRouteSummary(deps.commandContext, deps.toolRegistry, args));
        if (dispatchMode === 'execution_route') {
          const resolved = describeHarnessExecutionRoute(deps.commandContext, deps.toolRegistry, args);
          if (resolved.status === 'found') return output(resolved.route);
          if (resolved.status === 'ambiguous') return error(`Ambiguous execution route ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'background_processes') return output(backgroundProcessSummary(deps.commandContext, args));
        if (dispatchMode === 'background_process') {
          const resolved = describeBackgroundProcess(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.process);
          if (resolved.status === 'ambiguous') return error(`Ambiguous background process ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'execution_history') return output(executionHistorySummary(deps.commandContext, args));
        if (dispatchMode === 'execution_history_item') {
          const resolved = describeExecutionHistoryItem(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.record);
          if (resolved.status === 'ambiguous') return error(`Ambiguous execution history record ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'file_recovery') return output(fileRecoverySummary(deps.commandContext, args));
        if (dispatchMode === 'run_file_recovery') {
          const confirmationError = requireConfirmedAction(args, 'File recovery');
          return confirmationError ? error(confirmationError) : output(runFileRecovery(deps.commandContext, args));
        }
        if (dispatchMode === 'personal_ops_briefing') return output(await personalOpsBriefingSummary(deps.commandContext, args));
        if (dispatchMode === 'personal_ops') return output(await personalOpsSummary(deps.commandContext, args));

        if (dispatchMode === 'memory_posture') return output(await memoryPostureSummary(deps.commandContext, args));
        if (dispatchMode === 'memory_provider') {
          const resolved = await describeMemoryProvider(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.provider);
          if (resolved.status === 'ambiguous') return error(`Ambiguous memory provider ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'memory_refinement') return output(memoryRefinementSummary(deps.commandContext, args));
        if (dispatchMode === 'run_memory_refinement') {
          const confirmationError = requireConfirmedAction(args, 'Agent Knowledge semantic refinement');
          return confirmationError ? error(confirmationError) : output(await runMemoryRefinement(deps.commandContext, args));
        }
        if (dispatchMode === 'autonomy_intake') return output(autonomyIntakeSummary(deps.commandContext, args));
        if (dispatchMode === 'autonomy_queue') return output(autonomyQueueSummary(deps.commandContext, args));
        if (dispatchMode === 'autonomy_queue_item') {
          const resolved = describeAutonomyQueueItem(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.item);
          if (resolved.status === 'ambiguous') return error(`Ambiguous autonomy queue item ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'learning_curator') return output(learningCuratorSummary(deps.commandContext, args));
        if (dispatchMode === 'learning_auto_promote') {
          const confirmationError = requireConfirmedAction(args, 'Learning promotion'); if (confirmationError) return error(confirmationError);
          const shellPaths = deps.commandContext.workspace?.shellPaths;
          if (!shellPaths) return error('learning_auto_promote requires an active workspace.');
          const memoryApi = deps.commandContext.clients?.agentKnowledgeApi?.memory;
          if (!memoryApi) return error('learning_auto_promote requires an active memory registry.');
          const skillRegistry = AgentSkillRegistry.fromShellPaths(shellPaths);
          const result = await runAutoPromoter(deps.commandContext, skillRegistry, memoryApi);
          return output({
            ...result,
            message: result.promoted > 0
              ? `Promoted ${result.promoted} item(s); consolidated ${result.consolidated} duplicate(s).`
              : 'No items eligible for promotion this pass.',
            policy: 'Confirmed promotion. Skills are created via the skill-draft runner. Memory, persona, routine creates call registry directly. Consolidation runs the full merge-stale-delete pipeline. Secret scanning enforced by each registry create().',
          });
        }
        if (dispatchMode === 'learning_candidate') {
          const resolved = describeLearningCandidate(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.candidate);
          if (resolved.status === 'ambiguous') return error(`Ambiguous learning candidate ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'research_briefing') return output(researchBriefingSummary(deps.commandContext, args));
        if (dispatchMode === 'research_workflow') return output(researchWorkflowSummary(deps.commandContext, args));
        if (dispatchMode === 'research_runs') return output(researchRunsSummary(deps.commandContext, args));
        if (dispatchMode === 'research_run') {
          const resolved = describeResearchRun(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.run);
          if (resolved.status === 'ambiguous') return error(`Ambiguous research run ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'research_queue') return output(researchQueueSummary(deps.commandContext, args));
        if (dispatchMode === 'research_source') {
          const resolved = describeResearchSource(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.source);
          if (resolved.status === 'ambiguous') return error(`Ambiguous research source ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'document_ops') return output(documentOpsSummary(deps.commandContext, args));
        if (dispatchMode === 'document_ops_lane') {
          const resolved = describeDocumentOpsLane(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.lane);
          if (resolved.status === 'ambiguous') return error(`Ambiguous Document Ops lane ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'pairing_posture') return output(pairingPostureSummary(deps.commandContext, args));
        if (dispatchMode === 'pairing_route') {
          const resolved = describeHarnessPairingRoute(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.route);
          if (resolved.status === 'ambiguous') return error(`Ambiguous pairing route ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'delegation_posture') return output(delegationPostureSummary(deps.commandContext, args));
        if (dispatchMode === 'delegation_route') {
          const resolved = describeHarnessDelegationRoute(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.route);
          if (resolved.status === 'ambiguous') return error(`Ambiguous delegation route ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'security_posture') return output(await securityPostureSummary(deps.commandContext, args));
        if (dispatchMode === 'security_finding') {
          const resolved = describeHarnessSecurityFinding(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.finding);
          if (resolved.status === 'ambiguous') return error(`Ambiguous security finding ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'support_bundles') return output(supportBundleSummary(args));
        if (dispatchMode === 'support_bundle') {
          const resolved = describeHarnessSupportBundle(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.bundle);
          return error(resolved.usage);
        }
        if (dispatchMode === 'media_posture') return output(await mediaPostureSummary(deps.commandContext, args));
        if (dispatchMode === 'media_provider') {
          const resolved = await describeHarnessMediaProvider(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.provider);
          if (resolved.status === 'ambiguous') return error(`Ambiguous media provider ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'sessions') return output(sessionSummary(deps.commandContext, args));
        if (dispatchMode === 'session') {
          const resolved = describeHarnessSession(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.session);
          if (resolved.status === 'ambiguous') return error(`Ambiguous session ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'settings') {
          // Ownership-aware (daemon-owned keys carry the DAEMON's live value)
          // and short-page-aware: harnessSettingsCatalog states in words when
          // the page it returns is short of what matched.
          return output(await harnessSettingsCatalog(deps.commandContext.platform.configManager, args));
        }
        if (dispatchMode === 'get_setting') {
          const setting = await resolveEffectiveHarnessSetting(deps.commandContext.platform.configManager, settingLookupArgs(args));
          if (setting?.status === 'found') return output(setting.setting);
          if (setting?.status === 'ambiguous') {
            return error(`Ambiguous setting ${setting.input}. Candidates: ${JSON.stringify(setting.candidates)}`);
          }
          return error(`Unknown setting ${readString(args.key || args.target || args.query) || '<missing>'}. Use mode:"settings" to inspect available settings.`);
        }
        if (dispatchMode === 'set_setting') {
          const confirmationError = requireConfirmedAction(args, 'Setting mutation');
          if (confirmationError) return error(confirmationError);
          if (args.value === undefined) return error('set_setting requires value.');
          const setting = await resolveEffectiveHarnessSetting(deps.commandContext.platform.configManager, settingLookupArgs(args));
          if (setting?.status === 'ambiguous') {
            return error(`Ambiguous setting ${setting.input}. Candidates: ${JSON.stringify(setting.candidates)}`);
          }
          if (setting?.status !== 'found') {
            return error(`Unknown setting ${readString(args.key || args.target || args.query) || '<missing>'}. Use mode:"settings" to inspect available settings.`);
          }
          const result = await setHarnessSetting(
            deps.commandContext.platform.configManager,
            deps.commandContext.platform.secretsManager,
            setting.setting.key,
            args.value,
          );
          return output({ ...result, lookup: setting.lookup });
        }
        if (dispatchMode === 'reset_setting') {
          const confirmationError = requireConfirmedAction(args, 'Setting reset');
          if (confirmationError) return error(confirmationError);
          const setting = await resolveEffectiveHarnessSetting(deps.commandContext.platform.configManager, settingLookupArgs(args));
          if (setting?.status === 'ambiguous') {
            return error(`Ambiguous setting ${setting.input}. Candidates: ${JSON.stringify(setting.candidates)}`);
          }
          if (setting?.status !== 'found') {
            return error(`Unknown setting ${readString(args.key || args.target || args.query) || '<missing>'}. Use mode:"settings" to inspect available settings.`);
          }
          const result = await resetHarnessSetting(
            deps.commandContext.platform.configManager,
            deps.commandContext.platform.secretsManager,
            setting.setting.key,
          );
          return output({ ...result, lookup: setting.lookup });
        }
        if (dispatchMode === 'workspace' || dispatchMode === 'workspace_categories') {
          return output({
            categories: AGENT_WORKSPACE_CATEGORIES.map(describeWorkspaceCategory),
            actions: allWorkspaceActions().length,
          });
        }
        if (dispatchMode === 'workspace_actions') {
          const actions = listWorkspaceActions(deps.commandContext, args);
          return output(catalogEnvelope('actions', actions, allWorkspaceActions().length, catalogFilters(args, CQ.workspace_actions.filters), CQ.workspace_actions.discovery));
        }
        if (dispatchMode === 'workspace_action') {
          const resolved = resolveWorkspaceActionDetail(args);
          const editorContext = buildWorkspaceEditorContext(deps.commandContext, args);
          if (resolved?.status === 'found') {
            return output(describeWorkspaceAction(resolved.category, resolved.action, { includeEditor: true, editorContext, lookup: resolved.lookup }));
          }
          if (resolved?.status === 'ambiguous') {
            return error(`Ambiguous Agent workspace action ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          }
          return error(`Unknown Agent workspace action ${readString(args.actionId || args.command || args.target || args.query) || '<missing>'}. Use mode:"workspace_actions" to inspect available actions.`);
        }
        if (dispatchMode === 'run_workspace_action') {
          // The original dispatcher owns its inspected mode and typed refusal
          // contract. Protect workspace report bodies only after that routing
          // boundary, without rereading unrelated Proxy/accessor modes.
          const workspaceActionTool: Tool = { definition: tool.definition,
            execute: (input, executionOptions) => runWorkspaceAction(deps, input, executionOptions),
          };
          return protectAgentHarnessResearchTool(workspaceActionTool, deps.toolRegistry).execute(args as Record<string, unknown>, options);
        }
        if (dispatchMode === 'tools') {
          const tools = searchHarnessModelTools(deps.toolRegistry, args);
          return output(catalogEnvelope('tools', tools.matches, deps.toolRegistry.getToolDefinitions().length, catalogFilters(args, CQ.tools.filters), CQ.tools.discovery, { relaxedQuery: tools.relaxed }));
        }
        if (dispatchMode === 'tool') {
          const query = readString(args.toolName || args.target || args.query);
          const resolved = describeHarnessModelTool(deps.toolRegistry, args);
          if (resolved?.status === 'found') return output(resolved.tool);
          if (resolved?.status === 'ambiguous') return error(`Ambiguous model tool ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(describeUnknownModelTool(deps.toolRegistry, query));
        }
        if (dispatchMode === 'release_evidence') return output(releaseEvidenceSummary(args));
        if (dispatchMode === 'release_evidence_artifact') {
          const resolved = describeHarnessReleaseEvidenceArtifact(args);
          if (resolved.status === 'found') return output(resolved);
          if (resolved.status === 'ambiguous') return error(`Ambiguous release evidence artifact ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          if (resolved.status === 'missing_lookup') return error(resolved.usage ?? 'release_evidence_artifact requires artifactId, target, or query.');
          return error(`Unknown release evidence artifact ${readString(args.artifactId || args.target || args.query) || '<missing>'}. Use mode:"release_evidence" to inspect available artifacts.`);
        }
        if (dispatchMode === 'release_readiness') return output(releaseReadinessSummary(args));
        if (dispatchMode === 'release_readiness_item') {
          const resolved = describeHarnessReleaseReadinessItem(args);
          if (resolved.status === 'found') return output(resolved);
          if (resolved.status === 'ambiguous') return error(`Ambiguous release readiness item ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          if (resolved.status === 'unavailable') return output(resolved);
          if (resolved.status === 'missing_lookup') return error(resolved.usage ?? 'release_readiness_item requires itemId, target, or query.');
          return error(`Unknown release readiness item ${readString(args.itemId || args.target || args.query) || '<missing>'}. Use mode:"release_readiness" to inspect available items.`);
        }
        if (dispatchMode === 'operator_methods') return output(operatorMethodSummary(args));
        if (dispatchMode === 'operator_method') {
          const resolved = describeHarnessOperatorMethod(args);
          if (resolved.status === 'found') return output(resolved.method);
          if (resolved.status === 'ambiguous') return error(`Ambiguous operator method ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'service_posture') return output(await servicePostureSummary(deps.commandContext, args));
        if (dispatchMode === 'service_endpoint') {
          const resolved = await describeHarnessServiceEndpoint(deps.commandContext, args);
          if (resolved.status === 'found') return output(resolved.endpoint);
          if (resolved.status === 'ambiguous') return error(`Ambiguous service endpoint ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(resolved.usage);
        }
        if (dispatchMode === 'connected_host' || dispatchMode === 'daemon') {
          return output(connectedHostSummary(deps.commandContext, deps.toolRegistry, {
            includeParameters: args.includeParameters === true,
          }));
        }
        if (dispatchMode === 'connected_host_capability') {
          const query = readString(args.capabilityId || args.target || args.query);
          const resolved = describeConnectedHostCapability(deps.toolRegistry, query);
          if (resolved?.status === 'found') return output(resolved.detail);
          if (resolved?.status === 'ambiguous') return error(`Ambiguous connected-host capability ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
          return error(`Unknown connected-host capability ${query || '<missing>'}. Use mode:"connected_host" to inspect allowed and blocked capability ids.`);
        }
        if (dispatchMode === 'connected_host_status' || dispatchMode === 'daemon_status') {
          return output(await connectedHostStatusSummary(deps.commandContext, deps.toolRegistry, {
            includeParameters: args.includeParameters === true,
          }));
        }
        if (dispatchMode === 'propose_skill_drafts') {
          const confirmationError = requireConfirmedAction(args, 'Skill draft proposal');
          if (confirmationError) return error(confirmationError);
          const shellPaths = deps.commandContext.workspace?.shellPaths;
          if (!shellPaths) return error('Skill draft proposal requires an active workspace.');
          const registry = AgentSkillRegistry.fromShellPaths(shellPaths);
          const result = runSkillDraftProposer(deps.commandContext, registry);
          return output({
            proposed: result.proposed,
            skipped: result.skipped,
            skillIds: result.skillIds,
            message: result.proposed > 0
              ? `Drafted ${result.proposed} skill${result.proposed !== 1 ? 's' : ''} for review. Find them under Memory > Skills with enabled:false.`
              : 'No new skill drafts this pass.',
            policy: 'Drafted skills are disabled and require review before use. Enable them under Memory > Skills.',
          });
        }
        if (dispatchMode === 'remote_snapshot') return output(remoteSnapshotSummary(args));
        if (dispatchMode === 'remote_peers') return output(remotePeersSummary(args));
        if (dispatchMode === 'remote_work') return output(remoteWorkSummary(args));
        if (dispatchMode === 'remote_pair_requests') return output(remotePairRequestsSummary(args));
        if (dispatchMode === 'remote_pair_approve') {
          const confirmationError = requireConfirmedAction(args, 'Remote pair request approval');
          if (confirmationError) return error(confirmationError);
          return output(remotePairApproveHandoff(args));
        }
        if (dispatchMode === 'remote_pair_reject') {
          const confirmationError = requireConfirmedAction(args, 'Remote pair request rejection');
          if (confirmationError) return error(confirmationError);
          return output(remotePairRejectHandoff(args));
        }
        if (dispatchMode === 'remote_peers_invoke') {
          const confirmationError = requireConfirmedAction(args, 'Remote peer command invocation');
          if (confirmationError) return error(confirmationError);
          return output(remotePeersInvokeHandoff(args));
        }
        if (dispatchMode === 'remote_work_cancel') {
          const confirmationError = requireConfirmedAction(args, 'Remote work cancellation');
          if (confirmationError) return error(confirmationError);
          return output(remoteWorkCancelHandoff(args));
        }
        if (dispatchMode === 'unified_inbox') return output(await unifiedInboxSummary(deps.commandContext, args));
        if (dispatchMode === 'channel_drafts') return output(await channelDraftsSummary(deps.commandContext, args));
        if (dispatchMode === 'channel_draft_save') {
          const result = await channelDraftSaveHandoff(deps.commandContext, args); return typeof result === 'string' ? error(result) : output(result);
        }
        if (dispatchMode === 'channel_draft_send') {
          const result = await channelDraftSendHandoff(deps.commandContext, args); return typeof result === 'string' ? error(result) : output(result);
        }
        if (dispatchMode === 'channel_routing') return output(channelRoutingSummary(deps.commandContext, args));
        if (dispatchMode === 'channel_routing_assign') {
          const result = await channelRoutingAssignHandoff(deps.commandContext, args);
          return typeof result === 'string' ? error(result) : output(result);
        }
        if (dispatchMode === 'channel_routing_remove') {
          const result = channelRoutingRemoveHandoff(deps.commandContext, args);
          return typeof result === 'string' ? error(result) : output(result);
        }
        return error(`Unhandled agent_harness mode: ${dispatchMode}`);
      } catch (err) {
        return error(formatHarnessError(err));
      }
    },
  };
  return tool;
}

export function registerAgentHarnessTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
  taskRouteSources?: import('./agent-route-planner.ts').AgentTaskRouteSources,
): void {
  registry.register(createAgentHarnessTool({ commandRegistry, commandContext, toolRegistry: registry, ...(taskRouteSources ? { taskRouteSources } : {}) }), { inputProjection: createProcessInputProjector(registry, 'agent_harness', createPersonalOpsInputProjector(registry, createAgentHarnessResearchProjector(registry))) });
}
