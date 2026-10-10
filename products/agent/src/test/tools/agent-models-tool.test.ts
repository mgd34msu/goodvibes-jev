import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentModelsTool, registerAgentModelsTool } from '../../tools/agent-models-tool.ts';

function fakeTool(name: string, calls: Record<string, unknown>[]): Tool {
  return {
    definition: {
      name,
      description: 'Fake tool',
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async (args: Record<string, unknown>) => {
      calls.push({ tool: name, ...args });
      return { success: true, output: JSON.stringify({ name, args }) };
    },
  };
}

afterAll(cleanupResearchScreeningFixtures);

function makeTool(calls: Record<string, unknown>[] = []): Tool {
  const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
  return createAgentModelsTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {} } as CommandContext,
    toolRegistry: registry,
    harnessTool: fakeTool('agent_harness', calls),
  });
}

describe('models adapter', () => {
  test('routes model, route, local cookbook, provider, and provider-list reads', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'status', includeParameters: true });
    await tool.execute({ action: 'route', modelRouteId: 'local-model-cookbook' });
    await tool.execute({ action: 'local' });
    await tool.execute({ action: 'providers', query: 'subscription' });
    await tool.execute({ action: 'provider', providerId: 'openai-subscriber' });

    expect(calls).toEqual([
      { tool: 'agent_harness', mode: 'model_routing', includeParameters: true },
      { tool: 'agent_harness', mode: 'model_route', modelRouteId: 'local-model-cookbook' },
      { tool: 'agent_harness', mode: 'model_routing', query: 'local' },
      { tool: 'agent_harness', mode: 'provider_accounts', query: 'subscription' },
      { tool: 'agent_harness', mode: 'provider_account', providerId: 'openai-subscriber' },
    ]);
  });

  test('routes confirmed local server smoke through the existing confirmation gate', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({
      action: 'smoke',
      modelRouteId: 'ollama-local-endpoint',
      timeoutMs: 1500,
      confirm: true,
      explicitUserRequest: 'Check local model servers.',
    });

    expect(calls).toEqual([
      {
        tool: 'agent_harness',
        mode: 'run_local_model_smoke',
        modelRouteId: 'ollama-local-endpoint',
        timeoutMs: 1500,
        confirm: true,
        explicitUserRequest: 'Check local model servers.',
      },
    ]);
  });

  test('registers the direct models adapter', () => {
    const registry = new ToolRegistry();

    registerAgentModelsTool(registry, {} as CommandRegistry, { workspace: {}, platform: {} } as CommandContext);

    expect(registry.has('models')).toBe(true);
  });
});
