import type { HookExecutionOptions } from './execution.js';
import type { ToolLLM } from '../config/tool-llm.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { HookDefinition, HookEvent, HookResult } from './types.js';
import * as agentRunner from './runners/agent.js';
import * as commandRunner from './runners/command.js';
import * as httpRunner from './runners/http.js';
import * as promptRunner from './runners/prompt.js';
import * as tsRunner from './runners/typescript.js';

export type HookRunnerContext =
  | Pick<ToolLLM, 'chat'>
  | (Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'> & Partial<Pick<AgentManager, 'spawnOwned'>>)
  | string
  | null
  | undefined;

function hasAgentRunner(value: HookRunnerContext): value is Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'> & Partial<Pick<AgentManager, 'spawnOwned'>> {
  return typeof value === 'object'
    && value !== null
    && 'spawn' in value
    && 'getStatus' in value
    && 'cancel' in value;
}

function hasToolLlm(value: HookRunnerContext): value is Pick<ToolLLM, 'chat'> {
  return typeof value === 'object'
    && value !== null
    && 'chat' in value
    && typeof value.chat === 'function';
}

export async function run(
  hook: HookDefinition,
  event: HookEvent,
  context?: HookRunnerContext,
  execution?: HookExecutionOptions,
): Promise<HookResult> {
  switch (hook.type) {
    case 'command':
      return await commandRunner.run(hook, event, execution);
    case 'http':
      return await httpRunner.run(hook, event, execution);
    case 'prompt':
      return await promptRunner.run(hook, event, hasToolLlm(context) ? context : null, execution);
    case 'agent':
      if (!hasAgentRunner(context)) {
        return { ok: false, error: 'agent hook runner is not configured in this runtime', ...(execution === undefined ? {} : { code: 'OWNED_AGENT_EXECUTION_UNSUPPORTED' as const }) };
      }
      return await agentRunner.run(hook, event, context, execution);
    case 'ts':
      if (typeof context !== 'string' || context.length === 0) {
        return { ok: false, error: 'ts hook runner requires an explicit project root' };
      }
      return await tsRunner.run(hook, event, context, execution);
    default:
      return { ok: false, error: `unknown hook type: ${(hook as HookDefinition).type}` };
  }
}
