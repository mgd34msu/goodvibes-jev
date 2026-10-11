import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { planAgentTaskRoute, type AgentTaskRouteSources } from './agent-route-planner.ts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import { captureModelReadingInput } from './agent-harness-model-reading-source.ts';
import { createHarnessCatalogInputProjector, protectHarnessCatalogTool, harnessCatalogExecutionGuard, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';

type AgentRouteAction = 'plan' | 'status';

interface AgentRouteToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly query?: unknown;
  readonly target?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRouteAction(value: unknown): AgentRouteAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'plan' || action === 'route' || action === 'decide' || action === 'decision' || action === 'task' || action === 'intake') return 'plan';
  if (action === 'status' || action === 'summary' || action === 'help' || action === 'usage') return 'status';
  return null;
}

function readAction(args: AgentRouteToolArgs): AgentRouteAction {
  const explicit = normalizeRouteAction(args.action) ?? normalizeRouteAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.query) || readString(args.target)) return 'plan';
  return 'status';
}

function output(value: unknown): { readonly success: true; readonly output: string } {
  return {
    success: true,
    output: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  };
}

function status(): Record<string, unknown> {
  return {
    status: 'ready',
    usage: 'Use route action:"plan" query:"<user task>" before choosing a specialized GoodVibes Agent surface.',
    actions: ['plan', 'status'],
    examples: [
      'route action:"plan" query:"fix the failing tests"',
      'route action:"plan" query:"check daemon health"',
      'route action:"plan" query:"change the theme setting"',
      'route action:"plan" query:"remind me tomorrow to stretch"',
      'route action:"plan" query:"run pytest in background"',
      'route action:"plan" query:"run claude code with pty and sudo"',
      'route action:"plan" query:"undo the last file edit"',
      'route action:"plan" query:"show current permissions"',
      'route action:"plan" query:"why was that tool call blocked"',
      'route action:"plan" query:"export a support bundle"',
      'route action:"plan" query:"search saved sessions"',
      'route action:"plan" query:"show release readiness evidence"',
      'route action:"plan" query:"generate an image of a product dashboard"',
      'route action:"plan" query:"take a screenshot of the browser dashboard"',
      'route action:"plan" query:"triage my inbox and draft replies"',
      'route action:"plan" query:"run a weekly source-backed research report"',
    ],
    policy: 'Route is read-only. It selects visible user-first routes and missing fields but never runs tools, creates jobs, sends messages, changes settings, or opens UI surfaces.',
  };
}

export function createAgentRouteTool(commandContext: CommandContext, sources: AgentTaskRouteSources = {}, registry: ToolRegistry | undefined = commandContext.extensions?.toolRegistry): Tool {
  const tool: Tool = {
    definition: {
      name: 'route',
      description: 'Choose the best visible route for a user task.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['plan', 'status'],
            description: 'Plan a user-task route or show route-tool usage.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          query: { type: 'string', description: 'Plain user request to route.' },
          target: { type: 'string', description: 'Alias for query.' },
          includeParameters: { type: 'boolean', description: 'Include scoring and more catalog matches.' },
          limit: { type: 'number', description: 'Maximum candidate routes returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    execute: async (rawArgs, options) => {
      const args = captureModelReadingInput(rawArgs);
      const action = readAction(args);
      if (action === 'status') return output(status());
      return output(await planAgentTaskRoute(commandContext, args, sources, {
        signal: options?.signal, sourceOwner: agentResearchSourceOwner(registry),
        assertCurrent: harnessCatalogExecutionGuard(rawArgs, options), retainCurrent: retainHarnessCatalogCurrent(rawArgs),
      }));
    },
  };
  return registry ? protectHarnessCatalogTool(tool, registry, isRouteQuery, commandContext) : tool;
}

function isRouteQuery(input: Record<string, unknown>): boolean {
  const args = captureModelReadingInput(input);
  return readAction(args) === 'plan' && Boolean(readString(args.query) || readString(args.target));
}

export function registerAgentRouteTool(registry: ToolRegistry, commandContext: CommandContext, sources: AgentTaskRouteSources = {}): void {
  if (!registry.has('route')) registry.register(createAgentRouteTool(commandContext, sources, registry), { inputProjection: createHarnessCatalogInputProjector(registry, undefined, isRouteQuery, commandContext) });
}
