import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

const TOOL_SAFETY_MARKER = Symbol.for('goodvibes-agent.tool-execution-safety-wrapped');
const REGISTRY_SAFETY_MARKER = Symbol.for('goodvibes-agent.tool-registry-safety-installed');

type MarkedTool = Tool & { [TOOL_SAFETY_MARKER]?: true };
type MarkedRegistry = ToolRegistry & { [REGISTRY_SAFETY_MARKER]?: true };

export function installToolExecutionSafetyGuard(registry: ToolRegistry): void {
  const marked = registry as MarkedRegistry;
  if (marked[REGISTRY_SAFETY_MARKER]) return;
  marked[REGISTRY_SAFETY_MARKER] = true;

  for (const tool of registry.list()) wrapToolExecutionSafety(tool);

  const originalRegister = registry.register.bind(registry);
  registry.register = (tool: Tool, options): void => {
    wrapToolExecutionSafety(tool);
    originalRegister(tool, options);
  };
}

export function wrapToolExecutionSafety(tool: Tool): void {
  const marked = tool as MarkedTool;
  if (marked[TOOL_SAFETY_MARKER]) return;
  marked[TOOL_SAFETY_MARKER] = true;

  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    try {
      return await originalExecute(args, options);
    } catch (error) {
      return {
        success: false,
        error: summarizeError(error),
      };
    }
  };
}
