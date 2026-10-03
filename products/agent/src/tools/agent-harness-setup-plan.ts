import type { CommandContext } from '../input/command-registry.ts';
import type { CliServicePosture } from '../cli/service-posture.ts';
import type { OnboardingStep1CapabilityItem } from '../runtime/onboarding/index.ts';
import { previewAgentWorkspaceTuiSettingsImport } from '../input/agent-workspace-settings.ts';
import { browserControlPosture } from './agent-harness-browser-control.ts';
import { localModelCookbook } from './agent-harness-model-routing.ts';
import { sudoExecutionPosture } from './agent-harness-sudo-posture.ts';
import { agentHarnessVibeHealth } from './agent-harness-vibe-health.ts';
import { capabilityById, collectSnapshot, setupPlanStatusForCapability, setupProviderSignalIds } from './agent-harness-setup-posture-utils.ts';
import { browserControlSignals, localModelSetupNextAction, localModelSetupReadiness, localModelSetupSignals, localModelSetupStatus, settingsImportChangeCount, settingsImportSignals } from './agent-harness-setup-model-helpers.ts';
import { connectedHostAuthNextAction, connectedHostAuthPosture, connectedHostAuthSignals, connectedHostAuthStatus, connectedHostBootstrapPlan, connectedHostRepairCards, connectedHostServiceProbe, hostSetupStatus, serviceProbeSignal, setupServiceLifecycleDecision } from './agent-harness-setup-connected-host.ts';
import { installSmokePlan, installSmokeSignals, setupCompletionMarkerExists } from './agent-harness-setup-smoke.ts';
import type { SetupPlanItem } from './agent-harness-setup-posture-types.ts';

