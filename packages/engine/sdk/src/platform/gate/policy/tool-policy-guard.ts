/**
 * The Agent main-conversation tool policy guard: fixed per-tool mode and
 * argument allowlists, schema narrowing and denial messages for every tool the
 * main conversation can call.
 *
 * Hoisted from the agent (src/tools/agent-tool-policy-guard.ts) into the
 * engine gate. The mode and argument allowlists stay code because they are
 * the Agent product's declaration of which modes and options its
 * main-conversation tools offer (a published tool surface), not a reading of
 * any call's content; the safe fetch methods are the ones RFC 9110 defines as
 * safe, and the `bg_*` commands are the exec tool's own documented background
 * command grammar (tools/exec/schema.ts). The checks that did judge content
 * (which reads touch secrets, which settings writes are hazardous and whether
 * the request asks for them) are Jev readings in read-policy.ts and
 * settings-write-policy.ts, and the stakes of whatever the allowlists let
 * through are read by the gate (gate/reading.ts). The product-owned pieces
 * are passed in rather than imported: the `goodvibes_context` wrapper
 * (AgentToolPolicyGuardOptions) and the MCP call route's mode
 * (AgentToolPolicyExplanationOptions).
 *
 * The agent tool's modes are allowlisted by name.
 */
import type { Tool } from '../../types/tools.js';
import type { ToolRegistry } from '../../tools/registry.js';
import {
  wrapAnalyzeToolForAgentPolicy,
  wrapRegistryToolForAgentPolicy,
} from './analysis-registry-policy.js';
import { wrapFindToolForAgentPolicy } from './find-policy.js';
import { wrapReadToolForAgentPolicy } from './read-policy.js';
import {
  AGENT_SETTINGS_TOOL_DESCRIPTION,
  validateSettingsToolInvocationForAgentPolicy,
  wrapSettingsToolForAgentPolicy,
  type SettingsToolArgs,
} from './settings-write-policy.js';
import { wrapWebSearchToolForAgentPolicy } from './web-search-policy.js';
import type {
  AgentToolArgs,
  AgentToolPolicyExplanationOptions,
  AgentToolPolicyGuardOptions,
  AgentToolPolicyInvocationExplanation,
  ExecCommandArgs,
  ExecToolArgs,
  FetchToolArgs,
  InspectToolArgs,
  ModeRestrictedToolPolicy,
  ModeToolArgs,
  StateToolArgs,
} from './tool-policy-guard-types.js';
import {
  isStateMutation,
  READ_ONLY_STATE_ANALYTICS_ACTIONS,
  READ_ONLY_STATE_HOOK_ACTIONS,
  READ_ONLY_STATE_MEMORY_ACTIONS,
  READ_ONLY_STATE_MODE_ACTIONS,
  READ_ONLY_STATE_TOOL_MODES,
} from './state-policy.js';

const BLOCKED_MAIN_CONVERSATION_TOOL_NAMES = [] as const;
const AGENT_EXEC_BACKGROUND_COMMAND = /^\s*bg_(?:list|status|output|stop)\b/;

const READ_ONLY_AGENT_TOOL_MODES = [
  'spawn',
  'batch-spawn',
  'status',
  'cancel',
  'list',
  'templates',
  'get',
  'budget',
  'plan',
  'wait',
  'message',
  'contracts',
  'contract-history',
  'cohort-status',
  'cohort-report',
] as const;

const READ_ONLY_AGENT_TOOL_MODE_SET = new Set<string>(READ_ONLY_AGENT_TOOL_MODES);
const BLOCKED_MAIN_CONVERSATION_TOOL_NAME_SET = new Set<string>(BLOCKED_MAIN_CONVERSATION_TOOL_NAMES);

