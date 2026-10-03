import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentMemoryTool, registerAgentMemoryTool } from '../../tools/agent-memory-tool.ts';

function fakeTool(name: string, calls: Record<string, unknown>[]): Tool {
  return {
    definition: {
      name,
      description: `Fake ${name}`,
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, output: JSON.stringify({ args }) };
    },
  };
}

function makeTool(
  harnessCalls: Record<string, unknown>[] = [],
  localCalls: Record<string, unknown>[] = [],
): Tool {
  return createAgentMemoryTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeTool('agent_harness', harnessCalls),
    localRegistryTool: fakeTool('agent_local_registry', localCalls),
  });
}

describe('memory adapter', () => {
  test('routes posture provider curator and candidate inspection', async () => {
    const harnessCalls: Record<string, unknown>[] = [];
    const tool = makeTool(harnessCalls);

    await tool.execute({});
    await tool.execute({ action: 'provider', providerId: 'mem0', includeParameters: true });
    await tool.execute({ action: 'refinement', query: 'knowledge gaps', includeParameters: true });
    await tool.execute({ action: 'run_refinement', knowledgeSpaceId: 'agent', gapIds: ['gap-1'], limit: 2, maxRunMs: 5_000, force: true, confirm: true, explicitUserRequest: 'Run semantic refinement.' });
    await tool.execute({ action: 'queue', query: 'consolidation', limit: 4 });
    await tool.execute({ candidateId: 'learn-1' });

    expect(harnessCalls).toEqual([
      { mode: 'memory_posture' },
      { mode: 'memory_provider', providerId: 'mem0', includeParameters: true },
      { mode: 'memory_refinement', query: 'knowledge gaps', includeParameters: true },
      { mode: 'run_memory_refinement', knowledgeSpaceId: 'agent', gapIds: ['gap-1'], limit: 2, maxRunMs: 5_000, force: true, confirm: true, explicitUserRequest: 'Run semantic refinement.' },
      { mode: 'learning_curator', query: 'consolidation', limit: 4 },
      { mode: 'learning_candidate', candidateId: 'learn-1' },
    ]);
  });

  test('routes local memory record reads and writes through the local registry', async () => {
    const localCalls: Record<string, unknown>[] = [];
    const tool = makeTool([], localCalls);

    await tool.execute({ action: 'list' });
    await tool.execute({ query: 'routing decisions' });
    await tool.execute({ recordId: 'mem-1' });
    await tool.execute({ action: 'remember', summary: 'Use the release checklist', detail: 'Run the full suite before commits.', tags: ['release'] });
    await tool.execute({ action: 'forget', id: 'mem-2', confirm: true, explicitUserRequest: 'Forget mem-2.' });

    expect(localCalls).toEqual([
      { domain: 'memory', action: 'list' },
      { domain: 'memory', action: 'search', query: 'routing decisions' },
      { domain: 'memory', action: 'get', id: 'mem-1' },
      { domain: 'memory', action: 'create', summary: 'Use the release checklist', detail: 'Run the full suite before commits.', tags: ['release'] },
      { domain: 'memory', action: 'delete', id: 'mem-2', confirm: true, explicitUserRequest: 'Forget mem-2.' },
    ]);
  });

  test('reports unavailable local registry without hiding posture routes', async () => {
    const tool = createAgentMemoryTool({
      commandRegistry: {} as CommandRegistry,
      commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext,
      toolRegistry: new ToolRegistry(),
      harnessTool: fakeTool('agent_harness', []),
    });

    const result = await tool.execute({ action: 'list' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Agent-local memory registry is unavailable');
  });

  test('registers the direct memory adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentMemoryTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);
    registerAgentMemoryTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);

    expect(registry.has('memory')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'memory')).toHaveLength(1);
  });
});
