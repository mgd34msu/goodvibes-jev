import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  createAgentSdk,
  classifyKnowledgeError,
  getAgentKnowledgeJson,
  resolveConnectedHostConnection,
  validateAgentKnowledgeData,
  type AgentKnowledgeFailure,
  type AgentKnowledgeConnectionRuntime,
} from '../cli/agent-knowledge-runtime.ts';
import { AGENT_KNOWLEDGE_METHODS, type ConnectedHostCallMethod } from '../cli/agent-knowledge-methods.ts';
import {
  formatAsk,
  formatConnector,
  formatConnectorDoctor,
  formatConnectors,
  formatEntityList,
  formatFailure,
  formatItem,
  formatMap,
  formatSearch,
  formatStatus,
} from '../cli/agent-knowledge-format.ts';

export type AgentKnowledgeToolAction =
  | 'status'
  | 'ask'
  | 'search'
  | 'sources'
  | 'nodes'
  | 'issues'
  | 'item'
  | 'map'
  | 'connectors'
  | 'connector'
  | 'connector_doctor';
export type AgentKnowledgeAskMode = 'concise' | 'standard' | 'detailed';

export interface AgentKnowledgeToolArgs {
  readonly action?: unknown;
  readonly query?: unknown;
  readonly id?: unknown;
  readonly connectorId?: unknown;
  readonly limit?: unknown;
  readonly mode?: unknown;
}

const ACTIONS: readonly AgentKnowledgeToolAction[] = [
  'status',
  'ask',
  'search',
  'sources',
  'nodes',
  'issues',
  'item',
  'map',
  'connectors',
  'connector',
  'connector_doctor',
];
const ASK_MODES: readonly AgentKnowledgeAskMode[] = ['concise', 'standard', 'detailed'];

function isAction(value: unknown): value is AgentKnowledgeToolAction {
  return typeof value === 'string' && ACTIONS.includes(value as AgentKnowledgeToolAction);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number, max = 25): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return Math.min(value, max);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return Math.min(parsed, max);
  }
  return fallback;
}

function readMode(value: unknown): AgentKnowledgeAskMode {
  return typeof value === 'string' && ASK_MODES.includes(value as AgentKnowledgeAskMode)
    ? value as AgentKnowledgeAskMode
    : 'standard';
}

function toolFailure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function toolOutput(output: string): { readonly success: true; readonly output: string } {
  return { success: true, output };
}

function formatKnowledgeFailure(failure: AgentKnowledgeFailure): string {
  return formatFailure(failure, false);
}

async function classifyToolKnowledgeError(
  error: unknown,
  connection: ReturnType<typeof resolveConnectedHostConnection>,
  method: ConnectedHostCallMethod,
): Promise<{ readonly success: false; readonly error: string }> {
  return toolFailure(formatKnowledgeFailure(await classifyKnowledgeError(error, connection, method.route)));
}

function validatedToolOutput<TData>(
  data: TData,
  connection: ReturnType<typeof resolveConnectedHostConnection>,
  method: ConnectedHostCallMethod,
  format: (validatedData: TData) => string,
): { readonly success: true; readonly output: string } | { readonly success: false; readonly error: string } {
  const validated = validateAgentKnowledgeData(data, connection, method);
  if (!validated.ok) return toolFailure(formatKnowledgeFailure(validated));
  return toolOutput(format(validated.data));
}

