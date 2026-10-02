import type { PermissionCategory, PermissionDecisionReasonCode, PermissionDecisionSource } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { analyzePermissionRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { ToolDefinition } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { fallbackPermissionCategoryForArgs } from '../runtime/tool-permission-safety.ts';
import { HARNESS_MODE_DESCRIPTORS } from './agent-harness-mode-catalog.ts';
import { explainAgentToolPolicyInvocation } from './agent-tool-policy-guard.ts';
import { computeApprovalPosture, type ApprovalPosture } from '../permissions/approval-posture.ts';

type PolicyExplanationStatus = 'allowed' | 'confirmation_required' | 'denied';
type PermissionPredictionOutcome = 'allowed' | 'prompt' | 'denied';
type PermissionToolKey =
  | 'read'
  | 'write'
  | 'edit'
  | 'exec'
  | 'find'
  | 'fetch'
  | 'analyze'
  | 'inspect'
  | 'agent'
  | 'state'
  | 'workflow'
  | 'registry'
  | 'delegate'
  | 'mcp';

export interface AgentPolicyExplainArgs {
  readonly toolName?: unknown;
  readonly tool?: unknown;
  readonly toolArgs?: unknown;
  readonly args?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

export type AgentPolicyExplanationResolution =
  | { readonly status: 'found'; readonly explanation: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

interface PermissionPrediction {
  readonly outcome: PermissionPredictionOutcome;
  readonly sourceLayer: PermissionDecisionSource | 'user_prompt_pending';
  readonly reasonCode: PermissionDecisionReasonCode | 'prompt_required';
  readonly mode: string;
  readonly reason: string;
  readonly configuredAction?: string;
}

const TOOL_CONFIG_KEYS: Readonly<Record<string, PermissionToolKey>> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  exec: 'exec',
  find: 'find',
  fetch: 'fetch',
  analyze: 'analyze',
  inspect: 'inspect',
  agent: 'agent',
  state: 'state',
  workflow: 'workflow',
  registry: 'registry',
  goodvibes_context: 'state',
  goodvibes_settings: 'write',
  delegate: 'delegate',
  mcp: 'mcp',
};

const SECRET_KEY_RE = /(?:api[_-]?key|token|secret|password|authorization|auth|bearer|webhook)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && ['true', 'yes', 'apply', 'run'].includes(value.trim().toLowerCase()));
}

function readToolArgs(args: AgentPolicyExplainArgs): Record<string, unknown> {
  if (isRecord(args.toolArgs)) return args.toolArgs;
  if (isRecord(args.args)) return args.args;
  return {};
}

function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (SECRET_KEY_RE.test(key)) return '<redacted>';
  if (depth > 2) return '<nested>';
  if (Array.isArray(value)) return value.slice(0, 8).map((entry) => redactValue(key, entry, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([entryKey, entryValue]) => [entryKey, redactValue(entryKey, entryValue, depth + 1)]));
  }
  if (typeof value === 'string' && /(?:[?&](?:token|secret|password|api[_-]?key)=|bearer\s+)/i.test(value)) return '<redacted>';
  if (typeof value === 'string' && value.length > 240) return `${value.slice(0, 237)}...`;
  return value;
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).slice(0, 30).map(([key, value]) => [key, redactValue(key, value)]));
}

function hasSchemaProperty(definition: ToolDefinition | undefined, property: string): boolean {
  const parameters = definition?.parameters;
  if (!isRecord(parameters)) return false;
  const properties = parameters.properties;
  return isRecord(properties) && property in properties;
}

function sideEffects(definition: ToolDefinition | undefined): readonly string[] {
  return Array.isArray(definition?.sideEffects) ? definition.sideEffects.filter((entry): entry is string => typeof entry === 'string') : [];
}

function findToolDefinition(toolRegistry: ToolRegistry, name: string): ToolDefinition | undefined {
  return toolRegistry.getToolDefinitions().find((definition) => definition.name === name);
}

function toolSearchText(definition: ToolDefinition): string {
  return [definition.name, definition.description, ...(definition.sideEffects ?? [])].filter(Boolean).join('\n').toLowerCase();
}

