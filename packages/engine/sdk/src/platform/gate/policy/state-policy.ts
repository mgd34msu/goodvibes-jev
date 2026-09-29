/**
 * The state tool's declared read-only surface: which of its modes and actions
 * only read. Code, because the state tool defines its own modes (tools/state),
 * and whether a mode writes is a fact of that definition, not a reading of a
 * call. The Agent's main-conversation guard refuses the rest
 * (tool-policy-guard.ts), and the permission manager gives a state call that
 * writes (a value, a memory, a hook registration, a mode change, a record)
 * the gate's full reading instead of the known-read-only shortcut.
 */
import type { StateToolArgs } from './tool-policy-guard-types.js';

export const READ_ONLY_STATE_TOOL_MODES = ['get', 'list', 'budget', 'context', 'memory', 'telemetry', 'hooks', 'mode', 'analytics'] as const;
export const READ_ONLY_STATE_MEMORY_ACTIONS = ['list', 'get'] as const;
export const READ_ONLY_STATE_HOOK_ACTIONS = ['list'] as const;
export const READ_ONLY_STATE_MODE_ACTIONS = ['get', 'list'] as const;
export const READ_ONLY_STATE_ANALYTICS_ACTIONS = ['summary', 'query', 'dashboard'] as const;
const READ_ONLY_STATE_TOOL_MODE_SET = new Set<string>(READ_ONLY_STATE_TOOL_MODES);
const READ_ONLY_STATE_MEMORY_ACTION_SET = new Set<string>(READ_ONLY_STATE_MEMORY_ACTIONS);
const READ_ONLY_STATE_HOOK_ACTION_SET = new Set<string>(READ_ONLY_STATE_HOOK_ACTIONS);
const READ_ONLY_STATE_MODE_ACTION_SET = new Set<string>(READ_ONLY_STATE_MODE_ACTIONS);
const READ_ONLY_STATE_ANALYTICS_ACTION_SET = new Set<string>(READ_ONLY_STATE_ANALYTICS_ACTIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** Whether a state tool call writes anything (it falls outside the declared read-only surface). */
export function isStateMutation(args: StateToolArgs): boolean {
  if (isPresent(args.values) || isPresent(args.clearKeys)) return true;
  if (typeof args.mode === 'string' && !READ_ONLY_STATE_TOOL_MODE_SET.has(args.mode)) return true;

  if (args.mode === 'memory') {
    const action = typeof args.memoryAction === 'string' ? args.memoryAction : 'list';
    if (!READ_ONLY_STATE_MEMORY_ACTION_SET.has(action) || isPresent(args.memoryValue)) return true;
  }

  if (args.mode === 'hooks') {
    const action = typeof args.hookAction === 'string' ? args.hookAction : 'list';
    if (!READ_ONLY_STATE_HOOK_ACTION_SET.has(action) || isPresent(args.hookDefinition)) return true;
  }

  if (args.mode === 'mode') {
    const action = typeof args.modeAction === 'string' ? args.modeAction : 'get';
    if (!READ_ONLY_STATE_MODE_ACTION_SET.has(action) || isPresent(args.modeName)) return true;
  }

  if (args.mode === 'analytics') {
    const action = typeof args.analyticsAction === 'string' ? args.analyticsAction : 'summary';
    if (!READ_ONLY_STATE_ANALYTICS_ACTION_SET.has(action)) return true;
    if (
      isPresent(args.analyticsTool)
      || isPresent(args.analyticsArgs)
      || isPresent(args.analyticsResult)
      || isPresent(args.analyticsDuration)
      || isPresent(args.analyticsTokens)
      || isPresent(args.analyticsFormat)
    ) {
      return true;
    }
  }

  return false;
}
