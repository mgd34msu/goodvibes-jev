import { quoteRouteValue, provisionConnectedHostTokenRoute } from './agent-harness-setup-posture-utils.ts';
import type { SetupHandoffCard, SetupPlanItem, SetupRepairCard } from './agent-harness-setup-posture-types.ts';

export function setupHandoff(options: SetupHandoffCard): SetupHandoffCard {
  return options;
}

export function confirmedWorkspaceActionRoute(actionId: string, explicitUserRequest: string): string {
  return `agent_harness mode:"run_workspace_action" actionId:"${quoteRouteValue(actionId)}" confirm:true explicitUserRequest:"${quoteRouteValue(explicitUserRequest)}"`;
}

export function inspectWorkspaceActionRoute(actionId: string): string {
  return `agent_harness mode:"workspace_action" actionId:"${quoteRouteValue(actionId)}" includeParameters:true`;
}

export function openSurfaceRoute(surfaceId: string, explicitUserRequest: string): string {
  return `agent_harness mode:"open_ui_surface" surfaceId:"${quoteRouteValue(surfaceId)}" confirm:true explicitUserRequest:"${quoteRouteValue(explicitUserRequest)}"`;
}

export function handoffFromRepairCard(card: SetupRepairCard): SetupHandoffCard | null {
  if (!card.modelRoute) return null;
  return setupHandoff({
    id: card.id,
    label: card.label,
    kind: card.methodId ? 'operator-method' : 'diagnostic',
    effect: card.effect,
    userRoute: card.userRoute,
    modelRoute: card.modelRoute,
    nextStep: card.effect === 'confirmed-effect'
      ? 'Confirm only after the diagnostic card proves this mutation is the right repair.'
      : 'Inspect this diagnostic before choosing any host repair.',
    safety: card.safety,
    ...(card.effect === 'confirmed-effect' ? { requiresConfirmation: true } : {}),
    ...(card.prerequisite ? { prerequisite: card.prerequisite } : {}),
  });
}

export function connectedHostReadinessHandoffs(item: SetupPlanItem): readonly SetupHandoffCard[] {
  const repairCards = item.repairCards ?? [];
  const recommendedRepairs = repairCards
    .filter((card) => card.state === 'available' && card.recommendation === 'recommended')
    .map(handoffFromRepairCard)
    .filter((card): card is SetupHandoffCard => card !== null)
    .slice(0, 2);
  const bootstrap = item.bootstrapPlan
    ? [setupHandoff({
      id: 'connected-host-bootstrap',
      label: item.bootstrapPlan.status === 'recommended' ? 'Show host bootstrap checklist' : 'Show host bootstrap reference',
      kind: 'user-command',
      effect: 'user-run',
      userRoute: item.userRoute,
      modelRoute: 'setup action:"item" setupItemId:"connected-host-readiness"',
      nextStep: 'Show the Bun install, service start, binary verification, and reconnect commands for the user to run on the owning host.',
      safety: item.bootstrapPlan.policy,
    })]
    : [];
  return [
    setupHandoff({
      id: 'connected-host-status',
      label: 'Inspect connected-host status',
      kind: 'diagnostic',
      effect: 'read-only',
      userRoute: item.userRoute,
      modelRoute: 'host action:"status" includeParameters:true',
      nextStep: 'Check reachability, compatibility, token posture, and Agent Knowledge readiness before repair.',
      safety: 'Read-only host diagnostic; redacts token values.',
    }),
    ...recommendedRepairs,
    ...bootstrap,
    setupHandoff({
      id: 'service-posture',
      label: 'Inspect service posture',
      kind: 'diagnostic',
      effect: 'read-only',
      userRoute: '/health',
      modelRoute: 'host action:"services" includeParameters:true',
      nextStep: 'Review endpoint binding, reachability, and logs when host status is inconclusive.',
      safety: 'Read-only service diagnostic.',
    }),
  ];
}

