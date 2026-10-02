import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentSecurityTool, registerAgentSecurityTool } from '../../tools/agent-security-tool.ts';

function fakeHarness(calls: Record<string, unknown>[]): Tool {
  return {
    definition: {
      name: 'agent_harness',
      description: 'Fake harness',
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, output: JSON.stringify({ args }) };
    },
  };
}

function fakeContext(values: Record<string, unknown> = {}): CommandContext {
  return {
    workspace: {},
    platform: {
      config: {
        behavior: { autoApprove: false },
        permissions: { mode: 'prompt', tools: {} },
      },
      configManager: {
        get: (key: string) => values[key],
      },
    },
    session: { runtime: {} },
  } as CommandContext;
}

function registerSettingsTool(registry: ToolRegistry): void {
  registry.register({
    definition: {
      name: 'settings',
      description: 'List, inspect, change, reset, or import settings.',
      sideEffects: ['state'],
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          key: { type: 'string' },
          value: {},
          confirm: { type: 'boolean' },
          explicitUserRequest: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    execute: async () => ({ success: true, output: 'settings' }),
  });
}

function makeTool(calls: Record<string, unknown>[] = [], registry = new ToolRegistry()): Tool {
  return createAgentSecurityTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: fakeContext(),
    toolRegistry: registry,
    harnessTool: fakeHarness(calls),
  });
}

describe('security adapter', () => {
  test('routes security posture and findings through the harness', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'status', includeParameters: true, limit: 5 });
    await tool.execute({ action: 'finding', findingId: 'policy-preflight' });

    expect(calls).toEqual([
      { mode: 'security_posture', includeParameters: true, limit: 5 },
      { mode: 'security_finding', findingId: 'policy-preflight' },
    ]);
  });

  test('explains Agent policy denials before running blocked exec routes', async () => {
    const tool = makeTool();

    const result = await tool.execute({
      action: 'explain',
      toolName: 'exec',
      toolArgs: { commands: [{ cmd: 'pytest -v', background: true }] },
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!) as {
      readonly status: string;
      readonly category: string;
      readonly policyLayers: readonly { readonly layer: string; readonly outcome: string; readonly reason: string }[];
    };
    expect(body.status).toBe('denied');
    expect(body).toMatchObject({ preflight: { approvedWithoutMoreInput: false, permissionOutcome: 'unknown' } });
    expect(body.category).toBe('execute');
    expect(body.policyLayers[0]).toMatchObject({
      layer: 'Agent route guard',
      outcome: 'denied',
    });
    expect(body.policyLayers[0]?.reason).toContain('Raw exec background flags');
  });

  test('explains typed confirmation requirements without executing the tool', async () => {
    const registry = new ToolRegistry();
    registerSettingsTool(registry);
    const tool = makeTool([], registry);

    const result = await tool.execute({
      action: 'explain',
      toolName: 'settings',
      toolArgs: {
        action: 'set',
        key: 'notifications.webhookUrls',
        value: 'https://example.test/hook?token=secret',
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!) as {
      readonly status: string;
      readonly requiredActions: readonly string[];
      readonly preflight: {
        readonly toolConfirmationRequired: boolean;
        readonly toolConfirmationSatisfied: boolean;
      };
      readonly toolArgs: { readonly value?: string };
    };
    expect(body.status).toBe('confirmation_required');
    expect(body).toMatchObject({ preflight: { approvedWithoutMoreInput: false, permissionOutcome: 'unknown' } });
    expect(body.requiredActions.join('\n')).toContain('confirm:true');
    expect(body.preflight.toolConfirmationRequired).toBe(true);
    expect(body.preflight.toolConfirmationSatisfied).toBe(false);
    expect(body.toolArgs.value).toBe('<redacted>');
  });

  test('does not require typed confirmation for read-only actions on mixed tools', async () => {
    const registry = new ToolRegistry();
    registerSettingsTool(registry);
    const tool = makeTool([], registry);

    const result = await tool.execute({
      action: 'explain',
      toolName: 'settings',
      toolArgs: { action: 'get', key: 'ui.theme' },
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!) as {
      readonly status: string;
      readonly preflight: {
        readonly toolConfirmationRequired: boolean;
      };
    };
    expect(body.status).toBe('held');
    expect(body).toMatchObject({ preflight: { approvedWithoutMoreInput: false, permissionOutcome: 'unknown', permissionEvaluated: false } });
    expect(body.preflight.toolConfirmationRequired).toBe(false);
  });

  test('satisfying typed confirmation does not imply live permission approval', async () => {
    const registry = new ToolRegistry();
    registerSettingsTool(registry);
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls, registry);
    const result = await tool.execute({
      action: 'explain', toolName: 'settings',
      toolArgs: { action: 'set', key: 'notifications.webhookUrls', value: [], confirm: true, explicitUserRequest: 'Clear notification webhooks' },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!);
    expect(body.status).toBe('held');
    expect(body.preflight).toMatchObject({
      approvedWithoutMoreInput: false, permissionOutcome: 'unknown', permissionEvaluated: false,
      toolConfirmationRequired: true, toolConfirmationSatisfied: true,
    });
    expect(calls).toHaveLength(0);
  });

  test('registers the direct security adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentSecurityTool(registry, {} as CommandRegistry, fakeContext());
    registerAgentSecurityTool(registry, {} as CommandRegistry, fakeContext());

    expect(registry.has('security')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'security')).toHaveLength(1);
  });
});
