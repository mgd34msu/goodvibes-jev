import type { RouteCandidateDraft } from './agent-route-planner.ts';
import { directScheduleLike, externalChannelLike, externalMemoryProviderId, externalMemoryProviderLike, hasAll, hasAny, hostDiagnosticsLike, localModelLike, localModelSmokeLike, modelProviderId, modelRouteReadinessLike, personalOpsBriefingLike, personalOpsConnectorSetupLike, personalOpsFreshReadLike, personalOpsLaneFromText, personalOpsLike, personalOpsMutationLike, personalOpsQueueLike, providerAccountLike, quote } from './agent-route-planner-helpers.ts';

export function addSetupModelContextRouteCandidates(
  lower: string,
  request: string,
  add: (candidate: RouteCandidateDraft) => void,
): void {
if (hasAny(lower, ['setup', 'first run', 'first-run', 'install', 'bootstrap', 'onboarding', 'start host', 'start daemon', 'goodvibes-daemon', 'connected host', 'token', 'smoke'])) {
    add({
      id: 'setup-and-host-readiness',
      label: 'Guided setup or connected-host repair',
      score: 95,
      userSurface: 'Start workspace',
      userOutcome: 'Get the assistant reachable and working before asking the user to diagnose topology.',
      why: 'The request is about install, first-run setup, host availability, auth, token, or setup smoke evidence.',
      modelRoute: 'setup action:"status" includeParameters:true',
      inspectRoute: 'host action:"status" includeParameters:true',
      userRoute: 'Agent Workspace -> Start',
      requiresConfirmation: false,
      supportingRoutes: [
        'setup action:"item" setupItemId:"connected-host-service"',
        'setup action:"token" confirm:true explicitUserRequest:"..."',
        'setup action:"smoke" confirm:true explicitUserRequest:"..."',
        'host action:"services" includeParameters:true',
      ],
      policy: 'Setup inspection is read-only; token repair, smoke execution, service lifecycle, and finish markers stay confirmed.',
    });
  }

  if (hostDiagnosticsLike(lower)) {
    add({
      id: 'host-runtime-diagnostics',
      label: 'Connected host diagnostics',
      score: 97,
      userSurface: 'Start workspace diagnostics',
      userOutcome: 'Inspect daemon, host, service, and compatibility health through read-only connected-host diagnostics.',
      why: 'The request asks for daemon, host, service, health, doctor, readiness, or compatibility diagnostics.',
      modelRoute: 'host action:"status" includeParameters:true',
      inspectRoute: 'host action:"capabilities" includeParameters:true',
      userRoute: 'Agent Workspace -> Start',
      requiresConfirmation: false,
      supportingRoutes: [
        'host action:"services" includeParameters:true',
        'host action:"methods" includeParameters:true',
        'setup action:"repair" target:"host" includeParameters:true',
        'setup action:"smoke" confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Host diagnostics are read-only. Service lifecycle, setup smoke, token repair, and operator methods remain explicit confirmed routes.',
    });
  }

  if (hasAll(lower, ['goodvibes', 'settings']) || hasAny(lower, ['import settings', 'tui settings', 'shared settings', 'copy settings', 'settings import'])) {
    add({
      id: 'goodvibes-settings-import',
      label: 'Preview or import GoodVibes settings',
      score: 100,
      userSurface: 'Start workspace settings import',
      userOutcome: 'Import compatible shared GoodVibes settings and subscription state into Agent-owned settings while capability implementations remain in their owning packages.',
      why: 'The request asks to import or inspect existing GoodVibes settings.',
      modelRoute: 'settings action:"import"',
      inspectRoute: 'import_goodvibes_settings action:"preview"',
      userRoute: 'Agent Workspace -> Start -> Import GoodVibes settings',
      requiresConfirmation: true,
      supportingRoutes: [
        'settings action:"import" confirm:true explicitUserRequest:"..."',
        'workspace action:"run" actionId:"import-goodvibes-tui-settings" confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Import previews are read-only; apply imports only Agent-owned settings and subscription state after confirmation without mutating source package stores.',
    });
  }

  if (hasAny(lower, ['setting', 'settings', 'config', 'configuration', 'preference', 'preferences']) && !hasAny(lower, ['import settings', 'tui settings', 'copy settings', 'settings import'])) {
    const writeLike = hasAny(lower, ['set ', 'change', 'update', 'configure', 'reset', 'clear', 'default', 'restore']);
    add({
      id: 'agent-settings-configuration',
      label: 'Agent settings inspection or change',
      score: 84,
      userSurface: 'Settings workspace',
      userOutcome: 'Find the right Agent-owned setting and keep every setting mutation explicit and confirmed.',
      why: 'The request mentions settings, configuration, or preferences without asking for GoodVibes TUI import.',
      modelRoute: `settings action:"list" query:${quote(request)} includeParameters:true`,
      inspectRoute: 'settings action:"list" includeParameters:true',
      userRoute: 'Settings workspace (/settings)',
      requiresConfirmation: writeLike,
      missingFields: writeLike ? ['setting key', 'new value or reset target', 'confirmation'] : undefined,
      supportingRoutes: [
        'settings action:"get" target:"..." includeParameters:true',
        'settings action:"set" key:"..." value:... confirm:true explicitUserRequest:"..."',
        'settings action:"reset" key:"..." confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Settings search and inspection are read-only. Set/reset/import effects mutate only Agent-owned settings and require confirmation.',
    });
  }

  if (hasAny(lower, ['model', 'provider', 'openrouter', 'openai', 'anthropic', 'claude', 'subscription', 'local model', 'ollama', 'llama.cpp', 'llamacpp', 'vllm', 'context window', 'api key', 'local server', 'cookbook'])) {
    const providerId = modelProviderId(lower);

    if (localModelSmokeLike(lower)) {
      add({
        id: 'local-model-smoke-check',
        label: 'Local model server smoke check',
        score: 98,
        userSurface: 'Models workspace',
        userOutcome: 'Check local model endpoints only through the confirmed smoke route with clear success criteria.',
        why: 'The request asks to check, smoke, or verify local model server health.',
        modelRoute: `models action:"smoke" query:${quote(request)} includeParameters:true`,
        inspectRoute: 'models action:"local" query:"local server health" includeParameters:true',
        userRoute: 'Agent Workspace -> Models',
        requiresConfirmation: true,
        missingFields: ['local endpoint or route id when multiple candidates exist', 'timeout when not default', 'confirmation before probing local servers'],
        supportingRoutes: [
          `models action:"local" query:${quote(request)} includeParameters:true`,
          'models action:"route" target:"local" includeParameters:true',
          'setup action:"item" setupItemId:"local-model-readiness"',
        ],
        policy: 'Local model discovery is read-only. Smoke checks may contact local endpoints and require confirm:true plus explicitUserRequest.',
      });
    }

    if (localModelLike(lower)) {
      const localEffect = hasAny(lower, ['download', 'install', 'start', 'serve', 'run ', 'set up', 'setup']);
      add({
        id: 'local-model-cookbook-route',
        label: 'Local model cookbook and endpoint readiness',
        score: localModelSmokeLike(lower) ? 94 : 96,
        userSurface: 'Models workspace',
        userOutcome: 'Recommend local model recipes and inspect endpoint readiness before setup or smoke effects.',
        why: 'The request mentions local models, Ollama, llama.cpp, vLLM, LM Studio, cookbook recipes, or hardware fit.',
        modelRoute: `models action:"local" query:${quote(request)} includeParameters:true`,
        inspectRoute: 'models action:"status" query:"local" includeParameters:true',
        userRoute: 'Agent Workspace -> Models',
        requiresConfirmation: localEffect,
        missingFields: localEffect ? ['selected recipe or endpoint', 'install/start/smoke intent', 'confirmation before local setup or server probing'] : undefined,
        supportingRoutes: [
          'models action:"route" target:"local" includeParameters:true',
          'models action:"smoke" query:"local" confirm:true explicitUserRequest:"..."',
          'agent_model_compare mode:"compare" confirm:true explicitUserRequest:"..."',
        ],
        policy: 'Cookbook and endpoint readiness are read-only. Downloads, server starts, benchmark runs, route updates, and local smoke checks remain separate confirmed effects.',
      });
    }

    if (providerAccountLike(lower) && !localModelLike(lower)) {
      const providerEffect = hasAny(lower, ['connect', 'set up', 'setup', 'configure', 'add', 'login', 'sign in', 'api key', 'key', 'change', 'refresh']);
      add({
        id: 'model-provider-account-posture',
        label: 'Model provider account and subscription posture',
        score: 96,
        userSurface: 'Models workspace',
        userOutcome: 'Inspect provider account, subscription, and auth readiness before changing credentials or model routes.',
        why: 'The request mentions model providers, subscriptions, provider auth, or API keys.',
        modelRoute: providerId
          ? `models action:"provider" providerId:"${providerId}" includeParameters:true`
          : `models action:"providers" query:${quote(request)} includeParameters:true`,
        inspectRoute: 'models action:"providers" includeParameters:true',
        userRoute: 'Agent Workspace -> Models; /accounts',
        requiresConfirmation: providerEffect,
        missingFields: providerEffect ? ['provider id', 'credential or subscription setup route', 'confirmation before storing credentials or changing routes'] : undefined,
        supportingRoutes: [
          'settings action:"list" query:"provider model api key" includeHidden:true',
          'models action:"status" includeParameters:true',
          'models action:"route" target:"default" includeParameters:true',
        ],
        policy: 'Provider inspection is read-only. Credential storage, provider refreshes, and route changes stay on explicit confirmed settings or model-route effects.',
      });
    }

    if (modelRouteReadinessLike(lower)) {
      add({
        id: 'model-route-readiness',
        label: 'Model route fit and readiness',
        score: 94,
        userSurface: 'Models workspace',
        userOutcome: 'Inspect the best model route for context, tools, vision, cost, latency, and privacy before changing defaults.',
        why: 'The request asks to choose, compare, or inspect model route fit.',
        modelRoute: `models action:"route" query:${quote(request)} includeParameters:true`,
        inspectRoute: 'models action:"status" includeParameters:true',
        userRoute: 'Agent Workspace -> Models',
        requiresConfirmation: hasAny(lower, ['change', 'switch', 'set default', 'apply', 'use ']),
        missingFields: hasAny(lower, ['change', 'switch', 'set default', 'apply'])
          ? ['selected model route id', 'confirmation before route change']
          : undefined,
        supportingRoutes: [
          'models action:"status" includeParameters:true',
          'models action:"providers" includeParameters:true',
          'agent_model_compare mode:"compare" confirm:true explicitUserRequest:"..."',
        ],
        policy: 'Route inspection is read-only. Model comparisons and winner/default-route changes are separate confirmed routes with saved evidence.',
      });
    }

    add({
      id: 'model-provider-routing',
      label: 'Model/provider route readiness',
      score: 88,
      userSurface: 'Models workspace',
      userOutcome: 'Choose or diagnose model access without asking the user to know provider internals.',
      why: 'The request is about model choice, provider accounts, subscriptions, local models, or context-window fit.',
      modelRoute: 'models action:"status" includeParameters:true',
      inspectRoute: 'models action:"route" target:"..." includeParameters:true',
      userRoute: 'Agent Workspace -> Models',
      requiresConfirmation: false,
      supportingRoutes: [
        'models action:"local"',
        'models action:"providers"',
        'models action:"smoke" confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Model inspection and cookbook guidance are read-only; local smoke checks and route changes stay explicit confirmed actions.',
    });
  }

  if (hasAny(lower, ['vibe.md', 'vibe ', 'personality', 'tone', 'style', 'persona', 'soul.md']) || hasAny(lower, ['agents.md', '.hermes.md', 'claude.md', '.cursorrules', 'project context'])) {
    const contextRoute = hasAny(lower, ['agents.md', '.hermes.md', 'claude.md', '.cursorrules', 'project context'])
      ? 'context action:"files" includeParameters:true'
      : 'vibe action:"status" includeParameters:true';
    add({
      id: 'personality-and-context',
      label: 'Personality and project context',
      score: 86,
      userSurface: 'Local Context and Personas workspace',
      userOutcome: 'Inspect or update how the assistant should behave without hidden prompt surprises.',
      why: 'The request mentions VIBE.md, personality, personas, tone, or project instruction files.',
      modelRoute: contextRoute,
      inspectRoute: contextRoute,
      userRoute: 'Agent Workspace -> Local Context',
      requiresConfirmation: hasAny(lower, ['create', 'init', 'import', 'change', 'update']),
      supportingRoutes: [
        'vibe action:"show"',
        'vibe action:"init" confirm:true explicitUserRequest:"..."',
        'context action:"prompt" includeParameters:true',
        'memory action:"curator" includeParameters:true',
      ],
      policy: 'Context/personality inspection is read-only; VIBE.md creation or persona import requires confirmation and secret scanning.',
    });
  }

  if (hasAny(lower, ['memory', 'remember', 'forget', 'recall', 'skill', 'routine', 'learn', 'learning']) || externalMemoryProviderLike(lower)) {
    const providerId = externalMemoryProviderId(lower);
    if (externalMemoryProviderLike(lower)) {
      const externalEffect = hasAny(lower, ['connect', 'set up', 'setup', 'configure', 'enable', 'sync', 'import', 'export', 'write', 'upsert', 'delete', 'forget']);
      add({
        id: 'external-memory-provider-posture',
        label: 'External memory provider setup posture',
        score: 92,
        userSurface: 'Local Context workspace',
        userOutcome: 'Inspect provider readiness and required daemon/SDK contracts before promising external cross-session memory.',
        why: 'The request mentions an external memory provider, backend, sync, import/export, or a named provider such as Honcho, Mem0, or Supermemory.',
        modelRoute: providerId
          ? `memory action:"provider" providerId:"${providerId}" includeParameters:true`
          : 'memory action:"status" query:"external memory provider" includeParameters:true',
        inspectRoute: providerId
          ? `host action:"capability" query:"${providerId} memory provider"`
          : 'memory action:"status" query:"external memory provider" includeParameters:true',
        userRoute: 'Agent Workspace -> Local Context',
        requiresConfirmation: externalEffect,
        missingFields: [
          ...(providerId ? [] : ['provider id or backend name']),
          'published setup/status/read/write/receipt contract before external memory is considered ready',
          ...(externalEffect ? ['confirmation for any provider write, sync, import, export, or credential effect'] : []),
        ],
        supportingRoutes: [
          'memory action:"status" query:"external memory provider" includeParameters:true',
          'memory action:"provider" providerId:"honcho|mem0|supermemory" includeParameters:true',
          'host action:"capability" query:"memory provider"',
          'agent_harness mode:"mcp_servers" query:"memory provider"',
          'settings action:"list" query:"memory" includeHidden:true',
        ],
        policy: 'External memory posture is read-only. Agent-local memory remains the active path until SDK/daemon provider setup/status/read/write/sync contracts with secret-safe receipts are published for Agent to consume.',
      });
    }

    add({
      id: 'memory-learning',
      label: 'Memory, routines, skills, and learning review',
      score: 82,
      userSurface: 'Local Context workspace',
      userOutcome: 'Make durable learning reviewable, sourced, and reversible.',
      why: 'The request is about memory, recall, skills, routines, or external memory providers.',
      modelRoute: 'memory action:"status" includeParameters:true',
      inspectRoute: 'memory action:"curator" includeParameters:true',
      userRoute: 'Agent Workspace -> Local Context',
      requiresConfirmation: hasAny(lower, ['save', 'remember', 'forget', 'delete', 'merge', 'consolidate', 'create']),
      supportingRoutes: [
        'memory action:"list"',
        'memory action:"search" query:"..."',
        'memory action:"candidate" candidateId:"..."',
        'agent_learning_consolidation mode:"preview"',
      ],
      policy: 'Memory reads and review queues are safe; durable memory writes or consolidation phases require reviewed confirmed routes.',
    });
  }

  if (personalOpsLike(lower) && !externalChannelLike(lower) && !directScheduleLike(lower)) {
    const laneId = personalOpsLaneFromText(lower);
    const laneRoute = laneId ? `personal_ops action:"lane" laneId:"${laneId}" includeParameters:true` : 'personal_ops action:"status" includeParameters:true';
    const laneQueueQuery = laneId ? ` query:"${laneId}"` : '';
    const intakeRoute = `personal_ops action:"intake" query:${quote(request)} includeParameters:true`;

    if (personalOpsConnectorSetupLike(lower)) {
      const connectorEffect = hasAny(lower, ['connect', 'set up', 'setup', 'configure', 'enable', 'repair']);
      add({
        id: 'personal-ops-connector-setup',
        label: 'Personal Ops connector setup posture',
        score: 97,
        userSurface: 'Personal Ops workspace',
        userOutcome: 'Inspect the inbox or calendar connector lane before promising fresh provider data.',
        why: 'The request mentions Gmail, IMAP/SMTP, CalDAV, or an email/calendar connector setup task.',
        modelRoute: laneRoute,
        inspectRoute: 'personal_ops action:"status" includeParameters:true',
        userRoute: 'Agent Workspace -> Personal Ops -> Readiness map',
        requiresConfirmation: connectorEffect,
        missingFields: connectorEffect ? ['connector/provider choice', 'credential or MCP setup route', 'confirmation before any account or secret mutation'] : undefined,
        supportingRoutes: [
          intakeRoute,
          'agent_harness mode:"mcp_servers" query:"email calendar" includeParameters:true',
          'settings action:"list" query:"gmail imap smtp caldav" includeHidden:true',
        ],
        policy: 'Connector setup posture is read-only. Account connection, secret storage, MCP trust, and provider effects remain on explicit confirmed setup routes.',
      });
    }

    if (personalOpsBriefingLike(lower)) {
      add({
        id: 'personal-ops-daily-briefing',
        label: 'Personal Ops daily briefing',
        score: 96,
        userSurface: 'Personal Ops workspace',
        userOutcome: 'Start with one read-only daily plan across agenda, inbox, tasks, reminders, routines, delivery, and autonomy.',
        why: 'The request asks for a brief, briefing, agenda summary, or today view.',
        modelRoute: `personal_ops action:"briefing" query:${quote(request)} includeParameters:true`,
        inspectRoute: 'personal_ops action:"status" includeParameters:true',
        userRoute: 'Agent Workspace -> Personal Ops -> Daily briefing plan',
        requiresConfirmation: false,
        supportingRoutes: [
          'personal_ops action:"queue" includeParameters:true',
          'personal_ops action:"lane" laneId:"calendar" includeParameters:true',
          'autonomy action:"queue"',
          'schedule action:"list" limit:5',
        ],
        policy: 'Briefing is read-only. Live inbox/calendar reads, reminder creation, sends, edits, and schedule mutations stay on their owning confirmed routes.',
      });
    }

    if (personalOpsQueueLike(lower)) {
      add({
        id: 'personal-ops-review-queue',
        label: 'Personal Ops saved review queue',
        score: 96,
        userSurface: 'Personal Ops workspace',
        userOutcome: 'Review saved inbox threads and calendar events before doing fresh reads or provider effects.',
        why: 'The request asks for saved Personal Ops review queues or previously captured inbox/calendar cards.',
        modelRoute: `personal_ops action:"queue"${laneQueueQuery} includeParameters:true`,
        inspectRoute: laneRoute,
        userRoute: 'Agent Workspace -> Personal Ops -> Review queue',
        requiresConfirmation: false,
        supportingRoutes: [
          intakeRoute,
          'personal_ops action:"read" laneId:"inbox|calendar" recordId:"..." fields:{...} confirm:true explicitUserRequest:"..."',
          'agent_artifacts mode:"list" query:"personal ops review"',
        ],
        policy: 'Review queue inspection is read-only. Refreshing from a provider or applying send/edit/archive/RSVP effects requires a selected connector route and confirmation.',
      });
    }

    if (personalOpsFreshReadLike(lower)) {
      add({
        id: 'personal-ops-fresh-read-plan',
        label: 'Personal Ops fresh provider read plan',
        score: 95,
        userSurface: 'Personal Ops workspace',
        userOutcome: 'Select the safest read-only connector operation before fetching fresh inbox or calendar data.',
        why: 'The request asks to refresh, sync, fetch, or inspect unread/upcoming personal provider data.',
        modelRoute: intakeRoute,
        inspectRoute: laneRoute,
        userRoute: 'Agent Workspace -> Personal Ops -> Request planner',
        requiresConfirmation: true,
        missingFields: ['lane id', 'read-only connector operation record id', 'bounded input fields', 'confirmation before reading live personal provider data'],
        supportingRoutes: [
          laneRoute,
          'personal_ops action:"read" laneId:"inbox|calendar" recordId:"..." fields:{...} confirm:true explicitUserRequest:"..."',
          'personal_ops action:"queue" includeParameters:true',
        ],
        policy: 'Fresh provider reads are never implicit. The planner only selects the lane; one read-only connector operation still needs exact fields, confirm:true, and explicitUserRequest.',
      });
    }

    add({
      id: 'personal-ops-intake-route',
      label: 'Personal Ops request intake',
      score: hasAny(lower, ['email', 'inbox', 'calendar', 'agenda', 'draft reply', 'rsvp']) ? 94 : 78,
      userSurface: 'Personal Ops workspace',
      userOutcome: 'Triage personal data through reviewed lanes, redacted cards, and confirmed external effects.',
      why: 'The request involves inbox, email, calendar, notes, tasks, reminders, or reply drafting.',
      modelRoute: intakeRoute,
      inspectRoute: laneRoute,
      userRoute: 'Agent Workspace -> Personal Ops',
      requiresConfirmation: personalOpsFreshReadLike(lower) || personalOpsMutationLike(lower),
      missingFields: personalOpsMutationLike(lower)
        ? ['connector lane and record id', 'exact provider effect', 'confirmation']
        : undefined,
      supportingRoutes: [
        'personal_ops action:"briefing" includeParameters:true',
        'personal_ops action:"queue" includeParameters:true',
        laneRoute,
        'personal_ops action:"read" laneId:"inbox|calendar" recordId:"..." fields:{...} confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Personal Ops intake is read-only. Provider reads and every send/edit/archive/RSVP effect stay scoped and confirmed.',
    });
  }
}