export function setupHandoffsForItem(item: SetupPlanItem): readonly SetupHandoffCard[] {
  switch (item.id) {
    case 'connected-host-readiness':
      return connectedHostReadinessHandoffs(item);
    case 'connected-host-auth': {
      const authPosture = item.authPosture;
      const tokenUsable = authPosture?.operatorToken.usable === true;
      return [
        tokenUsable
          ? setupHandoff({
            id: 'verify-connected-host-auth',
            label: 'Verify connected-host auth',
            kind: 'diagnostic',
            effect: 'read-only',
            userRoute: item.userRoute,
            modelRoute: 'host action:"status" includeParameters:true',
            nextStep: 'Verify protected route readiness and Agent Knowledge before relying on daemon-backed automation.',
            safety: 'Read-only diagnostic; token values are never returned.',
          })
          : setupHandoff({
            id: 'provision-connected-host-token',
            label: 'Provision connected-host token',
            kind: 'confirmed-route',
            effect: 'confirmed-effect',
            userRoute: item.userRoute,
            modelRoute: authPosture?.routes.provisionTokenRoute ?? provisionConnectedHostTokenRoute(),
            nextStep: 'Create or repair the local companion token file, then rerun auth and connected-host status.',
            safety: 'Confirmed local token provisioning; returns only path, fingerprint, peer id, and timestamps, never the raw token.',
            requiresConfirmation: true,
          }),
        setupHandoff({
          id: 'pairing-posture',
          label: 'Inspect pairing posture',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: '/qrcode (alias /pair)',
          modelRoute: 'agent_harness mode:"pairing_posture" includeParameters:true',
          nextStep: 'Use the visible QR/manual pairing routes when the user needs a non-file token handoff.',
          safety: 'Read-only pairing posture; no token is printed by setup posture.',
        }),
      ];
    }
    case 'goodvibes-settings-import':
      return [
        setupHandoff({
          id: 'preview-goodvibes-settings-import',
          label: 'Preview GoodVibes import',
          kind: 'workspace-action',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'import_goodvibes_settings action:"preview"',
          nextStep: 'Show importable setting and subscription counts before any import.',
          safety: 'Read-only preview; raw provider secrets are not returned.',
        }),
        setupHandoff({
          id: 'apply-goodvibes-settings-import',
          label: 'Apply GoodVibes import',
          kind: 'workspace-action',
          effect: 'confirmed-effect',
          userRoute: item.userRoute,
          modelRoute: 'setup action:"import_settings" confirm:true explicitUserRequest:"Import reviewed shared GoodVibes settings into Agent-owned state."',
          nextStep: 'Apply only after the user has reviewed the preview and wants Agent to import the values.',
          safety: 'Confirmed Agent-owned settings import; does not mutate source GoodVibes platform stores.',
          requiresConfirmation: true,
        }),
      ];
    case 'provider-access':
      return [
        setupHandoff({
          id: 'open-main-model-picker',
          label: 'Open main model picker',
          kind: 'ui-surface',
          effect: 'visible-navigation',
          userRoute: item.userRoute,
          modelRoute: openSurfaceRoute('model-picker', 'Choose the main provider and model route for normal assistant turns.'),
          nextStep: 'Let the user choose the normal assistant route in the visible provider/model picker.',
          safety: 'Visible UI navigation; provider/model selection remains in the shared picker flow.',
          requiresConfirmation: true,
        }),
        setupHandoff({
          id: 'inspect-model-routing',
          label: 'Inspect model routing',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: 'Agent Workspace -> Models',
          modelRoute: 'models action:"status" includeParameters:true',
          nextStep: 'Inspect current route, provider readiness, local recipes, and route quality before choosing.',
          safety: 'Read-only model routing posture.',
        }),
        setupHandoff({
          id: 'inspect-provider-accounts',
          label: 'Inspect provider accounts',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: '/accounts',
          modelRoute: 'models action:"providers" includeParameters:true',
          nextStep: 'Review provider account readiness and credential posture without printing secrets.',
          safety: 'Read-only account posture; secret values are never returned.',
        }),
      ];
    case 'install-smoke':
      return [
        setupHandoff({
          id: 'run-setup-smoke',
          label: item.status === 'blocked' ? 'List smoke blockers' : 'Run setup smoke',
          kind: 'confirmed-route',
          effect: 'confirmed-effect',
          userRoute: item.userRoute,
          modelRoute: 'setup action:"smoke" setupItemId:"install-smoke" confirm:true explicitUserRequest:"Run the install smoke checks."',
          nextStep: item.status === 'blocked'
            ? 'Return the exact blocked checks and user-run checks without running shell or host commands implicitly.'
            : 'Capture the setup smoke result and then save redacted user-run evidence.',
          safety: 'Confirmed token-safe setup smoke; no package, host, or shell commands run implicitly.',
          requiresConfirmation: true,
        }),
        setupHandoff({
          id: 'inspect-smoke-plan',
          label: 'Inspect smoke plan',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'setup action:"item" setupItemId:"install-smoke"',
          nextStep: 'Review check status, success criteria, and policy before asking the user to run evidence commands.',
          safety: 'Read-only smoke plan.',
        }),
      ];
    case 'local-model-readiness':
      return [
        setupHandoff({
          id: 'inspect-local-model-cookbook',
          label: 'Inspect local model cookbook',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'models action:"local" includeParameters:true',
          nextStep: 'Review detected local routes, top recipe, setup gaps, and benchmark route before changing defaults.',
          safety: 'Read-only model cookbook; local server install/start remains user-run.',
        }),
        setupHandoff({
          id: 'open-local-model-picker',
          label: 'Open model picker',
          kind: 'ui-surface',
          effect: 'visible-navigation',
          userRoute: 'Agent Workspace -> Models',
          modelRoute: openSurfaceRoute('model-picker', 'Review or choose the main local model route.'),
          nextStep: 'Use the visible picker only after local readiness and benchmark evidence are reviewed.',
          safety: 'Visible UI navigation; route change stays explicit.',
          requiresConfirmation: true,
        }),
      ];
    case 'agent-knowledge':
      return [
        setupHandoff({
          id: 'agent-knowledge-status',
          label: 'Inspect Agent Knowledge status',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'agent_knowledge action:"status"',
          nextStep: 'Verify isolated Agent Knowledge readiness, counts, and connector posture before ingesting sources.',
          safety: 'Read-only Agent Knowledge status; never falls back to default knowledge.',
        }),
        setupHandoff({
          id: 'open-knowledge-panel',
          label: 'Open Knowledge panel',
          kind: 'ui-surface',
          effect: 'visible-navigation',
          userRoute: item.userRoute,
          modelRoute: openSurfaceRoute('knowledge-panel', 'Review isolated Agent Knowledge readiness.'),
          nextStep: 'Open the visible Knowledge workspace for source, search, connector, and ingest controls.',
          safety: 'Visible UI navigation; ingest and review actions remain separate confirmed routes.',
          requiresConfirmation: true,
        }),
      ];
    case 'local-behavior':
      return [
        setupHandoff({
          id: 'review-local-behavior',
          label: 'Review local behavior',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'memory action:"curator" includeParameters:true',
          nextStep: 'Review memory, notes, personas, skills, routines, and suggested local behavior updates.',
          safety: 'Read-only curator posture; creates and imports stay confirmed workspace actions.',
        }),
        setupHandoff({
          id: 'capture-learned-behavior',
          label: 'Capture learned behavior',
          kind: 'workspace-action',
          effect: 'confirmed-effect',
          userRoute: 'Agent Workspace -> Local Context',
          modelRoute: confirmedWorkspaceActionRoute('learned-behavior', 'Save a reviewed lesson, workflow, or operating style as Agent-local behavior.'),
          nextStep: 'Create a persona, skill, or routine only from a reviewed user-visible lesson.',
          safety: 'Confirmed Agent-local behavior write; no default knowledge write.',
          requiresConfirmation: true,
        }),
      ];
    case 'vibe-personality':
      return [
        setupHandoff({
          id: 'inspect-vibe-status',
          label: 'Inspect VIBE.md status',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'vibe action:"status"',
          nextStep: 'Review applied, blocked, and truncated VIBE.md personality files before relying on custom assistant tone.',
          safety: 'Read-only personality inspection; blocked VIBE.md content is not loaded into the prompt.',
        }),
        setupHandoff({
          id: 'show-vibe-status',
          label: 'Show VIBE.md status',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'vibe action:"show" scope:"project"',
          nextStep: 'Inspect the project VIBE.md body only after the file passes the VIBE.md secret-looking content scan.',
          safety: 'Read-only personality file inspection; blocked file bodies are never returned.',
        }),
        setupHandoff({
          id: 'init-project-vibe',
          label: 'Create project VIBE.md',
          kind: 'confirmed-route',
          effect: 'confirmed-effect',
          userRoute: item.userRoute,
          modelRoute: 'vibe action:"init" scope:"project" confirm:true explicitUserRequest:"Create a project VIBE.md personality file."',
          nextStep: 'Create a starter project personality file only when the user wants a local assistant vibe.',
          safety: 'Confirmed local file write in the current project scope.',
          requiresConfirmation: true,
        }),
        setupHandoff({
          id: 'import-vibe-persona',
          label: 'Import VIBE.md persona',
          kind: 'confirmed-route',
          effect: 'confirmed-effect',
          userRoute: item.userRoute,
          modelRoute: 'vibe action:"import_persona" scope:"project" review:true use:true confirm:true explicitUserRequest:"Import the project VIBE.md into a reviewed active persona."',
          nextStep: 'Use this when the user wants VIBE.md to become reviewed Agent-local persona context.',
          safety: 'Confirmed Agent-local persona write; does not ingest VIBE.md into default knowledge.',
          requiresConfirmation: true,
        }),
      ];
    case 'communication-channels':
      return [
        setupHandoff({
          id: 'inspect-channels',
          label: 'Inspect channel readiness',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'channels action:"status" includeParameters:true',
          nextStep: 'Review paired surfaces, delivery targets, and channel safety before sending or enabling reminders.',
          safety: 'Read-only channel posture; no external message is sent.',
        }),
        setupHandoff({
          id: 'open-channels-workspace',
          label: 'Open Channels workspace',
          kind: 'ui-surface',
          effect: 'visible-navigation',
          userRoute: item.userRoute,
          modelRoute: 'agent_harness mode:"open_ui_surface" surfaceId:"agent-workspace" target:"channels" confirm:true explicitUserRequest:"Open the Channels workspace for communication setup."',
          nextStep: 'Use visible channel setup only for surfaces where the assistant should be reachable.',
          safety: 'Visible UI navigation; channel pairing and delivery remain explicit.',
          requiresConfirmation: true,
        }),
      ];
    case 'sudo-execution-posture':
      return [
        setupHandoff({
          id: 'inspect-sudo-posture',
          label: 'Inspect sudo posture',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'setup action:"item" setupItemId:"sudo-execution-posture"',
          nextStep: 'Review foreground-only escalation posture, SUDO_PASSWORD presence, blocked background routes, and missing SDK/daemon contracts.',
          safety: 'Read-only setup posture; raw sudo password values are never read, stored, or returned.',
        }),
        setupHandoff({
          id: 'inspect-process-parity',
          label: 'Inspect process parity',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: 'Agent Workspace -> Work & Approvals -> Process capabilities',
          modelRoute: 'process action:"capabilities"',
          nextStep: 'Check process list, poll, wait, log, kill, write, PTY, and sudo parity before choosing a process route.',
          safety: 'Read-only parity report; does not start, stop, write to, or escalate a process.',
        }),
        setupHandoff({
          id: 'inspect-foreground-shell-route',
          label: 'Inspect foreground shell route',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: 'Agent Workspace -> Work & Approvals',
          modelRoute: 'execution action:"route" id:"local-shell-command"',
          nextStep: 'Use only visible foreground shell execution for explicit user-requested sudo until safe credential mediation exists.',
          safety: 'Read-only route inspection; actual shell execution remains governed by the foreground exec policy.',
        }),
        setupHandoff({
          id: 'review-sudo-env-guidance',
          label: 'Review SUDO_PASSWORD guidance',
          kind: 'user-command',
          effect: 'user-run',
          userRoute: item.sudoPosture?.credentialSignal.envFilePath ?? '~/.goodvibes/.env',
          modelRoute: 'setup action:"item" setupItemId:"sudo-execution-posture"',
          nextStep: 'If a future safe credential contract requires SUDO_PASSWORD, the user configures it outside Agent and Agent only reports presence.',
          safety: 'No Agent write route exists for sudo credentials; password values stay outside model-visible output.',
        }),
      ];
    case 'automation-review':
      return [
        setupHandoff({
          id: 'inspect-autonomy-queue',
          label: 'Inspect autonomy queue',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'autonomy action:"queue" includeParameters:true',
          nextStep: 'Review visible schedules, approvals, work plans, automation runs, receipts, and cancel routes.',
          safety: 'Read-only autonomy queue posture.',
        }),
        setupHandoff({
          id: 'open-automation-workspace',
          label: 'Open Automation workspace',
          kind: 'ui-surface',
          effect: 'visible-navigation',
          userRoute: 'Agent Workspace -> Automation',
          modelRoute: 'agent_harness mode:"open_ui_surface" surfaceId:"agent-workspace" target:"automation" confirm:true explicitUserRequest:"Open Automation workspace for schedule and background work setup."',
          nextStep: 'Create reminders or promote routines only through confirmed visible forms.',
          safety: 'Visible UI navigation; schedule and run mutations remain confirmed.',
          requiresConfirmation: true,
        }),
      ];
    case 'browser-desktop-control':
      return [
        setupHandoff({
          id: 'inspect-browser-desktop-route',
          label: 'Inspect browser and desktop route',
          kind: 'tool-discovery',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: item.modelRoute,
          nextStep: 'Review MCP trust, connection, schema freshness, and execution route before live UI automation.',
          safety: 'Read-only tool posture; no browser or desktop action is executed.',
        }),
        setupHandoff({
          id: 'open-tools-mcp-workspace',
          label: 'Open Tools & MCP workspace',
          kind: 'ui-surface',
          effect: 'visible-navigation',
          userRoute: item.userRoute,
          modelRoute: 'agent_harness mode:"open_ui_surface" surfaceId:"agent-workspace" target:"tools" confirm:true explicitUserRequest:"Open Tools and MCP setup for browser or desktop control."',
          nextStep: 'Configure and review only trusted browser or desktop connectors.',
          safety: 'Visible UI navigation; connector writes stay in confirmed setup forms.',
          requiresConfirmation: true,
        }),
      ];
    case 'build-delegation':
      return [
        setupHandoff({
          id: 'inspect-delegation-posture',
          label: 'Inspect delegation posture',
          kind: 'diagnostic',
          effect: 'read-only',
          userRoute: item.userRoute,
          modelRoute: 'delegation action:"status" includeParameters:true',
          nextStep: 'Check explicit GoodVibes TUI handoff routes and boundaries before delegating code work.',
          safety: 'Read-only delegation posture; no task is delegated.',
        }),
        setupHandoff({
          id: 'delegate-build-task',
          label: 'Delegate build task',
          kind: 'workspace-action',
          effect: 'confirmed-effect',
          userRoute: 'Agent Workspace -> Work & Approvals -> Delegate a build task',
          modelRoute: confirmedWorkspaceActionRoute('delegate-task', 'Delegate one explicit build, fix, review, or isolation task to GoodVibes TUI.'),
          nextStep: 'Use only when isolation, parallelism, remote execution, or explicit user request makes delegation helpful.',
          safety: 'Confirmed delegation; preserves the original ask and keeps review explicit.',
          requiresConfirmation: true,
        }),
      ];
    case 'finish-onboarding':
      return [
        setupHandoff({
          id: 'finish-onboarding',
          label: 'Apply and close onboarding',
          kind: 'workspace-action',
          effect: 'confirmed-effect',
          userRoute: 'Agent Workspace -> Finish',
          modelRoute: 'setup action:"finish" confirm:true explicitUserRequest:"Finish Agent onboarding after setup review."',
          nextStep: 'Persist the setup completion marker only after the assistant is usable.',
          safety: 'Confirmed local onboarding marker write; no provider, host, channel, or automation mutation.',
          requiresConfirmation: true,
        }),
        setupHandoff({
          id: 'open-onboarding',
          label: 'Open onboarding',
          kind: 'ui-surface',
          effect: 'visible-navigation',
          userRoute: item.userRoute,
          modelRoute: openSurfaceRoute('onboarding', 'Review Agent onboarding before finishing setup.'),
          nextStep: 'Review selected setup choices in the visible onboarding surface.',
          safety: 'Visible UI navigation only.',
          requiresConfirmation: true,
        }),
      ];
    default:
      return [setupHandoff({
        id: `${item.id}-inspect`,
        label: `Inspect ${item.label}`,
        kind: 'diagnostic',
        effect: 'read-only',
        userRoute: item.userRoute,
        modelRoute: item.modelRoute,
        nextStep: item.nextAction,
        safety: 'Read-only setup inspection unless the returned route explicitly requires confirmation.',
      })];
  }
}
