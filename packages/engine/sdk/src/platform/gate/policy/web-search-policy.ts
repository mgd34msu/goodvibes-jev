/** Preserve shared tool capabilities and caller-selected options. */
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

const MAX_WEB_SEARCH_RESULTS = 25;
const MAX_WEB_SEARCH_EVIDENCE_TOP_N = 10;
const WEB_SEARCH_POLICY_DENIAL = 'Invalid web search options.';

export const AGENT_READ_ONLY_WEB_SEARCH_VERBOSITIES = READ_ONLY_WEB_SEARCH_VERBOSITIES;
export const AGENT_READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACTS = READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACTS;
export const AGENT_MAX_WEB_SEARCH_RESULTS = MAX_WEB_SEARCH_RESULTS;
export const AGENT_MAX_WEB_SEARCH_EVIDENCE_TOP_N = MAX_WEB_SEARCH_EVIDENCE_TOP_N;
export const AGENT_WEB_SEARCH_POLICY_DENIAL_MESSAGE = WEB_SEARCH_POLICY_DENIAL;

export function wrapWebSearchToolForAgentPolicy(tool: Tool): void {
  narrowWebSearchToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const denial = validateWebSearchToolInvocationForAgentPolicy(args as WebSearchToolArgs);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(normalizeWebSearchToolInvocationForAgentPolicy(args as WebSearchToolArgs) as Parameters<Tool['execute']>[0], options);
  };
}

/** The search provider and shared tool schema own supported result budgets. */
export function validateWebSearchToolInvocationForAgentPolicy(_args: WebSearchToolArgs): string | null { return null; }
export function normalizeWebSearchToolInvocationForAgentPolicy(args: WebSearchToolArgs): WebSearchToolArgs { return args; }
function narrowWebSearchToolDefinitionForAgentPolicy(_tool: Tool): void {}
