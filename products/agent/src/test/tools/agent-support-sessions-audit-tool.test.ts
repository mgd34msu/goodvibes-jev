import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentAuditTool, registerAgentAuditTool } from '../../tools/agent-audit-tool.ts';
import { createAgentSessionsTool, registerAgentSessionsTool } from '../../tools/agent-sessions-tool.ts';
import { createAgentSupportTool, registerAgentSupportTool } from '../../tools/agent-support-tool.ts';

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

function fakeContext(): CommandContext {
  return {
    workspace: {},
    platform: {
      config: {
        behavior: { autoApprove: false },
        permissions: { mode: 'prompt', tools: {} },
      },
    },
    session: { runtime: {} },
  } as CommandContext;
}

describe('support adapter', () => {
  test('routes bundle catalog and single bundle inspection through the harness', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = createAgentSupportTool({
      commandRegistry: {} as CommandRegistry,
      commandContext: fakeContext(),
      toolRegistry: new ToolRegistry(),
      harnessTool: fakeHarness(calls),
    });

    await tool.execute({ action: 'status', query: 'diagnostics', includeParameters: true });
    await tool.execute({ action: 'bundle', bundlePath: 'support/bundle.json' });

    expect(calls).toEqual([
      { mode: 'support_bundles', query: 'diagnostics', includeParameters: true },
      { mode: 'support_bundle', bundlePath: 'support/bundle.json' },
    ]);
  });

  test('registers once', () => {
    const registry = new ToolRegistry();
    const context = fakeContext();

    registerAgentSupportTool(registry, {} as CommandRegistry, context);
    registerAgentSupportTool(registry, {} as CommandRegistry, context);

    expect(registry.has('support')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'support')).toHaveLength(1);
  });
});

describe('sessions adapter', () => {
  test('routes session list and detail inspection through the harness', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = createAgentSessionsTool({
      commandRegistry: {} as CommandRegistry,
      commandContext: fakeContext(),
      toolRegistry: new ToolRegistry(),
      harnessTool: fakeHarness(calls),
    });

    await tool.execute({ action: 'search', query: 'onboarding', limit: 5 });
    await tool.execute({ action: 'get', sessionId: 'session-123', includeParameters: true });

    expect(calls).toEqual([
      { mode: 'sessions', query: 'onboarding', limit: 5 },
      { mode: 'session', sessionId: 'session-123', includeParameters: true },
    ]);
  });

  test('registers once', () => {
    const registry = new ToolRegistry();
    const context = fakeContext();

    registerAgentSessionsTool(registry, {} as CommandRegistry, context);
    registerAgentSessionsTool(registry, {} as CommandRegistry, context);

    expect(registry.has('sessions')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'sessions')).toHaveLength(1);
  });
});

describe('audit adapter', () => {
  test('routes readiness and evidence surfaces through the harness', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = createAgentAuditTool({
      commandRegistry: {} as CommandRegistry,
      commandContext: fakeContext(),
      toolRegistry: new ToolRegistry(),
      harnessTool: fakeHarness(calls),
    });

    await tool.execute({ action: 'readiness', query: 'gate', includeParameters: true });
    await tool.execute({ action: 'item', itemId: 'route-planning' });
    await tool.execute({ action: 'evidence', query: 'live verification' });
    await tool.execute({ action: 'artifact', artifactId: 'live-verification-json', includeParameters: true });

    expect(calls).toEqual([
      { mode: 'release_readiness', query: 'gate', includeParameters: true },
      { mode: 'release_readiness_item', itemId: 'route-planning' },
      { mode: 'release_evidence', query: 'live verification' },
      { mode: 'release_evidence_artifact', artifactId: 'live-verification-json', includeParameters: true },
    ]);
  });

  test('infers evidence from release evidence wording', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = createAgentAuditTool({
      commandRegistry: {} as CommandRegistry,
      commandContext: fakeContext(),
      toolRegistry: new ToolRegistry(),
      harnessTool: fakeHarness(calls),
    });

    await tool.execute({ query: 'inspect release evidence artifact live verification' });

    expect(calls).toEqual([
      { mode: 'release_evidence', query: 'inspect release evidence artifact live verification' },
    ]);
  });

  test('registers once', () => {
    const registry = new ToolRegistry();
    const context = fakeContext();

    registerAgentAuditTool(registry, {} as CommandRegistry, context);
    registerAgentAuditTool(registry, {} as CommandRegistry, context);

    expect(registry.has('audit')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'audit')).toHaveLength(1);
  });
});
