import { types as nodeTypes } from 'node:util';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CatalogSearchResult } from './agent-harness-catalog-search.ts';
import { rankHarnessCatalog, captureCatalogData, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';

export interface AgentHarnessModelToolCatalogArgs {
  readonly query?: unknown;
  readonly toolName?: unknown;
  readonly target?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type HarnessModelToolDefinition = ReturnType<ToolRegistry['getToolDefinitions']>[number];
type ModelToolLookupSource = 'toolName' | 'target' | 'query';

export type HarnessModelToolResolution =
  | { readonly status: 'found'; readonly tool: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function previewText(value: string, maxLength = 56): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function schemaSearchText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(schemaSearchText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value)
    .map(([key, entry]) => `${key}\n${schemaSearchText(entry)}`)
    .filter(Boolean)
    .join('\n');
}

function modelToolSearchText(tool: HarnessModelToolDefinition): string {
  snapshotJudgmentInput(tool);
  return [
    tool.name,
    tool.name.replace(/_/g, ' '),
    tool.description,
    ...(tool.sideEffects ?? []),
    schemaSearchText(tool.parameters),
  ].join('\n');
}


/** Read registered definition data without invoking a replaced accessor/proxy. */
function captureModelTools(toolRegistry: ToolRegistry): readonly HarnessModelToolDefinition[] {
  const budget = { nodes: 0, characters: 0, slots: 0 };
  return toolRegistry.list().map((tool) => {
    let owner: object | null = tool;
    for (let depth = 0; owner && depth < 64; depth++) {
      if (nodeTypes.isProxy(owner)) throw new ToolInputProjectionError('invalid');
      const descriptor = Object.getOwnPropertyDescriptor(owner, 'definition');
      if (descriptor) {
        if (!('value' in descriptor)) throw new ToolInputProjectionError('invalid');
        return captureCatalogData(descriptor.value, budget) as HarnessModelToolDefinition;
      }
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    throw new ToolInputProjectionError('invalid');
  });
}

async function matchingModelTools(toolRegistry: ToolRegistry, input: string, options: CatalogRankingOptions) {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const registrations = toolRegistry.list();
  const tools = captureModelTools(toolRegistry);
  if (!input) return { matches: tools.slice().sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ entry, judgment: undefined })) };
  const revision = JSON.stringify(tools);
  return rankHarnessCatalog(tools, input, (entry) => ({ id: entry.name, description: modelToolSearchText(entry), evidence: entry }), 'agent.harness.tools', {
    ...options, requirePreservedSource: true, assertCurrent: () => {
      options.assertCurrent?.();
      const current = toolRegistry.list();
      if (current.length !== registrations.length || current.some((tool, index) => tool !== registrations[index])
        || JSON.stringify(captureModelTools(toolRegistry)) !== revision) throw new ToolInputProjectionError('stale');
    },
  });
}

function modelToolLookupFromArgs(args: AgentHarnessModelToolCatalogArgs): { readonly source: ModelToolLookupSource; readonly input: string } | null {
  const toolName = readString(args.toolName);
  if (toolName) return { source: 'toolName', input: toolName };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function describeModelTool(tool: HarnessModelToolDefinition, options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    name: tool.name,
    ...(options.includeParameters ? { description: tool.description } : { summary: previewText(tool.description) }),
    modelRoute: tool.name,
    modelAccess: {
      inspect: `agent_harness mode:"tool" toolName:"${tool.name}"`,
      invoke: tool.name,
    },
    sideEffects: tool.sideEffects ?? [],
    concurrency: tool.concurrency ?? 'parallel',
    supportsProgress: tool.supportsProgress ?? false,
    supportsStreamingOutput: tool.supportsStreamingOutput ?? false,
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? { parameters: tool.parameters } : {}),
  };
}

function describeModelToolCandidates(tools: readonly HarnessModelToolDefinition[]): readonly Record<string, unknown>[] {
  return tools.slice(0, 8).map((tool) => ({
    toolName: tool.name,
    summary: previewText(tool.description),
    modelRoute: tool.name,
    inspectRoute: `agent_harness mode:"tool" toolName:"${tool.name}"`,
    sideEffects: tool.sideEffects ?? [],
  }));
}