function resolveToolName(toolRegistry: ToolRegistry, args: AgentPolicyExplainArgs): {
  readonly status: 'found' | 'ambiguous' | 'missing_lookup';
  readonly toolName?: string;
  readonly input?: string;
  readonly candidates?: readonly Record<string, unknown>[];
  readonly explicit?: boolean;
} {
  const explicit = readString(args.toolName) || readString(args.tool);
  if (explicit) return { status: 'found', toolName: explicit, input: explicit, explicit: true };
  const input = readString(args.target) || readString(args.query);
  if (!input) return { status: 'missing_lookup' };

  const definitions = toolRegistry.getToolDefinitions();
  const exact = definitions.find((definition) => definition.name === input);
  if (exact) return { status: 'found', toolName: exact.name, input, explicit: false };
  const lowered = input.toLowerCase();
  const insensitive = definitions.find((definition) => definition.name.toLowerCase() === lowered);
  if (insensitive) return { status: 'found', toolName: insensitive.name, input, explicit: false };
  const matches = definitions.filter((definition) => toolSearchText(definition).includes(lowered)).slice(0, 8);
  if (matches.length === 1) return { status: 'found', toolName: matches[0]!.name, input, explicit: false };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.map((definition) => ({
        toolName: definition.name,
        description: definition.description,
        modelRoute: `security action:"explain" toolName:"${definition.name}" toolArgs:{...}`,
      })),
    };
  }
  return { status: 'found', toolName: input, input, explicit: false };
}

function readConfigValue(context: CommandContext, key: string): unknown {
  try {
    const manager = context.platform.configManager as unknown as { get?: (key: string) => unknown };
    return manager.get?.(key);
  } catch {
    return undefined;
  }
}

function readPermissionMode(context: CommandContext): string {
  const configured = readString(readConfigValue(context, 'permissions.mode'));
  if (configured) return configured;
  const mode = context.platform.config?.permissions?.mode;
  return typeof mode === 'string' && mode ? mode : 'prompt';
}

function readPermissionToolAction(context: CommandContext, key: PermissionToolKey): string | null {
  const configured = readString(readConfigValue(context, `permissions.tools.${key}`));
  if (configured) return configured;
  const action = context.platform.config?.permissions?.tools?.[key];
  return typeof action === 'string' && action ? action : null;
}

function readAutoApprove(context: CommandContext): boolean {
  const configured = readConfigValue(context, 'behavior.autoApprove');
  if (typeof configured === 'boolean') return configured;
  return context.platform.config?.behavior?.autoApprove === true;
}

/**
 * Reads the SAME effective approval posture that cli/status.ts, the doctor
 * surface, and the footer read (via computeApprovalPosture), the shared
 * single source of truth, so this tool's "explain" output never disagrees
 * with what those other surfaces say about auto-approve / permission mode.
 */
function readEffectivePosture(context: CommandContext): ApprovalPosture {
  const mode = readPermissionMode(context);
  const customTools: Record<string, unknown> = {};
  if (mode === 'custom') {
    for (const key of Object.values(TOOL_CONFIG_KEYS)) {
      if (key in customTools) continue;
      customTools[key] = readPermissionToolAction(context, key) ?? undefined;
    }
  }
  return computeApprovalPosture({
    autoApprove: readAutoApprove(context),
    mode,
    customTools,
  });
}

