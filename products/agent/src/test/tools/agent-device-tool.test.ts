import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentDeviceTool, registerAgentDeviceTool } from '../../tools/agent-device-tool.ts';

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

function makeTool(calls: Record<string, unknown>[] = []): Tool {
  return createAgentDeviceTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {} } as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeTool('agent_harness', calls),
  });
}

describe('device adapter', () => {
  test('routes device, capability, browser, control, voice, and provider reads', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'status', includeParameters: true });
    await tool.execute({ action: 'capability', capabilityId: 'browser-cockpit-pwa' });
    await tool.execute({ action: 'browser' });
    await tool.execute({ action: 'control', includeParameters: false });
    await tool.execute({ action: 'voice', query: 'push to talk' });
    await tool.execute({ action: 'provider', providerId: 'voice:openai' });

    expect(calls).toEqual([
      { tool: 'agent_harness', mode: 'pairing_posture', query: 'device', includeParameters: true },
      { tool: 'agent_harness', mode: 'pairing_route', pairingRouteId: 'browser-cockpit-pwa' },
      { tool: 'agent_harness', mode: 'ui_surface', surfaceId: 'connected-browser-cockpit', includeParameters: true },
      { tool: 'agent_harness', mode: 'execution_route', executionRouteId: 'browser-or-desktop-control', includeParameters: false },
      { tool: 'agent_harness', mode: 'media_posture', query: 'push to talk' },
      { tool: 'agent_harness', mode: 'media_provider', mediaProviderId: 'voice:openai' },
    ]);
  });

  test('routes confirmed visible open actions through existing UI surface gates', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({
      action: 'open_browser',
      confirm: true,
      explicitUserRequest: 'Open the connected browser cockpit.',
    });
    await tool.execute({
      action: 'open_tts_provider',
      confirm: true,
      explicitUserRequest: 'Open the TTS provider picker.',
    });
    await tool.execute({
      action: 'open_tts_voice',
      providerId: 'openai',
      confirm: true,
      explicitUserRequest: 'Open the TTS voice picker.',
    });

    expect(calls).toEqual([
      {
        tool: 'agent_harness',
        mode: 'open_ui_surface',
        surfaceId: 'connected-browser-cockpit',
        confirm: true,
        explicitUserRequest: 'Open the connected browser cockpit.',
      },
      {
        tool: 'agent_harness',
        mode: 'open_ui_surface',
        surfaceId: 'tts-provider-picker',
        confirm: true,
        explicitUserRequest: 'Open the TTS provider picker.',
      },
      {
        tool: 'agent_harness',
        mode: 'open_ui_surface',
        surfaceId: 'tts-voice-picker',
        target: 'openai',
        confirm: true,
        explicitUserRequest: 'Open the TTS voice picker.',
      },
    ]);
  });

  test('registers the direct device adapter', () => {
    const registry = new ToolRegistry();

    registerAgentDeviceTool(registry, {} as CommandRegistry, { workspace: {}, platform: {} } as CommandContext);

    expect(registry.has('device')).toBe(true);
  });
});
