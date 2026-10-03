import { afterEach, describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerAgentWorkspaceRuntimeCommands } from '../../input/commands/agent-workspace-runtime.ts';
import { registerGuidanceRuntimeCommands } from '../../input/commands/guidance-runtime.ts';
import { registerOnboardingRuntimeCommands } from '../../input/commands/onboarding-runtime.ts';
import { resetTestRuntimeServices } from '../helpers/runtime-services.ts';

afterEach(() => {
  resetTestRuntimeServices();
});

function makeContext(out: string[], registry?: CommandRegistry): CommandContext & {
  openedWorkspaceCategories: Array<string | undefined>;
  delegatedCommands: Array<{ name: string; args: string[] }>;
} {
  const openedWorkspaceCategories: Array<string | undefined> = [];
  const delegatedCommands: Array<{ name: string; args: string[] }> = [];
  const ctx = {
    print: (text: string) => {
      out.push(text);
    },
    renderRequest: () => {},
    exit: () => {},
    executeCommand: registry
      ? async (name: string, args: string[]) => {
          delegatedCommands.push({ name, args });
          return registry.execute(name, args, ctx as CommandContext);
        }
      : undefined,
    openAgentWorkspace: (categoryId?: string) => {
      openedWorkspaceCategories.push(categoryId);
    },
    openedWorkspaceCategories,
    delegatedCommands,
    session: {
      conversationManager: {} as never,
      runtime: {
        model: 'model-1',
        provider: 'openai',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'sess-onboarding',
      },
    },
    provider: {
      providerRegistry: {} as never,
    },
    workspace: {},
    platform: {
      config: {} as never,
      configManager: {} as never,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
  } as unknown as CommandContext & {
    openedWorkspaceCategories: Array<string | undefined>;
    delegatedCommands: Array<{ name: string; args: string[] }>;
  };
  return ctx;
}

function makeRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerAgentWorkspaceRuntimeCommands(registry);
  registerOnboardingRuntimeCommands(registry);
  return registry;
}

describe('setup entrypoints', () => {
  test('top-level setup command delegates to plain /agent', async () => {
    const registry = makeRegistry();
    const out: string[] = [];
    const ctx = makeContext(out, registry);

    await expect(registry.execute('setup', [], ctx)).resolves.toBe(true);

    expect(ctx.delegatedCommands).toEqual([{ name: 'agent', args: [] }]);
    expect(ctx.openedWorkspaceCategories).toEqual([undefined]);
    expect(out).toEqual([]);
  });

  test('legacy onboarding alias delegates to plain /agent', async () => {
    const registry = makeRegistry();
    const out: string[] = [];
    const ctx = makeContext(out, registry);

    await expect(registry.execute('onboarding', [], ctx)).resolves.toBe(true);

    expect(ctx.delegatedCommands).toEqual([{ name: 'agent', args: [] }]);
    expect(ctx.openedWorkspaceCategories).toEqual([undefined]);
    expect(out).toEqual([]);
  });

  test('setup command falls back to plain workspace opener when command delegation is unavailable', async () => {
    const registry = new CommandRegistry();
    registerOnboardingRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out);

    await expect(registry.execute('setup', [], ctx)).resolves.toBe(true);

    expect(ctx.delegatedCommands).toEqual([]);
    expect(ctx.openedWorkspaceCategories).toEqual([undefined]);
    expect(out).toEqual([]);
  });

  test('welcome open delegates to plain /agent', async () => {
    const registry = makeRegistry();
    registerGuidanceRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, registry);

    await expect(registry.execute('welcome', ['open'], ctx)).resolves.toBe(true);

    expect(ctx.delegatedCommands).toEqual([{ name: 'agent', args: [] }]);
    expect(ctx.openedWorkspaceCategories).toEqual([undefined]);
    expect(out).toEqual([]);
  });

  test('welcome print points users at the Agent workspace', async () => {
    const registry = new CommandRegistry();
    registerGuidanceRuntimeCommands(registry);
    const out: string[] = [];

    await expect(registry.execute('welcome', ['print'], makeContext(out))).resolves.toBe(true);

    expect(out.join('\n')).toContain('/setup');
    expect(out.join('\n')).toContain('open the Agent workspace');
    expect(out.join('\n')).not.toContain('/agent setup');
    expect(out.join('\n')).not.toContain('first-run checklist');
  });
});