const READ_ONLY_REMOTE_TOOL_MODES = ['pools', 'contracts', 'artifacts', 'review'] as const;
const READ_ONLY_CHANNEL_TOOL_MODES = ['accounts', 'directory', 'resolve_target', 'capabilities', 'tools', 'agent_tools', 'actions'] as const;
const READ_ONLY_MCP_TOOL_MODES = ['servers', 'tools', 'schema', 'resources', 'security', 'auth'] as const;
const READ_ONLY_FETCH_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;
const READ_ONLY_TASK_TOOL_MODES = ['list', 'show', 'handoffs'] as const;
const READ_ONLY_TEAM_TOOL_MODES = ['list', 'show'] as const;
const READ_ONLY_WORKLIST_TOOL_MODES = ['list', 'show'] as const;
const READ_ONLY_PACKET_TOOL_MODES = ['list', 'show'] as const;
const READ_ONLY_QUERY_TOOL_MODES = ['list', 'show'] as const;
const READ_ONLY_CONTROL_TOOL_MODES = ['commands', 'panels', 'subscriptions'] as const;
const READ_ONLY_REMOTE_TOOL_MODE_SET = new Set<string>(READ_ONLY_REMOTE_TOOL_MODES);
const READ_ONLY_CHANNEL_TOOL_MODE_SET = new Set<string>(READ_ONLY_CHANNEL_TOOL_MODES);
const READ_ONLY_MCP_TOOL_MODE_SET = new Set<string>(READ_ONLY_MCP_TOOL_MODES);
const READ_ONLY_FETCH_METHOD_SET = new Set<string>(READ_ONLY_FETCH_METHODS);
const READ_ONLY_TASK_TOOL_MODE_SET = new Set<string>(READ_ONLY_TASK_TOOL_MODES);
const READ_ONLY_TEAM_TOOL_MODE_SET = new Set<string>(READ_ONLY_TEAM_TOOL_MODES);
const READ_ONLY_WORKLIST_TOOL_MODE_SET = new Set<string>(READ_ONLY_WORKLIST_TOOL_MODES);
const READ_ONLY_PACKET_TOOL_MODE_SET = new Set<string>(READ_ONLY_PACKET_TOOL_MODES);
const READ_ONLY_QUERY_TOOL_MODE_SET = new Set<string>(READ_ONLY_QUERY_TOOL_MODES);
const READ_ONLY_CONTROL_TOOL_MODE_SET = new Set<string>(READ_ONLY_CONTROL_TOOL_MODES);

const LOCAL_AGENT_DENIAL = [
  'GoodVibes Agent creates only visible, tracked Agent jobs.',
  'Use a known agent mode and keep spawned work tied to the user request, visible status, and cancellable follow-up.',
].join(' ');

const LOCAL_CODING_TOOL_DENIAL = [
  'This tool is not exposed directly in GoodVibes Agent.',
  'Use a first-class visible Agent tool or a confirmed GoodVibes daemon operator method for the requested workflow.',
].join(' ');

const BACKGROUND_EXEC_DENIAL = [
  'GoodVibes Agent only runs foreground, serial command-line work from the main conversation.',
  'Raw exec background flags, parallel command batches, bg_* controls, and exec pre-command file operations are disabled here.',
  'For user-approved long-running local commands, use execution action:"processes", terminal background:true, and process lifecycle actions. Delegate only when isolation, remote execution, or parallel work is the user benefit.',
].join(' ');

const REMOTE_MUTATION_DENIAL = [
  'GoodVibes Agent only inspects remote build-host pools, contracts, artifacts, and review summaries from the main conversation.',
  'Remote pool creation, assignment, unassignment, and artifact import are disabled here.',
  'Use explicit GoodVibes TUI delegation for build/fix/review execution changes.',
].join(' ');

const CHANNEL_ACTION_DENIAL = [
  'GoodVibes Agent only inspects channel accounts, directories, capabilities, tools, and actions from the main conversation.',
  'Channel account actions, tool runs, operator action runs, authorization, and target auto-creation are disabled here.',
  'External channel side effects require an explicit Agent approval flow before they can run.',
].join(' ');

const MCP_SECURITY_MUTATION_DENIAL = [
  'GoodVibes Agent only inspects MCP servers, tools, schemas, resources, security, and auth state from the main conversation.',
  'MCP quarantine approval, trust changes, and role changes are disabled here.',
  'MCP security mutations require an explicit Agent approval flow before they can run.',
].join(' ');

const FETCH_NETWORK_MUTATION_DENIAL = [
  'GoodVibes Agent only performs serial, unauthenticated, read-only HTTP fetches from the main conversation.',
  'Non-read methods, request bodies, custom auth/header/service credentials, trust overrides, raw unsanitized responses, and parallel fetch batches are disabled here.',
  'Network writes or credentialed external calls require an explicit Agent approval flow before they can run.',
].join(' ');

const STATE_MUTATION_DENIAL = [
  'GoodVibes Agent only inspects runtime-owned state from the main conversation.',
  'Arbitrary state set/clear, runtime-owned memory writes, hook mutation, output-mode mutation, and analytics writes are disabled here.',
  'Use Agent-owned memory, skills, personas, routines, and explicit CLI/slash commands for intentional local state changes.',
].join(' ');

// The blanket settings denial that used to live here is gone. Its history, what
// it was protecting, and the short confirmation-gated list that replaced it are
// documented in agent-settings-write-policy.ts.

const INSPECT_WRITE_DENIAL = [
  'GoodVibes Agent only uses inspect scaffold mode for dry-run planning from the main conversation.',
  'File scaffolding and code creation are disabled in the Agent model tool surface.',
  'Delegate explicit build/implement/fix/review work to GoodVibes TUI instead.',
].join(' ');

