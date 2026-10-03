import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentExecutionAction =
  | 'status'
  | 'route'
  | 'history'
  | 'record'
  | 'processes'
  | 'process_capabilities'
  | 'process'
  | 'recovery';

interface AgentExecutionToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly routeId?: unknown;
  readonly executionRouteId?: unknown;
  readonly recordId?: unknown;
  readonly executionRecordId?: unknown;
  readonly processId?: unknown;
  readonly processSessionId?: unknown;
  readonly sessionId?: unknown;
  readonly session_id?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface AgentExecutionToolDeps {
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

function normalizeExecutionAction(value: unknown): AgentExecutionAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'overview' || action === 'routes' || action === 'posture' || action === 'execution_posture') return 'status';
  if (action === 'route' || action === 'show_route' || action === 'inspect_route' || action === 'execution_route') return 'route';
  if (action === 'history' || action === 'activity' || action === 'records' || action === 'execution_history') return 'history';
  if (action === 'record' || action === 'item' || action === 'show' || action === 'inspect' || action === 'execution_history_item') return 'record';
  if (action === 'processes' || action === 'background' || action === 'backgrounds' || action === 'background_processes') return 'processes';
  if (action === 'capabilities' || action === 'doctor' || action === 'parity' || action === 'process_capabilities' || action === 'process_doctor' || action === 'process_parity') return 'process_capabilities';
  if (action === 'process' || action === 'background_process') return 'process';
  if (action === 'recovery' || action === 'file_recovery' || action === 'undo_redo') return 'recovery';
  return null;
}

function readAction(args: AgentExecutionToolArgs): AgentExecutionAction | null {
  const explicit = readString(args.action) || readString(args.mode);
  if (explicit) return normalizeExecutionAction(explicit);
  const id = readString(args.id);
  if (readString(args.processId) || readString(args.processSessionId) || readString(args.sessionId) || readString(args.session_id)) return 'process';
  if (readString(args.executionRecordId) || readString(args.recordId)) return 'record';
  if (/^(bg|proc|process|session)[_-]/i.test(id)) return 'process';
  if (readString(args.executionRouteId) || readString(args.routeId) || id) return 'route';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function routeId(args: AgentExecutionToolArgs): string {
  return readString(args.executionRouteId) || readString(args.routeId) || readString(args.id);
}

function recordId(args: AgentExecutionToolArgs): string {
  return readString(args.executionRecordId) || readString(args.recordId) || readString(args.id);
}

function processLookup(args: AgentExecutionToolArgs): Record<string, unknown> {
  const id = readString(args.processId) || readString(args.processSessionId) || readString(args.sessionId) || readString(args.session_id) || readString(args.id);
  return compactArgs({
    processId: id,
    target: id ? undefined : args.target,
    query: id ? undefined : args.query,
  });
}

function statusArgs(args: AgentExecutionToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'execution_posture',
    query: args.query ?? args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function routeArgs(args: AgentExecutionToolArgs): Record<string, unknown> {
  const executionRouteId = routeId(args);
  return compactArgs({
    mode: 'execution_route',
    executionRouteId,
    target: executionRouteId ? undefined : args.target,
    query: executionRouteId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

function historyArgs(args: AgentExecutionToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'execution_history',
    query: args.query ?? args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function recordArgs(args: AgentExecutionToolArgs): Record<string, unknown> {
  const executionRecordId = recordId(args);
  return compactArgs({
    mode: 'execution_history_item',
    executionRecordId,
    target: executionRecordId ? undefined : args.target,
    query: executionRecordId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

function processesArgs(args: AgentExecutionToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'background_processes',
    query: args.query ?? args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function processCapabilitiesArgs(): Record<string, unknown> {
  return {
    mode: 'run_background_process',
    processAction: 'capabilities',
  };
}

function processArgs(args: AgentExecutionToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'background_process',
    ...processLookup(args),
    includeParameters: args.includeParameters,
  });
}

function recoveryArgs(args: AgentExecutionToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'file_recovery',
    includeParameters: args.includeParameters,
  });
}

export function createAgentExecutionTool(deps: AgentExecutionToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'execution',
      description: 'Inspect local work routes, history, and recovery.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'route', 'history', 'record', 'processes', 'process_capabilities', 'process', 'recovery', 'capabilities', 'doctor', 'parity'],
            description: 'Read-only execution posture, route, history, process, or recovery view.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Generic route, record, process, or session id.' },
          routeId: { type: 'string', description: 'Alias for executionRouteId.' },
          executionRouteId: { type: 'string', description: 'Execution route id.' },
          recordId: { type: 'string', description: 'Alias for executionRecordId.' },
          executionRecordId: { type: 'string', description: 'Execution history record id.' },
          processId: { type: 'string', description: 'Tracked local background process id.' },
          processSessionId: { type: 'string', description: 'Tracked process session id alias.' },
          sessionId: { type: 'string', description: 'Tracked process session id alias.' },
          session_id: { type: 'string', description: 'Tracked process session id alias.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include detailed route, evidence, and policy metadata.' },
          limit: { type: 'number', description: 'Maximum rows returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentExecutionToolArgs;
      const action = readAction(args);
      if (!action) return error('Unknown execution action. Use action:"status" for local route posture or action:"history" for recent work.');

      if (action === 'status') return harnessTool.execute(statusArgs(args));
      if (action === 'route') return harnessTool.execute(routeArgs(args));
      if (action === 'history') return harnessTool.execute(historyArgs(args));
      if (action === 'record') return harnessTool.execute(recordArgs(args));
      if (action === 'processes') return harnessTool.execute(processesArgs(args));
      if (action === 'process_capabilities') return harnessTool.execute(processCapabilitiesArgs());
      if (action === 'process') return harnessTool.execute(processArgs(args));
      if (action === 'recovery') return harnessTool.execute(recoveryArgs(args));

      return error('Unknown execution action. Use action:"status" for local route posture or action:"history" for recent work.');
    },
  };
}

export function registerAgentExecutionTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('execution')) registry.register(createAgentExecutionTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