function predictPermission(context: CommandContext, toolName: string, category: PermissionCategory): PermissionPrediction {
  const posture = readEffectivePosture(context);

  if (posture.autoApprove) {
    return {
      outcome: 'allowed',
      sourceLayer: 'config_policy',
      reasonCode: 'config_allow',
      mode: posture.mode,
      reason: posture.detail,
    };
  }

  const mode = posture.mode;
  if (mode === 'allow-all') {
    return {
      outcome: 'allowed',
      sourceLayer: 'runtime_mode',
      reasonCode: 'mode_allow_all',
      mode,
      reason: posture.detail,
    };
  }

  if (mode === 'plan') {
    if (category === 'read') {
      return {
        outcome: 'allowed',
        sourceLayer: 'runtime_mode',
        reasonCode: 'mode_allow_all',
        mode,
        reason: 'Plan mode auto-allows read-only actions.',
      };
    }
    return {
      outcome: 'denied',
      sourceLayer: 'runtime_mode',
      reasonCode: 'plan_mode',
      mode,
      reason: `Plan mode refuses ${category} actions outright, it never asks; the model presents a plan instead of acting.`,
    };
  }

  if (mode === 'accept-edits') {
    if (category === 'read' || category === 'write') {
      return {
        outcome: 'allowed',
        sourceLayer: 'runtime_mode',
        reasonCode: category === 'write' ? 'mode_accept_edits' : 'mode_allow_all',
        mode,
        reason: category === 'write'
          ? 'Accept-edits mode auto-approves file write/edit actions.'
          : 'Accept-edits mode auto-allows read-only actions.',
      };
    }
    return {
      outcome: 'prompt',
      sourceLayer: 'user_prompt_pending',
      reasonCode: 'prompt_required',
      mode,
      reason: `Accept-edits mode still asks before ${category} actions.`,
    };
  }

  if (mode === 'custom') {
    const toolConfigKey = TOOL_CONFIG_KEYS[toolName];
    if (!toolConfigKey) {
      return {
        outcome: 'prompt',
        sourceLayer: 'user_prompt_pending',
        reasonCode: 'prompt_required',
        mode,
        reason: 'Custom permission mode has no per-tool rule for this tool.',
      };
    }
    const configuredAction = readPermissionToolAction(context, toolConfigKey) ?? 'prompt';
    if (configuredAction === 'allow') {
      return {
        outcome: 'allowed',
        sourceLayer: 'config_policy',
        reasonCode: 'config_allow',
        mode,
        configuredAction,
        reason: `Custom permission rule permissions.tools.${toolConfigKey} is allow.`,
      };
    }
    if (configuredAction === 'deny') {
      return {
        outcome: 'denied',
        sourceLayer: 'config_policy',
        reasonCode: 'config_deny',
        mode,
        configuredAction,
        reason: `Custom permission rule permissions.tools.${toolConfigKey} is deny.`,
      };
    }
    return {
      outcome: 'prompt',
      sourceLayer: 'user_prompt_pending',
      reasonCode: 'prompt_required',
      mode,
      configuredAction,
      reason: `Custom permission rule permissions.tools.${toolConfigKey} is prompt.`,
    };
  }

  if (category === 'read') {
    return {
      outcome: 'allowed',
      sourceLayer: 'config_policy',
      reasonCode: 'config_allow',
      mode,
      reason: 'Prompt mode auto-allows read-only actions.',
    };
  }

  return {
    outcome: 'prompt',
    sourceLayer: 'user_prompt_pending',
    reasonCode: 'prompt_required',
    mode,
    reason: `Prompt mode asks before ${category} actions.`,
  };
}

function harnessModeRequiresConfirmation(toolName: string, toolArgs: Record<string, unknown>): boolean {
  if (toolName !== 'agent_harness') return false;
  const mode = readString(toolArgs.mode);
  if (!mode) return false;
  return HARNESS_MODE_DESCRIPTORS.some((descriptor) => descriptor.id === mode && descriptor.requiresConfirmation === true);
}

function confirmationState(toolName: string, toolArgs: Record<string, unknown>, definition: ToolDefinition | undefined, category: PermissionCategory): {
  readonly required: boolean;
  readonly confirmed: boolean;
  readonly reason: string;
} {
  const schemaRequestsConfirmation = hasSchemaProperty(definition, 'confirm') && hasSchemaProperty(definition, 'explicitUserRequest');
  const required = harnessModeRequiresConfirmation(toolName, toolArgs)
    || (schemaRequestsConfirmation && category !== 'read');
  if (!required) {
    return {
      required: false,
      confirmed: true,
      reason: 'The tool contract does not require typed confirmation for this read-only route.',
    };
  }
  const confirmed = readBoolean(toolArgs.confirm) && readString(toolArgs.explicitUserRequest).length > 0;
  return {
    required,
    confirmed,
    reason: confirmed
      ? 'Typed confirmation is present: confirm:true and explicitUserRequest are set.'
      : 'Typed confirmation is required: pass confirm:true and explicitUserRequest.',
  };
}

function statusFor(
  guard: ReturnType<typeof explainAgentToolPolicyInvocation>,
  permission: PermissionPrediction,
  confirmation: ReturnType<typeof confirmationState>,
): PolicyExplanationStatus {
  if (guard.status === 'denied' || permission.outcome === 'denied') return 'denied';
  if (permission.outcome === 'prompt' || (confirmation.required && !confirmation.confirmed)) return 'confirmation_required';
  return 'allowed';
}

