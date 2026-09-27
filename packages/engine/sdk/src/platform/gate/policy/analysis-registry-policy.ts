/**
 * Main-conversation policy for the `analyze` and `registry` tools: local static analysis and bounded registry discovery only.
 *
 * Hoisted from the agent (src/tools/agent-analysis-registry-policy.ts) into the engine gate. A fixed
 * allowlist over the tool's arguments: a deterministic boundary, kept as code.
 */
import type { Tool } from '../../types/tools.js';

type AnalyzeToolArgs = {
  readonly mode?: unknown;
  readonly [key: string]: unknown;
};

type RegistryToolArgs = {
  readonly mode?: unknown;
  readonly path?: unknown;
  readonly [key: string]: unknown;
};

const READ_ONLY_ANALYZE_TOOL_MODES = [
  'impact',
  'dependencies',
  'dead_code',
  'security',
  'coverage',
  'bundle',
  'preview',
  'diff',
  'surface',
  'breaking',
  'permissions',
  'test_find',
] as const;

const READ_ONLY_REGISTRY_TOOL_MODES = ['search', 'recommend', 'dependencies', 'preview'] as const;

const READ_ONLY_ANALYZE_TOOL_MODE_SET = new Set<string>(READ_ONLY_ANALYZE_TOOL_MODES);
const READ_ONLY_REGISTRY_TOOL_MODE_SET = new Set<string>(READ_ONLY_REGISTRY_TOOL_MODES);

const ANALYZE_NETWORK_DENIAL = [
  'GoodVibes Agent only exposes local, static analyze modes from the main conversation.',
  'npm registry upgrade checks and hidden secondary LLM diff analysis are disabled here.',
  'Use explicit Agent CLI/slash commands or GoodVibes TUI delegation for package-upgrade and code-review workflows.',
].join(' ');

const REGISTRY_CONTENT_DENIAL = [
  'GoodVibes Agent only exposes registry discovery, recommendation, dependency, and bounded preview from the main conversation.',
  'Full registry content materialization and arbitrary .goodvibes file reads are disabled here.',
  'Use explicit Agent CLI/slash commands for intentional local registry changes or deeper inspection.',
].join(' ');

export const AGENT_READ_ONLY_ANALYZE_TOOL_MODES = READ_ONLY_ANALYZE_TOOL_MODES;
export const AGENT_READ_ONLY_REGISTRY_TOOL_MODES = READ_ONLY_REGISTRY_TOOL_MODES;
export const AGENT_ANALYZE_NETWORK_DENIAL_MESSAGE = ANALYZE_NETWORK_DENIAL;
export const AGENT_REGISTRY_CONTENT_DENIAL_MESSAGE = REGISTRY_CONTENT_DENIAL;

export function wrapAnalyzeToolForAgentPolicy(tool: Tool): void {
  narrowAnalyzeToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args) => {
    const denial = validateAnalyzeToolInvocationForAgentPolicy(args as AnalyzeToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(args);
  };
}

export function wrapRegistryToolForAgentPolicy(tool: Tool): void {
  narrowRegistryToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args) => {
    const denial = validateRegistryToolInvocationForAgentPolicy(args as RegistryToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(args);
  };
}

export function validateAnalyzeToolInvocationForAgentPolicy(args: AnalyzeToolArgs): string | null {
  if (typeof args.mode === 'string' && !READ_ONLY_ANALYZE_TOOL_MODE_SET.has(args.mode)) return ANALYZE_NETWORK_DENIAL;
  return null;
}

export function validateRegistryToolInvocationForAgentPolicy(args: RegistryToolArgs): string | null {
  if (typeof args.mode === 'string' && !READ_ONLY_REGISTRY_TOOL_MODE_SET.has(args.mode)) return REGISTRY_CONTENT_DENIAL;
  if (args.mode === 'preview' && typeof args.path === 'string' && !isAllowedAgentRegistryPreviewPath(args.path)) {
    return REGISTRY_CONTENT_DENIAL;
  }
  return null;
}

function narrowAnalyzeToolDefinitionForAgentPolicy(tool: Tool): void {
  tool.definition.description = 'Run local, static project analysis for GoodVibes Agent.';
  tool.definition.sideEffects = ['read_fs'];

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;
  const modeProperty = properties.mode;
  if (isRecord(modeProperty)) {
    modeProperty.enum = [...READ_ONLY_ANALYZE_TOOL_MODES];
    modeProperty.description = 'Local static analysis mode allowed by GoodVibes Agent main-conversation policy.';
  }

  delete properties.packages;
}

function narrowRegistryToolDefinitionForAgentPolicy(tool: Tool): void {
  tool.definition.description = 'Discover and preview GoodVibes Agent registry entries.';
  tool.definition.sideEffects = ['read_fs'];

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;
  const modeProperty = properties.mode;
  if (isRecord(modeProperty)) {
    modeProperty.enum = [...READ_ONLY_REGISTRY_TOOL_MODES];
    modeProperty.description = 'Bounded registry discovery modes allowed by GoodVibes Agent main-conversation policy.';
  }
}

function isAllowedAgentRegistryPreviewPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return /(?:^|\/)\.goodvibes\/(?:skills|agents)\/.+(?:\.md|\/(?:SKILL|AGENT)\.md)$/i.test(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
