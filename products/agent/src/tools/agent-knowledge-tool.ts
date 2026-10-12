import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { assertCurrentToolInvocation, assertProjectionExecution, ToolInputProjectionError, type ToolRegistry, type ToolInputProjector } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureOperatorConnection } from '../agent/operator-connection-owner.ts';
import { captureCatalogMethods, captureCatalogSnapshot } from './agent-harness-catalog-ranking.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  createAgentSdk,
  classifyKnowledgeError,
  getAgentKnowledgeJson,
  resolveConnectedHostConnection,
  validateAgentKnowledgeData,
  type AgentKnowledgeFailure,
  type AgentKnowledgeConnectionRuntime,
  type AgentKnowledgeRequestOptions,
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
  return typeof value === 'string' && ACTIONS.some(action => action === value);
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
  return value === 'concise' || value === 'standard' || value === 'detailed' ? value : 'standard';
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
  options: AgentKnowledgeRequestOptions,
): Promise<{ readonly success: false; readonly error: string }> {
  return toolFailure(formatKnowledgeFailure(await classifyKnowledgeError(error, connection, method.route, options)));
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

interface AgentKnowledgeCapture {
  readonly shellPaths: ShellPathService;
  readonly configManager: AgentKnowledgeConnectionRuntime['configManager'];
  readonly connection: ReturnType<typeof captureOperatorConnection>;
  readonly assertCurrent: () => void;
}
const knowledgeCaptures = new WeakMap<object, AgentKnowledgeCapture>();

/** Hold the native host, credentials, request, and route descriptors before admission. */
export function createAgentKnowledgeInputProjector(shellPaths: ShellPathService,
  configManager: AgentKnowledgeConnectionRuntime['configManager']): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent(); request.signal?.throwIfAborted();
    const input = captureCatalogSnapshot(request.args);
    const pathsCurrent = captureCatalogMethods(shellPaths, ['homeDirectory']);
    const methodsCurrent = captureCatalogMethods(AGENT_KNOWLEDGE_METHODS, Object.keys(AGENT_KNOWLEDGE_METHODS));
    const methods = captureCatalogSnapshot(AGENT_KNOWLEDGE_METHODS);
    let released = false;
    const assertSelection = () => {
      if (released) throw new ToolInputProjectionError('released');
      request.assertCurrent(); request.signal?.throwIfAborted(); pathsCurrent(); methodsCurrent();
      input.assertCurrent(request.args); methods.assertCurrent(AGENT_KNOWLEDGE_METHODS);
    };
    const connection = captureOperatorConnection(shellPaths, configManager, assertSelection);
    const assertCurrent = () => { assertSelection(); connection.assertCurrent(); assertSelection(); };
    assertCurrent();
    const context = Object.freeze({});
    knowledgeCaptures.set(context, { shellPaths, configManager, connection, assertCurrent });
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent, resultPublication: 'read-only',
      assertRepairedArgs(args) { input.assertCurrent(args); assertCurrent(); },
      async release() { released = true; knowledgeCaptures.delete(context); },
    };
  } };
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
    execute: async (rawArgs, options) => {
      try {
        const optionsCurrent = options && captureCatalogMethods(options, ['signal', 'assertCurrent', 'inputProjectionContext']);
        const input = captureCatalogSnapshot(rawArgs), args = input.captured;
        const methodsCurrent = captureCatalogMethods(AGENT_KNOWLEDGE_METHODS, Object.keys(AGENT_KNOWLEDGE_METHODS));
        const methods = captureCatalogSnapshot(AGENT_KNOWLEDGE_METHODS);
        const context = options?.inputProjectionContext, captured = context && knowledgeCaptures.get(context);
        const assertInvocation = () => {
          optionsCurrent?.(); options?.signal?.throwIfAborted(); assertCurrentToolInvocation(rawArgs, options);
          input.assertCurrent(rawArgs); methodsCurrent(); methods.assertCurrent(AGENT_KNOWLEDGE_METHODS);
          if (context) {
            if (!captured || captured.shellPaths !== shellPaths || captured.configManager !== configManager) throw new ToolInputProjectionError('held');
            assertProjectionExecution(context, rawArgs); captured.assertCurrent();
          }
          optionsCurrent?.();
        };
        assertInvocation();
        const connection = captured ? captured.connection : captureOperatorConnection(shellPaths, configManager, assertInvocation);
        const assertCurrent = () => { assertInvocation(); connection.assertCurrent(); assertInvocation(); };
        const restrictions = { signal: options?.signal, assertCurrent };
        assertCurrent();
        const run = async () => {
          if (!isAction(args.action)) return toolFailure(`Unknown Agent Knowledge action. Valid values ${ACTIONS.join(', ')}.`);
          if (!connection.token) {
            return toolFailure(formatKnowledgeFailure({ ok: false, kind: 'auth_required',
              error: `No connected-host operator token found at ${connection.tokenPath}`,
              baseUrl: connection.baseUrl, route: '/api/goodvibes-agent/knowledge/*' }));
          }
          let method: ConnectedHostCallMethod = AGENT_KNOWLEDGE_METHODS.status;
          try {
            const sdk = createAgentSdk(connection, restrictions);
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
              const data = await getAgentKnowledgeJson(connection, method.route, { limit }, restrictions);
              return validatedToolOutput(data, connection, method, (validatedData) => formatEntityList(validatedData, kind, limit));
            }
            if (args.action === 'item') {
              method = AGENT_KNOWLEDGE_METHODS.itemGet;
              const id = readString(args.id);
              if (!id) return toolFailure('id is required for Agent Knowledge item lookup.');
              const route = `/api/goodvibes-agent/knowledge/items/${encodeURIComponent(id)}`;
              const data = await getAgentKnowledgeJson(connection, route, {}, restrictions);
              return validatedToolOutput(data, connection, { ...method, route }, (validatedData) => formatItem(validatedData, id));
            }
            if (args.action === 'map') {
              method = AGENT_KNOWLEDGE_METHODS.map;
              const data = await getAgentKnowledgeJson(connection, method.route, {
                limit: readLimit(args.limit, 50, 500),
                query: readString(args.query),
              }, restrictions);
              return validatedToolOutput(data, connection, method, formatMap);
            }
            if (args.action === 'connectors') {
              method = AGENT_KNOWLEDGE_METHODS.connectorsList;
              const data = await getAgentKnowledgeJson(connection, method.route, {}, restrictions);
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
              const data = await getAgentKnowledgeJson(connection, route, {}, restrictions);
              return validatedToolOutput(data, connection, { ...method, route }, (validatedData) => (
                args.action === 'connector'
                  ? formatConnector(validatedData, connectorId)
                  : formatConnectorDoctor(validatedData, connectorId)
              ));
            }
            return toolFailure(`Unknown Agent Knowledge action. Valid values ${ACTIONS.join(', ')}.`);
          } catch (error) {
            return classifyToolKnowledgeError(error, connection, method, restrictions);
          }
        };
        const result = await run();
        assertCurrent();
        return result;
      } catch {
        return toolFailure('Agent Knowledge operation held: original caller, source, or connection is unavailable.');
      }
    },
  };
}

export function registerAgentKnowledgeTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentKnowledgeConnectionRuntime['configManager'],
): void {
  registry.register(createAgentKnowledgeTool(shellPaths, configManager), {
    inputProjection: createAgentKnowledgeInputProjector(shellPaths, configManager),
  });
}