function userExplanation(status: PolicyExplanationStatus, category: PermissionCategory): string {
  if (status === 'denied') return 'This action is denied before execution. Use the recommended safer route or change policy explicitly.';
  if (status === 'confirmation_required') return `This ${category} action is available only after the user-visible confirmation or permission prompt is satisfied.`;
  return `This ${category} action is allowed by the current Agent and permission policy.`;
}

export function explainAgentPolicyDecision(
  context: CommandContext,
  toolRegistry: ToolRegistry,
  args: AgentPolicyExplainArgs,
): AgentPolicyExplanationResolution {
  const resolved = resolveToolName(toolRegistry, args);
  if (resolved.status === 'missing_lookup') {
    return {
      status: 'missing_lookup',
      usage: 'policy_explain requires toolName or a target/query matching one model tool.',
    };
  }
  if (resolved.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      input: resolved.input ?? '',
      candidates: resolved.candidates ?? [],
    };
  }

  const toolName = resolved.toolName!;
  const toolArgs = readToolArgs(args);
  const definition = findToolDefinition(toolRegistry, toolName);
  const category = fallbackPermissionCategoryForArgs(toolName, toolArgs);
  const analysis = analyzePermissionRequest(toolName, toolArgs, category);
  const guard = explainAgentToolPolicyInvocation(toolName, toolArgs);
  const permission = predictPermission(context, toolName, category);
  const confirmation = confirmationState(toolName, toolArgs, definition, category);
  const status = statusFor(guard, permission, confirmation);
  const requiredActions = [
    ...(permission.outcome === 'prompt' ? [`Answer the ${category} permission prompt for ${toolName}.`] : []),
    ...(confirmation.required && !confirmation.confirmed ? ['Call the route with confirm:true and explicitUserRequest.'] : []),
  ];
  // The overall approval posture, computed by the SAME shared helper that
  // cli/status.ts, the doctor surface, and the footer use, so this tool's
  // own displayed posture text can never disagree with theirs.
  const posture = readEffectivePosture(context);

  return {
    status: 'found',
    explanation: {
      status,
      toolName,
      registered: definition !== undefined,
      category,
      userExplanation: userExplanation(status, category),
      posture: {
        label: posture.label,
        autoApprove: posture.autoApprove,
        mode: posture.mode,
        automaticApprovals: posture.automaticApprovals,
        bypassesPrompts: posture.bypassesPrompts,
        detail: posture.detail,
      },
      policyLayers: [
        {
          layer: 'Agent route guard',
          outcome: guard.status,
          reason: guard.reason,
          ...(guard.allowedModes ? { allowedModes: guard.allowedModes } : {}),
        },
        {
          layer: 'Permission mode',
          outcome: permission.outcome,
          mode: permission.mode,
          sourceLayer: permission.sourceLayer,
          reasonCode: permission.reasonCode,
          reason: permission.reason,
          ...(permission.configuredAction ? { configuredAction: permission.configuredAction } : {}),
        },
        {
          layer: 'Tool confirmation',
          outcome: confirmation.required ? (confirmation.confirmed ? 'confirmed' : 'required') : 'not_required',
          reason: confirmation.reason,
        },
      ],
      requiredActions,
      analysis,
      preflight: {
        approvedWithoutMoreInput: status === 'allowed',
        permissionOutcome: permission.outcome,
        toolConfirmationRequired: confirmation.required,
        toolConfirmationSatisfied: confirmation.confirmed,
      },
      toolArgs: redactArgs(toolArgs),
      routes: {
        explain: `security action:"explain" toolName:"${toolName}" toolArgs:{...}`,
        inspectTool: `agent_harness mode:"tool" toolName:"${toolName}" includeParameters:true`,
        permissions: 'workspace action:"actions" categoryId:"tools-permissions"',
        securityPosture: 'security action:"status" includeParameters:true',
      },
      notes: [
        'This is a read-only preflight; final execution still uses the live safety guard.',
        'Secret-looking argument values are redacted in this explanation.',
      ],
      ...(args.includeParameters === true && definition ? {
        toolDefinition: {
          name: definition.name,
          description: definition.description,
          sideEffects: sideEffects(definition),
          hasConfirmParameter: hasSchemaProperty(definition, 'confirm'),
          hasExplicitUserRequestParameter: hasSchemaProperty(definition, 'explicitUserRequest'),
        },
      } : {}),
      ...(resolved.input ? { lookup: { input: resolved.input, explicit: resolved.explicit === true } } : {}),
    },
  };
}
