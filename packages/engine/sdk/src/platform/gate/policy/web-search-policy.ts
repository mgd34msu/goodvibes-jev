/**
 * Main-conversation policy for the `web_search` tool: bounded, read-only web research only.
 *
 * Hoisted from the agent (src/tools/agent-web-search-policy.ts) into the engine gate. A fixed
 * allowlist over the tool's arguments, kept as code because it is the Agent product's
 * declaration of which options its web_search tool offers (and, for caps, how much it returns),
 * not a reading of any call's content.
 */
import type { Tool } from '../../types/tools.js';

type WebSearchToolArgs = {
  readonly maxResults?: unknown;
  readonly verbosity?: unknown;
  readonly safeSearch?: unknown;
  readonly includeEvidence?: unknown;
  readonly evidenceTopN?: unknown;
  readonly evidenceExtract?: unknown;
  readonly [key: string]: unknown;
};

const READ_ONLY_WEB_SEARCH_VERBOSITIES = ['urls_only', 'titles', 'snippets', 'evidence'] as const;
const READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACTS = [
  'text',
  'markdown',
  'readable',
  'code_blocks',
  'links',
  'metadata',
  'tables',
] as const;

const READ_ONLY_WEB_SEARCH_VERBOSITY_SET = new Set<string>(READ_ONLY_WEB_SEARCH_VERBOSITIES);
const READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACT_SET = new Set<string>(READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACTS);

const MAX_WEB_SEARCH_RESULTS = 10;
const MAX_WEB_SEARCH_EVIDENCE_TOP_N = 3;

const WEB_SEARCH_POLICY_DENIAL = [
  'GoodVibes Agent only exposes bounded, read-only web research from the main conversation.',
  'Full-page/raw/summary evidence extraction, safe-search off, and high-fanout searches are disabled here.',
  'Use explicit Agent CLI/slash commands or an approval-backed workflow for broader external research.',
].join(' ');

export const AGENT_READ_ONLY_WEB_SEARCH_VERBOSITIES = READ_ONLY_WEB_SEARCH_VERBOSITIES;
export const AGENT_READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACTS = READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACTS;
export const AGENT_MAX_WEB_SEARCH_RESULTS = MAX_WEB_SEARCH_RESULTS;
export const AGENT_MAX_WEB_SEARCH_EVIDENCE_TOP_N = MAX_WEB_SEARCH_EVIDENCE_TOP_N;
export const AGENT_WEB_SEARCH_POLICY_DENIAL_MESSAGE = WEB_SEARCH_POLICY_DENIAL;

export function wrapWebSearchToolForAgentPolicy(tool: Tool): void {
  narrowWebSearchToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args) => {
    const denial = validateWebSearchToolInvocationForAgentPolicy(args as WebSearchToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(normalizeWebSearchToolInvocationForAgentPolicy(args as WebSearchToolArgs) as Parameters<Tool['execute']>[0]);
  };
}

export function validateWebSearchToolInvocationForAgentPolicy(args: WebSearchToolArgs): string | null {
  if (typeof args.maxResults === 'number' && args.maxResults > MAX_WEB_SEARCH_RESULTS) return WEB_SEARCH_POLICY_DENIAL;
  if (typeof args.evidenceTopN === 'number' && args.evidenceTopN > MAX_WEB_SEARCH_EVIDENCE_TOP_N) return WEB_SEARCH_POLICY_DENIAL;
  if (args.safeSearch === 'off') return WEB_SEARCH_POLICY_DENIAL;
  if (typeof args.verbosity === 'string' && !READ_ONLY_WEB_SEARCH_VERBOSITY_SET.has(args.verbosity)) {
    return WEB_SEARCH_POLICY_DENIAL;
  }
  if (
    typeof args.evidenceExtract === 'string'
    && !READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACT_SET.has(args.evidenceExtract)
  ) {
    return WEB_SEARCH_POLICY_DENIAL;
  }
  return null;
}

export function normalizeWebSearchToolInvocationForAgentPolicy(args: WebSearchToolArgs): WebSearchToolArgs {
  return {
    ...args,
    safeSearch: typeof args.safeSearch === 'string' ? args.safeSearch : 'moderate',
  };
}

function narrowWebSearchToolDefinitionForAgentPolicy(tool: Tool): void {
  tool.definition.description = 'Run bounded, read-only web research for GoodVibes Agent.';
  tool.definition.sideEffects = ['network'];

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;

  const verbosity = properties.verbosity;
  if (isRecord(verbosity)) {
    verbosity.enum = [...READ_ONLY_WEB_SEARCH_VERBOSITIES];
    verbosity.description = 'Bounded result verbosity allowed by GoodVibes Agent main-conversation policy.';
  }

  const evidenceExtract = properties.evidenceExtract;
  if (isRecord(evidenceExtract)) {
    evidenceExtract.enum = [...READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACTS];
    evidenceExtract.description = 'Bounded evidence extraction modes allowed by GoodVibes Agent main-conversation policy.';
  }

  const maxResults = properties.maxResults;
  if (isRecord(maxResults)) {
    maxResults.maximum = MAX_WEB_SEARCH_RESULTS;
    maxResults.description = 'Maximum ranked results returned by GoodVibes Agent main-conversation web research.';
  }

  const evidenceTopN = properties.evidenceTopN;
  if (isRecord(evidenceTopN)) {
    evidenceTopN.maximum = MAX_WEB_SEARCH_EVIDENCE_TOP_N;
    evidenceTopN.description = 'Maximum top results fetched for evidence by GoodVibes Agent main-conversation web research.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
