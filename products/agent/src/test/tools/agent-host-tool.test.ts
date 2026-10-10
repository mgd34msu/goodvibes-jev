import { afterAll, describe, expect, test } from 'bun:test';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentHostTool, registerAgentHostTool } from '../../tools/agent-host-tool.ts';

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

afterAll(cleanupResearchScreeningFixtures);

function makeTool(calls: Record<string, unknown>[] = []): Tool {
  const toolRegistry = new ToolRegistry();
  bindAgentResearchSourceOwner(toolRegistry, ordinaryResearchOwner());
  return createAgentHostTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {} } as CommandContext,
    toolRegistry,
    harnessTool: fakeHarnessTool(calls),
  });
}

describe('host adapter', () => {
  test('routes host and daemon status through the live connected-host status mode', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({});
    await tool.execute({ action: 'daemon_status', includeParameters: true });

    expect(calls).toEqual([
      { mode: 'connected_host_status' },
      { mode: 'connected_host_status', includeParameters: true },
    ]);
  });

  test('routes capability and service discovery through existing read-only harness modes', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'capabilities', includeParameters: true });
    await tool.execute({ capabilityId: 'agent-knowledge-read' });
    await tool.execute({ action: 'services' });
    await tool.execute({ action: 'service', endpointId: 'web' });

    expect(calls).toEqual([
      { mode: 'connected_host', includeParameters: true },
      { mode: 'connected_host_capability', capabilityId: 'agent-knowledge-read' },
      { mode: 'service_posture' },
      { mode: 'service_endpoint', endpointId: 'web' },
    ]);
  });

  test('routes operator method catalog and one-method inspection without invoking methods', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'methods', query: 'schedule', includeParameters: true, limit: 20 });
    await tool.execute({ methodId: 'services.status' });
    await tool.execute({ action: 'operator_method', target: 'watcher list' });

    expect(calls).toEqual([
      { mode: 'operator_methods', query: 'schedule', includeParameters: true, limit: 20 },
      { mode: 'operator_method', methodId: 'services.status' },
      { mode: 'operator_method', target: 'watcher list' },
    ]);
  });

  test('registers the direct host adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentHostTool(registry, {} as CommandRegistry, { workspace: {}, platform: {} } as CommandContext);
    registerAgentHostTool(registry, {} as CommandRegistry, { workspace: {}, platform: {} } as CommandContext);

    expect(registry.has('host')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'host')).toHaveLength(1);
  });
});
