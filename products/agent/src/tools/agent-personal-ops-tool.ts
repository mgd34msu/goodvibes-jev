import { createPersonalOpsInputProjector } from './agent-personal-ops-ingress.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentPersonalOpsAction = 'briefing' | 'status' | 'queue' | 'intake' | 'lane' | 'read';

interface AgentPersonalOpsToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly laneId?: unknown;
  readonly recordId?: unknown;
  readonly query?: unknown;
  readonly target?: unknown;
  readonly fields?: unknown;
  readonly saveReviewCards?: unknown;
  readonly saveReview?: unknown;
  readonly artifactTitle?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentPersonalOpsToolDeps {
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

function normalizePersonalOpsAction(value: unknown): AgentPersonalOpsAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'briefing' || action === 'brief' || action === 'daily' || action === 'daily_brief' || action === 'morning') return 'briefing';
  if (action === 'status' || action === 'summary' || action === 'overview' || action === 'map' || action === 'list') return 'status';
  if (action === 'queue' || action === 'queues' || action === 'review_queue' || action === 'review_queues' || action === 'personal_queue' || action === 'ops_queue') return 'queue';
  if (action === 'intake' || action === 'request' || action === 'route' || action === 'plan' || action === 'triage' || action === 'draft') return 'intake';
  if (action === 'lane' || action === 'inspect' || action === 'show') return 'lane';
  if (action === 'read' || action === 'run' || action === 'execute' || action === 'fresh_read' || action === 'refresh') return 'read';
  return null;
}

function readAction(args: AgentPersonalOpsToolArgs): AgentPersonalOpsAction {
  const explicit = normalizePersonalOpsAction(args.action) ?? normalizePersonalOpsAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.recordId)) return 'read';
  if (readString(args.laneId)) return 'lane';
  if (readString(args.query) || readString(args.target)) return 'intake';
  return 'briefing';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function readFields(args: AgentPersonalOpsToolArgs): Record<string, unknown> | undefined {
  const fields = args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
    ? { ...(args.fields as Record<string, unknown>) }
    : {};
  if (args.saveReviewCards !== undefined) fields.saveReviewCards = args.saveReviewCards;
  if (args.saveReview !== undefined) fields.saveReview = args.saveReview;
  const artifactTitle = readString(args.artifactTitle);
  if (artifactTitle) fields.artifactTitle = artifactTitle;
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function briefingArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'personal_ops_briefing',
    query: args.query,
    target: args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function statusArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'personal_ops',
    includeParameters: args.includeParameters,
  });
}

function intakeArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'personal_ops_intake',
    query: args.query,
    target: args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function queueArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'personal_ops_queue',
    query: args.query,
    target: args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function laneArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'personal_ops_lane',
    laneId: args.laneId,
    target: args.target,
    query: args.query,
    includeParameters: args.includeParameters,
  });
}

function readArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'run_personal_ops_read',
    laneId: args.laneId,
    recordId: args.recordId,
    target: args.target,
    query: args.query,
    fields: readFields(args),
    includeParameters: args.includeParameters,
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

export function createAgentPersonalOpsTool(deps: AgentPersonalOpsToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'personal_ops',
      description: 'Plan and run safe Personal Ops workflows.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['briefing', 'status', 'queue', 'intake', 'lane', 'read'],
            description: 'Discovery actions are read-only; read needs confirmation.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          laneId: { type: 'string', enum: ['inbox', 'calendar', 'notes', 'tasks', 'reminders', 'routines', 'delivery'], description: 'Personal Ops lane id.' },
          recordId: { type: 'string', description: 'Selected inbox/calendar read operation record id.' },
          query: { type: 'string', description: 'Personal operations request or lane lookup text.' },
          target: { type: 'string', description: 'Alias for query or lookup target.' },
          fields: { type: 'object', additionalProperties: true, description: 'Connector input fields for action:read.' },
          saveReviewCards: { type: 'boolean', description: 'For action:read, save redacted review cards as a local artifact.' },
          saveReview: { type: 'boolean', description: 'Alias for saveReviewCards.' },
          artifactTitle: { type: 'string', description: 'Optional title for a saved read-review artifact.' },
          includeParameters: { type: 'boolean', description: 'Include bounded operation schema and route detail where supported.' },
          limit: { type: 'number', description: 'Maximum briefing or intake rows.' },
          confirm: { type: 'boolean', description: 'Required true for action:read.' },
          explicitUserRequest: { type: 'string', description: 'User request authorizing action:read.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown, options) => {
      options?.signal?.throwIfAborted();
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentPersonalOpsToolArgs;
      const action = readAction(args);

      if (action === 'briefing') return harnessTool.execute(briefingArgs(args), options);
      if (action === 'status') return harnessTool.execute(statusArgs(args), options);
      if (action === 'queue') return harnessTool.execute(queueArgs(args), options);
      if (action === 'intake') return harnessTool.execute(intakeArgs(args), options);
      if (action === 'lane') return harnessTool.execute(laneArgs(args), options);
      if (action === 'read') return harnessTool.execute(readArgs(args), options);

      return error('Unknown Personal Ops action. Use action:"briefing" for the user-first daily plan.');
    },
  };
}

export function registerAgentPersonalOpsTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('personal_ops')) registry.register(createAgentPersonalOpsTool({ commandRegistry, commandContext, toolRegistry: registry }), { inputProjection: createPersonalOpsInputProjector(registry, undefined, (args) => ['queue', 'intake', 'lane', 'read'].includes(readAction(args))) });
}
