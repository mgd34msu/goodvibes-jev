import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentHostAction =
  | 'status'
  | 'capabilities'
  | 'capability'
  | 'services'
  | 'service'
  | 'methods'
  | 'method';

interface AgentHostToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly capabilityId?: unknown;
  readonly endpointId?: unknown;
  readonly methodId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface AgentHostToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeHostAction(value: unknown): AgentHostAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'health' || action === 'readiness' || action === 'daemon_status' || action === 'connected_host_status') return 'status';
  if (action === 'capabilities' || action === 'capability_map' || action === 'map' || action === 'inventory' || action === 'connected_host' || action === 'daemon' || action === 'host' || action === 'boundaries') return 'capabilities';
  if (action === 'capability' || action === 'show_capability' || action === 'inspect_capability' || action === 'connected_host_capability') return 'capability';
  if (action === 'services' || action === 'service_posture' || action === 'service_status' || action === 'endpoints' || action === 'endpoint_list') return 'services';
  if (action === 'service' || action === 'endpoint' || action === 'service_endpoint') return 'service';
  if (action === 'methods' || action === 'operator_methods' || action === 'operator_contract' || action === 'operations' || action === 'actions') return 'methods';
  if (action === 'method' || action === 'operator_method' || action === 'operation') return 'method';
  return null;
}

function readAction(args: AgentHostToolArgs): AgentHostAction {
  const explicit = normalizeHostAction(args.action) ?? normalizeHostAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.methodId)) return 'method';
  if (readString(args.endpointId)) return 'service';
  if (readString(args.capabilityId) || readString(args.target) || readString(args.query)) return 'capability';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

export function createAgentHostTool(deps: AgentHostToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'host',
      description: 'Inspect GoodVibes host status, services, and methods.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'capabilities', 'capability', 'services', 'service', 'methods', 'method'],
            description: 'Read host status, capabilities, services, and method posture.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          capabilityId: { type: 'string', description: 'Connected-host capability id.' },
          endpointId: { type: 'string', description: 'Service endpoint id.' },
          methodId: { type: 'string', description: 'Daemon operator method id.' },
          target: { type: 'string', description: 'Lookup target for a capability, endpoint, or method.' },
          query: { type: 'string', description: 'Search text for capabilities or methods.' },
          includeParameters: { type: 'boolean', description: 'Include detailed method schemas, route families, probes, or diagnostics.' },
          limit: { type: 'number', description: 'Maximum methods to return for action:methods.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentHostToolArgs;
      const action = readAction(args);

      if (action === 'status') {
        return harnessTool.execute(compactArgs({
          mode: 'connected_host_status',
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'capabilities') {
        return harnessTool.execute(compactArgs({
          mode: 'connected_host',
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'capability') {
        return harnessTool.execute(compactArgs({
          mode: 'connected_host_capability',
          capabilityId: args.capabilityId,
          target: args.target,
          query: args.query,
        }));
      }
      if (action === 'services') {
        return harnessTool.execute(compactArgs({
          mode: 'service_posture',
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'service') {
        return harnessTool.execute(compactArgs({
          mode: 'service_endpoint',
          endpointId: args.endpointId,
          target: args.target,
          query: args.query,
        }));
      }
      if (action === 'methods') {
        return harnessTool.execute(compactArgs({
          mode: 'operator_methods',
          query: args.query ?? args.target,
          includeParameters: args.includeParameters,
          limit: args.limit,
        }));
      }
      return harnessTool.execute(compactArgs({
        mode: 'operator_method',
        methodId: args.methodId,
        target: args.target,
        query: args.query,
      }));
    },
  };
}

export function registerAgentHostTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('host')) registry.register(createAgentHostTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