const DURABLE_WORKFLOW_MUTATION_DENIAL = [
  'GoodVibes Agent only inspects runtime-owned durable workflow tools from the main conversation.',
  'Task, team, worklist, packet, and query creation or lifecycle mutation is disabled here.',
  'Use explicit Agent CLI/slash commands or GoodVibes TUI delegation for intentional workflow changes.',
].join(' ');

const CONTROL_MUTATION_DENIAL = [
  'GoodVibes Agent only inspects runtime-owned product-control surfaces from the main conversation.',
  'Product-control mutation, connected-host lifecycle, and connected-host posture changes are disabled here.',
  'Use explicit Agent CLI/slash commands for Agent-owned changes, and keep connected-host lifecycle external.',
].join(' ');

export function installAgentToolPolicyGuard(registry: ToolRegistry, options: AgentToolPolicyGuardOptions = {}): void {
  const agentTool = registry.list().find((tool) => tool.definition.name === 'agent');
  if (!agentTool) throw new Error('Agent tool policy guard could not find the agent tool.');
  wrapAgentToolForAgentPolicy(agentTool, options);
  for (const tool of registry.list()) {
    if (tool.definition.name === 'exec') {
      wrapExecToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'read') {
      wrapReadToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'remote') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_REMOTE_TOOL_MODES,
        modeSet: READ_ONLY_REMOTE_TOOL_MODE_SET,
        description: 'Read-only remote build-host inspection. Mutations are disabled in Agent.',
        denial: REMOTE_MUTATION_DENIAL,
      });
    } else if (tool.definition.name === 'channel') {
      wrapChannelToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'mcp') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_MCP_TOOL_MODES,
        modeSet: READ_ONLY_MCP_TOOL_MODE_SET,
        description: 'Read-only MCP inspection. Mutations are disabled in Agent.',
        denial: MCP_SECURITY_MUTATION_DENIAL,
      });
    } else if (tool.definition.name === 'fetch') {
      wrapFetchToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'state') {
      wrapStateToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'goodvibes_context') {
      options.wrapContextTool?.(tool, registry);
    } else if (tool.definition.name === 'goodvibes_settings') {
      wrapSettingsToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'inspect') {
      wrapInspectToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'analyze') {
      wrapAnalyzeToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'registry') {
      wrapRegistryToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'find') {
      wrapFindToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'web_search') {
      wrapWebSearchToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'control') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_CONTROL_TOOL_MODES,
        modeSet: READ_ONLY_CONTROL_TOOL_MODE_SET,
        description: 'Read-only product-control inspection. Mutations are external.',
        denial: CONTROL_MUTATION_DENIAL,
      });
    } else if (tool.definition.name === 'task') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_TASK_TOOL_MODES,
        modeSet: READ_ONLY_TASK_TOOL_MODE_SET,
        description: 'Read-only task/workflow inspection. Mutations are disabled in Agent.',
        denial: DURABLE_WORKFLOW_MUTATION_DENIAL,
        removedProperties: ['title', 'label', 'status', 'dependsOnSessionId', 'dependsOnTaskId', 'reason', 'toSessionId'],
      });
    } else if (tool.definition.name === 'team') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_TEAM_TOOL_MODES,
        modeSet: READ_ONLY_TEAM_TOOL_MODE_SET,
        description: 'Read-only team inspection. Mutations are disabled in Agent.',
        denial: DURABLE_WORKFLOW_MUTATION_DENIAL,
        removedProperties: ['name', 'summary', 'memberId', 'role', 'lanes'],
      });
    } else if (tool.definition.name === 'worklist') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_WORKLIST_TOOL_MODES,
        modeSet: READ_ONLY_WORKLIST_TOOL_MODE_SET,
        description: 'Read-only worklist inspection. Mutations are disabled in Agent.',
        denial: DURABLE_WORKFLOW_MUTATION_DENIAL,
        removedProperties: ['title', 'itemId', 'text', 'owner', 'priority'],
      });
    } else if (tool.definition.name === 'packet') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_PACKET_TOOL_MODES,
        modeSet: READ_ONLY_PACKET_TOOL_MODE_SET,
        description: 'Read-only operator packet inspection. Mutations are disabled in Agent.',
        denial: DURABLE_WORKFLOW_MUTATION_DENIAL,
        removedProperties: ['title', 'summary', 'goals', 'constraints', 'risks', 'audience'],
      });
    } else if (tool.definition.name === 'query') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_QUERY_TOOL_MODES,
        modeSet: READ_ONLY_QUERY_TOOL_MODE_SET,
        description: 'Read-only operator query inspection. Mutations are disabled in Agent.',
        denial: DURABLE_WORKFLOW_MUTATION_DENIAL,
        removedProperties: ['prompt', 'askedBy', 'target', 'answer', 'resolution'],
      });
    } else if (BLOCKED_MAIN_CONVERSATION_TOOL_NAME_SET.has(tool.definition.name)) {
      wrapBlockedMainConversationToolForAgentPolicy(tool);
    }
  }
}

