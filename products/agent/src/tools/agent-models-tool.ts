import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { captureModelReadingInput } from './agent-harness-model-reading-source.ts';
import { createHarnessCatalogInputProjector, protectHarnessCatalogTool, forwardHarnessCatalogCall } from './agent-harness-catalog-ingress.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentModelsAction =
  | 'status'
  | 'route'
  | 'local'
  | 'providers'
  | 'provider'
  | 'smoke';

interface AgentModelsToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly modelRouteId?: unknown;
  readonly routeId?: unknown;
  readonly providerId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly timeoutMs?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentModelsToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeModelsAction(value: unknown): AgentModelsAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'routing' || action === 'routes' || action === 'models' || action === 'model' || action === 'readiness' || action === 'route_readiness') return 'status';
  if (action === 'route' || action === 'model_route' || action === 'inspect' || action === 'show' || action === 'candidate' || action === 'endpoint') return 'route';
  if (action === 'local' || action === 'cookbook' || action === 'local_cookbook' || action === 'recipes' || action === 'recipe' || action === 'ollama' || action === 'llama_cpp' || action === 'llamacpp' || action === 'vllm' || action === 'local_servers') return 'local';
  if (action === 'providers' || action === 'provider_accounts' || action === 'accounts' || action === 'subscriptions' || action === 'auth' || action === 'logins') return 'providers';
  if (action === 'provider' || action === 'provider_account' || action === 'account' || action === 'subscription' || action === 'auth_status') return 'provider';
  if (action === 'smoke' || action === 'local_smoke' || action === 'check_local' || action === 'check_servers' || action === 'server_health' || action === 'local_server_health' || action === 'run_local_model_smoke') return 'smoke';
  return null;
}

function readAction(args: AgentModelsToolArgs): AgentModelsAction {
  const explicit = normalizeModelsAction(args.action) ?? normalizeModelsAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.providerId)) return 'provider';
  if (readString(args.modelRouteId) || readString(args.routeId)) return 'route';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function routeLookup(args: AgentModelsToolArgs): string {
  return readString(args.modelRouteId)
    || readString(args.routeId)
    || readString(args.id);
}

function providerLookup(args: AgentModelsToolArgs): string {
  return readString(args.providerId)
    || readString(args.id);
}

function confirmedArgs(args: AgentModelsToolArgs): Record<string, unknown> {
  return compactArgs({
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

function statusArgs(args: AgentModelsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'model_routing',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function routeArgs(args: AgentModelsToolArgs): Record<string, unknown> {
  const modelRouteId = routeLookup(args);
  return compactArgs({
    mode: 'model_route',
    modelRouteId,
    target: modelRouteId ? undefined : args.target,
    query: modelRouteId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

function localArgs(args: AgentModelsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'model_routing',
    query: args.query ?? args.target ?? 'local',
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function providersArgs(args: AgentModelsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'provider_accounts',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function providerArgs(args: AgentModelsToolArgs): Record<string, unknown> {
  const providerId = providerLookup(args);
  return compactArgs({
    mode: 'provider_account',
    providerId,
    target: providerId ? undefined : args.target,
    query: providerId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

function smokeArgs(args: AgentModelsToolArgs): Record<string, unknown> {
  const modelRouteId = routeLookup(args);
  return compactArgs({
    mode: 'run_local_model_smoke',
    modelRouteId,
    target: modelRouteId ? undefined : args.target,
    query: modelRouteId ? undefined : args.query,
    limit: args.limit,
    timeoutMs: args.timeoutMs,
    ...confirmedArgs(args),
  });
}

export function createAgentModelsTool(deps: AgentModelsToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  const tool: Tool = {
    definition: {
      name: 'models',
      description: 'Inspect model routes, providers, cookbook, and checks.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'route', 'local', 'providers', 'provider', 'smoke'],
            description: 'Read model/provider posture; confirm local server smoke checks.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Model route or provider id alias.' },
          modelRouteId: { type: 'string', description: 'Model route, local endpoint, or cookbook route id.' },
          routeId: { type: 'string', description: 'Model route id alias.' },
          providerId: { type: 'string', description: 'Provider account id.' },
          target: { type: 'string', description: 'Lookup target.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include detailed route contracts.' },
          limit: { type: 'number', description: 'Maximum rows.' },
          timeoutMs: { type: 'number', description: 'Optional timeout for local model smoke checks.' },
          confirm: { type: 'boolean', description: 'Required true for local server smoke checks.' },
          explicitUserRequest: { type: 'string', description: 'User request authorizing confirmed local server checks.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs, options) => {
      const args = captureModelReadingInput(rawArgs) as AgentModelsToolArgs;
      const forward = (translated: Record<string, unknown>) => forwardHarnessCatalogCall(harnessTool, rawArgs, translated, options);
      const action = readAction(args);

      if (action === 'status') return forward(statusArgs(args));
      if (action === 'route') return forward(routeArgs(args));
      if (action === 'local') return forward(localArgs(args));
      if (action === 'providers') return forward(providersArgs(args));
      if (action === 'provider') return forward(providerArgs(args));
      if (action === 'smoke') return forward(smokeArgs(args));

      return error('Unknown models action. Use action:"status" for model routing readiness.');
    },
  };
  return protectHarnessCatalogTool(tool, deps.toolRegistry, isModelsReadinessCall, deps.commandContext);
}

export function isModelsReadinessCall(input: Record<string, unknown>): boolean {
  const args = captureModelReadingInput(input) as AgentModelsToolArgs;
  const action = readAction(args);
  return action === 'status' || action === 'route' || action === 'local';
}

export function registerAgentModelsTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('models')) registry.register(createAgentModelsTool({ commandRegistry, commandContext, toolRegistry: registry }), { inputProjection: createHarnessCatalogInputProjector(registry, undefined, isModelsReadinessCall, commandContext) });
}
