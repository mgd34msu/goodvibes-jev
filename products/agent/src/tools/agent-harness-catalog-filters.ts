/**
 * Which argument names each catalog mode filters on, and the route that lists
 * the whole catalog.
 *
 * An empty page has to name the filter that emptied it and the way back to a
 * full listing (see catalogEnvelope in agent-harness-tool-utils.ts), so both
 * belong next to each other rather than inline at the dispatch sites.
 */

const MODEL_TOOL_FILTERS = ['query', 'toolName', 'target'] as const;
const MODEL_TOOL_DISCOVERY = 'agent_harness mode:"tools" with no query';

const UI_SURFACE_FILTERS = ['query', 'surfaceId', 'target'] as const;
const UI_SURFACE_DISCOVERY = 'agent_harness mode:"ui_surfaces" with no query';

const CLI_COMMAND_FILTERS = ['query', 'cliCommand', 'target'] as const;
const CLI_COMMAND_DISCOVERY = 'agent_harness mode:"cli_commands" with no query';

const COMMAND_FILTERS = ['query', 'command', 'commandName', 'target'] as const;
const COMMAND_DISCOVERY = 'agent_harness mode:"commands" with no query';

const WORKSPACE_ACTION_FILTERS = ['query', 'category', 'categoryId'] as const;
const WORKSPACE_ACTION_DISCOVERY =
  'agent_harness mode:"workspace_actions" with no category or query';

const SETTING_FILTERS = ['query', 'category', 'prefix'] as const;
const SETTING_DISCOVERY = 'agent_harness mode:"settings" with no category, prefix, or query';

const METHOD_FILTERS = ['query', 'methodId', 'target'] as const;
const METHOD_DISCOVERY = 'host action:"methods" with no query';

/** Filter names and full-listing route for each catalog mode, keyed by mode id. */
export const CATALOG_QUERIES = {
  settings: { filters: SETTING_FILTERS, discovery: SETTING_DISCOVERY },
  tools: { filters: MODEL_TOOL_FILTERS, discovery: MODEL_TOOL_DISCOVERY },
  ui_surfaces: { filters: UI_SURFACE_FILTERS, discovery: UI_SURFACE_DISCOVERY },
  cli_commands: { filters: CLI_COMMAND_FILTERS, discovery: CLI_COMMAND_DISCOVERY },
  commands: { filters: COMMAND_FILTERS, discovery: COMMAND_DISCOVERY },
  workspace_actions: { filters: WORKSPACE_ACTION_FILTERS, discovery: WORKSPACE_ACTION_DISCOVERY },
  methods: { filters: METHOD_FILTERS, discovery: METHOD_DISCOVERY },
} as const;
