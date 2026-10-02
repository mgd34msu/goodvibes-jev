// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { createTestConfigManager } from '../helpers/test-managers.ts';
import { AgentManager } from '@goodvibes-jev/engine/sdk/platform/tools';

// ---------------------------------------------------------------------------
// ConversationManager streaming block lifecycle
// ---------------------------------------------------------------------------

describe('ConversationManager streaming block lifecycle', () => {
  let cm: ConversationManager;

  beforeEach(async () => {
    cm = new ConversationManager(() => 80, createTestConfigManager());
  });

  test('startStreamingBlock adds an empty assistant message', async () => {
    cm.addUserMessage('hello');
    cm.startStreamingBlock();
    const msgs = cm.getMessagesForLLM();
    // user + the streaming placeholder
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: '' });
  });

  test('updateStreamingBlock updates the last assistant message content', async () => {
    cm.startStreamingBlock();
    cm.updateStreamingBlock('hello');
    const msgs = cm.getMessagesForLLM();
    expect(msgs[0]).toMatchObject({ role: 'assistant', content: 'hello' });
  });

  test('updateStreamingBlock replaces content on each call (accumulated from caller)', async () => {
    cm.startStreamingBlock();
    cm.updateStreamingBlock('hel');
    cm.updateStreamingBlock('hello world');
    const msgs = cm.getMessagesForLLM();
    expect((msgs[0] as { content: string }).content).toBe('hello world');
  });

  test('finalizeStreamingBlock removes the streaming placeholder', async () => {
    cm.addUserMessage('hi');
    cm.startStreamingBlock();
    expect(cm.getMessagesForLLM()).toHaveLength(2);
    cm.finalizeStreamingBlock();
    // Only the user message remains, placeholder removed
    expect(cm.getMessagesForLLM()).toHaveLength(1);
  });

  test('full sequence: start -> multiple updates -> finalize -> addAssistantMessage', async () => {
    cm.addUserMessage('question');
    cm.startStreamingBlock();
    cm.updateStreamingBlock('part ');
    cm.updateStreamingBlock('part one ');
    cm.updateStreamingBlock('part one two');
    cm.finalizeStreamingBlock();
    // Add the actual final message that orchestrator would add
    cm.addAssistantMessage('part one two');

    const msgs = cm.getMessagesForLLM();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'question' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'part one two' });
  });

  test('startStreamingBlock when no messages adds assistant placeholder as first message', async () => {
    cm.startStreamingBlock();
    const msgs = cm.getMessagesForLLM();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'assistant', content: '' });
  });

  test('finalizeStreamingBlock only removes the last assistant message', async () => {
    cm.addAssistantMessage('previous response');
    cm.addUserMessage('follow-up');
    cm.startStreamingBlock();
    cm.finalizeStreamingBlock();
    const msgs = cm.getMessagesForLLM();
    // Previous assistant and user remain; placeholder removed
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'assistant', content: 'previous response' });
    expect(msgs[1]).toMatchObject({ role: 'user', content: 'follow-up' });
  });
});

// ---------------------------------------------------------------------------
// Abort during streaming: orchestrator cleanup
// ---------------------------------------------------------------------------

describe('Orchestrator: abort during streaming cleanup', () => {
  async function buildOrchestrator() {
    const { Orchestrator } = await import('@goodvibes-jev/engine/sdk/platform/core');
    const { ConversationManager } = await import('../../core/conversation.ts');
    const { PermissionManager, createPermissionConfigReader } = await import('@goodvibes-jev/engine/sdk/platform/permissions');
    const { ToolRegistry } = await import('@goodvibes-jev/engine/sdk/platform/tools');
    const configManager = createTestConfigManager();
    const cm = new ConversationManager(() => 80, configManager);
    const policyRuntimeState = new PolicyRuntimeState();
    const pm = new PermissionManager(async () => ({ approved: true }), createPermissionConfigReader(configManager), policyRuntimeState);
    const tr = new ToolRegistry();
    const orch = new Orchestrator({
      conversation: cm,
      getViewportHeight: () => 24,
      scrollToEnd: () => {},
      toolRegistry: tr,
      permissionManager: pm,
      getSystemPrompt: () => '',
      services: {
        agentManager: new AgentManager({ configManager }),
        contractRunner: { list: () => [] },
        contractIntake: { intake: async () => ({ kind: 'turn' }) },
      },
    });
    return { orch, cm };
  }

  test('isStreaming flag starts false on a fresh orchestrator', async () => {
    const { orch } = await buildOrchestrator();
    // Access via type cast since it is private
    expect((orch as unknown as { isStreaming: boolean }).isStreaming).toBe(false);
  });

});
