import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';

const AGENT_CONTEXT_TOOL_MODES = [
  'summary',
  'capabilities',
  'modes',
  'tools',
  'tool',
  'settings',
  'setting',
  'commands',
  'command',
  'workspace',
  'status',
] as const;

type AgentContextMode = typeof AGENT_CONTEXT_TOOL_MODES[number];

type AgentContextArgs = {
  readonly mode?: unknown;
  readonly query?: unknown;
  readonly target?: unknown;
  readonly toolName?: unknown;
  readonly command?: unknown;
  readonly commandName?: unknown;
  readonly key?: unknown;
  readonly category?: unknown;
  readonly prefix?: unknown;
  readonly includeHidden?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
};

const CONTEXT_TOOL_FALLBACK = {
  runtime: 'GoodVibes Agent',
  preferredTool: 'agent_harness',
  routes: {
    summary: 'agent_harness mode:"summary"',
    capabilities: 'goodvibes_context mode:"capabilities"',
    tools: 'agent_harness mode:"tools"',
    tool: 'agent_harness mode:"tool"',
    settings: 'settings action:"list"',
    commands: 'workspace action:"commands"',
    workspace: 'workspace action:"status"',
    status: 'host action:"status"',
  },
};

export function wrapAgentContextToolForAgentPolicy(tool: Tool, registry?: ToolRegistry): void {
  tool.definition.description = 'Inspect GoodVibes Agent harness capabilities.';
  tool.definition.sideEffects = [];
  tool.definition.parameters = {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: [...AGENT_CONTEXT_TOOL_MODES] },
      query: { type: 'string' },
      target: { type: 'string' },
      toolName: { type: 'string' },
      command: { type: 'string' },
      commandName: { type: 'string' },
      key: { type: 'string' },
      category: { type: 'string' },
      prefix: { type: 'string' },
      includeHidden: { type: 'boolean' },
      includeParameters: { type: 'boolean' },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  };
  tool.execute = async (rawArgs, options) => {
    const args = rawArgs as AgentContextArgs;
    const mode = readAgentContextMode(args.mode);
    if (mode === 'capabilities') return ok(buildAgentCapabilitiesContract(registry));

    const harnessMode = agentContextModeToHarnessMode(mode);
    const harnessTool = registry?.list().find((entry) => entry.definition.name === 'agent_harness');
    if (!harnessTool) {
      return ok({
        ...CONTEXT_TOOL_FALLBACK,
        status: 'agent_harness_not_registered_yet',
        requestedMode: mode,
        route: `agent_harness mode:"${harnessMode}"`,
      });
    }

    const harnessArgs = {
      mode: harnessMode,
      query: args.query,
      target: args.target,
      toolName: args.toolName,
      command: args.command,
      commandName: args.commandName,
      key: args.key,
      category: args.category,
      prefix: args.prefix,
      includeHidden: args.includeHidden,
      includeParameters: args.includeParameters,
      limit: args.limit,
    };
    const result = await harnessTool.execute(dropUndefined(harnessArgs), options);
    if (!result.success) return result;
    return ok({
      source: 'agent_harness',
      requestedMode: mode,
      route: `agent_harness mode:"${harnessMode}"`,
      result: parseToolOutput(result.output),
    });
  };
}

export const AGENT_CONTEXT_TOOL_COMPATIBILITY_MODES = AGENT_CONTEXT_TOOL_MODES;

function readAgentContextMode(value: unknown): AgentContextMode {
  return typeof value === 'string' && AGENT_CONTEXT_TOOL_MODES.includes(value as AgentContextMode)
    ? value as AgentContextMode
    : 'summary';
}

function agentContextModeToHarnessMode(mode: AgentContextMode): string {
  if (mode === 'modes') return 'modes';
  if (mode === 'tools') return 'tools';
  if (mode === 'tool') return 'tool';
  if (mode === 'settings') return 'settings';
  if (mode === 'setting') return 'get_setting';
  if (mode === 'commands') return 'commands';
  if (mode === 'command') return 'command';
  if (mode === 'workspace') return 'workspace';
  if (mode === 'status') return 'connected_host_status';
  return 'summary';
}

