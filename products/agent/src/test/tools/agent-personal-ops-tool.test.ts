import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentPersonalOpsTool, registerAgentPersonalOpsTool } from '../../tools/agent-personal-ops-tool.ts';

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

function makeTool(calls: Record<string, unknown>[] = []): Tool {
  return createAgentPersonalOpsTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: {} as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeHarness(calls),
  });
}

describe('personal_ops adapter', () => {
  test('routes briefing, status, intake, and lane actions to Personal Ops harness modes', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'briefing', query: 'today', limit: 5 });
    await tool.execute({ action: 'overview', includeParameters: true });
    await tool.execute({ action: 'queue', target: 'saved review', limit: 3 });
    await tool.execute({ action: 'triage', query: 'Triage my unread inbox.', includeParameters: true });
    await tool.execute({ action: 'inspect', laneId: 'calendar' });

    expect(calls).toEqual([
      { mode: 'personal_ops_briefing', query: 'today', limit: 5 },
      { mode: 'personal_ops', includeParameters: true },
      { mode: 'personal_ops_queue', target: 'saved review', limit: 3 },
      { mode: 'personal_ops_intake', query: 'Triage my unread inbox.', includeParameters: true },
      { mode: 'personal_ops_lane', laneId: 'calendar' },
    ]);
  });

  test('infers the user-first action from provided lookup fields', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({});
    await tool.execute({ query: 'Draft a reply to this email.' });
    await tool.execute({ laneId: 'tasks' });
    await tool.execute({ laneId: 'inbox', recordId: 'mcp:gmail:gmail.search_messages' });

    expect(calls).toEqual([
      { mode: 'personal_ops_briefing' },
      { mode: 'personal_ops_intake', query: 'Draft a reply to this email.' },
      { mode: 'personal_ops_lane', laneId: 'tasks' },
      { mode: 'run_personal_ops_read', laneId: 'inbox', recordId: 'mcp:gmail:gmail.search_messages' },
    ]);
  });

  test('passes confirmed read fields and review-artifact controls through one safe route', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({
      action: 'read',
      laneId: 'calendar',
      recordId: 'mcp:calendar:list_events',
      fields: { calendarId: 'primary', start: '2026-06-07' },
      saveReviewCards: true,
      artifactTitle: 'Today agenda review',
      includeParameters: true,
      confirm: true,
      explicitUserRequest: 'Brief my calendar for today.',
    });

    expect(calls).toEqual([
      {
        mode: 'run_personal_ops_read',
        laneId: 'calendar',
        recordId: 'mcp:calendar:list_events',
        fields: {
          calendarId: 'primary',
          start: '2026-06-07',
          saveReviewCards: true,
          artifactTitle: 'Today agenda review',
        },
        includeParameters: true,
        confirm: true,
        explicitUserRequest: 'Brief my calendar for today.',
      },
    ]);
  });

  test('registers the direct Personal Ops adapter', () => {
    const registry = new ToolRegistry();

    registerAgentPersonalOpsTool(registry, {} as CommandRegistry, {} as CommandContext);

    expect(registry.has('personal_ops')).toBe(true);
  });
});
