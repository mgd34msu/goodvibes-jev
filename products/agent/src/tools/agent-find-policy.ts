import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';

type FindQueryArgs = {
  readonly follow_symlinks?: unknown;
  readonly include_hidden?: unknown;
  readonly respect_gitignore?: unknown;
  readonly [key: string]: unknown;
};

type FindOutputArgs = {
  readonly format?: unknown;
  readonly [key: string]: unknown;
};

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

const READ_ONLY_FIND_OUTPUT_FORMAT_SET = new Set<string>(READ_ONLY_FIND_OUTPUT_FORMATS);

const FIND_POLICY_DENIAL = [
  'GoodVibes Agent only exposes serial, project-root, gitignore-respecting search from the main conversation.',
  'Hidden-file scans, symlink traversal, gitignore bypass, broad file previews, full symbol dumps, and parallel search are disabled here.',
  'Use explicit Agent CLI/slash commands or GoodVibes TUI delegation for deeper local inspection.',
].join(' ');

export const AGENT_READ_ONLY_FIND_OUTPUT_FORMATS = READ_ONLY_FIND_OUTPUT_FORMATS;
export const AGENT_FIND_POLICY_DENIAL_MESSAGE = FIND_POLICY_DENIAL;

export function wrapFindToolForAgentPolicy(tool: Tool): void {
  narrowFindToolDefinitionForAgentPolicy(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    const findArgs = args as FindToolArgs;
    const denial = validateFindToolInvocationForAgentPolicy(findArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(normalizeFindToolInvocationForAgentPolicy(findArgs) as Parameters<Tool['execute']>[0], options);
  };
}

export function validateFindToolInvocationForAgentPolicy(args: FindToolArgs): string | null {
  if (args.parallel === true) return FIND_POLICY_DENIAL;

  if (Array.isArray(args.queries)) {
    for (const query of args.queries) {
      if (!isRecord(query)) continue;
      const queryArgs = query as FindQueryArgs;
      if (queryArgs.follow_symlinks === true) return FIND_POLICY_DENIAL;
      if (queryArgs.include_hidden === true) return FIND_POLICY_DENIAL;
      if (queryArgs.respect_gitignore === false) return FIND_POLICY_DENIAL;
    }
  }

  if (isRecord(args.output)) {
    const output = args.output as FindOutputArgs;
    if (typeof output.format === 'string' && !READ_ONLY_FIND_OUTPUT_FORMAT_SET.has(output.format)) {
      return FIND_POLICY_DENIAL;
    }
  }

  return null;
}

export function normalizeFindToolInvocationForAgentPolicy(args: FindToolArgs): FindToolArgs {
  return {
    ...args,
    parallel: false,
  };
}

function narrowFindToolDefinitionForAgentPolicy(tool: Tool): void {
  tool.definition.description = 'Search project files with serial, gitignore-respecting read-only queries.';
  tool.definition.sideEffects = ['read_fs'];
  tool.definition.concurrency = 'serial';

  const properties = tool.definition.parameters.properties;
  if (!isRecord(properties)) return;
  delete properties.parallel;

  const queries = properties.queries;
  if (isRecord(queries)) {
    const itemSchema = queries.items;
    if (isRecord(itemSchema)) {
      const queryProperties = itemSchema.properties;
      if (isRecord(queryProperties)) {
        delete queryProperties.follow_symlinks;
        delete queryProperties.include_hidden;
        delete queryProperties.respect_gitignore;
      }
    }
  }

  const output = properties.output;
  if (!isRecord(output)) return;
  const outputProperties = output.properties;
  if (!isRecord(outputProperties)) return;

  const format = outputProperties.format;
  if (isRecord(format)) {
    format.enum = [...READ_ONLY_FIND_OUTPUT_FORMATS];
    format.description = 'Bounded output format allowed by GoodVibes Agent main-conversation search policy.';
  }
  delete outputProperties.preview_lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
