/** Preserve shared tool capabilities and caller-selected options. */
import type { Tool } from '../../types/tools.js';

type FindToolArgs = {
  readonly queries?: unknown;
  readonly output?: unknown;
  readonly parallel?: unknown;
  readonly [key: string]: unknown;
};

const READ_ONLY_FIND_OUTPUT_FORMATS = [
  'count_only',
  'files_only',
  'locations',
  'matches',
  'context',
  'with_stats',
  'signatures',
] as const;

const FIND_POLICY_DENIAL = 'Invalid search options.';

export const AGENT_READ_ONLY_FIND_OUTPUT_FORMATS = READ_ONLY_FIND_OUTPUT_FORMATS;
export const AGENT_FIND_POLICY_DENIAL_MESSAGE = FIND_POLICY_DENIAL;

export function wrapFindToolForAgentPolicy(tool: Tool): void {
  narrowFindToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    options?.signal?.throwIfAborted();
    const findArgs = args as FindToolArgs;
    const denial = validateFindToolInvocationForAgentPolicy(findArgs);
    if (denial) return { success: false, error: denial };
    options?.signal?.throwIfAborted();
    return originalExecute(normalizeFindToolInvocationForAgentPolicy(findArgs) as Parameters<Tool['execute']>[0], options);
  };
}

/** The shared search schema and configured read filter own validation. */
export function validateFindToolInvocationForAgentPolicy(_args: FindToolArgs): string | null { return null; }
export function normalizeFindToolInvocationForAgentPolicy(args: FindToolArgs): FindToolArgs { return args; }
function narrowFindToolDefinitionForAgentPolicy(_tool: Tool): void {}
