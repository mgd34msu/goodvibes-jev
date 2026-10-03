import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
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
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => { previous = installJudgmentPort(fakePort((name, question, state) => {
    const call = state as { tool: string; arguments: { action?: string } };
    if (name !== 'kind') throw new Error(`Unexpected classification question: ${name}`);
    if (call.tool === 'exec') return choiceAnswer(question, 'shell', 0.99);
    if (call.tool === 'settings') return choiceAnswer(question, call.arguments.action === 'get' ? 'read' : 'write', 0.99);
    throw new Error(`Unscripted classification fixture: ${call.tool}`);
  }).port); });
  afterEach(() => { installJudgmentPort(previous); });
  for (const caller of ['security', 'harness'] as const) {
    test(`${caller} explanation keeps the complete detached call stable while Jev is pending`, async () => {
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const fixture = fakePort((_name, question) => choiceAnswer(question, 'read', 0.99));
      installJudgmentPort({ model: fixture.port.model, async ask(request) {
        enter(); await pending; return fixture.port.ask(request);
      } });
      const registry = new ToolRegistry(); registerSettingsTool(registry);
      const tool = caller === 'security' ? makeTool([], registry) : createAgentHarnessTool({
        commandRegistry: {} as CommandRegistry, commandContext: fakeContext(), toolRegistry: registry,
      });
      const nested = { message: 'original nested value' };
      const toolArgs = { action: 'get', key: 'ui.theme', confirm: false, nested };
      const input = { action: 'explain', mode: 'policy_explain', toolName: 'settings', toolArgs, includeParameters: true };
      const outcome = tool.execute(input);
      await entered;
      toolArgs.action = 'set'; toolArgs.key = 'permissions.mode'; toolArgs.confirm = true;
      nested.message = 'mutated after judgment started';
      input.toolName = 'exec'; input.includeParameters = false;
      release();
      const result = await outcome;
      expect(result.success).toBe(true);
      const body = JSON.parse(result.output!);
      expect(body).toMatchObject({
        toolName: 'settings', category: 'read', categoryConfident: true,
        toolArgs: { action: 'get', key: 'ui.theme', confirm: false, nested: { message: 'original nested value' } },
        preflight: { permissionEvaluated: false, approvedWithoutMoreInput: false, toolConfirmationRequired: false },
        toolDefinition: { name: 'settings' },
      });
      expect(fixture.requests[0]!.state).toMatchObject({ tool: 'settings', arguments: body.toolArgs });
    });

    for (const location of ['input', 'toolArgs'] as const) test(`${caller} explanation refuses a ${location} getter without invoking it or Jev`, async () => {
      let reads = 0;
      const fixture = fakePort((_name, question) => choiceAnswer(question, 'read', 0.99));
      installJudgmentPort(fixture.port);
      const registry = new ToolRegistry(); registerSettingsTool(registry);
      const tool = caller === 'security' ? makeTool([], registry) : createAgentHarnessTool({
        commandRegistry: {} as CommandRegistry, commandContext: fakeContext(), toolRegistry: registry,
      });
      const toolArgs: Record<string, unknown> = { action: 'get', key: 'ui.theme' };
      const input: Record<string, unknown> = { action: 'explain', mode: 'policy_explain', toolName: 'settings', toolArgs };
      Object.defineProperty(location === 'input' ? input : toolArgs, location === 'input' ? 'toolArgs' : 'action', {
        enumerable: true, get() { reads++; return location === 'input' ? toolArgs : 'get'; },
      });
      await expect(tool.execute(input)).rejects.toMatchObject({ name: 'JudgmentInputError', problem: 'unsupported-input' });
      expect(reads).toBe(0);
      expect(fixture.requests).toHaveLength(0);
    });
  }

  for (const caller of ['security', 'harness'] as const) test(`${caller} explanation forwards its caller signal and cannot return a late category after cancellation`, async () => {
    const controller = new AbortController();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let seenSignal: AbortSignal | undefined;
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'read', 0.99));
    installJudgmentPort({ model: fixture.port.model, async ask(request) {
      seenSignal = request.signal; enter(); await pending; return fixture.port.ask(request);
    } });
    const registry = new ToolRegistry(); registerSettingsTool(registry);
    const tool = caller === 'security' ? makeTool([], registry) : createAgentHarnessTool({
      commandRegistry: {} as CommandRegistry, commandContext: fakeContext(), toolRegistry: registry,
    });
    const outcome = tool.execute({ action: 'explain', mode: 'policy_explain', toolName: 'settings', toolArgs: { action: 'get', key: 'ui.theme' } }, { signal: controller.signal }).catch((error: unknown) => error);
    await entered;
    expect(seenSignal).toBe(controller.signal);
    controller.abort('private reason');
    expect(await outcome).toMatchObject({ name: 'JudgmentError', kind: 'aborted' });
    release(); await Bun.sleep(0);
    expect(await outcome).toMatchObject({ kind: 'aborted' });
  });

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