export function buildSetupPlan(
  context: CommandContext,
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
  capabilities: readonly OnboardingStep1CapabilityItem[],
  servicePosture: CliServicePosture | null,
): readonly SetupPlanItem[] {
  const providerAccess = capabilityById(capabilities, 'provider-access');
  const agentKnowledge = capabilityById(capabilities, 'agent-knowledge');
  const localBehavior = capabilityById(capabilities, 'local-behavior');
  const communicationChannels = capabilityById(capabilities, 'communication-channels');
  const automationReview = capabilityById(capabilities, 'automation-review');
  const tuiDelegation = capabilityById(capabilities, 'tui-delegation');
  const setupMarkerDone = setupCompletionMarkerExists(context);
  const browserControl = browserControlPosture(context);
  const settingsImport = previewAgentWorkspaceTuiSettingsImport(context);
  const settingsImportChanges = settingsImportChangeCount(settingsImport);
  const localModels = localModelCookbook(context, true);
  const localModelReadiness = localModelSetupReadiness(localModels);
  const serviceProbe = connectedHostServiceProbe(servicePosture);
  const authPosture = connectedHostAuthPosture(context, snapshot);
  const smokePlan = installSmokePlan(providerAccess, serviceProbe, authPosture);
  const vibeHealth = agentHarnessVibeHealth(context);
  const sudoPosture = sudoExecutionPosture(context);

  const plan: SetupPlanItem[] = [
    {
      id: 'connected-host-readiness',
      label: 'Connected host readiness',
      status: hostSetupStatus(snapshot, serviceProbe),
      priority: 10,
      blocksAutonomy: true,
      reason: 'Daemon-backed automation, Agent Knowledge, channels, and companion routes need a reachable compatible GoodVibes host.',
      nextAction: 'Run connected-host status, then start, update, or repair the owning GoodVibes host if the live check reports a gap.',
      userRoute: 'Agent Workspace -> Connected Host; /compat',
      modelRoute: 'host action:"status"',
      relatedSetupItemId: 'operator-terminal',
      signals: [
        serviceProbeSignal(serviceProbe),
        ...serviceProbe.issues.slice(0, 3),
        ...snapshot.collectionIssues.filter((issue) => issue.area === 'host').map((issue) => issue.message),
      ],
      repairCards: connectedHostRepairCards(snapshot, serviceProbe),
      serviceLifecycleDecision: setupServiceLifecycleDecision(snapshot, serviceProbe),
      bootstrapPlan: connectedHostBootstrapPlan(snapshot, serviceProbe),
      serviceProbe,
    },
    {
      id: 'connected-host-auth',
      label: 'Connected-host auth',
      status: connectedHostAuthStatus(authPosture),
      priority: 12,
      blocksAutonomy: true,
      reason: 'Protected daemon routes, approvals, schedules, channels, and Agent Knowledge writes need a usable connected-host operator token from the canonical GoodVibes host token store.',
      nextAction: connectedHostAuthNextAction(authPosture),
      userRoute: 'Agent Workspace -> Connected Host; /auth review',
      modelRoute: authPosture.operatorToken.usable
        ? 'host action:"status" includeParameters:true'
        : authPosture.routes.provisionTokenRoute,
      relatedSetupItemId: 'operator-terminal',
      signals: connectedHostAuthSignals(authPosture),
      authPosture,
    },
    {
      id: 'goodvibes-settings-import',
      label: 'GoodVibes settings import',
      status: settingsImport?.summary.parseErrors ? 'check' : settingsImportChanges > 0 ? 'recommended' : 'optional',
      priority: 15,
      blocksAutonomy: false,
      reason: 'Existing shared GoodVibes settings can seed Agent provider, subscription, behavior, permission, UI, TTS, channel, helper, tool, release, and automation state.',
      nextAction: settingsImportChanges > 0
        ? 'Preview the import, explain the changed setting and subscription counts, then apply only after the user confirms the import.'
        : 'Use this when reusing settings from GoodVibes TUI or another published GoodVibes platform store; the preview shows whether anything importable is present.',
      userRoute: 'Agent Workspace -> Start -> Import GoodVibes settings',
      modelRoute: 'import_goodvibes_settings action:"preview"',
      signals: settingsImportSignals(settingsImport),
    },
    {
      id: 'provider-access',
      label: 'Provider and model access',
      status: setupPlanStatusForCapability(providerAccess, 'blocked'),
      priority: 20,
      blocksAutonomy: true,
      reason: providerAccess.detail,
      nextAction: providerAccess.selected ? 'Review the current model route and provider accounts.' : 'Choose a provider/model route or store a provider credential before relying on assistant turns.',
      userRoute: 'Agent Workspace -> Start -> Choose main model',
      modelRoute: 'models action:"status|providers"',
      relatedSetupItemId: providerAccess.id,
      signals: setupProviderSignalIds(snapshot),
    },
    {
      id: 'install-smoke',
      label: 'Install smoke',
      status: smokePlan.status === 'ready-to-run' ? 'recommended' : 'blocked',
      priority: 22,
      blocksAutonomy: false,
      reason: 'A fresh install should be provable from package binary to reachable host, usable auth, selected model route, reviewed setup posture, and one successful assistant turn.',
      nextAction: smokePlan.status === 'ready-to-run'
        ? 'Run the confirmed setup smoke route, then complete the user-visible package/status and first-turn checks.'
        : 'Resolve connected-host, connected-host auth, and provider/model blockers, then rerun the confirmed setup smoke route.',
      userRoute: 'Agent Workspace -> Start',
      modelRoute: 'setup action:"smoke" setupItemId:"install-smoke"',
      signals: installSmokeSignals(smokePlan),
      installSmokePlan: smokePlan,
    },
    {
      id: 'local-model-readiness',
      label: 'Local model readiness',
      status: localModelSetupStatus(localModels),
      priority: 25,
      blocksAutonomy: false,
      reason: 'A local route gives the assistant a private/offline fallback and can reduce cost, but it should be set up through visible server, refresh, and benchmark steps.',
      nextAction: localModelSetupNextAction(localModels),
      userRoute: 'Agent Workspace -> Start -> Use a local model (no sign-in)',
      modelRoute: 'models action:"local"',
      signals: localModelSetupSignals(localModels),
      localModelReadiness,
    },
    {
      id: 'agent-knowledge',
      label: 'Agent Knowledge readiness',
      status: 'recommended',
      priority: 30,
      blocksAutonomy: false,
      reason: agentKnowledge.detail,
      nextAction: 'Inspect isolated Agent Knowledge status before source-backed memory or research ingest.',
      userRoute: 'Agent Workspace -> Knowledge',
      modelRoute: 'host action:"status" or agent_knowledge',
      relatedSetupItemId: agentKnowledge.id,
    },
    {
      id: 'vibe-personality',
      label: 'VIBE.md personality',
      status: vibeHealth.status,
      priority: 35,
      blocksAutonomy: false,
      reason: 'VIBE.md is the user-friendly personality file for how GoodVibes Agent should feel, but blocked or truncated files should be visible before they shape a session.',
      nextAction: vibeHealth.nextAction,
      userRoute: vibeHealth.userRoute,
      modelRoute: vibeHealth.modelRoute,
      signals: vibeHealth.signals,
      vibeHealth,
    },
    {
      id: 'local-behavior',
      label: 'Local memory, skills, and routines',
      status: setupPlanStatusForCapability(localBehavior, 'recommended'),
      priority: 40,
      blocksAutonomy: false,
      reason: localBehavior.detail,
      nextAction: localBehavior.selected ? 'Review imported or customized local behavior.' : 'Import discovered behavior files or create the first persona, skill, or routine.',
      userRoute: 'Agent Workspace -> Local Context',
      modelRoute: 'memory action:"curator" or agent_harness mode:"workspace_actions" categoryId:"onboarding-context"',
      relatedSetupItemId: localBehavior.id,
    },
    {
      id: 'communication-channels',
      label: 'Communication channels',
      status: setupPlanStatusForCapability(communicationChannels, 'optional'),
      priority: 50,
      blocksAutonomy: false,
      reason: communicationChannels.detail,
      nextAction: communicationChannels.selected ? 'Review channel readiness and delivery safety.' : 'Enable only the channels where the assistant should be reachable.',
      userRoute: 'Agent Workspace -> Messaging',
      modelRoute: 'channels action:"status"',
      relatedSetupItemId: communicationChannels.id,
      signals: snapshot.surfaces.configuredEnabledKinds,
    },
    {
      id: 'automation-review',
      label: 'Automation review',
      status: setupPlanStatusForCapability(automationReview, 'recommended'),
      priority: 60,
      blocksAutonomy: false,
      reason: automationReview.detail,
      nextAction: 'Review schedules, approvals, routine promotion, and visible autonomy queue controls before ongoing background work.',
      userRoute: 'Agent Workspace -> Personal Ops -> Autonomy queue',
      modelRoute: 'autonomy action:"queue"',
      relatedSetupItemId: automationReview.id,
    },
    {
      id: 'browser-desktop-control',
      label: 'Browser and desktop control',
      status: browserControl.status === 'ready' ? 'ready' : browserControl.status === 'attention' ? 'check' : 'recommended',
      priority: 65,
      blocksAutonomy: false,
      reason: browserControl.configured
        ? 'A trusted browser, desktop, computer-use, screenshot, or screen-recording route is configured.'
        : browserControl.status === 'attention'
          ? 'A browser or desktop connector is present but needs trust, connection, or schema review before use.'
        : 'Live browser navigation, UI testing, screenshots, screen recording, and desktop or device actions need a trusted MCP server or first-class tool before the Agent can perform them.',
      nextAction: browserControl.configured
        ? 'Inspect the browser/desktop execution route before using live UI automation.'
        : browserControl.status === 'attention'
          ? 'Review the matching MCP server trust, connection, and schema freshness before using live UI automation.'
        : 'Configure and review a trusted browser or desktop MCP server, then inspect the execution route before offering live UI automation.',
      userRoute: 'Agent Workspace -> Tools & MCP',
      modelRoute: browserControl.recommendedRoute,
      signals: browserControlSignals(browserControl),
    },
    {
      id: 'sudo-execution-posture',
      label: 'Sudo execution posture',
      status: sudoPosture.setupStatus,
      priority: 66,
      blocksAutonomy: false,
      reason: 'Privilege escalation must stay explicit, visible, and user-supervised; background sudo prompts, stdin password writes, and raw password display are blocked until the SDK/daemon publishes safe mediation.',
      nextAction: sudoPosture.nextAction,
      userRoute: 'Agent Workspace -> Work & Approvals -> Process capabilities',
      modelRoute: sudoPosture.setupRoute,
      signals: sudoPosture.signals,
      sudoPosture,
    },
    {
      id: 'build-delegation',
      label: 'Build delegation boundary',
      status: setupPlanStatusForCapability(tuiDelegation, 'optional'),
      priority: 70,
      blocksAutonomy: false,
      reason: tuiDelegation.detail,
      nextAction: 'Use delegation for explicit build, fix, review, isolation, or parallelism work rather than as a setup prerequisite.',
      userRoute: 'Agent Workspace -> Work & Approvals -> Delegate a build task',
      modelRoute: 'delegation action:"status"',
      relatedSetupItemId: tuiDelegation.id,
    },
    {
      id: 'finish-onboarding',
      label: 'Finish onboarding state',
      status: setupMarkerDone ? 'ready' : 'recommended',
      priority: 80,
      blocksAutonomy: false,
      reason: setupMarkerDone ? 'A setup marker already exists for this Agent scope.' : 'No setup marker exists yet, so the user may see first-run guidance again.',
      nextAction: setupMarkerDone ? 'Reopen setup only when changing provider, channel, automation, or local behavior decisions.' : 'Open onboarding, review the selected choices, then apply and close when the assistant is usable.',
      userRoute: 'Agent Workspace -> Finish',
      modelRoute: 'agent_harness mode:"open_ui_surface" surfaceId:"onboarding"',
    },
  ];

  return plan.sort((left, right) => left.priority - right.priority);
}