export async function searchHarnessModelTools(
  toolRegistry: ToolRegistry,
  args: AgentHarnessModelToolCatalogArgs,
  options: CatalogRankingOptions = {},
): Promise<CatalogSearchResult<Record<string, unknown>>> {
  const query = readString(args.query);
  const includeParameters = args.includeParameters === true;
  const limit = readLimit(args.limit, 500);
  const found = await matchingModelTools(toolRegistry, query, options);
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  return {
    matches: found.matches.slice(0, limit).map(({ entry, judgment }) => ({ ...describeModelTool(entry, { includeParameters }), ...(judgment ? { judgment } : {}) })),
    relaxed: false,
  };
}

/**
 * Shape of the qualified names `mcp mode:"tools"` reports for MCP servers'
 * own tools, `mcp:<server>:<tool>`. Those names are real and describable
 * (see the `mcp` tool's own `mode:"tool"` lookup), but they are NOT
 * themselves top-level model tools: nothing in this registry resolves a
 * literal call to one, because they can only be invoked through
 * `mcp mode:"call" qualifiedName:"…"`.
 *
 * The incident this guards against: the model saw `mcp:playwright:browser_tabs`
 * listed by `mcp mode:"tools"`, then asked THIS catalog to look it up as if it
 * were a directly callable tool, got a bare "unknown", and had no way to learn
 * the real invocation path from that answer alone.
 */
const MCP_QUALIFIED_NAME_PATTERN = /^mcp:[^:]+:[^:]+$/;

/**
 * The message for a toolName/target/query that resolved to nothing.
 *
 * Names the tools that actually exist, right there, rather than sending the
 * caller on another round trip through `mode:"tools"` to find out. When the
 * input looks like an MCP-qualified name, adds the specific correction: that
 * shape is not a callable tool by itself, and the real invocation path is
 * named explicitly.
 */
export function describeUnknownModelTool(toolRegistry: ToolRegistry, query: string): string {
  const names = captureModelTools(toolRegistry).map((tool) => tool.name).sort();
  const known = names.length > 0 ? `Known tools: ${names.join(', ')}.` : 'No model tools are registered.';
  const label = query || '<missing>';
  if (query && MCP_QUALIFIED_NAME_PATTERN.test(query)) {
    const hint = names.includes('mcp')
      ? `"${query}" is an MCP-qualified name, not a directly callable tool. Call it with mcp mode:"call" qualifiedName:"${query}" input:{...}, confirm it is actually connected first with mcp mode:"servers" or mode:"tools".`
      : `"${query}" names an MCP tool, but no "mcp" tool is registered here to call it through.`;
    return `Unknown model tool ${label}. ${hint} ${known}`;
  }
  return `Unknown model tool ${label}. ${known} Use mode:"tools" to inspect available model tools.`;
}

export async function describeHarnessModelTool(toolRegistry: ToolRegistry, args: AgentHarnessModelToolCatalogArgs, options: CatalogRankingOptions = {}): Promise<HarnessModelToolResolution | null> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const lookup = modelToolLookupFromArgs(args);
  if (!lookup) return null;
  const tools = captureModelTools(toolRegistry).slice().sort((a, b) => a.name.localeCompare(b.name));
  const normalized = lookup.input.toLowerCase();
  const exact = tools.find((tool) => tool.name === lookup.input);
  const insensitive = tools.find((tool) => tool.name.toLowerCase() === normalized);
  let found: { tool: HarnessModelToolDefinition; resolvedBy: string; judgment?: unknown } | undefined;
  if (exact || insensitive) found = { tool: (exact ?? insensitive)!, resolvedBy: exact ? 'name' : 'case-insensitive-name' };
  else if (lookup.source !== 'toolName') {
    const searched = await matchingModelTools(toolRegistry, lookup.input, options);
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (searched.matches.length === 1 && searched.matches[0]!.judgment?.reading.verdict === 'yes') {
      const match = searched.matches[0]!;
      found = { tool: match.entry, resolvedBy: 'search', judgment: match.judgment };
    } else if (searched.matches.length > 0) {
      return { status: 'ambiguous', input: lookup.input, candidates: searched.matches.slice(0, 8).map(({ entry, judgment }) => ({
        ...describeModelToolCandidates([entry])[0], judgment,
      })) };
    }
  }
  if (!found) return null;
  return { status: 'found', tool: {
    ...describeModelTool(found.tool, { includeParameters: true, lookup: { ...lookup, resolvedBy: found.resolvedBy } }),
    ...(found.judgment ? { judgment: found.judgment } : {}),
    policy: 'This is a first-class model tool definition. Use the returned JSON schema directly; mutating or external side-effect tools still require the explicit confirmation arguments defined by that tool.',
  } };
}