export function wrapAgentToolForAgentPolicy(tool: Tool, _options: AgentToolPolicyGuardOptions = {}): void {
  narrowAgentToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const denial = validateAgentToolInvocationForAgentPolicy(args as AgentToolArgs);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(normalizeAgentToolInvocationForAgentPolicy(args as AgentToolArgs) as Parameters<Tool['execute']>[0], options);
  };
}

export function validateAgentToolInvocationForAgentPolicy(args: AgentToolArgs): string | null {
  if (typeof args.mode === 'string' && !READ_ONLY_AGENT_TOOL_MODE_SET.has(args.mode)) return LOCAL_AGENT_DENIAL;
  return null;
}

export function normalizeAgentToolInvocationForAgentPolicy(args: AgentToolArgs): AgentToolArgs {
  return args;
}

export function wrapBlockedMainConversationToolForAgentPolicy(tool: Tool): void {
  tool.definition.description = `Blocked in GoodVibes Agent: ${tool.definition.name}.`;
  tool.definition.sideEffects = [];
  tool.execute = async (_args, options) => {
    options?.signal?.throwIfAborted();
    return { success: false, error: LOCAL_CODING_TOOL_DENIAL };
  };
}

export function wrapExecToolForAgentPolicy(tool: Tool): void {
  narrowExecToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const denial = validateExecToolInvocationForAgentPolicy(args as ExecToolArgs);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(args, options);
  };
}

export function wrapFetchToolForAgentPolicy(tool: Tool): void {
  narrowFetchToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const denial = validateFetchToolInvocationForAgentPolicy(args as FetchToolArgs);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(normalizeFetchToolInvocationForAgentPolicy(args as FetchToolArgs) as Parameters<Tool['execute']>[0], options);
  };
}

export function wrapStateToolForAgentPolicy(tool: Tool): void {
  narrowStateToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const denial = validateStateToolInvocationForAgentPolicy(args as StateToolArgs);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(args, options);
  };
}

export function wrapInspectToolForAgentPolicy(tool: Tool): void {
  narrowInspectToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const inspectArgs = args as InspectToolArgs;
    const denial = validateInspectToolInvocationForAgentPolicy(inspectArgs);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(normalizeInspectToolInvocationForAgentPolicy(inspectArgs) as Parameters<Tool['execute']>[0], options);
  };
}

export function validateExecToolInvocationForAgentPolicy(args: ExecToolArgs): string | null {
  if (args.parallel === true) return BACKGROUND_EXEC_DENIAL;
  if (Array.isArray(args.file_ops) && args.file_ops.length > 0) return BACKGROUND_EXEC_DENIAL;
  if (args.file_ops !== undefined && !Array.isArray(args.file_ops)) return BACKGROUND_EXEC_DENIAL;
  if (!Array.isArray(args.commands)) return null;

  for (const command of args.commands) {
    if (!isRecord(command)) continue;
    const commandArgs = command as ExecCommandArgs;
    if (commandArgs.background === true) return BACKGROUND_EXEC_DENIAL;
    if (typeof commandArgs.cmd === 'string' && AGENT_EXEC_BACKGROUND_COMMAND.test(commandArgs.cmd)) {
      return BACKGROUND_EXEC_DENIAL;
    }
    if (isRecord(commandArgs.until)) {
      const killAfter = commandArgs.until.kill_after;
      if (killAfter !== true) return BACKGROUND_EXEC_DENIAL;
    }
  }

  return null;
}

export function validateFetchToolInvocationForAgentPolicy(args: FetchToolArgs): string | null {
  if (args.parallel === true) return FETCH_NETWORK_MUTATION_DENIAL;
  if (args.sanitize_mode === 'none') return FETCH_NETWORK_MUTATION_DENIAL;
  if (isPresent(args.trusted_hosts)) return FETCH_NETWORK_MUTATION_DENIAL;
  if (!Array.isArray(args.urls)) return null;

  for (const urlArgs of args.urls) {
    if (!isRecord(urlArgs)) continue;
    const method = typeof urlArgs.method === 'string' ? urlArgs.method.toUpperCase() : 'GET';
    if (!READ_ONLY_FETCH_METHOD_SET.has(method)) return FETCH_NETWORK_MUTATION_DENIAL;
    if (isPresent(urlArgs.body) || isPresent(urlArgs.body_base64) || isPresent(urlArgs.body_type) || isPresent(urlArgs.body_data)) {
      return FETCH_NETWORK_MUTATION_DENIAL;
    }
    if (isPresent(urlArgs.headers) || isPresent(urlArgs.auth) || isPresent(urlArgs.service) || isPresent(urlArgs.retry_on_auth)) {
      return FETCH_NETWORK_MUTATION_DENIAL;
    }
  }

  return null;
}