export function createAgentKnowledgeTool(
  shellPaths: ShellPathService,
  configManager: AgentKnowledgeConnectionRuntime['configManager'],
): Tool {
  return {
    definition: {
      name: 'agent_knowledge',
      description: 'Read isolated Agent Knowledge.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Read-only Agent Knowledge action.',
          },
          query: {
            type: 'string',
            description: 'Question/query for ask, search, or map filtering.',
          },
          id: {
            type: 'string',
            description: 'Agent Knowledge source, node, or issue id for action item.',
          },
          connectorId: {
            type: 'string',
            description: 'Connector id for connector or connector_doctor.',
          },
          limit: {
            type: 'number',
            description: 'Maximum result count.',
          },
          mode: {
            type: 'string',
            enum: [...ASK_MODES],
            description: 'Answer detail mode for ask.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async (rawArgs: unknown) => {
      const args = rawArgs as AgentKnowledgeToolArgs;
      if (!isAction(args.action)) return toolFailure(`Unknown Agent Knowledge action. Valid values ${ACTIONS.join(', ')}.`);
      const connection = resolveConnectedHostConnection({ configManager, homeDirectory: shellPaths.homeDirectory });
      if (!connection.token) {
        return toolFailure(formatKnowledgeFailure({
          ok: false,
          kind: 'auth_required',
          error: `No connected-host operator token found at ${connection.tokenPath}`,
          baseUrl: connection.baseUrl,
          route: '/api/goodvibes-agent/knowledge/*',
        }));
      }
      let method: ConnectedHostCallMethod = AGENT_KNOWLEDGE_METHODS.status;
      try {
        const sdk = createAgentSdk(connection);
        if (args.action === 'status') {
          method = AGENT_KNOWLEDGE_METHODS.status;
          const data = await sdk.knowledge.status();
          return validatedToolOutput(data, connection, method, formatStatus);
        }
        if (args.action === 'ask') {
          method = AGENT_KNOWLEDGE_METHODS.ask;
          const query = readString(args.query);
          if (!query) return toolFailure('query is required for Agent Knowledge ask.');
          const data = await sdk.knowledge.ask({
            query,
            limit: readLimit(args.limit, 8),
            mode: readMode(args.mode),
            includeSources: true,
            includeConfidence: true,
            includeLinkedObjects: true,
          });
          return validatedToolOutput(data, connection, method, (validatedData) => formatAsk(validatedData, query));
        }
        if (args.action === 'search') {
          method = AGENT_KNOWLEDGE_METHODS.search;
          const query = readString(args.query);
          if (!query) return toolFailure('query is required for Agent Knowledge search.');
          const data = await sdk.knowledge.search({ query, limit: readLimit(args.limit, 10) });
          return validatedToolOutput(data, connection, method, (validatedData) => formatSearch(validatedData, query));
        }
        if (args.action === 'sources' || args.action === 'nodes' || args.action === 'issues') {
          const kind = args.action;
          const limit = readLimit(args.limit, 25, 500);
          method = kind === 'sources'
            ? AGENT_KNOWLEDGE_METHODS.sourcesList
            : kind === 'nodes'
              ? AGENT_KNOWLEDGE_METHODS.nodesList
              : AGENT_KNOWLEDGE_METHODS.issuesList;
          const data = await getAgentKnowledgeJson(connection, method.route, { limit });
          return validatedToolOutput(data, connection, method, (validatedData) => formatEntityList(validatedData, kind, limit));
        }
        if (args.action === 'item') {
          method = AGENT_KNOWLEDGE_METHODS.itemGet;
          const id = readString(args.id);
          if (!id) return toolFailure('id is required for Agent Knowledge item lookup.');
          const route = `/api/goodvibes-agent/knowledge/items/${encodeURIComponent(id)}`;
          const data = await getAgentKnowledgeJson(connection, route);
          return validatedToolOutput(data, connection, { ...method, route }, (validatedData) => formatItem(validatedData, id));
        }
        if (args.action === 'map') {
          method = AGENT_KNOWLEDGE_METHODS.map;
          const data = await getAgentKnowledgeJson(connection, method.route, {
            limit: readLimit(args.limit, 50, 500),
            query: readString(args.query),
          });
          return validatedToolOutput(data, connection, method, formatMap);
        }
        if (args.action === 'connectors') {
          method = AGENT_KNOWLEDGE_METHODS.connectorsList;
          const data = await getAgentKnowledgeJson(connection, method.route);
          return validatedToolOutput(data, connection, method, formatConnectors);
        }
        if (args.action === 'connector' || args.action === 'connector_doctor') {
          method = args.action === 'connector'
            ? AGENT_KNOWLEDGE_METHODS.connectorGet
            : AGENT_KNOWLEDGE_METHODS.connectorDoctor;
          const connectorId = readString(args.connectorId) || readString(args.id);
          if (!connectorId) return toolFailure('connectorId or id is required for Agent Knowledge connector lookup.');
          const suffix = args.action === 'connector_doctor' ? '/doctor' : '';
          const route = `/api/goodvibes-agent/knowledge/connectors/${encodeURIComponent(connectorId)}${suffix}`;
          const data = await getAgentKnowledgeJson(connection, route);
          return validatedToolOutput(data, connection, { ...method, route }, (validatedData) => (
            args.action === 'connector'
              ? formatConnector(validatedData, connectorId)
              : formatConnectorDoctor(validatedData, connectorId)
          ));
        }
        return toolFailure(`Unknown Agent Knowledge action. Valid values ${ACTIONS.join(', ')}.`);
      } catch (error) {
        return classifyToolKnowledgeError(error, connection, method);
      }
    },
  };
}

export function registerAgentKnowledgeTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentKnowledgeConnectionRuntime['configManager'],
): void {
  registry.register(createAgentKnowledgeTool(shellPaths, configManager));
}
