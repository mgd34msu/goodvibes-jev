import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { catalogSearchTokens, searchCatalog, type CatalogSearchResult } from './agent-harness-catalog-search.ts';

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
  return [
    tool.name,
    tool.name.replace(/_/g, ' '),
    tool.description,
    ...(tool.sideEffects ?? []),
    schemaSearchText(tool.parameters),
  ].join('\n').toLowerCase();
}


function tokenScore(tokens: readonly string[], value: string | undefined, weight: number): number {
  if (!value) return 0;
  const text = value.toLowerCase();
  return tokens.reduce((score, token) => score + (text.includes(token) ? weight : 0), 0);
}

const ACTION_VERBS = new Set(['run', 'set', 'reset', 'open', 'create', 'send', 'schedule', 'generate', 'read', 'search', 'ingest']);

function modelToolRelevance(tool: HarnessModelToolDefinition, input: string): number {
  const normalized = input.toLowerCase().trim();
  if (!normalized) return 0;

  const tokens = catalogSearchTokens(normalized);
  const name = tool.name.toLowerCase();
  const namePhrase = name.replace(/_/g, ' ');
  const nameLookup = normalized.replace(/\s+/g, '_');
  const parameterText = schemaSearchText(tool.parameters);
  let score = 0;

  if (name === normalized || namePhrase === normalized) score += 10_000;
  if (name.startsWith(nameLookup) || namePhrase.startsWith(normalized)) score += 5_000;
  if (name.includes(nameLookup) || namePhrase.includes(normalized)) score += 2_500;

  score += tokenScore(tokens, `${name}\n${namePhrase}`, 1_000);
  score += tokenScore(tokens, tool.description, 300);
  score += tokenScore(tokens, (tool.sideEffects ?? []).join('\n'), 250);
  score += tokenScore(tokens, parameterText, 150);

  const actionVerb = tokens.find((token) => ACTION_VERBS.has(token));
  if (actionVerb && catalogSearchTokens(name).includes(actionVerb)) score += 1_500;

  return score;
}

function matchingModelTools(tools: readonly HarnessModelToolDefinition[], input: string): CatalogSearchResult<HarnessModelToolDefinition> {
  const query = input.toLowerCase().trim();
  const found = searchCatalog(tools, query, modelToolSearchText);
  const ranked = found.matches
    .map((tool, index) => ({ tool, index, score: modelToolRelevance(tool, query) }))
    .sort((left, right) => {
      if (!query) return left.tool.name.localeCompare(right.tool.name);
      return right.score - left.score || left.tool.name.localeCompare(right.tool.name) || left.index - right.index;
    })
    .map(({ tool }) => tool);
  return { matches: ranked, relaxed: found.relaxed };
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

export function searchHarnessModelTools(
  toolRegistry: ToolRegistry,
  args: AgentHarnessModelToolCatalogArgs,
): CatalogSearchResult<Record<string, unknown>> {
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const limit = readLimit(args.limit, 500);
  const found = matchingModelTools(toolRegistry.getToolDefinitions(), query);
  return {
    matches: found.matches.slice(0, limit).map((tool) => describeModelTool(tool, { includeParameters })),
    relaxed: found.relaxed,
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
  const names = toolRegistry.getToolDefinitions().map((tool) => tool.name).sort();
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

export function describeHarnessModelTool(toolRegistry: ToolRegistry, args: AgentHarnessModelToolCatalogArgs): HarnessModelToolResolution | null {
  const lookup = modelToolLookupFromArgs(args);
  if (!lookup) return null;
  const tools = toolRegistry.getToolDefinitions().sort((a, b) => a.name.localeCompare(b.name));
  const normalized = lookup.input.toLowerCase();
  const exact = tools.find((tool) => tool.name === lookup.input);
  const found = exact
    ? { tool: exact, resolvedBy: 'name' }
    : (() => {
        const insensitive = tools.find((tool) => tool.name.toLowerCase() === normalized);
        if (insensitive) return { tool: insensitive, resolvedBy: 'case-insensitive-name' };
        if (lookup.source === 'toolName') return null;
        const searched = matchingModelTools(tools, normalized);
        // A loose hit names a tool the query did not: offer it, never pick it.
        if (searched.matches.length === 1 && !searched.relaxed) return { tool: searched.matches[0]!, resolvedBy: 'search' };
        if (searched.matches.length > 0) return { candidates: searched.matches };
        return null;
      })();
  if (!found) return null;
  if ('candidates' in found) return { status: 'ambiguous', input: lookup.input, candidates: describeModelToolCandidates(found.candidates) };
  return {
    status: 'found',
    tool: {
      ...describeModelTool(found.tool, { includeParameters: true, lookup: { ...lookup, resolvedBy: found.resolvedBy } }),
      policy: 'This is a first-class model tool definition. Use the returned JSON schema directly; mutating or external side-effect tools still require the explicit confirmation arguments defined by that tool.',
    },
  };
}