export function normalizeFetchToolInvocationForAgentPolicy(args: FetchToolArgs): FetchToolArgs {
  return { ...args, parallel: false };
}

export function validateStateToolInvocationForAgentPolicy(args: StateToolArgs): string | null {
  return isStateMutation(args) ? STATE_MUTATION_DENIAL : null;
}

export function validateInspectToolInvocationForAgentPolicy(args: InspectToolArgs): string | null {
  if (args.mode === 'scaffold' && args.dryRun === false) return INSPECT_WRITE_DENIAL;
  return null;
}

export function normalizeInspectToolInvocationForAgentPolicy(args: InspectToolArgs): InspectToolArgs {
  if (args.mode !== 'scaffold') return args;
  return { ...args, dryRun: true };
}

export function wrapModeRestrictedToolForAgentPolicy(tool: Tool, policy: ModeRestrictedToolPolicy): void {
  narrowModeToolDefinitionForAgentPolicy(tool, policy.allowedModes, policy.description);
  if (policy.removedProperties) removeToolDefinitionProperties(tool, policy.removedProperties);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const denial = validateModeRestrictedToolInvocationForAgentPolicy(args as ModeToolArgs, policy.modeSet, policy.denial);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(args, options);
  };
}

export function wrapChannelToolForAgentPolicy(tool: Tool): void {
  narrowModeToolDefinitionForAgentPolicy(tool, READ_ONLY_CHANNEL_TOOL_MODES, [
    'Read-only channel inspection for GoodVibes Agent.',
    'Running channel tools/actions, account lifecycle actions, authorization, and target creation are disabled in the main conversation.',
  ].join(' '));
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const denial = validateModeRestrictedToolInvocationForAgentPolicy(args as ModeToolArgs, READ_ONLY_CHANNEL_TOOL_MODE_SET, CHANNEL_ACTION_DENIAL)
      ?? validateChannelToolInvocationForAgentPolicy(args as ModeToolArgs);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(args, options);
  };
}

export function validateModeRestrictedToolInvocationForAgentPolicy(
  args: ModeToolArgs,
  modeSet: ReadonlySet<string>,
  denial: string,
): string | null {
  if (typeof args.mode === 'string' && !modeSet.has(args.mode)) return denial;
  return null;
}

export function validateChannelToolInvocationForAgentPolicy(args: ModeToolArgs): string | null {
  if (args.mode === 'resolve_target' && args.createIfMissing === true) return CHANNEL_ACTION_DENIAL;
  return null;
}

function allowedByAgentPolicy(reason: string, allowedModes?: readonly string[]): AgentToolPolicyInvocationExplanation {
  return {
    status: 'allowed',
    layer: 'agent_tool_policy',
    reason,
    ...(allowedModes ? { allowedModes } : {}),
  };
}

function deniedByAgentPolicy(reason: string, allowedModes?: readonly string[]): AgentToolPolicyInvocationExplanation {
  return {
    status: 'denied',
    layer: 'agent_tool_policy',
    reason,
    ...(allowedModes ? { allowedModes } : {}),
  };
}

function explainModeRestrictedAgentPolicy(
  args: ModeToolArgs,
  allowedModes: readonly string[],
  modeSet: ReadonlySet<string>,
  denial: string,
): AgentToolPolicyInvocationExplanation {
  const denied = validateModeRestrictedToolInvocationForAgentPolicy(args, modeSet, denial);
  if (denied) return deniedByAgentPolicy(denied, allowedModes);
  const mode = typeof args.mode === 'string' && args.mode.trim() ? args.mode.trim() : '(default)';
  return allowedByAgentPolicy(`Agent policy allows ${mode} for read-only inspection on this tool.`, allowedModes);
}

