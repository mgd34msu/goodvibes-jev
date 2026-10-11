/**
 * The `route` tool: the agent's route adapter, backed by the Jev task route
 * planner. The definition, the action aliases and the status output are the
 * agent's; planning needs an installed judgment port and a protected source owner.
 */
import type { ToolRegistry } from '../../tools/registry.js';
import type { Tool } from '../../types/tools.js';
import { planTaskRoute } from './planner.js';
import type { TaskRouteDeps, TaskRouteReadOptions } from './types.js';
import { captureStrictJudgmentJson } from '../../gate/judgment-result.js';
import { isDeepStrictEqual } from 'node:util';
import { ToolInputProjectionError } from '../../tools/input-projection.js';

type TaskRouteAction = 'plan' | 'status';

interface TaskRouteToolArgs extends Readonly<Record<string, unknown>> {
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

/** The action a word names: fixed aliases, compared after lower-casing and hyphens to underscores. */
export function normalizeRouteAction(value: unknown): TaskRouteAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'plan' || action === 'route' || action === 'decide' || action === 'decision' || action === 'task' || action === 'intake') return 'plan';
  if (action === 'status' || action === 'summary' || action === 'help' || action === 'usage') return 'status';
  return null;
}

function readAction(args: TaskRouteToolArgs): TaskRouteAction {
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

function sameBindings(value: object, original: Record<string, PropertyDescriptor>): boolean {
  const fields = Object.getOwnPropertyDescriptors(value);
  return Object.getOwnPropertySymbols(value).length === 0 && Object.keys(fields).length === Object.keys(original).length
    && Object.entries(original).every(([key, field]) => {
      const current = fields[key];
      return current !== undefined && 'value' in current && Object.is(current.value, field.value)
        && current.enumerable === field.enumerable && current.configurable === field.configurable && current.writable === field.writable;
    });
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

export function createTaskRouteTool(deps: TaskRouteDeps = {}, options: TaskRouteReadOptions = {}): Tool {
  return {
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
    execute: async (rawArgs, opts) => {
      // The registry passes an object, but a model's arguments can arrive as anything.
      const args: TaskRouteToolArgs = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? captureStrictJudgmentJson(rawArgs) : {};
      const action = readAction(args);
      if (action === 'status') return output(status());
      const original = captureStrictJudgmentJson(args);
      const optionsFields = Object.getOwnPropertyDescriptors(options);
      const invocationFields = opts === undefined ? undefined : Object.getOwnPropertyDescriptors(opts);
      if (Object.getOwnPropertySymbols(options).length || Object.values(optionsFields).some(field => !('value' in field))
        || (opts !== undefined && (Object.getOwnPropertySymbols(opts).length || Object.values(invocationFields ?? {}).some(field => !('value' in field))))) throw new ToolInputProjectionError('invalid');
      const signal = options.signal && opts?.signal ? AbortSignal.any([options.signal, opts.signal]) : options.signal ?? opts?.signal;
      const callerCurrent = options.assertCurrent, invocationCurrent = opts?.assertCurrent;
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (!isDeepStrictEqual(captureStrictJudgmentJson(rawArgs), original)
          || !sameBindings(options, optionsFields)
          || (opts !== undefined && invocationFields !== undefined && !sameBindings(opts, invocationFields))) throw new ToolInputProjectionError('held');
        const first: unknown = callerCurrent?.(), second: unknown = invocationCurrent?.(original);
        if (first !== undefined || second !== undefined) {
          void Promise.resolve(first).catch(() => {}); void Promise.resolve(second).catch(() => {});
          throw new ToolInputProjectionError('held');
        }
        signal?.throwIfAborted();
        if (!isDeepStrictEqual(captureStrictJudgmentJson(rawArgs), original)
          || !sameBindings(options, optionsFields)
          || (opts !== undefined && invocationFields !== undefined && !sameBindings(opts, invocationFields))) throw new ToolInputProjectionError('held');
      };
      assertCurrent();
      let publicationCurrent = assertCurrent;
      const plan = await planTaskRoute(args, deps, { ...options, signal, assertCurrent, retainCurrent(guard, key) {
        publicationCurrent = guard; options.retainCurrent?.(guard, key);
      } });
      publicationCurrent();
      return output(plan);
    },
  };
}

/** Registers the route tool unless a tool named `route` is already registered. */
export function registerTaskRouteTool(registry: ToolRegistry, deps: TaskRouteDeps = {}, options: TaskRouteReadOptions = {}): void {
  if (!registry.has('route')) registry.register(createTaskRouteTool(deps, options));
}
