/**
 * The agent tool's budget mode reports the agent's recorded usage, never a
 * per-tool-call estimate (the old 200 input + 300 output tokens per call).
 */
import { describe, expect, test } from 'bun:test';
import { createAgentTool } from '../sdk/src/platform/tools/agent/index.ts';
import type { AgentManager, AgentRecord } from '../sdk/src/platform/tools/agent/manager.ts';

function toolFor(record: Partial<AgentRecord>) {
  const manager = { getStatus: (id: string) => (id === 'agent-1' ? ({ id: 'agent-1', toolCallCount: 4, ...record } as AgentRecord) : null) } as unknown as AgentManager;
  return createAgentTool({
    manager,
    messageBus: { getMessages: () => [], send: () => undefined } as never,
    archetypeLoader: { loadArchetype: () => null },
    configManager: { get: () => undefined } as never,
  });
}

describe('agent tool budget mode', () => {
  test('reports the recorded token usage', async () => {
    const tool = toolFor({
      usage: { inputTokens: 12_000, outputTokens: 3_400, cacheReadTokens: 800, cacheWriteTokens: 200, llmCallCount: 5, turnCount: 3 },
    });
    const result = await tool.execute({ mode: 'budget', agentId: 'agent-1' });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output!)).toEqual({
      agentId: 'agent-1',
      inputTokens: 12_000,
      outputTokens: 3_400,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
      totalTokens: 15_400,
      llmCallCount: 5,
      turnCount: 3,
      toolCallCount: 4,
    });
  });

  test('an agent with no recorded model call reports zeros and says so', async () => {
    const result = await toolFor({}).execute({ mode: 'budget', agentId: 'agent-1' });
    const output = JSON.parse(result.output!) as { totalTokens: number; note?: string };
    expect(output.totalTokens).toBe(0);
    expect(output.note).toBe('No model call has been recorded for this agent yet.');
  });
});