export async function explainAgentToolPolicyInvocation(
  toolName: string,
  args: Record<string, unknown> = {},
  options: AgentToolPolicyExplanationOptions = {},
): Promise<AgentToolPolicyInvocationExplanation> {
  if (BLOCKED_MAIN_CONVERSATION_TOOL_NAME_SET.has(toolName)) return deniedByAgentPolicy(LOCAL_CODING_TOOL_DENIAL);
  if (toolName === 'agent') {
    const denied = validateAgentToolInvocationForAgentPolicy(args as AgentToolArgs);
    return denied ? deniedByAgentPolicy(denied, READ_ONLY_AGENT_TOOL_MODES) : allowedByAgentPolicy('Agent policy allows visible tracked Agent modes.', READ_ONLY_AGENT_TOOL_MODES);
  }
  if (toolName === 'exec') {
    const denied = validateExecToolInvocationForAgentPolicy(args as ExecToolArgs);
    return denied ? deniedByAgentPolicy(denied) : allowedByAgentPolicy('Agent policy allows foreground serial shell execution.');
  }
  if (toolName === 'remote') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_REMOTE_TOOL_MODES, READ_ONLY_REMOTE_TOOL_MODE_SET, REMOTE_MUTATION_DENIAL);
  if (toolName === 'channel') {
    const modeDenied = validateModeRestrictedToolInvocationForAgentPolicy(args as ModeToolArgs, READ_ONLY_CHANNEL_TOOL_MODE_SET, CHANNEL_ACTION_DENIAL);
    const channelDenied = modeDenied ?? validateChannelToolInvocationForAgentPolicy(args as ModeToolArgs);
    return channelDenied
      ? deniedByAgentPolicy(channelDenied, READ_ONLY_CHANNEL_TOOL_MODES)
      : allowedByAgentPolicy('Agent policy allows read-only channel inspection.', READ_ONLY_CHANNEL_TOOL_MODES);
  }
  if (toolName === 'mcp') {
    // The call route is layered on after this guard, so the modes this tool
    // really accepts depend on whether it was installed. Reporting the
    // inspection-only list once calling is wired would be the same kind of
    // stale claim that made browser control look available when it was not.
    const mcpModes = options.mcpCallMode
      ? [...READ_ONLY_MCP_TOOL_MODES, options.mcpCallMode]
      : READ_ONLY_MCP_TOOL_MODES;
    return explainModeRestrictedAgentPolicy(args as ModeToolArgs, mcpModes, new Set(mcpModes), MCP_SECURITY_MUTATION_DENIAL);
  }
  if (toolName === 'fetch') {
    const denied = validateFetchToolInvocationForAgentPolicy(args as FetchToolArgs);
    return denied ? deniedByAgentPolicy(denied, READ_ONLY_FETCH_METHODS) : allowedByAgentPolicy('Agent policy allows serial sanitized read-only HTTP fetches.', READ_ONLY_FETCH_METHODS);
  }
  if (toolName === 'state') {
    const denied = validateStateToolInvocationForAgentPolicy(args as StateToolArgs);
    return denied ? deniedByAgentPolicy(denied, READ_ONLY_STATE_TOOL_MODES) : allowedByAgentPolicy('Agent policy allows read-only runtime state inspection.', READ_ONLY_STATE_TOOL_MODES);
  }
  if (toolName === 'goodvibes_settings') {
    const denied = await validateSettingsToolInvocationForAgentPolicy(args as SettingsToolArgs);
    return denied
      ? deniedByAgentPolicy(denied)
      : allowedByAgentPolicy('Agent policy allows reading and applying settings; a change Jev reads as a hazard needs the user to ask for it, and the refusal names why.');
  }
  if (toolName === 'inspect') {
    const denied = validateInspectToolInvocationForAgentPolicy(args as InspectToolArgs);
    return denied ? deniedByAgentPolicy(denied) : allowedByAgentPolicy('Agent policy allows inspection and dry-run scaffolding only.');
  }
  if (toolName === 'control') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_CONTROL_TOOL_MODES, READ_ONLY_CONTROL_TOOL_MODE_SET, CONTROL_MUTATION_DENIAL);
  if (toolName === 'task') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_TASK_TOOL_MODES, READ_ONLY_TASK_TOOL_MODE_SET, DURABLE_WORKFLOW_MUTATION_DENIAL);
  if (toolName === 'team') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_TEAM_TOOL_MODES, READ_ONLY_TEAM_TOOL_MODE_SET, DURABLE_WORKFLOW_MUTATION_DENIAL);
  if (toolName === 'worklist') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_WORKLIST_TOOL_MODES, READ_ONLY_WORKLIST_TOOL_MODE_SET, DURABLE_WORKFLOW_MUTATION_DENIAL);
  if (toolName === 'packet') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_PACKET_TOOL_MODES, READ_ONLY_PACKET_TOOL_MODE_SET, DURABLE_WORKFLOW_MUTATION_DENIAL);
  if (toolName === 'query') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_QUERY_TOOL_MODES, READ_ONLY_QUERY_TOOL_MODE_SET, DURABLE_WORKFLOW_MUTATION_DENIAL);
  return allowedByAgentPolicy('No Agent-specific route guard blocks this invocation.');
}