function buildAgentCapabilitiesContract(registry?: ToolRegistry): Record<string, unknown> {
  const availableTools = new Set(safeToolNames(registry));
  const has = (name: string) => availableTools.has(name);
  const optionalTool = (name: string) => has(name) ? name : `${name} (not registered)`;

  return {
    runtime: 'GoodVibes Agent',
    answerStyle: 'Answer user capability questions from this contract. Do not dump inventory counts.',
    currentContract: {
      autonomy: 'Operator agent working on the owner\'s behalf. It can inspect, plan, edit, run tools, perform confirmed effects, create accounts on services it needs, and run work in the background. The constraint is visibility, not prohibition: work that continues past the current turn is registered where the owner can list and cancel it, and every account created is recorded in the account register with the service, the alias used, what it is for, and the secret-store key its credential lives under.',
      confirmations: 'External sends, reminders, media generation, settings writes, slash-command execution, workspace actions, packet preset saves, and operator actions require an explicit user request plus confirm:true where the tool requires it.',
      secrets: 'Do not reveal raw secrets. Use configured secret refs, provider accounts, and channel readiness routes.',
    },
    canDoNow: [
      {
        area: 'Project and computer work',
        can: 'Read, search, analyze, edit, and write workspace files; run bounded shell commands; inspect diffs and project structure; recover recent file edit/write snapshots.',
        tools: ['read', 'find', 'analyze', 'inspect', 'edit', 'write', 'exec', optionalTool('repo_map'), optionalTool('execution'), optionalTool('delegation')].filter(has),
        inspect: 'execution action:"status"; delegation action:"status"',
      },
      {
        area: 'Web research',
        can: has('web_search')
          ? 'Brief multi-step research from one read-only queue, plan routes, search the web with bounded evidence, inspect URLs, capture candidate sources in a local review queue, and summarize sourced findings in the main conversation.'
          : 'Web research is not available until the web_search tool is registered.',
        tools: [optionalTool('research'), optionalTool('agent_harness'), optionalTool('web_search'), optionalTool('fetch'), optionalTool('agent_research_runs'), optionalTool('agent_research_sources'), optionalTool('agent_research_report')],
        inspect: 'research action:"briefing" query:"<research request>", action:"plan" for route planning, action:"search" for public source candidates, or action:"runner" for browser-backed readiness',
      },
      {
        area: 'Harness operation',
        can: 'Discover and use harness modes, slash commands, workspace actions, settings, UI surfaces, keybindings, and model tools.',
        tools: [optionalTool('agent_harness'), optionalTool('host'), optionalTool('settings'), 'goodvibes_context'],
        inspect: 'agent_harness mode:"modes" query:"capability"',
      },
      {
        area: 'Memory and knowledge',
        can: 'Use VIBE.md personality files, Agent-local memory, notes, personas, skills, routines, prompt-context inspection, memory/vector posture, learning curator review/proposal queues, confirmed duplicate-consolidation phase helpers, work plans, and isolated Agent Knowledge ask/search/ingest routes.',
        tools: [optionalTool('vibe'), optionalTool('context'), optionalTool('memory'), optionalTool('agent_harness'), optionalTool('agent_local_registry'), optionalTool('agent_learning_consolidation'), optionalTool('agent_work_plan'), optionalTool('agent_knowledge'), optionalTool('agent_knowledge_ingest')],
        inspect: 'vibe action:"status"; context action:"prompt|files"; memory action:"status|curator"',
      },
      {
        area: 'Personal operations',
        can: 'Turn inbox, agenda, task, reminder, note, routine, or delivery requests into the safest visible lane, route, required fields, and confirmation boundary, then inspect the broader operations map without inventing missing connectors.',
        tools: [optionalTool('personal_ops'), optionalTool('autonomy'), optionalTool('agent_harness'), optionalTool('agent_local_registry'), optionalTool('agent_work_plan'), optionalTool('schedule'), optionalTool('agent_autonomy_schedule'), optionalTool('agent_reminder_schedule'), optionalTool('agent_schedule_edit'), optionalTool('agent_channel_send')],
        inspect: 'personal_ops action:"queue" for saved inbox/calendar review queues, action:"intake" query:"<personal request>", or action:"status"',
      },
      {
      area: 'Documents and artifacts',
      can: 'Create, revise, version, review, comment on, suggest changes to, attach or insert saved artifacts into, export Agent document drafts with reviewer appendices, inspect reviewer-readiness preflight, save reusable review packet presets, and share confirmed reviewer packet archive references; browse saved artifacts; track visible research run checkpoints; capture and review research source queues; save sourced research report artifacts; promote reviewed artifacts into isolated Agent Knowledge; handle uploads, source checks, generated media artifacts, and run confirmed blind model comparisons from prompts or saved text artifacts with durable review, side-by-side views, section-jump reviewer handoff diffs, judgment, task/document/benchmark-filtered analytics/synthesis, reviewer handoff, handoff archive with matching route-decision receipt evidence, route-update actions, and leave-unchanged route-decision receipts.',
      tools: [optionalTool('research'), optionalTool('agent_harness'), optionalTool('agent_documents'), optionalTool('agent_review_packet_presets'), optionalTool('agent_review_packet_share'), optionalTool('agent_artifacts'), optionalTool('agent_knowledge'), optionalTool('agent_knowledge_ingest'), optionalTool('agent_media_generate'), optionalTool('agent_model_compare'), optionalTool('agent_research_runs'), optionalTool('agent_research_sources'), optionalTool('agent_research_report')],
        inspect: 'agent_harness mode:"document_ops"',
      },
      {
        area: 'Configured services and messages',
        can: 'Inspect configured channel readiness, visible autonomy queue, and send one confirmed message/notification/reminder/media request or create/edit one confirmed autonomous schedule through configured targets.',
        tools: [optionalTool('autonomy'), optionalTool('device'), optionalTool('agent_channel_send'), optionalTool('agent_notify'), optionalTool('schedule'), optionalTool('agent_autonomy_schedule'), optionalTool('agent_reminder_schedule'), optionalTool('agent_schedule_edit'), optionalTool('agent_media_generate')],
        inspect: 'channels action:"status|triage|deliveries", autonomy action:"queue", or agent_harness mode:"notifications"',
      },
      {
        area: 'Device, voice, and browser surfaces',
        can: 'Inspect companion pairing, mobile/PWA, voice/TTS, notification, browser/desktop-control, and unpublished sensor posture without claiming unavailable device APIs; open the connected browser cockpit or TTS pickers only after confirmation.',
        tools: [optionalTool('computer'), optionalTool('device'), optionalTool('agent_harness'), optionalTool('setup')],
        inspect: 'computer action:"browser|control|setup|mcp"; device action:"status"; voice posture with device action:"voice"',
      },
      {
        area: 'Provider and setup work',
        can: 'Inspect provider accounts, subscriptions, model routing, hardware-scored local model cookbook setup plans, confirmed local server checks, confirmed benchmark action routes, setup posture, service posture, connected-host status, and GoodVibes settings import; apply supported settings changes when explicitly requested.',
        tools: [optionalTool('models'), optionalTool('setup'), optionalTool('host'), optionalTool('settings'), optionalTool('agent_harness'), optionalTool('import_goodvibes_settings')],
        inspect: 'setup action:"status"; use host action:"status|services|methods" for host diagnostics, models action:"status|local|providers" for model/provider catalogs, and settings action:"list|get" for detailed settings',
      },
    ],
    needsSetupOrIntegration: [
      'Email and calendar are built in: the google tool reads and sends Gmail and reads and writes Google Calendar. No MCP server or plugin is involved.',
      'Connecting an account is YOUR job, not a command to hand over. Walk the user to the Google console only for what has no API, creating the OAuth client, and when they paste the client id and secret, call google action:"connect.client" with both: that registers them and returns a consent link to hand straight back. If they name a path to a client JSON instead, call google action:"connect.clientFile" with it. Two pasted values or a path IS the continuation of the walkthrough; treat them as such rather than asking what to do with them.',
      'Signing up for a third-party service in service of work the owner asked for is authorized and does not need separate permission. Record it with accounts action:\"record\" at creation time, service, URL, alias, purpose, and the secret-store key name, so it can be listed and revoked. Never record the credential itself, only the name of the secret-store entry holding it.',
      'Long-running work belongs on an explicit schedule, routine, automation, research run, or connected-host route so it appears in the autonomy queue and can be cancelled. Starting such work is authorized; starting it where the owner cannot see it is not.',
      'New capabilities can come from installed plugins, MCP servers, configured services, or code changes; the Agent should inspect what is installed before claiming a capability exists.',
    ],
    commonRoutes: {
      findCapability: 'agent_harness mode:"modes" query:"<task>"',
      executionPosture: 'execution action:"status"; inspect one route with action:"route"; use terminal command:"..." background:true confirm:true explicitUserRequest:"..." for visible tracked long-running commands and process action:"list|poll|log|wait|kill|write" to manage them; inspect tracked processes with action:"processes|process", recent work with action:"history|record", and recovery posture with action:"recovery"; prefer local read/edit/exec for the current workspace, delegation action:"status" for isolation/parallel/remote',
      delegation: 'delegation action:"status"; inspect one route with action:"route" delegationRouteId:"..."; delegated submission uses workspace action:"run" actionId:"delegate-task" or workspace action:"run_command" command:"/delegate ..." only after explicit confirmation',
      fileRecovery: 'execution action:"recovery"; apply one snapshot with agent_harness mode:"run_file_recovery" recoveryAction:"undo|redo" confirm:true explicitUserRequest:"..."',
      personalOps: 'personal_ops action:"briefing"; use action:"queue" for saved inbox/calendar review queues and refresh routes; use action:"intake" query:"<personal request>" to choose the safest lane; inspect one lane with action:"lane" laneId:"..."; run one live inbox/calendar read with action:"read" confirm:true explicitUserRequest:"..."; use schedule action:"list|create|remind|edit|run|pause|resume|delete" for connected schedules/reminders after explicit confirmation',
      promptContext: 'context action:"prompt"; add includeParameters:true only when bounded prompt previews are needed; inspect context files with action:"files|file" and receipts with action:"receipts|receipt"',
      memoryPosture: 'memory action:"status"; inspect one embedding or external-memory provider with action:"provider"; write/rebuild/change routes stay confirmed',
      autonomyIntake: 'autonomy action:"intake" query:"<ongoing work request>"; use returned route and missing fields before creating background work',
      autonomyQueue: 'autonomy action:"queue"; inspect one card with action:"item"; use returned live records/log tails when present',
      setup: 'setup action:"status"; inspect one row with action:"item" setupItemId:"..."; use action:"checkpoint"; confirmed effects use action:"save_checkpoint|clear_checkpoint|token|smoke|finish|import_settings" confirm:true explicitUserRequest:"..."',
      vibe: 'vibe action:"status"; inspect one file with action:"show" scope:"project|global"; confirmed effects use action:"init|import_persona" confirm:true explicitUserRequest:"..."',
      settings: 'settings action:"list"; inspect one setting with action:"get" key:"..."; confirmed changes use action:"set|reset" confirm:true explicitUserRequest:"..."; import existing GoodVibes settings with action:"import" and confirm:true only after approval',
      host: 'host action:"status"; inspect capabilities/services/methods with action:"capabilities|capability|services|service|methods|method"; execute exact daemon operations separately with agent_operator_method after confirmation',
      settingsImport: 'settings action:"import"; previews by default and applies with confirm:true explicitUserRequest:"..." after user approval; import_goodvibes_settings remains available for compatibility',
      computer: 'computer action:"status|plan|control|browser|setup|mcp"; open the connected browser cockpit with action:"open_browser" confirm:true explicitUserRequest:"..."; use this route for browser/PWA, browser/screenshot/desktop-control planning, screen, and computer-use posture',
      device: 'device action:"status"; inspect one capability/route with action:"capability" capabilityId:"..."; inspect voice/media with action:"voice"; inspect one provider with action:"provider"; browser/PWA and desktop-control compatibility routes remain available but computer is the primary route',
      models: 'models action:"status"; inspect one model/local endpoint route with action:"route" modelRouteId:"..."; inspect local cookbook with action:"local"; inspect providers with action:"providers"; inspect one provider with action:"provider" providerId:"..."; run local model server checks with action:"smoke" confirm:true explicitUserRequest:"..."',
      learningCurator: 'memory action:"curator"; inspect one card with action:"candidate"; apply duplicate phases with agent_learning_consolidation mode:"preview|merge|stale|delete|rollback"',
      documentOps: 'agent_harness mode:"document_ops"; inspect one lane with mode:"document_ops_lane"',
      documents: 'agent_documents mode:"list"; show with documentId; confirmed create/update/review/comment/resolveComment/suggest/acceptSuggestion/rejectSuggestion/attachArtifact/insertArtifact/export with confirm:true',
      reviewPacketPresets: 'agent_review_packet_presets mode:"list"; show with artifactId to check missing/superseded ids and reuse routes; refresh stale presets with mode:"refresh" confirm:true explicitUserRequest:"..."; save reusable packet defaults with mode:"save" confirm:true explicitUserRequest:"..."',
      reviewPacketShare: 'agent_review_packet_share archiveArtifactId:"..." channel:"..." confirm:true explicitUserRequest:"..."; sends a plain-text archive reference only',
      artifacts: 'agent_artifacts mode:"list"; inspect with mode:"show"; export one with mode:"export"; package selected ids with mode:"package" or mode:"archive"; promote reviewed artifact ids with agent_knowledge_ingest sourceKind:"artifact"',
      researchWorkflow: 'research action:"briefing" query:"<research request>"; returns one read-only next-action queue across visible runs, sources, saved reports, browser readiness, and exact follow-up routes. Use action:"plan" for route planning, action:"search" for bounded public source candidates, and action:"runner" for browser-backed readiness only',
      researchRuns: 'research action:"runs"; create visible run state with action:"create_run" confirm:true explicitUserRequest:"..."; checkpoint/pause/resume/cancel/complete use confirmed research lifecycle actions; no hidden background work starts from the ledger',
      researchSources: 'research action:"sources"; capture with action:"add_source" confirm:true explicitUserRequest:"..."; review with action:"review_source" confirm:true explicitUserRequest:"..."; bundle with action:"bundle"; no Knowledge ingest occurs unless agent_knowledge_ingest is called separately',
      researchReports: 'research action:"reports" lists saved sourced report artifacts; action:"report_artifact" previews one; save with action:"report" reviewed sources, citation coverage repair metadata, optional requireCitationCoverage:true, confirm:true, and explicitUserRequest',
      localModelCookbook: 'models action:"local"; inspect hardware fit with action:"route" modelRouteId:"local-model-cookbook"; confirmed local server checks use action:"smoke" confirm:true explicitUserRequest:"..."',
      listTools: 'agent_harness mode:"tools" query:"<task>"',
      inspectTool: 'agent_harness mode:"tool" toolName:"<tool>"',
      listCommands: 'workspace action:"commands" query:"<task>"',
      runCommand: 'workspace action:"run_command" command:"/<command> ..." confirm:true explicitUserRequest:"..."',
      listWorkspaceActions: 'workspace action:"actions" query:"<task>"',
      runWorkspaceAction: 'workspace action:"run" actionId:"<id>" confirm:true explicitUserRequest:"..."',
      inspectSettings: 'settings action:"list" query:"<setting>"',
      setSetting: 'settings action:"set" key:"<key>" value:<value> confirm:true explicitUserRequest:"..."',
      webResearch: `multi-step: research action:"briefing" query:"<research request>"; route plan: research action:"plan" query:"<research request>"; public source candidates: research action:"search" query:"<research request>"; browser readiness: research action:"runner"; raw single-shot fallback: ${has('web_search') ? 'web_search query:"<research request>" verbosity:"evidence" maxResults:10 evidenceTopN:3' : 'web_search not registered'}`,
      channels: 'channels action:"status|channel|setup|triage|deliveries"; send with agent_channel_send only after explicit user request',
    },
    registeredModelTools: safeToolNames(registry),
  };
}

function safeToolNames(registry?: ToolRegistry): readonly string[] {
  try {
    return registry?.getToolDefinitions().map((tool) => tool.name).sort((a, b) => a.localeCompare(b)) ?? [];
  } catch {
    return [];
  }
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function parseToolOutput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function ok(value: unknown): { readonly success: true; readonly output: string } {
  return { success: true, output: JSON.stringify(value, null, 2) };
}
