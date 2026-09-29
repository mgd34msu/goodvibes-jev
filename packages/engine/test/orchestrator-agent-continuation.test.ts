/**
 * What the core turn loop tells the conversation model after its agent tool
 * call (core/orchestrator-turn-helpers.ts): a call that started a contract
 * (the tool's `contractStarted` field) gets the contract note and no nudge to
 * spawn more agents; an ordinary spawn keeps the continuation nudge; and the
 * user's turn text rides every root agent call as its authoritative task, the
 * ask a contract's criteria trace to.
 */
import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import type { ConversationMessageSnapshot } from '../sdk/src/platform/core/conversation.js';
import { handleToolResponseOutcome } from '../sdk/src/platform/core/orchestrator-turn-helpers.js';
import type { ToolCall, ToolResult } from '../sdk/src/platform/types/tools.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';

function createProviderRegistry() {
  return {
    getCurrentModel: () => ({
      id: 'test-model',
      provider: 'test',
      registryKey: 'test:test-model',
      displayName: 'test-model',
      description: 'test model',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
      contextWindow: 128_000,
      selectable: true,
    }),
  };
}

async function runOutcome(input: { readonly toolCalls: ToolCall[]; readonly userText: string; readonly result: Record<string, unknown>; readonly onExecute?: (calls: ToolCall[]) => void }) {
  const conversation = new ConversationManager();
  await handleToolResponseOutcome({
    conversation,
    agentManager: { list: () => [], spawn: () => { throw new Error('not used'); } },
    planManager: null,
    configManager: { get: () => undefined } as unknown as Pick<ConfigManager, 'get'>,
    providerRegistry: createProviderRegistry(),
    runtimeBus: null,
    emitterContext: () => ({ sessionId: 'test', traceId: 'test', source: 'test' }),
    turnId: 'turn-1',
    response: { content: '', toolCalls: input.toolCalls, usage: undefined } as never,
    userText: input.userText,
    executeToolCalls: async (_turnId, calls): Promise<ToolResult[]> => {
      input.onExecute?.(calls);
      return [{ callId: 'call-agent', success: true, output: JSON.stringify(input.result) }];
    },
    setPendingToolCalls: () => {},
    messageQueueLength: 0,
    requestRender: () => {},
    sessionId: 'session-1',
  });
  const systemMessages = conversation.getMessageSnapshot()
    .filter((message): message is { role: 'system'; content: string } => message.role === 'system')
    .map((message) => message.content);
  return { conversation, systemMessages };
}

const spawnCall = (task: string): ToolCall[] => [{ id: 'call-agent', name: 'agent', arguments: { mode: 'spawn', task } }];

describe('the turn loop after an agent tool call', () => {
  test('a call that started a contract gets the contract note, not the nudge to spawn more agents', async () => {
    const { systemMessages } = await runOutcome({
      toolCalls: spawnCall('Build a token bucket rate limiter.'),
      userText: '',
      result: { contractStarted: true, contractId: 'ctr-1a2b3c4d', ownerAgentId: 'agent-owner' },
    });
    expect(systemMessages.some((message) => message.includes('continue spawning agents now'))).toBe(false);
    expect(systemMessages.some((message) => message.startsWith('A contract now owns this work'))).toBe(true);
  });

  test('an ordinary spawn keeps the continuation nudge', async () => {
    const { systemMessages } = await runOutcome({
      toolCalls: spawnCall('Inspect package manager configuration.'),
      userText: '',
      result: { agentId: 'agent-worker', status: 'spawned' },
    });
    expect(systemMessages.some((message) => message.includes('continue spawning agents now'))).toBe(true);
    expect(systemMessages.some((message) => message.startsWith('A contract now owns this work'))).toBe(false);
  });

  test('the user\'s turn text rides every root agent call as its authoritative task', async () => {
    let executed: ToolCall[] = [];
    const { conversation } = await runOutcome({
      toolCalls: [{
        id: 'call-agent',
        name: 'agent',
        arguments: { mode: 'batch-spawn', tasks: [{ task: 'Design a token bucket rate limiter.' }, { task: 'Write its tests.' }] },
      }],
      userText: 'make a token bucket rate limiter',
      result: { contractStarted: true, contractId: 'ctr-1a2b3c4d', ownerAgentId: 'agent-owner' },
      onExecute: (calls) => { executed = calls; },
    });
    expect(executed).toHaveLength(1);
    expect(executed[0]!.arguments.authoritativeTask).toBe('make a token bucket rate limiter');
    const assistantToolCall = conversation.getMessageSnapshot()
      .find((message): message is Extract<ConversationMessageSnapshot, { role: 'assistant' }> =>
        message.role === 'assistant' && !!message.toolCalls?.length);
    expect(assistantToolCall?.toolCalls?.[0]?.arguments.authoritativeTask).toBe('make a token bucket rate limiter');
  });
});