export const AGENT_LOCAL_SPAWN_DENIAL_MESSAGE = LOCAL_AGENT_DENIAL;
export const AGENT_READ_ONLY_TOOL_MODES = READ_ONLY_AGENT_TOOL_MODES;
export const AGENT_BLOCKED_MAIN_CONVERSATION_TOOL_NAMES = BLOCKED_MAIN_CONVERSATION_TOOL_NAMES;
export const AGENT_MAIN_CONVERSATION_TOOL_DENIAL_MESSAGE = LOCAL_CODING_TOOL_DENIAL;
export const AGENT_EXEC_BACKGROUND_DENIAL_MESSAGE = BACKGROUND_EXEC_DENIAL;
export const AGENT_READ_ONLY_REMOTE_TOOL_MODES = READ_ONLY_REMOTE_TOOL_MODES;
export const AGENT_READ_ONLY_CHANNEL_TOOL_MODES = READ_ONLY_CHANNEL_TOOL_MODES;
export const AGENT_READ_ONLY_MCP_TOOL_MODES = READ_ONLY_MCP_TOOL_MODES;
export const AGENT_READ_ONLY_FETCH_METHODS = READ_ONLY_FETCH_METHODS;
export const AGENT_READ_ONLY_STATE_TOOL_MODES = READ_ONLY_STATE_TOOL_MODES;
export const AGENT_READ_ONLY_STATE_MEMORY_ACTIONS = READ_ONLY_STATE_MEMORY_ACTIONS;
export const AGENT_READ_ONLY_STATE_HOOK_ACTIONS = READ_ONLY_STATE_HOOK_ACTIONS;
export const AGENT_READ_ONLY_STATE_MODE_ACTIONS = READ_ONLY_STATE_MODE_ACTIONS;
export const AGENT_READ_ONLY_STATE_ANALYTICS_ACTIONS = READ_ONLY_STATE_ANALYTICS_ACTIONS;
export const AGENT_READ_ONLY_TASK_TOOL_MODES = READ_ONLY_TASK_TOOL_MODES;
export const AGENT_READ_ONLY_TEAM_TOOL_MODES = READ_ONLY_TEAM_TOOL_MODES;
export const AGENT_READ_ONLY_WORKLIST_TOOL_MODES = READ_ONLY_WORKLIST_TOOL_MODES;
export const AGENT_READ_ONLY_PACKET_TOOL_MODES = READ_ONLY_PACKET_TOOL_MODES;
export const AGENT_READ_ONLY_QUERY_TOOL_MODES = READ_ONLY_QUERY_TOOL_MODES;
export const AGENT_READ_ONLY_CONTROL_TOOL_MODES = READ_ONLY_CONTROL_TOOL_MODES;
export const AGENT_REMOTE_MUTATION_DENIAL_MESSAGE = REMOTE_MUTATION_DENIAL;
export const AGENT_CHANNEL_ACTION_DENIAL_MESSAGE = CHANNEL_ACTION_DENIAL;
export const AGENT_MCP_SECURITY_MUTATION_DENIAL_MESSAGE = MCP_SECURITY_MUTATION_DENIAL;
export const AGENT_FETCH_NETWORK_MUTATION_DENIAL_MESSAGE = FETCH_NETWORK_MUTATION_DENIAL;
export const AGENT_STATE_MUTATION_DENIAL_MESSAGE = STATE_MUTATION_DENIAL;
export const AGENT_SETTINGS_TOOL_DESCRIPTION_TEXT = AGENT_SETTINGS_TOOL_DESCRIPTION;
export const AGENT_INSPECT_WRITE_DENIAL_MESSAGE = INSPECT_WRITE_DENIAL;
export const AGENT_DURABLE_WORKFLOW_MUTATION_DENIAL_MESSAGE = DURABLE_WORKFLOW_MUTATION_DENIAL;
export const AGENT_CONTROL_MUTATION_DENIAL_MESSAGE = CONTROL_MUTATION_DENIAL;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function narrowAgentToolDefinitionForAgentPolicy(tool: Tool): void {
  tool.definition.description = 'Visible local Agent orchestration for GoodVibes Agent: spawn, inspect, message, wait, cancel, and report tracked autonomous work.';

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;
  const modeProperty = properties.mode;
  if (!isRecord(modeProperty)) return;
  modeProperty.enum = [...READ_ONLY_AGENT_TOOL_MODES];
  modeProperty.description = 'Agent orchestration mode. Spawned work is visible, tracked, and cancellable.';
}

function narrowExecToolDefinitionForAgentPolicy(tool: Tool): void {
  tool.definition.description = 'Execute foreground shell commands serially for GoodVibes Agent.';

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;
  delete properties.parallel;
  delete properties.file_ops;

  const commandsProperty = properties.commands;
  if (!isRecord(commandsProperty)) return;
  const itemSchema = commandsProperty.items;
  if (!isRecord(itemSchema)) return;
  const commandProperties = itemSchema.properties;
  if (!isRecord(commandProperties)) return;

  delete commandProperties.background;
  const untilProperty = commandProperties.until;
  if (isRecord(untilProperty)) {
    untilProperty.description = [
      'Pattern-based early termination.',
      'GoodVibes Agent requires kill_after:true so until-mode does not promote the process to background.',
    ].join(' ');
  }
}

