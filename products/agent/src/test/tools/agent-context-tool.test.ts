import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentContextTool, registerAgentContextTool } from '../../tools/agent-context-tool.ts';

function fakeHarnessTool(calls: Record<string, unknown>[]): Tool {
  return {
    definition: {
      name: 'agent_harness',
      description: 'Fake harness tool',
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, output: JSON.stringify({ args }) };
    },
  };
}

function makeTool(calls: Record<string, unknown>[] = []): Tool {
  return createAgentContextTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeHarnessTool(calls),
  });
}

describe('context adapter', () => {
  test('routes default status and prompt aliases through prompt context', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({});
    await tool.execute({ action: 'prompt_context', includeParameters: true, limit: 2 });

    expect(calls).toEqual([
      { mode: 'prompt_context' },
      { mode: 'prompt_context', includeParameters: true, limit: 2 },
    ]);
  });

  test('routes project context files and one-file inspection', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'files', target: 'src/main.ts', query: 'agents', includeParameters: true });
    await tool.execute({ contextFileId: 'project-agents-md' });
    await tool.execute({ action: 'project_context_file', query: 'cursor rules', includeParameters: false });

    expect(calls).toEqual([
      { mode: 'project_context', target: 'src/main.ts', query: 'agents', includeParameters: true },
      { mode: 'project_context_file', contextFileId: 'project-agents-md' },
      { mode: 'project_context_file', query: 'cursor rules', includeParameters: false },
    ]);
  });

  test('routes receipt filters without exposing raw prompt bodies by default', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ receiptId: 'promptctx-abc', limit: 1 });
    await tool.execute({ action: 'receipts', outcomeStatus: 'error', includeParameters: false });

    expect(calls).toEqual([
      { mode: 'prompt_context', receiptId: 'promptctx-abc', limit: 1, includeParameters: true },
      { mode: 'prompt_context', outcomeStatus: 'error', includeParameters: false },
    ]);
  });

  test('registers the direct context adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentContextTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);
    registerAgentContextTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);

    expect(registry.has('context')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'context')).toHaveLength(1);
  });
});