function narrowFetchToolDefinitionForAgentPolicy(tool: Tool): void {
  tool.definition.description = 'Fetch public URLs with serial, read-only HTTP requests.';

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;
  delete properties.parallel;
  delete properties.trusted_hosts;

  const sanitizeModeProperty = properties.sanitize_mode;
  if (isRecord(sanitizeModeProperty)) {
    sanitizeModeProperty.enum = ['safe-text', 'strict'];
    sanitizeModeProperty.description = 'Response sanitization mode. Raw unsanitized responses are disabled in GoodVibes Agent.';
  }

  const urlsProperty = properties.urls;
  if (!isRecord(urlsProperty)) return;
  const itemSchema = urlsProperty.items;
  if (!isRecord(itemSchema)) return;
  const urlProperties = itemSchema.properties;
  if (!isRecord(urlProperties)) return;

  const methodProperty = urlProperties.method;
  if (isRecord(methodProperty)) {
    methodProperty.enum = [...READ_ONLY_FETCH_METHODS];
    methodProperty.description = 'Read-only HTTP method. GoodVibes Agent disables POST, PUT, PATCH, and DELETE in the main conversation.';
  }

  delete urlProperties.headers;
  delete urlProperties.body;
  delete urlProperties.body_base64;
  delete urlProperties.body_type;
  delete urlProperties.body_data;
  delete urlProperties.retry_on_auth;
  delete urlProperties.service;
  delete urlProperties.auth;
}

function narrowStateToolDefinitionForAgentPolicy(tool: Tool): void {
  tool.definition.description = 'Inspect runtime-owned state for GoodVibes Agent.';

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;
  const modeProperty = properties.mode;
  if (isRecord(modeProperty)) {
    modeProperty.enum = [...READ_ONLY_STATE_TOOL_MODES];
    modeProperty.description = 'Read-only runtime-owned state mode. set and clear are disabled in GoodVibes Agent.';
  }

  delete properties.values;
  delete properties.clearKeys;
  delete properties.memoryValue;
  delete properties.hookDefinition;
  delete properties.hookName;
  delete properties.modeName;
  delete properties.analyticsTool;
  delete properties.analyticsArgs;
  delete properties.analyticsResult;
  delete properties.analyticsDuration;
  delete properties.analyticsTokens;
  delete properties.analyticsFormat;

  narrowStringEnumProperty(properties, 'memoryAction', READ_ONLY_STATE_MEMORY_ACTIONS, 'Read-only runtime-owned memory actions allowed by GoodVibes Agent.');
  narrowStringEnumProperty(properties, 'hookAction', READ_ONLY_STATE_HOOK_ACTIONS, 'Read-only hook action allowed by GoodVibes Agent.');
  narrowStringEnumProperty(properties, 'modeAction', READ_ONLY_STATE_MODE_ACTIONS, 'Read-only mode actions allowed by GoodVibes Agent.');
  narrowStringEnumProperty(properties, 'analyticsAction', READ_ONLY_STATE_ANALYTICS_ACTIONS, 'Read-only analytics actions allowed by GoodVibes Agent.');
}

function narrowInspectToolDefinitionForAgentPolicy(tool: Tool): void {
  tool.definition.description = 'Inspect and analyze project structure for GoodVibes Agent.';

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;
  delete properties.dryRun;
}

function narrowModeToolDefinitionForAgentPolicy(tool: Tool, allowedModes: readonly string[], description: string): void {
  tool.definition.description = description;
  tool.definition.sideEffects = [];

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;
  const modeProperty = properties.mode;
  if (isRecord(modeProperty)) {
    modeProperty.enum = [...allowedModes];
    modeProperty.description = 'Read-only modes allowed by GoodVibes Agent main-conversation policy.';
  }

  if (tool.definition.name === 'channel') {
    delete properties.accountAction;
    delete properties.toolId;
    delete properties.actionId;
    delete properties.actorId;
    delete properties.createIfMissing;
  }
}

function removeToolDefinitionProperties(tool: Tool, keys: readonly string[]): void {
  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;
  for (const key of keys) delete properties[key];
}

function narrowStringEnumProperty(
  properties: Record<string, unknown>,
  key: string,
  values: readonly string[],
  description: string,
): void {
  const property = properties[key];
  if (!isRecord(property)) return;
  property.enum = [...values];
  property.description = description;
}
